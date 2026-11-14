#!/usr/bin/env node
/**
 * init-stock-warehouse.cjs
 *
 * Initialise le champ `stock_warehouse` a 0 sur les documents de la
 * collection `products` (Firestore, projet smartswi9a-31063).
 *
 * REGLE DE MIGRATION (idempotente) :
 *   Si `stock_warehouse` est deja present (nombre, y compris 0) -> ignore
 *   Sinon                                                       -> 0
 *
 * SECURITE
 *   Le mode par defaut est la SIMULATION (aucune ecriture).
 *   Aucune ecriture n'est possible sans le drapeau explicite --apply.
 *
 * USAGE
 *   node scripts/init-stock-warehouse.cjs            # SIMULATION (defaut)
 *   node scripts/init-stock-warehouse.cjs --apply    # ECRITURE REELLE
 *   node scripts/init-stock-warehouse.cjs --help
 *
 * PREREQUIS
 *   npm i -D firebase-admin
 *   Cle de service : C:/Users/hp/firebase-admin-key.json (ou --key <chemin>)
 */

'use strict';

const fs = require('fs');

const PROJECT_ID = 'smartswi9a-31063';
const COLLECTION = 'products';
const FIELD = 'stock_warehouse';
const DEFAULT_KEY = 'C:/Users/hp/firebase-admin-key.json';
const KNOWN_FLAGS = new Set(['--apply', '--dry-run', '--help', '-h', '--key']);
const BATCH_SIZE = 500;

/* ============================================================
   ARGUMENTS
   ============================================================ */
function parseArgs(argv) {
  const opts = { apply: false, help: false, key: DEFAULT_KEY };

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
    } else if (flag === '--key') {
      let value;
      if (eq !== -1) {
        value = raw.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (!next || next.indexOf('--') === 0) {
          console.error('--key attend une valeur');
          process.exit(2);
        }
        value = next;
        i += 1;
      }
      opts.key = value;
    }
  }

  return opts;
}

function printHelp() {
  console.log('');
  console.log('init-stock-warehouse.cjs - initialisation de stock_warehouse sur products');
  console.log('');
  console.log('  node scripts/init-stock-warehouse.cjs            # SIMULATION (defaut)');
  console.log('  node scripts/init-stock-warehouse.cjs --apply    # ECRITURE REELLE');
  console.log('');
  console.log('Sans --apply, le script ne fait AUCUNE ecriture (simulation).');
  console.log('');
  console.log('Options :');
  console.log('  --apply           ECRITURE REELLE. Obligatoire pour ecrire.');
  console.log('  --dry-run         Force la simulation (redondant avec le defaut).');
  console.log('  --key <chemin>    Fichier de cle de service (defaut : ' + DEFAULT_KEY + ')');
  console.log('  --help            Affiche cette aide.');
  console.log('');
  console.log('Regle : stock_warehouse absent -> 0 (les valeurs existantes sont preservees).');
  console.log('');
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
    };
  } catch (_) {
    console.error('Le module firebase-admin (API modulaire) est absent.');
    console.error('Installer avec : npm install --save-dev firebase-admin');
    return null;
  }
}

function productName(data) {
  return (
    data.nameFr ||
    data.nameEn ||
    data.nameAr ||
    data.slug ||
    data.name ||
    data.title ||
    '(sans nom)'
  );
}

/**
 * Un stock valide est un nombre fini >= 0.
 * On considere 0 comme une valeur legitime : un produit deja initialise a 0
 * ne doit PAS etre reecrit (idempotence).
 */
function hasValidStock(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
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
  const snap = await db.collection(COLLECTION).get();

  const toInit = [];
  const alreadyOk = [];
  const malformed = [];

  snap.forEach((doc) => {
    const data = doc.data() || {};
    const value = data[FIELD];

    if (value === undefined || value === null) {
      toInit.push({ id: doc.id, name: productName(data) });
    } else if (hasValidStock(value)) {
      alreadyOk.push({ id: doc.id, name: productName(data), value });
    } else {
      // Valeur presente mais inexploitable (string, negatif, NaN...).
      malformed.push({ id: doc.id, name: productName(data), value });
    }
  });

  console.log('');
  console.log('==============================================================================');
  console.log('INITIALISATION ' + FIELD + ' - ' + COLLECTION + ' @ ' + PROJECT_ID);
  console.log('MODE : ' + (opts.apply ? 'ECRITURE REELLE (--apply)' : 'SIMULATION (aucune ecriture)'));
  console.log('==============================================================================');
  console.log('Total produits........... : ' + snap.size);
  console.log('A initialiser............ : ' + toInit.length);
  console.log('Deja conformes........... : ' + alreadyOk.length);
  console.log('Valeurs suspectes........ : ' + malformed.length);
  console.log('');

  if (toInit.length > 0) {
    console.log('--- A INITIALISER (max 20 affiches) ---');
    toInit.slice(0, 20).forEach((p) => {
      console.log('  ' + p.id + ' :: ' + p.name + ' -> ' + FIELD + ' = 0');
    });
    if (toInit.length > 20) {
      console.log('  ... et ' + (toInit.length - 20) + ' autre(s).');
    }
    console.log('');
  }

  if (malformed.length > 0) {
    console.log('--- VALEURS SUSPECTES (non touchees) ---');
    malformed.slice(0, 20).forEach((p) => {
      console.log('  ' + p.id + ' :: ' + p.name + ' :: ' + FIELD + '=' + JSON.stringify(p.value));
    });
    if (malformed.length > 20) {
      console.log('  ... et ' + (malformed.length - 20) + ' autre(s).');
    }
    console.log('');
  }

  if (!opts.apply) {
    console.log('SIMULATION : aucune ecriture effectuee.');
    console.log('Relancer avec --apply pour appliquer l initialisation.');
    console.log('');
    return 0;
  }

  if (toInit.length === 0) {
    console.log('Rien a ecrire : tous les produits ont deja un stock_warehouse valide.');
    console.log('');
    return 0;
  }

  let written = 0;
  for (let start = 0; start < toInit.length; start += BATCH_SIZE) {
    const batch = db.batch();
    const slice = toInit.slice(start, start + BATCH_SIZE);
    slice.forEach((p) => {
      batch.update(db.collection(COLLECTION).doc(p.id), { [FIELD]: 0 });
    });
    await batch.commit();
    written += slice.length;
    console.log('Lot ecrit : ' + written + '/' + toInit.length);
  }

  console.log('');
  console.log('ECRITURE TERMINEE : ' + written + ' produit(s) initialise(s) a 0.');
  console.log('');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Erreur :', err && err.message ? err.message : err);
    process.exit(1);
  });
