/* ============================================================
   functions/retargeting.js — RECIBLAGE INTELLIGENT (GLUE)
   ------------------------------------------------------------
   PASSIF : lit product_views, n'écrit jamais dans le catalogue,
   le panier, le tri ou les recommandations.
   Reçoit un événement produit (baisse de prix / stock faible),
   décide du canal (push gratuit d'abord), et alimente la file
   `scheduled_emails` (1 email digest / client / jour).
   ============================================================ */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { mad, notifyClient } = require('./notifications');
const core = require('./retargeting-core');

const db = getFirestore();

const VIEWS = 'product_views';
const SCHEDULED = 'scheduled_emails';
const TOKENS = 'fcm_tokens';
const USERS = 'users';
const MAX_VIEWS = 400;

/* Plafond promotionnel : au-delà, 100 % push (quota transactionnel préservé). */
const PROMO_QUOTA_LIMIT = 180;

function toMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Vues enregistrées pour un produit (lecture seule). */
async function loadViews(productId) {
  try {
    const snap = await db.collection(VIEWS).where('productId', '==', String(productId)).limit(MAX_VIEWS).get();
    return snap.docs.map((doc) => ({ viewId: doc.id, ...(doc.data() || {}) }));
  } catch (error) {
    console.warn('[retargeting] loadViews :', error.message);
    return [];
  }
}

/** Le client a-t-il un token push actif ? (règle 7) */
async function hasPushToken(uid) {
  try {
    const snap = await db.collection(TOKENS).where('uid', '==', String(uid)).limit(5).get();
    return snap.docs.some((doc) => doc.data().active !== false);
  } catch (error) {
    return false;
  }
}

/** Profil client (plafond 3/7, opt-out). */
async function loadClient(uid) {
  try {
    const snap = await db.doc(`${USERS}/${uid}`).get();
    return snap.exists ? snap.data() || {} : {};
  } catch (error) {
    return {};
  }
}

/** Quota promotionnel restant (max 20 % de marge sur 200). */
async function quotaRemaining() {
  try {
    const snap = await db.doc('config/emailjs_usage').get();
    const data = snap.exists ? snap.data() || {} : {};
    const limit = Number(data.limit || 200);
    const used = Number(data.count || 0);
    const promoCap = Math.min(limit, PROMO_QUOTA_LIMIT);
    return Math.max(0, Math.min(limit - used, promoCap - used));
  } catch (error) {
    return 0;
  }
}

/** Ajoute des articles au digest du jour (1 doc par client et par jour). */
async function enqueueDigest({ uid, items, scheduledFor, abandoned }) {
  const { dayKey } = core.moroccoParts(Date.now());
  const ref = db.doc(`${SCHEDULED}/${uid}_${dayKey}`);
  try {
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() || {} : {};
    if (existing.status === 'sent') return false;
    const known = new Set((existing.items || []).map((item) => item && item.productId));
    const fresh = items.filter((item) => item && !known.has(item.productId));
    if (!fresh.length && existing.items) return false;
    const currentFor = toMs(existing.scheduledFor);
    const target = currentFor && currentFor > scheduledFor ? currentFor : scheduledFor;
    await ref.set(
      {
        uid,
        items: [...(existing.items || []), ...fresh],
        abandoned: existing.abandoned === true || abandoned === true,
        status: 'pending',
        scheduledFor: new Date(target),
        updatedAt: FieldValue.serverTimestamp(),
        ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() })
      },
      { merge: true }
    );
    return true;
  } catch (error) {
    console.warn('[retargeting] enqueueDigest :', error.message);
    return false;
  }
}

/** Payload push/in-app commun (gratuit). */
function promoPayload(product, productId, line) {
  const price = Number(product.price);
  const seen = Number(line && line.seenPrice);
  const body =
    Number.isFinite(seen) && seen > price
      ? `${String(product.nameFr || product.name || 'Produit').slice(0, 60)} : ${mad(seen)} → ${mad(price)}`
      : `${String(product.nameFr || product.name || 'Produit').slice(0, 60)} — ${mad(price)}`;
  return {
    type: 'client_price_drop',
    title: '📉 Baisse de prix sur un produit consulté',
    body,
    targetUrl: `/produit?slug=${encodeURIComponent(product.slug || productId)}${
      line && line.inAbandonedCart ? '&cart=1' : ''
    }`,
    tag: `drop-${productId}`
  };
}

/**
 * Baisse de prix / promotion : règles 1 à 9.
 * Push gratuit pour tous les éligibles, email seulement pour les
 * clients sans push (ou panier abandonné), sous plafond 3/7.
 */
async function handlePriceDrop({ productId, product = {}, nowMs } = {}) {
  const now = Number(nowMs) || Date.now();
  const newPrice = Number(product.price);
  if (!Number.isFinite(newPrice) || newPrice <= 0) return { skipped: 'invalid_price' };

  const rawViews = await loadViews(productId);
  const views = rawViews.map((view) => ({ ...view, lastViewedAtMs: toMs(view.lastViewedAt) }));
  const { eligible, rejected } = core.rankCandidates(views, { newPrice, nowMs: now });
  const remaining = await quotaRemaining();

  const title = String(product.nameFr || product.name || product.title || 'Produit').slice(0, 90);
  const image = String(product.image || product.imageUrl || product.photo || '');
  let push = 0;
  let queued = 0;

  for (const view of eligible) {
    const uid = String(view.uid || '').trim();
    if (!uid) continue;
    if (!(await require('./notifications').claimOnce(`drop-${productId}-${uid}`, 24))) continue;

    await notifyClient(uid, promoPayload(product, productId, view));
    push += 1;

    const [pushOk, client] = await Promise.all([hasPushToken(uid), loadClient(uid)]);
    if (client.emailOptOut === true) continue;

    const choice = core.chooseChannel({
      view: { ...view, promoEmailTimestamps: client.promoEmailTimestamps || [] },
      hasPush: pushOk,
      quotaRemaining: remaining,
      nowMs: now
    });
    if (choice.channel !== 'email' && choice.channel !== 'schedule') continue;

    const ok = await enqueueDigest({
      uid,
      abandoned: view.inAbandonedCart === true,
      items: [
        {
          productId,
          title,
          image,
          seenPrice: Number(view.seenPrice) || 0,
          newPrice,
          inAbandonedCart: view.inAbandonedCart === true
        }
      ],
      scheduledFor: choice.channel === 'email' ? now : core.nextPeakSlot(now)
    });
    if (ok) queued += 1;
  }

  return { productId, candidates: views.length, eligible: eligible.length, push, queued, rejected };
}

/** Règle 10 : « dernières pièces » sur un produit consulté. */
async function handleLowStock({ productId, product = {}, nowMs } = {}) {
  const now = Number(nowMs) || Date.now();
  const stock = Number(product.stock);
  if (!Number.isFinite(stock) || stock <= 0 || stock > core.LOW_STOCK_THRESHOLD) {
    return { skipped: 'stock_ok' };
  }

  const rawViews = await loadViews(productId);
  const title = String(product.nameFr || product.name || product.title || 'Produit').slice(0, 70);
  const remaining = await quotaRemaining();
  let pushed = 0;
  let queued = 0;

  for (const raw of rawViews) {
    const view = { ...raw, lastViewedAtMs: toMs(raw.lastViewedAt) };
    if (!core.shouldAlertLowStock({ stock, view, nowMs: now })) continue;
    const uid = String(view.uid || '').trim();
    if (!uid) continue;

    await notifyClient(uid, {
      type: 'client_low_stock',
      title: '⏳ Dernières pièces disponibles',
      body: `Il ne reste plus que ${stock} exemplaire(s) de « ${title} », que vous avez consulté.`,
      targetUrl: `/produit?slug=${encodeURIComponent(product.slug || productId)}`,
      tag: `low-stock-${productId}`
    });
    pushed += 1;

    try {
      await db.doc(`${VIEWS}/${view.viewId}`).set({ lowStockAlertSent: true }, { merge: true });
    } catch (error) {
      /* non bloquant */
    }

    if (view.inAbandonedCart !== true) continue;
    const client = await loadClient(uid);
    if (client.emailOptOut === true) continue;
    if (!core.withinFatigueCap(client.promoEmailTimestamps, now)) continue;
    if (remaining <= 0) continue;
    const ok = await enqueueDigest({
      uid,
      abandoned: true,
      items: [
        {
          productId,
          title,
          image: String(product.image || ''),
          seenPrice: Number(view.seenPrice) || Number(product.price) || 0,
          newPrice: Number(product.price) || 0,
          lowStock: stock
        }
      ],
      scheduledFor: core.isPeakWindow(now) ? now : core.nextPeakSlot(now)
    });
    if (ok) queued += 1;
  }

  return { productId, stock, pushed, queued };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Marque les vues comme « email promo envoyé » + horodatage anti-fatigue. */
async function markViewsSent({ uid, lines, nowMs }) {
  try {
    const batch = db.batch();
    for (const line of Array.isArray(lines) ? lines : []) {
      if (!line || !line.productId) continue;
      batch.set(
        db.doc(`${VIEWS}/${uid}_${line.productId}`),
        { promoEmailSent: true, promoEmailSentAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    batch.set(
      db.doc(`${USERS}/${uid}`),
      { promoEmailTimestamps: FieldValue.arrayUnion(new Date(Number(nowMs) || Date.now())) },
      { merge: true }
    );
    await batch.commit();
  } catch (error) {
    console.warn('[retargeting] markViewsSent :', error.message);
  }
}

/**
 * Envoie les digests arrivés à échéance (créneaux de pic, file 2,5 s).
 * Appelé par la Cloud Function planifiée toutes les 10 minutes.
 */
async function processScheduledEmails({ nowMs, limit = 15 } = {}) {
  const now = Number(nowMs) || Date.now();
  let due = null;
  try {
    due = await db
      .collection(SCHEDULED)
      .where('status', '==', 'pending')
      .where('scheduledFor', '<=', new Date(now))
      .limit(limit)
      .get();
  } catch (error) {
    console.warn('[retargeting] processScheduledEmails :', error.message);
    return { due: 0, sent: 0, skipped: 0, failed: 0 };
  }

  const { sendPromoDigestEmail } = require('./emails');
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of due.docs) {
    const data = doc.data() || {};
    const digest = core.buildDigest(data.items, now);
    if (!digest) {
      await doc.ref.set({ status: 'skipped', reason: 'empty' }, { merge: true });
      skipped += 1;
      continue;
    }
    const client = await loadClient(data.uid);
    if (client.emailOptOut === true) {
      await doc.ref.set({ status: 'skipped', reason: 'opt_out' }, { merge: true });
      skipped += 1;
      continue;
    }
    if (!core.withinFatigueCap(client.promoEmailTimestamps, now)) {
      await doc.ref.set({ status: 'skipped', reason: 'fatigue_cap' }, { merge: true });
      skipped += 1;
      continue;
    }

    const result = await sendPromoDigestEmail({
      uid: data.uid,
      digest,
      client,
      abandoned: data.abandoned === true
    });

    if (result.sent) {
      sent += 1;
      await doc.ref.set(
        { status: 'sent', sentAt: FieldValue.serverTimestamp(), itemCount: digest.count },
        { merge: true }
      );
      await markViewsSent({ uid: data.uid, lines: digest.lines, nowMs: now });
      await sleep(2500);
      continue;
    }

    if (result.reason === 'quota_exceeded' || result.reason === 'no_private_key') break;
    failed += 1;
    await doc.ref.set({ status: 'failed', reason: String(result.reason || '') }, { merge: true });
  }

  return { due: due.size, sent, skipped, failed };
}

module.exports = {
  PROMO_QUOTA_LIMIT,
  VIEWS,
  SCHEDULED,
  handlePriceDrop,
  handleLowStock,
  processScheduledEmails,
  markViewsSent,
  quotaRemaining
};

