/* ============================================================
   js/ads-attribution.js — SUIVI PERFORMANCE PUBLICITAIRE
   TikTok & Meta (attribution first-party + pixels)
   ------------------------------------------------------------
   Rôle :
     1. Capturer l'attribution à l'arrivée sur le site
        (utm_*, fbclid, ttclid, gclid + document.referrer).
     2. Normaliser la source principale :
        "tiktok" | "meta" | "google" | "whatsapp" | "direct" | "other".
     3. Conserver la DERNIÈRE campagne non-directe sur 7 jours
        (last-touch non-direct) dans localStorage `swi9a_attribution`.
     4. Déclencher les événements e-commerce standardisés (MAD) :
        ViewContent, AddToCart, InitiateCheckout, Purchase.
     5. Alimenter les compteurs agrégés anonymes
        `ad_events_daily/{YYYY-MM-DD}_{source}` (aucune donnée
        personnelle : uniquement des compteurs et un montant).

   CONTRAINTES :
     - Aucun import statique : le module reste testable sous Node
       (les imports Firebase sont chargés à la demande).
     - Aucune donnée personnelle : ni IP, ni nom, ni email, ni
       identifiant publicitaire complet. Seul le TYPE de click id
       (fbclid / ttclid) est conservé.
     - Toute erreur réseau/règles est non bloquante pour la vitrine.

   API publique :
     window.SmartswikaAds.track(eventName, payload)
     window.SmartswikaAds.flush(timeoutMs)
     window.SmartswikaAds.getAttribution()
     window.SmartswikaAds.buildOrderAttribution()
   ============================================================ */

const ATTRIBUTION_KEY = "swi9a_attribution";
const ATTRIBUTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ATTRIBUTION_VERSION = 1;
const SOURCES = ["tiktok", "meta", "google", "whatsapp", "direct", "other"];
const EVENT_COLLECTION = "ad_events_daily";
const PUBLIC_ADS_CONFIG = ["config", "ads_public"];
const MAX_EVENTS_IN_FLIGHT = 40;

const META_EVENTS = {
  ViewContent: "ViewContent",
  AddToCart: "AddToCart",
  InitiateCheckout: "InitiateCheckout",
  Purchase: "Purchase",
};

/* TikTok utilise CompletePayment pour l'achat. */
const TIKTOK_EVENTS = {
  ViewContent: "ViewContent",
  AddToCart: "AddToCart",
  InitiateCheckout: "InitiateCheckout",
  Purchase: "CompletePayment",
};

const EVENT_COUNTERS = {
  ViewContent: "viewContent",
  AddToCart: "addToCart",
  InitiateCheckout: "initiateCheckout",
  Purchase: "purchase",
};

const IS_BROWSER =
  typeof window !== "undefined" && typeof document !== "undefined";

/* ============================================================
   HELPERS PURS (testés par tests/ads-attribution.test.cjs)
   ============================================================ */

function clean(value, max) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function hostOf(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch (e) {
    return raw.toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  }
}

/**
 * Normalise une source publicitaire.
 * @param {string} utmSource valeur de utm_source
 * @param {string} referrer document.referrer
 * @param {string} [currentHost] hôte du site (navigation interne = direct)
 * @returns {"tiktok"|"meta"|"google"|"whatsapp"|"direct"|"other"}
 */
export function normalizeSource(utmSource, referrer, currentHost) {
  const utm = String(utmSource || "").trim().toLowerCase();
  const ref = hostOf(referrer);
  const self = String(currentHost || "").trim().toLowerCase();

  if (utm) {
    if (utm === "tiktok" || utm === "tt" || utm.includes("tiktok")) return "tiktok";
    if (
      utm === "facebook" || utm === "fb" || utm === "instagram" ||
      utm === "ig" || utm === "meta" || utm.includes("facebook") ||
      utm.includes("instagram")
    ) {
      return "meta";
    }
    if (utm === "google" || utm === "adwords" || utm === "gads" || utm.includes("google")) {
      return "google";
    }
    if (utm === "whatsapp" || utm === "wa" || utm.includes("whatsapp")) return "whatsapp";
    if (utm === "direct" || utm === "none" || utm === "(direct)") return "direct";
    return "other";
  }

  if (ref) {
    if (self && (ref === self || ref.endsWith("." + self))) return "direct";
    if (ref.includes("tiktok.com")) return "tiktok";
    if (
      ref.includes("facebook.com") || ref.includes("fb.com") ||
      ref.includes("instagram.com") || ref.includes("fbcdn.net")
    ) {
      return "meta";
    }
    if (ref.includes("google.")) return "google";
    if (ref.includes("whatsapp.com") || ref.includes("wa.me")) return "whatsapp";
    return "other";
  }

  return "direct";
}

/**
 * Construit l'attribution d'une visite.
 * @param {string} search query string (ex. window.location.search)
 * @param {string} referrer document.referrer
 * @param {number} [now] horodatage ms
 * @param {string} [currentHost] hôte courant
 * @returns {object} attribution normalisée
 */
export function parseAttribution(search, referrer, now, currentHost) {
  let params;
  try {
    params = new URLSearchParams(String(search || ""));
  } catch (e) {
    params = new URLSearchParams("");
  }

  const at = Number(now);
  const landedAt = Number.isFinite(at) && at > 0 ? at : Date.now();
  const fbclid = clean(params.get("fbclid"), 400);
  const ttclid = clean(params.get("ttclid"), 400);
  const utmSource = clean(params.get("utm_source"), 80);
  const utmMedium = clean(params.get("utm_medium"), 80);
  const campaign = clean(params.get("utm_campaign"), 120);
  const content = clean(params.get("utm_content"), 120);

  let source;
  let clickIdType = null;
  if (fbclid) {
    source = "meta";
    clickIdType = "fbclid";
  } else if (ttclid) {
    source = "tiktok";
    clickIdType = "ttclid";
  } else {
    source = normalizeSource(utmSource, referrer, currentHost);
  }

  let medium = utmMedium;
  if (!medium && clickIdType) medium = "paid_social";
  if (!medium && source === "direct") medium = "none";

  return {
    v: ATTRIBUTION_VERSION,
    source,
    medium: clean(medium, 80),
    campaign,
    content,
    clickIdType,
    landedAt,
  };
}

/** true si l'attribution est absente ou plus vieille que 7 jours. */
export function isAttributionExpired(attribution, now) {
  if (!attribution || typeof attribution !== "object") return true;
  const landedAt = Number(attribution.landedAt);
  const at = Number(now);
  const reference = Number.isFinite(at) && at > 0 ? at : Date.now();
  if (!Number.isFinite(landedAt) || landedAt <= 0) return true;
  if (landedAt > reference + 5 * 60 * 1000) return true; /* horloge incohérente */
  return reference - landedAt > ATTRIBUTION_TTL_MS;
}

function isNonDirect(attribution) {
  return Boolean(
    attribution &&
      (attribution.source !== "direct" || attribution.campaign)
  );
}

/**
 * Last-touch non-direct sur 7 jours :
 *   - une nouvelle campagne non-directe remplace l'ancienne ;
 *   - une visite directe conserve la campagne active valide ;
 *   - une campagne expirée est remplacée, même par du direct.
 */
export function mergeAttribution(previous, incoming, now) {
  if (!incoming || typeof incoming !== "object") {
    return previous && !isAttributionExpired(previous, now)
      ? previous
      : parseAttribution("", "", now);
  }
  if (isAttributionExpired(previous, now)) return incoming;
  if (isNonDirect(incoming)) return incoming;
  return previous;
}

/** Objet borné écrit dans `orders/{orderId}.attribution`. */
export function buildOrderAttribution(attribution, now) {
  const at = Number(now);
  const fallbackAt = Number.isFinite(at) && at > 0 ? at : Date.now();
  const source = SOURCES.includes(attribution && attribution.source)
    ? attribution.source
    : "direct";
  return {
    source,
    medium: clean(attribution && attribution.medium, 80),
    campaign: clean(attribution && attribution.campaign, 120),
    content: clean(attribution && attribution.content, 120),
    clickIdType:
      attribution && (attribution.clickIdType === "fbclid" || attribution.clickIdType === "ttclid")
        ? attribution.clickIdType
        : null,
    landedAt:
      attribution && Number(attribution.landedAt) > 0
        ? Number(attribution.landedAt)
        : fallbackAt,
  };
}

/** Clé locale `YYYY-MM-DD` (heure du Maroc = fuseau du navigateur). */
export function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Identifiant du document agrégé : {YYYY-MM-DD}_{source}. */
export function eventDocId(dateKeyValue, source) {
  const key = String(dateKeyValue || "");
  const src = SOURCES.includes(source) ? source : "direct";
  return `${key}_${src}`;
}

/** Slug de campagne sûr pour une URL UTM (max 80 caractères). */
export function slugifyCampaign(value) {
  return String(value == null ? "" : value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** URL prête à coller dans les pubs TikTok / Meta. */
export function buildUtmUrl(channel, campaign, base) {
  const raw = String(channel || "").trim().toLowerCase();
  const source = raw === "meta" || raw === "facebook" || raw === "instagram"
    ? "meta"
    : raw === "google"
    ? "google"
    : raw === "whatsapp"
    ? "whatsapp"
    : "tiktok";
  const medium = source === "whatsapp" ? "social" : "paid_social";
  const slug = slugifyCampaign(campaign) || "campagne";
  const root = String(base || "https://www.smartswika.ma/").replace(/\/+$/, "/");
  return `${root}?utm_source=${source}&utm_medium=${medium}&utm_campaign=${encodeURIComponent(slug)}`;
}

export const ADS_ATTRIBUTION = {
  KEY: ATTRIBUTION_KEY,
  TTL_MS: ATTRIBUTION_TTL_MS,
  SOURCES,
  EVENT_COLLECTION,
};

/* ============================================================
   ÉTAT NAVIGATEUR
   ============================================================ */

let initialized = false;
let attributionCache = null;
let firebasePromise = null;
let cartBaseline = null;
let checkoutFired = false;
let purchaseTracked = new Set();
let suppressCartEventsUntil = 0;
let flushQueue = new Set();
let pixels = { meta: false, tiktok: false };

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (e) {
    /* stockage indisponible (navigation privée) : non bloquant */
  }
}

function readStoredAttribution() {
  const raw = storageGet(ATTRIBUTION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!SOURCES.includes(parsed.source)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function writeStoredAttribution(attr) {
  storageSet(ATTRIBUTION_KEY, JSON.stringify(attr));
}

/** Attribution courante (relue et recalculée au besoin). */
export function getAttribution(now) {
  if (attributionCache) return attributionCache;
  const stored = readStoredAttribution();
  const reference = Number(now) || Date.now();
  if (stored && !isAttributionExpired(stored, reference)) {
    attributionCache = stored;
    return attributionCache;
  }
  attributionCache = parseAttribution("", "", reference);
  writeStoredAttribution(attributionCache);
  return attributionCache;
}

/** Capture (ou rafraîchit) l'attribution à l'arrivée sur le site. */
function captureAttribution(now) {
  const reference = Number(now) || Date.now();
  const incoming = parseAttribution(
    window.location.search || "",
    document.referrer || "",
    reference,
    window.location.hostname || ""
  );
  const previous = readStoredAttribution();
  const next = mergeAttribution(previous, incoming, reference);
  attributionCache = next;
  writeStoredAttribution(next);
  return next;
}

/* ============================================================
   FIREBASE (imports à la demande, jamais bloquants)
   ============================================================ */

async function getFirebase() {
  if (!firebasePromise) {
    firebasePromise = Promise.all([
      import("firebase/firestore"),
      import("./firebase.js"),
    ]).then(([fs, fb]) => ({ fs, db: fb.db }));
  }
  return firebasePromise;
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function trackQueue(promise) {
  flushQueue.add(promise);
  promise.finally(() => flushQueue.delete(promise));
  if (flushQueue.size > MAX_EVENTS_IN_FLIGHT) {
    const first = flushQueue.values().next().value;
    flushQueue.delete(first);
  }
  return promise;
}

/**
 * Enregistre un compteur agrégé anonyme :
 *   ad_events_daily/{YYYY-MM-DD}_{source}
 * Aucune donnée personnelle, aucun click id.
 */
async function recordAdEvent(canonical, payload) {
  const counter = EVENT_COUNTERS[canonical];
  if (!counter) return false;
  const { fs, db } = await getFirebase();
  const attr = getAttribution();
  const dateKeyValue = dayKey(new Date());
  if (!dateKeyValue) return false;
  const ref = fs.doc(db, EVENT_COLLECTION, eventDocId(dateKeyValue, attr.source));
  const data = {
    date: dateKeyValue,
    source: SOURCES.includes(attr.source) ? attr.source : "direct",
    updatedAt: fs.serverTimestamp(),
  };
  data[counter] = fs.increment(1);
  if (canonical === "Purchase") {
    const value = round2(payload && payload.value);
    if (value > 0) data.revenueCreatedMad = fs.increment(value);
  }
  await fs.setDoc(ref, data, { merge: true });
  return true;
}

/* ============================================================
   PIXELS META / TIKTOK
   ============================================================ */

function loadMetaPixel(pixelId) {
  if (!/^[0-9]{6,32}$/.test(String(pixelId || ""))) return false;
  if (typeof window.fbq !== "function") {
    /* Stub officiel : la file est vidée dès le chargement du script. */
    window.fbq = function () {
      window.fbq.callMethod
        ? window.fbq.callMethod.apply(window.fbq, arguments)
        : window.fbq.queue.push(arguments);
    };
    if (!window._fbq) window._fbq = window.fbq;
    window.fbq.push = window.fbq;
    window.fbq.loaded = true;
    window.fbq.version = "2.0";
    window.fbq.queue = [];
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    (document.head || document.documentElement).appendChild(script);
  }
  window.fbq("init", String(pixelId));
  window.fbq("track", "PageView");
  pixels.meta = true;
  return true;
}

function loadTiktokPixel(pixelId) {
  if (!/^[A-Z0-9]{6,40}$/i.test(String(pixelId || ""))) return false;
  if (!window.ttq) {
    const w = window;
    const d = document;
    const t = "ttq";
    w.TiktokAnalyticsObject = t;
    const ttq = (w[t] = w[t] || []);
    ttq.methods = [
      "page", "track", "identify", "instances", "debug", "on", "off",
      "once", "ready", "alias", "group", "enableCookie", "disableCookie",
      "holdConsent", "revokeConsent", "grantConsent",
    ];
    ttq.setAndDefer = function (target, method) {
      target[method] = function () {
        target.push([method].concat(Array.prototype.slice.call(arguments, 0)));
      };
    };
    for (let i = 0; i < ttq.methods.length; i++) {
      ttq.setAndDefer(ttq, ttq.methods[i]);
    }
    ttq.instance = function (id) {
      const instance = ttq._i[id] || [];
      for (let j = 0; j < ttq.methods.length; j++) {
        ttq.setAndDefer(instance, ttq.methods[j]);
      }
      return instance;
    };
    ttq.load = function (id) {
      const url = "https://analytics.tiktok.com/i18n/pixel/events.js";
      ttq._i = ttq._i || {};
      ttq._i[id] = [];
      ttq._i[id]._u = url;
      ttq._t = ttq._t || {};
      ttq._t[id] = +new Date();
      ttq._o = ttq._o || {};
      ttq._o[id] = {};
      const script = d.createElement("script");
      script.type = "text/javascript";
      script.async = true;
      script.src = url + "?sdkid=" + id + "&lib=ttq";
      const first = d.getElementsByTagName("script")[0];
      if (first && first.parentNode) first.parentNode.insertBefore(script, first);
      else (d.head || d.documentElement).appendChild(script);
    };
  }
  window.ttq.load(String(pixelId));
  window.ttq.page();
  pixels.tiktok = true;
  return true;
}

async function initPixels() {
  try {
    const { fs, db } = await getFirebase();
    const snap = await fs.getDoc(fs.doc(db, PUBLIC_ADS_CONFIG[0], PUBLIC_ADS_CONFIG[1]));
    if (!snap.exists()) return;
    const data = snap.data() || {};
    if (data.metaPixelId) loadMetaPixel(data.metaPixelId);
    if (data.tiktokPixelId) loadTiktokPixel(data.tiktokPixelId);
  } catch (e) {
    /* pixels indisponibles : les compteurs Firestore restent actifs */
  }
}

/* ============================================================
   PASSERELLE UNIFIÉE fbq / ttq / Firestore
   ============================================================ */

function canonicalEvent(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (raw === "viewcontent") return "ViewContent";
  if (raw === "addtocart") return "AddToCart";
  if (raw === "initiatecheckout") return "InitiateCheckout";
  if (raw === "purchase" || raw === "completepayment") return "Purchase";
  return "";
}

function normalizeEventPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const rawIds = Array.isArray(source.content_ids)
    ? source.content_ids
    : source.content_id != null
    ? [source.content_id]
    : [];
  const ids = rawIds
    .slice(0, 50)
    .map((id) => String(id == null ? "" : id).slice(0, 120))
    .filter(Boolean);
  return {
    content_ids: ids,
    content_name: clean(source.content_name, 200),
    value: round2(source.value),
    currency: "MAD",
    num_items: Math.max(1, Math.floor(Number(source.num_items) || 1)),
    order_id: clean(source.order_id, 120),
  };
}

function sendPixels(canonical, payload) {
  if (pixels.meta && typeof window.fbq === "function") {
    window.fbq("track", META_EVENTS[canonical], {
      content_ids: payload.content_ids,
      content_type: "product",
      content_name: payload.content_name || undefined,
      value: payload.value,
      currency: "MAD",
      num_items: payload.num_items,
      order_id: payload.order_id || undefined,
    });
  }
  if (pixels.tiktok && window.ttq && typeof window.ttq.track === "function") {
    window.ttq.track(TIKTOK_EVENTS[canonical], {
      content_id: payload.content_ids[0] || undefined,
      content_type: "product",
      content_name: payload.content_name || undefined,
      quantity: payload.num_items,
      value: payload.value,
      currency: "MAD",
      order_id: payload.order_id || undefined,
    });
  }
}

/**
 * Passerelle unifiée. Toujours non bloquante : renvoie une promesse
 * résolue même si les pixels ou Firestore sont indisponibles.
 * @param {string} eventName ViewContent | AddToCart | InitiateCheckout | Purchase
 * @param {object} payload { content_ids, content_name, value, currency, num_items, order_id }
 * @returns {Promise<boolean>}
 */
export function track(eventName, payload) {
  const canonical = canonicalEvent(eventName);
  if (!IS_BROWSER || !canonical) return Promise.resolve(false);
  const safePayload = normalizeEventPayload(payload);
  try {
    sendPixels(canonical, safePayload);
  } catch (e) {
    /* un pixel en erreur ne doit jamais casser la navigation */
  }
  return trackQueue(
    recordAdEvent(canonical, safePayload).catch((error) => {
      console.warn("[ads-attribution] compteur non enregistré :", error && error.message);
      return false;
    })
  );
}

/** Attend les écritures en cours (borné), avant navigation WhatsApp. */
export async function flush(timeoutMs) {
  if (!flushQueue.size) return true;
  const wait = Math.max(0, Number(timeoutMs) || 0);
  const all = Promise.allSettled(Array.from(flushQueue));
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, wait);
  });
  await Promise.race([all, timeout]);
  if (timer) clearTimeout(timer);
  return true;
}

/* ============================================================
   PANIER & ÉVÉNEMENTS AUTOMATIQUES
   ============================================================ */

/**
 * Photographie du panier local, sans dépendre de store.js :
 *   Map(productId -> { qty, amount })
 * On garde la clé de panier la plus remplie (anonyme ou {uid}).
 */
function readCartSnapshot() {
  const entries = new Map();
  try {
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith("swi9a_cart")) continue;
      if (key.includes("abandoned")) continue;
      keys.push(key);
    }
    let best = new Map();
    let bestQty = -1;
    for (const key of keys) {
      const raw = storageGet(key);
      if (!raw) continue;
      let lines;
      try {
        lines = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      if (!Array.isArray(lines)) continue;
      const map = new Map();
      let qty = 0;
      for (const line of lines) {
        if (!line || line.productId == null) continue;
        const id = String(line.productId);
        const quantity = Math.max(0, Math.floor(Number(line.quantity) || 0));
        if (!id || quantity <= 0) continue;
        const unit = Number(line.variant && line.variant.price) || 0;
        const previous = map.get(id) || { qty: 0, amount: 0 };
        map.set(id, {
          qty: previous.qty + quantity,
          amount: previous.amount + unit * quantity,
        });
        qty += quantity;
      }
      if (qty > bestQty) {
        best = map;
        bestQty = qty;
      }
    }
    best.forEach((value, id) => entries.set(id, value));
  } catch (e) {
    /* localStorage indisponible : snapshot vide */
  }
  return entries;
}

function snapshotQty(snapshot) {
  let total = 0;
  snapshot.forEach((value) => {
    total += Number(value.qty) || 0;
  });
  return total;
}

function isCartPage() {
  const path = String(window.location.pathname || "").replace(/\/+$/, "");
  return path === "/panier" || path.endsWith("/panier") || path.endsWith("/panier.html");
}

async function pricesFor(ids) {
  const prices = new Map();
  try {
    const store = await import("./store.js");
    const products = store.getProducts() || [];
    for (const id of ids) {
      const product = products.find((p) => String(p.id) === String(id));
      if (!product) continue;
      const flash = Number(product.flashPrice);
      prices.set(String(id), flash > 0 ? flash : Number(product.price) || 0);
    }
  } catch (e) {
    /* catalogue indisponible : valeur 0, l'événement reste compté */
  }
  return prices;
}

async function handleCartUpdated() {
  const next = readCartSnapshot();
  if (!cartBaseline || Date.now() < suppressCartEventsUntil) {
    /* Connexion / synchronisation Firestore : le panier restauré
       n'est PAS un ajout volontaire, on recale sans émettre. */
    cartBaseline = next;
    if (isCartPage()) maybeInitiateCheckout();
    return;
  }
  const previous = cartBaseline;
  const increased = [];
  const deltas = new Map();
  let deltaQty = 0;
  next.forEach((value, id) => {
    const before = previous.get(id) || { qty: 0 };
    const delta = Number(value.qty) - Number(before.qty);
    if (delta > 0) {
      increased.push(id);
      deltas.set(id, delta);
      deltaQty += delta;
    }
  });
  cartBaseline = next;
  if (!increased.length || deltaQty <= 0) {
    if (isCartPage()) maybeInitiateCheckout();
    return;
  }
  const prices = await pricesFor(increased);
  let value = 0;
  increased.forEach((id) => {
    value += (prices.get(id) || 0) * Number(deltas.get(id) || 0);
  });
  track("AddToCart", {
    content_ids: increased,
    content_name: "",
    value,
    currency: "MAD",
    num_items: deltaQty,
  });
  if (isCartPage()) maybeInitiateCheckout();
}

async function maybeInitiateCheckout(force) {
  if (checkoutFired && !force) return;
  if (!isCartPage()) return;
  const snapshot = cartBaseline || readCartSnapshot();
  const qty = snapshotQty(snapshot);
  if (qty <= 0) return;
  checkoutFired = true;
  const ids = Array.from(snapshot.keys());
  const prices = await pricesFor(ids);
  let value = 0;
  snapshot.forEach((line, id) => {
    value += (prices.get(id) || 0) * Number(line.qty || 0);
  });
  track("InitiateCheckout", {
    content_ids: ids,
    value,
    currency: "MAD",
    num_items: qty,
  });
}

function handleProductView(event) {
  const product = event && event.detail ? event.detail.product : null;
  if (!product || product.id == null) return;
  const flash = Number(product.flashPrice);
  const value = flash > 0 ? flash : Number(product.price) || 0;
  track("ViewContent", {
    content_ids: [product.id],
    content_name: product.nameFr || product.nameEn || product.nameAr || "",
    value,
    currency: "MAD",
    num_items: 1,
  });
}

function handleOrderCreated(event) {
  const detail = event && event.detail ? event.detail : null;
  if (!detail || !detail.orderId) return;
  const orderId = String(detail.orderId);
  if (purchaseTracked.has(orderId)) return;
  purchaseTracked.add(orderId);
  const items = Array.isArray(detail.items) ? detail.items : [];
  const ids = items
    .map((item) => (item && item.productId != null ? String(item.productId) : ""))
    .filter(Boolean);
  const numItems = items.reduce(
    (sum, item) => sum + Math.max(1, Math.floor(Number(item && item.quantity) || 1)),
    0
  );
  const value = Number(detail.totals && detail.totals.total) || 0;
  track("Purchase", {
    content_ids: ids,
    value,
    currency: "MAD",
    num_items: numItems || 1,
    order_id: orderId,
  });
}

/* ============================================================
   INITIALISATION & ÉCOUTEURS
   ============================================================ */

function bindEvents() {
  document.addEventListener("smartswika:product-viewed", handleProductView);

  document.addEventListener("cart-updated", () => {
    handleCartUpdated();
  });

  document.addEventListener("order-created", (event) => {
    handleOrderCreated(event);
    flush(1500);
  });

  /* Une connexion peut restaurer le panier Firestore : pendant 2,5 s
     les variations ne sont pas des ajouts volontaires. */
  document.addEventListener("auth-updated", () => {
    suppressCartEventsUntil = Date.now() + 2500;
    cartBaseline = readCartSnapshot();
  });

  /* Le clic sur « Confirmer la commande » complète l'InitiateCheckout
     si la page panier n'a pas encore émis l'événement (panier vide
     au chargement puis rempli dans la même visite). */
  document.addEventListener(
    "click",
    (event) => {
      const target = event && event.target;
      if (target && typeof target.closest === "function" && target.closest("#cartPageCheckout")) {
        maybeInitiateCheckout();
      }
    },
    true
  );

  window.addEventListener("storage", (event) => {
    const key = String(event && event.key ? event.key : "");
    if (key.startsWith("swi9a_cart") && !key.includes("abandoned")) {
      handleCartUpdated();
    }
  });
}

function init() {
  if (!IS_BROWSER || initialized) return;
  initialized = true;

  captureAttribution(Date.now());
  cartBaseline = readCartSnapshot();
  bindEvents();
  initPixels();

  if (isCartPage() && snapshotQty(cartBaseline) > 0) {
    /* Laisse panier.js / app.js charger le panier avant l'événement. */
    setTimeout(() => maybeInitiateCheckout(), 1500);
  }
}

/* ============================================================
   API PUBLIQUE
   ============================================================ */

if (IS_BROWSER) {
  window.SmartswikaAds = {
    version: "1.0.1",
    track,
    flush,
    getAttribution: () => getAttribution(),
    buildOrderAttribution: () => buildOrderAttribution(getAttribution()),
    refreshAttribution: () => captureAttribution(Date.now()),
    buildUtmUrl,
    pixels: () => ({ meta: pixels.meta, tiktok: pixels.tiktok }),
  };
  window.__adsAttribution = window.SmartswikaAds;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
}

console.log(
  "✅ ads-attribution.js chargé - v1.0.1 (attribution 7j + pixels TikTok/Meta)"
);







