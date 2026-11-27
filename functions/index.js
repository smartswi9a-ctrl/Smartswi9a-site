const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten, onDocumentUpdated, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, FieldPath, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getMessaging } = require('firebase-admin/messaging');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

initializeApp();
const db = getFirestore();
const PROJECT_ID = 'smartswi9a-31063';

const ALLOWED_ORIGINS = new Set([
  'https://smartswika.ma',
  'https://www.smartswika.ma',
  'https://smartswi9a.top',
  'https://www.smartswi9a.top',
  'https://smartswi9a-31063.web.app',
  'https://smartswi9a-31063.firebaseapp.com'
]);

/* ============================================================
   CONSTANTES GLOBALES
   ============================================================
   - LIVO_API_BASE : endpoint public Livo
   - RETURN_FEE_LIVO : valeur historique conservée uniquement pour reconstruire
     les contrats 1.1.0 à 1.3.0 ; aucun débit de retour ne l'utilise.
   - FALLBACK_DELIVERY_FEE : frais par défaut si Firestore vide
   - LIVO_DEPOT_KEYS : entrepôts Livo à exclure des villes clients
   - LOGIN_* : throttle login vendeur
   ============================================================ */
const LIVO_API_BASE = 'https://rest.livo.ma';
const LIVO_FEES_ENDPOINT = '/fees/public';
const LIVO_FEES_CACHE_HOURS = 24;
const LIVO_FEES_FETCH_TIMEOUT_MS = 10000;
const LIVO_FEES_CACHE_DOC = 'livo_fees_cache';
const LIVO_FEES_META_COLLECTION = 'meta';
const LIVO_WEBHOOK_SECRET = defineSecret('LIVO_WEBHOOK_SECRET');
const LIVO_WEBHOOK_MAX_CLOCK_SKEW_SECONDS = 300;
const LIVO_WEBHOOK_EVENT_COLLECTION = 'livo_webhook_events';
const LIVO_WEBHOOK_ALLOWED_EVENTS = new Set([
  'order.created', 'order.status_changed', 'order.return_status_changed',
  'pickup.created', 'pickup.status_changed',
  'return.created', 'return.status_changed', 'message.created', 'ping'
]);

const FALLBACK_DELIVERY_FEE = 30;

const LIVO_DEPOT_KEYS = new Set(['livo depot', 'livo depot casablanca']);

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;

/* ============================================================
   SNAPSHOT CONTRAT OFFICIEL (B-C1)
   ============================================================
   DOIT être synchronisé avec CONFIG.VENDOR dans js/config.js.
   Si tu modifies CONFIG.VENDOR côté client, tu DOIS modifier
   ces valeurs ici, sinon tous les nouveaux contrats échoueront
   avec "Falsification détectée".
   ============================================================ */
const OFFICIAL_VENDOR_CONFIG = {
  CONTRACT_VERSION: '1.6.0',
  COMMISSION_RATE: 0.07,
  COMMISSION_RATE_MIN: 0.05,
  COMMISSION_RATE_MAX: 0.15,
  DROPOFF_DEADLINE_HOURS_NEW: 72,
  DROPOFF_DEADLINE_HOURS_ESTABLISHED: 48,
  UNLOCK_DAYS_VENDOR: 7,
  UNLOCK_DAYS_SMART: 15,
  MIN_WITHDRAWAL: 200,
  RETURN_FEE_LIVO: 20
};

function buildOfficialSnapshot() {
  return {
    version: OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION,
    commissionRate: OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE,
    commissionRateMin: OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE_MIN,
    commissionRateMax: OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE_MAX,
    dropoffDeadlineHoursNew: OFFICIAL_VENDOR_CONFIG.DROPOFF_DEADLINE_HOURS_NEW,
    dropoffDeadlineHoursEstablished: OFFICIAL_VENDOR_CONFIG.DROPOFF_DEADLINE_HOURS_ESTABLISHED,
    unlockDaysVendor: OFFICIAL_VENDOR_CONFIG.UNLOCK_DAYS_VENDOR,
    unlockDaysSmart: OFFICIAL_VENDOR_CONFIG.UNLOCK_DAYS_SMART,
    minWithdrawal: OFFICIAL_VENDOR_CONFIG.MIN_WITHDRAWAL,
    returnFeeLivo: OFFICIAL_VENDOR_CONFIG.RETURN_FEE_LIVO,
    returnFeeSpeedaf: OFFICIAL_VENDOR_CONFIG.RETURN_FEE_LIVO
  };
}

/* ============================================================
   HELPERS FINANCIERS (chrono 7/15 jours + statut portefeuille)
   ============================================================ */

/**
 * Statuts du portefeuille vendeur.
 * - active    : retraits autorises.
 * - frozen    : litige ouvert, retraits bloques, fonds conserves.
 * - suspended : solde debiteur (dette de frais de retour), retraits bloques.
 */
const WALLET_STATUS = Object.freeze({
  ACTIVE: 'active',
  FROZEN: 'frozen',
  SUSPENDED: 'suspended'
});

const WALLET_STATUS_VALUES = new Set(Object.values(WALLET_STATUS));

/**
 * Lit le statut portefeuille d'un profil vendeur.
 * Le champ vit sur le profil (users/{uid}.wallet_status), jamais sur le wallet,
 * car les regles Firestore interdisent au vendeur d'ecrire dans wallets/.
 * Absence de champ => 'active' (compatibilite avec les comptes existants).
 */
function normalizeWalletStatus(vendorData) {
  const raw = vendorData && vendorData.wallet_status;
  const value = String(raw || '').trim().toLowerCase();
  return WALLET_STATUS_VALUES.has(value) ? value : WALLET_STATUS.ACTIVE;
}

/**
 * CIN marocaine : 1 a 3 lettres suivies de 4 a 8 chiffres (ex : AB123456,
 * EE105603). Retourne true si le format est valide.
 */
function isValidMoroccanCin(value) {
  return /^[A-Z]{1,3}\d{4,8}$/.test(String(value || '').trim().toUpperCase());
}

/**
 * Normalise un numero de telephone marocain : supprime espaces, points et
 * tirets, convertit le prefixe +212 en 0. Retourne le numero normalise
 * (ex : '0612345678') ou null si le format final n'est pas 06/07 + 8 chiffres.
 */
function normalizeMoroccanPhone(value) {
  let raw = String(value || '').replace(/[\s.\-()]/g, '');
  if (raw.startsWith('+212')) raw = '0' + raw.slice(4);
  else if (raw.startsWith('00212')) raw = '0' + raw.slice(5);
  else if (raw.startsWith('212') && raw.length === 12) raw = '0' + raw.slice(3);
  return /^(?:0)[67]\d{8}$/.test(raw) ? raw : null;
}

/**
 * Date de disponibilite des fonds = base + delai de garantie.
 * La base est la prise en charge du colis par Livo (trackingStartedAt),
 * jamais la date de commande.
 */
function addDaysToDate(date, days) {
  const base = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(base.getTime())) return null;
  const result = new Date(base.getTime());
  result.setUTCDate(result.getUTCDate() + Number(days));
  return result;
}

/**
 * Determine la date d'ancrage du chrono et le delai applicable.
 *
 * Regle : 15 jours UNIQUEMENT si un article porte explicitement
 * isSmartSwika: true, sans condition sur le vendorId (le vendeur
 * 'smartswi9a' est le vendeur par defaut de la plateforme).
 * Par defaut on retombe sur 7 jours (vendeur).
 *
 * @returns {{ok: true, date: Date, unlockDays: number, scope: string}|{ok: false, reason: string}}
 */
function resolveCreditUnlockBase(order) {
  if (!order || typeof order !== 'object') {
    return { ok: false, reason: 'commande absente' };
  }

  // Ancrage principal : prise en charge reelle par Livo.
  // Fallback documente : si la commande a ete livree sans que le moindre
  // evenement de tracking n'ait ete enregistre (webhook perdu, transition de
  // statut manuelle, import historique), on ancre sur createdAt puis updatedAt.
  // Un warning est emis pour rendre le cas visible dans les logs.
  const toDateOrNull = (value) => {
    if (!value) return null;
    const parsed = value.toDate ? value.toDate() : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  let date = toDateOrNull(order.trackingStartedAt);
  let anchoredFrom = 'trackingStartedAt';

  if (!date) {
    date = toDateOrNull(order.createdAt) || toDateOrNull(order.updatedAt);
    anchoredFrom = date ? (toDateOrNull(order.createdAt) ? 'createdAt' : 'updatedAt') : null;
    if (date) {
      const orderId = order.id || order.slug || '(sans id)';
      console.warn(
        '[resolveCreditUnlockBase] trackingStartedAt absent, ancrage de secours sur ' +
        anchoredFrom + ' pour la commande ' + orderId
      );
    }
  }

  if (!date) {
    return { ok: false, reason: 'trackingStartedAt absent et aucune date de repli (createdAt/updatedAt)' };
  }

  const items = Array.isArray(order.items) ? order.items : [];
  // 15 jours des qu'un article est marque isSmartSwika: true, quel que soit
  // le vendorId. Le vendeur 'smartswi9a' est le vendeur par defaut de la
  // plateforme : l'exclure annulait le marqueur sur ses propres produits.
  const hasSmartSwika = items.some(item =>
    item && item.isSmartSwika === true
  );

  const unlockDays = hasSmartSwika
    ? OFFICIAL_VENDOR_CONFIG.UNLOCK_DAYS_SMART
    : OFFICIAL_VENDOR_CONFIG.UNLOCK_DAYS_VENDOR;

  return {
    ok: true,
    date,
    unlockDays,
    scope: hasSmartSwika ? 'smart' : 'vendor'
  };
}

/* ============================================================
   HELPERS GÉNÉRAUX
   ============================================================ */
function cors(req, res) {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return true; }
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ success: false, message: 'Méthode non autorisée.' });
    return true;
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    res.status(403).json({ success: false, message: 'Origine non autorisée.' });
    return true;
  }
  return false;
}

function validPassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length <= 128 && /[A-Za-z]/.test(p) && /\d/.test(p);
}
function validEmail(e) {
  return typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

async function findUserByEmail(email) {
  const snap = await db.collection('users').where('email', '==', email).limit(2).get();
  if (snap.empty) return null;
  if (snap.size > 1) throw new Error('Plusieurs profils utilisent cette adresse.');
  return { uid: snap.docs[0].id, data: snap.docs[0].data() };
}

function approved(profile) {
  return profile && profile.role === 'vendor' && profile.vendorInfo &&
    profile.vendorInfo.status === 'approved' &&
    profile.vendorInfo.contractStatus === 'accepted' &&
    String(profile.vendorInfo.contractVersion || '') === OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION;
}

function statusMessage(profile) {
  const status = profile?.vendorInfo?.status;
  if (status === 'pending') return 'Votre demande vendeur est en attente de validation.';
  if (status === 'rejected') return 'Votre demande vendeur a été refusée.';
  if (status === 'suspended') return 'Votre accès vendeur est suspendu.';
  if (status === 'approved') return 'Votre contrat vendeur doit être accepté avant l’accès au tableau de bord.';
  return 'Ce compte ne dispose pas d’un accès vendeur approuvé.';
}

/* ============================================================
   HELPERS CACHE LIVO
   ============================================================ */
async function getLivoFeesCacheMeta() {
  const snap = await db.collection(LIVO_FEES_META_COLLECTION).doc(LIVO_FEES_CACHE_DOC).get();
  return snap.exists ? snap.data() : null;
}

async function isLivoFeesCacheFresh() {
  const meta = await getLivoFeesCacheMeta();
  if (!meta || !meta.updatedAt) return false;
  const updatedAt = meta.updatedAt.toDate ? meta.updatedAt.toDate() : new Date(meta.updatedAt);
  const ageHours = (Date.now() - updatedAt.getTime()) / 3600000;
  return ageHours < LIVO_FEES_CACHE_HOURS;
}

function normalizeCityKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* ============================================================
   VENTE FLASH (audit 2026-11-16) — HELPERS SERVEUR
   ------------------------------------------------------------
   Recalcul du prix remise cote serveur. Le client ne doit jamais
   pouvoir imposer un prix : `price` vient de son panier, donc on
   reapplique la remise officielle ici.

   Regles bornees (identiques a js/flash-sales.js, testees par
   tests/flash-sales.test.cjs) :
     - une remise ne rend jamais le prix negatif ;
     - une remise ne depasse jamais le prix initial ;
     - un pourcentage > 100 est borne a 100 ;
     - une vente hors fenetre ou epuisee n est pas appliquee.

   NOTE : pas d apostrophe dans ce bloc (voir README, regle 2).
   ============================================================ */

function isFlashSaleLiveServer(sale, nowMs) {
  if (!sale || sale.status !== 'active') return false;
  const toMs = (v) => {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (v instanceof Date) return v.getTime();
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  };
  const start = toMs(sale.startsAt);
  const end = toMs(sale.endsAt);
  if (start == null || end == null) return false;
  if (nowMs < start || nowMs > end) return false;
  if (sale.maxQuantity != null && Number(sale.soldCount || 0) >= Number(sale.maxQuantity)) {
    return false;
  }
  return true;
}

function applyServerFlashPrice(price, sale, nowMs = Date.now()) {
  const base = Math.max(0, Number(price) || 0);
  if (!isFlashSaleLiveServer(sale, nowMs)) {
    return { finalPrice: base, discount: 0, percent: 0 };
  }
  const value = Math.max(0, Number(sale.discountValue) || 0);
  let discount;
  if (sale.discountType === 'percent') {
    discount = Math.round((base * Math.min(value, 100)) / 100);
  } else {
    discount = Math.min(Math.round(value), base);
  }
  const finalPrice = Math.max(0, base - discount);
  const percent = base > 0 ? Math.round((discount / base) * 100) : 0;
  return { finalPrice, discount, percent };
}

/* ============================================================
   KOULCHI DIALK (K3) - BAREME SERVEUR
   ------------------------------------------------------------
   Doit rester IDENTIQUE a js/koulchi.js (source de verite client).
   tests/koulchi-server.test.cjs compare les deux fichiers et echoue
   si les bornes ou les paliers divergent.
   Le serveur ne recoit jamais un prix du client : il relit
   product.koulchiPrice dans la transaction et recalcule.
   ============================================================ */
const KOULCHI_MIN_ITEMS = 3;
const KOULCHI_MAX_ITEMS = 10;
const KOULCHI_TIERS = [
  { min: 9, percent: 15 },
  { min: 6, percent: 10 },
  { min: 3, percent: 5 }
];

function getKoulchiPercentServer(itemCount) {
  const n = Math.floor(Number(itemCount) || 0);
  if (n < KOULCHI_MIN_ITEMS) return 0;
  for (const tier of KOULCHI_TIERS) {
    if (n >= tier.min) return tier.percent;
  }
  return 0;
}


/* ============================================================
   CORRECTIF C3 (audit 2026-11-16) — RAPPROCHEMENT TOLERANT DES VILLES
   ------------------------------------------------------------
   Livo renvoie des libelles qui varient d une synchronisation a une autre :
     "sidi sliman"             vs  "sidi slimane"     (doc historique)
     "ajdir al hoceima"        vs  "ajdir"
     "bni bouayach al hoceima" vs  "bni bouayach"
   Avec une egalite stricte sur normalizeCityKey, ces variantes ne
   matchaient pas le document existant : syncLivoCitiesFromApi CREAIT un
   second document au lieu de mettre a jour, laissant deux prix pour la
   meme ville. utils.js retenant le premier par id, c est l ancien tarif
   qui s affichait (sous-facturation).

   Trois passes, de la plus stricte a la plus permissive :
     1. cle exacte normalisee
     2. cle agressive (tout sauf [a-z0-9] supprime)
     3. prefixe, borne : l une prefixe de l autre, chacune >= 8 chars
        et rapport de longueur >= 0.75, pour ne pas fusionner des
        villes reellement distinctes (bir jdid / bir rami, ksar el
        kebir / ksar sghir, oued jdida / oued laou).

   Au niveau module : testable sans Firestore
   (tests/livo-city-matching.test.cjs) et non recree a chaque appel.
   NOTE : pas d apostrophe dans ce bloc. Le test livo-webhook-sim extrait
   du code par comptage de quotes et ne sait pas ignorer les commentaires ;
   une apostrophe ici decalerait son extraction.
   ============================================================ */
const MIN_CITY_PREFIX = 8;

function looseCityKey(raw) {
  return normalizeCityKey(raw).replace(/[^a-z0-9]/g, '');
}

/* index = { byKey: Map, byLoose: Map, list: [{ loose, entry }] } */
function findExistingCity(index, livoKey) {
  if (!index) return null;

  const strict = index.byKey.get(livoKey);
  if (strict) return strict;

  const loose = looseCityKey(livoKey);
  if (!loose) return null;

  const byLoose = index.byLoose.get(loose);
  if (byLoose) return byLoose;

  if (loose.length >= MIN_CITY_PREFIX) {
    let best = null;
    for (const cand of index.list) {
      if (cand.loose.length < MIN_CITY_PREFIX) continue;
      if (!(loose.startsWith(cand.loose) || cand.loose.startsWith(loose))) continue;
      const shorter = Math.min(loose.length, cand.loose.length);
      const longer = Math.max(loose.length, cand.loose.length);
      if (shorter / longer < 0.75) continue;
      if (!best || cand.loose.length > best.loose.length) best = cand;
    }
    if (best) return best.entry;
  }

  return null;
}


async function fetchLivoFeesFromApi() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVO_FEES_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${LIVO_API_BASE}${LIVO_FEES_ENDPOINT}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Livo API HTTP ${res.status}`);
    const json = await res.json();
    const data = json?.data?.data || json?.data || null;
    if (!data || !Array.isArray(data.order_fees)) {
      throw new Error('Format de réponse Livo invalide (order_fees manquant).');
    }
    return {
      requestDate: String(data.request_date || new Date().toISOString()),
      cities: data.order_fees.map(item => ({
        city: normalizeCityKey(item.city),
        fee: Number(item.fee) || 0
      })).filter(c => c.city && c.fee > 0 && !LIVO_DEPOT_KEYS.has(c.city))
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function syncLivoCitiesFromApi(options = {}) {
  const { preserveCustom = false, preserveReferenced = true } = options;
  const purgeReferencedGuard = preserveReferenced === true;

  /* CORRECTIF C11 : ids de villes encore references par une commande.
     Garde-fou avant toute suppression (desactivable via preserveReferenced). */
  const referencedCityIds = new Set();
  if (purgeReferencedGuard) {
    try {
      const ordersSnap = await db.collection('orders').select('delivery').limit(2000).get();
      ordersSnap.docs.forEach(o => {
        const dv = (o.data() || {}).delivery || {};
        if (dv.cityId != null && String(dv.cityId) !== '') referencedCityIds.add(String(dv.cityId));
      });
    } catch (e) {
      console.warn('[syncLivoCities] lecture orders pour garde-fou impossible:', e.message);
    }
  }

  const { requestDate, cities } = await fetchLivoFeesFromApi();

  if (!cities.length) throw new Error('Livo a retourné 0 ville.');

  const existingSnap = await db.collection('cities').get();
  const existingByKey = new Map();
  let maxExistingId = 0;

  /* CORRECTIF C3 (audit 2026-11-16) : index de rapprochement TOLERANT.
     Livo renvoie des libelles qui varient d une synchronisation a une autre
     ("sidi sliman" vs "sidi slimane", "ajdir al hoceima" vs "ajdir",
     "bni bouayach al hoceima" vs "bni bouayach"). Avec une comparaison
     stricte sur normalizeCityKey, ces variations ne matchaient pas
     le document existant : le sync CREAIT un second document au lieu de mettre a
     jour, laissant deux prix pour la meme ville.

     Les helpers looseCityKey / findExistingCity sont declares au niveau
     module (voir plus bas, a cote de normalizeCityKey) pour rester
     testables et ne pas recreer de fonction a chaque synchronisation. */
  const existingByLoose = new Map();   // cle agressive -> doc
  const existingByLooseList = [];      // [{ loose, entry }] pour les prefixes

  existingSnap.docs.forEach(d => {
    const data = d.data();
    const key = normalizeCityKey(data.key || data.nameFr || '');
    const loose = looseCityKey(data.key || data.nameFr || '');
    const entry = { id: d.id, data, loose };
    if (key) existingByKey.set(key, entry);
    if (loose) {
      if (!existingByLoose.has(loose)) existingByLoose.set(loose, entry);
      existingByLooseList.push({ loose, entry });
    }
    const existingId = Number(data.id) || 0;
    if (existingId > maxExistingId) maxExistingId = existingId;
  });

  const cityIndex = { byKey: existingByKey, byLoose: existingByLoose, list: existingByLooseList };

  // Anti-collision ID
  let nextId = maxExistingId + 1;

  const BATCH_SIZE = 400;
  let synced = 0, created = 0, updated = 0;

  const allCities = cities.map(c => ({
    ...c,
    displayName: c.city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  }));

  // P2-7 : grille publique pre-calculee, ecrite dans meta/livo_fees_cache.
  // Evite de relire jusqu'a 500 documents cities a chaque getLivoFees.
  const gridByKey = new Map();

  for (let i = 0; i < allCities.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = allCities.slice(i, i + BATCH_SIZE);

    chunk.forEach(c => {
      const existing = findExistingCity(cityIndex, c.city);
      const docId = existing?.id || `city_${c.city.replace(/\s+/g, '_')}`;
      const ref = db.collection('cities').doc(docId);

      if (existing) {
        batch.update(ref, {
          price: c.fee,
          lastSyncedFromLivo: FieldValue.serverTimestamp()
        });
        updated++;
        gridByKey.set(c.city, {
          id: Number(existing.data.id) || 0,
          key: c.city,
          nameFr: existing.data.nameFr || c.displayName,
          nameEn: existing.data.nameEn || c.displayName,
          nameAr: existing.data.nameAr || c.displayName,
          price: c.fee,
          delay: existing.data.delay || '48h',
          fromLivo: true
        });
      } else {
        const assignedId = nextId++;
        batch.set(ref, {
          id: assignedId,
          key: c.city,
          nameFr: c.displayName,
          nameEn: c.displayName,
          nameAr: c.displayName,
          price: c.fee,
          delay: '48h',
          source: 'livo',
          lastSyncedFromLivo: FieldValue.serverTimestamp()
        });
        created++;
        gridByKey.set(c.city, {
          id: assignedId,
          key: c.city,
          nameFr: c.displayName,
          nameEn: c.displayName,
          nameAr: c.displayName,
          price: c.fee,
          delay: '48h',
          fromLivo: true
        });
      }
      synced++;
    });
    await batch.commit();
  }

  // Suppression des villes obsolètes
  // ------------------------------------------------------------
  // CORRECTIF C3-bis (audit 2026-11-16) : ce bloc supprimait tout document
  // dont la cle ne correspondait pas EXACTEMENT a la grille Livo, y compris les
  // documents LEGACY (source absente, ex. `lahraouiyine`, `sidi slimane`).
  // Or une commande existante peut referencer ces documents par leur id
  // numerique : createCustomerOrder fait
  //   db.collection('cities').doc(String(delivery.cityId))
  // et refuse la commande si le document a disparu.
  //
  // On ne supprime donc que les documents reellement crees par Livo
  // (source === 'livo' ET presents dans `existingByKey` via notre index
  // tolerant). Les documents historiques sont CONSERVES : ils seront
  // simplement mis a jour au prix Livo si les deux correspondent, ou laisses tels quels sinon.
  // desservie, ou laisses tels quels sinon.
  let deleted = 0;
  if (!preserveCustom) {
    const matchedRefs = new Set();
    for (const c of cities) {
      const entry = findExistingCity(cityIndex, c.city);
      if (entry) matchedRefs.add(entry.id);
    }

    const toDelete = [];
    existingSnap.docs.forEach(d => {
      const data = d.data();
      if (data.source === 'manual') return;

      /* Ne supprimer que les doublons Livo non apparies : un document
         Livo qui a servi de cible (matchedRefs) est conserve. */
      if (matchedRefs.has(d.id)) return;

      /* CORRECTIF C11 (2026-11-16) : decision produit -> le site ne doit
         proposer QUE les villes desservees par Livo. Les documents
         historiques (source absente) sont desormais purges EUX AUSSI,
         au lieu d etre conserves indefiniment.
         `matchedRefs` couvre deja les villes historiques reconnues par
         l index tolerant (sidi slimane, souk el arbaa, errahma...) : elles
         sont mises a jour, pas supprimees.
         Garde-fou : si `preserveReferenced` est vrai, on conserve en plus
         tout document encore reference par une commande. */
      if (purgeReferencedGuard && referencedCityIds.has(String(data.id))) return;

      toDelete.push(d.ref);
    });

    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const batch = db.batch();
      toDelete.slice(i, i + BATCH_SIZE).forEach(ref => batch.delete(ref));
      await batch.commit();
      deleted += Math.min(BATCH_SIZE, toDelete.length - i);
    }
  }

  await db.collection(LIVO_FEES_META_COLLECTION).doc(LIVO_FEES_CACHE_DOC).set({
    updatedAt: FieldValue.serverTimestamp(),
    citiesCount: cities.length,
    cityKeys: cities.map(city => city.city),
    publicGrid: allCities
      .map(c => gridByKey.get(c.city))
      .filter(Boolean)
      .sort((a, b) => a.id - b.id),
    requestDate,
    source: 'livo',
    created, updated, deleted
  }, { merge: true });

  return { synced, created, updated, deleted, requestDate, citiesCount: cities.length };
}

/* ============================================================
   HELPERS THROTTLE LOGIN VENDEUR
   ============================================================ */
function throttleId(email) {
  // Cle basee sur l email uniquement : une IP issue d en-tetes client
  // (X-Forwarded-For) est falsifiable et permettait de contourner le
  // compteur en la faisant varier a chaque tentative.
  return crypto.createHash('sha256').update(`email|${email}`).digest('hex');
}

async function isLoginThrottled(email) {
  const ref = db.collection('vendorLoginThrottle').doc(throttleId(email));
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data();
  const now = Date.now();
  if (data.windowStartedAt && now - data.windowStartedAt > LOGIN_WINDOW_MS) {
    await ref.delete().catch(() => {});
    return false;
  }
  return Number(data.failures || 0) >= LOGIN_MAX_FAILURES;
}

async function recordLoginFailure(email, ip) {
  // ip conservee a titre d audit uniquement, jamais utilisee dans la cle
  const ref = db.collection('vendorLoginThrottle').doc(throttleId(email));
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data() : {};
    const inWindow = data.windowStartedAt && now - data.windowStartedAt <= LOGIN_WINDOW_MS;
    tx.set(ref, {
      email, ip: String(ip || 'unknown').slice(0, 80),
      failures: inWindow ? Number(data.failures || 0) + 1 : 1,
      windowStartedAt: inWindow ? data.windowStartedAt : now,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
}

async function clearLoginFailures(email) {
  await db.collection('vendorLoginThrottle').doc(throttleId(email)).delete().catch(() => {});
}

/* ============================================================
   TEMPLATES CONTRAT (Reproduction stricte côté serveur)
   ============================================================ */
function getContractText(lang, version, snapshot) {
  const templates = {
    "1.1.0": {
      fr: (t) => `CONTRAT DE PARTENARIAT VENDEUR — SMART SWI9A\nVersion ${t.version}\n\nArticle 1 — Objet\nLe présent contrat encadre la mise en vente de produits par le Vendeur sur la plateforme Smart Swi9a (smartswi9a.top), marketplace marocaine d'appareils connectés et de produits pour la maison.\n\nArticle 2 — Inscription et vérification\nLe Vendeur s'engage à fournir des informations exactes (nom de boutique, téléphone, ville, ICE ou CIN). Toute fausse déclaration entraîne la suspension immédiate du compte.\n\nArticle 3 — Commission\nSmart Swi9a prélève une commission de ${(t.commissionRate * 100).toFixed(0)} % sur le montant hors livraison de chaque vente. Cette commission peut être ajustée entre ${(t.commissionRateMin * 100).toFixed(0)} % et ${(t.commissionRateMax * 100).toFixed(0)} % avec l'accord écrit du Vendeur.\n\nArticle 4 — Expédition\nLe Vendeur choisit le dépôt en agence (drop-off) ou la logistique Smart Swi9a (fulfillment). Les délais de dépôt sont de ${t.dropoffDeadlineHoursNew} heures (nouveaux comptes) ou ${t.dropoffDeadlineHoursEstablished} heures (comptes matures). Tout retard peut entraîner une suspension.\n\nArticle 5 — Paiement\nLes gains sont crédités sur le portefeuille vendeur et deviennent disponibles ${t.unlockDaysVendor} jours après livraison confirmée (${t.unlockDaysSmart} jours pour les produits Smart Swi9a). Le retrait minimum est de ${t.minWithdrawal} MAD.\n\nArticle 6 — Retours\nEn cas de retour, des frais de ${t.returnFeeSpeedaf} MAD sont prélevés par colis retourné. Les retours répétés peuvent entraîner une révision du statut du Vendeur.\n\nArticle 7 — Résiliation\nChaque partie peut résilier ce contrat à tout moment. Les commandes en cours restent soumises aux présentes conditions.\n\nArticle 8 — Loi applicable\nLe présent contrat est régi par le droit marocain. Tout litige relève des tribunaux de Casablanca.\n\nArticle 9 — Signature électronique\nLa signature électronique vaut acceptation pleine et entière. L'IP, le user-agent, la date serveur et un hash SHA-256 du présent document sont enregistrés à titre de preuve.\n\nEn signant, le Vendeur reconnaît avoir lu et compris l'intégralité du présent contrat.`,
      ar: (t) => `عقد شراكة البائع — سمارت سويقة\nالإصدار ${t.version}\n\nالمادة 1 — الموضوع\nينظم هذا العقد عرض البائع لمنتجاته للبيع على منصة سمارت سويقة (smartswi9a.top)، وهي سوق مغربية للأجهزة المتصلة ومنتجات المنزل.\n\nالمادة 2 — التسجيل والتحقق\nيلتزم البائع بتقديم معلومات صحيحة (اسم المتجر، الهاتف، المدينة، ICE أو CIN). أي تصريح كاذب يؤدي إلى تعليق الحساب فوراً.\n\nالمادة 3 — العمولة\nتقتطع سمارت سويقة عمولة قدرها ${(t.commissionRate * 100).toFixed(0)}% على مبلغ كل عملية بيع دون احتساب التوصيل. يمكن تعديل هذه العمولة بين ${(t.commissionRateMin * 100).toFixed(0)}% و${(t.commissionRateMax * 100).toFixed(0)}% بموافقة كتابية من البائع.\n\nالمادة 4 — الشحن\nيختار البائع الإيداع في الوكالة (drop-off) أو لوجستيك سمارت سويقة (fulfillment). مهل الإيداع هي ${t.dropoffDeadlineHoursNew} ساعة (الحسابات الجديدة) أو ${t.dropoffDeadlineHoursEstablished} ساعة (الحسابات الناضجة). أي تأخير قد يؤدي إلى تعليق الحساب.\n\nالمادة 5 — الدفع\nتُضاف الأرباح إلى محفظة البائع وتصبح متاحة بعد ${t.unlockDaysVendor} أيام من تأكيد التسليم (${t.unlockDaysSmart} يوماً لمنتجات سمارت سويقة). الحد الأدنى للسحب هو ${t.minWithdrawal} درهم.\n\nالمادة 6 — الإرجاع\nفي حالة الإرجاع، تُخصم رسوم قدرها ${t.returnFeeSpeedaf} درهماً لكل طرد مُرجع. الإرجاعات المتكررة قد تؤدي إلى مراجعة وضع البائع.\n\nالمادة 7 — الإنهاء\nيمكن لأي طرف إنهاء هذا العقد في أي وقت. تبقى الطلبات الجارية خاضعة لهذه الشروط.\n\nالمادة 8 — القانون المطبق\nيخضع هذا العقد للقانون المغربي. يختص القضاء في الدار البيضاء بأي نزاع.\n\nالمادة 9 — التوقيع الإلكتروني\nالتوقيع الإلكتروني يعتبر قبولاً تاماً وصريحاً. يتم تسجيل عنوان IP، ووكيل المستخدم، وتاريخ الخادم، وبصمة SHA-256 لهذا المستند كدليل.\n\nبالتوقيع، يقر البائع بأنه قرأ وفهم كامل هذا العقد.`,
      en: (t) => `VENDOR PARTNERSHIP AGREEMENT — SMART SWI9A\nVersion ${t.version}\n\nArticle 1 — Purpose\nThis agreement governs the listing and sale of products by the Vendor on Smart Swi9a (smartswi9a.top), a Moroccan marketplace for connected devices and home products.\n\nArticle 2 — Registration and verification\nThe Vendor agrees to provide accurate information (shop name, phone, city, ICE or CIN). Any false statement results in immediate account suspension.\n\nArticle 3 — Commission\nSmart Swi9a charges a ${(t.commissionRate * 100).toFixed(0)}% commission on the delivery-excluded amount of each sale. This commission may be adjusted between ${(t.commissionRateMin * 100).toFixed(0)}% and ${(t.commissionRateMax * 100).toFixed(0)}% with the Vendor's written consent.\n\nArticle 4 — Shipping\nThe Vendor chooses agency drop-off or Smart Swi9a fulfillment. Drop-off deadlines are ${t.dropoffDeadlineHoursNew} hours (new accounts) or ${t.dropoffDeadlineHoursEstablished} hours (mature accounts). Any delay may result in suspension.\n\nArticle 5 — Payment\nEarnings are credited to the vendor wallet and become available ${t.unlockDaysVendor} days after confirmed delivery (${t.unlockDaysSmart} days for Smart Swi9a products). Minimum withdrawal is ${t.minWithdrawal} MAD.\n\nArticle 6 — Returns\nIn case of return, a ${t.returnFeeSpeedaf} MAD fee is charged per returned parcel. Repeated returns may lead to a review of the Vendor's status.\n\nArticle 7 — Termination\nEither party may terminate this agreement at any time. Pending orders remain subject to these terms.\n\nArticle 8 — Governing law\nThis agreement is governed by Moroccan law. Any dispute falls under the jurisdiction of the courts of Casablanca.\n\nArticle 9 — Electronic signature\nThe electronic signature constitutes full acceptance. The IP, user-agent, server date, and a SHA-256 hash of this document are recorded as evidence.\n\nBy signing, the Vendor acknowledges having read and understood this entire agreement.`
    },
    "1.2.0": {
      fr: (t) => `CONTRAT DE PARTENARIAT VENDEUR — SMART SWI9A\nVersion ${t.version}\n\nArticle 1 — Objet\nLe présent contrat encadre la mise en vente de produits par le Vendeur sur la plateforme Smart Swi9a (smartswi9a.top), marketplace marocaine d'appareils connectés et de produits pour la maison.\n\nArticle 2 — Inscription et vérification\nLe Vendeur s'engage à fournir des informations exactes (nom de boutique, téléphone, ville, ICE ou CIN). Toute fausse déclaration entraîne la suspension immédiate du compte.\n\nArticle 3 — Commission\nSmart Swi9a prélève une commission de ${(t.commissionRate * 100).toFixed(0)} % sur le montant hors livraison de chaque vente. Cette commission peut être ajustée entre ${(t.commissionRateMin * 100).toFixed(0)} % et ${(t.commissionRateMax * 100).toFixed(0)} % avec l'accord écrit du Vendeur.\n\nArticle 4 — Expédition\nLe Vendeur choisit le dépôt en agence (drop-off) ou la logistique Smart Swi9a (fulfillment). Les délais de dépôt sont de ${t.dropoffDeadlineHoursNew} heures (nouveaux comptes) ou ${t.dropoffDeadlineHoursEstablished} heures (comptes matures). Tout retard peut entraîner une suspension.\n\nArticle 5 — Paiement\nLes gains sont crédités sur le portefeuille vendeur et deviennent disponibles ${t.unlockDaysVendor} jours après livraison confirmée (${t.unlockDaysSmart} jours pour les produits Smart Swi9a). Le retrait minimum est de ${t.minWithdrawal} MAD.\n\nArticle 6 — Retours\nEn cas de retour, des frais de ${t.returnFeeLivo} MAD sont prélevés par colis retourné (frais facturés par notre partenaire logistique Livo). Les retours répétés peuvent entraîner une révision du statut du Vendeur.\n\nArticle 7 — Résiliation\nChaque partie peut résilier ce contrat à tout moment. Les commandes en cours restent soumises aux présentes conditions.\n\nArticle 8 — Loi applicable\nLe présent contrat est régi par le droit marocain. Tout litige relève des tribunaux de Casablanca.\n\nArticle 9 — Signature électronique\nLa signature électronique vaut acceptation pleine et entière. L'IP, le user-agent, la date serveur et un hash SHA-256 du présent document sont enregistrés à titre de preuve.\n\nEn signant, le Vendeur reconnaît avoir lu et compris l'intégralité du présent contrat.`,
      ar: (t) => `عقد شراكة البائع — سمارت سويقة\nالإصدار ${t.version}\n\nالمادة 1 — الموضوع\nينظم هذا العقد عرض البائع لمنتجاته للبيع على منصة سمارت سويقة (smartswi9a.top)، وهي سوق مغربية للأجهزة المتصلة ومنتجات المنزل.\n\nالمادة 2 — التسجيل والتحقق\nيلتزم البائع بتقديم معلومات صحيحة (اسم المتجر، الهاتف، المدينة، ICE أو CIN). أي تصريح كاذب يؤدي إلى تعليق الحساب فوراً.\n\nالمادة 3 — العمولة\nتقتطع سمارت سويقة عمولة قدرها ${(t.commissionRate * 100).toFixed(0)}% على مبلغ كل عملية بيع دون احتساب التوصيل. يمكن تعديل هذه العمولة بين ${(t.commissionRateMin * 100).toFixed(0)}% و${(t.commissionRateMax * 100).toFixed(0)}% بموافقة كتابية من البائع.\n\nالمادة 4 — الشحن\nيختار البائع الإيداع في الوكالة (drop-off) أو لوجستيك سمارت سويقة (fulfillment). مهل الإيداع هي ${t.dropoffDeadlineHoursNew} ساعة (الحسابات الجديدة) أو ${t.dropoffDeadlineHoursEstablished} ساعة (الحسابات الناضجة). أي تأخير قد يؤدي إلى تعليق الحساب.\n\nالمادة 5 — الدفع\nتُضاف الأرباح إلى محفظة البائع وتصبح متاحة بعد ${t.unlockDaysVendor} أيام من تأكيد التسليم (${t.unlockDaysSmart} يوماً لمنتجات سمارت سويقة). الحد الأدنى للسحب هو ${t.minWithdrawal} درهم.\n\nالمادة 6 — الإرجاع\nفي حالة الإرجاع، تُخصم رسوم قدرها ${t.returnFeeLivo} درهماً لكل طرد مُرجع (رسوم يفرضها شريكنا اللوجستي Livo). الإرجاعات المتكررة قد تؤدي إلى مراجعة وضع البائع.\n\nالمادة 7 — الإنهاء\nيمكن لأي طرف إنهاء هذا العقد في أي وقت. تبقى الطلبات الجارية خاضعة لهذه الشروط.\n\nالمادة 8 — القانون المطبق\nيخضع هذا العقد للقانون المغربي. يختص القضاء في الدار البيضاء بأي نزاع.\n\nالمادة 9 — التوقيع الإلكتروني\nالتوقيع الإلكتروني يعتبر قبولاً تاماً وصريحاً. يتم تسجيل عنوان IP، ووكيل المستخدم، وتاريخ الخادم، وبصمة SHA-256 لهذا المستند كدليل.\n\nبالتوقيع، يقر البائع بأنه قرأ وفهم كامل هذا العقد.`,
      en: (t) => `VENDOR PARTNERSHIP AGREEMENT — SMART SWI9A\nVersion ${t.version}\n\nArticle 1 — Purpose\nThis agreement governs the listing and sale of products by the Vendor on Smart Swi9a (smartswi9a.top), a Moroccan marketplace for connected devices and home products.\n\nArticle 2 — Registration and verification\nThe Vendor agrees to provide accurate information (shop name, phone, city, ICE or CIN). Any false statement results in immediate account suspension.\n\nArticle 3 — Commission\nSmart Swi9a charges a ${(t.commissionRate * 100).toFixed(0)}% commission on the delivery-excluded amount of each sale. This commission may be adjusted between ${(t.commissionRateMin * 100).toFixed(0)}% and ${(t.commissionRateMax * 100).toFixed(0)}% with the Vendor's written consent.\n\nArticle 4 — Shipping\nThe Vendor chooses agency drop-off or Smart Swi9a fulfillment. Drop-off deadlines are ${t.dropoffDeadlineHoursNew} hours (new accounts) or ${t.dropoffDeadlineHoursEstablished} hours (mature accounts). Any delay may result in suspension.\n\nArticle 5 — Payment\nEarnings are credited to the vendor wallet and become available ${t.unlockDaysVendor} days after confirmed delivery (${t.unlockDaysSmart} days for Smart Swi9a products). Minimum withdrawal is ${t.minWithdrawal} MAD.\n\nArticle 6 — Returns\nIn case of return, a ${t.returnFeeLivo} MAD fee is charged per returned parcel (fee charged by our logistics partner Livo). Repeated returns may lead to a review of the Vendor's status.\n\nArticle 7 — Termination\nEither party may terminate this agreement at any time. Pending orders remain subject to these terms.\n\nArticle 8 — Governing law\nThis agreement is governed by Moroccan law. Any dispute falls under the jurisdiction of the courts of Casablanca.\n\nArticle 9 — Electronic signature\nThe electronic signature constitutes full acceptance. The IP, user-agent, server date, and a SHA-256 hash of this document are recorded as evidence.\n\nBy signing, the Vendor acknowledges having read and understood this entire agreement.`
    }
  };
  // La version 1.3.0 reprend strictement le contrat Livo 1.2.0,
  // avec le nouveau domaine. Les gabarits 1.1.0 et 1.2.0 restent intacts
  // afin de préserver les empreintes des contrats déjà signés.
  const sourceVersion = ["1.3.0", "1.4.0", "1.5.0", "1.6.0"].includes(version) ? "1.2.0" : version;
  const t = templates[sourceVersion] || templates["1.2.0"];
  let text = t[lang] ? t[lang](snapshot) : t["fr"](snapshot);
  if (["1.4.0", "1.5.0", "1.6.0"].includes(version)) {
    const clauses = {
      fr: `Article 6 — Retours
Les frais de retour sont facturés séparément à chaque Vendeur selon le montant réel communiqué par le transporteur ou, à défaut, validé par l'administration. Aucun frais n'est débité avant l'enregistrement et la validation de ce montant. Les retours répétés peuvent entraîner une révision du statut du Vendeur.`,
      ar: `المادة 6 — الإرجاع
ØªÙÙØ±Ø¶ Ø±Ø³ÙˆÙ… Ø§Ù„Ø¥Ø±Ø¬Ø§Ø¹ Ø¨Ø´ÙƒÙ„ Ù…Ù†ÙØµÙ„ Ø¹Ù„Ù‰ ÙƒÙ„ Ø¨Ø§Ø¦Ø¹ ÙˆÙÙ‚ Ø§Ù„Ù…Ø¨Ù„Øº Ø§Ù„ÙØ¹Ù„ÙŠ Ø§Ù„Ø°ÙŠ ÙŠØ­Ø¯Ø¯Ù‡ Ø§Ù„Ù†Ø§Ù‚Ù„ØŒ Ø£Ùˆ Ø§Ù„Ø°ÙŠ ØªØ¹ØªÙ…Ø¯Ù‡ Ø§Ù„Ø¥Ø¯Ø§Ø±Ø© Ø¹Ù†Ø¯ Ø¹Ø¯Ù… ØªÙˆÙØ±Ù‡. Ù„Ø§ ÙŠØªÙ… Ø®ØµÙ… Ø£ÙŠ Ø±Ø³ÙˆÙ… Ù‚Ø¨Ù„ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ù…Ø¨Ù„Øº ÙˆØ§Ø¹ØªÙ…Ø§Ø¯Ù‡. ÙˆÙ‚Ø¯ ØªØ¤Ø¯ÙŠ Ø§Ù„Ø¥Ø±Ø¬Ø§Ø¹Ø§Øª Ø§Ù„Ù…ØªÙƒØ±Ø±Ø© Ø¥Ù„Ù‰ Ù…Ø±Ø§Ø¬Ø¹Ø© ÙˆØ¶Ø¹ Ø§Ù„Ø¨Ø§Ø¦Ø¹.`,
      en: `Article 6 — Returns
Return fees are charged separately to each Vendor based on the actual amount provided by the carrier or, if unavailable, validated by the administration. No fee is debited until that amount has been recorded and approved. Repeated returns may lead to a review of the Vendor's status.`
    };
    const patterns = {
      fr: /Article 6 — Retours\n[\s\S]*?(?=\n\nArticle 7 — Résiliation)/,
      ar: /المادة 6 — الإرجاع\n[\s\S]*?(?=\n\nالمادة 7 — الإنهاء)/,
      en: /Article 6 — Returns\n[\s\S]*?(?=\n\nArticle 7 — Termination)/
    };
    const language = clauses[lang] ? lang : "fr";
    text = text.replace(patterns[language], clauses[language]);
    text = text.replaceAll("smartswi9a.top", "smartswika.ma");
    if (version === "1.5.0" || version === "1.6.0") {
      text = text.replaceAll("SMART SWI9A", "SMARTSWIKA").replaceAll("Smart Swi9a", "Smartswika").replaceAll("Ø³Ù…Ø§Ø±Øª Ø³ÙˆÙŠÙ‚Ø©", "Ø³Ù…Ø§Ø±ØªØ³ÙˆÙŠÙƒØ§");
    }
    if (version === "1.6.0") {
      const stockClauses = {
        fr: `Article 4 — Stock, SKU et étiquetage
Le Vendeur stocke obligatoirement ses produits à l'entrepôt Smartswika. Il crée une demande de ramassage dans son espace vendeur ; l'administration enregistre la quantité réellement reçue et approuve la demande. Aucun produit ne peut être publié avant cette approbation. À l'approbation, un SKU unique est attribué à chaque ligne de ramassage (une ligne = une variante taille/couleur) ; le Vendeur imprime les étiquettes fournies par la Plateforme (nom, SKU, code-barres Code 128) et colle une étiquette par unité. Le SKU est figé dans la fiche produit. Livo ne récupère les colis qu'à l'entrepôt pour les livrer aux acheteurs.`,
        ar: `المادة 4 — المخزون وSKU والملصقات
يخزن البائع منتجاته إلزامياً في مستودع Smart Swika. ينشئ طلب استلام من مساحة البائع؛ تسجل الإدارة الكمية المستلمة فعلياً وتوافق على الطلب. لا يمكن نشر أي منتج قبل هذه الموافقة. عند الموافقة يُمنح SKU فريد لكل سطر استلام (سطر واحد = متغير مقاس/لون)؛ يطبع البائع الملصقات التي توفرها المنصة (الاسم، SKU، رمز شريطي Code 128) ويلصق ملصقاً واحداً لكل وحدة. يكون SKU ثابتاً في بطاقة المنتج. لا يستلم Livo الطرود إلا من المستودع لتوصيلها إلى المشترين.`,
        en: `Article 4 — Stock, SKU and labelling
The Vendor must store its products in the Smartswika warehouse. It creates a pickup request in its vendor space; the administration records the quantity actually received and approves the request. No product may be published before this approval. On approval, a unique SKU is assigned to each pickup line (one line = one size/colour variant); the Vendor prints the labels provided by the Platform (name, SKU, Code 128 barcode) and sticks one label per unit. The SKU is locked in the product record. Livo only collects parcels at the warehouse to deliver them to buyers.`
      };
      const stockPatterns = {
        fr: /Article 4 — Expédition\n[\s\S]*?(?=\n\nArticle 5 — Paiement)/,
        ar: /المادة 4 — الشحن\n[\s\S]*?(?=\n\nالمادة 5 — الدفع)/,
        en: /Article 4 — Shipping\n[\s\S]*?(?=\n\nArticle 5 — Payment)/
      };
      const stockLang = stockClauses[lang] ? lang : "fr";
      text = text.replace(stockPatterns[stockLang], stockClauses[stockLang]);
    }
    text = text.replace(/\s+/g, " ").trim();
    return text;
  }
  return version === "1.3.0"
    ? text.replaceAll("smartswi9a.top", "smartswika.ma").replace(/\s+/g, " ").trim()
    : text;
}

/* ============================================================
   VÉRIFICATION D'UN CONTRAT VENDEUR OFFICIEL
   ============================================================ */
function isOfficialVendorContract(vendorId, contract) {
  try {
    if (!vendorId || !contract || typeof contract !== 'object') return false;
    if (contract.vendorId !== vendorId || contract.status !== 'accepted') return false;
    if (String(contract.version || '') !== OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION) return false;
    if (!['fr', 'ar', 'en'].includes(String(contract.language || ''))) return false;
    if (!/^[a-f0-9]{64}$/i.test(String(contract.textHash || ''))) return false;
    if (!/^[a-f0-9]{64}$/i.test(String(contract.contractHash || ''))) return false;

    const officialSnapshot = buildOfficialSnapshot();
    const storedSnapshot = contract.termsSnapshot;
    if (!storedSnapshot || typeof storedSnapshot !== 'object') return false;
    const expectedKeys = Object.keys(officialSnapshot).sort();
    const storedKeys = Object.keys(storedSnapshot).sort();
    if (expectedKeys.length !== storedKeys.length ||
        expectedKeys.some((key, index) => key !== storedKeys[index])) return false;
    if (!expectedKeys.every(key => storedSnapshot[key] === officialSnapshot[key])) return false;

    const officialText = getContractText(contract.language, contract.version, officialSnapshot);
    const expectedTextHash = crypto.createHash('sha256').update(officialText).digest('hex');
    if (expectedTextHash !== String(contract.textHash).toLowerCase()) return false;

    const expectedContractHash = crypto.createHash('sha256')
      .update([vendorId, contract.version, contract.language, contract.textHash].join('|'))
      .digest('hex');
    return expectedContractHash === String(contract.contractHash).toLowerCase();
  } catch (error) {
    console.error('[isOfficialVendorContract]', error);
    return false;
  }
}

/* ============================================================
   CF : getLivoFees (PUBLIC)
   ============================================================ */
exports.getLivoFees = onRequest({ invoker: 'public', region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    let metaEarly = null;
    try { metaEarly = await getLivoFeesCacheMeta(); }
    catch (e) { console.warn('[getLivoFees] Cache metadata read failed:', e.message); }

    let cacheFresh = false;
    const wasFreshAtEntry = !!(metaEarly && metaEarly.updatedAt);
    if (metaEarly && metaEarly.updatedAt) {
      const updatedAt = metaEarly.updatedAt.toDate
        ? metaEarly.updatedAt.toDate()
        : new Date(metaEarly.updatedAt);
      cacheFresh = (Date.now() - updatedAt.getTime()) / 3600000 < LIVO_FEES_CACHE_HOURS;
    }

    let syncError = null;
    if (!cacheFresh) {
      try {
        await syncLivoCitiesFromApi({ preserveCustom: true });
        cacheFresh = true;
      } catch (e) {
        syncError = e;
        console.warn('[getLivoFees] Livo sync failed; serving last stored rates:', e.message);
      }
    }

    // P2-7 : apres une synchronisation, metaEarly est perime : on le relit
    // pour disposer de la grille pre-calculee et des cityKeys a jour.
    let meta = metaEarly;
    if (!wasFreshAtEntry && !syncError) {
      try { meta = await getLivoFeesCacheMeta(); }
      catch (e) { console.warn('[getLivoFees] Cache metadata refresh failed:', e.message); }
    }

    let cities = [];
    if (cacheFresh && Array.isArray(meta?.publicGrid) && meta.publicGrid.length) {
      cities = meta.publicGrid;
    } else {
        const mapFn = d => {
          const data = d.data();
          const price = Number(data.price);
          return {
            id: Number(data.id) || 0,
            key: data.key || '',
            nameFr: data.nameFr || data.key || '',
            nameEn: data.nameEn || data.nameFr || data.key || '',
            nameAr: data.nameAr || data.nameFr || data.key || '',
            price: Number.isFinite(price) ? price : FALLBACK_DELIVERY_FEE,
            delay: data.delay || '48h',
            fromLivo: !!data.lastSyncedFromLivo || data.source === 'livo'
          };
        };
        try {
          const snap = await db.collection('cities').orderBy('id', 'asc').limit(500).get();
          cities = snap.docs.map(mapFn).filter(c => c.key);
        } catch (e) {
          console.warn('[getLivoFees] orderBy id failed, fallback unsorted:', e.message);
          try {
            const snap = await db.collection('cities').limit(500).get();
            cities = snap.docs.map(mapFn).filter(c => c.key).sort((a, b) => a.id - b.id);
          } catch (e2) {
            console.warn('[getLivoFees] Fallback unsorted failed:', e2.message);
          }
        }

        // N'expose que les villes présentes dans la dernière réponse Livo. Cela
        // exclut les anciennes villes et les éventuels tarifs manuels du tableau public.
        if (Array.isArray(meta?.cityKeys) && meta.cityKeys.length) {
          const activeKeys = new Set(meta.cityKeys.map(normalizeCityKey));
          cities = cities.filter(city => activeKeys.has(normalizeCityKey(city.key)));
        } else {
          const livoCities = cities.filter(city => city.fromLivo);
          if (livoCities.length) cities = livoCities;
        }
    }

    if (cities.length === 0) {
      return res.status(503).json({
        success: false,
        message: 'Grille tarifaire temporairement indisponible. Réessayez dans quelques instants.',
        source: 'none'
      });
    }

    const updatedAt = meta?.updatedAt?.toDate ? meta.updatedAt.toDate().toISOString() : (meta?.updatedAt ? new Date(meta.updatedAt).toISOString() : null);
    // P2-7 : grille fraiche -> cache navigateur/CDN 5 min. Perimee -> no-store.
    res.set('Cache-Control', cacheFresh
      ? 'public, max-age=300, stale-while-revalidate=60'
      : 'no-store');
    return res.status(200).json({
      success: true,
      count: cities.length,
      source: cacheFresh ? 'livo' : 'stale-cache',
      cacheFresh,
      stale: !cacheFresh,
      lastSyncedAt: updatedAt,
      requestDate: meta?.requestDate || null,
      ...(syncError ? { refreshError: 'Tarifs Livo indisponibles; affichage des derniers tarifs enregistrés.' } : {}),
      cities
    });
  } catch (error) {
    console.error('[getLivoFees]', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

/* ============================================================
   CF : livoWebhook (Livo event receiver)
   ============================================================ */
// Mapping Livo -> statut Smart Swika (PR 8.3).
// `shipping` est DEPRECIE : il n'est plus jamais produit ici (legacy en lecture seule).
// Seuls les statuts porteurs d'un vrai changement de workflow sont mappes.
// `draft`, `problem` et `reported` sont volontairement ABSENTS : ces evenements
// n'ecrivent que `livoStatusRaw` et ne touchent JAMAIS le statut principal.
//   - draft   : brouillon cote Livo, n'a aucun sens dans notre cycle (pending ->
//               confirmed -> preparing -> prepared -> pickup_requested -> picked_up
//               -> in_transit -> delivered). Le mapper retrograderait une commande
//               deja avancee, sans retour possible (aucune transition arriere).
//   - problem : incident transport, il ne doit pas ecraser un `in_transit` ou un
//               `delivered` ; l'incident est trace dans `livoStatusRaw`.
//   - reported: signalement, meme raisonnement.
const LIVO_STATUS_TO_ORDER_STATUS = Object.freeze({
  pending: 'confirmed',
  programmed: 'confirmed',
  'awaiting pickup': 'pickup_requested',
  'awaiting transfer': 'picked_up',
  'in progress': 'in_transit',
  fulfilled: 'delivered',
  cancelled: 'cancelled'
});

function timingSafeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

exports.livoWebhook = onRequest({
  invoker: 'public',
  region: 'europe-west1',
  timeoutSeconds: 10,
  maxInstances: 5,
  secrets: [LIVO_WEBHOOK_SECRET]
}, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ success: false });

  const secret = LIVO_WEBHOOK_SECRET.value();
  if (!secret) {
    console.error('[livoWebhook] LIVO_WEBHOOK_SECRET absent.');
    return res.status(500).json({ success: false });
  }

  // Spec (api-entrepot-livo.json, section Webhooks > Securiser votre endpoint) :
  // Livo envoie `secret` dans `Authorization: Bearer <secret>` a chaque livraison
  // et impose de refuser toute requete dont l'en-tete n'est pas exactement celui-la,
  // avec une comparaison a temps constant. Un en-tete absent est donc un 401.
  const authorization = String(req.get('authorization') || '');
  const expectedAuthorization = `Bearer ${secret}`;
  if (!timingSafeTextEqual(authorization, expectedAuthorization)) {
    return res.status(401).json({ success: false, message: 'Autorisation invalide.' });
  }

  const timestampText = String(req.get('x-livo-timestamp') || '');
  const timestamp = Number(timestampText);
  if (!/^\d{10,12}$/.test(timestampText) || !Number.isFinite(timestamp) ||
      Math.abs(Math.floor(Date.now() / 1000) - timestamp) > LIVO_WEBHOOK_MAX_CLOCK_SKEW_SECONDS) {
    return res.status(401).json({ success: false, message: 'Horodatage invalide.' });
  }

  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
  if (!rawBody || rawBody.length === 0 || rawBody.length > 512 * 1024) {
    return res.status(400).json({ success: false, message: 'Corps de requête invalide.' });
  }

  const signature = String(req.get('x-livo-signature') || '').match(/^sha256=([a-f0-9]{64})$/i);
  if (!signature) return res.status(401).json({ success: false });
  const expectedSignature = crypto.createHmac('sha256', secret)
    .update(timestampText)
    .update('.')
    .update(rawBody)
    .digest('hex');
  if (!timingSafeTextEqual(signature[1].toLowerCase(), expectedSignature)) {
    return res.status(401).json({ success: false });
  }

  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); }
  catch (_) { return res.status(400).json({ success: false, message: 'JSON invalide.' }); }

  const eventId = String(req.get('x-livo-delivery') || event?.id || '').trim();
  const eventType = String(req.get('x-livo-event') || event?.event || '').trim();
  const data = event?.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : null;
  if (!eventId || eventId.length > 200 || eventId.includes('/') || (eventType !== 'ping' && !data) ||
      !LIVO_WEBHOOK_ALLOWED_EVENTS.has(eventType)) {
    return res.status(400).json({ success: false, message: 'Événement Livo invalide.' });
  }

  const resourceId = String(data?._id || data?.order_id || data?.id || '').trim().slice(0, 200);
  const livoStatus = String(data?.status || '').trim().slice(0, 80).toLowerCase();
  const returnStatus = String(data?.return_status || '').trim().slice(0, 80).toLowerCase();
  const mappedStatus = eventType === 'order.status_changed' ? LIVO_STATUS_TO_ORDER_STATUS[livoStatus] : null;

  try {
    let matchedOrderRef = null;
    if (resourceId && ['order.status_changed', 'order.return_status_changed'].includes(eventType)) {
      const matches = await db.collection('orders').where('livoTracking', '==', resourceId).limit(2).get();
      if (matches.size === 1) matchedOrderRef = matches.docs[0].ref;
    }

    const eventRef = db.collection(LIVO_WEBHOOK_EVENT_COLLECTION).doc(eventId);
    const outcome = await db.runTransaction(async tx => {
      const previous = await tx.get(eventRef);
      if (previous.exists) return { duplicate: true };

      let orderSnap = null;
      if (matchedOrderRef) orderSnap = await tx.get(matchedOrderRef);

      // `livoStatusRaw` est ecrit des qu'une commande est correlee et que l'evenement
      // porte un statut : c'est notre source de verite d'audit, meme quand le statut
      // principal ne bouge pas (draft, problem, reported, ou commande terminale).
      const shouldWriteRaw = !!(orderSnap?.exists && eventType === 'order.status_changed' && livoStatus);
      const orderStatus = String(orderSnap?.data()?.status || '').toLowerCase();
      const isTerminal = ['delivered', 'returned', 'cancelled'].includes(orderStatus);
      // Le statut principal ne change que si le mapping produit une cible
      // ET que la commande n'est pas dans un etat terminal (jamais d'ecrasement).
      const canApplyStatus = !!(shouldWriteRaw && mappedStatus && !isTerminal);
      const canApplyReturn = !!(orderSnap?.exists && eventType === 'order.return_status_changed' && returnStatus);

      tx.create(eventRef, {
        eventId,
        eventType,
        resourceId: resourceId || null,
        livoStatus: livoStatus || null,
        returnStatus: returnStatus || null,
        processing: shouldWriteRaw || canApplyReturn ? 'applied' : (matchedOrderRef ? 'ignored' : 'unmatched'),
        receivedAt: FieldValue.serverTimestamp()
      });

      if (shouldWriteRaw) {
        const statusPatch = {
          livoStatusRaw: livoStatus,
          livoSyncedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        };
        if (canApplyStatus) statusPatch.status = mappedStatus;

        // Chrono garanti : l'ancre est la PRISE EN CHARGE du colis, c'est-a-dire le
        // passage en `in progress` chez Livo (colis en circulation). `pending`
        // (commande enregistree) et `pickup_requested` (ramassage demande) ne sont
        // PAS des prises en charge : ils ne posent pas l'ancre.
        // Deux garde-fous cumules :
        //   - `!isTerminal` : une commande livree/retournee/annulee ne recoit jamais
        //     d'ancre, meme si un `in progress` tardif arrive apres coup.
        //   - `!trackingStartedAt` : ecrite une seule fois, un rejeu
        //     `in progress` -> `in progress` ne repousse jamais la date de deblocage.
        if (canApplyStatus && livoStatus === 'in progress' && !orderSnap.data().trackingStartedAt) {
          statusPatch.trackingStartedAt = FieldValue.serverTimestamp();
          statusPatch.trackingStartedFrom = 'livo_webhook';
        }

        tx.update(matchedOrderRef, statusPatch);
      } else if (canApplyReturn) {
        const orderData = orderSnap.data();

        // ---- Restitution de la poche entrepot (PR 8.3) --------------------
        // Deux sources de decrement coexistent dans l'application :
        //   b. `stock_warehouse_deducted: true` -> commande 100 % entrepot,
        //      decrementee par markOrderAsPrepared (js/admin.js:639).
        //   b'. `stockDeducted: true` -> commande mixte, decrement partiel de
        //      stock_warehouse fait par deductStockInTransaction (js/orders.js).
        // `stockDeducted` seul est INSUFFISANT : une commande 100 % entrepot ne
        // passe jamais par deductStockInTransaction et n'a donc jamais ce flag.
        const warehouseDeducted = orderData.stock_warehouse_deducted === true ||
          orderData.stockDeducted === true;
        const isFullReturn = returnStatus === 'returned-fully';
        // Un retour "fully" est une transition METIER : il pose `returned` meme
        // sans restitution de stock. `delivered -> returned` est le chemin normal
        // d'un retour, on n'applique donc PAS la garde terminale ici (elle ne
        // protege que `status` pilote par order.status_changed).
        // Seuls `cancelled` et un `returned` deja pose sont proteges : ecraser
        // une annulation par un retour serait une inversion de sens.
        const canSetReturnedStatus = isFullReturn && !['cancelled', 'returned'].includes(orderStatus);

        // Un retour ANNONCÉ (returned-pending, returned-started) n'est pas un
        // retour RECU : le colis n'est pas encore a l'entrepot, donc rien a
        // restituer. Seuls returned-warehouse et returned-fully declenchent une
        // restitution.
        const isRestitutableReturn = returnStatus === 'returned-warehouse' || isFullReturn;

        // La restitution n'a lieu que si rien n'a deja ete restitue POUR CETTE
        // COMMANDE. L'idempotence par event_id ne suffit pas : deux evenements
        // distincts (returned-warehouse puis returned-fully) doivent produire
        // un seul increment.
        const shouldRestitute = isRestitutableReturn && !orderData.stockRestituted;

        const returnPatch = {
          livoReturnStatus: returnStatus,
          livoSyncedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        };
        if (canSetReturnedStatus) returnPatch.status = 'returned';

        if (shouldRestitute) {
          // Agregation des quantites par produit (plusieurs lignes possibles).
          const qtyByProduct = new Map();
          for (const item of (Array.isArray(orderData.items) ? orderData.items : [])) {
            const pid = item && item.productId != null ? String(item.productId) : '';
            const qty = Math.floor(Number(item && item.quantity));
            if (!pid || !Number.isFinite(qty) || qty < 1) continue;
            qtyByProduct.set(pid, (qtyByProduct.get(pid) || 0) + qty);
          }

          // Toutes les lectures AVANT toute ecriture (exigence Firestore).
          const productRefs = [];
          const productSnaps = [];
          if (warehouseDeducted) {
            for (const pid of qtyByProduct.keys()) {
              const productRef = db.collection('products').doc(pid);
              productRefs.push(productRef);
              productSnaps.push(await tx.get(productRef));
            }
          }

          productSnaps.forEach((snap, index) => {
            if (!snap.exists) {
              console.warn('[livoWebhook] Produit introuvable pour restitution:', productRefs[index].id);
              return;
            }
            const pData = snap.data() || {};
            // (a) Seuls les produits stockes a l'entrepot ont une poche
            // stock_warehouse. Les produits normaux ne sont JAMAIS touches.
            if (pData.delivery_mode !== 'smartswika_warehouse') return;
            const qty = qtyByProduct.get(productRefs[index].id) || 0;
            if (qty < 1) return;
            // On ne restitue QUE stock_warehouse : ni stock, ni variants, ni
            // salesCount. Ce n'est pas une annulation commerciale mais une
            // restitution logistique de la poche entrepot.
            tx.update(productRefs[index], { stock_warehouse: FieldValue.increment(qty) });
          });
        }

        // SEMANTIQUE DE stockRestituted (ne pas se tromper) :
        // ce flag signifie "evenement de retour TRAITE, idempotence scellee pour
        // cette commande". Il NE signifie PAS "du stock a ete incremente" :
        // il est aussi pose quand les flags de decrement sont absents, ou quand
        // aucun produit n'est stocke a l'entrepot, ou sur returned-fully sans
        // restitution. Sa seule fonction est d'empecher un second traitement
        // (restitution) par un evenement ulterieur portant un event_id distinct.
        returnPatch.stockRestituted = true;

        tx.update(matchedOrderRef, returnPatch);
      }

      return { duplicate: false, applied: shouldWriteRaw || canApplyReturn };
    });

    return res.status(200).json({ success: true, ...outcome });
  } catch (error) {
    console.error('[livoWebhook] Event processing failed:', error.message);
    return res.status(500).json({ success: false, message: 'Traitement webhook temporairement indisponible.' });
  }
});

/* ============================================================
   CF : syncLivoCities (ADMIN)
   ============================================================ */
exports.syncLivoCities = onRequest({ invoker: 'public', region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 60 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    const isAdmin = decoded.admin === true || (adminSnap.exists && adminSnap.data()?.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });
    }

    /* preserveCustom: true      -> ne supprime rien, met seulement a jour.
       preserveReferenced: false -> supprime aussi les villes encore
         referencees par une commande (par defaut on les conserve). */
    const result = await syncLivoCitiesFromApi({
      preserveCustom: req.body?.preserveCustom === true,
      preserveReferenced: req.body?.preserveReferenced !== false
    });

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('[syncLivoCities]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Erreur lors de la synchronisation.'
    });
  }
});

/* ============================================================
   CF : syncVendorPublic (Trigger)
   ============================================================ */
exports.syncVendorPublic = onDocumentWritten('users/{userId}', async (event) => {
  const snap = event.data.after;

  // La suppression du profil doit aussi supprimer la fiche publique.
  // Sans ce cas, une ancienne boutique peut rester visible après suppression du vendeur.
  if (!snap || !snap.exists) {
    return db.collection('vendorsPublic').doc(event.params.userId).delete();
  }

  const data = snap.data();

  // Seuls les vendeurs approuvés avec un contrat accepté sont publiés.
  // Les demandes pending/rejected/suspended restent privées dans users/.
  if (
    data.role !== 'vendor' ||
    !data.vendorInfo ||
    data.vendorInfo.status !== 'approved' ||
    data.vendorInfo.contractStatus !== 'accepted' ||
    String(data.vendorInfo.contractVersion || '') !== OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION
  ) {
    return db.collection('vendorsPublic').doc(event.params.userId).delete().catch(() => {});
  }

  return db.collection('vendorsPublic').doc(event.params.userId).set({
    shopName: data.vendorInfo.shopName || 'Boutique',
    status: data.vendorInfo.status || 'pending',
    contractVersion: data.vendorInfo.contractVersion,
    description: data.vendorInfo.description || '',
    createdAt: data.createdAt || FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
});

/* ============================================================
   CF : signVendorContract (Sécurisé + B-C1 snapshot officiel)
   ============================================================ */
exports.signVendorContract = onRequest({ invoker: 'public', region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    // Le contrat vendeur ne peut être signé que par un compte déjà inscrit
    // comme vendeur. Sans ce contrôle, un acheteur authentifié pourrait créer
    // un document contracts/ et recevoir vendorInfo.contractStatus=accepted.
    const vendorRef = db.collection('users').doc(decoded.uid);
    const vendorSnap = await vendorRef.get();
    if (!vendorSnap.exists || vendorSnap.data()?.role !== 'vendor') {
      return res.status(403).json({ success: false, message: 'Cette action est réservée aux comptes vendeurs.' });
    }

    const vendorProfile = vendorSnap.data();
    const vendorStatus = vendorProfile.vendorInfo?.status;
    if (!['pending', 'approved'].includes(vendorStatus)) {
      return res.status(403).json({
        success: false,
        message: 'Votre compte vendeur ne peut pas signer de contrat dans son état actuel.'
      });
    }

    const body = req.body || {};
    const { version, language, textHash } = body;
    const contractSource = String(body.source || 'dashboard');
    if (!['signup', 'dashboard', 'resign'].includes(contractSource)) {
      return res.status(400).json({ success: false, message: 'Origine de signature invalide.' });
    }
    if (!version || !language || !textHash) {
      return res.status(400).json({ success: false, message: 'Données incomplètes.' });
    }
    if (!['fr', 'ar', 'en'].includes(String(language))) {
      return res.status(400).json({ success: false, message: 'Langue du contrat invalide.' });
    }

    // B-C1 : on IGNORE le termsSnapshot du client, on reconstruit l'officiel
    const officialSnapshot = buildOfficialSnapshot();

    if (String(officialSnapshot.version) !== String(version)) {
      return res.status(400).json({
        success: false,
        message: `Version contrat obsolète. Version attendue : ${officialSnapshot.version}, reçue : ${version}. Rechargez la page.`
      });
    }

    const contractId = `contract_${decoded.uid}_v${version}`;
    const contractRef = db.collection('contracts').doc(contractId);

    const existing = await contractRef.get();
    if (existing.exists) {
      const existingData = existing.data();

      // Idempotence : si le contrat existe déjà, réconcilier aussi le profil.
      // Cela évite qu'un ancien échec réseau laisse contractStatus à "pending"
      // alors que le document signé est bien présent dans contracts/.
      if (!isOfficialVendorContract(decoded.uid, existingData) ||
          String(existingData.version) !== String(version)) {
        return res.status(409).json({
          success: false,
          message: 'Un document de contrat existe déjà mais ses données ne sont pas cohérentes. Contactez l’administration.'
        });
      }

      const vendorRef = db.collection('users').doc(decoded.uid);
      const vendorSnap = await vendorRef.get();
      if (!vendorSnap.exists || vendorSnap.data()?.role !== 'vendor') {
        return res.status(403).json({ success: false, message: 'Profil vendeur introuvable.' });
      }

      await vendorRef.update({
        'vendorInfo.contractStatus': 'accepted',
        'vendorInfo.currentContractId': contractId,
        'vendorInfo.contractVersion': existingData.version,
        'vendorInfo.contractSignedAt': existingData.acceptedAt || FieldValue.serverTimestamp(),
        'vendorInfo.commissionRate': OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE,
        'vendorInfo.commissionRateMin': OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE_MIN,
        'vendorInfo.commissionRateMax': OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE_MAX,
        updatedAt: FieldValue.serverTimestamp()
      });

      return res.status(200).json({
        success: true,
        alreadySigned: true,
        contractId,
        version: existingData.version
      });
    }

    const officialText = getContractText(language, version, officialSnapshot);
    const officialHash = crypto.createHash('sha256').update(officialText).digest('hex');

    if (officialHash !== textHash) {
      return res.status(400).json({
        success: false,
        message: 'Falsification détectée : le hash ne correspond pas au contrat officiel. Rechargez la page.'
      });
    }

    const contractHash = crypto.createHash('sha256')
      .update([decoded.uid, version, language, textHash].join('|')).digest('hex');
    const ip = String(req.ip || 'unknown').slice(0, 80);
    const userAgent = String(req.get('user-agent') || 'unknown').slice(0, 300);

    await contractRef.set({
      vendorId: decoded.uid,
      version: version,
      language: language,
      termsSnapshot: officialSnapshot,  // ← officiel
      textHash: textHash,
      contractHash: contractHash,
      acceptedAt: FieldValue.serverTimestamp(),
      ipAddress: ip,
      userAgent,
      status: 'accepted',
      source: contractSource
    });

    await db.collection('users').doc(decoded.uid).update({
      'vendorInfo.contractStatus': 'accepted',
      'vendorInfo.currentContractId': contractId,
      'vendorInfo.contractVersion': version,
      'vendorInfo.contractSignedAt': FieldValue.serverTimestamp(),
      // La commission contractuelle est fixée par le serveur lors de la signature.
      'vendorInfo.commissionRate': OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE,
      'vendorInfo.commissionRateMin': OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE_MIN,
      'vendorInfo.commissionRateMax': OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE_MAX,
      updatedAt: FieldValue.serverTimestamp()
    });

    return res.status(200).json({ success: true, contractId, version });
  } catch (error) {
    console.error('[signVendorContract]', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

/* ============================================================
   CF : loginVendor (B-C3 : rate limiting)
   ============================================================ */
exports.loginVendor = onRequest({ invoker: 'public', region: 'europe-west1', maxInstances: 5, timeoutSeconds: 20 }, async (req, res) => {
  if (cors(req, res)) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  // req.ip est fourni par l infrastructure Cloud Functions, jamais par le client.
  // X-Forwarded-For n est volontairement plus lu : il est falsifiable.
  const clientIp = String(req.ip || 'unknown').slice(0, 80);

  if (!validEmail(email) || typeof password !== 'string' || password.length === 0 || password.length > 128) {
    return res.status(400).json({ success: false, message: 'Identifiants invalides.' });
  }

  try {
    // B-C3 : throttle AVANT tout traitement
    if (await isLoginThrottled(email)) {
      return res.status(429).json({
        success: false,
        message: 'Trop de tentatives échouées. Réessayez dans 15 minutes.'
      });
    }

    const userRecord = await findUserByEmail(email);
    if (!userRecord) {
      await recordLoginFailure(email, clientIp);
      return res.status(401).json({ success: false, message: 'Identifiants incorrects.' });
    }

    const { uid, data: profile } = userRecord;
    const credentialSnap = await db.collection('vendorCredentials').doc(uid).get();
    let validCredential = false;

    if (credentialSnap.exists) {
      const credential = credentialSnap.data();
      if (credential.email === email && credential.passwordHash) {
        validCredential = await bcrypt.compare(password, credential.passwordHash);
      }
    }

    if (!validCredential) {
      await recordLoginFailure(email, clientIp);
      return res.status(401).json({ success: false, message: 'Identifiants incorrects.' });
    }

    // Ne jamais émettre de jeton vendeur pour un profil qui n'a pas le rôle vendeur.
    // Autoriser les vendeurs approuvés avec un ancien contrat à se connecter
    // uniquement pour accéder à l'écran de re-signature (les droits métier
    // restent bloqués par les règles tant que la version courante n'est pas acceptée).
    const canLogin = profile.role === 'vendor' &&
      ['pending', 'approved'].includes(String(profile.vendorInfo?.status || ''));
    if (!canLogin) {
      return res.status(403).json({ success: false, message: statusMessage(profile) });
    }

    await clearLoginFailures(email);

    const customToken = await getAuth().createCustomToken(uid, { vendorLogin: true });
    return res.status(200).json({ success: true, customToken, needsContract: !approved(profile) });
  } catch (error) {
    console.error('[loginVendor]', error);
    return res.status(500).json({ success: false, message: 'Erreur temporaire.' });
  }
});

/* ============================================================
   CF : setVendorPassword
   ============================================================ */
exports.setVendorPassword = onRequest({ invoker: 'public', region: 'europe-west1', maxInstances: 5, timeoutSeconds: 15 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const vendorPassword = req.body?.vendorPassword;
    if (!validPassword(vendorPassword)) {
      return res.status(400).json({ success: false, message: 'Mot de passe invalide.' });
    }

    const ref = db.collection('users').doc(decoded.uid);
    const snap = await ref.get();
    const vendorProfile = snap.exists ? snap.data() : null;
    if (!vendorProfile || vendorProfile.role !== 'vendor' ||
        !['pending', 'approved'].includes(String(vendorProfile.vendorInfo?.status || ''))) {
      return res.status(403).json({ success: false, message: 'Profil vendeur non autorisé.' });
    }

    const passwordHash = await bcrypt.hash(vendorPassword, 12);
    await db.collection('vendorCredentials').doc(decoded.uid).set({
      uid: decoded.uid,
      email: String(vendorProfile.email || '').trim().toLowerCase(),
      passwordHash,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

/* ============================================================
   CONTRÔLE DE COHÉRENCE AVANT SUPPRESSION VENDEUR
   ============================================================ */
async function inspectVendorSettlement(vendorId) {
  const blockers = [];
  let cursor = null;
  let scannedOrders = 0;
  let orderPages = 0;

  while (true) {
    // Parcourir toutes les commandes permet aussi de détecter les anciennes
    // commandes qui n'ont pas encore été migrées et ne possèdent pas vendorIds.
    let query = db.collection('orders')
      .orderBy(FieldPath.documentId())
      .limit(300);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) break;
    orderPages++;
    scannedOrders += snap.size;

    for (const orderDoc of snap.docs) {
      const order = orderDoc.data();
      const indexedVendorMatch = Array.isArray(order.vendorIds) && order.vendorIds.includes(vendorId);
      const legacyItemVendorMatch = Array.isArray(order.items) &&
        order.items.some(item => String(item?.vendorId || '') === vendorId);
      if (!indexedVendorMatch && !legacyItemVendorMatch) continue;

      const status = String(order.status || '').toLowerCase();
      if (['cancelled', 'canceled'].includes(status)) continue;
      if (!['delivered', 'returned'].includes(status)) {
        blockers.push({ orderId: orderDoc.id, reason: `commande non clôturée (statut ${status || 'absent'})` });
        continue;
      }

      const credit = order.vendorCredits?.[vendorId];
      // Une commande retournée avant livraison peut légitimement ne jamais
      // avoir généré de crédit de vente. Si un crédit existe, il doit toujours
      // être relié à une transaction cohérente.
      if (status === 'delivered' && (!credit?.txId || !(Number(credit.amount) > 0))) {
        blockers.push({ orderId: orderDoc.id, reason: 'crédit vendeur absent ou incomplet' });
      } else if (credit) {
        const saleTx = await db.collection('wallet_transactions').doc(String(credit.txId || '')).get();
        const sale = saleTx.exists ? saleTx.data() : null;
        if (!credit.txId || !sale || sale.vendorId !== vendorId || sale.orderId !== orderDoc.id ||
            sale.type !== 'sale' || !(Number(sale.amount) > 0)) {
          blockers.push({ orderId: orderDoc.id, reason: 'écriture de vente absente ou incohérente' });
        }
      }

      if (status === 'returned') {
        const returns = Array.isArray(order.returns) ? order.returns : [];
        if (returns.length === 0) {
          blockers.push({ orderId: orderDoc.id, reason: 'commande retournée sans détail de retour' });
        }
        // Vérifier chaque variante exacte (produit + taille + couleur), et non
        // seulement le total par produit : deux variantes ne sont pas interchangeables.
        const orderedByVariant = {};
        for (const item of (order.items || [])) {
          if (String(item.vendorId || '') !== vendorId) continue;
          const variant = item.variant || {};
          const key = JSON.stringify([
            String(item.productId || ''),
            String(variant.size || ''),
            String(variant.color || '')
          ]);
          orderedByVariant[key] = (orderedByVariant[key] || 0) + (Number(item.quantity) || 0);
        }
        const cumulativeReturnedByVariant = {};
        for (let returnIndex = 0; returnIndex < returns.length; returnIndex++) {
          for (const retItem of (returns[returnIndex]?.items || [])) {
            const productId = String(retItem?.productId || '');
            const variant = retItem?.variant || {};
            const matchingItems = (order.items || []).filter(item => {
              const itemVariant = item.variant || {};
              return String(item.productId || '') === productId &&
                String(itemVariant.size || '') === String(variant.size || '') &&
                String(itemVariant.color || '') === String(variant.color || '');
            });
            const owners = [...new Set(matchingItems.map(item => String(item.vendorId || '')))];
            const delta = Number(retItem?.delta);
            if (!productId || !Number.isInteger(delta) || delta <= 0 || owners.length !== 1) {
              blockers.push({ orderId: orderDoc.id, reason: `produit ou propriétaire ambigu dans le retour ${returnIndex + 1}` });
              continue;
            }
            // Les lignes des autres vendeurs du même panier ne doivent pas
            // être comptées dans le rapprochement de ce vendeur.
            if (owners[0] !== vendorId) continue;
            const key = JSON.stringify([
              productId,
              String(variant.size || ''),
              String(variant.color || '')
            ]);
            if (!orderedByVariant[key]) {
              blockers.push({ orderId: orderDoc.id, reason: `variante absente de la commande pour ${productId}` });
              continue;
            }
            cumulativeReturnedByVariant[key] = (cumulativeReturnedByVariant[key] || 0) + delta;
            if (cumulativeReturnedByVariant[key] > orderedByVariant[key]) {
              blockers.push({ orderId: orderDoc.id, reason: `quantité retournée supérieure à la quantité commandée pour ${productId}` });
            }
          }
        }

        for (let returnIndex = 0; returnIndex < returns.length; returnIndex++) {
          const entry = returns[returnIndex];
          const returnedQty = (entry?.items || []).reduce((sum, retItem) => {
            const variant = retItem.variant || {};
            const matchingItems = (order.items || []).filter(item => {
              const itemVariant = item.variant || {};
              return String(item.productId || '') === String(retItem.productId || '') &&
                String(itemVariant.size || '') === String(variant.size || '') &&
                String(itemVariant.color || '') === String(variant.color || '');
            });
            const owners = [...new Set(matchingItems.map(item => String(item.vendorId || '')))];
            if (owners.length !== 1) return sum;
            return owners[0] === vendorId ? sum + Math.max(0, Number(retItem.delta) || 0) : sum;
          }, 0);
          if (returnedQty <= 0) continue;
          const debit = order.vendorDebits?.[`${vendorId}_ret${returnIndex}`];
          const feeRef = db.collection('order_return_fees').doc(returnFeeDocId(orderDoc.id, returnIndex, vendorId));
          const feeSnap = await feeRef.get();
          const feeRecord = feeSnap.exists ? feeSnap.data() : null;
          if (!debit?.txId) {
            if (!feeRecord || feeRecord.status !== 'validated' ||
                !Number.isFinite(Number(feeRecord.amount)) || Number(feeRecord.amount) <= 0) {
              blockers.push({ orderId: orderDoc.id, reason: `frais du retour ${returnIndex + 1} non renseignés pour ce vendeur` });
            } else {
              blockers.push({ orderId: orderDoc.id, reason: `débit du retour ${returnIndex + 1} en attente de rapprochement` });
            }
          } else {
            const hasFeeRecord = !!feeRecord;
            const expectedFee = Number(feeRecord?.amount ?? debit.amount);
            const feeRecordInvalid = hasFeeRecord && (
              feeRecord.orderId !== orderDoc.id ||
              feeRecord.vendorId !== vendorId ||
              Number(feeRecord.returnIndex) !== returnIndex ||
              feeRecord.status !== 'validated' ||
              !['manual', 'livo'].includes(feeRecord.source) ||
              !Number.isFinite(expectedFee) || expectedFee <= 0 ||
              !feeRecord.recordedAt ||
              (feeRecord.source === 'manual' && !feeRecord.recordedBy)
            );
            const debitSnap = await db.collection('wallet_transactions').doc(String(debit.txId)).get();
            const debitTx = debitSnap.exists ? debitSnap.data() : null;
            if (feeRecordInvalid ||
                !Number.isFinite(expectedFee) || expectedFee <= 0 ||
                Math.abs(Number(debit.amount) - expectedFee) > 0.01 ||
                Number(debit.returnedQty) !== returnedQty ||
                !debitTx || debitTx.vendorId !== vendorId || debitTx.orderId !== orderDoc.id ||
                debitTx.type !== 'return_fee' || Number(debitTx.amount) >= 0 ||
                Math.abs(Math.abs(Number(debitTx.amount)) - expectedFee) > 0.01 ||
                (hasFeeRecord && debit.source !== feeRecord.source)) {
              blockers.push({ orderId: orderDoc.id, reason: `écriture financière du retour ${returnIndex + 1} absente ou incohérente` });
            }
          }
        }
      }
    }

    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 300) break;
    if (orderPages >= 100) {
      blockers.push({ reason: 'contrôle des commandes incomplet : limite de pagination atteinte' });
      break;
    }
  }

  // Vérifier également les écritures pending indépendamment du solde agrégé.
  cursor = null;
  let txPages = 0;
  while (true) {
    let query = db.collection('wallet_transactions')
      .where('vendorId', '==', vendorId)
      .limit(300);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) break;
    txPages++;
    snap.docs.forEach(docSnap => {
      const tx = docSnap.data();
      if (tx.status === 'pending') {
        blockers.push({ reason: `écriture financière en attente (${docSnap.id})` });
      }
    });
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 300) break;
    if (txPages >= 100) {
      blockers.push({ reason: 'contrôle des écritures financières incomplet : limite de pagination atteinte' });
      break;
    }
  }

  return { blockers, scannedOrders };
}

/* ============================================================
   CF : adminVendorAction
   ============================================================ */
exports.adminVendorAction = onRequest({ invoker: 'public', region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 540, maxInstances: 2 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    const isAdmin = decoded.admin === true || (adminSnap.exists && adminSnap.data()?.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });
    }

    const vendorId = String(req.body?.vendorId || '').trim();
    const action = String(req.body?.action || '').trim();
    if (!vendorId || !['approved', 'rejected', 'suspended', 'deleted'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action invalide.' });
    }

    const vendorRef = db.collection('users').doc(vendorId);
    const vendorSnap = await vendorRef.get();
    if (!vendorSnap.exists || vendorSnap.data()?.role !== 'vendor') {
      return res.status(404).json({ success: false, message: 'Profil introuvable.' });
    }

    if (action === 'approved') {
      const vendorInfo = vendorSnap.data().vendorInfo || {};

      // Vérifier l'état réel dans Firebase Authentication, pas uniquement
      // le champ emailVerified du profil Firestore qui peut être obsolète.
      const vendorAuthUser = await getAuth().getUser(vendorId);
      if (vendorAuthUser.emailVerified !== true) {
        return res.status(409).json({
          success: false,
          message: 'Impossible d’approuver : le vendeur doit d’abord vérifier son adresse e-mail.'
        });
      }

      if (vendorInfo.contractStatus !== 'accepted') {
        return res.status(409).json({ success: false, message: 'Impossible d’approuver : contrat non signé.' });
      }
      if (String(vendorInfo.contractVersion || '') !== OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION) {
        return res.status(409).json({
          success: false,
          message: 'Impossible d’approuver : le vendeur doit accepter le contrat ' + OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION + '.'
        });
      }

      const contractId = vendorInfo.currentContractId ||
        (vendorInfo.contractVersion ? `contract_${vendorId}_v${vendorInfo.contractVersion}` : '');
      if (!contractId) {
        return res.status(409).json({ success: false, message: 'Impossible d’approuver : référence du contrat signée introuvable.' });
      }

      const contractSnap = await db.collection('contracts').doc(contractId).get();
      const contract = contractSnap.exists ? contractSnap.data() : null;
      if (
        !isOfficialVendorContract(vendorId, contract) ||
        String(contract.version) !== String(vendorInfo.contractVersion || contract.version)
      ) {
        return res.status(409).json({ success: false, message: 'Impossible d’approuver : le document du contrat signé est absent ou incohérent.' });
      }
    }

    if (action === 'deleted') {
      // Verrouiller le vendeur et retirer sa fiche publique AVANT les contrôles :
      // createCustomerOrder lit vendorsPublic dans sa transaction, qui sera ainsi
      // invalidée si une commande était en cours de création.
      const originalVendorInfo = vendorSnap.data().vendorInfo || {};
      const restoreStatus = originalVendorInfo.statusBeforeDeletion || originalVendorInfo.status || 'pending';
      await vendorRef.update({
        'vendorInfo.statusBeforeDeletion': restoreStatus,
        'vendorInfo.status': 'deletion_pending',
        'vendorInfo.statusUpdatedAt': FieldValue.serverTimestamp(),
        'vendorInfo.statusUpdatedBy': decoded.uid,
        updatedAt: FieldValue.serverTimestamp()
      });
      const restoreVendorListing = async () => {
        await vendorRef.update({
          'vendorInfo.status': restoreStatus,
          'vendorInfo.statusBeforeDeletion': FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp()
        });
        if (restoreStatus === 'approved' && originalVendorInfo.contractStatus === 'accepted') {
          await db.collection('vendorsPublic').doc(vendorId).set({
            shopName: originalVendorInfo.shopName || 'Boutique',
            status: 'approved',
            contractVersion: originalVendorInfo.contractVersion,
            description: originalVendorInfo.description || '',
            createdAt: vendorSnap.data().createdAt || FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
      };

      // Si le retrait de la fiche publique échoue, restaurer le compte au lieu
      // de laisser le vendeur bloqué en deletion_pending.
      try {
        await db.collection('vendorsPublic').doc(vendorId).delete();
      } catch (error) {
        await restoreVendorListing().catch(restoreError =>
          console.error('[adminVendorAction] restauration après échec vendorsPublic:', restoreError)
        );
        throw error;
      }

      // Protection financière et contrôle des commandes/écritures associées.
      const walletRef = db.collection('wallets').doc(vendorId);
      const payoutQuery = db.collection('payout_requests')
        .where('vendorId', '==', vendorId);
      let walletSnap;
      let payoutSnap;
      try {
        [walletSnap, payoutSnap] = await Promise.all([
          walletRef.get(),
          payoutQuery.get()
        ]);
      } catch (error) {
        await restoreVendorListing().catch(restoreError =>
          console.error('[adminVendorAction] restauration après échec lecture financière:', restoreError)
        );
        throw error;
      }

      const wallet = walletSnap.exists ? walletSnap.data() : {};
      const availableBalance = Number(wallet.availableBalance) || 0;
      const pendingBalance = Number(wallet.pendingBalance) || 0;
      const negativeBalance = Number(wallet.negativeBalance) || 0;
      const openPayouts = payoutSnap.docs.filter(docSnap => {
        const status = String(docSnap.data().status || 'pending').toLowerCase();
        return !['paid', 'rejected', 'cancelled', 'canceled'].includes(status);
      });

      const financialReasons = [];
      if (availableBalance > 0.0001) {
        financialReasons.push(`solde disponible de ${availableBalance.toFixed(2)} MAD`);
      }
      if (pendingBalance > 0.0001) {
        financialReasons.push(`solde en attente de ${pendingBalance.toFixed(2)} MAD`);
      }
      if (negativeBalance < -0.0001) {
        financialReasons.push(`dette vendeur de ${Math.abs(negativeBalance).toFixed(2)} MAD`);
      }
      if (openPayouts.length > 0) {
        financialReasons.push(`${openPayouts.length} demande(s) de retrait non traitée(s)`);
      }

      let settlement;
      try {
        settlement = await inspectVendorSettlement(vendorId);
      } catch (error) {
        await restoreVendorListing().catch(restoreError =>
          console.error('[adminVendorAction] restauration après échec audit financier:', restoreError)
        );
        throw error;
      }
      if (settlement.blockers.length > 0) {
        financialReasons.push(`${settlement.blockers.length} anomalie(s) de commande ou d'écriture financière`);
      }

      if (financialReasons.length > 0) {
        await restoreVendorListing();
        return res.status(409).json({
          success: false,
          code: 'VENDOR_FINANCIAL_SETTLEMENT_REQUIRED',
          message: `Suppression bloquée : ${financialReasons.join(' ; ')}. Réglez les soldes et clôturez les demandes de retrait avant de supprimer ce compte.`,
          financial: {
            availableBalance,
            pendingBalance,
            negativeBalance,
            openPayoutCount: openPayouts.length,
            scannedOrders: settlement.scannedOrders,
            blockers: settlement.blockers.slice(0, 20)
          }
        });
      }

      let deletedProducts = 0;

      // Nettoyage borné par requête pour éviter un dépassement du délai Cloud Functions.
      // Le profil et l'identité Firebase restent intacts tant qu'il reste des produits.
      for (let page = 0; page < 20; page++) {
        const productsSnap = await db.collection('products')
          .where('vendorId', '==', vendorId)
          .limit(400)
          .get();

        if (productsSnap.empty) break;

        const batch = db.batch();
        productsSnap.docs.forEach(docSnap => batch.delete(docSnap.ref));
        await batch.commit();
        deletedProducts += productsSnap.size;

        if (productsSnap.size < 400) break;
      }

      // Vérification explicite : ne jamais supprimer le compte si le nettoyage est incomplet.
      const remainingProducts = await db.collection('products')
        .where('vendorId', '==', vendorId)
        .limit(1)
        .get();

      if (!remainingProducts.empty) {
        return res.status(409).json({
          success: false,
          action,
          deletedProducts,
          productsRemaining: true,
          message: 'Suppression partielle : des produits restent à traiter. Relancez la suppression pour continuer.'
        });
      }

      // Supprimer uniquement les images produits de ce vendeur.
      // Si Storage échoue, conserver le compte et permettre une nouvelle tentative.
      await getStorage().bucket('smartswi9a-31063.firebasestorage.app')
        .deleteFiles({ prefix: `vendors/${vendorId}/products/` });

      // Retirer explicitement la fiche publique avant la suppression du profil.
      // Le trigger syncVendorPublic effectue aussi ce nettoyage, mais cet appel
      // synchrone garantit qu'une boutique ne reste pas publiée si le trigger tarde.
      await db.collection('vendorsPublic').doc(vendorId).delete();

      // Supprimer les identifiants vendeurs avant le profil, et ne pas masquer une erreur réelle.
      await db.collection('vendorCredentials').doc(vendorId).delete().catch(error => {
        if (error.code !== 5) throw error; // NOT_FOUND
      });

      // Un utilisateur déjà absent est considéré comme nettoyé ; toute autre erreur bloque la suite.
      try {
        await getAuth().deleteUser(vendorId);
      } catch (error) {
        if (error.code !== 'auth/user-not-found') throw error;
      }

      await vendorRef.delete();

      return res.status(200).json({ success: true, action, deletedProducts });
    }

    const previousStatus = vendorSnap.data()?.vendorInfo?.status || 'pending';
    const suspensionType = String(req.body?.suspensionType || '').trim();
    const suspensionCause = String(req.body?.suspensionCause || '').trim().slice(0, 300);
    const suspensionUntil = String(req.body?.suspensionUntil || '').trim().slice(0, 32);

    if (action === 'suspended' && !suspensionCause) {
      return res.status(400).json({ success: false, message: 'La cause de la suspension est obligatoire.' });
    }

    const vendorUpdate = {
      'vendorInfo.status': action,
      'vendorInfo.statusUpdatedAt': FieldValue.serverTimestamp(),
      'vendorInfo.statusUpdatedBy': decoded.uid,
      updatedAt: FieldValue.serverTimestamp()
    };
    if (action === 'approved') {
      // Le taux de commission est défini côté serveur, jamais par le vendeur.
      vendorUpdate['vendorInfo.commissionRate'] = OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE;
      vendorUpdate['vendorInfo.commissionRateMin'] = OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE_MIN;
      vendorUpdate['vendorInfo.commissionRateMax'] = OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE_MAX;
      // Lever la suspension : aucun motif residuel ne doit rester sur le profil.
      vendorUpdate['vendorInfo.suspension'] = FieldValue.delete();
      vendorUpdate['vendorInfo.suspendedAt'] = FieldValue.delete();
      vendorUpdate['vendorInfo.suspensionReason'] = FieldValue.delete();
      vendorUpdate.suspended = false;
    }
    if (action === 'suspended') {
      /* Type + cause obligatoires : le trigger onUserWritten les reprend
         pour le push et l email au vendeur. */
      vendorUpdate['vendorInfo.suspension'] = {
        type: suspensionType === 'permanent' ? 'permanent' : 'temporary',
        cause: suspensionCause,
        until: suspensionType === 'permanent' ? '' : suspensionUntil,
        at: new Date().toISOString(),
        by: decoded.uid
      };
      vendorUpdate['vendorInfo.suspendedAt'] = FieldValue.serverTimestamp();
      vendorUpdate['vendorInfo.suspensionReason'] = suspensionCause;
      vendorUpdate.suspended = true;
    }
    await vendorRef.update(vendorUpdate);

    /* Reactivation : onUserWritten ne notifie que les nouvelles suspensions,
       on envoie donc ici le push + in-app de reactivation. */
    if (action === 'approved' && previousStatus === 'suspended') {
      try {
        const { notifyVendor } = require('./notifications');
        await notifyVendor(vendorId, {
          type: 'vendor_reactivated',
          title: 'Compte vendeur réactivé',
          body: 'Votre compte vendeur est de nouveau actif : vous pouvez publier et vendre.',
          targetUrl: '/vendor/dashboard',
          tag: `vendor-reactivated-${vendorId}-${Date.now()}`
        });
      } catch (notifyError) {
        console.error('[adminVendorAction] notification réactivation :', notifyError);
      }
    }

    return res.status(200).json({ success: true, action });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

function returnFeeDocId(orderId, returnIndex, vendorId) {
  return `${orderId}_ret${returnIndex}_${vendorId}`;
}

/* ============================================================
   CF : adminSetReturnFee
   Enregistre un justificatif isolé par commande, retour et vendeur.
   ============================================================ */
exports.adminSetReturnFee = onRequest({ invoker: 'public', region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    const isAdmin = decoded.admin === true || (adminSnap.exists && adminSnap.data()?.role === 'admin');
    if (!isAdmin) return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });

    const orderId = String(req.body?.orderId || '').trim();
    const returnIndex = Number(req.body?.returnIndex);
    const vendorId = String(req.body?.vendorId || '').trim();
    const amount = Number(req.body?.amount);
    if (!orderId || orderId.length > 128 || !Number.isInteger(returnIndex) || returnIndex < 0 ||
        !vendorId || vendorId.length > 128 || !Number.isFinite(amount) || amount <= 0 || amount > 100000) {
      return res.status(400).json({ success: false, message: 'Commande, retour, vendeur ou montant invalide.' });
    }

    const orderRef = db.collection('orders').doc(orderId);
    const vendorRef = db.collection('users').doc(vendorId);
    const feeRef = db.collection('order_return_fees').doc(returnFeeDocId(orderId, returnIndex, vendorId));

    await db.runTransaction(async tx => {
      const [orderSnap, vendorSnap, feeSnap] = await Promise.all([
        tx.get(orderRef), tx.get(vendorRef), tx.get(feeRef)
      ]);
      if (!orderSnap.exists) throw new Error('Commande introuvable.');
      const order = orderSnap.data();
      const returns = Array.isArray(order.returns) ? order.returns : [];
      const entry = returns[returnIndex];
      if (order.status !== 'returned' || !entry || !Array.isArray(entry.items)) {
        throw new Error('Retour introuvable ou commande non retournée.');
      }
      if (feeSnap.exists) throw new Error('Un montant a déjà été enregistré pour ce vendeur et ce retour.');
      if (order.vendorDebits?.[`${vendorId}_ret${returnIndex}`]) {
        throw new Error('Ce frais a déjà été débité : aucun second débit n’est autorisé.');
      }

      const vendorData = vendorSnap.exists ? vendorSnap.data() : null;
      if (!vendorData || vendorData.role !== 'vendor' ||
          vendorData.vendorInfo?.contractStatus !== 'accepted' ||
          String(vendorData.vendorInfo?.contractVersion || '') !== OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION) {
        throw new Error('Le vendeur doit accepter le nouveau contrat ' + OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION + ' avant l’application de ces frais.');
      }

      const orderedByVariant = {};
      for (const item of (order.items || [])) {
        if (String(item.vendorId || '') !== vendorId) continue;
        const variant = item.variant || {};
        const key = JSON.stringify([String(item.productId || ''), String(variant.size || ''), String(variant.color || '')]);
        orderedByVariant[key] = (orderedByVariant[key] || 0) + (Number(item.quantity) || 0);
      }
      const cumulativeByVariant = {};
      for (let idx = 0; idx < returns.length; idx++) {
        for (const retItem of (returns[idx]?.items || [])) {
          const variant = retItem.variant || {};
          const productId = String(retItem.productId || '');
          const matchingItems = (order.items || []).filter(item => {
            const itemVariant = item.variant || {};
            return String(item.productId || '') === productId &&
              String(itemVariant.size || '') === String(variant.size || '') &&
              String(itemVariant.color || '') === String(variant.color || '');
          });
          const owners = [...new Set(matchingItems.map(item => String(item.vendorId || '')))];
          const delta = Number(retItem.delta);
          if (!productId || !Number.isInteger(delta) || delta <= 0 || owners.length !== 1) {
            throw new Error('Produit, propriétaire ou quantité de retour invalide.');
          }
          if (owners[0] !== vendorId) continue;
          const key = JSON.stringify([productId, String(variant.size || ''), String(variant.color || '')]);
          cumulativeByVariant[key] = (cumulativeByVariant[key] || 0) + delta;
          if (!orderedByVariant[key] || cumulativeByVariant[key] > orderedByVariant[key]) {
            throw new Error('La quantité retournée dépasse la quantité commandée.');
          }
        }
      }

      let returnedQty = 0;
      let vendorName = '';
      for (const retItem of entry.items) {
        const variant = retItem.variant || {};
        const productId = String(retItem.productId || '');
        const matchingItems = (order.items || []).filter(item => {
          const itemVariant = item.variant || {};
          return String(item.productId || '') === productId &&
            String(itemVariant.size || '') === String(variant.size || '') &&
            String(itemVariant.color || '') === String(variant.color || '');
        });
        const owners = [...new Set(matchingItems.map(item => String(item.vendorId || '')))];
        if (owners.length !== 1) throw new Error('Une ligne retournée est absente ou ambiguë dans la commande.');
        if (owners[0] === vendorId) {
          const vendorItems = matchingItems.filter(item => String(item.vendorId || '') === vendorId);
          returnedQty += Number(retItem.delta);
          vendorName = String(vendorItems[0]?.vendorName || vendorItems[0]?.shopName || vendorData.vendorInfo?.shopName || vendorData.name || 'Vendeur').slice(0, 120);
        }
      }
      if (!Number.isInteger(returnedQty) || returnedQty <= 0) {
        throw new Error('Ce vendeur ne possède aucun article dans ce retour.');
      }

      tx.create(feeRef, {
        orderId,
        returnIndex,
        vendorId,
        vendorName,
        amount: Math.round(amount * 100) / 100,
        currency: 'MAD',
        source: 'manual',
        status: 'validated',
        returnedQty,
        recordedAt: FieldValue.serverTimestamp(),
        recordedBy: decoded.uid,
        createdAt: FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ success: true, message: 'Montant enregistré. Le débit sécurisé sera rapproché automatiquement.' });
  } catch (error) {
    const message = error.message || 'Erreur serveur.';
    if (/nouveau contrat 1\.4\.0/i.test(message)) {
      return res.status(409).json({ success: false, code: 'VENDOR_CONTRACT_UPDATE_REQUIRED', message });
    }
    const clientError = /introuvable|invalide|retournée|correspond pas|aucun article|déjà été enregistré|déjà été débité|dépasse la quantité/i.test(message);
    return res.status(clientError ? 400 : 500).json({ success: false, message });
  }
});

/* ============================================================
   CF : requestWithdrawal (B-C2 : check vendeur approuvé)
   ============================================================ */
exports.requestWithdrawal = onRequest({ invoker: 'public', region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    const amount = Number(req.body?.amount);
    const method = String(req.body?.method || '').trim();

    // Identité du bénéficiaire : l'admin dépose le montant à l'agence au nom
    // du vendeur, ces informations sont donc obligatoires et validées ici.
    const firstName = String(req.body?.firstName || '').trim();
    const lastName = String(req.body?.lastName || '').trim();
    const cin = String(req.body?.cin || '').trim().toUpperCase();
    const phone = normalizeMoroccanPhone(req.body?.phone || req.body?.account || '');
    // `account` est l'ancien nom du champ de réception : conservé égal à `phone`
    // pour ne pas casser les demandes déjà enregistrées.
    const account = phone || '';

    if (!Number.isFinite(amount) || amount < 200) {
      return res.status(400).json({ success: false, message: 'Montant invalide. Minimum 200 MAD.' });
    }

    const allowedMethods = new Set(['Wafacash', 'CashPlus']);
    if (!allowedMethods.has(method)) {
      return res.status(400).json({ success: false, message: 'Réseau de retrait invalide (Wafacash ou CashPlus).' });
    }

    if (firstName.length < 2 || firstName.length > 60) {
      return res.status(400).json({ success: false, message: 'Prénom invalide (2 à 60 caractères).' });
    }
    if (lastName.length < 2 || lastName.length > 60) {
      return res.status(400).json({ success: false, message: 'Nom invalide (2 à 60 caractères).' });
    }
    if (!isValidMoroccanCin(cin)) {
      return res.status(400).json({ success: false, message: 'CIN invalide (ex : AB123456).' });
    }
    if (!/^(?:\+212|0)[67]\d{8}$/.test(phone || '')) {
      return res.status(400).json({ success: false, message: 'Numéro de téléphone invalide (06XXXXXXXX ou 07XXXXXXXX).' });
    }

    // Aucun frais n'est retenu par Smart Swika : l'admin dépose exactement le
    // montant demandé. Les frais de retrait sont déduits par l'agence
    // Wafacash/CashPlus et ne concernent pas la plateforme.

    const vendorRef = db.collection('users').doc(decoded.uid);
    const walletRef = db.collection('wallets').doc(decoded.uid);
    const payoutRef = db.collection('payout_requests').doc();
    const pendingQuery = db.collection('payout_requests')
      .where('vendorId', '==', decoded.uid)
      .where('status', '==', 'pending');

    // Transaction atomique : empêche deux demandes simultanées de passer
    // le contrôle du solde et de l'unicité d'une demande en attente.
    await db.runTransaction(async tx => {
      const [vendorSnap, walletSnap, pendingSnap] = await Promise.all([
        tx.get(vendorRef),
        tx.get(walletRef),
        tx.get(pendingQuery)
      ]);

      if (!vendorSnap.exists || vendorSnap.data()?.role !== 'vendor') {
        throw new Error('Profil vendeur introuvable.');
      }

      const vendorData = vendorSnap.data();
      if (vendorData.vendorInfo?.status !== 'approved' ||
          vendorData.vendorInfo?.contractStatus !== 'accepted' ||
          String(vendorData.vendorInfo?.contractVersion || '') !== OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION) {
        throw new Error('Votre compte vendeur doit être approuvé et votre contrat accepté.');
      }

      // Statut portefeuille : un compte gele (litige) ou suspendu (dette)
      // ne peut demander aucun retrait. 'active' par defaut pour ne pas
      // bloquer les vendeurs qui n'ont pas encore le champ.
      const walletStatus = normalizeWalletStatus(vendorData);
      if (walletStatus === WALLET_STATUS.FROZEN) {
        throw new Error('Retrait impossible : vos fonds sont gelés suite à un litige en cours.');
      }
      if (walletStatus === WALLET_STATUS.SUSPENDED) {
        throw new Error('Retrait impossible : votre portefeuille est suspendu (solde débiteur à régulariser).');
      }

      if (!walletSnap.exists) throw new Error('Wallet introuvable.');
      if (!pendingSnap.empty) throw new Error('Une demande de retrait est déjà en cours.');

      const walletData = walletSnap.data();
      if ((Number(walletData.negativeBalance) || 0) < -0.0001) {
        throw new Error('Retrait impossible : votre portefeuille présente un solde débiteur à régulariser.');
      }
      const balance = Number(walletData.availableBalance);
      if (!Number.isFinite(balance) || amount > balance) {
        throw new Error('Solde insuffisant.');
      }

      // Cette écriture sur le wallet force les transactions concurrentes
      // à se rejouer et à constater la demande déjà créée.
      tx.update(walletRef, {
        payoutRequestVersion: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp()
      });

      tx.create(payoutRef, {
        vendorId: decoded.uid,
        vendorName: String(vendorData.vendorInfo?.shopName || vendorData.name || 'Vendeur').slice(0, 120),
        firstName,
        lastName,
        cin,
        phone,
        amount,
        method,
        account,
        status: 'pending',
        transferNumber: null,
        sentAt: null,
        requestedAt: FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    const message = error.message || 'Erreur serveur.';
    const clientError = /introuvable|invalide|minimum|coordonnées|méthode|réseau|prénom|\bnom\b|CIN|téléphone|solde insuffisant|solde débiteur|retrait impossible|déjà en cours|doit être approuvé/i.test(message);
    return res.status(clientError ? 400 : 500).json({ success: false, message });
  }
});

/* ============================================================
   CF : adminManageWallet (gestion du statut portefeuille vendeur)
   ============================================================ */
exports.adminManageWallet = onRequest({
  invoker: 'public',
  region: 'europe-west1',
  cors: [...ALLOWED_ORIGINS],
  timeoutSeconds: 30
}, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    const isAdmin = decoded.admin === true || (adminSnap.exists && adminSnap.data()?.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });
    }

    const vendorId = String(req.body?.vendorId || '').trim();
    const action = String(req.body?.action || '').trim();
    const reason = String(req.body?.reason || '').trim().slice(0, 500);

    if (!vendorId || vendorId.length > 128) {
      return res.status(400).json({ success: false, message: 'Vendeur invalide.' });
    }

    const ACTIONS = {
      freeze:        { status: WALLET_STATUS.FROZEN,    label: 'Portefeuille gelé' },
      unfreeze:      { status: WALLET_STATUS.ACTIVE,    label: 'Portefeuille débloqué' },
      suspend:       { status: WALLET_STATUS.SUSPENDED, label: 'Portefeuille suspendu' },
      reactivate:    { status: WALLET_STATUS.ACTIVE,    label: 'Portefeuille réactivé' }
    };
    const decision = ACTIONS[action];
    if (!decision) {
      return res.status(400).json({ success: false, message: 'Action invalide.' });
    }

    const vendorRef = db.collection('users').doc(vendorId);
    const previous = await db.runTransaction(async tx => {
      const snap = await tx.get(vendorRef);
      if (!snap.exists || snap.data()?.role !== 'vendor') {
        throw new Error('Profil vendeur introuvable.');
      }
      const before = normalizeWalletStatus(snap.data());
      tx.update(vendorRef, {
        wallet_status: decision.status,
        wallet_status_updated_at: FieldValue.serverTimestamp(),
        wallet_status_updated_by: decoded.uid,
        wallet_status_reason: reason || null,
        updatedAt: FieldValue.serverTimestamp()
      });
      return before;
    });

    return res.status(200).json({
      success: true,
      action,
      previousStatus: previous,
      wallet_status: decision.status,
      message: decision.label + '.'
    });
  } catch (error) {
    const message = error.message || 'Erreur serveur.';
    const clientError = /introuvable|invalide/i.test(message);
    return res.status(clientError ? 400 : 500).json({ success: false, message });
  }
});

/* ============================================================
   DÉBIT SÉCURISÉ D'UN FRAIS DE RETOUR
   Le document justificatif est séparé de la commande et idempotent.
   ============================================================ */
async function processReturnFeeDebit(orderId, returnIndex, vendorId) {
  const orderRef = db.collection('orders').doc(orderId);
  const feeRef = db.collection('order_return_fees').doc(returnFeeDocId(orderId, returnIndex, vendorId));
  const vendorRef = db.collection('users').doc(vendorId);
  const walletRef = db.collection('wallets').doc(vendorId);
  const debitKey = `${vendorId}_ret${returnIndex}`;

  await db.runTransaction(async tx => {
    const [orderSnap, feeSnap, vendorSnap] = await Promise.all([
      tx.get(orderRef), tx.get(feeRef), tx.get(vendorRef)
    ]);
    if (!orderSnap.exists || !feeSnap.exists) return;
    const order = orderSnap.data();
    const feeRecord = feeSnap.data();
    if (order.status !== 'returned') return;
    if (order.vendorDebits?.[debitKey]) return;
    if (feeRecord.orderId !== orderId || feeRecord.vendorId !== vendorId ||
        Number(feeRecord.returnIndex) !== returnIndex ||
        feeRecord.status !== 'validated' ||
        !['manual', 'livo'].includes(feeRecord.source) ||
        !Number.isFinite(Number(feeRecord.amount)) || Number(feeRecord.amount) <= 0 ||
        !feeRecord.recordedAt ||
        (feeRecord.source === 'manual' && !feeRecord.recordedBy)) {
      throw new Error('Justificatif de frais de retour invalide.');
    }
    const vendorData = vendorSnap.exists ? vendorSnap.data() : null;
    if (!vendorData || vendorData.role !== 'vendor') {
      throw new Error('Profil vendeur introuvable pendant le retour.');
    }
    if (vendorData.vendorInfo?.contractStatus !== 'accepted' ||
        String(vendorData.vendorInfo?.contractVersion || '') !== OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION) {
      throw new Error('Débit retour bloqué : contrat vendeur ' + OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION + ' non accepté.');
    }
    if (vendorData.vendorInfo?.status === 'deletion_pending') {
      throw new Error('Débit retour bloqué : suppression du compte en cours.');
    }

    const returns = Array.isArray(order.returns) ? order.returns : [];
    const entry = returns[returnIndex];
    if (!entry || !Array.isArray(entry.items)) throw new Error('Détail du retour introuvable.');

    const orderedByVariant = {};
    for (const item of (order.items || [])) {
      if (String(item.vendorId || '') !== vendorId) continue;
      const variant = item.variant || {};
      const key = JSON.stringify([String(item.productId || ''), String(variant.size || ''), String(variant.color || '')]);
      orderedByVariant[key] = (orderedByVariant[key] || 0) + (Number(item.quantity) || 0);
    }
    const cumulativeByVariant = {};
    for (let idx = 0; idx < returns.length; idx++) {
      for (const retItem of (returns[idx]?.items || [])) {
        const variant = retItem.variant || {};
        const productId = String(retItem.productId || '');
        const matchingItems = (order.items || []).filter(item => {
          const itemVariant = item.variant || {};
          return String(item.productId || '') === productId &&
            String(itemVariant.size || '') === String(variant.size || '') &&
            String(itemVariant.color || '') === String(variant.color || '');
        });
        const owners = [...new Set(matchingItems.map(item => String(item.vendorId || '')))];
        const delta = Number(retItem.delta);
        if (!productId || !Number.isInteger(delta) || delta <= 0 || owners.length !== 1) {
          throw new Error('Produit, propriétaire ou quantité de retour invalide pour la commande ' + orderId);
        }
        if (owners[0] !== vendorId) continue;
        const key = JSON.stringify([productId, String(variant.size || ''), String(variant.color || '')]);
        cumulativeByVariant[key] = (cumulativeByVariant[key] || 0) + delta;
        if (!orderedByVariant[key] || cumulativeByVariant[key] > orderedByVariant[key]) {
          throw new Error('Quantité retournée supérieure à la quantité commandée pour ' + key);
        }
      }
    }

    let returnedQty = 0;
    for (const retItem of entry.items) {
      const variant = retItem.variant || {};
      const productId = String(retItem.productId || '');
      const matchingItems = (order.items || []).filter(item => {
        const itemVariant = item.variant || {};
        return String(item.productId || '') === productId &&
          String(itemVariant.size || '') === String(variant.size || '') &&
          String(itemVariant.color || '') === String(variant.color || '');
      });
      const owners = [...new Set(matchingItems.map(item => String(item.vendorId || '')))];
      if (owners.length !== 1) throw new Error('Ligne retournée absente ou ambiguë pour la commande ' + orderId);
      if (owners[0] === vendorId) returnedQty += Number(retItem.delta);
    }
    if (!Number.isInteger(returnedQty) || returnedQty <= 0 ||
        Number(feeRecord.returnedQty) !== returnedQty) {
      throw new Error('Quantité retournée incohérente avec le justificatif des frais.');
    }

    const walletSnap = await tx.get(walletRef);
    const wallet = walletSnap.exists ? walletSnap.data() : {
      vendorId, pendingBalance: 0, availableBalance: 0, negativeBalance: 0,
      totalEarnings: 0, totalWithdrawn: 0,
      createdAt: FieldValue.serverTimestamp()
    };

    const saleTxId = order.vendorCredits?.[vendorId]?.txId;
    const saleTxRef = saleTxId ? db.collection('wallet_transactions').doc(String(saleTxId)) : null;
    const saleTxSnap = saleTxRef ? await tx.get(saleTxRef) : null;
    const saleTx = saleTxSnap?.exists ? saleTxSnap.data() : null;
    const salePendingRemaining = saleTx && saleTx.status === 'pending'
      ? Math.max(0, (Number(saleTx.amount) || 0) -
          (Number(saleTx.reversedAmount) || 0) -
          (Number(saleTx.releasedAmount) || 0))
      : 0;

    const fee = Number(feeRecord.amount);
    let pending = Number(wallet.pendingBalance) || 0;
    let available = Number(wallet.availableBalance) || 0;
    let negative = Number(wallet.negativeBalance) || 0;
    let remaining = fee;

    const fromPending = Math.min(Math.max(0, pending), remaining, salePendingRemaining);
    pending -= fromPending;
    remaining -= fromPending;
    const fromAvailable = Math.min(Math.max(0, available), remaining);
    available -= fromAvailable;
    remaining -= fromAvailable;
    if (remaining > 0) negative -= remaining;

    const txRef = db.collection('wallet_transactions').doc();
    const walletUpdate = {
      vendorId, pendingBalance: pending, availableBalance: available,
      negativeBalance: negative,
      totalEarnings: Number(wallet.totalEarnings) || 0,
      totalWithdrawn: Number(wallet.totalWithdrawn) || 0,
      lastUpdated: FieldValue.serverTimestamp()
    };
    if (walletSnap.exists) tx.update(walletRef, walletUpdate);
    else tx.set(walletRef, { ...wallet, ...walletUpdate });

    if (fromPending > 0 && saleTxRef && saleTxSnap?.exists) {
      tx.update(saleTxRef, {
        reversedAmount: FieldValue.increment(fromPending),
        returnOffsetAmount: FieldValue.increment(fromPending),
        lastReturnOffsetAt: FieldValue.serverTimestamp()
      });
    }

    tx.create(txRef, {
      vendorId,
      type: 'return_fee',
      amount: -fee,
      source: feeRecord.source,
      feeRecordedAt: feeRecord.recordedAt,
      feeRecordedBy: feeRecord.recordedBy || null,
      pendingOffsetAmount: fromPending,
      availableOffsetAmount: fromAvailable,
      debtAmount: remaining,
      orderId, returnIndex, returnedQty,
      status: 'released',
      description: `Frais retour commande #${orderId.slice(0, 8).toUpperCase()} (${feeRecord.source})`,
      createdAt: FieldValue.serverTimestamp()
    });
    tx.update(orderRef, {
      [`vendorDebits.${debitKey}`]: {
        debitedAt: FieldValue.serverTimestamp(),
        amount: fee,
        returnedQty,
        pendingOffsetAmount: fromPending,
        availableOffsetAmount: fromAvailable,
        debtAmount: remaining,
        txId: txRef.id
      }
    });
  });
}

exports.onOrderReturnFeeCreated = onDocumentCreated(
  { document: 'order_return_fees/{feeId}', retry: true },
  async event => {
    const fee = event.data.data();
    if (!fee?.orderId || !Number.isInteger(Number(fee.returnIndex)) || !fee?.vendorId) return;
    await processReturnFeeDebit(String(fee.orderId), Number(fee.returnIndex), String(fee.vendorId));
  }
);

/* ============================================================
   CF : onOrderStatusChanged (Trigger)
   ============================================================ */
exports.onOrderStatusChanged = onDocumentUpdated({ document: 'orders/{orderId}', retry: true }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();

  const orderId = event.params.orderId;

  // Synchroniser uniquement le statut dans les vues privées de chaque vendeur.
  // Les articles et montants propres à chaque vendeur restent cloisonnés.
  // Filet de securite : si le webhook Livo n'a pas pose la date (commande
  // passee en livraison/livree par un autre chemin), on l'ancre ici pour que
  // le chrono 7/15 jours ne soit jamais perdu.
  // - `shipping` : prise en charge logistique confirmee.
  // - `delivered` sans ancre : on utilise createdAt (date de commande) puis
  //   updatedAt comme repli, afin de ne jamais bloquer un credit legitime.
  const trackingFallbackStatuses = ['shipping', 'delivered'];
  if (trackingFallbackStatuses.includes(after.status) && !after.trackingStartedAt) {
    const fallbackDate = after.status === 'shipping'
      ? FieldValue.serverTimestamp()
      : (after.createdAt || after.updatedAt || FieldValue.serverTimestamp());
    const trackingStartedFrom = after.status === 'shipping'
      ? 'status_transition'
      : 'status_transition_delivered_fallback';
    await db.collection('orders').doc(orderId).update({
      trackingStartedAt: fallbackDate,
      trackingStartedFrom
    }).catch(err => console.error('[onOrderStatusChanged] trackingStartedAt :', err.message));
    after.trackingStartedAt = after.status === 'shipping'
      ? new Date()
      : (after.createdAt || after.updatedAt || new Date());
  }

  if (before.status !== after.status && Array.isArray(after.vendorIds)) {
    await Promise.all(after.vendorIds.map(vendorId =>
      db.collection('vendor_orders').doc(String(vendorId))
        .collection('orders').doc(orderId)
        .set({
          status: after.status,
          updatedAt: after.updatedAt || FieldValue.serverTimestamp()
        }, { merge: true })
    ));
  }

  // Le trigger est aussi relancé lorsqu'un administrateur valide les frais
  // d'un retour déjà enregistré. Les débits sont idempotents via vendorDebits.

  // Notifications client générées côté serveur (idempotentes).
  // Les vendeurs ne peuvent pas créer librement des notifications dans Firestore.
  if (after.status === 'delivered' && before.status !== 'delivered' && after.userId) {
    const deliveryNotificationRef = db.collection('notifications').doc('order_delivered_' + orderId);
    const reviewNotificationRef = db.collection('notifications').doc('review_request_' + orderId);
    await db.runTransaction(async tx => {
      const [deliverySnap, reviewSnap] = await Promise.all([
        tx.get(deliveryNotificationRef),
        tx.get(reviewNotificationRef)
      ]);
      const shortId = orderId.slice(0, 8).toUpperCase();
      if (!deliverySnap.exists) {
        tx.create(deliveryNotificationRef, {
          userId: after.userId,
          type: 'order_delivered',
          title: 'Commande livrée',
          message: 'Votre commande #' + shortId + ' est livrée !',
          orderId,
          read: false,
          createdAt: FieldValue.serverTimestamp()
        });
      }
      if (!reviewSnap.exists) {
        tx.create(reviewNotificationRef, {
          userId: after.userId,
          type: 'review_request',
          title: 'Laissez un avis',
          message: 'Votre commande #' + shortId + ' est livrée ! Partagez votre expérience.',
          orderId,
          persistent: true,
          read: false,
          createdAt: FieldValue.serverTimestamp()
        });
      }
    });
  }

  // Crédit vendeur
  if (after.status === 'delivered' && before.status !== 'delivered') {
    const vendorItems = {};
    (after.items || []).forEach(item => {
      if (item.vendorId && item.vendorId !== 'smartswi9a') {
        if (!vendorItems[item.vendorId]) vendorItems[item.vendorId] = 0;
        vendorItems[item.vendorId] += (Number(item.price) || 0) * (Number(item.quantity) || 0);
      }
    });

    for (const [vendorId, subtotal] of Object.entries(vendorItems)) {
      try {
        const alreadyCredited = after.vendorCredits && after.vendorCredits[vendorId];
        if (alreadyCredited) continue;

        const vendorSnap = await db.collection('users').doc(vendorId).get();
        if (!vendorSnap.exists) continue;

        const configuredRate = Number(vendorSnap.data().vendorInfo?.commissionRate);
        const rate = Number.isFinite(configuredRate) &&
          configuredRate >= OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE_MIN &&
          configuredRate <= OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE_MAX
          ? configuredRate
          : OFFICIAL_VENDOR_CONFIG.COMMISSION_RATE;
        const commission = Math.round(subtotal * rate * 100) / 100;
        const net = Math.round((subtotal - commission) * 100) / 100;
        if (net <= 0) continue;

        const walletRef = db.collection('wallets').doc(vendorId);

        // Le deblocage part de la prise en charge par Livo (trackingStartedAt),
        // jamais de la date de commande : 7 jours pour une vente vendeur,
        // 15 jours pour un produit Smart Swika. Les deux valeurs viennent des
        // constantes officielles du contrat, aucune duree en dur.
        const creditBase = resolveCreditUnlockBase(after);
        if (!creditBase.ok) {
          console.error('[onOrderStatusChanged] Deblocage differe (commande ' + orderId + ') : ' + creditBase.reason);
          continue;
        }
        const unlockAt = addDaysToDate(creditBase.date, creditBase.unlockDays);

        await db.runTransaction(async (tx) => {
          const orderRef = db.collection('orders').doc(orderId);
          const freshOrderSnap = await tx.get(orderRef);
          if (!freshOrderSnap.exists) return;
          const freshOrder = freshOrderSnap.data();

          // Une invocation retardée du trigger "delivered" ne doit jamais
          // créditer une vente si la commande est déjà passée à "returned"
          // ou à un autre statut depuis l'événement initial.
          if (freshOrder.status !== 'delivered') return;
          if (freshOrder.vendorCredits && freshOrder.vendorCredits[vendorId]) return;

          // Lecture du profil dans la transaction : le verrou deletion_pending
          // invalide/rejoue un crédit qui serait concurrent à une suppression.
          const freshVendorSnap = await tx.get(db.collection('users').doc(vendorId));
          if (!freshVendorSnap.exists || freshVendorSnap.data()?.role !== 'vendor') return;
          if (freshVendorSnap.data()?.vendorInfo?.status === 'deletion_pending') {
            throw new Error('Crédit vendeur bloqué : suppression du compte en cours.');
          }

          const freshWalletSnap = await tx.get(walletRef);
          const wallet = freshWalletSnap.exists ? freshWalletSnap.data() : {
            pendingBalance: 0,
            availableBalance: 0,
            negativeBalance: 0,
            totalEarnings: 0,
            totalWithdrawn: 0
          };
          const currentDebt = Math.max(0, -(Number(wallet.negativeBalance) || 0));
          const debtOffset = Math.min(net, currentDebt);
          const pendingCredit = Math.max(0, net - debtOffset);
          const nextDebt = Math.min(0, (Number(wallet.negativeBalance) || 0) + debtOffset);
          const walletUpdate = {
            vendorId,
            pendingBalance: Math.max(0, Number(wallet.pendingBalance) || 0) + pendingCredit,
            availableBalance: Number(wallet.availableBalance) || 0,
            negativeBalance: nextDebt,
            totalEarnings: (Number(wallet.totalEarnings) || 0) + net,
            totalWithdrawn: Number(wallet.totalWithdrawn) || 0,
            lastUpdated: FieldValue.serverTimestamp()
          };
          if (freshWalletSnap.exists) tx.update(walletRef, walletUpdate);
          else tx.set(walletRef, { ...walletUpdate, createdAt: FieldValue.serverTimestamp() });

          const txRef = db.collection('wallet_transactions').doc();
          tx.set(txRef, {
            vendorId,
            type: 'sale',
            amount: net,
            reversedAmount: debtOffset,
            releasedAmount: 0,
            debtOffsetAmount: debtOffset,
            commission,
            commissionRate: rate,
            subtotal,
            orderId,
            status: 'pending',
            unlockAt,
            description: `Vente commande #${orderId.slice(0, 8).toUpperCase()}`,
            createdAt: FieldValue.serverTimestamp()
          });

          tx.update(orderRef, {
            [`vendorCredits.${vendorId}`]: {
              creditedAt: FieldValue.serverTimestamp(),
              amount: net,
              txId: txRef.id
            }
          });
        });
      } catch (err) {
        console.error(`[onOrderStatusChanged] Erreur crédit vendeur ${vendorId}:`, err);
        throw err;
      }
    }
  }

  // Rejouer les justificatifs déjà créés si une commande repasse au statut retourné.
  // Le processeur est idempotent : une écriture wallet ne peut être créée qu'une fois.
  if (after.status === 'returned') {
    const feeSnap = await db.collection('order_return_fees')
      .where('orderId', '==', orderId)
      .get();
    for (const feeDoc of feeSnap.docs) {
      const fee = feeDoc.data();
      await processReturnFeeDebit(orderId, Number(fee.returnIndex), String(fee.vendorId));
    }
  }
});

/* ============================================================
   CF : createVerifiedReview
   Création d'avis avec vérification d'achat côté serveur.
   ============================================================ */
exports.createVerifiedReview = onRequest({ invoker: 'public', region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 30 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const productId = String(req.body?.productId ?? '').trim();
    const rating = Number(req.body?.rating);
    const title = String(req.body?.title || '').trim().slice(0, 80);
    const comment = String(req.body?.comment || '').trim().slice(0, 500);
    const photos = Array.isArray(req.body?.photos) ? req.body.photos.slice(0, 5) : [];

    if (!productId || productId.includes('/') || productId.length > 150 || !Number.isInteger(rating) || rating < 1 || rating > 5 || !comment) {
      return res.status(400).json({ success: false, message: 'Avis invalide.' });
    }
    for (const photo of photos) {
      if (typeof photo !== 'string' || photo.length > 2048) {
        return res.status(400).json({ success: false, message: 'Photo invalide.' });
      }
      let validPath = false;
      try {
        const parsed = new URL(photo);
        const decodedPath = decodeURIComponent(parsed.pathname);
        validPath = parsed.hostname === 'firebasestorage.googleapis.com' &&
          decodedPath.includes('/o/reviews/' + decoded.uid + '/');
      } catch (_) {}
      if (!validPath) return res.status(400).json({ success: false, message: 'Photo non autorisée.' });
    }

    const reviewId = 'review_' + decoded.uid + '_' + productId;
    const reviewRef = db.collection('reviews').doc(reviewId);
    const productRef = db.collection('products').doc(productId);
    const ordersSnap = await db.collection('orders')
      .where('userId', '==', decoded.uid)
      .where('status', 'in', ['delivered', 'received'])
      .limit(50)
      .get();

    const matchingOrder = ordersSnap.docs.find(docSnap =>
      (docSnap.data().items || []).some(item => String(item.productId) === productId)
    );
    if (!matchingOrder) {
      return res.status(403).json({ success: false, message: 'Un achat livré de ce produit est nécessaire pour publier un avis.' });
    }

    const result = await db.runTransaction(async tx => {
      const [reviewSnap, orderSnap, productSnap, userSnap] = await Promise.all([
        tx.get(reviewRef),
        tx.get(matchingOrder.ref),
        tx.get(productRef),
        tx.get(db.collection('users').doc(decoded.uid))
      ]);
      if (reviewSnap.exists) throw new Error('Vous avez déjà publié un avis pour ce produit.');
      if (!orderSnap.exists || !['delivered', 'received'].includes(orderSnap.data().status)) {
        throw new Error('La commande ne permet plus de vérifier cet achat.');
      }
      if (!(orderSnap.data().items || []).some(item => String(item.productId) === productId)) {
        throw new Error('Produit absent de la commande.');
      }
      if (!productSnap.exists) throw new Error('Produit introuvable.');
      const product = productSnap.data();
      const user = userSnap.exists ? userSnap.data() : {};
      const reviewData = {
        userId: decoded.uid,
        userName: String(user.name || decoded.name || decoded.email || 'Client').slice(0, 100),
        productId: /^\d+$/.test(productId) ? Number(productId) : productId,
        productName: String(product.nameFr || product.nameEn || product.nameAr || 'Produit').slice(0, 150),
        productSlug: String(product.slug || '').slice(0, 180),
        rating,
        title,
        comment,
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
        orderId: matchingOrder.id,
        photos,
        verifiedPurchase: true,
        serverVerified: true,
        likes: [],
        likesCount: 0,
        featured: false
      };
      tx.create(reviewRef, reviewData);
      return { reviewId, orderId: matchingOrder.id };
    });

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('[createVerifiedReview]', error);
    return res.status(400).json({ success: false, message: error.message || 'Création de l’avis impossible.' });
  }
});

/* ============================================================
   CF : backfillVendorOrderViews
   Migration idempotente des anciennes commandes vers les vues privées.
   ============================================================ */
exports.backfillVendorOrderViews = onRequest({ invoker: 'public', region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 60 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    const isAdmin = decoded.admin === true || (adminSnap.exists && adminSnap.data()?.role === 'admin');
    if (!isAdmin) return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });

    const pageSize = Math.max(1, Math.min(Number(req.body?.pageSize) || 100, 100));
    let query = db.collection('orders').orderBy(FieldPath.documentId()).limit(pageSize);
    const cursor = String(req.body?.cursor || '').trim();
    if (cursor) {
      const cursorSnap = await db.collection('orders').doc(cursor).get();
      if (!cursorSnap.exists) return res.status(400).json({ success: false, message: 'Curseur de migration introuvable.' });
      query = query.startAfter(cursorSnap);
    }

    const ordersSnap = await query.get();
    const writes = [];
    for (const orderDoc of ordersSnap.docs) {
      const order = orderDoc.data();
      const items = Array.isArray(order.items) ? order.items : [];
      const vendorIds = [...new Set(items
        .map(item => String(item.vendorId || 'smartswi9a'))
        .filter(vendorId => vendorId && vendorId !== 'smartswi9a'))];
      const containsPlatformItems = items.some(item => String(item.vendorId || 'smartswi9a') === 'smartswi9a');
      await orderDoc.ref.update({
        vendorIds,
        containsPlatformItems
      });

      for (const vendorId of vendorIds) {
        const vendorItems = items
          .filter(item => String(item.vendorId || '') === vendorId)
          .map(item => ({
            id: String(item.id || ''),
            productId: String(item.productId || ''),
            vendorId,
            shippingMethod: String(item.shippingMethod || ''),
            variant: item.variant && typeof item.variant === 'object'
              ? { size: String(item.variant.size || ''), color: String(item.variant.color || '') }
              : null,
            quantity: Number(item.quantity) || 0,
            price: Number(item.price) || 0,
            name: String(item.name || 'Produit').slice(0, 160)
          }));
        const vendorSubtotal = vendorItems.reduce(
          (sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0),
          0
        );
        const viewRef = db.collection('vendor_orders').doc(vendorId)
          .collection('orders').doc(orderDoc.id);
        writes.push({
          ref: viewRef,
          data: {
            orderId: orderDoc.id,
            vendorId,
            privacySafe: true,
            vendorCount: vendorIds.length + (items.some(item => String(item.vendorId || 'smartswi9a') === 'smartswi9a') ? 1 : 0),
            items: vendorItems,
            vendorSubtotal,
            status: order.status || 'pending',
            createdAt: order.createdAt || FieldValue.serverTimestamp(),
            updatedAt: order.updatedAt || FieldValue.serverTimestamp()
          }
        });
      }
    }

    for (let i = 0; i < writes.length; i += 400) {
      const batch = db.batch();
      // Remplacement complet pour effacer les coordonnées acheteur présentes
      // dans les anciennes projections vendeur.
      writes.slice(i, i + 400).forEach(write => batch.set(write.ref, write.data));
      await batch.commit();
    }

    const lastDoc = ordersSnap.docs[ordersSnap.docs.length - 1];
    return res.status(200).json({
      success: true,
      processedOrders: ordersSnap.size,
      vendorViewsWritten: writes.length,
      nextCursor: ordersSnap.size === pageSize && lastDoc ? lastDoc.id : null,
      complete: ordersSnap.size < pageSize
    });
  } catch (error) {
    console.error('[backfillVendorOrderViews]', error);
    return res.status(500).json({ success: false, message: 'Migration des commandes vendeurs impossible.' });
  }
});

/* ============================================================
   CF : createCustomerOrder
   ============================================================ */
exports.createCustomerOrder = onRequest({ invoker: 'public', region: 'europe-west1', maxInstances: 10, timeoutSeconds: 30, cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    const input = req.body || {};
    const delivery = input.deliveryInfo || {};
    const rawItems = Array.isArray(input.items) ? input.items : [];
    const suppliedRequestId = String(input.requestId || '').trim();
    if (suppliedRequestId && !/^[A-Za-z0-9_-]{20,80}$/.test(suppliedRequestId)) {
      return res.status(400).json({ success: false, message: 'Identifiant de demande invalide.' });
    }
    // Compatibilité avec les versions du site déjà publiées; les versions
    // récentes transmettent leur clé stable pour rendre les reprises idempotentes.
    const requestId = suppliedRequestId || crypto.randomUUID();

    if (!rawItems.length || rawItems.length > 50) {
      return res.status(400).json({ success: false, message: 'Panier vide ou trop volumineux.' });
    }
    for (const k of ['name', 'phone', 'address', 'city']) {
      if (typeof delivery[k] !== 'string' || !delivery[k].trim()) {
        return res.status(400).json({ success: false, message: `Champ obligatoire : ${k}` });
      }
    }

    /* K3 : pricingVersion 2 = nouveau bareme (Koulchi). Sans ce champ on
       conserve l ancien bareme, uniquement pour les clients deja en cache. */
    const pricingVersion = Math.max(0, Math.floor(Number(input.pricingVersion) || 0));

    const merged = new Map();
    for (const it of rawItems) {
      const productId = String(it?.productId ?? '').trim();
      const qty = Math.floor(Number(it?.quantity));
      if (!productId || !Number.isFinite(qty) || qty < 1 || qty > 99) {
        return res.status(400).json({ success: false, message: 'Article invalide.' });
      }
      const v = it.variant && typeof it.variant === 'object'
        ? { size: String(it.variant.size || ''), color: String(it.variant.color || '') }
        : null;
      /* K3 : la zone fait partie de la cle de fusion. Sans cela, une ligne
         classique et une ligne Koulchi du meme produit fusionneraient. */
      const mode = String(it?.mode || '') === 'koulchi' ? 'koulchi' : null;
      const key = JSON.stringify([productId, v?.size || '', v?.color || '', mode || '']);
      const old = merged.get(key);
      if (old) old.quantity += qty;
      else merged.set(key, { productId, quantity: qty, variant: v, mode, id: String(it.id || productId) });
    }
    const items = [...merged.values()];
    const couponId = input.appliedCoupon?.id ? String(input.appliedCoupon.id) : null;
    const requestPayloadHash = crypto.createHash('sha256').update(JSON.stringify({
      userId: decoded.uid,
      items: items.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        variant: item.variant ? { size: item.variant.size || '', color: item.variant.color || '' } : null,
        mode: item.mode || null
      })),
      delivery: {
        name: String(delivery.name || '').trim(),
        phone: String(delivery.phone || '').trim(),
        address: String(delivery.address || '').trim(),
        city: String(delivery.city || '').trim(),
        cityId: String(delivery.cityId || ''),
        cityAr: String(delivery.cityAr || '').trim(),
        cityFr: String(delivery.cityFr || '').trim(),
        email: String(delivery.email || decoded.email || '').trim(),
        note: String(delivery.note || '').trim()
      },
      pricingVersion,
      couponId
    })).digest('hex');

    // Le checkout ne doit jamais confirmer une commande avec une grille tarifaire
    // Livo périmée. On synchronise avant la transaction Firestore.
    let livoFeesFresh = false;
    try { livoFeesFresh = await isLivoFeesCacheFresh(); } catch (e) { console.warn('[createCustomerOrder] Cache tarifs Livo illisible:', e.message); }
    if (!livoFeesFresh) {
      try {
        await syncLivoCitiesFromApi({ preserveCustom: true });
        livoFeesFresh = await isLivoFeesCacheFresh();
      } catch (e) {
        console.error('[createCustomerOrder] Actualisation des tarifs Livo impossible:', e.message);
      }
    }
    if (!livoFeesFresh) throw new Error('Les tarifs Livo ne peuvent pas être vérifiés pour le moment. Réessayez dans quelques minutes.');

    const requestRef = db.collection('order_requests').doc(`${decoded.uid}_${requestId}`);
    const orderRef = db.collection('orders').doc();

    const outcome = await db.runTransaction(async tx => {
      const requestSnap = await tx.get(requestRef);
      if (requestSnap.exists) {
        const requestData = requestSnap.data();
        if (requestData.payloadHash !== requestPayloadHash) {
          throw new Error('Cette demande de commande a déjà été utilisée avec d’autres informations.');
        }
        if (!requestData.response) throw new Error('Commande précédente en cours de traitement. Réessayez dans un instant.');
        return requestData.response;
      }

      const productRefs = items.map(i => db.collection('products').doc(i.productId));
      const productSnaps = await Promise.all(productRefs.map(ref => tx.get(ref)));
      const vendorIdsSet = new Set();

      /* ============================================================
         VENTE FLASH (audit 2026-11-16) : prechargement des ventes actives
         ------------------------------------------------------------
         Une seule lecture pour toutes les ventes actives, indexees par
         productId. On retient la remise la plus avantageuse par produit.
         Fait AVANT la boucle pour ne pas multiplier les get() dans la
         transaction (limite Firestore et cout).
         ============================================================ */
      const flashSalesByProduct = new Map();
      try {
        const nowMs = Date.now();
        const flashSnap = await tx.get(
          db.collection('flash_sales').where('status', '==', 'active').limit(50)
        );
        const allSales = flashSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const liveSales = allSales.filter(s => isFlashSaleLiveServer(s, nowMs));
        for (const sale of liveSales) {
          const ids = Array.isArray(sale.productIds) ? sale.productIds.map(String) : [];
          for (const pid of ids) {
            const current = flashSalesByProduct.get(pid);
            /* La remise la plus forte gagne. */
            if (!current) { flashSalesByProduct.set(pid, sale); continue; }
            const a = applyServerFlashPrice(1, sale, nowMs).percent;
            const b = applyServerFlashPrice(1, current, nowMs).percent;
            if (a > b) flashSalesByProduct.set(pid, sale);
          }
        }
      } catch (e) {
        /* Fail-open sur la vente flash : une panne de lecture ne doit pas
           bloquer la vente. Le prix normal s applique alors. */
        console.warn('[createCustomerOrder] vente flash illisible, prix normaux appliques:', e.message);
      }

      for (let i = 0; i < productSnaps.length; i++) {
        if (!productSnaps[i].exists) throw new Error(`Produit introuvable.`);
        const pd = productSnaps[i].data();
        const vid = String(pd.vendorId || 'smartswi9a');
        // Les produits vendeurs doivent explicitement être approuvés.
        // La tolérance au champ status absent est réservée au catalogue historique Smartswika.
        if (vid !== 'smartswi9a' && pd.status !== 'approved') {
          throw new Error('Produit vendeur indisponible ou non approuvé.');
        }
        if (vid === 'smartswi9a' && pd.status && pd.status !== 'approved') {
          throw new Error('Produit indisponible.');
        }
        if (vid !== 'smartswi9a') vendorIdsSet.add(vid);
      }
      const vendorIds = [...vendorIdsSet];
      const shippingMethodsByVendor = new Map();

      // C6 : vérif vendeurs approuvés
      if (vendorIds.length > 0) {
        const vendorRefs = vendorIds.map(id => db.collection('vendorsPublic').doc(id));
        const vendorSnaps = await Promise.all(vendorRefs.map(ref => tx.get(ref)));
        const vendorProfileRefs = vendorIds.map(id => db.collection('users').doc(id));
        const vendorProfileSnaps = await Promise.all(vendorProfileRefs.map(ref => tx.get(ref)));
        vendorSnaps.forEach((snap, i) => {
          if (!snap.exists) throw new Error(`Le vendeur ${vendorIds[i]} n'est pas actif.`);
          const vData = snap.data();
          if (vData.status !== 'approved' ||
              String(vData.contractVersion || '') !== OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION) {
            throw new Error(`Le vendeur ${vendorIds[i]} n'est pas approuvé avec le contrat courant.`);
          }
          const profileSnap = vendorProfileSnaps[i];
          if (!profileSnap.exists || profileSnap.data().role !== 'vendor' || profileSnap.data().vendorInfo?.status !== 'approved') {
            throw new Error(`Le vendeur ${vendorIds[i]} n'est plus actif.`);
          }
          const shippingMethod = String(profileSnap.data().vendorInfo?.shippingMethod || '');
          if (shippingMethod !== 'fulfillment') {
            throw new Error(`Le mode logistique du vendeur ${vendorIds[i]} n'est pas configuré.`);
          }
          shippingMethodsByVendor.set(vendorIds[i], shippingMethod);
        });
      }

      let subtotal = 0;
      let totalQty = 0;
      const validatedItems = [];
      const productUpdates = new Map();
      const workingProducts = new Map(productSnaps.map((snap, i) => [
        items[i].productId,
        { ...snap.data(), variants: Array.isArray(snap.data().variants) ? snap.data().variants.map(v => ({ ...v })) : undefined }
      ]));

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const data = workingProducts.get(item.productId);
        const qty = item.quantity;
        let stock = 0, price = Number(data.price) || 0;

        const update = productUpdates.get(item.productId)?.data || { salesCount: Number(data.salesCount) || 0 };
        update.salesCount = (Number(update.salesCount) || 0) + qty;
        update.lastOrderId = orderRef.id;
        update.updatedAt = FieldValue.serverTimestamp();

        if (item.variant) {
          const variants = Array.isArray(update.variants)
            ? update.variants.map(v => ({ ...v }))
            : (Array.isArray(data.variants) ? data.variants.map(v => ({ ...v })) : []);
          const idx = variants.findIndex(v =>
            String(v.size || '') === item.variant.size && String(v.color || '') === item.variant.color
          );
          if (idx < 0) throw new Error(`Variante indisponible.`);
          stock = Number(variants[idx].stock) || 0;
          const vp = Number(variants[idx].price);
          if (Number.isFinite(vp) && vp > 0) price = vp;
          if (stock < qty) throw new Error(`Stock insuffisant.`);
          variants[idx].stock = stock - qty;
          update.variants = variants;
          update.stock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
          data.variants = variants;
          data.stock = update.stock;
        } else {
          stock = Number(update.stock ?? data.stock) || 0;
          if (stock < qty) throw new Error(`Stock insuffisant.`);
          update.stock = stock - qty;
          data.stock = update.stock;
        }

        data.salesCount = update.salesCount;
        productUpdates.set(item.productId, { ref: productRefs[i], data: update });

        /* ============================================================
           VENTE FLASH (audit 2026-11-16) — recalcul SERVEUR du prix
           ------------------------------------------------------------
           Le client envoie `price` depuis son panier : champ non fiable.
           On reapplique ici la remise flash active, en lisant la vente
           dans la MEME transaction. Le client ne peut donc pas forger un
           prix remise : soit la vente est active et le montant est
           recalcule, soit elle ne l'est pas et le prix normal s'applique.
           ============================================================ */
        let unitPrice = price;
        let flashApplied = null;
        if (flashSalesByProduct.has(String(item.productId))) {
          const sale = flashSalesByProduct.get(String(item.productId));
          const computed = applyServerFlashPrice(price, sale);
          if (computed.discount > 0) {
            unitPrice = computed.finalPrice;
            flashApplied = {
              saleId: sale.id,
              discountType: String(sale.discountType || ''),
              discountValue: Number(sale.discountValue) || 0,
              discountPerUnit: computed.discount
            };
          }
        }

        totalQty += qty;
        validatedItems.push({
          id: item.id,
          productId: item.productId,
          vendorId: String(data.vendorId || 'smartswi9a'),
          /* Mode unique : tout le stock est stocke a l entrepot Smart Swika. */
          delivery_mode: 'smartswika_warehouse',
          shippingMethod: String(data.vendorId || 'smartswi9a') === 'smartswi9a'
            ? 'platform'
            : String(shippingMethodsByVendor.get(String(data.vendorId)) || ''),
          variant: item.variant,
          quantity: qty,
          mode: item.mode || null,
          price: unitPrice,
          basePrice: price,
          /* K3 : prix de groupe relu dans la transaction. Retenu seulement
             s il est STRICTEMENT inferieur au meilleur prix deja obtenu,
             pour ne jamais facturer plus cher en Koulchi. */
          /* K3/K6b : pas de cumul vente flash + Koulchi. Un produit deja
             remise en vente flash reste en vente flash (option A). */
          koulchiPrice: !flashApplied
            && !item.variant
            && Number.isFinite(Number(data.koulchiPrice))
            && Number(data.koulchiPrice) > 0
            && Number(data.koulchiPrice) < unitPrice
              ? Number(data.koulchiPrice)
              : null,
          flashSale: flashApplied,
          name: String(data.nameFr || data.nameEn || 'Produit')
        });
      }

      // Le tarif doit provenir d'une ville Firestore identifiée et correspondre
      // au nom français sélectionné. Le client ne peut pas choisir un cityId
      // moins cher tout en saisissant une autre ville.
      if (!delivery.cityId) throw new Error('Veuillez sélectionner une ville de livraison valide.');
      const cityIdNumber = Number(delivery.cityId);
      let cityData = null;
      if (Number.isFinite(cityIdNumber)) {
        const cityQuery = db.collection('cities').where('id', '==', cityIdNumber).limit(1);
        const cityQuerySnap = await tx.get(cityQuery);
        if (!cityQuerySnap.empty) cityData = cityQuerySnap.docs[0].data();
      }
      // Compatibilité avec les anciennes villes dont l'identifiant Firestore
      // est directement utilisé comme identifiant côté interface.
      if (!cityData) {
        const cityDocSnap = await tx.get(db.collection('cities').doc(String(delivery.cityId)));
        if (cityDocSnap.exists) cityData = cityDocSnap.data();
      }
      if (!cityData) throw new Error('Ville de livraison introuvable. Actualisez la liste des villes.');
      const submittedCity = normalizeCityKey(delivery.cityFr || delivery.city || '');
      const acceptedCityNames = [cityData.key, cityData.nameFr, cityData.nameEn, cityData.name]
        .map(normalizeCityKey)
        .filter(Boolean);
      const exactSubmittedNames = [delivery.cityAr, delivery.city]
        .map(value => String(value || '').trim().toLocaleLowerCase())
        .filter(Boolean);
      const exactAcceptedNames = [cityData.nameAr, cityData.nameFr, cityData.nameEn, cityData.name]
        .map(value => String(value || '').trim().toLocaleLowerCase())
        .filter(Boolean);
      const cityNameMatches =
        (submittedCity && acceptedCityNames.includes(submittedCity)) ||
        exactSubmittedNames.some(name => exactAcceptedNames.includes(name));
      if (!cityNameMatches) {
        throw new Error('La ville sélectionnée ne correspond pas à la ville de livraison.');
      }
      const deliveryFee = Math.max(0, Number(cityData.price) || 0);

      // M1 : réduction volume
      /* ============================================================
         K3 : KOULCHI DIALK - RECALCUL SERVEUR
         ------------------------------------------------------------
         La zone groupe est valide entre 3 et 10 articles. Le prix de
         groupe a ete relu dans la transaction et retenu seulement s il
         est strictement inferieur au meilleur prix (variante, flash).
         Hors bornes ou prix invalide : prix normal, jamais 0.
         La remise volume de 5 % est supprimee pour pricingVersion >= 2.
         ============================================================ */
      let koulchiZoneQty = 0;
      for (const item of validatedItems) {
        if (item.mode === 'koulchi') koulchiZoneQty += Number(item.quantity) || 0;
      }
      const koulchiZoneValid =
        koulchiZoneQty >= KOULCHI_MIN_ITEMS && koulchiZoneQty <= KOULCHI_MAX_ITEMS;
      const koulchiPercent =
        pricingVersion >= 2 && koulchiZoneValid ? getKoulchiPercentServer(koulchiZoneQty) : 0;

      let koulchiSubtotal = 0;
      subtotal = 0;
      for (const item of validatedItems) {
        if (koulchiPercent > 0 && item.mode === 'koulchi' && item.koulchiPrice != null) {
          item.price = item.koulchiPrice;
        }
        const lineTotal = (Number(item.price) || 0) * (Number(item.quantity) || 0);
        subtotal += lineTotal;
        if (koulchiPercent > 0 && item.mode === 'koulchi') koulchiSubtotal += lineTotal;
      }
      const koulchiDiscount =
        koulchiPercent > 0 ? Math.round((koulchiSubtotal * koulchiPercent) / 100) : 0;

      /* Ancien bareme conserve UNIQUEMENT pour les clients sans
         pricingVersion (cache navigateur). Aucune fenetre de desaccord
         entre le prix affiche et le prix facture dans les deux sens. */
      const volumeDiscount = pricingVersion >= 2
        ? 0
        : (totalQty >= 3 ? Math.round(subtotal * 0.05) : 0);
      const itemDiscount = koulchiDiscount + volumeDiscount;

      // C3 : coupon
      let couponData = null;
      let couponDiscount = 0;
      if (couponId) {
        const couponRef = db.collection('coupons').doc(couponId);
        const couponSnap = await tx.get(couponRef);
        if (!couponSnap.exists) throw new Error('Code promo introuvable.');
        const c = couponSnap.data();
        if (c.isActive !== true) throw new Error('Code promo inactif.');
        if (c.expiresAt) {
          const exp = c.expiresAt.toDate ? c.expiresAt.toDate() : new Date(c.expiresAt);
          if (exp.getTime() < Date.now()) throw new Error('Code promo expiré.');
        }
        if (Number(c.maxUses) > 0 && (Number(c.usedCount) || 0) >= Number(c.maxUses)) {
          throw new Error('Code promo épuisé.');
        }
        if (Number(c.minPurchase) > 0 && subtotal < Number(c.minPurchase)) {
          throw new Error(`Minimum ${Number(c.minPurchase)} MAD requis.`);
        }
        if (c.oneUsePerUser === true) {
          const useSnap = await tx.get(db.collection('coupon_uses').doc(`${couponId}_${decoded.uid}`));
          if (useSnap.exists) throw new Error('Vous avez déjà utilisé ce code promo.');
        }
        const value = Math.max(0, Number(c.value) || 0);
        if (c.type === 'percentage') couponDiscount = Math.round(subtotal * Math.min(100, value) / 100);
        else if (c.type === 'fixed') couponDiscount = Math.min(value, subtotal);
        else if (c.type === 'free_shipping') couponDiscount = deliveryFee;
        if (couponDiscount <= 0) throw new Error('Ce code ne produit aucune réduction.');

        couponData = c;
        tx.update(couponRef, { usedCount: FieldValue.increment(1) });
        tx.set(db.collection('coupon_uses').doc(`${couponId}_${decoded.uid}`), {
          couponId,
          code: String(c.code || ''),
          userId: decoded.uid,
          orderId: orderRef.id,
          discountApplied: couponDiscount,
          usedAt: FieldValue.serverTimestamp()
        });
      }

      const productDiscount = Math.min(subtotal, itemDiscount + Math.max(0, couponDiscount - (couponData?.type === 'free_shipping' ? deliveryFee : 0)));
      const shippingDiscount = couponData?.type === 'free_shipping' ? Math.min(deliveryFee, couponDiscount) : 0;
      const total = Math.max(0, subtotal - productDiscount + deliveryFee - shippingDiscount);

      const now = Date.now();
      const cancellableUntil = new Date(now + 4 * 3600 * 1000);

      const vendorList = [...new Set(validatedItems.map(i => i.vendorId).filter(v => v && v !== 'smartswi9a'))];
      const containsPlatformItems = validatedItems.some(i => i.vendorId === 'smartswi9a');
      const vendorCountForPrivacy = vendorList.length + (containsPlatformItems ? 1 : 0);
      const orderData = {
        userId: decoded.uid,
        userName: String(delivery.name).trim().slice(0, 100),
        userEmail: String(decoded.email || delivery.email || ''),
        items: validatedItems,
        vendorIds: vendorList,
        containsPlatformItems,
        status: 'pending',
        paymentStatus: 'unpaid',
        subtotal,
        discount: itemDiscount,
        koulchiDiscount,
        koulchiPercent,
        koulchiItemCount: koulchiZoneQty,
        couponId: couponData ? couponId : null,
        couponCode: couponData ? String(couponData.code || '') : null,
        couponDiscount,
        deliveryFee,
        total,
        stockDeducted: true,
        couponRestored: false,
        deliveryAddress: delivery,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        cancellableUntil,
        vendorCredits: {},
        vendorDebits: {}
      };

      productUpdates.forEach(u => tx.update(u.ref, u.data));
      tx.set(orderRef, orderData);

      /* ============================================================
         VENTE FLASH : increment du compteur de ventes
         ------------------------------------------------------------
         `soldCount` est un compteur SERVEUR : le client ne peut pas
         l ecrire (regles Firestore). Il sert au quota `maxQuantity`.
         Un increment par unite vendue, uniquement pour les ventes
         reellement appliquees a cette commande.
         ============================================================ */
      const flashSalesToIncrement = new Map();
      for (const item of validatedItems) {
        if (!item.flashSale || !item.flashSale.saleId) continue;
        const prev = flashSalesToIncrement.get(item.flashSale.saleId) || 0;
        flashSalesToIncrement.set(item.flashSale.saleId, prev + Number(item.quantity || 0));
      }
      for (const [saleId, qty] of flashSalesToIncrement) {
        tx.update(db.collection('flash_sales').doc(saleId), {
          soldCount: FieldValue.increment(qty)
        });
      }

      // Vue cloisonnée par vendeur : aucun vendeur ne reçoit les articles
      // des autres boutiques ni les totaux globaux de la commande.
      for (const vendorId of vendorList) {
        const vendorItems = validatedItems
          .filter(item => item.vendorId === vendorId)
          .map(item => ({
            id: String(item.id || ''),
            productId: String(item.productId || ''),
            vendorId,
            shippingMethod: String(item.shippingMethod || ''),
            variant: item.variant && typeof item.variant === 'object'
              ? { size: String(item.variant.size || ''), color: String(item.variant.color || '') }
              : null,
            quantity: Number(item.quantity) || 0,
            price: Number(item.price) || 0,
            basePrice: Number(item.basePrice) || Number(item.price) || 0,
            mode: item.mode === 'koulchi' ? 'koulchi' : null,
            koulchiPrice: item.koulchiPrice != null ? Number(item.koulchiPrice) : null,
            name: String(item.name || 'Produit').slice(0, 160)
          }));
        const vendorSubtotal = vendorItems.reduce(
          (sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0),
          0
        );
        const vendorKoulchiSubtotal = vendorItems.reduce(
          (sum, item) => item.mode === 'koulchi'
            ? sum + (Number(item.price) || 0) * (Number(item.quantity) || 0)
            : sum,
          0
        );
        const vendorKoulchiDiscount = koulchiSubtotal > 0
          ? Math.round((koulchiDiscount * vendorKoulchiSubtotal) / koulchiSubtotal)
          : 0;
        const vendorOrderRef = db.collection('vendor_orders').doc(vendorId)
          .collection('orders').doc(orderRef.id);
        tx.set(vendorOrderRef, {
          orderId: orderRef.id,
          vendorId,
          privacySafe: true,
          vendorCount: vendorCountForPrivacy,
          items: vendorItems,
          vendorSubtotal,
          koulchiDiscount: vendorKoulchiDiscount,
          status: 'pending',
          createdAt: orderData.createdAt,
          updatedAt: orderData.updatedAt
        });
      }

      const notifRef = db.collection('notifications').doc();
      tx.set(notifRef, {
        userId: decoded.uid,
        type: 'order_created',
        title: 'Commande reçue',
        message: `Merci pour votre commande #${orderRef.id.slice(0, 8).toUpperCase()} !`,
        orderId: orderRef.id,
        read: false,
        createdAt: FieldValue.serverTimestamp()
      });

      const responseData = {
        orderId: orderRef.id,
        totals: {
          subtotal,
          discount: itemDiscount,
          koulchiDiscount,
          koulchiPercent,
          couponCode: orderData.couponCode,
          couponDiscount,
          deliveryFee,
          total,
          vendorIds: vendorList
        },
        validatedItems
      };
      tx.create(requestRef, {
        userId: decoded.uid,
        payloadHash: requestPayloadHash,
        orderId: orderRef.id,
        response: responseData,
        createdAt: FieldValue.serverTimestamp()
      });
      return responseData;
    });

    return res.status(200).json({ success: true, ...outcome });
  } catch (error) {
    console.error('[createCustomerOrder]', error);
    return res.status(400).json({ success: false, message: error.message || 'Création de commande impossible.' });
  }
});

/* ============================================================
   CF : cancelCustomerOrder
   ============================================================ */
exports.cancelCustomerOrder = onRequest({ invoker: 'public', region: 'europe-west1', maxInstances: 10, timeoutSeconds: 30, cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const orderId = String(req.body?.orderId || '').trim();
    if (!orderId) return res.status(400).json({ success: false, message: 'Commande invalide.' });

    await db.runTransaction(async tx => {
      const orderRef = db.collection('orders').doc(orderId);
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw new Error('Commande introuvable.');
      const order = orderSnap.data();
      if (order.userId !== decoded.uid) throw new Error('Non autorisé.');
      if (!['pending', 'confirmed'].includes(order.status)) throw new Error('Délai dépassé.');

      if (order.cancellableUntil) {
        const until = order.cancellableUntil.toDate
          ? order.cancellableUntil.toDate()
          : new Date(order.cancellableUntil);
        if (Date.now() > until.getTime()) throw new Error('Le délai d’annulation est dépassé.');
      }

      const items = Array.isArray(order.items) ? order.items : [];
      const productIds = [...new Set(items.map(i => String(i.productId)))];
      const refs = productIds.map(id => db.collection('products').doc(id));
      const snaps = await Promise.all(refs.map(ref => tx.get(ref)));

      // Toutes les lectures doivent précéder les premières écritures
      // de la transaction Firestore.
      const couponRef = order.couponId
        ? db.collection('coupons').doc(String(order.couponId))
        : null;
      const couponSnap = couponRef && !order.couponRestored
        ? await tx.get(couponRef)
        : null;

      if (order.stockDeducted === true) {
        for (let i = 0; i < productIds.length; i++) {
          if (!snaps[i].exists) {
            throw new Error(`Produit ${productIds[i]} introuvable : annulation interrompue pour préserver le stock.`);
          }
          const p = snaps[i].data();
          const productItems = items.filter(item => String(item.productId) === productIds[i]);
          const quantities = productItems.map(item => {
            const qty = Number(item.quantity);
            if (!Number.isInteger(qty) || qty <= 0) {
              throw new Error(`Quantité invalide pour le produit ${productIds[i]}.`);
            }
            return { item, qty };
          });
          const totalQty = quantities.reduce((sum, entry) => sum + entry.qty, 0);
          const upd = {
            salesCount: Math.max(0, (Number(p.salesCount) || 0) - totalQty),
            lastOrderId: orderId,
            updatedAt: FieldValue.serverTimestamp()
          };
          const variants = Array.isArray(p.variants) ? p.variants.map(v => ({ ...v })) : [];
          let simpleStock = Number(p.stock) || 0;
          let hasVariantItems = false;
          let hasSimpleItems = false;

          for (const { item, qty } of quantities) {
            if (item.variant) {
              hasVariantItems = true;
              const idx = variants.findIndex(v =>
                String(v.size || '') === String(item.variant.size || '') &&
                String(v.color || '') === String(item.variant.color || '')
              );
              if (idx < 0) {
                throw new Error(`Variante introuvable pour le produit ${productIds[i]} : annulation interrompue.`);
              }
              const currentVariantStock = Number(variants[idx].stock);
              if (!Number.isFinite(currentVariantStock) || currentVariantStock < 0) {
                throw new Error(`Stock de variante invalide pour le produit ${productIds[i]}.`);
              }
              variants[idx].stock = currentVariantStock + qty;
            } else {
              hasSimpleItems = true;
              simpleStock += qty;
            }
          }

          if (hasVariantItems && hasSimpleItems) {
            throw new Error(`Structure de stock incohérente pour le produit ${productIds[i]} : variantes et stock simple mélangés.`);
          }
          if (hasVariantItems) {
            upd.variants = variants;
            upd.stock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
          } else {
            upd.stock = simpleStock;
          }
          tx.update(refs[i], upd);
        }
      }

      // Restaurer le coupon sans lecture après les premières écritures
      // et sans jamais rendre usedCount négatif.
      if (couponRef && !order.couponRestored) {
        if (couponSnap?.exists && Number(couponSnap.data().usedCount) > 0) {
          tx.update(couponRef, { usedCount: FieldValue.increment(-1) });
        }
        tx.delete(db.collection('coupon_uses').doc(`${order.couponId}_${decoded.uid}`));
      }

      tx.update(orderRef, {
        status: 'cancelled',
        cancelledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        stockDeducted: false,
        couponRestored: true
      });
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[cancelCustomerOrder]', error);
    return res.status(400).json({ success: false, message: error.message });
  }
});

/* ============================================================
   CF : adminPayoutAction (M3 : validation vendorId)
   ============================================================ */
/* ============================================================
   CF : adminPayoutAction
   Cycle de vie d'une demande de retrait Wafacash/CashPlus :
     pending --(sent)--> sent --(completed)--> completed
     pending|sent --(rejected)--> rejected
   L'argent est debite du wallet au moment de 'sent' (l'admin a depose le
   montant a l'agence). Les frais de l'agence sont deduits a la source par
   Wafacash/CashPlus : Smart Swika ne preleve aucun frais.
   ============================================================ */
exports.adminPayoutAction = onRequest({ invoker: 'public', region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 30 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    const isAdmin = decoded.admin === true || (adminSnap.exists && adminSnap.data()?.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });
    }

    const payoutId = String(req.body?.payoutId || '');
    const rawAction = String(req.body?.action || '').trim();
    // Retro-compatibilite : l'ancienne action 'paid' est un alias de 'completed'.
    const action = rawAction === 'paid' ? 'completed' : rawAction;
    const transferNumber = String(req.body?.transferNumber || '').trim().slice(0, 60);
    const reason = String(req.body?.reason || '').trim().slice(0, 500);

    if (!payoutId || !['sent', 'completed', 'rejected'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Paramètres invalides.' });
    }
    if (action === 'sent' && transferNumber.length < 3) {
      return res.status(400).json({ success: false, message: 'Numéro de transfert obligatoire (3 caractères minimum).' });
    }

    await db.runTransaction(async (t) => {
      const payoutRef = db.collection('payout_requests').doc(payoutId);
      const payoutSnap = await t.get(payoutRef);
      if (!payoutSnap.exists) throw new Error('Demande introuvable.');
      const payoutData = payoutSnap.data();
      const currentStatus = String(payoutData.status || 'pending').toLowerCase() === 'paid'
        ? 'completed'
        : String(payoutData.status || 'pending').toLowerCase();

      // Transitions autorisees uniquement.
      const allowedFrom = { sent: ['pending'], completed: ['sent'], rejected: ['pending', 'sent'] };
      if (!allowedFrom[action].includes(currentStatus)) {
        throw new Error(`Transition de retrait impossible depuis le statut Â« ${currentStatus} Â».`);
      }

      // M3 : vendorId obligatoire
      const vendorId = String(payoutData.vendorId || '');
      if (!vendorId) throw new Error('Demande sans vendorId — impossible de traiter.');

      // Serialiser le traitement d'un retrait avec le verrou de suppression
      // du vendeur. Si la suppression est deja engagee, aucune operation
      // financiere ne doit etre creee apres le controle des demandes ouvertes.
      const vendorRef = db.collection('users').doc(vendorId);
      const vendorSnap = await t.get(vendorRef);
      if (!vendorSnap.exists || vendorSnap.data()?.role !== 'vendor') {
        throw new Error('Profil vendeur introuvable.');
      }
      if (vendorSnap.data()?.vendorInfo?.status === 'deletion_pending') {
        throw new Error('Suppression du compte vendeur en cours : retrait temporairement bloqué.');
      }

      const amount = Number(payoutData.amount) || 0;
      const method = String(payoutData.method || 'Wafacash');

      if (action === 'sent') {
        if (amount <= 0) throw new Error('Montant invalide.');

        const walletRef = db.collection('wallets').doc(vendorId);
        const walletSnap = await t.get(walletRef);
        if (!walletSnap.exists) throw new Error('Wallet introuvable.');

        const wallet = walletSnap.data();
        if ((Number(wallet.negativeBalance) || 0) < -0.0001) {
          throw new Error('Envoi bloqué : le portefeuille vendeur présente un solde débiteur à régulariser.');
        }
        const available = Number(wallet.availableBalance) || 0;
        if (available < amount) {
          throw new Error(`Solde insuffisant : disponible ${available} MAD, demandé ${amount} MAD.`);
        }

        // Option A : le wallet est debite au moment ou l'argent est depose
        // a l'agence (status 'sent'), pas a la confirmation de retrait.
        t.update(walletRef, {
          availableBalance: FieldValue.increment(-amount),
          totalWithdrawn: FieldValue.increment(amount),
          lastUpdated: FieldValue.serverTimestamp()
        });

        t.update(payoutRef, {
          status: 'sent',
          transferNumber,
          sentAt: FieldValue.serverTimestamp(),
          sentBy: decoded.uid
        });

        const txRef = db.collection('wallet_transactions').doc();
        t.set(txRef, {
          vendorId,
          type: 'payout',
          amount: -amount,
          status: 'released',
          payoutRequestId: payoutId,
          description: `Retrait envoyé à l'agence - ${method}`,
          createdAt: FieldValue.serverTimestamp(),
          releasedAt: FieldValue.serverTimestamp()
        });

        const notifRef = db.collection('notifications').doc();
        t.set(notifRef, {
          userId: vendorId,
          type: 'payout_sent',
          title: 'Retrait envoyé',
          message: `Votre retrait de ${amount} MAD a été envoyé. Numéro de transfert : ${transferNumber}. Présentez-vous à une agence avec votre CIN.`,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
          payoutId
        });
      } else if (action === 'completed') {
        t.update(payoutRef, {
          status: 'completed',
          completedAt: FieldValue.serverTimestamp(),
          completedBy: decoded.uid
        });

        const notifRef = db.collection('notifications').doc();
        t.set(notifRef, {
          userId: vendorId,
          type: 'payout_completed',
          title: 'Retrait retiré',
          message: `Votre retrait de ${amount} MAD a été marqué comme retiré.`,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
          payoutId
        });
      } else {
        t.update(payoutRef, {
          status: 'rejected',
          rejectionReason: reason || null,
          rejectedAt: FieldValue.serverTimestamp(),
          rejectedBy: decoded.uid
        });

        const notifRef = db.collection('notifications').doc();
        t.set(notifRef, {
          userId: vendorId,
          type: 'payout_rejected',
          title: 'Retrait rejeté',
          message: reason
            ? `Votre demande de retrait de ${amount} MAD a été rejetée. Motif : ${reason}`
            : `Votre demande de retrait de ${amount} MAD a été rejetée.`,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
          payoutId
        });
      }
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[adminPayoutAction]', error);
    const message = error.message || 'Erreur serveur.';
    const clientError = /introuvable|invalide|obligatoire|impossible|solde insuffisant|solde débiteur|suppression du compte/i.test(message);
    return res.status(clientError ? 400 : 500).json({ success: false, message });
  }
});

/* ============================================================
   CF : releaseDueFunds
   ============================================================ */
exports.releaseDueFunds = onRequest({ invoker: 'public', region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 60 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    const isAdmin = decoded.admin === true || (adminSnap.exists && adminSnap.data()?.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });
    }

    const batchSize = Math.min(Number(req.body?.batchSize) || 400, 1000);
    const now = new Date();

    let totalReleased = 0;
    let vendorsProcessed = 0;
    let transactionsReleased = 0;
    const errors = [];

    const txQuery = db.collection('wallet_transactions')
      .where('status', '==', 'pending')
      .where('unlockAt', '<=', now)
      .limit(batchSize);

    const txSnap = await txQuery.get();
    if (txSnap.empty) {
      return res.status(200).json({ success: true, totalReleased: 0, vendorsProcessed: 0, transactionsReleased: 0, errors: [] });
    }

    const byVendor = {};
    txSnap.forEach(doc => {
      const data = doc.data();
      if (!data.vendorId) return;
      if (!byVendor[data.vendorId]) byVendor[data.vendorId] = [];
      byVendor[data.vendorId].push({ id: doc.id, ref: doc.ref, data });
    });

    for (const [vendorId, txs] of Object.entries(byVendor)) {
      try {
        const walletRef = db.collection('wallets').doc(vendorId);

        const result = await db.runTransaction(async (t) => {
          // Le profil vendeur sert de verrou commun avec adminVendorAction :
          // une libération ne peut pas passer silencieusement après le début
          // d'une suppression.
          const vendorRef = db.collection('users').doc(vendorId);
          const [vendorSnap, walletSnap] = await Promise.all([
            t.get(vendorRef),
            t.get(walletRef)
          ]);
          if (!vendorSnap.exists || vendorSnap.data()?.role !== 'vendor') {
            throw new Error('Profil vendeur introuvable');
          }
          if (vendorSnap.data()?.vendorInfo?.status === 'deletion_pending') {
            throw new Error('Suppression du compte vendeur en cours');
          }
          if (normalizeWalletStatus(vendorSnap.data()) === WALLET_STATUS.FROZEN) {
            throw new Error('Portefeuille gelé : libération des fonds impossible tant que le litige est en cours.');
          }
          if (!walletSnap.exists) throw new Error('Wallet introuvable');

          // Relire chaque transaction dans la transaction Firestore : deux
          // exécutions concurrentes ne doivent jamais libérer deux fois la
          // même écriture à partir du même résultat de requête initial.
          const freshTxs = [];
          for (const candidate of txs) {
            const freshSnap = await t.get(candidate.ref);
            if (!freshSnap.exists) continue;
            const freshData = freshSnap.data();
            if (freshData.status !== 'pending' || !freshData.unlockAt) continue;
            const unlockDate = typeof freshData.unlockAt.toDate === 'function'
              ? freshData.unlockAt.toDate()
              : new Date(freshData.unlockAt);
            if (!Number.isFinite(unlockDate.getTime()) || unlockDate > now) continue;
            freshTxs.push({ ref: candidate.ref, data: freshData });
          }

          const wallet = walletSnap.data();
          let pendingBalance = Number(wallet.pendingBalance) || 0;
          let availableBalance = Number(wallet.availableBalance) || 0;
          let vendorReleased = 0;
          let txsCount = 0;

          for (const tx of freshTxs) {
            const amount = Math.max(0, Number(tx.data.amount) || 0);
            const reversed = Math.max(0, Number(tx.data.reversedAmount) || 0);
            const alreadyReleased = Math.max(0, Number(tx.data.releasedAmount) || 0);
            const eligible = Math.max(0, amount - reversed - alreadyReleased);

            if (eligible <= 0.0001) {
              t.update(tx.ref, {
                status: 'released',
                releasedAt: tx.data.releasedAt || FieldValue.serverTimestamp(),
                releasedAmount: alreadyReleased
              });
              continue;
            }

            const releaseForThis = Math.min(eligible, Math.max(0, pendingBalance));
            if (releaseForThis <= 0) continue;

            pendingBalance -= releaseForThis;
            availableBalance += releaseForThis;
            vendorReleased += releaseForThis;
            txsCount++;

            const cumulativeReleased = alreadyReleased + releaseForThis;
            const fullyReleased = (reversed + cumulativeReleased) >= amount - 0.0001;
            t.update(tx.ref, {
              status: fullyReleased ? 'released' : 'pending',
              releasedAmount: cumulativeReleased,
              ...(fullyReleased
                ? { releasedAt: FieldValue.serverTimestamp() }
                : { partialReleasedAt: FieldValue.serverTimestamp() })
            });
          }

          if (vendorReleased > 0) {
            t.update(walletRef, {
              pendingBalance: Math.max(0, pendingBalance),
              availableBalance,
              lastUpdated: FieldValue.serverTimestamp()
            });
          }

          return { released: vendorReleased, count: txsCount };
        });

        totalReleased += result.released;
        transactionsReleased += result.count;
        vendorsProcessed++;
      } catch (err) {
        console.error(`[releaseDueFunds] Erreur vendeur ${vendorId}:`, err);
        errors.push({ vendorId, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      totalReleased,
      vendorsProcessed,
      transactionsReleased,
      errors
    });
  } catch (error) {
    console.error('[releaseDueFunds]', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});


/* ============================================================
   RELANCES PANIERS ABANDONNÉS — PUSH FCM GRATUIT (0 EmailJS)
   ------------------------------------------------------------
   Toutes les 15 minutes, heure Africa/Casablanca :
     - ne s'exécute QUE pendant les heures de pic Maroc
       (11h00-14h30 et 18h30-23h00) ; hors créneau, les paniers
       restent en file d'attente pour la prochaine fenêtre ;
     - sélectionne status == 'active', updatedAt <= now - 45 min
       et updatedAt >= now - 48 h (les plus vieux sont ignorés) ;
     - ignore les paniers sans fcmToken (relance WhatsApp admin) ;
     - envoie un push localisé fr / en / ar (Urgency high,
       requireInteraction) vers ?recover_cart={cartId} ;
     - passe le document en 'reminded_push' + remindedAt.
   Aucun email n'est envoyé ici : quota EmailJS préservé.
   ============================================================ */

const ABANDONED_CARTS = 'abandoned_carts';
const ABANDON_REMINDER_DELAY_MS = 45 * 60 * 1000;
const ABANDON_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const ABANDON_BATCH_LIMIT = 200;
const ABANDON_PUSH_LINK = 'https://smartswika.ma/?recover_cart=';
const ABANDON_ICON = 'https://smartswika.ma/assets/pwa-192.png';

/* Heures de pic Maroc, en minutes depuis minuit. */
const ABANDON_PEAK_WINDOWS = [
  [11 * 60, 14 * 60 + 30], /* 11h00 -> 14h30 */
  [18 * 60 + 30, 23 * 60]  /* 18h30 -> 23h00 */
];

const ABANDON_MESSAGES = {
  fr: {
    title: '🛒 Votre panier Smartswika vous attend !',
    body: 'Finalisez votre commande maintenant (paiement à la livraison 24-72h).'
  },
  en: {
    title: '🛒 Your Smartswika cart is waiting!',
    body: 'Complete your order now (Cash on Delivery 24-72h).'
  },
  ar: {
    title: '🛒 سلة مشترياتك في Smartswika بانتظارك!',
    body: 'أكمل طلبك الآن مع الدفع عند الاستلام خلال 24-72 ساعة.'
  }
};

/* Minutes depuis minuit à l'heure de Casablanca (Intl : gère le
   ramadan / changements d'offset sans constante codée en dur). */
function moroccoMinutesOfDay(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Casablanca',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date);
    const pick = (type) => Number((parts.find((p) => p.type === type) || {}).value || 0);
    return (pick('hour') % 24) * 60 + pick('minute');
  } catch (error) {
    const shifted = new Date(date.getTime() + 60 * 60 * 1000);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  }
}

function isMoroccoPeakWindow(date = new Date()) {
  const minutes = moroccoMinutesOfDay(date);
  return ABANDON_PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
}

function timestampToMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

exports.abandonedCartReminder = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Africa/Casablanca',
    maxInstances: 1,
    timeoutSeconds: 300
  },
  async () => {
    const now = Date.now();

    /* Hors pic : on ne touche à rien, le panier reste en attente. */
    if (!isMoroccoPeakWindow(new Date(now))) {
      console.log('[abandonedCartReminder] hors créneau de pic Maroc — report');
      return;
    }

    const cutoff = new Date(now - ABANDON_REMINDER_DELAY_MS);
    const oldest = new Date(now - ABANDON_MAX_AGE_MS);

    let snapshot;
    try {
      snapshot = await db
        .collection(ABANDONED_CARTS)
        .where('status', '==', 'active')
        .where('updatedAt', '<=', cutoff)
        .where('updatedAt', '>=', oldest)
        .orderBy('updatedAt', 'asc')
        .limit(ABANDON_BATCH_LIMIT)
        .get();
    } catch (error) {
      console.error('[abandonedCartReminder] requête impossible :', error.message);
      return;
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const cartDoc of snapshot.docs) {
      const data = cartDoc.data() || {};
      const token = typeof data.fcmToken === 'string' ? data.fcmToken.trim() : '';
      if (!token || String(data.status) !== 'active') {
        skipped += 1;
        continue;
      }
      if (now - timestampToMillis(data.updatedAt || data.createdAt) > ABANDON_MAX_AGE_MS) {
        skipped += 1;
        continue;
      }

      const lang = data.lang === 'en' || data.lang === 'ar' ? data.lang : 'fr';
      const message = ABANDON_MESSAGES[lang];
      const cartId = cartDoc.id;
      const link = `${ABANDON_PUSH_LINK}${encodeURIComponent(cartId)}`;
      const tag = `abandoned-cart-${cartId}`;

      try {
        await getMessaging().send({
          token,
          data: {
            title: message.title,
            body: message.body,
            targetUrl: link,
            type: 'abandoned_cart',
            tag
          },
          notification: { title: message.title, body: message.body },
          webpush: {
            headers: { Urgency: 'high', TTL: '86400' },
            notification: {
              title: message.title,
              body: message.body,
              icon: ABANDON_ICON,
              badge: ABANDON_ICON,
              requireInteraction: true,
              tag,
              data: { url: link, type: 'abandoned_cart', cartId }
            },
            fcmOptions: { link }
          }
        });

        await cartDoc.ref.update({
          status: 'reminded_push',
          remindedAt: FieldValue.serverTimestamp()
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        const code = error && error.code;
        console.warn(`[abandonedCartReminder] ${cartId} :`, code || (error && error.message));
        /* Token mort : on le retire pour ne pas boucler indéfiniment. */
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          try {
            await cartDoc.ref.update({ fcmToken: null });
          } catch (cleanupError) {
            /* non bloquant */
          }
        }
      }
    }

    console.log(
      '[abandonedCartReminder]',
      JSON.stringify({ candidates: snapshot.size, sent, skipped, failed, emailjs: 0 })
    );
  }
);

/* ============================================================
   ADS AUTOMATION - CATALOG FEED + META / TIKTOK CAMPAIGNS
   ============================================================ */

const ADS_BASE_URL = 'https://www.smartswika.ma';
const CATALOG_FEED_PATH = '/feed/products.xml';
const ADS_SECRETS_COLLECTION = 'config';
const ADS_SECRETS_DOC = 'ads_secrets';
const AD_CAMPAIGNS_COLLECTION = 'ad_campaigns';
const META_GRAPH_VERSION = 'v21.0';
const TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';
/* TikTok Ads location id for Morocco. */
const TIKTOK_LOCATION_MA = '2252422';
const OFFICIAL_PRODUCT_VENDOR_IDS = new Set([
  'smartswi9a',
  'smartswika',
  'platform',
  'smartswi9a-31063'
]);
const ADS_ALLOWED_HOSTS = new Set([
  'smartswika.ma',
  'www.smartswika.ma',
  'smartswi9a.top',
  'www.smartswi9a.top',
  'smartswi9a-31063.web.app',
  'smartswi9a-31063.firebaseapp.com'
]);

function isOfficialSmartswikaProduct(product) {
  if (!product) return false;
  const vendorId = String(product.vendorId || '').trim();
  if (!vendorId) return true;
  if (OFFICIAL_PRODUCT_VENDOR_IDS.has(vendorId)) return true;
  return product.isSmartswikaOfficial === true && vendorId === 'smartswi9a';
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripHtml(value) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteAssetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return ADS_BASE_URL + '/assets/logo-64.png';
  if (/^https?:\/\//i.test(raw)) return raw;
  return ADS_BASE_URL + (raw.startsWith('/') ? raw : '/' + raw);
}

function catalogProductTitle(product) {
  return stripHtml(product.nameFr || product.nameEn || product.nameAr || '').slice(0, 150);
}

function catalogProductDescription(product) {
  const text = stripHtml(
    product.descFr || product.descEn || product.descAr || product.description || ''
  );
  return (text || catalogProductTitle(product)).slice(0, 5000);
}

function catalogPriceMad(product) {
  const price = Number(product.price);
  if (!Number.isFinite(price) || price <= 0) return '';
  return price.toFixed(2) + ' MAD';
}

async function requireAdminCallable(request) {
  if (!request || !request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  const token = request.auth.token || {};
  if (token.admin === true) return request.auth.uid;
  const snap = await db.doc('users/' + request.auth.uid).get();
  if (!snap.exists || snap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Administrator account required.');
  }
  return request.auth.uid;
}

async function readAdsSecrets() {
  const snap = await db.doc(ADS_SECRETS_COLLECTION + '/' + ADS_SECRETS_DOC).get();
  return snap.exists ? snap.data() || {} : {};
}

function sanitizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new HttpsError('invalid-argument', 'destinationUrl is required.');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new HttpsError('invalid-argument', 'destinationUrl is invalid.');
  }
  if (parsed.protocol !== 'https:' || !ADS_ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new HttpsError('invalid-argument', 'destinationUrl host is not allowed.');
  }
  return parsed.toString();
}

function positiveBudget(value) {
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget < 20 || budget > 5000) {
    throw new HttpsError('invalid-argument', 'dailyBudgetMad must be between 20 and 5000.');
  }
  return Math.round(budget * 100) / 100;
}

function buildProductCatalogXml(products) {
  const items = products
    .map((product) => {
      const id = String(product.id || '');
      const title = catalogProductTitle(product);
      const price = catalogPriceMad(product);
      if (!id || !title || !price) return '';
      const link = ADS_BASE_URL + '/produit.html?id=' + encodeURIComponent(id);
      const description = catalogProductDescription(product);
      const image = absoluteAssetUrl(product.img || (product.gallery || [])[0]);
      return [
        '    <item>',
        '      <g:id>' + escapeXml(id) + '</g:id>',
        '      <g:title>' + escapeXml(title) + '</g:title>',
        '      <g:description>' + escapeXml(description) + '</g:description>',
        '      <g:link>' + escapeXml(link) + '</g:link>',
        '      <g:image_link>' + escapeXml(image) + '</g:image_link>',
        '      <g:availability>in stock</g:availability>',
        '      <g:price>' + escapeXml(price) + '</g:price>',
        '      <g:brand>Smartswika</g:brand>',
        '      <g:condition>new</g:condition>',
        '      <g:identifier_exists>no</g:identifier_exists>',
        '    </item>'
      ].join('\n');
    })
    .filter(Boolean);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '  <channel>',
    '    <title>Smartswika - Catalogue produits</title>',
    '    <link>' + ADS_BASE_URL + '</link>',
    '    <description>Catalogue officiel Smartswika pour Google Merchant, Meta et TikTok Catalog.</description>',
    ...items,
    '  </channel>',
    '</rss>'
  ].join('\n');
}

exports.productCatalogFeed = onRequest(
  { invoker: 'public', region: 'europe-west1', cors: true, timeoutSeconds: 30 },
  async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).set('Allow', 'GET, HEAD').send('Method Not Allowed');
      return;
    }
    try {
      const snapshot = await db
        .collection('products')
        .where('status', '==', 'approved')
        .limit(500)
        .get();
      const products = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((product) => {
          const stock = Number(product.stock);
          const price = Number(product.price);
          return (
            Number.isFinite(stock) &&
            stock > 0 &&
            Number.isFinite(price) &&
            price > 0 &&
            isOfficialSmartswikaProduct(product)
          );
        });
      const xml = buildProductCatalogXml(products);
      res.set('Content-Type', 'application/xml; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=900');
      res.set('X-Content-Type-Options', 'nosniff');
      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }
      res.status(200).send(xml);
    } catch (error) {
      console.error('[productCatalogFeed]', error && (error.code || error.message));
      res.status(500).set('Cache-Control', 'no-store');
      res.type('application/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><error>catalog_unavailable</error>'
      );
    }
  }
);

/* ============================================================
   SUPPRESSION VIDEO R2 (ADMIN)
   ------------------------------------------------------------
   Le champ `products.video` contient le nom du fichier servi par
   https://videos.smartswika.ma (bucket R2 smartswi9a-videos).
   Cette fonction :
     1. verifie le jeton Firebase + le role admin ;
     2. delegue la suppression au Worker Cloudflare (secret partage) ;
     3. repond success meme si l'objet est deja absent (idempotent).
   ============================================================ */
exports.adminDeleteVideo = onRequest(
  { invoker: 'public', region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 30 },
  async (req, res) => {
    if (cors(req, res)) return;
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Methode non autorisee.' });
    }
    try {
      const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
      if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
      let decoded;
      try {
        decoded = await getAuth().verifyIdToken(match[1], true);
      } catch (_) {
        return res.status(401).json({ success: false, message: 'Session invalide.' });
      }
      let isAdmin = decoded.admin === true;
      if (!isAdmin) {
        const snap = await db.doc('users/' + decoded.uid).get();
        isAdmin = snap.exists && (snap.data() || {}).role === 'admin';
      }
      if (!isAdmin) return res.status(403).json({ success: false, message: 'Administrateur requis.' });

      const key = String((req.body && req.body.key) || '').trim();
      if (!key || key.length > 200 || key.includes('/') || key.includes('..')) {
        return res.status(400).json({ success: false, message: 'Cle invalide.' });
      }

      const endpoint = process.env.R2_DELETE_URL || 'https://smartswika.ma/api/internal/r2-delete';
      const secret = process.env.R2_DELETE_SECRET;
      if (!secret) {
        return res.status(503).json({ success: false, message: 'Suppression R2 non configuree.' });
      }

      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
        body: JSON.stringify({ key })
      });
      const payload = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        console.error('[adminDeleteVideo] R2', upstream.status, payload);
        return res.status(502).json({ success: false, message: 'Suppression R2 impossible.' });
      }
      return res.json({ success: true, key });
    } catch (error) {
      console.error('[adminDeleteVideo]', error && (error.code || error.message));
      return res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
  }
);

async function metaGraphRequest(path, method, payload, token) {
  const response = await fetch('https://graph.facebook.com/' + META_GRAPH_VERSION + '/' + path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify({ ...payload, access_token: token }) : undefined
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error) {
    const message =
      (json.error && (json.error.error_user_msg || json.error.message)) ||
      'Meta API HTTP ' + response.status;
    throw new Error(message);
  }
  return json;
}

async function tiktokRequest(path, method, payload, token) {
  const response = await fetch(TIKTOK_API_BASE + path, {
    method: method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Access-Token': token
    },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || (typeof json.code === 'number' && json.code !== 0)) {
    throw new Error(json.message || 'TikTok API HTTP ' + response.status);
  }
  return json.data || json;
}

function metaAdsManagerUrl(accountId) {
  const act = String(accountId || '').replace(/^act_/, '');
  return 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=' + encodeURIComponent(act);
}

function tiktokAdsManagerUrl(advertiserId) {
  return (
    'https://ads.tiktok.com/i18n/dashboard?aadvid=' +
    encodeURIComponent(String(advertiserId || ''))
  );
}

async function createMetaCampaign(options) {
  const account = String(options.accountId || '').replace(/^act_/, '');
  if (!account) throw new Error('Meta Ad Account ID missing.');
  const status = options.startPaused ? 'PAUSED' : 'ACTIVE';
  const campaign = await metaGraphRequest(
    'act_' + account + '/campaigns',
    'POST',
    {
      name: options.campaignName,
      objective: 'OUTCOME_TRAFFIC',
      status,
      special_ad_categories: []
    },
    options.token
  );
  const adset = await metaGraphRequest(
    'act_' + account + '/adsets',
    'POST',
    {
      name: options.campaignName + ' - MA 21-55',
      campaign_id: campaign.id,
      daily_budget: Math.round(options.dailyBudgetMad * 100),
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LINK_CLICKS',
      destination_type: 'WEBSITE',
      targeting: {
        geo_locations: { countries: ['MA'] },
        age_min: 21,
        age_max: 55
      },
      status
    },
    options.token
  );
  return {
    externalCampaignId: String(campaign.id),
    externalAdSetId: String(adset.id),
    status,
    adsManagerUrl: metaAdsManagerUrl(account)
  };
}

async function createTiktokCampaign(options) {
  const advertiserId = String(options.advertiserId || '');
  if (!advertiserId) throw new Error('TikTok Advertiser ID missing.');
  const operationStatus = options.startPaused ? 'DISABLE' : 'ENABLE';
  const budget = Math.max(20, Math.round(options.dailyBudgetMad * 100) / 100);
  const campaign = await tiktokRequest(
    '/campaign/create/',
    'POST',
    {
      advertiser_id: advertiserId,
      campaign_name: options.campaignName,
      objective_type: 'TRAFFIC',
      budget_mode: 'BUDGET_MODE_DAY',
      budget,
      operation_status: operationStatus
    },
    options.token
  );
  const campaignId = campaign.campaign_id || campaign.campaignId;
  if (!campaignId) throw new Error('TikTok campaign id missing in response.');
  const adgroup = await tiktokRequest(
    '/adgroup/create/',
    'POST',
    {
      advertiser_id: advertiserId,
      campaign_id: campaignId,
      adgroup_name: options.campaignName + ' - MA 21-55',
      budget_mode: 'BUDGET_MODE_DAY',
      budget,
      schedule_type: 'SCHEDULE_FROM_NOW',
      location_ids: [TIKTOK_LOCATION_MA],
      age_groups: ['AGE_21_34', 'AGE_35_44', 'AGE_45_54', 'AGE_55_100'],
      gender: 'GENDER_UNLIMITED',
      pacing: 'PACING_MODE_SMOOTH',
      billing_event: 'CPC',
      bid_type: 'BID_TYPE_NO_BID',
      optimization_goal: 'CLICK',
      operation_status: operationStatus
    },
    options.token
  );
  return {
    externalCampaignId: String(campaignId),
    externalAdSetId: String(adgroup.adgroup_id || adgroup.adgroupId || ''),
    status: operationStatus === 'ENABLE' ? 'ACTIVE' : 'PAUSED',
    adsManagerUrl: tiktokAdsManagerUrl(advertiserId)
  };
}

const CAROUSEL_MIN_PRODUCTS = 3;
const CAROUSEL_MAX_PRODUCTS = 20;
const META_CAROUSEL_MAX_CARDS = 10;

function carouselCampaignSlug(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'smartswika-selection';
}

function buildCarouselProductLinks(products, source, slug) {
  const safeSource = source === 'meta' ? 'meta' : 'tiktok';
  return products.map((product) => {
    const id = encodeURIComponent(String(product.id));
    return (
      ADS_BASE_URL +
      '/produit.html?id=' + id +
      '&utm_source=' + safeSource +
      '&utm_medium=paid_social' +
      '&utm_campaign=carousel_' + encodeURIComponent(slug) +
      '&utm_content=' + id
    );
  });
}

async function createMetaCarouselCampaign(options) {
  const account = String(options.accountId || '').replace(/^act_/, '');
  if (!account || !options.pageId) {
    throw new Error('Meta Ad Account ID or Page ID missing.');
  }
  const base = await createMetaCampaign({
    accountId: account,
    token: options.token,
    campaignName: options.campaignName,
    dailyBudgetMad: options.dailyBudgetMad,
    startPaused: options.startPaused
  });
  const cards = options.products.slice(0, META_CAROUSEL_MAX_CARDS).map((product) => ({
    link: product.link,
    name: String(product.title || '').slice(0, 80),
    description: String(product.priceMad || '')
      .concat(product.text ? ' · ' + String(product.text) : '')
      .slice(0, 80),
    picture: product.imageUrl,
    call_to_action: { type: 'SHOP_NOW' }
  }));
  const creative = await metaGraphRequest(
    'act_' + account + '/adcreatives',
    'POST',
    {
      name: options.campaignName + ' - Carrousel',
      object_story_spec: {
        page_id: String(options.pageId),
        link_data: {
          message: options.message,
          link: options.products[0].link,
          name: options.campaignName,
          description: options.products.length + ' produits Smartswika',
          child_attachments: cards,
          call_to_action: { type: 'SHOP_NOW' },
          multi_share_optimized: true
        }
      }
    },
    options.token
  );
  const ad = await metaGraphRequest(
    'act_' + account + '/ads',
    'POST',
    {
      name: options.campaignName + ' - Carrousel Ad',
      adset_id: base.externalAdSetId,
      creative: { creative_id: creative.id },
      status: options.startPaused ? 'PAUSED' : 'ACTIVE'
    },
    options.token
  );
  return {
    ...base,
    externalCreativeId: String(creative.id),
    externalAdId: String(ad.id),
    metaCardCount: cards.length
  };
}

function normalizeAdCopy(value) {
  if (value && typeof value === 'object') {
    return {
      fr: stripHtml(value.fr || value.FR || '').slice(0, 2000),
      en: stripHtml(value.en || value.EN || '').slice(0, 2000),
      ar: stripHtml(value.ar || value.AR || '').slice(0, 2000)
    };
  }
  const text = stripHtml(value || '').slice(0, 2000);
  return { fr: text, en: text, ar: text };
}

const USD_MAD_DEFAULT_RATE = 10;

function roundMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function normalizeMediaList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 20)
    .map((item) => {
      const type = item && item.type === 'video' ? 'video' : 'image';
      const url = String((item && item.url) || '').trim();
      const posterUrl = String((item && item.posterUrl) || '').trim();
      if (!/^https:\/\//i.test(url)) return null;
      return {
        type,
        url,
        posterUrl: /^https:\/\//i.test(posterUrl) ? posterUrl : ''
      };
    })
    .filter(Boolean);
}

function normalizeCarouselCards(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 20)
    .map((card) => {
      if (!card || !card.productId) return null;
      const mediaUrl = String(card.mediaUrl || card.imageUrl || '').trim();
      const posterUrl = String(card.posterUrl || card.imageUrl || '').trim();
      const mediaType = card.mediaType === 'video' ? 'video' : 'image';
      return {
        productId: String(card.productId).slice(0, 128),
        title: stripHtml(card.title || '').slice(0, 120),
        priceMad: stripHtml(card.priceMad || card.price || '').slice(0, 40),
        text: stripHtml(card.text || '').slice(0, 300),
        imageUrl: /^https:\/\//i.test(String(card.imageUrl || '')) ? String(card.imageUrl) : '',
        mediaType,
        mediaUrl: /^https:\/\//i.test(mediaUrl) ? mediaUrl : '',
        posterUrl: /^https:\/\//i.test(posterUrl) ? posterUrl : ''
      };
    })
    .filter(Boolean);
}

function resolveCampaignBudget(data) {
  const durationDays = Math.max(
    0,
    Math.min(365, Math.round(Number(data.durationDays) || 0))
  );
  const usdMadRate =
    Number(data.usdMadRate) > 0 ? Number(data.usdMadRate) : USD_MAD_DEFAULT_RATE;
  const totalBudgetUsd = Math.max(0, roundMoney(data.totalBudgetUsd));
  const totalMadInput =
    Number(data.totalBudgetMad) > 0
      ? roundMoney(data.totalBudgetMad)
      : roundMoney(totalBudgetUsd * usdMadRate);
  let dailyBudgetMad = Number(data.dailyBudgetMad) || 0;
  if (durationDays > 0 && totalMadInput > 0) {
    dailyBudgetMad = totalMadInput / durationDays;
  }
  dailyBudgetMad = positiveBudget(dailyBudgetMad || 20);
  const totalBudgetMad =
    totalMadInput > 0 ? totalMadInput : roundMoney(dailyBudgetMad * Math.max(1, durationDays));
  const totalUsd =
    totalBudgetUsd > 0 ? totalBudgetUsd : roundMoney(totalBudgetMad / usdMadRate);
  return {
    dailyBudgetMad,
    durationDays,
    totalBudgetMad: roundMoney(totalBudgetMad),
    totalBudgetUsd: roundMoney(totalUsd),
    currency: String(data.currency || (totalBudgetUsd > 0 ? 'USD' : 'MAD')).toUpperCase() === 'USD' ? 'USD' : 'MAD',
    usdMadRate,
    endsAt:
      durationDays > 0
        ? Timestamp.fromMillis(Date.now() + durationDays * 24 * 60 * 60 * 1000)
        : null
  };
}

function creativeFields(data) {
  return {
    headline: stripHtml(data.headline || '').slice(0, 120),
    description: stripHtml(data.description || '').slice(0, 300),
    ctaLabel: stripHtml(data.ctaLabel || '').slice(0, 40),
    customMedia: normalizeMediaList(data.customMedia || data.customImages),
    carouselCards: normalizeCarouselCards(data.carouselCards)
  };
}

function campaignBudgetPatch(budget) {
  const patch = {
    dailyBudgetMad: budget.dailyBudgetMad,
    durationDays: budget.durationDays,
    totalBudgetMad: budget.totalBudgetMad,
    totalBudgetUsd: budget.totalBudgetUsd,
    currency: budget.currency,
    usdMadRate: budget.usdMadRate,
    endsAt: budget.endsAt || null
  };
  return patch;
}

async function createMetaSingleCreativeAd(options) {
  if (!options.pageId) return null;
  const media = Array.isArray(options.customMedia) ? options.customMedia : [];
  const video = media.find((item) => item.type === 'video');
  const image = media.find((item) => item.type === 'image');
  if (!video && !image && !options.headline) return null;
  const account = String(options.accountId || '').replace(/^act_/, '');
  let storySpec;
  if (video) {
    const uploaded = await metaGraphRequest(
      'act_' + account + '/advideos',
      'POST',
      {
        file_url: video.url,
        title: options.headline || options.campaignName
      },
      options.token
    );
    storySpec = {
      page_id: String(options.pageId),
      video_data: {
        video_id: String(uploaded.id),
        message: options.message,
        title: options.headline || '',
        link_description: options.description || '',
        image_url: video.posterUrl || (image && image.url) || '',
        call_to_action: {
          type: 'SHOP_NOW',
          value: { link: options.destinationUrl }
        }
      }
    };
  } else {
    storySpec = {
      page_id: String(options.pageId),
      link_data: {
        message: options.message,
        link: options.destinationUrl,
        name: options.headline || options.campaignName,
        description: options.description || '',
        picture: image ? image.url : '',
        call_to_action: { type: 'SHOP_NOW' }
      }
    };
  }
  const creative = await metaGraphRequest(
    'act_' + account + '/adcreatives',
    'POST',
    {
      name: options.campaignName + ' - Creative',
      object_story_spec: storySpec
    },
    options.token
  );
  const ad = await metaGraphRequest(
    'act_' + account + '/ads',
    'POST',
    {
      name: options.campaignName + ' - Ad',
      adset_id: options.externalAdSetId,
      creative: { creative_id: creative.id },
      status: options.startPaused ? 'PAUSED' : 'ACTIVE'
    },
    options.token
  );
  return {
    externalCreativeId: String(creative.id),
    externalAdId: String(ad.id)
  };
}

async function uploadTiktokVideo(advertiserId, token, media) {
  const video = (Array.isArray(media) ? media : []).find(
    (item) => item.type === 'video'
  );
  if (!video) return null;
  return tiktokRequest(
    '/file/video/ad/upload/',
    'POST',
    {
      advertiser_id: String(advertiserId),
      upload_type: 'UPLOAD_BY_URL',
      video_url: video.url
    },
    token
  );
}

async function syncCampaignBudgetToPlatform(campaign, budget, secrets) {
  const warnings = [];
  try {
    if (
      campaign.platform === 'meta' &&
      campaign.externalAdSetId &&
      secrets.metaAccessToken &&
      secrets.metaAdAccountId
    ) {
      await metaGraphRequest(
        String(campaign.externalAdSetId),
        'POST',
        { daily_budget: Math.round(budget.dailyBudgetMad * 100) },
        String(secrets.metaAccessToken)
      );
    } else if (
      campaign.platform === 'tiktok' &&
      campaign.externalAdSetId &&
      secrets.tiktokAccessToken &&
      secrets.tiktokAdvertiserId
    ) {
      await tiktokRequest(
        '/adgroup/update/',
        'POST',
        {
          advertiser_id: String(secrets.tiktokAdvertiserId),
          adgroup_id: String(campaign.externalAdSetId),
          budget_mode: 'BUDGET_MODE_DAY',
          budget: budget.dailyBudgetMad
        },
        String(secrets.tiktokAccessToken)
      );
    }
  } catch (error) {
    warnings.push(String((error && error.message) || 'Budget sync failed.').slice(0, 300));
  }
  return warnings;
}

async function pauseExternalCampaign(campaign, secrets) {
  if (!campaign || !campaign.externalCampaignId) return false;
  if (campaign.platform === 'meta' && secrets.metaAccessToken) {
    await metaGraphRequest(
      String(campaign.externalCampaignId),
      'POST',
      { status: 'PAUSED' },
      String(secrets.metaAccessToken)
    );
    return true;
  }
  if (
    campaign.platform === 'tiktok' &&
    secrets.tiktokAccessToken &&
    secrets.tiktokAdvertiserId
  ) {
    await tiktokRequest(
      '/campaign/status/update/',
      'POST',
      {
        advertiser_id: String(secrets.tiktokAdvertiserId),
        campaign_ids: [String(campaign.externalCampaignId)],
        operation_status: 'DISABLE'
      },
      String(secrets.tiktokAccessToken)
    );
    return true;
  }
  return false;
}

exports.launchSuggestedAdCampaign = onCall(
  { region: 'europe-west1', timeoutSeconds: 120, maxInstances: 5 },
  async (request) => {
    const adminUid = await requireAdminCallable(request);
    const data = request.data || {};
    const platform = String(data.platform || '').toLowerCase();
    if (!['meta', 'tiktok', 'both'].includes(platform)) {
      throw new HttpsError('invalid-argument', 'platform must be meta, tiktok or both.');
    }
    const productId = String(data.productId || '').trim();
    if (!productId) throw new HttpsError('invalid-argument', 'productId is required.');
    const productSnap = await db.doc('products/' + productId).get();
    if (!productSnap.exists) throw new HttpsError('not-found', 'Product not found.');
    const product = { id: productSnap.id, ...productSnap.data() };
    if (!isOfficialSmartswikaProduct(product)) {
      throw new HttpsError(
        'permission-denied',
        'Only official Smartswika products can be launched from this tool.'
      );
    }
    if (product.status !== 'approved' || Number(product.stock) <= 0) {
      throw new HttpsError(
        'failed-precondition',
        'Product must be approved and in stock.'
      );
    }

    const title = catalogProductTitle(product) || productId;
    const campaignName =
      String(data.campaignName || '').trim().slice(0, 120) ||
      ('Smartswika ' + title + ' ' + platform).slice(0, 120);
    const budget = resolveCampaignBudget(data);
    const dailyBudgetMad = budget.dailyBudgetMad;
    const destinationUrl = sanitizeUrl(data.destinationUrl);
    const startPaused = data.startPaused !== false;
    const adCopy = normalizeAdCopy(data.adCopy);
    const creative = creativeFields(data);
    const message =
      adCopy[String(data.language || 'fr')] || adCopy.fr || adCopy.en || adCopy.ar || campaignName;
    const secrets = await readAdsSecrets();
    const requested = platform === 'both' ? ['meta', 'tiktok'] : [platform];
    const campaigns = [];
    const prepared = [];
    const errors = [];

    for (const current of requested) {
      const isMeta = current === 'meta';
      const token = isMeta
        ? String(secrets.metaAccessToken || '')
        : String(secrets.tiktokAccessToken || '');
      const accountId = isMeta
        ? String(secrets.metaAdAccountId || '')
        : String(secrets.tiktokAdvertiserId || '');
      const adsManagerUrl = isMeta
        ? metaAdsManagerUrl(accountId)
        : tiktokAdsManagerUrl(accountId);

      if (!token || !accountId) {
        prepared.push({
          platform: current,
          reason: 'tokens_not_configured',
          adsManagerUrl,
          destinationUrl,
          adCopy,
          ...creative,
          ...campaignBudgetPatch(budget)
        });
        continue;
      }

      try {
        const created = isMeta
          ? await createMetaCampaign({
              accountId,
              token,
              campaignName,
              dailyBudgetMad,
              startPaused
            })
          : await createTiktokCampaign({
              advertiserId: accountId,
              token,
              campaignName,
              dailyBudgetMad,
              startPaused
            });
        let extraCreative = {};
        if (isMeta && secrets.metaPageId) {
          const metaCreative = await createMetaSingleCreativeAd({
            accountId,
            token,
            pageId: String(secrets.metaPageId),
            campaignName,
            externalAdSetId: created.externalAdSetId,
            message,
            headline: creative.headline,
            description: creative.description,
            customMedia: creative.customMedia,
            destinationUrl,
            startPaused
          });
          if (metaCreative) extraCreative = metaCreative;
        } else if (!isMeta) {
          const uploadedVideo = await uploadTiktokVideo(
            accountId,
            token,
            creative.customMedia
          ).catch(() => null);
          if (uploadedVideo) {
            extraCreative.externalVideoId = String(
              uploadedVideo.video_id || uploadedVideo.videoId || ''
            );
          }
        }
        const docRef = await db.collection(AD_CAMPAIGNS_COLLECTION).add({
          platform: current,
          externalCampaignId: created.externalCampaignId,
          externalAdSetId: created.externalAdSetId || '',
          externalCreativeId: extraCreative.externalCreativeId || '',
          externalAdId: extraCreative.externalAdId || '',
          externalVideoId: extraCreative.externalVideoId || '',
          productId,
          productTitle: title,
          campaignName,
          status: created.status,
          destinationUrl,
          adCopy,
          ...creative,
          customImages: creative.customMedia
            .filter((item) => item.type === 'image')
            .map((item) => item.url),
          ...campaignBudgetPatch(budget),
          createdBy: adminUid,
          createdAt: FieldValue.serverTimestamp()
        });
        campaigns.push({
          campaignDocId: docRef.id,
          platform: current,
          externalCampaignId: created.externalCampaignId,
          externalAdSetId: created.externalAdSetId || '',
          status: created.status,
          adsManagerUrl: created.adsManagerUrl
        });
      } catch (error) {
        errors.push({
          platform: current,
          message: String((error && error.message) || 'API error').slice(0, 500)
        });
      }
    }

    if (!campaigns.length && errors.length) {
      throw new HttpsError(
        'failed-precondition',
        errors.map((item) => item.platform + ': ' + item.message).join(' | ')
      );
    }

    return {
      mode: campaigns.length
        ? prepared.length || errors.length
          ? 'partial'
          : 'launched'
        : 'prepared',
      campaigns,
      prepared,
      errors,
      adsManagerUrl:
        (campaigns[0] && campaigns[0].adsManagerUrl) ||
        (prepared[0] && prepared[0].adsManagerUrl) ||
        metaAdsManagerUrl(secrets.metaAdAccountId),
      adCopy,
      ...creative,
      ...campaignBudgetPatch(budget),
      destinationUrl,
      startPaused
    };
  }
);

exports.launchMultiProductCarouselCampaign = onCall(
  { region: 'europe-west1', timeoutSeconds: 180, maxInstances: 5 },
  async (request) => {
    const adminUid = await requireAdminCallable(request);
    const data = request.data || {};
    const platform = String(data.platform || '').toLowerCase();
    if (!['meta', 'tiktok', 'both'].includes(platform)) {
      throw new HttpsError('invalid-argument', 'platform must be meta, tiktok or both.');
    }
    if (!Array.isArray(data.productIds)) {
      throw new HttpsError('invalid-argument', 'productIds must be an array.');
    }
    const productIds = [
      ...new Set(
        data.productIds.map((value) => String(value || '').trim()).filter(Boolean)
      )
    ];
    if (
      productIds.length < CAROUSEL_MIN_PRODUCTS ||
      productIds.length > CAROUSEL_MAX_PRODUCTS
    ) {
      throw new HttpsError(
        'invalid-argument',
        'productIds must contain between 3 and 20 products.'
      );
    }

    const snapshots = await Promise.all(
      productIds.map((productId) => db.doc('products/' + productId).get())
    );
    const products = snapshots.map((snapshot, index) => {
      const productId = productIds[index];
      if (!snapshot.exists) {
        throw new HttpsError('not-found', 'Product not found: ' + productId);
      }
      const product = { id: snapshot.id, ...snapshot.data() };
      if (!isOfficialSmartswikaProduct(product)) {
        throw new HttpsError(
          'permission-denied',
          'Only official Smartswika products can be used in a carousel: ' + productId
        );
      }
      if (product.status !== 'approved' || Number(product.stock) <= 0) {
        throw new HttpsError(
          'failed-precondition',
          'Product must be approved and in stock: ' + productId
        );
      }
      return product;
    });

    const campaignName =
      String(data.campaignName || '').trim().slice(0, 120) ||
      'Carrousel Smartswika - Top Selection';
    const campaignSlug = carouselCampaignSlug(campaignName);
    const budget = resolveCampaignBudget(data);
    const dailyBudgetMad = budget.dailyBudgetMad;
    const startPaused = data.startPaused !== false;
    const language = ['fr', 'en', 'ar'].includes(String(data.language || ''))
      ? String(data.language)
      : 'fr';
    const adCopy = normalizeAdCopy(data.adCopy);
    const creative = creativeFields(data);
    const message =
      adCopy[language] || adCopy.fr || adCopy.en || adCopy.ar || campaignName;
    const secrets = await readAdsSecrets();
    const requested = platform === 'both' ? ['meta', 'tiktok'] : [platform];
    const campaigns = [];
    const prepared = [];
    const errors = [];
    const payloadFor = (source) => {
      const links = buildCarouselProductLinks(products, source, campaignSlug);
      const overrides = new Map(
        creative.carouselCards.map((card) => [String(card.productId), card])
      );
      return products.map((product, index) => {
        const card = overrides.get(String(product.id)) || {};
        const cardMedia = card.mediaUrl || card.imageUrl || '';
        const fallbackImage = absoluteAssetUrl(product.img || (product.gallery || [])[0]);
        return {
          id: product.id,
          title: card.title || catalogProductTitle(product) || product.id,
          priceMad: card.priceMad || catalogPriceMad(product) || '0.00 MAD',
          text: card.text || '',
          imageUrl:
            card.mediaType === 'video'
              ? card.posterUrl || fallbackImage
              : cardMedia || fallbackImage,
          mediaType: card.mediaType || 'image',
          mediaUrl: cardMedia,
          posterUrl: card.posterUrl || '',
          link: links[index]
        };
      });
    };

    for (const current of requested) {
      const isMeta = current === 'meta';
      const token = isMeta
        ? String(secrets.metaAccessToken || '')
        : String(secrets.tiktokAccessToken || '');
      const accountId = isMeta
        ? String(secrets.metaAdAccountId || '')
        : String(secrets.tiktokAdvertiserId || '');
      const pageId = isMeta ? String(secrets.metaPageId || '') : '';
      const productsForPlatform = payloadFor(current);
      const productUrls = productsForPlatform.map((product) => product.link);
      const adsManagerUrl = isMeta
        ? metaAdsManagerUrl(accountId)
        : tiktokAdsManagerUrl(accountId);
      const configured = Boolean(token && accountId && (!isMeta || pageId));

      if (!configured) {
        prepared.push({
          platform: current,
          reason: 'tokens_not_configured',
          adsManagerUrl,
          productUrls,
          adCopy,
          ...creative,
          ...campaignBudgetPatch(budget),
          productCount: productUrls.length
        });
        continue;
      }

      try {
        const created = isMeta
          ? await createMetaCarouselCampaign({
              accountId,
              token,
              pageId,
              campaignName,
              dailyBudgetMad,
              startPaused,
              products: productsForPlatform,
              message
            })
          : await createTiktokCampaign({
              advertiserId: accountId,
              token,
              campaignName: campaignName + ' - Carrousel',
              dailyBudgetMad,
              startPaused
            });
        const docRef = await db.collection(AD_CAMPAIGNS_COLLECTION).add({
          type: 'carousel',
          platform: current,
          externalCampaignId: created.externalCampaignId,
          externalAdSetId: created.externalAdSetId || '',
          externalCreativeId: created.externalCreativeId || '',
          externalAdId: created.externalAdId || '',
          productId: productIds[0],
          productIds,
          productCount: productIds.length,
          productTitle: productIds.length + ' produits Smartswika',
          campaignName,
          status: created.status,
          destinationUrl: productUrls[0],
          productUrls,
          utmCampaign: 'carousel_' + campaignSlug,
          adCopy,
          ...creative,
          customImages: creative.customMedia
            .filter((item) => item.type === 'image')
            .map((item) => item.url),
          ...campaignBudgetPatch(budget),
          createdBy: adminUid,
          createdAt: FieldValue.serverTimestamp()
        });
        campaigns.push({
          campaignDocId: docRef.id,
          platform: current,
          externalCampaignId: created.externalCampaignId,
          externalAdSetId: created.externalAdSetId || '',
          externalCreativeId: created.externalCreativeId || '',
          externalAdId: created.externalAdId || '',
          metaCardCount: created.metaCardCount || 0,
          status: created.status,
          adsManagerUrl: created.adsManagerUrl
        });
      } catch (error) {
        errors.push({
          platform: current,
          message: String((error && error.message) || 'API error').slice(0, 500)
        });
      }
    }

    if (!campaigns.length && errors.length) {
      throw new HttpsError(
        'failed-precondition',
        errors.map((item) => item.platform + ': ' + item.message).join(' | ')
      );
    }

    const responseProducts = payloadFor(platform === 'tiktok' ? 'tiktok' : 'meta');
    return {
      mode: campaigns.length
        ? prepared.length || errors.length
          ? 'partial'
          : 'launched'
        : 'prepared',
      type: 'carousel',
      productCount: productIds.length,
      productUrls: responseProducts.map((product) => product.link),
      campaigns,
      prepared,
      errors,
      adsManagerUrl:
        (campaigns[0] && campaigns[0].adsManagerUrl) ||
        (prepared[0] && prepared[0].adsManagerUrl) ||
        metaAdsManagerUrl(secrets.metaAdAccountId),
      adCopy,
      campaignName,
      startPaused
    };
  }
);

exports.updateAdCampaignSettings = onCall(
  { region: 'europe-west1', timeoutSeconds: 120, maxInstances: 5 },
  async (request) => {
    const adminUid = await requireAdminCallable(request);
    const data = request.data || {};
    const campaignDocId = String(data.campaignDocId || '').trim();
    const creative = creativeFields(data);
    const hasBudgetChange = [
      'dailyBudgetMad',
      'durationDays',
      'totalBudgetUsd',
      'totalBudgetMad',
      'usdMadRate',
      'currency'
    ].some((key) => data[key] !== undefined && data[key] !== null && data[key] !== '');
    const budget = hasBudgetChange ? resolveCampaignBudget(data) : null;
    const adCopy = data.adCopy ? normalizeAdCopy(data.adCopy) : null;

    if (!campaignDocId) {
      const draftBudget = budget || resolveCampaignBudget({ dailyBudgetMad: 20 });
      const draftRef = await db.collection(AD_CAMPAIGNS_COLLECTION).add({
        type: data.type === 'carousel' ? 'carousel' : 'suggestion',
        platform: ['meta', 'tiktok', 'both'].includes(String(data.platform))
          ? String(data.platform)
          : 'meta',
        status: 'DRAFT',
        productId: String(data.productId || ''),
        productIds: Array.isArray(data.productIds)
          ? data.productIds.map(String).slice(0, 20)
          : [],
        productCount: Array.isArray(data.productIds) ? data.productIds.length : 0,
        productTitle: String(data.productTitle || '').slice(0, 160),
        campaignName:
          String(data.campaignName || '').trim().slice(0, 120) ||
          'Brouillon Smartswika',
        destinationUrl: String(data.destinationUrl || '').slice(0, 2048),
        adCopy: adCopy || normalizeAdCopy(''),
        ...creative,
        customImages: creative.customMedia
          .filter((item) => item.type === 'image')
          .map((item) => item.url),
        ...campaignBudgetPatch(draftBudget),
        createdBy: adminUid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      return {
        campaignDocId: draftRef.id,
        status: 'DRAFT',
        mode: 'draft',
        syncWarnings: []
      };
    }

    const ref = db.collection(AD_CAMPAIGNS_COLLECTION).doc(campaignDocId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Campaign not found.');
    const existing = snap.data() || {};
    const patch = {
      updatedAt: FieldValue.serverTimestamp()
    };
    if (data.campaignName !== undefined) {
      patch.campaignName = String(data.campaignName || '').trim().slice(0, 120);
    }
    if (data.platform !== undefined && ['meta', 'tiktok', 'both'].includes(String(data.platform))) {
      patch.platform = String(data.platform);
    }
    if (Array.isArray(data.productIds)) {
      patch.productIds = data.productIds.map(String).slice(0, 20);
      patch.productCount = patch.productIds.length;
      if (patch.productIds[0]) patch.productId = patch.productIds[0];
    }
    if (adCopy) patch.adCopy = adCopy;
    Object.assign(patch, creative);
    patch.customImages = creative.customMedia
      .filter((item) => item.type === 'image')
      .map((item) => item.url);
    patch.customMedia = creative.customMedia;
    patch.carouselCards = creative.carouselCards;
    let syncWarnings = [];
    if (budget) {
      Object.assign(patch, campaignBudgetPatch(budget));
      const secrets = await readAdsSecrets();
      syncWarnings = await syncCampaignBudgetToPlatform(
        { ...existing, ...patch },
        budget,
        secrets
      );
    }
    await ref.update(patch);
    return {
      campaignDocId,
      status: existing.status || 'DRAFT',
      mode: 'updated',
      dailyBudgetMad: patch.dailyBudgetMad ?? existing.dailyBudgetMad ?? 0,
      durationDays: patch.durationDays ?? existing.durationDays ?? 0,
      totalBudgetMad: patch.totalBudgetMad ?? existing.totalBudgetMad ?? 0,
      totalBudgetUsd: patch.totalBudgetUsd ?? existing.totalBudgetUsd ?? 0,
      endsAt: patch.endsAt || existing.endsAt || null,
      syncWarnings
    };
  }
);

exports.autoPauseExpiredAdCampaigns = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: 'Africa/Casablanca',
    region: 'europe-west1',
    timeoutSeconds: 300
  },
  async () => {
    const now = Date.now();
    const snapshot = await db
      .collection(AD_CAMPAIGNS_COLLECTION)
      .where('status', '==', 'ACTIVE')
      .limit(500)
      .get();
    const secrets = await readAdsSecrets();
    let paused = 0;
    for (const docSnap of snapshot.docs) {
      const campaign = { id: docSnap.id, ...docSnap.data() };
      const endsAt = campaign.endsAt;
      const endsAtMs = endsAt && typeof endsAt.toMillis === 'function'
        ? endsAt.toMillis()
        : endsAt instanceof Date
        ? endsAt.getTime()
        : Number(endsAt) || 0;
      if (!endsAtMs || endsAtMs > now) continue;
      try {
        await pauseExternalCampaign(campaign, secrets);
      } catch (error) {
        console.warn(
          '[autoPauseExpiredAdCampaigns]',
          docSnap.id,
          error && (error.code || error.message)
        );
      }
      await docSnap.ref.update({
        status: 'PAUSED',
        autoPausedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      paused += 1;
    }
    console.log('[autoPauseExpiredAdCampaigns]', JSON.stringify({ scanned: snapshot.size, paused }));
  }
);

exports.toggleAdCampaignStatus = onCall(
  { region: 'europe-west1', timeoutSeconds: 60, maxInstances: 5 },
  async (request) => {
    await requireAdminCallable(request);
    const data = request.data || {};
    const campaignDocId = String(data.campaignDocId || '').trim();
    const action = String(data.action || '').toUpperCase();
    if (!campaignDocId) throw new HttpsError('invalid-argument', 'campaignDocId is required.');
    if (!['ACTIVE', 'PAUSED'].includes(action)) {
      throw new HttpsError('invalid-argument', 'action must be ACTIVE or PAUSED.');
    }
    const ref = db.collection(AD_CAMPAIGNS_COLLECTION).doc(campaignDocId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Campaign not found.');
    const campaign = snap.data() || {};
    const secrets = await readAdsSecrets();
    let synced = false;

    if (campaign.externalCampaignId) {
      if (campaign.platform === 'meta') {
        const token = String(secrets.metaAccessToken || '');
        const accountId = String(secrets.metaAdAccountId || '');
        if (!token || !accountId) {
          throw new HttpsError('failed-precondition', 'Meta credentials are missing.');
        }
        await metaGraphRequest(
          String(campaign.externalCampaignId),
          'POST',
          { status: action === 'ACTIVE' ? 'ACTIVE' : 'PAUSED' },
          token
        );
        synced = true;
      } else if (campaign.platform === 'tiktok') {
        const token = String(secrets.tiktokAccessToken || '');
        const advertiserId = String(secrets.tiktokAdvertiserId || '');
        if (!token || !advertiserId) {
          throw new HttpsError('failed-precondition', 'TikTok credentials are missing.');
        }
        await tiktokRequest(
          '/campaign/status/update/',
          'POST',
          {
            advertiser_id: advertiserId,
            campaign_ids: [String(campaign.externalCampaignId)],
            operation_status: action === 'ACTIVE' ? 'ENABLE' : 'DISABLE'
          },
          token
        );
        synced = true;
      }
    }

    await ref.update({
      status: action,
      updatedAt: FieldValue.serverTimestamp()
    });
    return { campaignDocId, status: action, synced };
  }
);

exports.testAdPlatformConnection = onCall(
  { region: 'europe-west1', timeoutSeconds: 30, maxInstances: 5 },
  async (request) => {
    await requireAdminCallable(request);
    const platform = String((request.data || {}).platform || '').toLowerCase();
    if (!['meta', 'tiktok'].includes(platform)) {
      throw new HttpsError('invalid-argument', 'platform must be meta or tiktok.');
    }
    const secrets = await readAdsSecrets();
    if (platform === 'meta') {
      const accountId = String(secrets.metaAdAccountId || '').replace(/^act_/, '');
      const token = String(secrets.metaAccessToken || '');
      if (!accountId || !token) {
        return { platform, configured: false, connected: false };
      }
      const url =
        'https://graph.facebook.com/' +
        META_GRAPH_VERSION +
        '/act_' +
        encodeURIComponent(accountId) +
        '?fields=name,account_status,currency&access_token=' +
        encodeURIComponent(token);
      const response = await fetch(url);
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.error) {
        throw new HttpsError(
          'failed-precondition',
          (json.error && json.error.message) || 'Meta connection failed.'
        );
      }
      const statusMap = {
        1: 'ACTIVE',
        2: 'DISABLED',
        3: 'UNSETTLED',
        7: 'PENDING_RISK_REVIEW',
        8: 'PENDING_SETTLEMENT',
        9: 'IN_GRACE_PERIOD',
        100: 'PENDING_CLOSURE',
        101: 'CLOSED',
        201: 'ANY_ACTIVE',
        202: 'ANY_CLOSED'
      };
      return {
        platform,
        configured: true,
        connected: true,
        accountName: String(json.name || ''),
        status: statusMap[Number(json.account_status)] || String(json.account_status || ''),
        currency: String(json.currency || '')
      };
    }

    const advertiserId = String(secrets.tiktokAdvertiserId || '');
    const token = String(secrets.tiktokAccessToken || '');
    if (!advertiserId || !token) {
      return { platform, configured: false, connected: false };
    }
    const info = await tiktokRequest(
      '/advertiser/info/?advertiser_ids=' +
        encodeURIComponent(JSON.stringify([advertiserId])),
      'GET',
      null,
      token
    );
    const list = Array.isArray(info) ? info : info.list || [];
    const account = list[0] || {};
    return {
      platform,
      configured: true,
      connected: true,
      accountName: String(account.name || account.advertiser_name || ''),
      status: String(account.status || account.advertiser_status || ''),
      currency: String(account.currency || '')
    };
  }
);

/* __ADS_END__ */






/* Notifications push + in-app + emails EmailJS : enregistre les déclencheurs.
   IMPORTANT : Object.assign est obligatoire — `require('./triggers')` seul
   posait les exports sur le module triggers.js, pas sur index.js, donc
   AUCUNE fonction n'était déployée (bug corrigé le 2026-11-24). */
Object.assign(exports, require('./triggers'));

