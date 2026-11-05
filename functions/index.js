const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

initializeApp();
const db = getFirestore();
const PROJECT_ID = 'smartswi9a-31063';
const FIREBASE_WEB_API_KEY = 'AIzaSyBhULwDxPBRqjywsSD_0ny41Bmt968ofSA';

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
   - RETURN_FEE_LIVO : frais retour (doit être synchronisé avec
     CONFIG.VENDOR.RETURN_FEE_LIVO dans js/config.js)
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

const FALLBACK_DELIVERY_FEE = 30;
const RETURN_FEE_LIVO = 20;

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
  CONTRACT_VERSION: '1.3.0',
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
    profile.vendorInfo.status === 'approved' && profile.vendorInfo.contractStatus === 'accepted';
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
  const { preserveCustom = false } = options;
  const { requestDate, cities } = await fetchLivoFeesFromApi();

  if (!cities.length) throw new Error('Livo a retourné 0 ville.');

  const existingSnap = await db.collection('cities').get();
  const existingByKey = new Map();
  let maxExistingId = 0;

  existingSnap.docs.forEach(d => {
    const data = d.data();
    const key = normalizeCityKey(data.key || data.nameFr || '');
    if (key) existingByKey.set(key, { id: d.id, data });
    const existingId = Number(data.id) || 0;
    if (existingId > maxExistingId) maxExistingId = existingId;
  });

  // Anti-collision ID
  let nextId = maxExistingId + 1;

  const BATCH_SIZE = 400;
  let synced = 0, created = 0, updated = 0;

  const allCities = cities.map(c => ({
    ...c,
    displayName: c.city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  }));

  for (let i = 0; i < allCities.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = allCities.slice(i, i + BATCH_SIZE);

    chunk.forEach(c => {
      const existing = existingByKey.get(c.city);
      const docId = existing?.id || `city_${c.city.replace(/\s+/g, '_')}`;
      const ref = db.collection('cities').doc(docId);

      if (existing) {
        batch.update(ref, {
          price: c.fee,
          lastSyncedFromLivo: FieldValue.serverTimestamp()
        });
        updated++;
      } else {
        batch.set(ref, {
          id: nextId++,
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
      }
      synced++;
    });
    await batch.commit();
  }

  // Suppression des villes obsolètes
  let deleted = 0;
  if (!preserveCustom) {
    const livoKeys = new Set(cities.map(c => c.city));
    const toDelete = [];
    existingSnap.docs.forEach(d => {
      const data = d.data();
      if (data.source === 'manual') return;
      const key = normalizeCityKey(data.key || data.nameFr || '');
      if (key && !livoKeys.has(key)) toDelete.push(d.ref);
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
    requestDate,
    source: 'livo',
    created, updated, deleted
  }, { merge: true });

  return { synced, created, updated, deleted, requestDate, citiesCount: cities.length };
}

/* ============================================================
   HELPERS THROTTLE LOGIN VENDEUR
   ============================================================ */
function throttleId(email, ip) {
  return crypto.createHash('sha256').update(`${email}|${ip || 'unknown'}`).digest('hex');
}

async function isLoginThrottled(email, ip) {
  const ref = db.collection('vendorLoginThrottle').doc(throttleId(email, ip));
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
  const ref = db.collection('vendorLoginThrottle').doc(throttleId(email, ip));
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

async function clearLoginFailures(email, ip) {
  await db.collection('vendorLoginThrottle').doc(throttleId(email, ip)).delete().catch(() => {});
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
  const sourceVersion = version === "1.3.0" ? "1.2.0" : version;
  const t = templates[sourceVersion] || templates["1.2.0"];
  const text = t[lang] ? t[lang](snapshot) : t["fr"](snapshot);
  return version === "1.3.0"
    ? text.replaceAll("smartswi9a.top", "smartswika.ma").replace(/\s+/g, " ").trim()
    : text;
}

/* ============================================================
   CF : getLivoFees (PUBLIC)
   ============================================================ */
exports.getLivoFees = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    let cacheFresh = false;
    try { cacheFresh = await isLivoFeesCacheFresh(); }
    catch (e) { console.warn('[getLivoFees] Cache check failed:', e.message); }

    // Lecture Firestore avec fallback sans orderBy (B-I1)
    let cities = [];
    const mapFn = d => {
      const data = d.data();
      return {
        id: Number(data.id) || 0,
        key: data.key || '',
        nameFr: data.nameFr || data.key || '',
        nameEn: data.nameEn || data.nameFr || data.key || '',
        nameAr: data.nameAr || data.nameFr || data.key || '',
        price: Number(data.price) || FALLBACK_DELIVERY_FEE,
        delay: data.delay || '48h'
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

    // Sync arrière-plan si vide ou périmé
    if (cities.length === 0 || !cacheFresh) {
      syncLivoCitiesFromApi({ preserveCustom: true })
        .then(r => console.log('[getLivoFees] Background sync OK:', r))
        .catch(e => console.warn('[getLivoFees] Background sync failed:', e.message));
    }

    if (cities.length === 0) {
      return res.status(503).json({
        success: false,
        message: 'Grille tarifaire temporairement indisponible. Réessayez dans quelques instants.',
        source: 'none'
      });
    }

    res.set('Cache-Control', 'public, max-age=3600');
    return res.status(200).json({
      success: true,
      count: cities.length,
      source: cacheFresh ? 'firestore' : 'livo-cache-miss',
      cacheFresh,
      cities
    });
  } catch (error) {
    console.error('[getLivoFees]', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

/* ============================================================
   CF : syncLivoCities (ADMIN)
   ============================================================ */
exports.syncLivoCities = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 60 }, async (req, res) => {
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

    const result = await syncLivoCitiesFromApi({
      preserveCustom: req.body?.preserveCustom === true
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
    data.vendorInfo.contractStatus !== 'accepted'
  ) {
    return db.collection('vendorsPublic').doc(event.params.userId).delete().catch(() => {});
  }

  return db.collection('vendorsPublic').doc(event.params.userId).set({
    shopName: data.vendorInfo.shopName || 'Boutique',
    status: data.vendorInfo.status || 'pending',
    description: data.vendorInfo.description || '',
    createdAt: data.createdAt || FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
});

/* ============================================================
   CF : signVendorContract (Sécurisé + B-C1 snapshot officiel)
   ============================================================ */
exports.signVendorContract = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    const { version, language, textHash } = req.body;
    if (!version || !language || !textHash) {
      return res.status(400).json({ success: false, message: 'Données incomplètes.' });
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
      if (
        existingData.vendorId !== decoded.uid ||
        existingData.status !== 'accepted' ||
        String(existingData.version) !== String(version)
      ) {
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
    const ip = req.ip || req.get('x-forwarded-for') || 'unknown';

    await contractRef.set({
      vendorId: decoded.uid,
      version: version,
      language: language,
      termsSnapshot: officialSnapshot,  // ← officiel
      textHash: textHash,
      contractHash: contractHash,
      acceptedAt: FieldValue.serverTimestamp(),
      ipAddress: ip,
      userAgent: req.get('user-agent') || 'unknown',
      status: 'accepted',
      source: req.body.source || 'dashboard'
    });

    await db.collection('users').doc(decoded.uid).update({
      'vendorInfo.contractStatus': 'accepted',
      'vendorInfo.currentContractId': contractId,
      'vendorInfo.contractVersion': version,
      'vendorInfo.contractSignedAt': FieldValue.serverTimestamp(),
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
exports.loginVendor = onRequest({ region: 'europe-west1', maxInstances: 5, timeoutSeconds: 20 }, async (req, res) => {
  if (cors(req, res)) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  const clientIp = String(req.ip || req.get('x-forwarded-for') || 'unknown').split(',')[0].trim().slice(0, 80);

  if (!validEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ success: false, message: 'Identifiants invalides.' });
  }

  try {
    // B-C3 : throttle AVANT tout traitement
    if (await isLoginThrottled(email, clientIp)) {
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
      const authResponse = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true })
        }
      );
      if (authResponse.ok) {
        const authData = await authResponse.json();
        validCredential = authData.localId === uid;
      }
    }

    if (!validCredential) {
      await recordLoginFailure(email, clientIp);
      return res.status(401).json({ success: false, message: 'Identifiants incorrects.' });
    }

    // Ne jamais émettre de jeton vendeur pour un profil qui n'a pas le rôle vendeur.
    const canLogin = profile.role === 'vendor' && (approved(profile) || profile.vendorInfo?.status === 'pending');
    if (!canLogin) {
      return res.status(403).json({ success: false, message: statusMessage(profile) });
    }

    await clearLoginFailures(email, clientIp);

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
exports.setVendorPassword = onRequest({ region: 'europe-west1', maxInstances: 5, timeoutSeconds: 15 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = req.get('authorization').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const vendorPassword = req.body?.vendorPassword;
    if (!validPassword(vendorPassword)) {
      return res.status(400).json({ success: false, message: 'Mot de passe invalide.' });
    }

    const ref = db.collection('users').doc(decoded.uid);
    const snap = await ref.get();
    if (!snap.exists || snap.data().role !== 'vendor') {
      return res.status(403).json({ success: false, message: 'Profil invalide.' });
    }

    const passwordHash = await bcrypt.hash(vendorPassword, 12);
    await db.collection('vendorCredentials').doc(decoded.uid).set({
      uid: decoded.uid,
      email: String(snap.data().email || '').trim().toLowerCase(),
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
    let query = db.collection('orders')
      .where('vendorIds', 'array-contains', vendorId)
      .limit(300);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) break;
    orderPages++;
    scannedOrders += snap.size;

    for (const orderDoc of snap.docs) {
      const order = orderDoc.data();
      const status = String(order.status || '').toLowerCase();
      if (['cancelled', 'canceled'].includes(status)) continue;
      if (!['delivered', 'returned'].includes(status)) {
        blockers.push({ orderId: orderDoc.id, reason: `commande non clôturée (statut ${status || 'absent'})` });
        continue;
      }

      const credit = order.vendorCredits?.[vendorId];
      if (!credit?.txId || !(Number(credit.amount) > 0)) {
        blockers.push({ orderId: orderDoc.id, reason: 'crédit vendeur absent ou incomplet' });
      } else {
        const saleTx = await db.collection('wallet_transactions').doc(String(credit.txId)).get();
        const sale = saleTx.exists ? saleTx.data() : null;
        if (!sale || sale.vendorId !== vendorId || sale.orderId !== orderDoc.id ||
            sale.type !== 'sale' || !(Number(sale.amount) > 0)) {
          blockers.push({ orderId: orderDoc.id, reason: 'écriture de vente absente ou incohérente' });
        }
      }

      if (status === 'returned') {
        const returns = Array.isArray(order.returns) ? order.returns : [];
        if (returns.length === 0) {
          blockers.push({ orderId: orderDoc.id, reason: 'commande retournée sans détail de retour' });
        }
        for (let returnIndex = 0; returnIndex < returns.length; returnIndex++) {
          const entry = returns[returnIndex];
          const returnedQty = (entry?.items || []).reduce((sum, retItem) => {
            const item = (order.items || []).find(i => String(i.productId) === String(retItem.productId));
            return item?.vendorId === vendorId ? sum + Math.max(0, Number(retItem.delta) || 0) : sum;
          }, 0);
          if (returnedQty <= 0) continue;
          const debit = order.vendorDebits?.[`${vendorId}_ret${returnIndex}`];
          const expectedFee = RETURN_FEE_LIVO * returnedQty;
          if (!debit || Number(debit.amount) + 0.0001 < expectedFee) {
            blockers.push({ orderId: orderDoc.id, reason: `débit du retour ${returnIndex + 1} absent ou incomplet` });
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
exports.adminVendorAction = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
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

      const contractId = vendorInfo.currentContractId ||
        (vendorInfo.contractVersion ? `contract_${vendorId}_v${vendorInfo.contractVersion}` : '');
      if (!contractId) {
        return res.status(409).json({ success: false, message: 'Impossible d’approuver : référence du contrat signée introuvable.' });
      }

      const contractSnap = await db.collection('contracts').doc(contractId).get();
      const contract = contractSnap.exists ? contractSnap.data() : null;
      if (
        !contract ||
        contract.vendorId !== vendorId ||
        contract.status !== 'accepted' ||
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
      await db.collection('vendorsPublic').doc(vendorId).delete();

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
            description: originalVendorInfo.description || '',
            createdAt: vendorSnap.data().createdAt || FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
      };

      // Protection financière et contrôle des commandes/écritures associées.
      const walletRef = db.collection('wallets').doc(vendorId);
      const payoutQuery = db.collection('payout_requests')
        .where('vendorId', '==', vendorId);
      const [walletSnap, payoutSnap] = await Promise.all([
        walletRef.get(),
        payoutQuery.get()
      ]);

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

      const settlement = await inspectVendorSettlement(vendorId);
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

    await vendorRef.update({
      'vendorInfo.status': action,
      'vendorInfo.statusUpdatedAt': FieldValue.serverTimestamp(),
      'vendorInfo.statusUpdatedBy': decoded.uid,
      updatedAt: FieldValue.serverTimestamp()
    });
    return res.status(200).json({ success: true, action });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/* ============================================================
   CF : requestWithdrawal (B-C2 : check vendeur approuvé)
   ============================================================ */
exports.requestWithdrawal = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    const amount = Number(req.body?.amount);
    const method = String(req.body?.method || '').trim();
    const account = String(req.body?.account || '').trim();

    if (!Number.isFinite(amount) || amount < 200) {
      return res.status(400).json({ success: false, message: 'Montant invalide. Minimum 200 MAD.' });
    }

    const allowedMethods = new Set(['Wafacash', 'Cash Plus', 'Virement bancaire']);
    if (!allowedMethods.has(method)) {
      return res.status(400).json({ success: false, message: 'Méthode de retrait invalide.' });
    }

    const validPhone = /^(?:\+212|0)[67]\d{8}$/.test(account);
    const validRib = /^\d{24}$/.test(account);
    if ((method === 'Virement bancaire' && !validRib) ||
        (method !== 'Virement bancaire' && !validPhone)) {
      return res.status(400).json({ success: false, message: 'Coordonnées de réception invalides.' });
    }

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
          vendorData.vendorInfo?.contractStatus !== 'accepted') {
        throw new Error('Votre compte vendeur doit être approuvé et votre contrat accepté.');
      }

      if (!walletSnap.exists) throw new Error('Wallet introuvable.');
      if (!pendingSnap.empty) throw new Error('Une demande de retrait est déjà en cours.');

      const balance = Number(walletSnap.data().availableBalance);
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
        amount,
        method,
        account,
        status: 'pending',
        requestedAt: FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    const message = error.message || 'Erreur serveur.';
    const clientError = /introuvable|invalide|minimum|coordonnées|méthode|solde insuffisant|déjà en cours|doit être approuvé/i.test(message);
    return res.status(clientError ? 400 : 500).json({ success: false, message });
  }
});

/* ============================================================
   CF : onOrderStatusChanged (Trigger)
   ============================================================ */
exports.onOrderStatusChanged = onDocumentUpdated('orders/{orderId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();

  const beforeReturnsCount = Array.isArray(before.returns) ? before.returns.length : 0;
  const afterReturns = Array.isArray(after.returns) ? after.returns : [];
  const statusChanged = before.status !== after.status;

  // Un retour peut être ajouté à une commande déjà marquée "returned".
  // Le trigger doit traiter les nouvelles entrées même si le statut ne change plus.
  if (!statusChanged && afterReturns.length <= beforeReturnsCount) return;

  const orderId = event.params.orderId;

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

        const rate = Number(vendorSnap.data().vendorInfo?.commissionRate) || 0.07;
        const commission = Math.round(subtotal * rate * 100) / 100;
        const net = Math.round((subtotal - commission) * 100) / 100;
        if (net <= 0) continue;

        const walletRef = db.collection('wallets').doc(vendorId);
        const unlockAt = new Date();
        unlockAt.setDate(unlockAt.getDate() + 7);

        await db.runTransaction(async (tx) => {
          const orderRef = db.collection('orders').doc(orderId);
          const freshOrderSnap = await tx.get(orderRef);
          if (!freshOrderSnap.exists) return;
          const freshOrder = freshOrderSnap.data();
          if (freshOrder.vendorCredits && freshOrder.vendorCredits[vendorId]) return;

          const freshWalletSnap = await tx.get(walletRef);
          if (!freshWalletSnap.exists) {
            tx.set(walletRef, {
              vendorId,
              pendingBalance: net,
              availableBalance: 0,
              totalEarnings: net,
              totalWithdrawn: 0,
              createdAt: FieldValue.serverTimestamp(),
              lastUpdated: FieldValue.serverTimestamp()
            });
          } else {
            tx.update(walletRef, {
              pendingBalance: FieldValue.increment(net),
              totalEarnings: FieldValue.increment(net),
              lastUpdated: FieldValue.serverTimestamp()
            });
          }

          const txRef = db.collection('wallet_transactions').doc();
          tx.set(txRef, {
            vendorId,
            type: 'sale',
            amount: net,
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
      }
    }
  }

  // Débit des retours vendeur : traiter chaque nouvelle entrée, pas seulement
  // la dernière. Cela couvre plusieurs retours successifs sur une même commande.
  if (after.status === 'returned' && afterReturns.length > beforeReturnsCount) {
    for (let returnIndex = beforeReturnsCount; returnIndex < afterReturns.length; returnIndex++) {
      const returnEntry = afterReturns[returnIndex];
      if (!returnEntry || !Array.isArray(returnEntry.items)) continue;

      const qtyByVendor = {};
      returnEntry.items.forEach(retItem => {
        const item = (after.items || []).find(i => String(i.productId) === String(retItem.productId));
        if (!item) return;
        const vid = item.vendorId;
        const delta = Number(retItem.delta) || 0;
        if (!vid || vid === 'smartswi9a' || delta <= 0) return;
        qtyByVendor[vid] = (qtyByVendor[vid] || 0) + delta;
      });

      for (const [vendorId, qty] of Object.entries(qtyByVendor)) {
        if (qty <= 0) continue;
        const fee = RETURN_FEE_LIVO * qty;
        const debitKey = `${vendorId}_ret${returnIndex}`;
        const walletRef = db.collection('wallets').doc(vendorId);

        try {
          await db.runTransaction(async (tx) => {
            const orderRef = db.collection('orders').doc(orderId);
            const freshOrderSnap = await tx.get(orderRef);
            if (!freshOrderSnap.exists) return;
            const freshOrder = freshOrderSnap.data();
            const freshReturns = Array.isArray(freshOrder.returns) ? freshOrder.returns : [];
            if (freshOrder.status !== 'returned' || !freshReturns[returnIndex]) return;
            if (freshOrder.vendorDebits && freshOrder.vendorDebits[debitKey]) return;

            const freshWalletSnap = await tx.get(walletRef);
            const w = freshWalletSnap.exists ? freshWalletSnap.data() : {
              vendorId,
              pendingBalance: 0,
              availableBalance: 0,
              negativeBalance: 0,
              totalEarnings: 0,
              totalWithdrawn: 0,
              createdAt: FieldValue.serverTimestamp()
            };

            let pending = Number(w.pendingBalance) || 0;
            let available = Number(w.availableBalance) || 0;
            let negative = Number(w.negativeBalance) || 0;
            let remaining = fee;

            const fromPending = Math.min(Math.max(0, pending), remaining);
            pending -= fromPending;
            remaining -= fromPending;

            const fromAvailable = Math.min(Math.max(0, available), remaining);
            available -= fromAvailable;
            remaining -= fromAvailable;

            if (remaining > 0) negative -= remaining;

            const txRef = db.collection('wallet_transactions').doc();
            const walletUpdate = {
              vendorId,
              pendingBalance: pending,
              availableBalance: available,
              negativeBalance: negative,
              totalEarnings: Number(w.totalEarnings) || 0,
              totalWithdrawn: Number(w.totalWithdrawn) || 0,
              lastUpdated: FieldValue.serverTimestamp()
            };
            if (freshWalletSnap.exists) tx.update(walletRef, walletUpdate);
            else tx.set(walletRef, { ...w, ...walletUpdate });
            tx.set(txRef, {
              vendorId,
              type: 'return_fee',
              amount: -fee,
              orderId,
              returnIndex,
              status: 'released',
              description: `Frais retour commande #${orderId.slice(0, 8).toUpperCase()} (${qty} colis)`,
              createdAt: FieldValue.serverTimestamp()
            });
            tx.update(orderRef, {
              [`vendorDebits.${debitKey}`]: {
                debitedAt: FieldValue.serverTimestamp(),
                amount: fee,
                returnedQty: qty,
                txId: txRef.id
              }
            });
          });
        } catch (err) {
          console.error(`[onOrderStatusChanged] Erreur débit retour vendeur ${vendorId}, retour ${returnIndex}:`, err);
        }
      }
    }
  }
});

/* ============================================================
   CF : createCustomerOrder
   ============================================================ */
exports.createCustomerOrder = onRequest({ region: 'europe-west1', maxInstances: 10, timeoutSeconds: 30, cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    const input = req.body || {};
    const delivery = input.deliveryInfo || {};
    const rawItems = Array.isArray(input.items) ? input.items : [];

    if (!rawItems.length || rawItems.length > 50) {
      return res.status(400).json({ success: false, message: 'Panier vide ou trop volumineux.' });
    }
    for (const k of ['name', 'phone', 'address', 'city']) {
      if (typeof delivery[k] !== 'string' || !delivery[k].trim()) {
        return res.status(400).json({ success: false, message: `Champ obligatoire : ${k}` });
      }
    }

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
      const key = JSON.stringify([productId, v?.size || '', v?.color || '']);
      const old = merged.get(key);
      if (old) old.quantity += qty;
      else merged.set(key, { productId, quantity: qty, variant: v, id: String(it.id || productId) });
    }
    const items = [...merged.values()];
    const orderRef = db.collection('orders').doc();

    const outcome = await db.runTransaction(async tx => {
      const productRefs = items.map(i => db.collection('products').doc(i.productId));
      const productSnaps = await Promise.all(productRefs.map(ref => tx.get(ref)));
      const vendorIdsSet = new Set();

      for (let i = 0; i < productSnaps.length; i++) {
        if (!productSnaps[i].exists) throw new Error(`Produit introuvable.`);
        const pd = productSnaps[i].data();
        if (pd.status && pd.status !== 'approved') throw new Error(`Produit indisponible.`);
        const vid = String(pd.vendorId || 'smartswi9a');
        if (vid !== 'smartswi9a') vendorIdsSet.add(vid);
      }
      const vendorIds = [...vendorIdsSet];

      // C6 : vérif vendeurs approuvés
      if (vendorIds.length > 0) {
        const vendorRefs = vendorIds.map(id => db.collection('vendorsPublic').doc(id));
        const vendorSnaps = await Promise.all(vendorRefs.map(ref => tx.get(ref)));
        vendorSnaps.forEach((snap, i) => {
          if (!snap.exists) throw new Error(`Le vendeur ${vendorIds[i]} n'est pas actif.`);
          const vData = snap.data();
          if (vData.status !== 'approved') {
            throw new Error(`Le vendeur ${vendorIds[i]} n'est pas approuvé (statut: ${vData.status || 'pending'}).`);
          }
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
        subtotal += price * qty;
        totalQty += qty;
        validatedItems.push({
          id: item.id,
          productId: item.productId,
          vendorId: String(data.vendorId || 'smartswi9a'),
          variant: item.variant,
          quantity: qty,
          price,
          name: String(data.nameFr || data.nameEn || 'Produit')
        });
      }

      // C2 : deliveryFee depuis Firestore
      let deliveryFee = FALLBACK_DELIVERY_FEE;
      if (delivery.cityId) {
        try {
          const citySnap = await tx.get(db.collection('cities').doc(String(delivery.cityId)));
          if (citySnap.exists) {
            deliveryFee = Math.max(0, Number(citySnap.data().price) || 0);
          }
        } catch (e) {
          console.warn('[createCustomerOrder] cities read failed, fallback:', e.message);
        }
      }

      // M1 : réduction volume
      const volumeDiscount = totalQty >= 3 ? Math.round(subtotal * 0.05) : 0;

      // C3 : coupon
      let couponData = null;
      let couponDiscount = 0;
      const couponId = input.appliedCoupon?.id ? String(input.appliedCoupon.id) : null;

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

      const productDiscount = Math.min(subtotal, volumeDiscount + Math.max(0, couponDiscount - (couponData?.type === 'free_shipping' ? deliveryFee : 0)));
      const shippingDiscount = couponData?.type === 'free_shipping' ? Math.min(deliveryFee, couponDiscount) : 0;
      const total = Math.max(0, subtotal - productDiscount + deliveryFee - shippingDiscount);

      const now = Date.now();
      const cancellableUntil = new Date(now + 4 * 3600 * 1000);

      const vendorList = [...new Set(validatedItems.map(i => i.vendorId).filter(v => v && v !== 'smartswi9a'))];
      const orderData = {
        userId: decoded.uid,
        userName: String(delivery.name).trim().slice(0, 100),
        userEmail: String(decoded.email || delivery.email || ''),
        items: validatedItems,
        vendorIds: vendorList,
        status: 'pending',
        paymentStatus: 'unpaid',
        subtotal,
        discount: volumeDiscount,
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

      return {
        orderId: orderRef.id,
        totals: {
          subtotal,
          discount: volumeDiscount,
          couponCode: orderData.couponCode,
          couponDiscount,
          deliveryFee,
          total,
          vendorIds: vendorList
        },
        validatedItems
      };
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
exports.cancelCustomerOrder = onRequest({ region: 'europe-west1', maxInstances: 10, timeoutSeconds: 30, cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
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

      if (order.stockDeducted === true) {
        for (let i = 0; i < productIds.length; i++) {
          if (!snaps[i].exists) continue;
          const p = snaps[i].data();
          const productItems = items.filter(item => String(item.productId) === productIds[i]);
          const totalQty = productItems.reduce((sum, item) => sum + Math.max(1, Math.floor(Number(item.quantity) || 1)), 0);
          const upd = {
            salesCount: Math.max(0, (Number(p.salesCount) || 0) - totalQty),
            lastOrderId: orderId,
            updatedAt: FieldValue.serverTimestamp()
          };
          const variants = Array.isArray(p.variants) ? p.variants.map(v => ({ ...v })) : [];
          let simpleStock = Number(p.stock) || 0;
          for (const item of productItems) {
            const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
            if (item.variant) {
              const idx = variants.findIndex(v =>
                String(v.size || '') === String(item.variant.size || '') &&
                String(v.color || '') === String(item.variant.color || '')
              );
              if (idx >= 0) variants[idx].stock = (Number(variants[idx].stock) || 0) + qty;
            } else {
              simpleStock += qty;
            }
          }
          if (productItems.some(item => item.variant)) {
            upd.variants = variants;
            upd.stock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
          } else {
            upd.stock = simpleStock;
          }
          tx.update(refs[i], upd);
        }
      }

      // M2 : restauration coupon (protégée contre usedCount négatif)
      if (order.couponId && !order.couponRestored) {
        try {
          const couponRef = db.collection('coupons').doc(String(order.couponId));
          const couponSnap = await tx.get(couponRef);
          if (couponSnap.exists && Number(couponSnap.data().usedCount) > 0) {
            tx.update(couponRef, { usedCount: FieldValue.increment(-1) });
          }
          tx.delete(db.collection('coupon_uses').doc(`${order.couponId}_${decoded.uid}`));
        } catch (e) {
          console.warn('[cancelCustomerOrder] Coupon restore failed:', e.message);
        }
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
exports.adminPayoutAction = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 30 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    if (!adminSnap.exists || adminSnap.data()?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });
    }

    const payoutId = String(req.body?.payoutId || '');
    const action = String(req.body?.action || '');
    if (!payoutId || !['paid', 'rejected'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Paramètres invalides.' });
    }

    await db.runTransaction(async (t) => {
      const payoutRef = db.collection('payout_requests').doc(payoutId);
      const payoutSnap = await t.get(payoutRef);
      if (!payoutSnap.exists) throw new Error('Demande introuvable.');
      const payoutData = payoutSnap.data();
      if (payoutData.status !== 'pending') throw new Error('Cette demande a déjà été traitée.');

      // M3 : vendorId obligatoire
      const vendorId = String(payoutData.vendorId || '');
      if (!vendorId) throw new Error('Demande sans vendorId — impossible de traiter.');

      if (action === 'paid') {
        const amount = Number(payoutData.amount) || 0;
        if (amount <= 0) throw new Error('Montant invalide.');

        const walletRef = db.collection('wallets').doc(vendorId);
        const walletSnap = await t.get(walletRef);
        if (!walletSnap.exists) throw new Error('Wallet introuvable.');

        const wallet = walletSnap.data();
        const available = Number(wallet.availableBalance) || 0;
        if (available < amount) {
          throw new Error(`Solde insuffisant : disponible ${available} MAD, demandé ${amount} MAD.`);
        }

        t.update(walletRef, {
          availableBalance: FieldValue.increment(-amount),
          totalWithdrawn: FieldValue.increment(amount),
          lastUpdated: FieldValue.serverTimestamp()
        });

        t.update(payoutRef, {
          status: 'paid',
          paidAt: FieldValue.serverTimestamp(),
          paidBy: decoded.uid
        });

        const txRef = db.collection('wallet_transactions').doc();
        t.set(txRef, {
          vendorId,
          type: 'payout',
          amount: -amount,
          status: 'released',
          payoutRequestId: payoutId,
          description: `Retrait payé (admin) - ${payoutData.method || 'Wafacash'}`,
          createdAt: FieldValue.serverTimestamp(),
          releasedAt: FieldValue.serverTimestamp()
        });

        const notifRef = db.collection('notifications').doc();
        t.set(notifRef, {
          userId: vendorId,
          type: 'payout_paid',
          title: 'Retrait payé',
          message: `Votre retrait de ${amount} MAD a été payé.`,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
          payoutId
        });
      } else {
        t.update(payoutRef, {
          status: 'rejected',
          rejectedAt: FieldValue.serverTimestamp(),
          rejectedBy: decoded.uid
        });

        const notifRef = db.collection('notifications').doc();
        t.set(notifRef, {
          userId: vendorId,
          type: 'payout_rejected',
          title: 'Retrait rejeté',
          message: `Votre demande de retrait de ${payoutData.amount} MAD a été rejetée.`,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
          payoutId
        });
      }
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[adminPayoutAction]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/* ============================================================
   CF : releaseDueFunds
   ============================================================ */
exports.releaseDueFunds = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 60 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    if (!adminSnap.exists || adminSnap.data()?.role !== 'admin') {
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
          const walletSnap = await t.get(walletRef);
          if (!walletSnap.exists) throw new Error('Wallet introuvable');

          const wallet = walletSnap.data();
          let pendingBalance = Number(wallet.pendingBalance) || 0;
          let availableBalance = Number(wallet.availableBalance) || 0;
          let vendorReleased = 0;
          let txsCount = 0;

          for (const tx of txs) {
            const amount = Number(tx.data.amount) || 0;
            const reversed = Number(tx.data.reversedAmount) || 0;
            const eligible = Math.max(0, amount - reversed);
            const releaseForThis = Math.min(eligible, pendingBalance);

            if (releaseForThis > 0) {
              pendingBalance -= releaseForThis;
              availableBalance += releaseForThis;
              vendorReleased += releaseForThis;
              txsCount++;
            }

            t.update(tx.ref, {
              status: 'released',
              releasedAt: FieldValue.serverTimestamp(),
              releasedAmount: releaseForThis
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