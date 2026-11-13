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
 *   node scripts/migrate-unlock-at.cjs --diagnose
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
 *   --diagnose             Diagnostic seul (aucune ecriture) : identite du
 *                          projet, credentials, emulateur, comptages bruts et
 *                          filtres, echantillons et collections visibles.
 *                          A utiliser quand la migration renvoie 0 document.
 *   --help                 Affiche cette aide.
 *
 * PREREQUIS
 *   npm i -D firebase-admin       (a la racine du depot)
 *   GOOGLE_APPLICATION_CREDENTIALS=C:\chemin\serviceAccount.json
 *
 * Le script est idempotent : relance sans effet si tout est deja conforme.
 * ========================================================================== */

const fs = require('fs');

const APOS = String.fromCharCode(39); // apostrophe, sans antislash

const PROJECT_ID = 'smartswi9a-31063';

const UNLOCK_DAYS_VENDOR = 7;
const UNLOCK_DAYS_SMART = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOLERANCE_MS = 60 * 1000; // 1 minute : evite les reecritures pour un arrondi
const BATCH_SIZE = 500;
const MAX_SAMPLES = 3;
const SMART_SWIKA_VENDOR_ID = 'smartswi9a';
// Identifiant de collection volontairement inoffensif : une lecture sur une
// collection inexistante ne cree rien. Attention, les noms de la forme
// __xxx__ sont RESERVES par Firestore et provoquent un INVALID_ARGUMENT.
const DIAGNOSTIC_PING_COLLECTION = 'diagnostic_ping';

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has('--dry-run');
const FORCE_FALLBACK_DATE = argv.has('--force-fallback-date');
const ONLY_PRODUCTS = argv.has('--only-products');
const ONLY_TRANSACTIONS = argv.has('--only-transactions');
const SHOW_HELP = argv.has('--help') || argv.has('-h');
const DIAGNOSE = argv.has('--diagnose');

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
  console.log('  node scripts/migrate-unlock-at.cjs --diagnose # diagnostic seul');
  console.log('');
  console.log('Options :');
  console.log('  --dry-run              Aucune ecriture, seulement le rapport.');
  console.log('  --force-fallback-date  Ecrit un unlockAt meme sans trackingStartedAt');
  console.log('                         (ancre = createdAt de la transaction). DANGEREUX.');
  console.log('  --only-products        Traite uniquement products.');
  console.log('  --only-transactions    Traite uniquement wallet_transactions.');
  console.log('  --diagnose             Diagnostic seul (aucune ecriture) :');
  console.log('                         projet, credentials, emulateur, comptages,');
  console.log('                         echantillons, collections visibles.');
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
   MODE --diagnose (aucune ecriture)
   ------------------------------------------------------------
   Objectif : expliquer pourquoi la migration renvoie 0 document alors
   que la base devrait etre peuplee (mauvais projet, emulateur actif,
   nom de collection errone, champ type absent...).
   Ce mode ne fait que LIRE.
   ============================================================ */

/** Lit uniquement le champ project_id d'un service account. Jamais la cle. */
function readServiceAccountProjectId(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.project_id === 'string' ? parsed.project_id : null;
  } catch (err) {
    return null;
  }
}

/** Rend un champ texte lisible, ou '(absent)'. */
function fieldOr(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback || '(absent)';
  }
  return String(value);
}

/** Compte les documents d'une collection (count() si dispo, sinon borne). */
async function countCollection(db, collectionName) {
  const ref = db.collection(collectionName);
  try {
    if (typeof ref.count === 'function') {
      const agg = await ref.count().get();
      return { total: agg.data().count, method: 'aggregation count()' };
    }
  } catch (err) {
    // On retombe sur une lecture bornee.
  }
  try {
    const snap = await ref.limit(1000).get();
    return { total: snap.size, method: 'lecture bornee limit(1000)', capped: snap.size >= 1000 };
  } catch (err) {
    return { total: null, method: 'indisponible', error: err && err.message ? err.message : String(err) };
  }
}

/** Repartition des valeurs d'un champ, par pages de 500. */
async function countByField(db, collectionName, fieldName, maxPages) {
  const pages = maxPages || 10;
  const counts = new Map();
  let scanned = 0;
  let lastDoc = null;

  for (let page = 0; page < pages; page += 1) {
    let query = db.collection(collectionName).orderBy('__name__').limit(500);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;
    snap.docs.forEach((doc) => {
      const data = doc.data() || {};
      const key = fieldOr(data[fieldName], '(champ absent)');
      counts.set(key, (counts.get(key) || 0) + 1);
      scanned += 1;
    });
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return { scanned, counts: sorted, truncated: scanned >= pages * 500 };
}

async function runDiagnose() {
  const startedAt = Date.now();

  printHeader('DIAGNOSTIC - migrate-unlock-at');
  console.log('  Mode lecture seule : aucune ecriture ne sera effectuee.');
  console.log('  Projet attendu par le script : ' + PROJECT_ID);

  /* ---------- 1. Connexion et identite ---------- */
  printHeader('1 - CONNEXION ET IDENTITE');

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
  console.log('  GOOGLE_APPLICATION_CREDENTIALS : ' + (credPath || '(non defini)'));

  let credProjectId = null;
  if (credPath) {
    if (!fs.existsSync(credPath)) {
      console.log('    ! fichier introuvable a ce chemin');
    } else {
      credProjectId = readServiceAccountProjectId(credPath);
      if (credProjectId) {
        console.log('    project_id du service account : ' + credProjectId);
      } else {
        console.log('    ! fichier illisible, JSON invalide, ou champ project_id absent');
      }
    }
  }
  console.log('    (la cle privee n' + APOS + 'est jamais affichee, seul project_id est lu)');

  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '';
  if (emulatorHost) {
    console.log('  FIRESTORE_EMULATOR_HOST        : ' + emulatorHost + '   <-- EMULATEUR ACTIF');
    console.log('    ! Les donnees lues viennent de l' + APOS + 'emulateur local, pas de la production.');
  } else {
    console.log('  FIRESTORE_EMULATOR_HOST        : (non defini) - connexion reelle');
  }

  if (process.env.GCLOUD_PROJECT) {
    console.log('  GCLOUD_PROJECT                 : ' + process.env.GCLOUD_PROJECT);
  }
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    console.log('  GOOGLE_CLOUD_PROJECT           : ' + process.env.GOOGLE_CLOUD_PROJECT);
  }

  const { app, firestore } = loadAdmin();
  const { initializeApp, applicationDefault } = app;
  const { getFirestore } = firestore;

  const appInstance = initializeApp({
    projectId: PROJECT_ID,
    credential: applicationDefault()
  });

  const effectiveProjectId =
    appInstance && appInstance.options && appInstance.options.projectId
      ? appInstance.options.projectId
      : PROJECT_ID;

  console.log('');
  console.log('  projectId utilise par le SDK   : ' + effectiveProjectId);

  const mismatches = [];
  if (credProjectId && credProjectId !== effectiveProjectId) {
    mismatches.push(
      'le service account pointe sur "' + credProjectId + '" mais le SDK interroge "' + effectiveProjectId + '"'
    );
  }
  if (emulatorHost) {
    mismatches.push('un emulateur Firestore est actif : les collections peuvent etre vides');
  }

  if (mismatches.length > 0) {
    console.log('');
    console.log('  ! COHERENCE A VERIFIER :');
    mismatches.forEach((m) => console.log('    - ' + m));
  } else {
    console.log('  coherence projet : OK (aucun ecart detecte)');
  }

  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });

  console.log('');
  let pingOk = false;
  try {
    const pingSnap = await db.collection(DIAGNOSTIC_PING_COLLECTION).limit(1).get();
    pingOk = true;
    console.log('  appel de test Firestore       : OK (reponse recue, ' + pingSnap.size + ' document(s))');
  } catch (err) {
    console.log('  appel de test Firestore       : ECHEC');
    console.log('    ' + (err && err.message ? err.message : err));
    console.log('');
    console.log('  Diagnostic interrompu.');
    console.log('  Verifiez la valeur de GOOGLE_APPLICATION_CREDENTIALS et les droits IAM du');
    console.log('  service account (roles/datastore.user ou roles/datastore.owner).');
    return;
  }

  /* ---------- 2. Comptages bruts vs filtres ---------- */
  printHeader('2 - COMPTAGES : BRUT vs FILTRES DE MIGRATION');

  const txTotal = await countCollection(db, 'wallet_transactions');
  if (txTotal.total === null) {
    console.log('  wallet_transactions (total)   : indisponible (' + (txTotal.error || 'erreur') + ')');
  } else {
    console.log('  wallet_transactions (total)   : ' + txTotal.total + '   [' + txTotal.method + ']');
  }

  const prodTotal = await countCollection(db, 'products');
  if (prodTotal.total === null) {
    console.log('  products (total)              : indisponible (' + (prodTotal.error || 'erreur') + ')');
  } else {
    console.log('  products (total)              : ' + prodTotal.total + '   [' + prodTotal.method + ']');
  }

  let txSale = null;
  try {
    const snap = await db.collection('wallet_transactions').where('type', '==', 'sale').get();
    txSale = snap.size;
    console.log('  wallet_transactions type=sale : ' + snap.size + '   [filtre de la migration]');
  } catch (err) {
    console.log('  wallet_transactions type=sale : ECHEC - ' + (err && err.message ? err.message : err));
  }

  let prodSmart = null;
  try {
    const snap = await db.collection('products')
      .where('vendorId', '==', SMART_SWIKA_VENDOR_ID)
      .get();
    prodSmart = snap.size;
    console.log('  products vendorId=' + SMART_SWIKA_VENDOR_ID + '     : ' + snap.size + '   [filtre de la migration]');
  } catch (err) {
    console.log('  products vendorId=' + SMART_SWIKA_VENDOR_ID + '     : ECHEC - ' + (err && err.message ? err.message : err));
  }

  /* ---------- 3. Echantillons ---------- */
  printHeader('3 - ECHANTILLONS (' + MAX_SAMPLES + ' premiers documents)');

  try {
    const snap = await db.collection('wallet_transactions').limit(MAX_SAMPLES).get();
    if (snap.empty) {
      console.log('  wallet_transactions : collection vide ou inexistante');
    } else {
      snap.docs.forEach((doc, index) => {
        const data = doc.data() || {};
        console.log('');
        console.log('  [' + (index + 1) + '/' + snap.size + '] wallet_transactions');
        console.log('    id                : ' + doc.id);
        console.log('    type              : ' + fieldOr(data.type));
        console.log('    status            : ' + fieldOr(data.status));
        console.log('    vendorId          : ' + fieldOr(data.vendorId));
        console.log('    orderId           : ' + fieldOr(data.orderId));
        console.log('    unlockAt          : ' + formatDate(data.unlockAt));
        console.log('    trackingStartedAt : ' + formatDate(data.trackingStartedAt));
        console.log('    createdAt         : ' + formatDate(data.createdAt));
      });
    }
  } catch (err) {
    console.log('  wallet_transactions : ECHEC - ' + (err && err.message ? err.message : err));
  }

  try {
    const snap = await db.collection('products').limit(MAX_SAMPLES).get();
    if (snap.empty) {
      console.log('');
      console.log('  products : collection vide ou inexistante');
    } else {
      snap.docs.forEach((doc, index) => {
        const data = doc.data() || {};
        console.log('');
        console.log('  [' + (index + 1) + '/' + snap.size + '] products');
        console.log('    id                : ' + doc.id);
        console.log('    vendorId          : ' + fieldOr(data.vendorId));
        console.log('    type              : ' + fieldOr(data.type));
        console.log('    status            : ' + fieldOr(data.status));
        console.log('    isSmartSwika      : ' + fieldOr(data.isSmartSwika));
        console.log('    nom               : ' + fieldOr(data.nameFr || data.nameEn || data.slug));
      });
    }
  } catch (err) {
    console.log('  products : ECHEC - ' + (err && err.message ? err.message : err));
  }

  /* ---------- 4. Collections visibles ---------- */
  printHeader('4 - COLLECTIONS VISIBLES A LA RACINE');

  let visibleCollections = [];
  try {
    const collections = await db.listCollections();
    visibleCollections = collections.map((c) => c.id).sort();
    if (visibleCollections.length === 0) {
      console.log('  Aucune collection visible a la racine.');
      console.log('  ! La base semble vide, ou les droits de lecture sont insuffisants.');
    } else {
      console.log('  ' + visibleCollections.length + ' collection(s) :');
      visibleCollections.forEach((name) => console.log('    - ' + name));
    }
  } catch (err) {
    console.log('  listCollections() : ECHEC - ' + (err && err.message ? err.message : err));
  }

  if (visibleCollections.length > 0) {
    const expected = ['wallet_transactions', 'products', 'orders'];
    const missing = expected.filter((name) => visibleCollections.indexOf(name) === -1);
    console.log('');
    if (missing.length > 0) {
      console.log('  ! Collections attendues mais ABSENTES : ' + missing.join(', '));
    } else {
      console.log('  Les collections attendues (wallet_transactions, products, orders) sont presentes.');
    }
  }

  /* ---------- 5. Repartition par type ---------- */
  printHeader('5 - wallet_transactions : REPARTITION PAR type');

  try {
    const byType = await countByField(db, 'wallet_transactions', 'type');
    if (byType.scanned === 0) {
      console.log('  Aucun document lisible dans wallet_transactions.');
    } else {
      console.log('  ' + byType.scanned + ' document(s) analyse(s)' +
        (byType.truncated ? ' (echantillon tronque)' : '') + ' :');
      byType.counts.forEach((entry) => {
        console.log('    ' + String(entry[0]).padEnd(20, ' ') + ' : ' + entry[1]);
      });
      const hasSale = byType.counts.some((e) => e[0] === 'sale');
      if (!hasSale) {
        console.log('');
        console.log('  ! Aucun document type="sale" : la migration n' + APOS + 'a donc rien a traiter.');
        console.log('    Le champ type existe-t-il sous un autre nom, ou avec une autre valeur ?');
      }
    }
  } catch (err) {
    console.log('  repartition par type : ECHEC - ' + (err && err.message ? err.message : err));
  }

  /* ---------- 6. Conclusion ---------- */
  printHeader('CONCLUSION');

  const problems = [];
  if (mismatches.length > 0) problems = problems.concat(mismatches);
  if (visibleCollections.length === 0) {
    problems.push('aucune collection visible : base vide ou droits insuffisants');
  }
  if (txTotal.total === 0) problems.push('wallet_transactions est vide');
  if (prodTotal.total === 0) problems.push('products est vide');
  if (txTotal.total !== null && txTotal.total > 0 && txSale === 0) {
    problems.push('des transactions existent mais aucune n' + APOS + 'est de type "sale"');
  }
  if (prodTotal.total !== null && prodTotal.total > 0 && prodSmart === 0) {
    problems.push('des produits existent mais aucun n' + APOS + 'a vendorId="smartswi9a"');
  }

  if (problems.length === 0) {
    console.log('  Aucun probleme detecte : les filtres de migration trouvent bien des documents.');
    console.log('  Vous pouvez lancer : node scripts/migrate-unlock-at.cjs --dry-run');
  } else {
    console.log('  Piste(s) expliquant probablement le resultat "0 document" :');
    problems.forEach((p) => console.log('    - ' + p));
  }

  console.log('');
  console.log('  duree : ' + ((Date.now() - startedAt) / 1000).toFixed(1) + ' s');
  console.log('  Aucune ecriture effectuee (mode --diagnose).');
  console.log('');
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

const runner = DIAGNOSE ? runDiagnose : main;

runner().catch((err) => {
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
