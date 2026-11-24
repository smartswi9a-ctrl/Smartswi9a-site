/* ============================================================
   functions/triggers.js — 17 NOTIFICATIONS PAR RÔLE
   ------------------------------------------------------------
   NOTIFICATIONS PUSH + IN-APP (+ 5 emails EmailJS côté emails.js).
   ADMIN : push + in-app uniquement — AUCUN email.
   Quota EmailJS : 5 emails automatiques (4 vendeur, 1 client).
   Chaque déclencheur est tolérant aux erreurs : une notification
   ne doit jamais casser un flux métier.
   ============================================================ */

const {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentWritten
} = require('firebase-functions/v2/firestore');

const {
  db,
  mad,
  notifyAdmins,
  notifyVendor,
  notifyClient,
  notifyUids,
  notifyRole,
  claimOnce
} = require('./notifications');

const { sendCriticalEmail, sendCampaignEmails, verifyUnsubscribeToken } = require('./emails');
const { applyRotation, forceBroadcast, STATE_PATH } = require('./rotation');
const { handlePriceDrop, handleLowStock, processScheduledEmails } = require('./retargeting');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');

/* ---------- Helpers commandes ---------- */

function orderNumber(order, id) {
  return String(order.orderNumber || order.number || order.ref || id).slice(0, 24);
}

function orderTotal(order) {
  return order.total ?? order.totalAmount ?? order.amount ?? order.grandTotal ?? 0;
}

function orderCity(order) {
  const address = order.deliveryAddress || order.shippingAddress || {};
  return address.city || address.town || order.city || '—';
}

function orderItems(order) {
  return Array.isArray(order.items) ? order.items : [];
}

function vendorIdsOf(order) {
  return [...new Set(orderItems(order).map((item) => item && item.vendorId).filter(Boolean))];
}

function clientUidOf(order) {
  return order.userId || order.customerId || order.uid || '';
}

/* ---------- Lignes de commande (emails EmailJS) ---------- */

function itemLabel(item) {
  return String(item.name || item.nameFr || item.title || 'Article').slice(0, 60);
}

function itemQty(item) {
  return Number(item.quantity) || 1;
}

function itemPrice(item) {
  const n = Number(item.price ?? item.unitPrice ?? item.prix);
  return Number.isFinite(n) ? n : 0;
}

function orderLines(order, vendorId) {
  return orderItems(order)
    .filter((item) => (vendorId ? item.vendorId === vendorId : true))
    .map((item) => ({ label: itemLabel(item), qty: itemQty(item), price: itemPrice(item) }));
}

function linesTotal(lines) {
  return Math.round(lines.reduce((sum, line) => sum + line.qty * line.price, 0) * 100) / 100;
}

/* Commission vendeur de 7 % (CONFIG.VENDOR.COMMISSION_RATE). */
function vendorNet(lines) {
  return Math.round(linesTotal(lines) * 0.93 * 100) / 100;
}

/* ============================================================
   ADMIN 1 — Nouvelle commande
   VENDEUR 3 — Nouvelle commande vendeur
   ============================================================ */

exports.onOrderCreated = onDocumentCreated('orders/{orderId}', async (event) => {
  try {
    const order = event.data && event.data.data();
    if (!order) return;
    const id = event.params.orderId;
    const num = orderNumber(order, id);
    const total = mad(orderTotal(order));
    const city = orderCity(order);

    await notifyAdmins({
      type: 'admin_new_order',
      title: 'Nouvelle commande',
      body: `Commande ${num} — ${total} — ${city}`,
      targetUrl: `/admin.html?tab=orders&order=${encodeURIComponent(id)}`,
      tag: `order-${id}`,
      extra: { orderId: id }
    });

    for (const vendorId of vendorIdsOf(order)) {
      const items = orderItems(order).filter((item) => item.vendorId === vendorId);
      const qty = items.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
      const label = items[0] && (items[0].name || items[0].nameFr || items[0].title);
      await notifyVendor(vendorId, {
        type: 'seller_new_order',
        title: 'Nouvelle commande vendeur',
        body: `${qty} article(s)${label ? ' — ' + String(label).slice(0, 60) : ''} — ${total}`,
        targetUrl: `/vendor/dashboard?tab=orders&order=${encodeURIComponent(id)}`,
        tag: `vendor-order-${id}`,
        extra: { orderId: id }
      });
      /* EMAIL VENDEUR 3/5 — nouvelle commande (quota EmailJS). */
      const lines = orderLines(order, vendorId);
      await sendCriticalEmail({
        uid: vendorId,
        role: 'seller',
        type: 'seller_new_order',
        data: {
          orderId: id,
          orderNumber: num,
          city,
          lines,
          vendorTotal: vendorNet(lines)
        }
      });
    }

    /* EMAIL CLIENT 1/1 — confirmation initiale (jamais pour un admin). */
    const clientUid = clientUidOf(order);
    const clientRole = String(order.userRole || 'client');
    if (clientUid && clientRole !== 'admin') {
      await sendCriticalEmail({
        uid: clientUid,
        role: 'client',
        type: 'client_order_confirmation',
        data: {
          orderId: id,
          orderNumber: num,
          city,
          total: orderTotal(order),
          lines: orderLines(order)
        }
      });
    }
  } catch (error) {
    console.error('[triggers] onOrderCreated :', error);
  }
});

/* ============================================================
   ADMIN 2 — Stock critique | ADMIN 5 — Nouveau produit
   VENDEUR 4 — Validation / refus | CLIENT 2 — Promo favoris
   ============================================================ */

exports.onProductWritten = onDocumentWritten('products/{productId}', async (event) => {
  try {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;

    const id = event.params.productId;
    const name = String(after.nameFr || after.name || after.title || 'Produit').slice(0, 80);
    const owner = after.vendorId || after.sellerId || '';
    const ownerLabel = owner ? 'vendeur' : 'Smartswika';

    /* ADMIN 5 — nouvelle fiche soumise */
    if (!before && (after.status === 'pending_admin_approval' || after.status === 'pending')) {
      await notifyAdmins({
        type: 'admin_new_product',
        title: 'Nouveau produit à valider',
        body: `${name} — ${ownerLabel}`,
        targetUrl: `/admin.html?tab=products&product=${encodeURIComponent(id)}`,
        tag: `product-pending-${id}`,
        extra: { productId: id }
      });
    }

    /* ADMIN 2 — rupture / stock critique (sur transition) */
    const stock = Number(after.stock);
    const previousStock = before ? Number(before.stock) : NaN;
    if (Number.isFinite(stock) && stock <= 2) {
      const crossed = !before || !Number.isFinite(previousStock) || previousStock > 2;
      if (crossed) {
        await notifyAdmins({
          type: stock <= 0 ? 'admin_stock_out' : 'admin_stock_low',
          title: stock <= 0 ? 'Rupture de stock' : 'Stock critique',
          body: `${name} (${ownerLabel}) — stock : ${stock}`,
          targetUrl: `/admin.html?tab=products&product=${encodeURIComponent(id)}`,
          tag: `stock-${id}`,
          extra: { productId: id, stock }
        });
      }
    }

    /* VENDEUR 4 — décision de l'admin sur la fiche */
    if (before && owner && before.status !== after.status) {
      const decision = after.status;
      const messages = {
        approved: ['Fiche produit validée', `« ${name} » est publiée.`],
        rejected: ['Fiche produit refusée', `« ${name} » a été refusée.`],
        suspended: ['Fiche produit suspendue', `« ${name} » a été suspendue.`]
      };
      if (messages[decision]) {
        await notifyVendor(owner, {
          type: `seller_product_${decision}`,
          title: messages[decision][0],
          body: messages[decision][1],
          targetUrl: `/vendor/dashboard?tab=products&product=${encodeURIComponent(id)}`,
          tag: `product-${decision}-${id}`,
          extra: { productId: id }
        });
      }
    }

    /* DIFFUSION CLIENTS — produits Smartswika (100 %) et boucle 10:1 vendeurs. */
    const becameApproved = after.status === 'approved' && (!before || before.status !== 'approved');
    const oldPriceNum = before ? Number(before.price) : NaN;
    const newPriceNum = Number(after.price);
    const promoDrop =
      before &&
      before.status === 'approved' &&
      after.status === 'approved' &&
      Number.isFinite(oldPriceNum) &&
      Number.isFinite(newPriceNum) &&
      newPriceNum < oldPriceNum;
    if (becameApproved || promoDrop) {
      await applyRotation({ productId: id, product: after, vendorId: owner });
    }

    /* RECIBLAGE (règles 1-9) : baisse de prix sur un produit déjà consulté. */
    if (promoDrop) {
      await handlePriceDrop({ productId: id, product: after });
    }

    /* RECIBLAGE (règle 10) : « dernières pièces » sur un produit consulté. */
    if (Number.isFinite(stock) && stock > 0 && stock <= 3) {
      const enteredLowStock = !Number.isFinite(previousStock) || previousStock > 3;
      if (enteredLowStock) {
        await handleLowStock({ productId: id, product: after });
      }
    }

    /* CLIENT 2 — produit passé en promotion (uniquement les favoris) */
    if (before && after.status === 'approved') {
      const oldPrice = Number(before.price);
      const newPrice = Number(after.price);
      if (Number.isFinite(oldPrice) && Number.isFinite(newPrice) && newPrice < oldPrice) {
        try {
          const favs = await db
            .collection('users')
            .where('favorites', 'array-contains', id)
            .limit(100)
            .get();
          const uids = favs.docs.map((d) => d.id);
          if (uids.length) {
            await notifyUids(uids, {
              type: 'client_promo',
              title: 'Promotion sur un produit favori',
              body: `${name} : ${mad(oldPrice)} → ${mad(newPrice)}`,
              targetUrl: `/produit.html?slug=${encodeURIComponent(after.slug || '')}`,
              tag: `promo-${id}-${Math.round(newPrice * 100)}`,
              recipientRole: 'client',
              extra: { productId: id }
            });
          }
        } catch (favError) {
          console.warn('[triggers] favoris promo :', favError.message);
        }
        /* Aucun email automatique ici : mode économie EmailJS (5 emails max). */
      }
    }
  } catch (error) {
    console.error('[triggers] onProductWritten :', error);
  }
});

/* ============================================================
   ADMIN 3 — Demande de ramassage
   ============================================================ */

exports.onPickupCreated = onDocumentCreated('vendor_pickup_requests/{requestId}', async (event) => {
  try {
    const data = event.data && event.data.data();
    if (!data) return;
    const id = event.params.requestId;
    const items = Array.isArray(data.items) ? data.items : [];
    const qty = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

    let city = '';
    try {
      const vendor = await db.collection('users').doc(String(data.vendorId || '')).get();
      const profile = vendor.exists ? vendor.data() || {} : {};
      city = profile.city || (profile.vendorInfo && profile.vendorInfo.city) || '';
    } catch (error) {
      /* ville facultative */
    }

    await notifyAdmins({
      type: 'admin_pickup_request',
      title: 'Demande de ramassage',
      body: `${data.vendorName || 'Vendeur'} — ${items.length} article(s), ${qty} unité(s)${city ? ' — ' + city : ''}`,
      targetUrl: `/admin.html?tab=pickups&request=${encodeURIComponent(id)}`,
      tag: `pickup-${id}`,
      extra: { pickupRequestId: id, vendorId: data.vendorId || '' }
    });
  } catch (error) {
    console.error('[triggers] onPickupCreated :', error);
  }
});

/* ============================================================
   VENDEUR 1 — Ramassage approuvé
   VENDEUR 2 — Marchandise reçue (déblocage du formulaire produit)
   ============================================================ */

exports.onPickupUpdated = onDocumentUpdated('vendor_pickup_requests/{requestId}', async (event) => {
  try {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const id = event.params.requestId;
    const vendorId = after.vendorId || before.vendorId;
    if (!vendorId) return;

    if (before.status !== 'approved' && after.status === 'approved') {
      await notifyVendor(vendorId, {
        type: 'seller_pickup_approved',
        title: 'Ramassage approuvé',
        body: `Votre demande est approuvée${after.desiredDate ? ' — ' + after.desiredDate : ''}.`,
        targetUrl: '/vendor/dashboard?tab=stock',
        tag: `pickup-approved-${id}`,
        extra: { pickupRequestId: id }
      });
      /* EMAIL VENDEUR 1/5 — ramassage approuvé. */
      const pickupItems = Array.isArray(after.items) ? after.items : [];
      const pickupQty = pickupItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      await sendCriticalEmail({
        uid: vendorId,
        role: 'seller',
        type: 'seller_pickup_approved',
        data: {
          requestId: id,
          slot: after.desiredDate || after.pickupDate || after.confirmedSlot || '',
          summary: `${pickupItems.length} article(s), ${pickupQty} unité(s)`
        }
      });
    }

    if (!before.received_at_warehouse && after.received_at_warehouse === true) {
      await notifyVendor(vendorId, {
        type: 'seller_warehouse_received',
        title: 'Marchandise reçue à l’entrepôt',
        body: 'Vos marchandises sont arrivées à l’entrepôt Smart Swika. Vous pouvez désormais ajouter vos produits.',
        targetUrl: '/vendor/dashboard?tab=products',
        tag: `pickup-received-${id}`,
        extra: { pickupRequestId: id }
      });
      /* EMAIL VENDEUR 2/5 — marchandise reçue (formulaire débloqué). */
      const receivedItems = Array.isArray(after.items) ? after.items : [];
      const receivedQty = receivedItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      await sendCriticalEmail({
        uid: vendorId,
        role: 'seller',
        type: 'seller_warehouse_received',
        data: {
          requestId: id,
          summary: `${receivedItems.length} article(s), ${receivedQty} unité(s)`
        }
      });
    }
  } catch (error) {
    console.error('[triggers] onPickupUpdated :', error);
  }
});

/* ============================================================
   ADMIN 4 — Nouveau vendeur inscrit
   VENDEUR 6 — Suspension (type + cause obligatoires)
   ============================================================ */

exports.onUserWritten = onDocumentWritten('users/{uid}', async (event) => {
  try {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const uid = event.params.uid;
    const info = after.vendorInfo || {};

    if (!before && after.role === 'vendor' && info.status === 'pending') {
      await notifyAdmins({
        type: 'admin_new_vendor',
        title: 'Nouveau vendeur inscrit',
        body: `${info.shopName || after.name || 'Vendeur'}${after.phone ? ' — ' + after.phone : ''}`,
        targetUrl: `/admin.html?tab=vendors&vendor=${encodeURIComponent(uid)}`,
        tag: `vendor-new-${uid}`,
        extra: { vendorId: uid }
      });
    }

    const beforeSuspension = before && before.vendorInfo ? before.vendorInfo.suspension : null;
    const afterSuspension = info.suspension || null;
    const isNewSuspension =
      afterSuspension &&
      (!beforeSuspension ||
        beforeSuspension.cause !== afterSuspension.cause ||
        beforeSuspension.type !== afterSuspension.type ||
        beforeSuspension.until !== afterSuspension.until);

    if (isNewSuspension) {
      const typeLabel =
        afterSuspension.type === 'permanent'
          ? 'Définitive'
          : `Temporaire${afterSuspension.until ? ' jusqu’au ' + afterSuspension.until : ''}`;
      await notifyVendor(uid, {
        type: 'seller_suspended',
        title: 'Compte vendeur suspendu',
        body: `${typeLabel} — Cause : ${afterSuspension.cause || 'non précisée'}`,
        targetUrl: '/vendor/dashboard',
        tag: `vendor-suspended-${uid}-${Date.now()}`,
        extra: { suspension: afterSuspension }
      });
      /* EMAIL VENDEUR 4/5 — suspension (type + cause obligatoires). */
      await sendCriticalEmail({
        uid,
        role: 'seller',
        type: 'seller_suspended',
        data: {
          suspensionType: afterSuspension.type || 'temporary',
          until: afterSuspension.until || '',
          cause: afterSuspension.cause || 'Non précisée',
          date: new Date().toISOString().slice(0, 10)
        }
      });
    }
  } catch (error) {
    console.error('[triggers] onUserWritten :', error);
  }
});

/* ============================================================
   ADMIN 6 — Annulation / retour
   CLIENT 1 — Suivi de commande
   VENDEUR 5 — Suivi de livraison
   ============================================================ */

exports.onOrderUpdated = onDocumentUpdated('orders/{orderId}', async (event) => {
  try {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const status = String(after.status || '');
    if (!status || status === String(before.status || '')) return;

    const id = event.params.orderId;
    const num = orderNumber(after, id);
    const uid = clientUidOf(after);

    if (status === 'cancelled' || status === 'returned') {
      await notifyAdmins({
        type: status === 'cancelled' ? 'admin_order_cancelled' : 'admin_order_returned',
        title: status === 'cancelled' ? 'Commande annulée' : 'Retour enregistré',
        body: `Commande ${num} — ${mad(orderTotal(after))} — ${orderCity(after)}`,
        targetUrl: `/admin.html?tab=orders&order=${encodeURIComponent(id)}`,
        tag: `order-${status}-${id}`,
        extra: { orderId: id }
      });
    }

    const clientLabels = {
      confirmed: ['Commande confirmée', 'Votre commande est confirmée.'],
      shipping: ['Commande en route', 'Votre colis est en cours de livraison.'],
      delivered: ['Commande livrée', 'Votre colis a été livré. Merci !']
    };
    if (uid && clientLabels[status]) {
      await notifyClient(uid, {
        type: `client_order_${status}`,
        title: `${clientLabels[status][0]} — ${num}`,
        body: clientLabels[status][1],
        targetUrl: '/?action=account',
        tag: `client-order-${id}-${status}`,
        extra: { orderId: id }
      });
      /* Push + in-app uniquement : pas d'email de suivi (quota EmailJS). */
    }

    for (const vendorId of vendorIdsOf(after)) {
      if (status === 'shipping') {
        await notifyVendor(vendorId, {
          type: 'seller_order_shipping',
          title: `Commande ${num} en route`,
          body: 'Le colis a été remis au transporteur.',
          targetUrl: `/vendor/dashboard?tab=orders&order=${encodeURIComponent(id)}`,
          tag: `vendor-order-shipping-${id}`,
          extra: { orderId: id }
        });
      }
      if (status === 'delivered' || status === 'returned') {
        await notifyVendor(vendorId, {
          type: `seller_order_${status}`,
          title: status === 'delivered' ? `Commande ${num} livrée` : `Retour ${num}`,
          body: status === 'delivered' ? 'La livraison est confirmée.' : 'Un retour a été enregistré.',
          targetUrl: `/vendor/dashboard?tab=orders&order=${encodeURIComponent(id)}`,
          tag: `vendor-order-${status}-${id}`,
          extra: { orderId: id }
        });
        /* Push + in-app uniquement : pas d'email final (quota EmailJS). */
      }
    }
  } catch (error) {
    console.error('[triggers] onOrderUpdated :', error);
  }
});

/* ============================================================
   CLIENT 3 — Ventes flash (annonce unique par vente)
   ============================================================ */

exports.onFlashSaleWritten = onDocumentWritten('flash_sales/{saleId}', async (event) => {
  try {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after || after.status !== 'active') return;
    if (before && before.status === 'active') return;

    const id = event.params.saleId;
    if (!(await claimOnce(`flash_${id}`, 12))) return;

    const title = String(after.title || after.name || 'Vente flash').slice(0, 80);
    await notifyRole('client', {
      type: 'client_flash_sale',
      title: '⚡ Vente flash en cours',
      body: `${title} — quantités limitées.`,
      targetUrl: '/koulchi.html',
      tag: `flash-${id}`
    });
    /* Aucun email automatique : push + in-app uniquement (quota préservé). */
  } catch (error) {
    console.error('[triggers] onFlashSaleWritten :', error);
  }
});

/* ============================================================
   CLIENT 5 — Événements du calendrier Smartswika
   ============================================================ */

exports.onEventsConfigWritten = onDocumentWritten('config/events', async (event) => {
  try {
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const before = event.data.before.exists ? event.data.before.data() : null;
    const serialize = (data) => JSON.stringify((data && data.events) || []);
    if (before && serialize(before) === serialize(after)) return;

    const stamp =
      after.updatedAt && typeof after.updatedAt.toMillis === 'function'
        ? after.updatedAt.toMillis()
        : Date.now();
    if (!(await claimOnce(`events_${stamp}`, 1))) return;

    await notifyRole('client', {
      type: 'client_event',
      title: 'Nouvel événement Smartswika',
      body: 'Une nouvelle opération saisonnière est en ligne.',
      targetUrl: '/',
      tag: 'events'
    });
    /* Aucun email automatique : push + in-app uniquement (quota préservé). */
  } catch (error) {
    console.error('[triggers] onEventsConfigWritten :', error);
  }
});

/* ============================================================
   CAMPAGNES MANUELLES (admin) — push immédiat
   EmailJS optionnel (case décochée), file espacée 2,5 s.
   ============================================================ */

exports.onCampaignCreated = onDocumentCreated('campaigns/{campaignId}', async (event) => {
  try {
    const data = event.data && event.data.data();
    if (!data || data.status === 'sent') return;

    const channel = String(data.channel || 'push');
    const wantsPush = channel === 'push' || channel === 'both';

    const segment = String(data.segment || 'clients');
    const role = segment === 'vendors' ? 'seller' : segment === 'admins' ? 'admin' : 'client';
    const id = event.params.campaignId;

    /* Les admins ne reçoivent jamais d'email : push + in-app seulement. */
    const push = wantsPush
      ? await notifyRole(role, {
          type: String(data.type || 'campaign'),
          title: String(data.title || 'Smartswika').slice(0, 120),
          body: String(data.body || '').slice(0, 240),
          targetUrl: String(data.targetUrl || '/'),
          tag: `campaign-${id}`
        })
      : { sent: 0, failed: 0 };

    /* Case « Envoyer aussi par EmailJS » : file espacée 2,5 s + désinscription. */
    const emailResult =
      data.sendEmail === true ? await sendCampaignEmails(id, data) : { sent: 0, skipped: 0, reason: 'not_requested' };

    const { FieldValue } = require('firebase-admin/firestore');
    await event.data.ref.set(
      {
        status: 'sent',
        sentAt: FieldValue.serverTimestamp(),
        pushSent: push.sent || 0,
        pushFailed: push.failed || 0,
        emailSent: emailResult.sent || 0,
        emailSkipped: emailResult.skipped || 0,
        emailReason: String(emailResult.reason || '')
      },
      { merge: true }
    );
  } catch (error) {
    console.error('[triggers] onCampaignCreated :', error);
  }
});

/* ============================================================
   DIFFUSION FORCÉE (admin) — hors cycle 10:1
   L'admin écrit forceProductId dans config/notifications_command ;
   le déclencheur diffuse immédiatement puis nettoie la commande.
   ============================================================ */

const FORCE_PATH = 'config/notifications_command';

exports.onRotationForceRequested = onDocumentWritten(FORCE_PATH, async (event) => {
  try {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const forceId = String(after.forceProductId || '').trim();
    if (!forceId) return;
    if (before && String(before.forceProductId || '') === forceId) return;

    const result = await forceBroadcast(forceId);
    const { FieldValue } = require('firebase-admin/firestore');
    await event.data.after.ref.set(
      {
        forceProductId: FieldValue.delete(),
        lastForcedProductId: forceId,
        lastForcedAt: FieldValue.serverTimestamp(),
        lastResult: result.sent ? 'sent' : String(result.reason || 'skipped')
      },
      { merge: true }
    );
  } catch (error) {
    console.error('[triggers] onRotationForceRequested :', error);
  }
});

/* ============================================================
   DÉSINSCRIPTION EMAILS (lien présent dans chaque campagne)
   ============================================================ */

exports.unsubscribeEmail = onRequest(
  { invoker: 'public', region: 'europe-west1', cors: true, maxInstances: 2, timeoutSeconds: 15 },
  async (req, res) => {
    try {
      const token = String((req.query && req.query.t) || (req.body && req.body.t) || '');
      const uid = verifyUnsubscribeToken(token);
      if (!uid) {
        res.status(400).json({ ok: false, error: 'invalid_token' });
        return;
      }
      const { FieldValue } = require('firebase-admin/firestore');
      await db
        .collection('users')
        .doc(uid)
        .set({ emailOptOut: true, emailOptOutAt: FieldValue.serverTimestamp() }, { merge: true });
      res.json({ ok: true });
    } catch (error) {
      console.error('[triggers] unsubscribeEmail :', error);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  }
);

/* ============================================================
   RECIBLAGE — ENVOI DIFFÉRÉ (créneaux de pic Maroc, digest 1/jour)
   Toutes les 10 minutes : traite scheduled_emails arrivés à échéance.
   ============================================================ */

exports.retargetingSweep = onSchedule(
  { schedule: 'every 10 minutes', timeZone: 'Africa/Casablanca', maxInstances: 1, timeoutSeconds: 540 },
  async () => {
    try {
      const result = await processScheduledEmails({});
      if (result.sent || result.failed) {
        console.log('[retargeting] sweep', JSON.stringify(result));
      }
    } catch (error) {
      console.error('[triggers] retargetingSweep :', error);
    }
  }
);
