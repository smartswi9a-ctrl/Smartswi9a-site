#!/usr/bin/env node
/**
 * migrate-delivery-mode.cjs
 *
 * Ajoute le champ `delivery_mode` sur les documents de la collection
 * `products` (Firestore, projet smartswi9a-31063).
 *
 * REGLE DE MIGRATION (idempotente) :
 *   Si `delivery_mode` est deja present et non vide  -> document ignore
 *   Sinon si `isSmartSwika === true`                 -> 'smartswika_warehouse'
 *   Sinon                                            -> 'dropoff'
 *
 * SECURITE
 *   Le mode par defaut est la SIMULATION (aucune ecriture).
 *   Aucune ecriture n'est possible sans le drapeau explicite --apply.
 *
 * USAGE
 *   node scripts/migrate-delivery-mode.cjs            # SIMULATION (defaut)
 *   node scripts/migrate-delivery-mode.cjs --apply    # ECRITURE REELLE
 *   node scripts/migrate-delivery-mode.cjs --help
 *
 * PREREQUIS
 *   npm i -D firebase-admin
 *   Cle de service : C:/Users/hp/firebase-admin-key.json (ou --key <chemin>)
 */

'use strict';

const fs = require('fs');

const PROJECT_ID = 'smartswi9a-31063';
const COLLECTION = 'products';
const FIELD = 'delivery_mode';
const MODE_SMART = 'smartswika_warehouse';
const MODE_DROPOFF = 'dropoff';
const DEFAULT_KEY = 'C:/Users/hp/firebase-admin-key.json';
const KNOWN_FLAGS = new Set(['--apply', '--dry-run', '--help', '-h', '--key']);

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
  console.log('migrate-delivery-mode.cjs - ajout du champ delivery_mode sur products');
  console.log('');
  console.log('  node scripts/migrate-delivery-mode.cjs            # SIMULATION (defaut)');
  console.log('  node scripts/migrate-delivery-mode.cjs --apply    # ECRITURE REELLE');
  console.log('');
  console.log('Sans --apply, le script ne fait AUCUNE ecriture (simulation).');
  console.log('');
  console.log('Options :');
  console.log('  --apply           ECRITURE REELLE. Obligatoire pour ecrire.');
  console.log('  --dry-run         Force la simulation (redondant avec le defaut).');
  console.log('  --key <chemin>    Fichier de cle de service (defaut : ' + DEFAULT_KEY + ')');
  console.log('  --help            Affiche cette aide.');
  console.log('');
  console.log('Regle : delivery_mode absent + isSmartSwika === true -> ' + MODE_SMART);
  console.log('        delivery_mode absent sinon                     -> ' + MODE_DROPOFF);
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

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
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

  const toMigrate = [];
  const alreadyOk = [];

  snap.forEach((doc) => {
    const data = doc.data() || {};
    if (isBlank(data[FIELD])) {
      const target = data.isSmartSwika === true ? MODE_SMART : MODE_DROPOFF;
      toMigrate.push({
        id: doc.id,
        name: productName(data),
        isSmartSwika: data.isSmartSwika === true,
        target,
      });
    } else {
      alreadyOk.push({ id: doc.id, name: productName(data), value: data[FIELD] });
    }
  });

  console.log('');
  console.log('==============================================================================');
  console.log('MIGRATION ' + FIELD + ' - ' + COLLECTION + ' @ ' + PROJECT_ID);
  console.log('MODE : ' + (opts.apply ? 'ECRITURE REELLE (--apply)' : 'SIMULATION (aucune ecriture)'));
  console.log('==============================================================================');
  console.log('Total produits........... : ' + snap.size);
  console.log('A migrer................. : ' + toMigrate.length);
  console.log('Deja conformes........... : ' + alreadyOk.length);
  console.log('');

  if (toMigrate.length > 0) {
    const willSmart = toMigrate.filter((p) => p.target === MODE_SMART).length;
    const willDropoff = toMigrate.filter((p) => p.target === MODE_DROPOFF).length;
    console.log('Repartition cible des migrations :');
    console.log('  ' + MODE_SMART.padEnd(24) + ' : ' + willSmart);
    console.log('  ' + MODE_DROPOFF.padEnd(24) + ' : ' + willDropoff);
    console.log('');
    console.log('--- A MIGRER (max 20 affiches) ---');
    toMigrate.slice(0, 20).forEach((p) => {
      console.log(
        '  ' + p.id + ' :: ' + p.name + ' :: isSmartSwika=' + p.isSmartSwika + ' -> ' + p.target
      );
    });
    if (toMigrate.length > 20) {
      console.log('  ... et ' + (toMigrate.length - 20) + ' autre(s).');
    }
    console.log('');
  }

  const distribution = {};
  alreadyOk.forEach((p) => {
    distribution[p.value] = (distribution[p.value] || 0) + 1;
  });
  toMigrate.forEach((p) => {
    distribution[p.target] = (distribution[p.target] || 0) + 1;
  });
  console.log('Repartition finale attendue par mode :');
  Object.keys(distribution)
    .sort()
    .forEach((mode) => {
      console.log('  ' + String(mode).padEnd(24) + ' : ' + distribution[mode]);
    });
  console.log('');

  if (!opts.apply) {
    console.log('SIMULATION : aucune ecriture effectuee.');
    console.log('Relancer avec --apply pour appliquer la migration.');
    console.log('');
    return 0;
  }

  if (toMigrate.length === 0) {
    console.log('Rien a ecrire : tous les produits sont deja conformes.');
    console.log('');
    return 0;
  }

  let written = 0;
  const BATCH_SIZE = 500;
  for (let start = 0; start < toMigrate.length; start += BATCH_SIZE) {
    const batch = db.batch();
    const slice = toMigrate.slice(start, start + BATCH_SIZE);
    slice.forEach((p) => {
      batch.update(db.collection(COLLECTION).doc(p.id), { [FIELD]: p.target });
    });
    await batch.commit();
    written += slice.length;
    console.log('Lot ecrit : ' + written + '/' + toMigrate.length);
  }

  console.log('');
  console.log('ECRITURE TERMINEE : ' + written + ' produit(s) migre(s).');
  console.log('');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Erreur :', err && err.message ? err.message : err);
    process.exit(1);
  });
