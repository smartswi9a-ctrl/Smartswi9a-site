/* ============================================================
   js/admin-abandoned.js — ONGLET « 🛒 PANIERS ABANDONNÉS »
   ------------------------------------------------------------
   Responsabilités :
     1. Badge temps réel dans la sidebar (paniers non récupérés
        depuis > 45 min avec téléphone ou token push).
     2. 4 KPI (count-up via admin-ui.js) :
        abandonnés 7j, montant potentiel, récupérés, taux.
     3. Filtres rapides : tous / téléphone / push / récupérés.
     4. Tableau responsive (cartes empilées en mobile 390px).
     5. Relance WhatsApp pré-rédigée FR/EN/AR + statut
        "reminded_whatsapp".
     6. Suppression avec confirmation.
   Aucune écriture email : ce module n'envoie que WhatsApp.
   ============================================================ */

import {
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "./firebase.js";
import { adminT, getAdminLang } from "./admin-ui.js?v=drawer2027c";
import { showToast, confirmAction } from "./ui-core.js";
import { escapeHTML } from "./utils.js";

const COLLECTION = "abandoned_carts";
const ABANDON_DELAY_MS = 45 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DOCS = 300;
const ITEMS_PREVIEW = 3;

let unsubscribe = null;
let cachedCarts = [];
let activeFilter = "all";
let filtersBound = false;
let tickTimer = null;

/* ============================================================
   HELPERS
   ============================================================ */

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeCart(id, data) {
  const raw = data || {};
  const items = Array.isArray(raw.items)
    ? raw.items.map((item) => ({
        id: String((item && item.id) || ""),
        title: String((item && item.title) || ""),
        qty: Math.max(1, Math.floor(Number(item && item.qty) || 1)),
        price: Number((item && item.price) || 0),
        image: String((item && item.image) || ""),
      }))
    : [];
  return {
    id: String(id),
    cartId: String(raw.cartId || id),
    uid: raw.uid ? String(raw.uid) : null,
    customerName: String(raw.customerName || ""),
    phone: String(raw.phone || ""),
    city: String(raw.city || ""),
    lang: raw.lang === "en" || raw.lang === "ar" ? raw.lang : "fr",
    items,
    subtotalMad: Number(raw.subtotalMad) || 0,
    discountMad: Number(raw.discountMad) || 0,
    totalMad: Number(raw.totalMad) || 0,
    fcmToken: typeof raw.fcmToken === "string" ? raw.fcmToken : "",
    status: String(raw.status || "active"),
    createdAt: toMillis(raw.createdAt),
    updatedAt: toMillis(raw.updatedAt) || toMillis(raw.createdAt),
    remindedAt: toMillis(raw.remindedAt),
  };
}

function localeTag() {
  const lang = getAdminLang();
  return lang === "ar" ? "ar-MA-u-nu-latn" : lang === "en" ? "en-GB" : "fr-FR";
}

function formatMoney(value) {
  const num = Number(value) || 0;
  try {
    return new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 2 }).format(num) + " MAD";
  } catch (e) {
    return Math.round(num) + " MAD";
  }
}

function formatRelative(ms) {
  if (!ms) return "—";
  const delta = Date.now() - ms;
  const lang = getAdminLang();
  try {
    const rtf = new Intl.RelativeTimeFormat(
      lang === "ar" ? "ar" : lang === "en" ? "en" : "fr",
      { numeric: "auto" }
    );
    if (delta < 60 * 1000) return rtf.format(-1, "minute");
    if (delta < 60 * 60 * 1000) return rtf.format(-Math.round(delta / 60000), "minute");
    if (delta < 24 * 60 * 60 * 1000) return rtf.format(-Math.round(delta / 3600000), "hour");
    return rtf.format(-Math.round(delta / 86400000), "day");
  } catch (e) {
    const minutes = Math.max(1, Math.round(delta / 60000));
    return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  }
}

function normalizeWhatsAppPhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00212")) digits = digits.slice(5);
  else if (digits.startsWith("212")) digits = digits.slice(3);
  if (digits.startsWith("0")) return "212" + digits.slice(1);
  if (digits.length === 9 && /^[67]/.test(digits)) return "212" + digits;
  return digits;
}

function statusLabelKey(status) {
  if (status === "reminded_push") return "abandonedStatusPush";
  if (status === "reminded_whatsapp") return "abandonedStatusWhatsapp";
  if (status === "recovered") return "abandonedStatusRecovered";
  if (status === "abandoned") return "abandonedStatusAbandoned";
  return "abandonedStatusActive";
}

function statusClass(status) {
  if (status === "recovered") return "is-recovered";
  if (status === "reminded_push" || status === "reminded_whatsapp") return "is-reminded";
  if (status === "abandoned") return "is-abandoned";
  return "is-active";
}

function cartIsAbandoned(cart, now = Date.now()) {
  if (!cart.updatedAt) return false;
  if (cart.status === "recovered") return false;
  return now - cart.updatedAt >= ABANDON_DELAY_MS;
}

function buildWhatsAppMessage(cart) {
  const lang = cart.lang === "en" || cart.lang === "ar" ? cart.lang : "fr";
  const name = cart.customerName ? ` ${cart.customerName}` : "";
  const lines = cart.items
    .map((item) => `• ${item.title || "#" + item.id} ×${item.qty} — ${formatMoney(item.price * item.qty)}`)
    .join("\n");
  const total = formatMoney(cart.totalMad);
  const link = `https://smartswika.ma/?recover_cart=${encodeURIComponent(cart.id)}`;

  if (lang === "en") {
    return `Hello${name} 👋\n\nYour Smartswika cart is waiting:\n${lines}\n\nTotal: ${total} (Cash on Delivery 24-72h)\nComplete your order: ${link}`;
  }
  if (lang === "ar") {
    return `مرحباً${name} 👋\n\nسلتك في Smartswika بانتظارك:\n${lines}\n\nالمجموع: ${total} (الدفع عند الاستلام خلال 24-72 ساعة)\nأكمل طلبك: ${link}`;
  }
  return `Bonjour${name} 👋\n\nVotre panier Smartswika vous attend :\n${lines}\n\nTotal : ${total} (paiement à la livraison 24-72h)\nFinalisez votre commande : ${link}`;
}

/* ============================================================
   KPI + BADGE
   ============================================================ */

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderKpis() {
  const now = Date.now();
  const recent = cachedCarts.filter((cart) => cart.updatedAt && now - cart.updatedAt <= WEEK_MS);
  const abandoned = recent.filter((cart) => cart.status !== "recovered");
  const recovered = recent.filter((cart) => cart.status === "recovered");
  const potential = abandoned.reduce((sum, cart) => sum + (Number(cart.totalMad) || 0), 0);
  const rate = recent.length ? Math.round((recovered.length / recent.length) * 100) : 0;

  setText("abandonedKpiAbandoned", String(abandoned.length));
  setText("abandonedKpiAmount", formatMoney(potential));
  setText("abandonedKpiRecovered", String(recovered.length));
  setText("abandonedKpiRate", rate + " %");
}

export function updateAbandonedBadge() {
  const badge = document.getElementById("navBadgeAbandoned");
  if (!badge) return;
  const now = Date.now();
  const count = cachedCarts.filter(
    (cart) => cartIsAbandoned(cart, now) && (cart.phone || cart.fcmToken)
  ).length;
  if (count > 0) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.hidden = false;
    badge.title = adminT("abandonedBadgeHint");
  } else {
    badge.hidden = true;
  }
}

/* ============================================================
   TABLEAU RESPONSIVE
   ============================================================ */

function getFilteredCarts() {
  if (activeFilter === "phone") return cachedCarts.filter((cart) => Boolean(cart.phone));
  if (activeFilter === "push") return cachedCarts.filter((cart) => cart.status === "reminded_push");
  if (activeFilter === "recovered") return cachedCarts.filter((cart) => cart.status === "recovered");
  return cachedCarts;
}

function itemsPreview(cart) {
  if (!cart.items.length) return "—";
  const titles = cart.items.slice(0, ITEMS_PREVIEW).map(
    (item) =>
      `${escapeHTML(item.title || "#" + item.id)} <span class="abandoned-qty">×${item.qty}</span>`
  );
  const extra = cart.items.length - ITEMS_PREVIEW;
  if (extra > 0) {
    titles.push(
      `<span class="abandoned-more">${escapeHTML(
        adminT("abandonedItemsMore").replace("{n}", String(extra))
      )}</span>`
    );
  }
  return titles.join("<br>");
}

function cartRowHtml(cart) {
  const labels = {
    client: adminT("abandonedColClient"),
    city: adminT("abandonedColCity"),
    items: adminT("abandonedColItems"),
    total: adminT("abandonedColTotal"),
    age: adminT("abandonedColAge"),
    status: adminT("abandonedColStatus"),
    actions: adminT("abandonedColActions"),
  };
  const name = cart.customerName ? escapeHTML(cart.customerName) : adminT("abandonedGuest");
  const phone = cart.phone ? escapeHTML(cart.phone) : adminT("abandonedNoPhone");
  const hasPhone = Boolean(cart.phone);
  const itemCount = cart.items.reduce((sum, item) => sum + item.qty, 0);

  return `<tr data-cart-id="${escapeHTML(cart.id)}">
    <td data-label="${escapeHTML(labels.client)}">
      <div class="abandoned-client">
        <span class="abandoned-avatar" aria-hidden="true">👤</span>
        <div class="abandoned-client-info">
          <strong>${name}</strong>
          <span class="abandoned-phone">${phone}</span>
        </div>
      </div>
    </td>
    <td data-label="${escapeHTML(labels.city)}">${cart.city ? escapeHTML(cart.city) : "—"}</td>
    <td data-label="${escapeHTML(labels.items)}">
      <div class="abandoned-items">${itemsPreview(cart)}</div>
      <span class="abandoned-count">${itemCount} ${escapeHTML(adminT("abandonedArticles"))}</span>
    </td>
    <td data-label="${escapeHTML(labels.total)}">
      <strong class="abandoned-total">${formatMoney(cart.totalMad)}</strong>
    </td>
    <td data-label="${escapeHTML(labels.age)}">${escapeHTML(formatRelative(cart.updatedAt))}</td>
    <td data-label="${escapeHTML(labels.status)}">
      <span class="abandoned-status ${statusClass(cart.status)}">${escapeHTML(
        adminT(statusLabelKey(cart.status))
      )}</span>
    </td>
    <td data-label="${escapeHTML(labels.actions)}">
      <div class="abandoned-actions">
        <button type="button" class="abandoned-btn abandoned-btn--wa"
          data-abandoned-wa="${escapeHTML(cart.id)}"${hasPhone ? "" : " disabled"}
          title="${escapeHTML(hasPhone ? adminT("abandonedWhatsApp") : adminT("abandonedNoPhone"))}">
          💬 ${escapeHTML(adminT("abandonedWhatsApp"))}
        </button>
        <button type="button" class="abandoned-btn abandoned-btn--del"
          data-abandoned-del="${escapeHTML(cart.id)}">
          🗑️ ${escapeHTML(adminT("abandonedDelete"))}
        </button>
      </div>
    </td>
  </tr>`;
}

function renderRows() {
  const body = document.getElementById("abandonedCartsBody");
  if (!body) return;
  const empty = document.getElementById("abandonedEmpty");
  const rows = getFilteredCarts();

  if (!rows.length) {
    body.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  body.innerHTML = rows.map(cartRowHtml).join("");
}

function renderAll() {
  renderKpis();
  renderRows();
  updateAbandonedBadge();
}

/* ============================================================
   ACTIONS (WhatsApp + suppression)
   ============================================================ */

function handleWhatsApp(cartId) {
  const cart = cachedCarts.find((entry) => entry.id === cartId);
  if (!cart) return;
  const phone = normalizeWhatsAppPhone(cart.phone);
  if (!phone) {
    showToast(adminT("abandonedNoPhone"), 4000);
    return;
  }

  const url = `https://wa.me/${phone}?text=${encodeURIComponent(buildWhatsAppMessage(cart))}`;
  /* Ouvre immédiatement (geste utilisateur = pas de blocage popup). */
  window.open(url, "_blank", "noopener");

  cart.status = "reminded_whatsapp";
  cart.remindedAt = Date.now();
  renderAll();

  updateDoc(doc(db, COLLECTION, cartId), {
    status: "reminded_whatsapp",
    remindedAt: serverTimestamp(),
  })
    .then(() => showToast(adminT("abandonedWhatsAppSent"), 3500))
    .catch((error) => {
      console.warn("[admin-abandoned] statut WhatsApp :", error && error.message);
      showToast(adminT("abandonedError"), 4000);
    });
}

async function handleDelete(cartId) {
  const confirmed = await confirmAction(adminT("abandonedConfirmDelete"), {
    title: adminT("abandonedDelete"),
    confirmText: adminT("delete"),
    cancelText: adminT("cancel"),
  });
  if (!confirmed) return;

  try {
    await deleteDoc(doc(db, COLLECTION, cartId));
    cachedCarts = cachedCarts.filter((cart) => cart.id !== cartId);
    renderAll();
    showToast(adminT("abandonedDeleted"), 3000);
  } catch (error) {
    console.warn("[admin-abandoned] suppression :", error && error.message);
    showToast(adminT("abandonedError"), 4000);
  }
}

function bindActions() {
  const root = document.getElementById("abandonedCartsList");
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";

  root.addEventListener("click", (event) => {
    const waBtn = event.target.closest("[data-abandoned-wa]");
    if (waBtn) {
      handleWhatsApp(waBtn.dataset.abandonedWa);
      return;
    }
    const deleteBtn = event.target.closest("[data-abandoned-del]");
    if (deleteBtn) handleDelete(deleteBtn.dataset.abandonedDel);
  });
}

/* ============================================================
   FILTRES + ÉCOUTE TEMPS RÉEL
   ============================================================ */

function bindFilters() {
  if (filtersBound) return;
  filtersBound = true;

  document.querySelectorAll("[data-abandoned-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.abandonedFilter || "all";
      document.querySelectorAll("[data-abandoned-filter]").forEach((other) => {
        other.classList.toggle("active", other === btn);
        other.setAttribute("aria-selected", other === btn ? "true" : "false");
      });
      renderRows();
    });
  });

  document.getElementById("abandonedRefreshBtn")?.addEventListener("click", () => {
    renderAll();
    showToast(adminT("abandonedRefreshed"), 2000);
  });
}

export function startAbandonedCartWatch() {
  if (unsubscribe) return;
  try {
    const cartsQuery = query(
      collection(db, COLLECTION),
      orderBy("updatedAt", "desc"),
      limit(MAX_DOCS)
    );
    unsubscribe = onSnapshot(
      cartsQuery,
      (snapshot) => {
        cachedCarts = snapshot.docs.map((entry) => normalizeCart(entry.id, entry.data()));
        renderAll();
      },
      (error) => {
        console.warn("[admin-abandoned] écoute impossible :", error && error.message);
      }
    );
  } catch (error) {
    console.warn("[admin-abandoned] démarrage impossible :", error && error.message);
  }
}

export function stopAbandonedCartWatch() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  cachedCarts = [];
  updateAbandonedBadge();
}

export function initAbandonedTab() {
  bindFilters();
  bindActions();
  startAbandonedCartWatch();
  renderAll();

  if (!tickTimer) {
    /* Rafraîchit « Temps écoulé » toutes les 60 s sans relire Firestore. */
    tickTimer = setInterval(() => {
      const panel = document.getElementById("tab-abandoned");
      if (panel && panel.classList.contains("active")) renderAll();
    }, 60000);
  }
}

/* ============================================================
   AUDIT VISUEL (Playwright) — injection de données factices
   ------------------------------------------------------------
   N'écrit jamais dans Firestore : remplace uniquement le cache
   local pour capturer l'onglet sans compte de test.
   ============================================================ */

if (typeof window !== "undefined") {
  let previewRows = null;

  const applyPreview = () => {
    const now = Date.now();
    cachedCarts = (Array.isArray(previewRows) ? previewRows : []).map((row, index) =>
      normalizeCart(`preview-${index + 1}`, {
        ...row,
        updatedAt: row && row.updatedAt ? row.updatedAt : new Date(now - (index + 1) * 3600000),
        createdAt: row && row.createdAt ? row.createdAt : new Date(now - (index + 2) * 3600000),
      })
    );
    renderAll();
  };

  window.__abandonedAdminPreview = (rows) => {
    previewRows = Array.isArray(rows) ? rows : [];
    applyPreview();
  };

  document.addEventListener("admin-lang-changed", () => {
    if (previewRows) applyPreview();
  });
}

/* Le changement de langue admin (admin-ui.js) doit retraduire le
   tableau sans attendre un nouvel instantané Firestore. */
if (typeof document !== "undefined") {
  document.addEventListener("admin-lang-changed", () => {
    try {
      renderAll();
    } catch (e) {
      /* non bloquant */
    }
  });
}

console.log("✅ admin-abandoned.js chargé - v1.0.0 (onglet paniers abandonnés)");
