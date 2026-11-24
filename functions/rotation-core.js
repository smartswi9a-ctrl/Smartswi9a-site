/* ============================================================
   functions/rotation-core.js — ALGORITHME 10:1 (PUR, TESTABLE)
   ------------------------------------------------------------
   Produits Smartswika : diffusion immédiate, sans restriction.
   Produits vendeurs tiers (commission 7 %) :
     • prix > 500 MAD → diffusion immédiate, premiumCount +1
     • prix ≤ 500 MAD → file d'attente (lowPriceQueue)
     • premiumCount = 10 → le produit ≤ 500 MAD suivant est
       diffusé, puis premiumCount repart à 0.
   Aucune dépendance Firebase : importable par les tests.
   ============================================================ */

const PREMIUM_THRESHOLD = 500;
const CYCLE_SIZE = 10;
const MAX_QUEUE = 200;

/* Propriétaires « Smartswika » : diffusion sans restriction de prix. */
const SMART_OWNERS = new Set(['', 'smartswika', 'smartswi9a', 'smart-swika', 'smart swika']);

function isSmartOwner(vendorId) {
  return SMART_OWNERS.has(String(vendorId || '').trim().toLowerCase());
}

function clampCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(CYCLE_SIZE, Math.max(0, Math.floor(n)));
}

/**
 * Cœur de l'algorithme (fonction pure).
 * @param {{premiumCount?: number, lowPriceQueue?: Array}} state
 * @param {number} price prix en MAD
 * @param {string} productId
 * @returns {{broadcast: boolean, premiumCount: number, lowPriceQueue: Array,
 *            flushLow: object|null, reason: string}}
 */
function decideRotation(state = {}, price, productId = '') {
  const premiumCount = clampCount(state.premiumCount);
  const lowPriceQueue = Array.isArray(state.lowPriceQueue) ? state.lowPriceQueue.slice(0, MAX_QUEUE) : [];
  const p = Number(price);

  if (!Number.isFinite(p) || p <= 0) {
    return { broadcast: false, premiumCount, lowPriceQueue, flushLow: null, reason: 'invalid_price' };
  }

  if (p > PREMIUM_THRESHOLD) {
    if (premiumCount < CYCLE_SIZE) {
      return {
        broadcast: true,
        premiumCount: premiumCount + 1,
        lowPriceQueue,
        flushLow: null,
        reason: 'premium_slot'
      };
    }
    /* Cycle complet : on libère d'abord le slot « petit prix ». */
    const flushLow = lowPriceQueue.length ? lowPriceQueue.shift() : null;
    return {
      broadcast: true,
      premiumCount: 1,
      lowPriceQueue,
      flushLow,
      reason: 'cycle_reset_by_premium'
    };
  }

  if (premiumCount === CYCLE_SIZE) {
    return {
      broadcast: true,
      premiumCount: 0,
      lowPriceQueue,
      flushLow: null,
      reason: 'low_price_slot'
    };
  }

  if (!productId) {
    return { broadcast: false, premiumCount, lowPriceQueue, flushLow: null, reason: 'queued_no_id' };
  }

  const already = lowPriceQueue.some((item) => item && item.productId === productId);
  if (!already) {
    lowPriceQueue.push({ productId, price: p, addedAt: Date.now() });
  }
  return {
    broadcast: false,
    premiumCount,
    lowPriceQueue: lowPriceQueue.slice(-MAX_QUEUE),
    flushLow: null,
    reason: already ? 'already_queued' : 'queued'
  };
}

module.exports = {
  PREMIUM_THRESHOLD,
  CYCLE_SIZE,
  MAX_QUEUE,
  SMART_OWNERS,
  isSmartOwner,
  clampCount,
  decideRotation
};
