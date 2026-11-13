'use strict';

const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));

const EXPECTED_CONTRACT_VERSION = '1.5.0';
const PROJECT_ID = 'smartswi9a-31063';
const DRY_RUN = process.argv.includes('--dry-run');

admin.initializeApp({
  projectId: PROJECT_ID,
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();

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
