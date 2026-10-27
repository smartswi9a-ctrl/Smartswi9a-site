/* ============================================================ js/utils.js UTILITAIRES - SMART SWI9A Version 9.0.0 - Lot 2/30 : ajout helpers Livo + corrections mineures CHANGEMENTS v9.0.0 : - Ajout : LIVO_ID_PREFIXES, getLivoIdPrefix, isValidLivoId, cleanLivoId, formatLivoDate, parseLivoDate, cleanMoroccanPhone, normalizeMoroccanPhone. - Ajout : helpers LIVO_STATUS_MAP pour affichage (via config). - Correction : getCityName retourne '' (et non le nom arabe) en FR si nameFr ET key sont vides (bug P2-16). - Correction : cleanMoroccanPhone gère 9 chiffres 6/7 sans préfixe 0/212. - Retrait : import ORDER_LEGACY_STATUS inutilisé. - Documentation : comportement de getCityName clarifié. ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc (/* ... *\/). ============================================================ */

import {
  CONFIG,
  LANGUAGES,
  DEFAULT_LANGUAGE,
  CURRENCY_SUFFIX,
  ORDER_STATUS,
  REVIEW_STATUS,
  normalizeOrderStatus,
  getReturnedQuantities,
} from "./config.js";

/* ============================================================ LANGUE (évite le ReferenceError au chargement) ============================================================ */
let currentLang = "fr";

function isDevMode() {
  if (typeof window === "undefined") return false;
  return (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.search.includes("debug=1")
  );
}

/* ============================================================ I18N ============================================================ */
export function t(key) {
  const translations = window.translations || {};
  const langValue = translations[currentLang]?.[key];
  if (langValue !== undefined && langValue !== null) return langValue;

  const defaultVal = translations[DEFAULT_LANGUAGE]?.[key];
  if (defaultVal !== undefined && defaultVal !== null) return defaultVal;

  if (isDevMode())
    console.warn(`[i18n] Clé manquante : "${key}" (lang: ${currentLang})`);
  return key;
}

export function setLang(lang) {
  if (!LANGUAGES.includes(lang)) lang = DEFAULT_LANGUAGE;
  const previousLang = currentLang;
  currentLang = lang;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  safeSetItem(CONFIG.STORAGE_KEYS.LANG, lang);

  const select = document.getElementById("langSelect");
  if (select && select.value !== lang) select.value = lang;

  if (previousLang !== lang) {
    document.dispatchEvent(
      new CustomEvent("lang-changed", {
        detail: { lang, previousLang },
      })
    );
  }
}

export function getLang() {
  return currentLang;
}
export function getCurrency() {
  return CURRENCY_SUFFIX[currentLang] || "MAD";
}

/* ============================================================ SÉCURITÉ - Échappement HTML (anti-XSS) ============================================================ */
export function escapeHTML(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, function (m) {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[m];
  });
}

/* ============================================================ LOCALSTORAGE SÉCURISÉ ============================================================ */
export function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn("localStorage indisponible:", e);
    return false;
  }
}

export function safeGetItem(key, fallback = null) {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : fallback;
  } catch (e) {
    console.warn("Erreur lecture localStorage:", e);
    return fallback;
  }
}

export function safeRemoveItem(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {}
}

/* ============================================================ PRODUITS - Accesseurs multilingues ============================================================ */
export function getProductName(p) {
  if (!p) return "Produit";
  const key = `name${ currentLang.charAt(0).toUpperCase() + currentLang.slice(1) }`;
  return p[key] || p.nameFr || p.nameEn || p.nameAr || "Produit";
}

export function getProductDesc(p) {
  if (!p) return "";
  const key = `desc${ currentLang.charAt(0).toUpperCase() + currentLang.slice(1) }`;
  return p[key] || p.descFr || p.descEn || p.descAr || "";
}

export function getProductFeatures(p) {
  if (!p) return [];
  const key = `features${ currentLang.charAt(0).toUpperCase() + currentLang.slice(1) }`;
  return p[key] ?? p.featuresFr ?? p.featuresEn ?? p.featuresAr ?? [];
}

export function getProductImageUrl(p) {
  const fallback = getFallbackImage(getProductName(p));
  if (!p) return fallback;

  /* Compatibilité avec les schémas historiques : img, image, imageUrl, images[] et gallery[]. Les URL Firebase complètes sont conservées. */
  let candidate = p.img || p.image || p.imageUrl || p.imageURL;
  if (!candidate && Array.isArray(p.images)) candidate = p.images.find(Boolean);
  if (!candidate && Array.isArray(p.gallery))
    candidate = p.gallery.find(Boolean);
  if (candidate && typeof candidate === "object") {
    candidate =
      candidate.url ||
      candidate.src ||
      candidate.downloadURL ||
      candidate.downloadUrl;
  }
  const img = String(candidate || "").trim();
  if (!img || img.startsWith("//")) return fallback;
  if (/^https?:\/\//i.test(img) || img.startsWith("data:image/")) return img;
  if (img.startsWith("/")) return img;
  return "/" + img;
}

/* ============================================================ IMAGE FALLBACK ============================================================ */
export function getFallbackImage(name) {
  const safe =
    String(name || "Produit")
      .substring(0, 30)
      .replace(/[<>&"'`\\]/g, "")
      .trim() || "Produit";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect fill="#f8f6f2" width="400" height="400"/><path fill="#a57b2e" d="M200 50 L240 150 L340 150 L260 210 L290 310 L200 250 L110 310 L140 210 L60 150 L160 150 Z"/><text x="200" y="360" text-anchor="middle" fill="#1a1a2e" font-family="sans-serif" font-size="14">${safe}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* ============================================================ HELPERS DE CALCUL ============================================================ */
export function safePercent(value, total, decimals = 0) {
  const v = Number(value) || 0;
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  const result = (v / t) * 100;
  return decimals > 0 ? Number(result.toFixed(decimals)) : Math.round(result);
}

export function getDiscountPercent(oldPrice, price) {
  const op = Number(oldPrice) || 0;
  const p = Number(price) || 0;
  if (op <= 0 || p >= op) return 0;
  return Math.round(((op - p) / op) * 100);
}

export function safeDivide(numerator, denominator, fallback = 0) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d === 0) return fallback;
  return n / d;
}

/* ============================================================ STORAGE HELPERS ============================================================ */
export function getStoragePathFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const decoded = decodeURIComponent(url);
    const match = decoded.match(/\/o\/([^?]+)/);
    return match && match[1] ? match[1] : null;
  } catch (e) {
    return null;
  }
}

export function isStorageUrl(url) {
  if (!url || typeof url !== "string") return false;
  return url.includes("firebasestorage.googleapis.com");
}

/* ============================================================ FORMATAGE ============================================================ */
export function formatPrice(price) {
  if (price === null || price === undefined) return "--";
  return `${price} ${getCurrency()}`;
}

export function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    const date = toDate(dateStr);
    if (!date) return "";
    const locale =
      currentLang === "ar" ? "ar-MA" : currentLang === "en" ? "en-GB" : "fr-FR";
    return date.toLocaleDateString(locale);
  } catch (e) {
    return "";
  }
}

export function formatDateTime(dateStr) {
  if (!dateStr) return "";
  try {
    const date = toDate(dateStr);
    if (!date) return "";
    const locale =
      currentLang === "ar" ? "ar-MA" : currentLang === "en" ? "en-GB" : "fr-FR";
    return (
      date.toLocaleDateString(locale) +
      " " +
      date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    );
  } catch (e) {
    return "";
  }
}

/* ============================================================ toDate() robuste ============================================================ */
export function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") {
    try {
      return value.toDate();
    } catch (e) {}
  }
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const ms = value >= 1e12 ? value : value * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    if (year < 2000 || year > 2100) {
      const alt = value >= 1e12 ? value * 1000 : value;
      const altD = new Date(alt);
      const altYear = altD.getFullYear();
      if (!isNaN(altD.getTime()) && altYear >= 2000 && altYear <= 2100)
        return altD;
    }
    return d;
  }
  if (typeof value === "object" && typeof value.seconds === "number") {
    const d = new Date(value.seconds * 1000);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const frMatch = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (frMatch) {
      const [, d, m, y] = frMatch;
      const year = y.length === 2 ? 2000 + parseInt(y) : parseInt(y);
      const date = new Date(year, parseInt(m) - 1, parseInt(d));
      return isNaN(date.getTime()) ? null : date;
    }
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/* ============================================================ COMMANDES - Statuts (Clients) ============================================================ */
export function getOrderStatusEmoji(status) {
  const normalized = normalizeOrderStatus(status);
  const emojis = {
    [ORDER_STATUS.PENDING]: "⏳",
    [ORDER_STATUS.CONFIRMED]: "✅",
    [ORDER_STATUS.SHIPPING]: "🚚",
    [ORDER_STATUS.DELIVERED]: "📦",
    [ORDER_STATUS.RETURNED]: "↩️",
    [ORDER_STATUS.CANCELLED]: "❌",
  };
  return emojis[normalized] || "❓";
}

export function getOrderStatusColor(status) {
  const normalized = normalizeOrderStatus(status);
  const colors = {
    [ORDER_STATUS.PENDING]: "#e67e22",
    [ORDER_STATUS.CONFIRMED]: "#3498db",
    [ORDER_STATUS.SHIPPING]: "#d35400",
    [ORDER_STATUS.DELIVERED]: "#2ecc71",
    [ORDER_STATUS.RETURNED]: "#9b59b6",
    [ORDER_STATUS.CANCELLED]: "#b03a2e",
  };
  return colors[normalized] || "#5c5c5c";
}

export function getOrderStatusLabel(status) {
  const normalized = normalizeOrderStatus(status);
  const labels = {
    [ORDER_STATUS.PENDING]: "orderStatusPending",
    [ORDER_STATUS.CONFIRMED]: "orderStatusConfirmed",
    [ORDER_STATUS.SHIPPING]: "orderStatusShipping",
    [ORDER_STATUS.DELIVERED]: "orderStatusDelivered",
    [ORDER_STATUS.RETURNED]: "orderStatusReturned",
    [ORDER_STATUS.CANCELLED]: "orderStatusCancelled",
  };
  const key = labels[normalized];
  if (!key) return t("orderStatusUnknown");
  return t(key);
}

export function getOrderTimelineSteps(status) {
  const normalized = normalizeOrderStatus(status);
  const steps = [
    { id: "pending", label: "timelinePending", emoji: "⏳" },
    { id: "confirmed", label: "timelineConfirmed", emoji: "✅" },
    { id: "shipping", label: "timelineShipping", emoji: "🚚" },
    { id: "delivered", label: "timelineDelivered", emoji: "📦" },
  ];
  if (normalized === ORDER_STATUS.RETURNED) {
    steps.push({ id: "returned", label: "timelineReturned", emoji: "↩️" });
  }
  const statusIndex = {
    [ORDER_STATUS.PENDING]: 0,
    [ORDER_STATUS.CONFIRMED]: 1,
    [ORDER_STATUS.SHIPPING]: 2,
    [ORDER_STATUS.DELIVERED]: 3,
    [ORDER_STATUS.RETURNED]: 4,
  };
  const currentIndex = statusIndex[normalized] ?? -1;
  return steps.map((step, idx) => ({
    ...step,
    done: idx <= currentIndex,
    current: idx === currentIndex,
    active: idx <= currentIndex,
  }));
}

export function isOrderCancellable(order) {
  if (!order) return false;
  const status = normalizeOrderStatus(order.status);
  if (status !== ORDER_STATUS.PENDING) return false;
  const cancellableUntilDate = toDate(order.cancellableUntil);
  if (cancellableUntilDate) return Date.now() < cancellableUntilDate.getTime();
  const createdDate = toDate(order.createdAt);
  if (!createdDate) return false;
  const hoursElapsed = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60);
  return hoursElapsed < CONFIG.ORDERS.CANCELLABLE_HOURS;
}

export function getTimeRemainingForCancellation(order) {
  if (!order) return null;
  const status = normalizeOrderStatus(order.status);
  if (status !== ORDER_STATUS.PENDING) return null;
  const cancellableUntilDate = toDate(order.cancellableUntil);
  if (cancellableUntilDate) {
    const remaining = cancellableUntilDate.getTime() - Date.now();
    return remaining > 0 ? remaining : null;
  }
  const createdDate = toDate(order.createdAt);
  if (!createdDate) return null;
  const cancellableUntil =
    createdDate.getTime() + CONFIG.ORDERS.CANCELLABLE_HOURS * 60 * 60 * 1000;
  const remaining = cancellableUntil - Date.now();
  return remaining > 0 ? remaining : null;
}

export function formatTimeRemaining(ms) {
  if (!ms || ms <= 0) return "";
  const totalMinutes = Math.floor(ms / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}

/* ============================================================ HELPERS RETOUR ============================================================ */
export function getReturnSummary(order) {
  if (!order || !order.items)
    return {
      totalOrdered: 0,
      totalReturned: 0,
      summary: "0/0",
      isFullReturn: false,
      hasPartialReturn: false,
      hasAnyReturn: false,
    };
  const returned = getReturnedQuantities(order);
  let totalOrdered = 0,
    totalReturned = 0;
  order.items.forEach((item) => {
    const pid = String(item.productId);
    totalOrdered += Number(item.quantity) || 0;
    totalReturned += returned[pid] || 0;
  });
  return {
    totalOrdered,
    totalReturned,
    summary: `${totalReturned}/${totalOrdered}`,
    isFullReturn: totalOrdered > 0 && totalReturned >= totalOrdered,
    hasPartialReturn: totalReturned > 0 && totalReturned < totalOrdered,
    hasAnyReturn: totalReturned > 0,
  };
}

export function getReturnBadgeText(order) {
  const summary = getReturnSummary(order);
  if (!summary.hasAnyReturn) return "";
  if (summary.isFullReturn)
    return `↩️ ${t("returnBadgeFull") || "Retour total"}`;
  return `↩️ ${t("returnBadgePartial") || "Retour"} ${summary.summary}`;
}

/* ============================================================ AVIS - Statuts ============================================================ */
export function getReviewStatusEmoji(status) {
  const emojis = {
    [REVIEW_STATUS.PENDING]: "🟡",
    [REVIEW_STATUS.APPROVED]: "🟢",
    [REVIEW_STATUS.REJECTED]: "🔴",
  };
  return emojis[status] || "⚪";
}

export function getReviewStatusLabel(status) {
  const labels = {
    [REVIEW_STATUS.PENDING]: "reviewStatusPending",
    [REVIEW_STATUS.APPROVED]: "reviewStatusApproved",
    [REVIEW_STATUS.REJECTED]: "reviewStatusRejected",
  };
  return t(labels[status] || "reviewStatusUnknown");
}

export function renderStars(rating) {
  const num = Math.round(Number(rating) || 0);
  const full = "★".repeat(Math.min(5, Math.max(0, num)));
  const empty = "☆".repeat(Math.max(0, 5 - num));
  return full + empty;
}

/* ============================================================ VENDEUR & MARKETPLACE - Statuts ============================================================ */
export function getVendorOrderStatusEmoji(status) {
  const emojis = {
    pending: "⏳",
    awaiting_dropoff: "🏷️",
    overdue: "⏰",
    dropoff_received: "📥",
    preparing: "📦",
    shipped: "🚚",
    delivered: "✅",
    returned: "↩️",
    cancelled: "❌",
  };
  return emojis[status] || "❓";
}

export function getVendorOrderStatusLabel(status) {
  const labels = {
    pending: "En attente",
    awaiting_dropoff: "À déposer",
    overdue: "En retard",
    dropoff_received: "Déposé",
    preparing: "Préparation",
    shipped: "Expédiée",
    delivered: "Livrée",
    returned: "Retournée",
    cancelled: "Annulée",
  };
  return t(labels[status]) || labels[status] || "Inconnu";
}

export function getFulfillmentStatusEmoji(status) {
  const emojis = {
    pending_admin_approval: "⏳",
    approved: "✅",
    label_sent: "🏷️",
    in_transit: "🚚",
    received_by_livo: "📥",
    active_stock: "📦",
    depleted: "🪫",
    rejected: "❌",
    cancelled: "🚫",
    overdue_not_shipped: "⏰",
  };
  return emojis[status] || "❓";
}

export function getFulfillmentStatusLabel(status) {
  const labels = {
    pending_admin_approval: "En attente validation",
    approved: "Approuvé",
    label_sent: "Étiquette envoyée",
    in_transit: "En transit",
    received_by_livo: "Reçu par Livo",
    active_stock: "En stock",
    depleted: "Épuisé",
    rejected: "Refusé",
    cancelled: "Annulé",
    overdue_not_shipped: "Non déposé",
  };
  return t(labels[status]) || labels[status] || "Inconnu";
}

export function getProductStatusEmoji(status) {
  const emojis = { pending: "🟡", approved: "🟢", rejected: "🔴" };
  return emojis[status] || "⚪";
}

export function getProductStatusLabel(status) {
  const labels = {
    pending: "En attente",
    approved: "Approuvé",
    rejected: "Refusé",
  };
  return t(labels[status]) || labels[status] || "Inconnu";
}

/* ============================================================ HELPERS LIVO - IDs ============================================================ Format des IDs Livo (OpenAPI 1.0.0) : - pr-xxxxxxxx : produit - or-xxxxxxxx : commande - pi-xxxxxxxx : ramassage (pickup) - it-xxxxxxxx : item (stock) - us-xxxxxxxx : utilisateur / livreur Les 8 caractères sont alphanumériques minuscules. ============================================================ */
export const LIVO_ID_PREFIXES = ["pr", "or", "pi", "it", "us"];

export function getLivoIdPrefix(id) {
  if (!id) return null;
  const m = String(id).match(/^([a-z]{2})-/i);
  return m ? m[1].toLowerCase() : null;
}

export function isValidLivoId(id, expectedPrefix = null) {
  if (!id) return false;
  const m = String(id).match(/^([a-z]{2})-[a-z0-9]{8}$/i);
  if (!m) return false;
  if (
    expectedPrefix &&
    m[1].toLowerCase() !== String(expectedPrefix).toLowerCase()
  )
    return false;
  return true;
}

export function cleanLivoId(id) {
  if (!id) return "";
  return String(id).trim().toLowerCase();
}

/* ============================================================ HELPERS LIVO - DATES ============================================================ Livo exige le format JJ/MM/AAAA pour desired_date (voir AddOrderRequest et AddPickupRequest dans l'OpenAPI). ============================================================ */
export function formatLivoDate(dateInput) {
  const d = toDate(dateInput);
  if (!d) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

export function parseLivoDate(str) {
  if (!str) return null;
  const m = String(str)
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) return null;
  if (date.getDate() !== day || date.getMonth() !== month - 1) return null;
  return date;
}

/* ============================================================ HELPERS LIVO - TÉLÉPHONE ============================================================ Livo n'accepte que les téléphones mobiles marocains (06/07). Format préféré : 0XXXXXXXXX (10 chiffres). Accepte aussi +212XXXXXXXXX, 212XXXXXXXXX, ou 9 chiffres 6/7. ============================================================ */
export function cleanMoroccanPhone(phone) {
  if (!phone) return "";
  let cleaned = String(phone).replace(/\D/g, "");
  if (cleaned.startsWith("212")) {
    cleaned = "0" + cleaned.substring(3);
  } else if (cleaned.length === 9 && /^[67]/.test(cleaned)) {
    cleaned = "0" + cleaned;
  }
  return cleaned;
}

export function normalizeMoroccanPhone(phone) {
  const cleaned = cleanMoroccanPhone(phone);
  if (/^0[67]\d{8}$/.test(cleaned)) {
    return "+212" + cleaned.substring(1);
  }
  return cleaned;
}

export function isValidMoroccanPhone(phone) {
  const cleaned = cleanMoroccanPhone(phone);
  return /^0[67]\d{8}$/.test(cleaned);
}

/* ============================================================ RETRY RÉSEAU ============================================================ */
export async function fetchWithRetry( url, options = {}, retries = 3, delay = 1000 ) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      const isNonRetryable = response.status >= 400 && response.status < 500;
      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      err.nonRetryable = isNonRetryable;
      throw err;
    } catch (error) {
      attempt++;
      if (attempt === retries || error.nonRetryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

export async function firestoreWithRetry(fn, retries = 3, delay = 1000) {
  const NON_RETRYABLE_CODES = [
    "permission-denied",
    "unauthenticated",
    "invalid-argument",
    "not-found",
    "already-exists",
    "failed-precondition",
  ];
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      const isNonRetryable = NON_RETRYABLE_CODES.includes(error?.code);
      if (attempt === retries || isNonRetryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

/* ============================================================ DEVICE ============================================================ */
export function isMobile() {
  return window.innerWidth <= CONFIG.BREAKPOINTS.MOBILE_MAX;
}
export function isTablet() {
  return (
    window.innerWidth >= CONFIG.BREAKPOINTS.TABLET_MIN &&
    window.innerWidth <= CONFIG.BREAKPOINTS.TABLET_MAX
  );
}
export function isDesktop() {
  return window.innerWidth >= CONFIG.BREAKPOINTS.DESKTOP_MIN;
}
export function getDevice() {
  if (isMobile()) return "mobile";
  if (isTablet()) return "tablet";
  return "desktop";
}

/* ============================================================ DEBOUNCE / THROTTLE ============================================================ */
export function debounce(fn, delay = 300) {
  let timer = null;
  const debounced = function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, delay);
  };
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}

export function throttle(fn, limit = 200) {
  let inThrottle = false,
    timer = null;
  const throttled = function (...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      timer = setTimeout(() => {
        inThrottle = false;
        timer = null;
      }, limit);
    }
  };
  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    inThrottle = false;
  };
  return throttled;
}

/* ============================================================ PARSING & VALIDATION ============================================================ */
export function toInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}
export function toFloat(value, fallback = 0) {
  const n = parseFloat(value);
  return isNaN(n) ? fallback : n;
}
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}
export function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
export function isValidPhone(phone) {
  if (!phone || typeof phone !== "string") return false;
  const cleaned = phone.replace(/[\s\-\.\(\)]/g, "");
  return /^(\+212|0)[5-7]\d{8}$/.test(cleaned);
}
export function isValidPassword(password) {
  return password && password.length >= 6;
}

/* ============================================================ INIT LANGUE ============================================================ */
export function initLang() {
  const saved = safeGetItem(CONFIG.STORAGE_KEYS.LANG);
  const urlParams = new URLSearchParams(window.location.search);
  const urlLang = urlParams.get("lang");
  const browserLang = (navigator.language || "").split("-")[0].toLowerCase();

  let lang = DEFAULT_LANGUAGE;
  if (urlLang && LANGUAGES.includes(urlLang)) lang = urlLang;
  else if (saved && LANGUAGES.includes(saved)) lang = saved;
  else if (browserLang && LANGUAGES.includes(browserLang)) lang = browserLang;

  setLang(lang);
  return lang;
}

/* ============================================================ LOAD CITIES ============================================================ */
export async function loadCities(force = false) {
  const CACHE_KEY = CONFIG.STORAGE_KEYS.CITIES_CACHE;
  const CACHE_VERSION = CONFIG.VERSION?.CITIES_SCHEMA ?? 3;
  const { setDeliveryData } = await import("./store.js");

  if (!force) {
    const cached = safeGetItem(CACHE_KEY);
    if (
      cached &&
      cached.version === CACHE_VERSION &&
      cached.timestamp &&
      Date.now() - cached.timestamp < 86400000
    ) {
      setDeliveryData(cached.data);
      return cached.data;
    }
  }

  try {
    const { collection, getDocs } = await import("firebase/firestore");
    const { db } = await import("./firebase.js");
    const snap = await getDocs(collection(db, "cities"));
    if (!snap.empty) {
      const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      data.sort((a, b) => Number(a.id) - Number(b.id));
      setDeliveryData(data);
      safeSetItem(CACHE_KEY, {
        data,
        timestamp: Date.now(),
        version: CACHE_VERSION,
      });
      return data;
    }
  } catch (e) {
    console.error("Erreur Firestore cities :", e);
  }

  try {
    const res = await fetchWithRetry("/villes.json");
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("villes.json mal formaté");
    setDeliveryData(data);
    safeSetItem(CACHE_KEY, {
      data,
      timestamp: Date.now(),
      version: CACHE_VERSION,
    });
    return data;
  } catch (e) {
    setDeliveryData([]);
    return [];
  }
}

/* ============================================================ SLUGIFY ============================================================ */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/* ============================================================ HELPERS VILLES ============================================================ getCityName() : retourne le nom localisé d'une ville. - AR : nameAr, puis name, puis key. - FR : nameFr, puis override manuel sur key, puis smartTitleCase(key), puis '' (NE RETOURNE JAMAIS le nom arabe pour un lecteur FR). - EN : nameEn, puis smartTitleCase(key), puis ''. Correction P2-16 : avant, en FR, si nameFr et key étaient vides, on tombait sur city.name (arabe) - ce qui produisait un affichage incohérent pour un utilisateur francophone. On retourne '' désormais. ============================================================ */
const CITY_LOWERCASE_WORDS = new Set([
  "de",
  "du",
  "des",
  "la",
  "le",
  "les",
  "et",
  "sur",
  "el",
  "ben",
  "bni",
  "oulad",
  "sidi",
  "ain",
  "bir",
  "dar",
  "souk",
  "kasba",
  "jorf",
  "bou",
  "aïn",
]);

function smartTitleCase(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .split(/\s+/)
    .map((word, idx) => {
      if (!word) return "";
      if (idx > 0 && CITY_LOWERCASE_WORDS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

const CITY_FR_OVERRIDES = {
  fes: "Fès",
  meknes: "Meknès",
  tetouan: "Tétouan",
  sale: "Salé",
  laayoune: "Laâyoune",
  "ain harouda": "Aïn Harouda",
  "beni mellal": "Béni Mellal",
  khenifra: "Khénifra",
  "sidi kacem": "Sidi Kacem",
  "sidi slimane": "Sidi Slimane",
  "souk el arbaa": "Souk El Arbaa",
  "el ksiba": "El Ksiba",
  "el hajeb": "El Hajeb",
  "al hoceima": "Al Hoceïma",
  errachidia: "Errachidia",
  ouarzazate: "Ouarzazate",
  tinghir: "Tinghir",
  zagora: "Zagora",
  guelmim: "Guelmim",
  "tan-tan": "Tan-Tan",
  "el kelaa des sraghna": "El Kelâa des Sraghna",
  "kasba tadla": "Kasba Tadla",
  "fquih ben salah": "Fquih Ben Salah",
  "oulad frej": "Oulad Frej",
  "souk sebt oulad nemma": "Souk Sebt Oulad Nemma",
  "jorf el melha": "Jorf El Melha",
  "ksar el kebir": "Ksar El Kébir",
  "el jorf": "El Jorf",
  mdiq: "M'diq",
  fnideq: "Fnideq",
  chefchaouen: "Chefchaouen",
  ouazzane: "Ouezzane",
  lahraouiyine: "Lahraouiyine",
  nouaceur: "Nouaceur",
  tikiouine: "Tikiouine",
  skhirat: "Skhirat",
  temara: "Témara",
  "sidi yahya gharb": "Sidi Yahya El Gharb",
  "mechra bel ksiri": "Mechra Bel Ksiri",
  "moulay bousselham": "Moulay Bousselham",
  "sidi bennour": "Sidi Bennour",
  "sebt el guerdane": "Sebt El Guerdane",
  aourir: "Aourir",
  tamanar: "Tamanar",
  tahanaout: "Tahannaout",
  tameslohte: "Tamesloht",
  "sidi bou othmane": "Sidi Bou Othmane",
  martil: "Martil",
  asilah: "Asilah",
  larache: "Larache",
  "sidi smail": "Sidi Smail",
  youssoufia: "Youssoufia",
  azilal: "Azilal",
  demnate: "Demnate",
  "oued zem": "Oued Zem",
  khouribga: "Khouribga",
  bejaad: "Bejaâd",
  settat: "Settat",
  berrechid: "Berrechid",
  benslimane: "Benslimane",
  bouznika: "Bouznika",
  "ben guerir": "Ben Guerir",
  "khemis zemamra": "Khemis Zemamra",
  echemmaia: "Echemmaia",
  "sidi bouzid": "Sidi Bouzid",
  "ain taoujdate": "Aïn Taoujdate",
  "oulad m barek": "Oulad M'Barek",
  "zaouiat cheikh": "Zaouiat Cheikh",
  "ait oumghar": "Aït Oumghar",
  ifrane: "Ifrane",
  azrou: "Azrou",
  mrirt: "Mrirt",
  midelt: "Midelt",
  berkane: "Berkane",
  driouch: "Driouch",
  midar: "Midar",
  taourirt: "Taourirt",
  jerada: "Jerada",
  figuig: "Figuig",
  bouarfa: "Bouarfa",
  guercif: "Guercif",
  taza: "Taza",
  imzouren: "Imzouren",
  "bni bouayach": "Bni Bouayach",
  ajdir: "Ajdir",
  targuist: "Targuist",
  aknoul: "Aknoul",
  taounate: "Taounate",
  ghafsai: "Ghafsai",
  tahla: "Tahla",
  tissa: "Tissa",
  erfoud: "Erfoud",
  rissani: "Rissani",
  agdz: "Agdz",
  taznakht: "Taznakht",
  "kelaa mgouna": "Kelâa M'Gouna",
  "boumalne dades": "Boumalne Dadès",
  skoura: "Skoura",
  tata: "Tata",
  tissint: "Tissint",
  "foum zguid": "Foum Zguid",
  akka: "Akka",
  boujdour: "Boujdour",
  dakhla: "Dakhla",
  smara: "Smara",
  tarfaya: "Tarfaya",
  "sidi ifni": "Sidi Ifni",
  "bab berred": "Bab Berred",
  "bab taza": "Bab Taza",
  dalia: "Dalia",
  benhmed: "Ben Ahmed",
  tassoultant: "Tassoultante",
  lahbichat: "Lahbichat",
  "douar lhna": "Douar Lhna",
  tamsonsurt: "Tamsonsurt",
  loudaya: "Loudaya",
  sminou: "Sminou",
  ounagha: "Ounagha",
  attaouia: "Attaouia",
  chouiter: "Chouiter",
  rich: "Rich",
  boumia: "Boumia",
  zaida: "Zaida",
  tounfiet: "Tounfiet",
  missour: "Missour",
  "outat lhaj": "Outat El Haj",
  tinejdad: "Tinejdad",
  bodnib: "Boudnib",
  bouarg: "Bouarg",
  laaroui: "Laâroui",
  arkmane: "Arkmane",
  "bni drar": "Bni Drar",
  "bni wkil": "Bni Oukil",
  "laayoune cergia": "Laâyoune Cergia",
  ahfir: "Ahfir",
  aklim: "Aklim",
  selouane: "Selouane",
  zaio: "Zaïo",
  "sidi slimane charae": "Sidi Slimane Charaâ",
  boudinar: "Boudinar",
  "dar el kebdani": "Dar El Kebdani",
  "al aaroui": "Al Aroui",
  "bni ansar": "Bni Ansar",
  zeghanghane: "Zeghanghane",
  "hassi berkane": "Hassi Berkane",
  jaadar: "Jaadar",
  "beni ensar": "Beni Ensar",
  tiztoutine: "Tiztoutine",
  "ain zohra": "Aïn Zohra",
  temsamane: "Temsamane",
  azghenghan: "Azghanghan",
  kassita: "Kassita",
  tafoughalt: "Tafoughalt",
  "ain erroua": "Aïn Erroua",
  "hassi oulad": "Hassi Oulad",
  "sidi bouafif": "Sidi Bouafif",
  farkhana: "Farkhana",
  "bni chiker": "Bni Chiker",
  tawima: "Taouima",
  "ait bouayach": "Aït Bouayach",
  rouadi: "Rouadi",
  trougout: "Trougout",
  mhajer: "Mhajer",
  "sidi bouhria": "Sidi Bouhria",
  "ben taieb": "Ben Taïeb",
  tizroutine: "Tizroutine",
  "dar kebdani": "Dar El Kebdani",
  afra: "Afra",
  ihddaden: "Ihddaden",
  "ait yassine": "Aït Yassine",
  tamdit: "Tamdit",
  "ouled settout": "Ouled Settout",
  mrija: "Mrija",
  "ain sfa": "Aïn Sfa",
  "ain bni mathar": "Aïn Bni Mathar",
  talsint: "Talsint",
  "figuig ville": "Figuig",
  "bni tajjit": "Bni Tajjit",
  bouanane: "Bouanane",
  tendrara: "Tendrara",
  "ain chair": "Aïn Chaïr",
  "oum laachar": "Oum Laâchar",
  "bni guil": "Bni Guil",
  "ouled bouarfa": "Ouled Bouarfa",
  "ain chouater": "Aïn Chouater",
  bousaada: "Bousaâda",
  "el arjoune": "El Arjoune",
  "sidi rached": "Sidi Rached",
  "bni khaled": "Bni Khaled",
  kerouna: "Kerouna",
  "tizi ouzli": "Tizi Ouzli",
  "ain leuh": "Aïn Leuh",
  "el menzel": "El Menzel",
  "sidi youssef ben ahmed": "Sidi Youssef Ben Ahmed",
  jbabra: "Jbabra",
  "sidi hadjeb": "Sidi El Hajeb",
  "bni ahmed": "Bni Ahmed",
  matmata: "Matmata",
  msila: "Msila",
  boulemane: "Boulemane",
  guigou: "Guigou",
  "errahma ville": "Errahma",
  "tit mellil": "Tit Mellil",
  "had soualem": "Had Soualem",
  "dar bouazza": "Dar Bouazza",
  "sidi rahhal": "Sidi Rahhal",
};

export function getCityName(city) {
  if (!city) return "";
  const lang = getLang();
  if (lang === "ar") return city.nameAr || city.name || city.key || "";
  if (lang === "fr") {
    if (city.nameFr) return city.nameFr;
    const key = String(city.key || "")
      .toLowerCase()
      .trim();
    if (CITY_FR_OVERRIDES[key]) return CITY_FR_OVERRIDES[key];
    if (key) return smartTitleCase(key);
    return "";
  }
  if (lang === "en") {
    if (city.nameEn) return city.nameEn;
    const key = String(city.key || "")
      .toLowerCase()
      .trim();
    if (key) return smartTitleCase(key);
    return "";
  }
  return city.name || "";
}

export function getCityNameAll(city) {
  if (!city) return [];
  return [
    city.nameFr,
    city.nameEn,
    city.nameAr || city.name,
    city.key,
    smartTitleCase(city.key || ""),
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
}

/* ============================================================ HELPERS BLOG ============================================================ */
export function estimateReadTime(text) {
  if (!text) return 1;
  const wordCount = String(text).trim().split(/\s+/).length;
  return Math.max(1, Math.ceil(wordCount / 200));
}

export function truncate(text, maxLength = 150) {
  if (!text) return "";
  const str = String(text).trim();
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength).trim() + "…";
}

/* ============================================================ HELPERS SIGNUP Le mode 'vendor' (inscription vendeur via formulaire dédié) possède sa clé 'signupMethodVendor' dans translations.js. Fallback human-readable pour éviter d'afficher la clé brute si la traduction manque. ============================================================ */
export function getSignupMethodLabel(method) {
  const labels = {
    otp: "signupMethodOtp",
    google: "signupMethodGoogle",
    facebook: "signupMethodFacebook",
    vendor: "signupMethodVendor",
  };
  const key = labels[method];
  if (!key) return t("signupMethodOtp");
  const translated = t(key);
  if (translated === key) {
    const fallbacks = {
      otp: "OTP",
      google: "Google",
      facebook: "Facebook",
      vendor: "Vendeur",
    };
    return fallbacks[method] || "OTP";
  }
  return translated;
}

export function getSignupMethodEmoji(method) {
  const emojis = {
    otp: "🔐",
    google: "🔵",
    facebook: "📘",
    vendor: "🏪",
  };
  return emojis[method] || "🔐";
}

/* ============================================================ DÉTECTION PAGE & FORMAT EMAIL/PHONE ============================================================ */
export function getCurrentPage() {
  let path = window.location.pathname.replace(/\.html$/, "").replace(/\/$/, "");
  if (path === "") path = "/";
  if (path === "/") return "home";
  if (path === "/produit") return "product";
  if (path === "/blog") return "blog";
  if (path === "/villes" || path === "/villesmaroc") return "villes";
  if (path === "/admin") return "admin";
  if (path === "/panier") return "cart";
  return "unknown";
}

export function cleanEmail(email) {
  if (!email) return "";
  return String(email).trim().toLowerCase();
}

export function cleanPhone(phone) {
  if (!phone) return "";
  return String(phone).replace(/[^\d+]/g, "");
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ utils.js chargé - v9.0.0 (Lot 2 : helpers Livo + corrections mineures)"
);