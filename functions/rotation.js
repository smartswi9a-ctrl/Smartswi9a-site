/* ============================================================
   functions/rotation.js — DIFFUSION CLIENTS & RENTABILITÉ
   ------------------------------------------------------------
   Produits Smartswika (100 %) : diffusion immédiate.
   Produits vendeurs tiers (commission 7 %) : boucle 10 pour 1.
     • prix > 500 MAD  → diffusion immédiate, premiumCount +1
     • prix ≤ 500 MAD  → file d'attente (lowPriceQueue)
     • premiumCount = 10 → le prochain produit ≤ 500 MAD est
       diffusé, puis premiumCount repart à 0.
   État persistant : config/notifications_rotation
   ============================================================ */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { mad, notifyRole, claimOnce } = require('./notifications');

const db = getFirestore();

const STATE_PATH = 'config/notifications_rotation';
const {
  PREMIUM_THRESHOLD,
  CYCLE_SIZE,
  MAX_QUEUE,
  isSmartOwner,
  clampCount,
  decideRotation
} = require('./rotation-core');

/** Charge l'état courant (lecture seule, tolérante). */
async function readState() {
  try {
    const snap = await db.doc(STATE_PATH).get();
    const data = snap.exists ? snap.data() || {} : {};
    return {
      premiumCount: clampCount(data.premiumCount),
      lowPriceQueue: Array.isArray(data.lowPriceQueue) ? data.lowPriceQueue : [],
      cycles: Number(data.cycles || 0)
    };
  } catch (error) {
    return { premiumCount: 0, lowPriceQueue: [], cycles: 0 };
  }
}

function clientPayload(product, productId, extraTitle) {
  const price = Number(product.price);
  return {
    type: 'client_new_product',
    title: extraTitle || 'Nouveau produit Smartswika',
    body: `${String(product.nameFr || product.name || product.title || 'Produit').slice(0, 70)} — ${mad(price)}`,
    targetUrl: `/produit.html?slug=${encodeURIComponent(product.slug || productId)}`,
    tag: `rotation-${productId}`
  };
}

/* Plafond d'écritures in-app par diffusion (maîtrise du coût Firestore). */
const IN_APP_FANOUT = 50;

/** Push vers tous les tokens clients + in-app pour les 50 derniers comptes. */
async function broadcastToClients(payload) {
  const push = await notifyRole('client', payload);
  try {
    const { createInApp } = require('./notifications');
    const snap = await db.collection('users').where('role', 'in', ['user', 'client']).limit(IN_APP_FANOUT).get();
    await Promise.all(
      snap.docs.map((docSnap) =>
        createInApp({ ...payload, recipientId: docSnap.id, recipientRole: 'client' })
      )
    );
  } catch (error) {
    console.warn('[rotation] in-app fanout :', error.message);
  }
  return push;
}

/** Diffuse un produit resté dans la file (le plus ancien). */
async function broadcastQueuedLow(item) {
  if (!item || !item.productId) return { sent: false, reason: 'empty_queue' };
  try {
    const snap = await db.collection('products').doc(String(item.productId)).get();
    if (!snap.exists) return { sent: false, reason: 'missing' };
    const product = snap.data() || {};
    if (product.status !== 'approved') return { sent: false, reason: 'not_approved' };
    if (!(await claimOnce(`rotation-low-${item.productId}`, 48))) {
      return { sent: false, reason: 'already_sent' };
    }
    await broadcastToClients(clientPayload(product, item.productId, 'Bon plan vendeur'));
    return { sent: true, productId: item.productId };
  } catch (error) {
    console.warn('[rotation] flush low :', error.message);
    return { sent: false, reason: 'error' };
  }
}

/**
 * Applique l'algorithme pour un produit vendeur ou Smartswika.
 * @returns {Promise<object>} décision + effet
 */
async function applyRotation({ productId, product = {}, vendorId = '' }) {
  const price = Number(product.price);
  const smart = isSmartOwner(vendorId);

  if (smart) {
    if (!(await claimOnce(`rotation-smart-${productId}`, 24))) {
      return { broadcast: false, reason: 'already_sent', premiumCount: null };
    }
    await broadcastToClients(clientPayload(product, productId, 'Nouveauté Smartswika'));
    return { broadcast: true, reason: 'smart_owner', premiumCount: null };
  }

  const ref = db.doc(STATE_PATH);
  let decision = null;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() || {} : {};
      decision = decideRotation(
        { premiumCount: data.premiumCount, lowPriceQueue: data.lowPriceQueue },
        price,
        productId
      );
      const cycleDone = decision.reason === 'low_price_slot';
      tx.set(
        ref,
        {
          premiumCount: decision.premiumCount,
          lowPriceQueue: decision.lowPriceQueue,
          cycles: Number(data.cycles || 0) + (cycleDone ? 1 : 0),
          thresholdMad: PREMIUM_THRESHOLD,
          cycleSize: CYCLE_SIZE,
          updatedAt: FieldValue.serverTimestamp(),
          ...(cycleDone
            ? { lastLowBroadcast: productId, lastLowAt: FieldValue.serverTimestamp() }
            : {})
        },
        { merge: true }
      );
    });
  } catch (error) {
    console.warn('[rotation] transaction :', error.message);
    return { broadcast: false, reason: 'tx_error' };
  }

  if (decision.broadcast) {
    const title = Number(price) > PREMIUM_THRESHOLD ? 'Sélection vendeur' : 'Bon plan vendeur';
    await broadcastToClients(clientPayload(product, productId, title));
  }
  let flushed = null;
  if (decision.flushLow) flushed = await broadcastQueuedLow(decision.flushLow);

  return { ...decision, flushed };
}

/** Diffusion forcée par l'admin (hors cycle). */
async function forceBroadcast(productId) {
  if (!productId) return { sent: false, reason: 'no_product' };
  try {
    const snap = await db.collection('products').doc(String(productId)).get();
    if (!snap.exists) return { sent: false, reason: 'missing' };
    const product = snap.data() || {};
    await broadcastToClients(clientPayload(product, productId, 'À ne pas manquer'));
    try {
      const ref = db.doc(STATE_PATH);
      const queue = (await ref.get()).data()?.lowPriceQueue || [];
      await ref.set(
        { lowPriceQueue: queue.filter((item) => item && item.productId !== productId) },
        { merge: true }
      );
    } catch (error) {
      /* la file se nettoiera au prochain passage */
    }
    return { sent: true, productId };
  } catch (error) {
    console.warn('[rotation] force :', error.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = {
  STATE_PATH,
  PREMIUM_THRESHOLD,
  CYCLE_SIZE,
  isSmartOwner,
  decideRotation,
  readState,
  clientPayload,
  broadcastToClients,
  broadcastQueuedLow,
  applyRotation,
  forceBroadcast
};
