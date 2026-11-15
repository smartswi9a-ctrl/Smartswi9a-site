#!/usr/bin/env node
/**
 * backfill-grouped-pickup-eligible.cjs
 *
 * PR 8.4 - Ramassage groupe : attestation d'eligibilite one-shot.
 *
 * Probleme resolu
 *   La garde de js/orders.js (confirmed -> pickup_requested) et la modale de
 *   ramassage groupe (js/admin.js) s'appuient sur l'attestation
 *   `groupedPickupEligible`. Cette attestation n'est posee QUE par les
 *   commandes traitees apres le deploiement. Les commandes deja en statut
 *   `confirmed` au moment du merge n'en ont pas : elles resteraient invisibles
 *   du ramassage jusqu'a ce qu'un admin les repasse a la main.
 *
 *   Ce script ecrit l'attestation sur les commandes deja eligibles, sans
 *   jamais toucher au statut ni a livoPickupId.
 *
 * PREDICAT
 *   Les regles ne sont PAS reecrites ici : le script extrait
 *   js/grouped-pickup.js (module ES, sans DOM) via `vm` et appelle
 *   evaluateGroupedPickupOrder() avec un contexte construit a partir de
 *   lectures Firestore. Il y a donc une seule source de verite : si le
 *   predicat evolue, le backfill evolue avec lui.
 *
 * SECURITE
 *   - SIMULATION par defaut : aucune ecriture sans --apply.
 *   - Ecriture unique : { groupedPickupEligible: true,
 *     groupedPickupEligibleAt, groupedPickupEligibleSource } en merge:true.
 *   - JAMAIS de statut, JAMAIS de livoPickupId, JAMAIS de false.
 *   - Idempotent : une commande deja attestee est ignoree (re-run sans effet).
 *   - Fail-closed : une lecture vendeur/produit en echec => commande ignoree.
 *
 * USAGE
 *   node scripts/backfill-grouped-pickup-eligible.cjs            # SIMULATION
 *   node scripts/backfill-grouped-pickup-eligible.cjs --dry-run  # idem explicite
 *   node scripts/backfill-grouped-pickup-eligible.cjs --apply    # ECRITURE
 *   node scripts/backfill-grouped-pickup-eligible.cjs --audit    # rapport seul
 *   node scripts/backfill-grouped-pickup-eligible.cjs --limit=50 # plafonne
 *
 * PREREQUIS
 *   npm i -D firebase-admin
 *   Cle de service : C:/Users/hp/firebase-admin-key.json (ou --key <chemin>)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJECT_ID = 'smartswi9a-31063';
const COLLECTION = 'orders';
const DEFAULT_KEY = 'C:/Users/hp/firebase-admin-key.json';
const SOURCE_TAG = 'backfill-pr8.4';
const PREDICATE_FILE = path.resolve(__dirname, '..', 'js', 'grouped-pickup.js');

const KNOWN_FLAGS = new Set([
  '--apply', '--dry-run', '--audit', '--help', '-h', '--key', '--limit'
]);

/* ============================================================
   ARGUMENTS
   ============================================================ */
function parseArgs(argv) {
  const opts = { apply: false, audit: false, help: false, key: DEFAULT_KEY, limit: Infinity };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);

    if (!KNOWN_FLAGS.has(flag)) {
      console.error('Option inconnue : ' + raw);
      console.error('Options supportees : ' + Array.from(KNOWN_FLAGS).join(', '));
      process.exit(2);
    }

    if (flag === '--help' || flag === '-h') {
      opts.help = true;
    } else if (flag === '--apply') {
      opts.apply = true;
    } else if (flag === '--dry-run') {
      opts.apply = false;
    } else if (flag === '--audit') {
      opts.audit = true;
      opts.apply = false;
    } else if (flag === '--key' || flag === '--limit') {
      let value;
      if (eq !== -1) {
        value = raw.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (!next || next.indexOf('--') === 0) {
          console.error(flag + ' attend une valeur');
          process.exit(2);
        }
        value = next;
        i += 1;
      }
      if (flag === '--key') {
        opts.key = value;
      } else {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          console.error('--limit attend un entier positif');
          process.exit(2);
        }
        opts.limit = Math.floor(n);
      }
    }
  }

  if (opts.audit) opts.apply = false;
  return opts;
}

function printHelp() {
  console.log('');
  console.log('backfill-grouped-pickup-eligible.cjs - attestation d\'eligibilite PR 8.4');
  console.log('');
  console.log('  node scripts/backfill-grouped-pickup-eligible.cjs            # SIMULATION');
  console.log('  node scripts/backfill-grouped-pickup-eligible.cjs --dry-run   # idem');
  console.log('  node scripts/backfill-grouped-pickup-eligible.cjs --apply     # ECRITURE');
  console.log('  node scripts/backfill-grouped-pickup-eligible.cjs --audit     # rapport');
  console.log('  node scripts/backfill-grouped-pickup-eligible.cjs --limit=50  # plafond');
  console.log('');
  console.log('Sans --apply, le script ne fait AUCUNE ecriture.');
  console.log('');
  console.log('Options :');
  console.log('  --apply           ECRITURE REELLE. Obligatoire pour ecrire.');
  console.log('  --dry-run         Force la simulation (redondant avec le defaut).');
  console.log('  --audit           Rapport detaille, jamais d\'ecriture.');
  console.log('  --limit=N         Traite au plus N commandes candidates.');
  console.log('  --key <chemin>    Fichier de cle de service (defaut : ' + DEFAULT_KEY + ')');
  console.log('  --help            Affiche cette aide.');
  console.log('');
  console.log('Ecrit UNIQUEMENT (merge:true) :');
  console.log('  groupedPickupEligible       = true');
  console.log('  groupedPickupEligibleAt     = <timestamp serveur>');
  console.log('  groupedPickupEligibleSource = \'' + SOURCE_TAG + '\'');
  console.log('');
  console.log('Ne touche JAMAIS : status, livoPickupId, ni aucune autre valeur.');
  console.log('');
}

/* ============================================================
   PREDICAT - extraction du module ES via vm
   ============================================================ */
function loadPredicate() {
  if (!fs.existsSync(PREDICATE_FILE)) {
    throw new Error('Module introuvable : ' + PREDICATE_FILE);
  }
  const source = fs.readFileSync(PREDICATE_FILE, 'utf8');

  // Transformations minimales : le module est ecrit en ESM et sans DOM, mais
  // il importe les helpers Firebase pour construire le contexte de lot.
  // On retire ces imports : le backfill construit ses propres Maps.
  let code = source
    .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"]\s*;?/gm, '')
    .replace(/\bexport\s+default\s+/g, 'module.exports.default = ')
    .replace(/\bexport\s+(async\s+function|function|const|let|var|class)/g, '$1');

  // Expose ce dont on a besoin au scope du script.
  code += '\n;this.__exports = {\n' +
    '  evaluateGroupedPickupOrder: typeof evaluateGroupedPickupOrder !== "undefined" ? evaluateGroupedPickupOrder : null,\n' +
    '  getOrderVendorIds: typeof getOrderVendorIds !== "undefined" ? getOrderVendorIds : null,\n' +
    '  getOrderProductIds: typeof getOrderProductIds !== "undefined" ? getOrderProductIds : null,\n' +
    '  INCOMPATIBLE_PAYMENT_STATUSES: typeof INCOMPATIBLE_PAYMENT_STATUSES !== "undefined" ? INCOMPATIBLE_PAYMENT_STATUSES : null\n' +
    '};\n';

  const sandbox = {
    console,
    module: { exports: {} },
    exports: {},
    setTimeout,
    clearTimeout,
    // Stubs : le predicat ne fait aucun I/O, mais le module declare des
    // imports Firebase au niveau superieur. Ils sont retires ci-dessus ; ces
    // stubs couvrent tout appel residuel dans une branche non utilisee.
    getDoc: async () => null,
    doc: () => ({}),
    db: null,
    document: undefined,
    window: undefined,
    Promise,
    Map,
    Set,
    Date,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object,
    Boolean
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: PREDICATE_FILE });

  const api = sandbox.__exports;
  if (!api || typeof api.evaluateGroupedPickupOrder !== 'function') {
    throw new Error('evaluateGroupedPickupOrder() introuvable apres extraction de ' + PREDICATE_FILE);
  }
  return api;
}

/* ============================================================
   FIRESTORE
   ============================================================ */
function loadAdmin() {
  try {
    const appMod = require('firebase-admin/app');
    const fsMod = require('firebase-admin/firestore');
    return {
      initializeApp: appMod.initializeApp,
      getApps: appMod.getApps,
      cert: appMod.cert,
      getFirestore: fsMod.getFirestore,
      FieldValue: fsMod.FieldValue
    };
  } catch (_) {
    console.error('Le module firebase-admin (API modulaire) est absent.');
    console.error('Installer avec : npm install --save-dev firebase-admin');
    return null;
  }
}

function shortId(id) {
  return String(id || '').slice(0, 8);
}

/* ============================================================
   MAIN
   ============================================================ */
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return 0;
  }

  let predicate;
  try {
    predicate = loadPredicate();
  } catch (err) {
    console.error('Predicat : ' + (err && err.message ? err.message : err));
    return 1;
  }

  if (!fs.existsSync(opts.key)) {
    console.error('Fichier de cles introuvable : ' + opts.key);
    return 1;
  }

  const admin = loadAdmin();
  if (!admin) return 1;

  const serviceAccount = JSON.parse(fs.readFileSync(opts.key, 'utf8'));
  if (serviceAccount.project_id && serviceAccount.project_id !== PROJECT_ID) {
    console.error(
      'ATTENTION : le fichier de cles cible "' +
        serviceAccount.project_id +
        '" au lieu de "' +
        PROJECT_ID +
        '".'
    );
    return 1;
  }

  const app =
    admin.getApps().length > 0
      ? admin.getApps()[0]
      : admin.initializeApp({ credential: admin.cert(serviceAccount), projectId: PROJECT_ID });
  const db = admin.getFirestore(app);

  /* 1) Lecture des commandes en statut `confirmed` : c'est le seul statut
        que le predicat accepte (regle 1), et le seul ou l'attestation a un
        effet (la garde ne s'applique qu'a confirmed -> pickup_requested). */
  const snap = await db.collection(COLLECTION).where('status', '==', 'confirmed').get();
  const orders = [];
  snap.forEach((docSnap) => orders.push({ id: docSnap.id, ...(docSnap.data() || {}) }));

  /* 2) Contexte : une lecture par vendeur et par produit distincts. */
  const vendorIds = new Set();
  const productIds = new Set();
  orders.forEach((order) => {
    (predicate.getOrderVendorIds ? predicate.getOrderVendorIds(order) : []).forEach((id) => vendorIds.add(id));
    (predicate.getOrderProductIds ? predicate.getOrderProductIds(order) : []).forEach((id) => productIds.add(id));
  });

  const readCollection = async (collectionName, ids) => {
    const map = new Map();
    const arr = Array.from(ids);
    const CHUNK = 20;
    for (let i = 0; i < arr.length; i += CHUNK) {
      const slice = arr.slice(i, i + CHUNK);
      const reads = await Promise.all(
        slice.map((id) =>
          db.collection(collectionName).doc(id).get().catch(() => null)
        )
      );
      reads.forEach((docSnap, index) => {
        const id = slice[index];
        if (!docSnap) {
          // Lecture en echec : enregistree non lisible -> le predicat rejette.
          map.set(id, { exists: false, unreadable: true });
          return;
        }
        map.set(id, docSnap);
      });
    }
    return map;
  };

  const vendorSnaps = await readCollection('users', vendorIds);
  const productSnaps = await readCollection('products', productIds);

  const vendors = new Map();
  vendorSnaps.forEach((docSnap, id) => {
    vendors.set(id, {
      exists: docSnap.exists === true,
      vendorInfo: docSnap.exists === true ? (docSnap.data().vendorInfo || {}) : {}
    });
  });
  const products = new Map();
  productSnaps.forEach((docSnap, id) => {
    products.set(id, {
      exists: docSnap.exists === true,
      delivery_mode: docSnap.exists === true ? docSnap.data().delivery_mode : null
    });
  });
  const ctx = { vendors, products };

  /* 3) Evaluation. */
  const alreadyAttested = [];
  const eligible = [];
  const rejected = [];

  orders.forEach((order) => {
    if (order.groupedPickupEligible === true) {
      alreadyAttested.push(order);
      return;
    }
    const evaluation = predicate.evaluateGroupedPickupOrder(order, ctx);
    if (evaluation && evaluation.eligible === true) {
      eligible.push({ order, evaluation });
    } else {
      rejected.push({ order, evaluation });
    }
  });

  const toWrite = Number.isFinite(opts.limit) ? eligible.slice(0, opts.limit) : eligible;
  const skippedByLimit = eligible.length - toWrite.length;
  const totalArticles = toWrite.reduce((sum, e) => sum + (e.evaluation.articles || 0), 0);

  /* 4) Rapport. */
  console.log('');
  console.log('==============================================================================');
  console.log('BACKFILL groupedPickupEligible - ' + COLLECTION + ' @ ' + PROJECT_ID);
  console.log('MODE : ' + (opts.apply ? 'ECRITURE REELLE (--apply)' : (opts.audit ? 'AUDIT (aucune ecriture)' : 'SIMULATION (aucune ecriture)')));
  console.log('PREDICAT : ' + PREDICATE_FILE);
  console.log('==============================================================================');
  console.log('Commandes confirmed lues....... : ' + orders.length);
  console.log('Deja attestees (ignorees)..... : ' + alreadyAttested.length);
  console.log('Eligibles non attestees....... : ' + eligible.length);
  console.log('Rejetees par le predicat ..... : ' + rejected.length);
  if (Number.isFinite(opts.limit)) {
    console.log('Plafond --limit ............... : ' + opts.limit + ' (differees : ' + skippedByLimit + ')');
  }
  console.log('A ecrire ..................... : ' + toWrite.length + ' commande(s), ' + totalArticles + ' colis');
  console.log('');

  if (toWrite.length > 0) {
    console.log('--- A ATTESTER (' + Math.min(toWrite.length, 30) + ' affichees) ---');
    toWrite.slice(0, 30).forEach(({ order, evaluation }) => {
      console.log(
        '  ' + shortId(order.id) +
        ' :: ' + (evaluation.vendorIds[0] || 'plateforme') +
        ' :: ' + evaluation.articles + ' colis' +
        ' :: ' + evaluation.productIds.length + ' produit(s)'
      );
    });
    if (toWrite.length > 30) {
      console.log('  ... et ' + (toWrite.length - 30) + ' autre(s).');
    }
    console.log('');
  }

  if (opts.audit) {
    const reasons = {};
    rejected.forEach(({ evaluation }) => {
      const list = (evaluation && evaluation.reasons) || ['inconnu'];
      list.forEach((r) => {
        const key = String(r).split(':')[0];
        reasons[key] = (reasons[key] || 0) + 1;
      });
    });
    console.log('--- AUDIT : motifs de rejet ---');
    Object.keys(reasons).sort().forEach((key) => {
      console.log('  ' + key.padEnd(28) + ' : ' + reasons[key]);
    });
    console.log('');
    console.log('--- AUDIT : detail des rejets (' + Math.min(rejected.length, 30) + ' affiches) ---');
    rejected.slice(0, 30).forEach(({ order, evaluation }) => {
      const list = (evaluation && evaluation.reasons) || [];
      console.log('  ' + shortId(order.id) + ' :: ' + list.join(', '));
    });
    if (rejected.length > 30) {
      console.log('  ... et ' + (rejected.length - 30) + ' autre(s).');
    }
    console.log('');
    console.log('AUDIT : aucune ecriture effectuee.');
    console.log('');
    return 0;
  }

  if (!opts.apply) {
    console.log('SIMULATION : aucune ecriture effectuee.');
    console.log('Relancer avec --apply pour ecrire les attestations.');
    console.log('');
    return 0;
  }

  if (toWrite.length === 0) {
    console.log('Rien a ecrire : toutes les commandes eligibles sont deja attestees.');
    console.log('');
    return 0;
  }

  /* 5) Ecriture : merge:true, uniquement les 3 champs d'attestation. */
  let written = 0;
  const BATCH_SIZE = 400;
  for (let start = 0; start < toWrite.length; start += BATCH_SIZE) {
    const batch = db.batch();
    const slice = toWrite.slice(start, start + BATCH_SIZE);
    slice.forEach(({ order }) => {
      const ref = db.collection(COLLECTION).doc(order.id);
      batch.set(
        ref,
        {
          groupedPickupEligible: true,
          groupedPickupEligibleAt: admin.FieldValue.serverTimestamp(),
          groupedPickupEligibleSource: SOURCE_TAG
        },
        { merge: true }
      );
    });
    await batch.commit();
    written += slice.length;
    console.log('Lot ecrit : ' + written + '/' + toWrite.length);
  }

  console.log('');
  console.log('ECRITURE TERMINEE : ' + written + ' commande(s) attestee(s).');
  console.log('Aucun statut modifie, aucun livoPickupId pose.');
  console.log('');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Erreur :', err && err.message ? err.message : err);
    process.exit(1);
  });
