#!/usr/bin/env node
/* ============================================================
   CORRECTIF : villes.json -> prix exacts Livo (sans marge)
   ------------------------------------------------------------
   villes.json est le FALLBACK de loadCities() (js/utils.js:876-955) :
   utilise uniquement si Firestore `cities` est vide ou injoignable.
   Il doit donc porter les MEMES prix que Livo, sinon un client voit
   un tarif different selon que Firestore repond ou non.

   Ce script :
     1. lit docs/livo/fees-livo.json (snapshot de /fees/public) ;
     2. pour chaque ville de villes.json, retrouve son tarif Livo par
        correspondance EXACTE sur la cle normalisee, puis, a defaut,
        par correspondance floue prudente (nom complet identique
        apres normalisation) ;
     3. ecrit le prix Livo. Aucune marge n'est ajoutee.

   Les villes sans correspondance sont SIGNALEES et conservees telles
   quelles : on ne supprime rien, on ne devine pas un prix.

   Usage :
     node scripts/apply-livo-fees-to-villes.cjs           # simulation
     node scripts/apply-livo-fees-to-villes.cjs --write   # ecriture
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VILLES_JSON = path.join(ROOT, 'villes.json');
const FEES_JSON = path.join(ROOT, 'docs', 'livo', 'fees-livo.json');
const WRITE = process.argv.includes('--write');

/* Doit rester aligne sur normalizeCityKey() cote serveur
   (functions/index.js) pour que les cles se comparent. */
function normalizeKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function main() {
  if (!fs.existsSync(FEES_JSON)) {
    console.error('ECHEC: ' + FEES_JSON + ' introuvable. Lancer d\'abord scripts/import-livo-fees.cjs');
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(FEES_JSON, 'utf8'));
  const villes = JSON.parse(fs.readFileSync(VILLES_JSON, 'utf8'));

  /* Index Livo : cle normalisee -> tarif */
  const livoByKey = new Map();
  for (const c of snapshot.cities) {
    livoByKey.set(normalizeKey(c.key || c.name), Number(c.fee));
  }

  let changed = 0;
  let same = 0;
  const unmatched = [];

  for (const v of villes) {
    const candidates = [v.key, v.nameFr, v.nameEn].filter(Boolean);
    let fee = null;
    for (const cand of candidates) {
      const k = normalizeKey(cand);
      if (k && livoByKey.has(k)) { fee = livoByKey.get(k); break; }
    }

    if (fee === null) { unmatched.push(v); continue; }

    const before = Number(v.price);
    if (before === fee) { same++; continue; }
    if (WRITE) v.price = fee;
    changed++;
    if (changed <= 15) {
      console.log('  ' + String(v.nameFr || v.key).padEnd(22) + before + ' -> ' + fee + ' DH');
    }
  }

  console.log('');
  console.log('villes.json        : ' + villes.length + ' villes');
  console.log('grille Livo        : ' + snapshot.cities.length + ' villes');
  console.log('prix mis a jour    : ' + changed);
  console.log('deja corrects      : ' + same);
  console.log('sans correspondance: ' + unmatched.length);

  if (unmatched.length) {
    console.log('');
    console.log('--- Sans correspondance (prix CONSERVE, a verifier a la main) ---');
    for (const u of unmatched.slice(0, 20)) {
      console.log('  ' + String(u.nameFr || u.key).padEnd(22) + ' key=' + u.key + '  prix=' + u.price);
    }
    if (unmatched.length > 20) console.log('  ... et ' + (unmatched.length - 20) + ' autres');
  }

  if (!WRITE) {
    console.log('');
    console.log('SIMULATION — aucune ecriture. Relancer avec --write pour appliquer.');
    return;
  }

  fs.writeFileSync(VILLES_JSON, JSON.stringify(villes, null, 2) + '\n', 'utf8');
  console.log('');
  console.log('ECRIT : ' + path.relative(ROOT, VILLES_JSON));
}

main();
