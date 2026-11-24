/* ============================================================
   functions/retargeting-core.js — RECIBLAGE (PUR, TESTABLE)
   ------------------------------------------------------------
   Aucune dépendance Firebase : toutes les règles de décision
   sont ici et vérifiées par tests/retargeting.test.mjs.
   Le moteur est PASSIF : il lit product_views, il ne touche
   jamais au tri, aux recommandations ni au panier.
   ============================================================ */

const DAY_MS = 24 * 3600 * 1000;
const VIEW_TTL_DAYS = 30;
const FATIGUE_WINDOW_DAYS = 7;
const FATIGUE_MAX_EMAILS = 3;
const MIN_DROP_MAD = 30;
const MIN_DROP_RATIO = 0.1;
const LOW_STOCK_THRESHOLD = 3;
const PEAK_START_MINUTES = 10 * 60 + 30; /* 10h30 */
const PEAK_END_MINUTES = 22 * 60 + 30; /* 22h30 */
const SLOT_NOON_MINUTES = 11 * 60 + 30; /* 11h30 */
const SLOT_EVENING_MINUTES = 20 * 60; /* 20h00 */

/** Heure / minute / jour à l'heure du Maroc (offset explicite UTC+1). */
function moroccoParts(ms) {
  const shifted = new Date(Number(ms) + 3600 * 1000);
  return {
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    dayKey: shifted.toISOString().slice(0, 10),
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  };
}

/** Vrai entre 10h30 et 22h30 heure de Casablanca (fenêtre d'envoi). */
function isPeakWindow(ms) {
  const { minutesOfDay } = moroccoParts(ms);
  return minutesOfDay >= PEAK_START_MINUTES && minutesOfDay < PEAK_END_MINUTES;
}

/**
 * Prochain créneau d'envoi (11h30 ou 20h00 Casablanca).
 * @returns {number} timestamp ms
 */
function nextPeakSlot(ms) {
  const { minutesOfDay } = moroccoParts(ms);
  const dayStart = Math.floor(Number(ms) / DAY_MS) * DAY_MS;
  if (minutesOfDay < SLOT_NOON_MINUTES) return dayStart + (SLOT_NOON_MINUTES - 60) * 60000;
  if (minutesOfDay < SLOT_EVENING_MINUTES) return dayStart + (SLOT_EVENING_MINUTES - 60) * 60000;
  return dayStart + DAY_MS + (SLOT_NOON_MINUTES - 60) * 60000;
}

/** Règle 2 : une visite de plus de 30 jours est ignorée. */
function isFresh(lastViewedAtMs, nowMs) {
  const ts = Number(lastViewedAtMs);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return Number(nowMs) - ts <= VIEW_TTL_DAYS * DAY_MS;
}

/** Règle 1 : visite préalable avec un prix vu supérieur au nouveau prix. */
function isEligibleView({ seenPrice, newPrice, promoEmailSent, purchased } = {}) {
  const seen = Number(seenPrice);
  const next = Number(newPrice);
  if (!Number.isFinite(seen) || !Number.isFinite(next) || next <= 0) return false;
  if (promoEmailSent === true) return false;
  if (purchased === true) return false;
  return seen > next;
}

/** Règle 4 : baisse significative (>= 10 % ou >= 30 MAD). */
function isSignificantDrop(seenPrice, newPrice) {
  const seen = Number(seenPrice);
  const next = Number(newPrice);
  if (!Number.isFinite(seen) || !Number.isFinite(next) || seen <= 0) return false;
  const diff = seen - next;
  if (diff <= 0) return false;
  return diff >= MIN_DROP_MAD || diff / seen >= MIN_DROP_RATIO;
}

/** Règle 3 : intérêt réel (2 visites, 20 s, ou panier abandonné). */
function isEngaged(view = {}) {
  if (view.inAbandonedCart === true) return true;
  if (view.engaged === true) return true;
  return Number(view.viewCount) >= 2;
}

/** Règle 8 : plafond 3 emails promotionnels / 7 jours glissants. */
function withinFatigueCap(timestamps, nowMs) {
  const list = Array.isArray(timestamps) ? timestamps : [];
  const since = Number(nowMs) - FATIGUE_WINDOW_DAYS * DAY_MS;
  const recent = list
    .map((value) => Number(value && value.toMillis ? value.toMillis() : value))
    .filter((value) => Number.isFinite(value) && value >= since && value <= Number(nowMs));
  return recent.length < FATIGUE_MAX_EMAILS;
}

/** Règle 5 : les paniers abandonnés passent devant. */
function priorityOf(view = {}) {
  return view.inAbandonedCart === true ? 0 : 1;
}

/**
 * Filtre les vues éligibles pour UNE baisse de prix.
 * Applique les règles 1 à 4 et trie les paniers abandonnés en premier.
 * @returns {{eligible: Array, rejected: Object}}
 */
function rankCandidates(views, { newPrice, nowMs } = {}) {
  const eligible = [];
  const rejected = { stale: 0, notSeen: 0, alreadySent: 0, purchased: 0, notEngaged: 0, smallDrop: 0 };

  for (const view of Array.isArray(views) ? views : []) {
    if (!view) continue;
    if (!isFresh(view.lastViewedAtMs, nowMs)) {
      rejected.stale += 1;
      continue;
    }
    if (view.purchased === true) {
      rejected.purchased += 1;
      continue;
    }
    if (view.promoEmailSent === true) {
      rejected.alreadySent += 1;
      continue;
    }
    if (!isEligibleView({ seenPrice: view.seenPrice, newPrice, purchased: view.purchased })) {
      rejected.notSeen += 1;
      continue;
    }
    if (!isSignificantDrop(view.seenPrice, newPrice)) {
      rejected.smallDrop += 1;
      continue;
    }
    if (!isEngaged(view)) {
      rejected.notEngaged += 1;
      continue;
    }
    eligible.push(view);
  }

  eligible.sort((a, b) => priorityOf(a) - priorityOf(b) || Number(b.seenPrice) - Number(a.seenPrice));
  return { eligible, rejected };
}

/**
 * Règles 5, 7, 8, 9 : choix du canal pour UN client.
 * @returns {{channel: 'push'|'email'|'schedule'|'skip', reason: string}}
 */
function chooseChannel({ view = {}, hasPush = false, quotaRemaining = 0, nowMs } = {}) {
  const abandoned = view.inAbandonedCart === true;
  if (!withinFatigueCap(view.promoEmailTimestamps, nowMs)) {
    return { channel: 'push', reason: 'fatigue_cap' };
  }
  /* Règle 7 : Push gratuit d'abord, sauf panier abandonné. */
  if (hasPush && !abandoned) {
    return { channel: 'push', reason: 'push_available' };
  }
  /* Plafond mensuel atteint : 100 % push. */
  if (Number(quotaRemaining) <= 0) {
    return { channel: 'push', reason: 'quota_reached' };
  }
  /* Règle 9 : la nuit, on programme au prochain créneau de pic. */
  if (!isPeakWindow(nowMs)) {
    return { channel: 'schedule', reason: 'off_peak' };
  }
  return { channel: 'email', reason: abandoned ? 'abandoned_cart' : 'no_push' };
}

/**
 * Règle 6 : un seul email récapitulatif par client et par jour.
 * @param {Array<{productId,title,image,seenPrice,newPrice}>} items
 */
function buildDigest(items, nowMs) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length) return null;
  const { dayKey } = moroccoParts(nowMs);
  const lines = list.map((item) => ({
    productId: String(item.productId || ''),
    title: String(item.title || 'Produit').slice(0, 90),
    image: String(item.image || ''),
    seenPrice: Number(item.seenPrice) || 0,
    newPrice: Number(item.newPrice) || 0,
    drop: Math.max(0, (Number(item.seenPrice) || 0) - (Number(item.newPrice) || 0))
  }));
  const totalDrop = lines.reduce((sum, line) => sum + line.drop, 0);
  return {
    dayKey,
    count: lines.length,
    lines,
    totalDrop: Math.round(totalDrop * 100) / 100,
    title:
      lines.length === 1
        ? 'Bonne nouvelle : le produit que vous avez consulté est en promotion'
        : `Bonne nouvelle ! ${lines.length} articles que vous avez consultés sont en promotion`
  };
}

/** Règle 10 : alerte stock faible sur un produit visité. */
function shouldAlertLowStock({ stock, view = {}, nowMs, purchased } = {}) {
  const qty = Number(stock);
  if (!Number.isFinite(qty) || qty <= 0 || qty > LOW_STOCK_THRESHOLD) return false;
  if (purchased === true || view.purchased === true) return false;
  if (view.lowStockAlertSent === true) return false;
  if (!isFresh(view.lastViewedAtMs, nowMs)) return false;
  return isEngaged(view);
}

module.exports = {
  DAY_MS,
  VIEW_TTL_DAYS,
  FATIGUE_WINDOW_DAYS,
  FATIGUE_MAX_EMAILS,
  MIN_DROP_MAD,
  MIN_DROP_RATIO,
  LOW_STOCK_THRESHOLD,
  PEAK_START_MINUTES,
  PEAK_END_MINUTES,
  moroccoParts,
  isPeakWindow,
  nextPeakSlot,
  isFresh,
  isEligibleView,
  isSignificantDrop,
  isEngaged,
  withinFatigueCap,
  priorityOf,
  rankCandidates,
  chooseChannel,
  buildDigest,
  shouldAlertLowStock
};

