/* ============================================================
   functions/notifications.js — HELPERS PUSH + IN-APP
   ------------------------------------------------------------
   Push FCM + centre de notifications in-app.
   Emails : 5 critiques seulement (functions/emails.js), jamais d'admin.
   RÈGLE ABSOLUE : aucun email vers un compte admin.
   ============================================================ */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const db = getFirestore();

const TOKENS = 'fcm_tokens';
const NOTIFICATIONS = 'notifications';
const USERS = 'users';
const PUSH_CHUNK = 500;
const MAX_IN_APP = 500;

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
]);

/* Admin uids en cache mémoire (5 min) pour éviter des lectures. */
let adminCache = { at: 0, uids: [] };
const ADMIN_TTL_MS = 5 * 60 * 1000;

/** Horodatage lisible à l'heure du Maroc (Africa/Casablanca). */
function moroccoStamp(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Casablanca',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date);
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  } catch (error) {
    return date.toISOString();
  }
}

/** Montant en MAD, arrondi. */
function mad(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2).replace(/\.00$/, '')} MAD` : '—';
}

/** Écrit une notification in-app (double schéma pour compatibilité cloche). */
async function createInApp(payload) {
  const recipientId = payload.recipientId;
  if (!recipientId) return null;
  const body = String(payload.body || '');
  return db.collection(NOTIFICATIONS).add({
    recipientId,
    recipientRole: payload.recipientRole || 'client',
    type: payload.type || 'info',
    title: String(payload.title || 'Smartswika'),
    body,
    targetUrl: payload.targetUrl || '/',
    isRead: false,
    /* Champs historiques conservés pour js/notifications.js */
    userId: recipientId,
    message: body,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
    createdAtMorocco: moroccoStamp(),
    ...(payload.extra || {})
  });
}

/** Uids des administrateurs (cache 5 min). */
async function getAdminUids() {
  if (Date.now() - adminCache.at < ADMIN_TTL_MS && adminCache.uids.length) {
    return adminCache.uids;
  }
  try {
    const snap = await db.collection(USERS).where('role', '==', 'admin').limit(10).get();
    const uids = snap.docs.map((d) => d.id);
    adminCache = { at: Date.now(), uids };
    return uids;
  } catch (error) {
    console.warn('[notifications] admin uids :', error.message);
    return [];
  }
}

/** Tokens actifs pour une liste d'uids (max 500). */
async function getTokensForUids(uids) {
  const unique = [...new Set((uids || []).filter(Boolean))];
  const tokens = [];
  for (let i = 0; i < unique.length && tokens.length < PUSH_CHUNK; i += 10) {
    const chunk = unique.slice(i, i + 10);
    const snap = await db
      .collection(TOKENS)
      .where('uid', 'in', chunk)
      .limit(PUSH_CHUNK)
      .get();
    snap.docs.forEach((d) => {
      if (d.data().active !== false) tokens.push(d.id);
    });
  }
  return [...new Set(tokens)].slice(0, PUSH_CHUNK);
}

/** Tokens actifs pour un rôle (max 500). */
async function getTokensForRole(role) {
  const snap = await db
    .collection(TOKENS)
    .where('role', '==', role)
    .limit(PUSH_CHUNK)
    .get();
  return snap.docs.filter((d) => d.data().active !== false).map((d) => d.id);
}

/**
 * Envoie un push HAUTE PRIORITÉ et purge les tokens invalides.
 * Deux blocs sont envoyés pour réveiller l'écran (Android/iOS) :
 *  - `notification` natif (bannière affichée même si l'onglet est fermé) ;
 *  - `webpush.notification` (icône, badge, requireInteraction, clic).
 */
async function sendPush(tokens, payload) {
  const list = [...new Set((tokens || []).filter(Boolean))];
  if (!list.length) return { sent: 0, failed: 0, cleaned: 0 };

  const data = {
    title: String(payload.title || 'Smartswika'),
    body: String(payload.body || ''),
    targetUrl: String(payload.targetUrl || '/'),
    type: String(payload.type || 'info'),
    tag: String(payload.tag || payload.type || 'smartswika')
  };

  const ICON = 'https://smartswika.ma/assets/pwa-192.png';
  const absoluteUrl = (value) => {
    const raw = String(value || '/');
    if (/^https?:\/\//i.test(raw)) return raw;
    return `https://smartswika.ma${raw.startsWith('/') ? '' : '/'}${raw}`;
  };

  const notification = { title: data.title, body: data.body };
  const webpushNotification = {
    title: data.title,
    body: data.body,
    icon: ICON,
    badge: ICON,
    requireInteraction: true,
    tag: data.tag,
    data: { url: data.targetUrl, type: data.type }
  };

  let sent = 0;
  let failed = 0;
  let cleaned = 0;

  for (let i = 0; i < list.length; i += PUSH_CHUNK) {
    const chunk = list.slice(i, i + PUSH_CHUNK);
    try {
      const response = await getMessaging().sendEachForMulticast({
        tokens: chunk,
        data,
        notification,
        webpush: {
          headers: { Urgency: 'high', TTL: '86400' },
          notification: webpushNotification,
          fcmOptions: { link: absoluteUrl(data.targetUrl) }
        }
      });
      sent += response.successCount;
      failed += response.failureCount;
      response.responses.forEach((res, index) => {
        const code = res.error && res.error.code;
        if (code && INVALID_TOKEN_CODES.has(code)) {
          cleaned += 1;
          db.collection(TOKENS).doc(chunk[index]).delete().catch(() => undefined);
        }
      });
    } catch (error) {
      console.warn('[notifications] envoi push :', error.message);
      failed += chunk.length;
    }
  }

  return { sent, failed, cleaned };
}

/** In-app + push vers une liste d'uids (max 500). */
async function notifyUids(uids, payload) {
  const list = [...new Set((uids || []).filter(Boolean))].slice(0, MAX_IN_APP);
  if (!list.length) return { recipients: 0, sent: 0, failed: 0 };

  await Promise.all(
    list.map((uid) => createInApp({ ...payload, recipientId: uid }))
  );
  const tokens = await getTokensForUids(list);
  const push = await sendPush(tokens, payload);
  return { recipients: list.length, ...push };
}

/** Push vers tous les tokens d'un rôle (annonces). */
async function notifyRole(role, payload) {
  const tokens = await getTokensForRole(role);
  return sendPush(tokens, payload);
}

/** Alerte admin (in-app + push, JAMAIS d'email). */
async function notifyAdmins(payload) {
  const uids = await getAdminUids();
  return notifyUids(uids, { ...payload, recipientRole: 'admin' });
}

/** Alerte vendeur. */
async function notifyVendor(uid, payload) {
  if (!uid) return { recipients: 0 };
  return notifyUids([uid], { ...payload, recipientRole: 'seller' });
}

/** Alerte client. */
async function notifyClient(uid, payload) {
  if (!uid) return { recipients: 0 };
  return notifyUids([uid], { ...payload, recipientRole: 'client' });
}

/**
 * Verrou anti-doublon : une seule annonce par clé sur `ttlHours`.
 * @returns {Promise<boolean>} true si l'envoi est autorisé
 */
async function claimOnce(key, ttlHours = 24) {
  if (!key) return true;
  const ref = db.collection('meta').doc(`notif_${key}`.slice(0, 1400));
  try {
    const snap = await ref.get();
    const until = snap.exists ? Number(snap.data().until || 0) : 0;
    if (until > Date.now()) return false;
    await ref.set({
      until: Date.now() + ttlHours * 3600000,
      at: FieldValue.serverTimestamp()
    });
    return true;
  } catch (error) {
    return true;
  }
}

module.exports = {
  db,
  moroccoStamp,
  mad,
  createInApp,
  getAdminUids,
  getTokensForUids,
  getTokensForRole,
  sendPush,
  notifyUids,
  notifyRole,
  notifyAdmins,
  notifyVendor,
  notifyClient,
  claimOnce
};
