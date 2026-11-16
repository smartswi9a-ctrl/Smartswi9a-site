#!/usr/bin/env node
/* ============================================================
   IMPORT : grille tarifaire publique Livo -> fichier local
   ------------------------------------------------------------
   Recupere GET https://rest.livo.ma/fees/public (endpoint public,
   aucune cle API requise) et l'enregistre dans
   docs/livo/fees-livo.json sous une forme stable et versionnable.

   Pourquoi un fichier local plutot qu'un appel a chaque fois :
   - l'audit et les tests doivent rester reproductibles hors ligne ;
   - on peut differ (git diff) ce qui a change chez Livo entre deux syncs.

   Format en sortie :
   {
     "source": "https://rest.livo.ma/fees/public",
     "fetched_at": "<ISO>",
     "request_date": "<valeur brute renvoyee par Livo>",
     "count": <int>,
     "cities": [ { "key": "<slug minuscule>", "name": "<libelle Livo>", "fee": <int> } ]
   }

   Usage : node scripts/import-livo-fees.cjs
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'livo');
const OUT_FILE = path.join(OUT_DIR, 'fees-livo.json');
const LIVO_FEES_URL = 'https://rest.livo.ma/fees/public';

/* Normalise un libelle Livo en cle stable : minuscules, espaces compresses. */
function toKey(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

async function main() {
  const res = await fetch(LIVO_FEES_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    console.error('ECHEC: /fees/public a repondu ' + res.status);
    process.exit(1);
  }

  const payload = await res.json();
  const data = payload?.data?.data;
  const fees = data?.order_fees;

  if (!Array.isArray(fees)) {
    console.error('ECHEC: order_fees absent de la reponse.');
    process.exit(1);
  }

  const seen = new Set();
  const cities = [];
  for (const f of fees) {
    if (!f || typeof f.city !== 'string') continue;
    const key = toKey(f.city);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const fee = Number(f.fee);
    cities.push({ key, name: f.city.trim(), fee: Number.isFinite(fee) ? fee : 0 });
  }

  cities.sort((a, b) => a.key.localeCompare(b.key, 'fr'));

  const out = {
    source: LIVO_FEES_URL,
    fetched_at: new Date().toISOString(),
    request_date: data.request_date || null,
    count: cities.length,
    cities
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');

  const byFee = cities.reduce((acc, c) => { acc[c.fee] = (acc[c.fee] || 0) + 1; return acc; }, {});
  console.log('OK: ' + cities.length + ' villes ecrites dans ' + path.relative(path.join(__dirname, '..'), OUT_FILE));
  console.log('   ' + Object.keys(byFee).sort((a, b) => a - b).map((k) => k + ' DH=' + byFee[k]).join(' | '));
  console.log('   fetched_at = ' + out.fetched_at);
}

main().catch((e) => { console.error('ERREUR: ' + e.message); process.exit(1); });
