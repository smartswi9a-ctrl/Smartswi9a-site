#!/usr/bin/env node
/* ============================================================
   scripts/vapid-activate.cjs
   ------------------------------------------------------------
   Injecte la clé publique VAPID (Firebase Cloud Messaging →
   « Web Push certificates ») dans js/config.js : PWA_CONFIG.VAPID_KEY.

   Firebase n'expose pas cette clé via API/CLI : elle se copie une
   fois depuis la console. Ce script évite toute faute de frappe et
   valide le format avant écriture.

   Usage :
     node scripts/vapid-activate.cjs "BExxxxxxxxxxxxxxxxxxxxxxxxx..."
     VAPID_KEY="B..." node scripts/vapid-activate.cjs
   ============================================================ */
const fs = require('fs');
const path = require('path');

const key = String(process.argv[2] || process.env.VAPID_KEY || '').trim();

if (!key) {
  console.error('Usage : node scripts/vapid-activate.cjs "BExxxxxxxxx..." (clé publique VAPID)');
  process.exit(1);
}

/* Clé publique VAPID = point P-256 non compressé, base64url, ~87 caractères. */
if (!/^B[A-Za-z0-9_-]{80,100}$/.test(key)) {
  console.error('Clé invalide : elle doit commencer par « B » et faire 81 à 101 caractères base64url.');
  process.exit(2);
}

const file = path.join(__dirname, '..', 'js', 'config.js');
let source = fs.readFileSync(file, 'utf8');

if (!/VAPID_KEY:\s*'[^']*'/.test(source)) {
  console.error('Bloc PWA_CONFIG.VAPID_KEY introuvable dans js/config.js.');
  process.exit(3);
}

source = source.replace(/VAPID_KEY:\s*'[^']*'/, `VAPID_KEY: '${key}'`);
fs.writeFileSync(file, source, 'utf8');

console.log('OK : clé VAPID injectée dans js/config.js (PWA_CONFIG.VAPID_KEY).');
console.log('Étape suivante : déployer le hosting (firebase deploy --only hosting) puis recharger le site.');
console.log('Vérification navigateur : window.smartswikaEnablePush() doit renvoyer { ok: true }.');
