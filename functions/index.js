const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

initializeApp();
const db = getFirestore();
const PROJECT_ID = 'smartswi9a-31063';
const FIREBASE_WEB_API_KEY = 'AIzaSyBhULwDxPBRqjywsSD_0ny41Bmt968ofSA';

const ALLOWED_ORIGINS = new Set([
    'https://smartswi9a.top',
    'https://www.smartswi9a.top',
    'https://smartswi9a-31063.web.app',
    'https://smartswi9a-31063.firebaseapp.com'
]);

/* ============================================================
   CONFIG PRIX LIVO (API PUBLIQUE)
   ============================================================
   Source de vérité : https://rest.livo.ma/fees/public
   Endpoint public (pas d'auth).
   Réponse : { success: true, data: { data: { request_date, order_fees: [...] } } }
   Chaque élément : { city: "casablanca", fee: 20 }
   ============================================================ */
const LIVO_API_BASE = 'https://rest.livo.ma';
const LIVO_FEES_ENDPOINT = '/fees/public';
const LIVO_FEES_CACHE_HOURS = 24;
const LIVO_FEES_FETCH_TIMEOUT_MS = 10000;

// Prix par défaut si Firestore vide ET Livo down (fallback ultime)
const FALLBACK_DELIVERY_FEE = 30;

// Villes "dépôts" à exclure (ce ne sont pas des villes clients)
const LIVO_DEPOT_KEYS = new Set(['livo depot', 'livo depot casablanca']);

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
   HELPERS CACHES LIVO (Firestore)
   ============================================================
   Collection meta/livo_fees_cache :
   {
     updatedAt: Timestamp,
     citiesCount: number,
     source: 'livo' | 'manual',
     requestDate: string
   }
   ============================================================ */
const LIVO_FEES_CACHE_DOC = 'livo_fees_cache';
const LIVO_FEES_META_COLLECTION = 'meta';

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

/**
 * Normalise une clé ville (slug safe).
 * "Casablanca" → "casablanca", "M'Diq" → "mdiq"
 */
function normalizeCityKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Fetch l'API publique Livo /fees/public.
 * Retourne { requestDate, cities: [{city, fee}] } ou throw.
 */
async function fetchLivoFeesFromApi() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVO_FEES_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${LIVO_API_BASE}${LIVO_FEES_ENDPOINT}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Livo API HTTP ${res.status}`);
    }
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

/**
 * Sync Livo → Firestore `cities` (upsert).
 * Retourne { synced: number, deleted: number, requestDate }.
 * - Si une ville existe déjà dans `cities`, on met à jour `price` uniquement
 *   (les champs nameFr/nameEn/nameAr custom côté admin restent intacts).
 * - Si elle n'existe pas, on la crée avec un nom par défaut dérivé du slug.
 * - Les villes présentes dans Firestore mais absentes de Livo sont supprimées
 *   SAUF si `preserveCustom` = true (flag manuel admin pour garder une ville
 *   ajoutée à la main).
 */
async function syncLivoCitiesFromApi(options = {}) {
  const { preserveCustom = false } = options;
  const { requestDate, cities } = await fetchLivoFeesFromApi();

  if (!cities.length) {
    throw new Error('Livo a retourné 0 ville.');
  }

  // Snapshot actuel Firestore
  const existingSnap = await db.collection('cities').get();
  const existingByKey = new Map();
  const existingBySlug = new Map();
  existingSnap.docs.forEach(d => {
    const data = d.data();
    const key = normalizeCityKey(data.key || data.nameFr || '');
    if (key) existingByKey.set(key, { id: d.id, data });
    if (data.key) existingBySlug.set(String(data.key), { id: d.id, data });
  });

  // Batch upsert
  const BATCH_SIZE = 400;
  let synced = 0;
  let created = 0;
  let updated = 0;

  const allCities = cities.map((c, idx) => ({
    ...c,
    id: existingByKey.get(c.city)?.data?.id || (idx + 1),
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
        // Update price seulement (préserve les noms custom)
        batch.update(ref, {
          price: c.fee,
          lastSyncedFromLivo: FieldValue.serverTimestamp()
        });
        updated++;
      } else {
        // Création
        batch.set(ref, {
          id: c.id,
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

  // Supprimer les villes obsolètes (présentes Firestore mais plus dans Livo)
  let deleted = 0;
  if (!preserveCustom) {
    const livoKeys = new Set(cities.map(c => c.city));
    const toDelete = [];
    existingSnap.docs.forEach(d => {
      const data = d.data();
      if (data.source === 'manual') return; // Ne pas toucher aux villes ajoutées manuellement
      const key = normalizeCityKey(data.key || data.nameFr || '');
      if (key && !livoKeys.has(key)) {
        toDelete.push(d.ref);
      }
    });
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const batch = db.batch();
      toDelete.slice(i, i + BATCH_SIZE).forEach(ref => batch.delete(ref));
      await batch.commit();
      deleted += Math.min(BATCH_SIZE, toDelete.length - i);
    }
  }

  // Mettre à jour le méta cache
  await db.collection(LIVO_FEES_META_COLLECTION).doc(LIVO_FEES_CACHE_DOC).set({
    updatedAt: FieldValue.serverTimestamp(),
    citiesCount: cities.length,
    requestDate: requestDate,
    source: 'livo',
    created,
    updated,
    deleted
  }, { merge: true });

  return { synced, created, updated, deleted, requestDate, citiesCount: cities.length };
}

/* ============================================================
   CLOUD FUNCTION : getLivoFees (PUBLIC)
   ============================================================
   Retourne les villes + prix Livo.
   - Lit Firestore `cities` (source de vérité, potentiellement éditée par admin)
   - Si vide OU cache > 24h, déclenche sync Livo en arrière-plan
   - Réponse cacheable 1h côté CDN
   ============================================================ */
exports.getLivoFees = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    // 1. Vérifier si cache frais
    let cacheFresh = false;
    try {
      cacheFresh = await isLivoFeesCacheFresh();
    } catch (e) {
      console.warn('[getLivoFees] Cache check failed:', e.message);
    }

    // 2. Lire Firestore cities
    let cities = [];
    try {
      const snap = await db.collection('cities').orderBy('id', 'asc').limit(500).get();
      cities = snap.docs.map(d => {
        const data = d.data();
        return {
          id: data.id,
          key: data.key,
          nameFr: data.nameFr || data.key,
          nameEn: data.nameEn || data.nameFr || data.key,
          nameAr: data.nameAr || data.nameFr || data.key,
          price: Number(data.price) || FALLBACK_DELIVERY_FEE,
          delay: data.delay || '48h'
        };
      });
    } catch (e) {
      console.warn('[getLivoFees] Firestore read failed:', e.message);
    }

    // 3. Si vide OU cache périmé, sync en arrière-plan (fire-and-forget)
    if (cities.length === 0 || !cacheFresh) {
      syncLivoCitiesFromApi({ preserveCustom: true })
        .then(r => console.log('[getLivoFees] Background sync OK:', r))
        .catch(e => console.warn('[getLivoFees] Background sync failed:', e.message));
    }

    // 4. Si toujours vide (Livo down + Firestore vide), retourner fallback minimal
    if (cities.length === 0) {
      return res.status(503).json({
        success: false,
        message: 'Grille tarifaire temporairement indisponible. Réessayez dans quelques instants.',
        source: 'none'
      });
    }

    // 5. Cache CDN 1h
    res.set('Cache-Control', 'public, max-age=3600');
    return res.status(200).json({
      success: true,
      count: cities.length,
      source: 'firestore',
      cacheFresh: cacheFresh,
      cities: cities
    });
  } catch (error) {
    console.error('[getLivoFees]', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

/* ============================================================
   CLOUD FUNCTION : syncLivoCities (ADMIN)
   ============================================================
   Force la synchro Livo → Firestore. Réservé admin.
   Body : { preserveCustom?: boolean }
   ============================================================ */
exports.syncLivoCities = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 60 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    if (!adminSnap.exists || adminSnap.data()?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });
    }

    const result = await syncLivoCitiesFromApi({
      preserveCustom: req.body?.preserveCustom === true
    });

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[syncLivoCities]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Erreur lors de la synchronisation.'
    });
  }
});

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
  const t = templates[version] || templates["1.2.0"];
  return t[lang] ? t[lang](snapshot) : t["fr"](snapshot);
}

/* ============================================================
   CLOUD FUNCTION : syncVendorPublic (Trigger)
   ============================================================ */
exports.syncVendorPublic = onDocumentWritten('users/{userId}', async (event) => {
  const snap = event.data.after;
  if (!snap || !snap.exists) return;
  const data = snap.data();

  if (data.role !== 'vendor' || !data.vendorInfo) {
    return db.collection('vendorsPublic').doc(event.params.userId).delete().catch(() => { });
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
   CLOUD FUNCTION : signVendorContract (Sécurisé)
   ============================================================ */
exports.signVendorContract = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    const { version, language, termsSnapshot, textHash } = req.body;
    if (!version || !language || !termsSnapshot || !textHash) {
      return res.status(400).json({ success: false, message: 'Données incomplètes.' });
    }

    const contractId = `contract_${decoded.uid}_v${version}`;
    const contractRef = db.collection('contracts').doc(contractId);

    const existing = await contractRef.get();
    if (existing.exists) {
      return res.status(200).json({ success: true, alreadySigned: true, contractId });
    }

    const officialText = getContractText(language, version, termsSnapshot);
    const officialHash = crypto.createHash('sha256').update(officialText).digest('hex');

    if (officialHash !== textHash) {
      return res.status(400).json({ success: false, message: 'Falsification détectée : le hash ne correspond pas.' });
    }

    const contractHash = crypto.createHash('sha256').update([decoded.uid, version, language, textHash].join('|')).digest('hex');
    const ip = req.ip || req.get('x-forwarded-for') || 'unknown';

    await contractRef.set({
      vendorId: decoded.uid,
      version: version,
      language: language,
      termsSnapshot: termsSnapshot,
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
   CLOUD FUNCTION : loginVendor (Autorise pending pour signature)
   ============================================================ */
exports.loginVendor = onRequest({ region: 'europe-west1', maxInstances: 5, timeoutSeconds: 20 }, async (req, res) => {
  if (cors(req, res)) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;

  if (!validEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ success: false, message: 'Identifiants invalides.' });
  }

  try {
    const userRecord = await findUserByEmail(email);
    if (!userRecord) return res.status(401).json({ success: false, message: 'Identifiants incorrects.' });

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
      const authResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      });
      if (authResponse.ok) {
        const authData = await authResponse.json();
        validCredential = authData.localId === uid;
      }
    }

    if (!validCredential) return res.status(401).json({ success: false, message: 'Identifiants incorrects.' });

    const canLogin = approved(profile) || profile.vendorInfo?.status === 'pending';
    if (!canLogin) return res.status(403).json({ success: false, message: statusMessage(profile) });

    const customToken = await getAuth().createCustomToken(uid, { vendorLogin: true });
    return res.status(200).json({ success: true, customToken, needsContract: !approved(profile) });
  } catch (error) {
    console.error('[loginVendor]', error);
    return res.status(500).json({ success: false, message: 'Erreur temporaire.' });
  }
});

/* ============================================================
   CLOUD FUNCTION : setVendorPassword
   ============================================================ */
exports.setVendorPassword = onRequest({ region: 'europe-west1', maxInstances: 5, timeoutSeconds: 15 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = req.get('authorization').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const vendorPassword = req.body?.vendorPassword;
    if (!validPassword(vendorPassword)) return res.status(400).json({ success: false, message: 'Mot de passe invalide.' });

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
   CLOUD FUNCTION : adminVendorAction (Sécurisé)
   ============================================================ */
exports.adminVendorAction = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    if (!adminSnap.exists || adminSnap.data()?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });
    }

    const vendorId = String(req.body?.vendorId || '').trim();
    const action = String(req.body?.action || '').trim();
    if (!vendorId || !['approved', 'rejected', 'suspended', 'deleted'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action invalide.' });
    }

    const vendorRef = db.collection('users').doc(vendorId);
    const vendorSnap = await vendorRef.get();
    if (!vendorSnap.exists() || vendorSnap.data()?.role !== 'vendor') {
      return res.status(404).json({ success: false, message: 'Profil introuvable.' });
    }

    if (action === 'approved' && vendorSnap.data().vendorInfo?.contractStatus !== 'accepted') {
      return res.status(409).json({ success: false, message: 'Impossible d’approuver : contrat non signé.' });
    }

    if (action === 'deleted') {
      let deletedProducts = 0;
      let productsRemaining = false;
      for (let page = 0; page < 20; page++) {
        const productsSnap = await db.collection('products').where('vendorId', '==', vendorId).limit(400).get();
        if (productsSnap.empty) { productsRemaining = false; break; }
        const batch = db.batch();
        productsSnap.docs.forEach(docSnap => batch.delete(docSnap.ref));
        await batch.commit();
        deletedProducts += productsSnap.size;
        productsRemaining = productsSnap.size === 400;
        if (!productsRemaining) break;
      }

      await vendorRef.delete();
      await db.collection('vendorCredentials').doc(vendorId).delete().catch(() => { });
      try { await getAuth().deleteUser(vendorId); } catch (e) { /* ignore */ }

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
   CLOUD FUNCTION : requestWithdrawal (Sécurisé)
   ============================================================ */
exports.requestWithdrawal = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);

    const amount = Number(req.body?.amount);
    const method = String(req.body?.method || '');
    const account = String(req.body?.account || '');

    if (amount < 200) return res.status(400).json({ success: false, message: 'Minimum 200 MAD.' });

    const walletSnap = await db.collection('wallets').doc(decoded.uid).get();
    if (!walletSnap.exists) return res.status(404).json({ success: false, message: 'Wallet introuvable.' });

    const pendingReq = await db.collection('payout_requests')
      .where('vendorId', '==', decoded.uid)
      .where('status', '==', 'pending')
      .get();
    if (!pendingReq.empty) {
      return res.status(400).json({ success: false, message: 'Demande déjà en cours.' });
    }

    const balance = Number(walletSnap.data().availableBalance) || 0;
    if (amount > balance) {
      return res.status(400).json({ success: false, message: 'Solde insuffisant.' });
    }

    await db.collection('payout_requests').add({
      vendorId: decoded.uid,
      vendorName: req.body.vendorName || 'Vendeur',
      amount, method, account,
      status: 'pending',
      requestedAt: FieldValue.serverTimestamp()
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});