'use strict';

/* ============================================================================
 * migrate-unlock-at.cjs
 * ----------------------------------------------------------------------------
 * Migration des dates de deblocage (unlockAt) des credits vendeur.
 *
 * REGLE OFFICIELLE (source : functions/index.js resolveCreditUnlockBase) :
 *
 *   unlockAt = trackingStartedAt + N jours
 *
 *   N = 15 si AU MOINS UN article de la commande porte isSmartSwika: true
 *       (items.some(i => i.isSmartSwika === true)), quel que soit le vendorId.
 *   N =  7 sinon (vente vendeur classique).
 *
 *   L'ancre est TOUJOURS trackingStartedAt (date de prise en charge du colis
 *   par Livo), jamais la date de commande. Si trackingStartedAt est absent,
 *   le backend ne cree pas de credit : par defaut ce script ne touche donc
 *   PAS ces documents (il les signale). Voir --force-fallback-date.
 *
 * COLLECTION MIGREE : wallet_transactions (seule collection portant unlockAt).
 *
 * Les documents `orders` servent uniquement de source pour recuperer
 * trackingStartedAt et items[].isSmartSwika, via le champ orderId.
 *
 * SECONDE TACHE : forcer isSmartSwika: true sur les produits de la plateforme
 * (products ou vendorId === 'smartswi9a'), avec merge: true.
 *
 * USAGE
 *   node scripts/migrate-unlock-at.cjs --dry-run
 *   node scripts/migrate-unlock-at.cjs
 *   node scripts/migrate-unlock-at.cjs --force-fallback-date
 *   node scripts/migrate-unlock-at.cjs --only-products
 *   node scripts/migrate-unlock-at.cjs --only-transactions
 *
 * OPTIONS
 *   --dry-run              Simulation : compteurs + 3 exemples avant/apres,
 *                          aucune ecriture.
 *   --force-fallback-date  Autorise l'ecriture d'un unlockAt pour les
 *                          transactions dont la commande n'a pas de
 *                          trackingStartedAt, en utilisant createdAt de la
 *                          transaction comme ancre. DANGEREUX : peut debloquer
 *                          des fonds sans preuve de prise en charge Livo.
 *                          Desactive par defaut.
 *   --only-products        Ne traite que la collection products.
 *   --only-transactions    Ne traite que la collection wallet_transactions.
 *   --help                 Affiche cette aide.
 *
 * PREREQUIS
 *   npm i -D firebase-admin       (a la racine du depot)
 *   GOOGLE_APPLICATION_CREDENTIALS=C:\chemin\serviceAccount.json
 *
 * Le script est idempotent : relance sans effet si tout est deja conforme.
 * ========================================================================== */

const PROJECT_ID = 'smartswi9a-31063';

const UNLOCK_DAYS_VENDOR = 7;
const UNLOCK_DAYS_SMART = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOLERANCE_MS = 60 * 1000; // 1 minute : evite les reecritures pour un arrondi
const BATCH_SIZE = 500;
const MAX_SAMPLES = 3;
const SMART_SWIKA_VENDOR_ID = 'smartswi9a';

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has('--dry-run');
const FORCE_FALLBACK_DATE = argv.has('--force-fallback-date');
const ONLY_PRODUCTS = argv.has('--only-products');
const ONLY_TRANSACTIONS = argv.has('--only-transactions');
const SHOW_HELP = argv.has('--help') || argv.has('-h');

const DO_PRODUCTS = !ONLY_TRANSACTIONS;
const DO_TRANSACTIONS = !ONLY_PRODUCTS;

/* ============================================================
   AIDE
   ============================================================ */
function printHelp() {
  console.log('');
  console.log('migrate-unlock-at.cjs - migration des unlockAt (wallet_transactions)');
  console.log('');
  console.log('  node scripts/migrate-unlock-at.cjs --dry-run   # simulation');
  console.log('  node scripts/migrate-unlock-at.cjs             # ecriture reelle');
  console.log('');
  console.log('Options :');
  console.log('  --dry-run              Aucune ecriture, seulement le rapport.');
  console.log('  --force-fallback-date  Ecrit un unlockAt meme sans trackingStartedAt');
  console.log('                         (ancre = createdAt de la transaction). DANGEREUX.');
  console.log('  --only-products        Traite uniquement products.');
  console.log('  --only-transactions    Traite uniquement wallet_transactions.');
  console.log('  --help                 Cette aide.');
  console.log('');
  console.log('Prerequis :');
  console.log('  npm i -D firebase-admin');
  console.log('  set GOOGLE_APPLICATION_CREDENTIALS=C:\\chemin\\serviceAccount.json');
  console.log('');
}

/* ============================================================
   CHARGEMENT PARESSEUX DE FIREBASE-ADMIN
   ============================================================ */
/**
 * Charge firebase-admin uniquement quand on en a besoin, afin que --help
 * fonctionne avant l'installation du module.
 */
function loadAdmin() {
  let app;
  let firestore;
  try {
    app = require('firebase-admin/app');
    firestore = require('firebase-admin/firestore');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      console.error('');
      console.error('ERREUR : le module firebase-admin est introuvable.');
      console.error('');
      console.error('Installez-le a la racine du depot :');
      console.error('  npm i -D firebase-admin');
      console.error('');
      process.exit(1);
    }
    throw err;
  }
  return { app, firestore };
}

/* ============================================================
   UTILITAIRES DATE
   ============================================================ */
/** Convertit un Timestamp Firestore / Date / string en Date, ou null. */
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value.toDate === 'function') {
    const d = value.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (typeof value === 'object' && typeof value.seconds === 'number') {
    const d = new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function formatDate(value) {
  const d = toDate(value);
  if (!d) return '(absent)';
  return d.toISOString().replace('.000Z', 'Z');
}

function formatDelta(ms) {
  const hours = ms / (60 * 60 * 1000);
  if (Math.abs(hours) < 48) return (hours >= 0 ? '+' : '') + hours.toFixed(1) + ' h';
  const days = hours / 24;
  return (days >= 0 ? '+' : '') + days.toFixed(2) + ' j';
}

/* ============================================================
   REGLE METIER
   ============================================================ */
/**
 * Reproduit exactement functions/index.js:resolveCreditUnlockBase().
 * @returns {{ok:true, unlockDays:number, scope:string, anchor:Date}|{ok:false, reason:string}}
 */
function resolveUnlockBase(orderData) {
  if (!orderData || typeof orderData !== 'object') {
    return { ok: false, reason: 'commande introuvable' };
  }

  const anchor = toDate(orderData.trackingStartedAt);
  if (!anchor) {
    return { ok: false, reason: 'trackingStartedAt absent' };
  }

  const items = Array.isArray(orderData.items) ? orderData.items : [];
  // some() : un seul article Smart Swika suffit pour passer a 15 jours.
  const hasSmartSwika = items.some((item) => item && item.isSmartSwika === true);

  return {
    ok: true,
    anchor,
    unlockDays: hasSmartSwika ? UNLOCK_DAYS_SMART : UNLOCK_DAYS_VENDOR,
    scope: hasSmartSwika ? 'smart' : 'vendor'
  };
}

/* ============================================================
   AFFICHAGE
   ============================================================ */
function printHeader(title) {
  console.log('');
  console.log('======================================================');
  console.log(' ' + title);
  console.log('======================================================');
}

function printSamples(samples) {
  if (samples.length === 0) {
    console.log('  (aucun exemple a afficher)');
    return;
  }
  samples.forEach((s, index) => {
    console.log('');
    console.log('  [' + (index + 1) + '/' + samples.length + '] wallet_transactions');
    console.log('    document        : ' + s.id);
    console.log('    orderId         : ' + (s.orderId || '(absent)'));
    console.log('    vendorId        : ' + (s.vendorId || '(absent)'));
    console.log('    scope           : ' + s.scope);
    console.log('    trackingStarted : ' + formatDate(s.anchor));
    console.log('    regle           : + ' + s.unlockDays + ' jours');
    console.log('    unlockAt AVANT  : ' + formatDate(s.before));
    console.log('    unlockAt APRES  : ' + formatDate(s.after));
    if (s.before) {
      const delta = toDate(s.after).getTime() - toDate(s.before).getTime();
      console.log('    ecart           : ' + formatDelta(delta));
    }
  });
}

/* ============================================================
   TACHE 1 : wallet_transactions
   ============================================================ */
async function migrateTransactions(db, Timestamp) {
  printHeader('TACHE 1 - wallet_transactions : recalcul de unlockAt');

  const stats = {
    scanned: 0,
    alreadyOk: 0,
    toUpdate: 0,
    updated: 0,
    skippedNoOrder: 0,
    skippedNoTracking: 0,
    failed: 0
  };

  const samples = [];
  const warnings = [];

  const query = db.collection('wallet_transactions').where('type', '==', 'sale');
  const snapshot = await query.get();

  console.log('  documents type=sale trouves : ' + snapshot.size);

  // Cache des commandes pour ne pas relire le meme document N fois.
  const orderCache = new Map();

  async function getOrder(orderId) {
    if (!orderId) return null;
    if (orderCache.has(orderId)) return orderCache.get(orderId);
    const snap = await db.collection('orders').doc(String(orderId)).get();
    const data = snap.exists ? snap.data() : null;
    orderCache.set(orderId, data);
    return data;
  }

  let currentBatch = null;
  let pendingWrites = 0;

  function ensureBatch() {
    if (!currentBatch) {
      currentBatch = db.batch();
      pendingWrites = 0;
    }
  }

  async function flushBatch() {
    if (!currentBatch || pendingWrites === 0) {
      currentBatch = null;
      pendingWrites = 0;
      return;
    }
    if (DRY_RUN) {
      currentBatch = null;
      pendingWrites = 0;
      return;
    }
    await currentBatch.commit();
    stats.updated += pendingWrites;
    console.log('    batch commit : ' + pendingWrites + ' document(s)');
    currentBatch = null;
    pendingWrites = 0;
  }

  for (const doc of snapshot.docs) {
    stats.scanned += 1;
    const data = doc.data() || {};
    const orderId = data.orderId ? String(data.orderId) : '';

    const order = await getOrder(orderId);

    let base = resolveUnlockBase(order);
    let usedFallback = false;

    if (!base.ok) {
      if (orderId === '' || !order) {
        stats.skippedNoOrder += 1;
        warnings.push(doc.id + ' : commande introuvable (orderId=' + (orderId || 'vide') + ')');
        continue;
      }

      if (base.reason === 'trackingStartedAt absent') {
        if (!FORCE_FALLBACK_DATE) {
          stats.skippedNoTracking += 1;
          warnings.push(doc.id + ' (commande ' + orderId + ') : trackingStartedAt absent - IGNORE');
          continue;
        }

        // Fallback explicite et demande : ancre = createdAt de la transaction.
        const fallbackAnchor = toDate(data.createdAt);
        if (!fallbackAnchor) {
          stats.skippedNoTracking += 1;
          warnings.push(doc.id + ' : trackingStartedAt ET createdAt absents - IGNORE');
          continue;
        }
        const items = Array.isArray(order.items) ? order.items : [];
        const smart = items.some((i) => i && i.isSmartSwika === true);
        base = {
          ok: true,
          anchor: fallbackAnchor,
          unlockDays: smart ? UNLOCK_DAYS_SMART : UNLOCK_DAYS_VENDOR,
          scope: smart ? 'smart (fallback)' : 'vendor (fallback)'
        };
        usedFallback = true;
      } else {
        stats.skippedNoTracking += 1;
        warnings.push(doc.id + ' : ' + base.reason + ' - IGNORE');
        continue;
      }
    }

    const target = addDays(base.anchor, base.unlockDays);
    const current = toDate(data.unlockAt);

    const isConform = current && Math.abs(current.getTime() - target.getTime()) <= TOLERANCE_MS;

    if (isConform) {
      stats.alreadyOk += 1;
      continue;
    }

    stats.toUpdate += 1;

    if (samples.length < MAX_SAMPLES) {
      samples.push({
        id: doc.id,
        orderId,
        vendorId: data.vendorId,
        scope: base.scope + (usedFallback ? ' + fallback' : ''),
        anchor: base.anchor,
        unlockDays: base.unlockDays,
        before: data.unlockAt,
        after: target
      });
    }

    ensureBatch();
    currentBatch.update(doc.ref, { unlockAt: Timestamp.fromDate(target) });
    pendingWrites += 1;

    if (pendingWrites >= BATCH_SIZE) {
      await flushBatch();
    }
  }

  await flushBatch();

  console.log('');
  console.log('  --- RESUME ---');
  console.log('  analyses               : ' + stats.scanned);
  console.log('  deja conformes         : ' + stats.alreadyOk);
  console.log('  a corriger             : ' + stats.toUpdate);
  if (!DRY_RUN) {
    console.log('  ecrits                 : ' + stats.updated);
  }
  console.log('  ignores (sans commande): ' + stats.skippedNoOrder);
  console.log('  ignores (sans tracking): ' + stats.skippedNoTracking);
  if (FORCE_FALLBACK_DATE) {
    console.log('  fallback createdAt     : ACTIVE');
  }

  if (samples.length > 0) {
    console.log('');
    console.log('  --- EXEMPLES (' + samples.length + ') ---');
    printSamples(samples);
  }

  if (warnings.length > 0) {
    console.log('');
    console.log('  --- AVERTISSEMENTS (' + warnings.length + ') ---');
    warnings.slice(0, 50).forEach((w) => console.log('    ! ' + w));
    if (warnings.length > 50) {
      console.log('    ... et ' + (warnings.length - 50) + ' autre(s)');
    }
  }

  return stats;
}

/* ============================================================
   TACHE 2 : products (isSmartSwika)
   ============================================================ */
async function migrateProducts(db) {
  printHeader("TACHE 2 - products : forcage de isSmartSwika sur vendorId='smartswi9a'");

  const stats = {
    scanned: 0,
    alreadyOk: 0,
    toUpdate: 0,
    updated: 0,
    failed: 0
  };

  const samples = [];
  const snapshot = await db.collection('products')
    .where('vendorId', '==', SMART_SWIKA_VENDOR_ID)
    .get();

  console.log('  produits vendorId=' + SMART_SWIKA_VENDOR_ID + ' trouves : ' + snapshot.size);

  let currentBatch = null;
  let pendingWrites = 0;

  function ensureBatch() {
    if (!currentBatch) {
      currentBatch = db.batch();
      pendingWrites = 0;
    }
  }

  async function flushBatch() {
    if (!currentBatch || pendingWrites === 0) {
      currentBatch = null;
      pendingWrites = 0;
      return;
    }
    if (!DRY_RUN) {
      await currentBatch.commit();
      stats.updated += pendingWrites;
      console.log('    batch commit : ' + pendingWrites + ' document(s)');
    }
    currentBatch = null;
    pendingWrites = 0;
  }

  for (const doc of snapshot.docs) {
    stats.scanned += 1;
    const data = doc.data() || {};

    if (data.isSmartSwika === true) {
      stats.alreadyOk += 1;
      continue;
    }

    stats.toUpdate += 1;

    if (samples.length < MAX_SAMPLES) {
      samples.push({
        id: doc.id,
        name: data.nameFr || data.nameEn || data.slug || '(sans nom)',
        slug: data.slug || '',
        before: data.isSmartSwika === undefined ? '(absent)' : String(data.isSmartSwika),
        after: 'true'
      });
    }

    ensureBatch();
    currentBatch.set(doc.ref, { isSmartSwika: true }, { merge: true });
    pendingWrites += 1;

    if (pendingWrites >= BATCH_SIZE) {
      await flushBatch();
    }
  }

  await flushBatch();

  console.log('');
  console.log('  --- RESUME ---');
  console.log('  analyses       : ' + stats.scanned);
  console.log('  deja conformes : ' + stats.alreadyOk);
  console.log('  a corriger     : ' + stats.toUpdate);
  if (!DRY_RUN) {
    console.log('  ecrits         : ' + stats.updated);
  }

  if (samples.length > 0) {
    console.log('');
    console.log('  --- EXEMPLES (' + samples.length + ') ---');
    samples.forEach((s, i) => {
      console.log('');
      console.log('  [' + (i + 1) + '/' + samples.length + '] products');
      console.log('    document           : ' + s.id);
      console.log('    nom                : ' + s.name);
      console.log('    slug               : ' + (s.slug || '(absent)'));
      console.log('    isSmartSwika AVANT : ' + s.before);
      console.log('    isSmartSwika APRES : ' + s.after);
    });
  }

  return stats;
}

/* ============================================================
   MAIN
   ============================================================ */
async function main() {
  printHeader('migrate-unlock-at - projet ' + PROJECT_ID);
  console.log('  mode                : ' + (DRY_RUN ? 'SIMULATION (aucune ecriture)' : 'ECRITURE REELLE'));
  console.log('  ancre               : trackingStartedAt (jamais la date de commande)');
  console.log('  regle               : 15 j si un article isSmartSwika, sinon 7 j');
  console.log('  collection cible    : wallet_transactions (type=sale)');
  console.log('  fallback createdAt  : ' + (FORCE_FALLBACK_DATE ? 'ACTIVE (--force-fallback-date)' : 'desactive (recommande)'));
  console.log('  batch size          : ' + BATCH_SIZE);
  console.log('  taches              : ' + [
    DO_TRANSACTIONS ? 'wallet_transactions' : null,
    DO_PRODUCTS ? 'products' : null
  ].filter(Boolean).join(' + '));

  const { app, firestore } = loadAdmin();
  const { initializeApp, applicationDefault } = app;
  const { getFirestore, Timestamp } = firestore;

  initializeApp({
    projectId: PROJECT_ID,
    credential: applicationDefault()
  });

  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  const startedAt = Date.now();
  let txStats = null;
  let productStats = null;

  if (DO_TRANSACTIONS) {
    txStats = await migrateTransactions(db, Timestamp);
  }

  if (DO_PRODUCTS) {
    productStats = await migrateProducts(db);
  }

  printHeader('RAPPORT FINAL');
  if (txStats) {
    console.log('  wallet_transactions : ' +
      txStats.toUpdate + ' a corriger / ' + txStats.scanned + ' analyses' +
      (DRY_RUN ? '' : ' / ' + txStats.updated + ' ecrits'));
  }
  if (productStats) {
    console.log('  products            : ' +
      productStats.toUpdate + ' a corriger / ' + productStats.scanned + ' analyses' +
      (DRY_RUN ? '' : ' / ' + productStats.updated + ' ecrits'));
  }
  console.log('  duree               : ' + ((Date.now() - startedAt) / 1000).toFixed(1) + ' s');

  if (DRY_RUN) {
    console.log('');
    console.log('  [SIMULATION] Aucune ecriture effectuee.');
    console.log('  Relancez sans --dry-run pour appliquer les changements.');
  } else {
    console.log('');
    console.log('  ECRITURE TERMINEE.');
    console.log('  Relancez avec --dry-run pour verifier que le rapport est vide.');
  }
}

/* ============================================================
   POINT D'ENTREE
   ============================================================ */
if (SHOW_HELP) {
  printHelp();
  process.exit(0);
}

main().catch((err) => {
  console.error('');
  console.error('ERREUR : ' + (err && err.message ? err.message : err));
  const message = String((err && err.message) || '');
  if (/default credentials|Unable to detect a Project Id|Could not load the default credentials/i.test(message)) {
    console.error('');
    console.error('Credentials introuvables :');
    console.error('  1) gcloud auth application-default login');
    console.error('  2) set GOOGLE_APPLICATION_CREDENTIALS=C:\\chemin\\serviceAccount.json');
    console.error('');
    console.error('Module manquant ?');
    console.error('  npm i -D firebase-admin');
  }
  process.exit(1);
});
