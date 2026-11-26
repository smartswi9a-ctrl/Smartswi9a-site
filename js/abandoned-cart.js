/* ============================================================
   js/abandoned-cart.js — RELANCES PANIERS ABANDONNÉS (Vitrine)
   ------------------------------------------------------------
   Rôle : synchroniser le panier local avec Firestore
   `abandoned_carts/{cartSessionId}` afin que :
     1. l'admin voie les paniers non finalisés ;
     2. la Cloud Function `abandonedCartReminder` envoie un push
        gratuit après 45 min (heures de pic Maroc) ;
     3. l'admin puisse relancer en WhatsApp en un clic.

   cartSessionId = uid si le client est connecté, sinon un
   guest_id persistant (localStorage) : la session invité est
   validée strictement par firestore.rules (cartId == docId,
   uid == null, champs bornés, téléphone 06/07).

   RÈGLES :
     - panier >= 1 article : setDoc (création ou mise à jour) ;
     - panier vidé manuellement : deleteDoc, SAUF si le panier
       vient d'être récupéré par une commande (status recovered) ;
     - commande validée : status "recovered" + recoveredOrderId.
   AUCUN email n'est envoyé par ce module (0 crédit EmailJS).
   ============================================================ */

import { doc, setDoc, deleteDoc, getDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG } from "./config.js?v=2";
import { getCart, getProducts, getSelectedCity, setCart } from "./store.js";
import { getCurrentUser } from "./auth.js";
import {
  getLang,
  getProductName,
  getProductImageUrl,
  safeGetItem,
  safeSetItem,
  cleanMoroccanPhone,
  isValidMoroccanPhone,
} from "./utils.js";
import { getCartSubtotal, getCartDiscount } from "./cart.js";

/* ============================================================
   CONSTANTES
   ============================================================ */

const COLLECTION = "abandoned_carts";
const GUEST_KEY = "swi9a_guest_id";
const FCM_TOKEN_KEY = "swi9a_fcm_token";
const ABANDON_DELAY_MS = 45 * 60 * 1000;
const MAX_ITEMS = 100;

const RECOVERY_TEXT = {
  fr: "🛒 Votre panier a été restauré. Finalisez votre commande — paiement à la livraison 24-72h.",
  en: "🛒 Your cart has been restored. Complete your order — Cash on Delivery 24-72h.",
  ar: "🛒 تمت استعادة سلتك. أكمل طلبك الآن — الدفع عند الاستلام خلال 24-72 ساعة.",
};

/* ============================================================
   ÉTAT LOCAL
   ============================================================ */

let fcmToken = "";
let knownSessions = new Map(); /* sessionId -> { status, createdAt } */
let recoveredSessions = new Set();
let pendingTimer = null;
let lastSyncedSignature = "";
let initialized = false;
let guestDocWritten = null;

/* ============================================================
   HELPERS
   ============================================================ */

function randomId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch (e) {
    /* crypto indisponible : repli ci-dessous */
  }
  return "g-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

function getGuestId() {
  let id = safeGetItem(GUEST_KEY);
  if (!id || typeof id !== "string" || id.length < 8) {
    id = randomId();
    safeSetItem(GUEST_KEY, id);
  }
  return id;
}

function currentSessionId() {
  const user = getCurrentUser();
  return user && user.uid ? String(user.uid) : getGuestId();
}

function readCartSafe() {
  const fromStore = getCart();
  if (Array.isArray(fromStore) && fromStore.length > 0) return fromStore;
  const user = getCurrentUser();
  const key = user && user.uid
    ? `${CONFIG.STORAGE_KEYS.CART}_${user.uid}`
    : CONFIG.STORAGE_KEYS.CART;
  const stored = safeGetItem(key);
  return Array.isArray(stored) ? stored : [];
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function unitPrice(item, product) {
  if (!product) return 0;
  if (item && item.variant) return Number(item.variant.price) || 0;
  if (Number(product.flashPrice) > 0) return Number(product.flashPrice);
  return Number(product.price) || 0;
}

function isFlashSale(product) {
  if (!product) return false;
  if (product.isFlashSale === true) return true;
  return Number(product.flashPrice) > 0 && Number(product.flashPrice) < Number(product.price);
}

function buildItems(cartLines) {
  const products = getProducts();
  const out = [];
  for (const line of Array.isArray(cartLines) ? cartLines : []) {
    if (!line || line.productId == null) continue;
    const product = products.find((p) => String(p.id) === String(line.productId));
    const qty = Math.max(1, Math.floor(Number(line.quantity) || 0));
    out.push({
      id: String(line.productId),
      title: product ? String(getProductName(product) || "").slice(0, 160) : "",
      price: round2(unitPrice(line, product)),
      qty,
      image: product ? String(getProductImageUrl(product) || "").slice(0, 900) : "",
      isFlashSale: isFlashSale(product),
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function readCustomerFields() {
  const read = (id) => {
    const el = typeof document !== "undefined" ? document.getElementById(id) : null;
    return el && typeof el.value === "string" ? el.value.trim() : "";
  };

  const name = read("cartName").slice(0, 120);
  const rawPhone = read("cartPhone");
  const phone = isValidMoroccanPhone(rawPhone) ? cleanMoroccanPhone(rawPhone) : "";
  const typedCity = read("cityFilterInput").slice(0, 120);
  const selected = getSelectedCity();
  const city = typedCity || String((selected && (selected.nameFr || selected.name)) || "").slice(0, 120);

  return { name, phone, city };
}

function readLang() {
  const lang = getLang();
  return lang === "en" || lang === "ar" ? lang : "fr";
}

function loadStoredToken() {
  if (fcmToken) return fcmToken;
  const stored = safeGetItem(FCM_TOKEN_KEY);
  if (typeof stored === "string" && stored.length > 20) fcmToken = stored;
  return fcmToken;
}

function signatureOf(payload) {
  return JSON.stringify({
    c: payload.cartId,
    u: payload.uid,
    n: payload.customerName,
    p: payload.phone,
    v: payload.city,
    l: payload.lang,
    t: payload.fcmToken,
    s: payload.subtotalMad,
    d: payload.discountMad,
    m: payload.totalMad,
    i: payload.items,
  });
}

/* ============================================================
   ÉCRITURE FIRESTORE
   ============================================================ */

async function writeCart() {
  const cartLines = readCartSafe();
  const sessionId = currentSessionId();

  if (!Array.isArray(cartLines) || cartLines.length === 0) {
    await deleteCart(sessionId);
    return;
  }

  const user = getCurrentUser();
  const fields = readCustomerFields();
  const items = buildItems(cartLines);
  if (!items.length) return;

  const subtotal = round2(getCartSubtotal());
  const discount = round2(getCartDiscount());
  /* totalMad = valeur du panier hors livraison : la ville n'est pas
     encore connue au moment de l'abandon (Montant potentiel admin). */
  const total = round2(Math.max(0, subtotal - discount));

  const payload = {
    cartId: sessionId,
    uid: user && user.uid ? String(user.uid) : null,
    customerName: fields.name,
    phone: fields.phone,
    city: fields.city,
    lang: readLang(),
    items,
    subtotalMad: subtotal,
    discountMad: discount,
    totalMad: total,
    fcmToken: loadStoredToken() || null,
    status: "active",
    updatedAt: serverTimestamp(),
    remindedAt: null,
    recoveredOrderId: null,
    recoveredAt: null,
  };

  const signature = signatureOf(payload);
  if (signature === lastSyncedSignature && knownSessions.has(sessionId)) return;

  try {
    const ref = doc(db, COLLECTION, sessionId);
    let state = knownSessions.get(sessionId);

    if (!state) {
      const snap = await getDoc(ref);
      state = snap.exists()
        ? { status: snap.data().status || "active", createdAt: snap.data().createdAt || null }
        : { status: null, createdAt: null };
    }

    if (!state.status) {
      await setDoc(ref, { ...payload, createdAt: serverTimestamp() });
      knownSessions.set(sessionId, { status: "active", createdAt: Date.now() });
    } else if (state.status === "recovered") {
      /* Nouveau cycle : le client recommence un panier après une
         commande. On réinitialise le document (createdAt neuf). */
      await setDoc(ref, { ...payload, createdAt: serverTimestamp() });
      knownSessions.set(sessionId, { status: "active", createdAt: Date.now() });
    } else {
      await setDoc(ref, payload, { merge: true });
      knownSessions.set(sessionId, { status: "active", createdAt: state.createdAt });
    }

    if (!user && sessionId === getGuestId()) guestDocWritten = sessionId;
    lastSyncedSignature = signature;
  } catch (e) {
    /* Réseau coupé / règles : la vitrine ne doit jamais être bloquée. */
    console.warn("[abandoned-cart] écriture impossible :", e && e.message);
  }
}

async function deleteCart(sessionId) {
  const id = sessionId || currentSessionId();

  if (recoveredSessions.has(id)) {
    /* Le panier vient d'être converti en commande : on conserve la
       trace "recovered" pour les KPI admin (spec §1). */
    return;
  }

  const state = knownSessions.get(id);
  if (state && state.status === "recovered") return;

  try {
    await deleteDoc(doc(db, COLLECTION, id));
    knownSessions.delete(id);
    lastSyncedSignature = "";
  } catch (e) {
    console.warn("[abandoned-cart] suppression impossible :", e && e.message);
  }
}

async function markRecovered(orderId) {
  const sessionId = currentSessionId();
  recoveredSessions.add(sessionId);

  try {
    await setDoc(
      doc(db, COLLECTION, sessionId),
      {
        status: "recovered",
        recoveredOrderId: orderId ? String(orderId).slice(0, 120) : null,
        recoveredAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    knownSessions.set(sessionId, { status: "recovered", createdAt: Date.now() });
  } catch (e) {
    console.warn("[abandoned-cart] marquage récupéré impossible :", e && e.message);
  }
}

/* ============================================================
   ORDONNANCEMENT (debounce)
   ============================================================ */

function scheduleSync(delay = 800) {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    writeCart();
  }, Math.max(0, Number(delay) || 0));
}

/* ============================================================
   REPRISE DEPUIS UN LIEN PUSH  ?recover_cart={cartId}
   ============================================================ */

function isCartPage() {
  const path = String(window.location.pathname || "");
  return path === "/panier" || path.endsWith("/panier") || path.endsWith("panier.html");
}

function showRecoveryBanner(lang) {
  if (typeof document === "undefined" || !document.body) return;
  const existing = document.getElementById("abandonedCartRecoveryBanner");
  if (existing) existing.remove();

  const banner = document.createElement("div");
  banner.id = "abandonedCartRecoveryBanner";
  banner.setAttribute("role", "status");
  banner.style.cssText = [
    "position:fixed",
    "top:16px",
    "left:50%",
    "transform:translateX(-50%)",
    "z-index:5000",
    "max-width:min(92vw, 560px)",
    "padding:0.85rem 1.1rem",
    "border-radius:14px",
    "border:1px solid #B4833E",
    "background:linear-gradient(135deg, #1a1a2e 0%, #241f2e 100%)",
    "color:#f5efe4",
    "font:600 0.9rem/1.5 'Inter', system-ui, sans-serif",
    "text-align:center",
    "box-shadow:0 12px 32px rgba(0,0,0,0.35)",
  ].join(";");
  banner.textContent = RECOVERY_TEXT[lang] || RECOVERY_TEXT.fr;
  document.body.appendChild(banner);
  setTimeout(() => {
    banner.style.transition = "opacity .4s ease";
    banner.style.opacity = "0";
    setTimeout(() => banner.remove(), 450);
  }, 8000);
}

async function restoreCartFromDoc(cartId) {
  const user = getCurrentUser();
  if (!user || !user.uid) return false; /* les invités ne peuvent pas relire le doc */

  try {
    const snap = await getDoc(doc(db, COLLECTION, cartId));
    if (!snap.exists()) return false;
    const data = snap.data() || {};
    if (String(data.uid || "") !== String(user.uid)) return false;
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return false;

    const key = `${CONFIG.STORAGE_KEYS.CART}_${user.uid}`;
    const stored = safeGetItem(key);
    const current = Array.isArray(stored) ? stored : [];

    const merged = current.slice();
    for (const line of items) {
      if (!line || line.id == null) continue;
      const productId = String(line.id);
      const qty = Math.max(1, Math.floor(Number(line.qty) || 1));
      const existing = merged.find((l) => String(l.productId) === productId && !l.variant);
      if (existing) {
        existing.quantity = Math.max(Number(existing.quantity) || 0, qty);
      } else {
        merged.push({ id: productId, productId, variant: null, quantity: qty, mode: null });
      }
    }

    safeSetItem(key, merged);
    setCart(merged);
    document.dispatchEvent(new CustomEvent("cart-updated"));
    return true;
  } catch (e) {
    return false;
  }
}

async function handleRecoverParam() {
  let params;
  try {
    params = new URLSearchParams(window.location.search || "");
  } catch (e) {
    return;
  }
  const cartId = params.get("recover_cart");
  if (!cartId) return;

  if (!isCartPage()) {
    window.location.replace(`/panier?recover_cart=${encodeURIComponent(cartId)}`);
    return;
  }

  await restoreCartFromDoc(cartId.slice(0, 200));
  showRecoveryBanner(readLang());

  try {
    window.history.replaceState({}, "", "/panier");
  } catch (e) {
    /* historique indisponible : le paramètre reste, sans conséquence */
  }
}

/* ============================================================
   LISTENERS
   ============================================================ */

function bindListeners() {
  document.addEventListener("cart-updated", () => scheduleSync(600));

  window.addEventListener("storage", (event) => {
    const key = String(event.key || "");
    if (key === CONFIG.STORAGE_KEYS.CART || key.startsWith(`${CONFIG.STORAGE_KEYS.CART}_`)) {
      scheduleSync(600);
    }
  });

  document.addEventListener("auth-updated", async (event) => {
    const user = event && event.detail ? event.detail.user : null;
    lastSyncedSignature = "";
    knownSessions = new Map();

    if (user && user.uid && guestDocWritten) {
      /* Le client vient de se connecter : le panier invité est repris
         par le document uid, le doc invité n'a plus de raison d'être. */
      try {
        await deleteDoc(doc(db, COLLECTION, guestDocWritten));
      } catch (e) {
        /* déjà supprimé / hors ligne : sans conséquence */
      }
      guestDocWritten = null;
    }

    scheduleSync(900);
  });

  document.addEventListener("smartswika:push-token", (event) => {
    const token = event && event.detail ? event.detail.token : "";
    if (!token || typeof token !== "string") return;
    fcmToken = token;
    safeSetItem(FCM_TOKEN_KEY, token);
    if (readCartSafe().length > 0) scheduleSync(400);
  });

  const isTrackedField = (target) =>
    target && (target.id === "cartName" || target.id === "cartPhone" || target.id === "cityFilterInput");

  document.addEventListener("input", (event) => {
    if (isTrackedField(event.target)) scheduleSync(1200);
  });

  document.addEventListener("change", (event) => {
    if (isTrackedField(event.target)) scheduleSync(600);
  });

  document.addEventListener("order-created", (event) => {
    const orderId = event && event.detail ? event.detail.orderId : null;
    markRecovered(orderId);
  });

  window.addEventListener("online", () => scheduleSync(200));
}

function init() {
  if (initialized) return;
  initialized = true;

  loadStoredToken();
  bindListeners();
  handleRecoverParam();

  /* Première synchronisation : laisse app.js charger le panier. */
  setTimeout(() => {
    if (readCartSafe().length > 0) scheduleSync(1200);
  }, 2500);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}

/* API de diagnostic (console) : aucune donnée sensible exportée. */
if (typeof window !== "undefined") {
  window.__abandonedCart = {
    delayMs: ABANDON_DELAY_MS,
    sessionId: () => currentSessionId(),
    sync: () => scheduleSync(0),
  };
}

console.log("✅ abandoned-cart.js chargé - v1.0.0 (capture paniers + relances)");
