#!/usr/bin/env node
/**
 * audit-products-sku.cjs
 *
 * Inventaire LECTURE SEULE des SKU de la collection `products`
 * (Firestore, projet smartswi9a-31063).
 *
 * Remplace audit-livo-product-ids.cjs : le champ `livo_product_id` n'est
 * plus utilise (produit generique unique cote Livo), le SKU devient la
 * reference d'identification envoyee dans `refr`.
 *
 * CONTROLES
 *   1. SKU absent ou vide           -> BLOQUANT (refr inexploitable)
 *   2. SKU duplique                 -> BLOQUANT (ambiguite entrepoto)
 *   3. SKU present mais mal forme   -> AVERTISSEMENT (espaces autour)
 *
 * SECURITE
 *   STRICTEMENT en lecture seule : aucune ecriture, aucun --apply.
 *
 * USAGE
 *   node scripts/audit-products-sku.cjs
 *   node scripts/audit-products-sku.cjs --json
 *   node scripts/audit-products-sku.cjs --help
 *
 * PREREQUIS
 *   npm i -D firebase-admin
 *   Cle de service : C:/Users/hp/firebase-admin-key.json (ou --key <chemin>)
 */

'use strict';

const fs = require('fs');

const PROJECT_ID = 'smartswi9a-31063';
const COLLECTION = 'products';
const FIELD = 'sku';
const DEFAULT_KEY = 'C:/Users/hp/firebase-admin-key.json';
const KNOWN_FLAGS = new Set(['--json', '--help', '-h', '--key']);

/* ============================================================
   ARGUMENTS
   ============================================================ */
function parseArgs(argv) {
  const opts = { json: false, help: false, key: DEFAULT_KEY };

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
    } else if (flag === '--json') {
      opts.json = true;
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
  console.log('audit-products-sku.cjs - inventaire des SKU de products');
  console.log('');
  console.log('  node scripts/audit-products-sku.cjs [options]');
  console.log('');
  console.log('Options :');
  console.log('  --json            sortie JSON (machine lisible) au lieu du rapport texte');
  console.log('  --key <chemin>    Fichier de cle de service (defaut : ' + DEFAULT_KEY + ')');
  console.log('  --help            Affiche cette aide.');
  console.log('');
  console.log('Ce script est STRICTEMENT en lecture seule. Aucune donnee n est modifiee.');
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

function normSku(value) {
  return String(value).trim().toUpperCase();
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

  const missing = [];
  const malformed = [];
  const bySku = new Map();
  const all = [];

  snap.forEach((doc) => {
    const data = doc.data() || {};
    const raw = data[FIELD];
    const record = {
      id: doc.id,
      name: productName(data),
      vendorId: data.vendorId || '-',
      status: data.status || '(absent)',
      sku: raw,
    };
    all.push(record);

    if (isBlank(raw)) {
      missing.push(record);
      return;
    }

    if (typeof raw !== 'string') {
      malformed.push(record);
      return;
    }

    if (raw.trim() !== raw) {
      malformed.push(record);
    }

    const key = normSku(raw);
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key).push(record);
  });

  const duplicates = [];
  bySku.forEach((list, key) => {
    if (list.length > 1) {
      duplicates.push({ sku: key, count: list.length, products: list });
    }
  });
  duplicates.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  missing.sort(byId);
  malformed.sort(byId);

  const blocking = missing.length + duplicates.length;

  const report = {
    project: PROJECT_ID,
    collection: COLLECTION,
    field: FIELD,
    readOnly: true,
    total: all.length,
    withSku: all.length - missing.length,
    missingSku: missing.length,
    malformedSku: malformed.length,
    duplicateSkuGroups: duplicates.length,
    duplicateSkuProducts: duplicates.reduce((sum, d) => sum + d.count, 0),
    blockingIssues: blocking,
    productsMissingSku: missing,
    productsMalformedSku: malformed,
    duplicates,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return blocking > 0 ? 1 : 0;
  }

  const line = '==============================================================================';
  console.log(line);
  console.log('AUDIT ' + FIELD + ' - ' + COLLECTION + ' @ ' + PROJECT_ID + '  (LECTURE SEULE)');
  console.log(line);
  console.log('Total produits........... : ' + report.total);
  console.log('Avec SKU................. : ' + report.withSku);
  console.log('Sans SKU (BLOQUANT)...... : ' + report.missingSku);
  console.log('SKU mal forme............ : ' + report.malformedSku);
  console.log('Groupes de doublons...... : ' + report.duplicateSkuGroups);
  console.log('Produits en doublon...... : ' + report.duplicateSkuProducts);
  console.log('');

  if (missing.length > 0) {
    console.log('--- PRODUITS SANS SKU  >>> BLOQUANT <<<');
    missing.forEach((p) => {
      console.log('  ' + p.id + ' :: ' + p.name + ' :: vendorId=' + p.vendorId + ' :: status=' + p.status);
    });
    console.log('');
  }

  if (duplicates.length > 0) {
    console.log('--- SKU DUPLIQUES  >>> BLOQUANT <<<');
    duplicates.forEach((d) => {
      console.log('  ' + d.sku + ' (' + d.count + ' produits)');
      d.products.forEach((p) => {
        console.log('      - ' + p.id + ' :: ' + p.name + ' :: status=' + p.status);
      });
    });
    console.log('');
  }

  if (malformed.length > 0) {
    console.log('--- SKU MAL FORMES (espaces autour / non-string) ---');
    malformed.forEach((p) => {
      console.log('  ' + p.id + ' :: ' + p.name + ' :: sku=' + JSON.stringify(p.sku));
    });
    console.log('');
  }

  if (blocking === 0 && malformed.length === 0) {
    console.log('OK - tous les produits ont un SKU unique et exploitable.');
    console.log('');
  } else if (blocking === 0) {
    console.log('OK pour les bloquants, mais des SKU mal formes subsistent.');
    console.log('');
  }

  console.log(line);
  console.log('Aucune donnee modifiee (lecture seule).');
  console.log(line);

  return blocking > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Erreur :', err && err.message ? err.message : err);
    process.exit(1);
  });
