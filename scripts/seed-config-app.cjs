'use strict';

/*
 * seed-config-app.cjs
 *
 * Ecrit config/app.contractVersion dans Firestore (projet smartswi9a-31063).
 *
 * USAGE
 *   node scripts/seed-config-app.cjs --help
 *   node scripts/seed-config-app.cjs --dry-run   # SIMULATION
 *   node scripts/seed-config-app.cjs             # ECRITURE
 *
 * PREREQUIS
 *   firebase-admin (API modulaire) resolvable depuis la racine du depot.
 *   Credentials : GOOGLE_APPLICATION_CREDENTIALS ou
 *   gcloud auth application-default login.
 *
 * HISTORIQUE
 *   La version precedente chargeait firebase-admin via
 *   `path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin')`,
 *   chemin qui n'existe pas (MODULE_NOT_FOUND), puis utilisait
 *   `admin.credential.applicationDefault()`, namespace supprime dans
 *   firebase-admin v14 (TypeError). Les deux sont corriges ici par la
 *   migration vers l'API modulaire, alignee sur
 *   scripts/backfill-shipping-to-in-transit.cjs.
 */

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const EXPECTED_CONTRACT_VERSION = '1.5.0';
const PROJECT_ID = 'smartswi9a-31063';
const DRY_RUN = process.argv.includes('--dry-run');
const HELP = process.argv.includes('--help') || process.argv.includes('-h');

/* --help court-circuite AVANT toute initialisation Firebase : aucune
   credentials n'est lue, aucun appel reseau n'est fait, exit 0. */
if (HELP) {
  console.log('');
  console.log('seed-config-app.cjs - ecrit config/app.contractVersion');
  console.log('');
  console.log('  node scripts/seed-config-app.cjs --help     # cette aide');
  console.log('  node scripts/seed-config-app.cjs --dry-run  # SIMULATION');
  console.log('  node scripts/seed-config-app.cjs            # ECRITURE REELLE');
  console.log('');
  console.log('Valeur cible : contractVersion = ' + EXPECTED_CONTRACT_VERSION);
  console.log('Projet       : ' + PROJECT_ID);
  console.log('');
  process.exit(0);
}

const app = initializeApp({
  projectId: PROJECT_ID,
  credential: applicationDefault(),
});

const db = getFirestore(app);

function describe(v) {
  return v === undefined ? '(absent)' : JSON.stringify(v);
}

(async () => {
  const ref = db.collection('config').doc('app');

  console.log('======================================================');
  console.log(' seed config/app - projet ' + PROJECT_ID);
  console.log(' mode : ' + (DRY_RUN ? 'SIMULATION' : 'ECRITURE REELLE'));
  console.log('======================================================');

  const before = await ref.get();
  const beforeData = before.exists ? (before.data() || {}) : null;

  console.log('');
  console.log('--- AVANT ---');
  if (!before.exists) {
    console.log('  document        : ABSENT');
    console.log('  contractVersion : (absent)');
  } else {
    console.log('  document        : present');
    console.log('  contractVersion : ' + describe(beforeData.contractVersion));
    console.log('  autres champs   : ' + (Object.keys(beforeData).join(', ') || '(aucun)'));
  }
  console.log('  valeur cible    : ' + JSON.stringify(EXPECTED_CONTRACT_VERSION));

  const alreadyOk = before.exists &&
    String(beforeData.contractVersion || '') === EXPECTED_CONTRACT_VERSION;

  if (alreadyOk) {
    console.log('');
    console.log('  => Deja conforme. Rien a ecrire.');
    console.log('     Si upload echoue encore, cause ailleurs (token, bucket, CORS).');
    return;
  }

  console.log('');
  console.log('--- ACTION ---');
  if (!before.exists) {
    console.log('  Creation du document config/app.');
  } else {
    console.log('  Mise a jour : ' + describe(beforeData.contractVersion) +
      ' -> ' + JSON.stringify(EXPECTED_CONTRACT_VERSION));
  }

  if (DRY_RUN) {
    console.log('');
    console.log('  [simulation] Aucune ecriture. Relancez sans --dry-run.');
    return;
  }

  await ref.set({ contractVersion: EXPECTED_CONTRACT_VERSION }, { merge: true });

  const after = await ref.get();
  const afterData = after.exists ? (after.data() || {}) : {};

  console.log('');
  console.log('--- APRES ---');
  console.log('  document        : ' + (after.exists ? 'present' : 'ABSENT'));
  console.log('  contractVersion : ' + describe(afterData.contractVersion));
  console.log('  autres champs   : ' + (Object.keys(afterData).join(', ') || '(aucun)'));

  console.log('');
  if (String(afterData.contractVersion || '') === EXPECTED_CONTRACT_VERSION) {
    console.log('  OK : config/app.contractVersion = ' + JSON.stringify(afterData.contractVersion));
  } else {
    console.log('  ECHEC : valeur relue incorrecte.');
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('');
  console.error('ERREUR : ' + (err && err.message ? err.message : err));
  if (err && /default credentials|Unable to detect a Project Id/i.test(err.message || '')) {
    console.error('');
    console.error('Credentials introuvables :');
    console.error('  1) gcloud auth application-default login');
    console.error('  2) GOOGLE_APPLICATION_CREDENTIALS=chemin\\serviceAccount.json');
  }
  process.exit(1);
});
