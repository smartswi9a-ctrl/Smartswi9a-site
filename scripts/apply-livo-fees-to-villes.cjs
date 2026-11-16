#!/usr/bin/env node
/* ============================================================
   CORRECTIF : villes.json -> prix exacts Livo (sans marge)
   ------------------------------------------------------------
   villes.json est le FALLBACK de loadCities() (js/utils.js:876-955).
   Il doit porter les MEMES prix que Livo, sinon un client voit un
   tarif different selon que Firestore repond ou non.

   CORRECTIF C10 (audit 2026-11-16) : la premiere version ne matchait
   que sur egalite stricte de la cle. 105 villes restaient a 30 DH
   parce que Livo utilise des libelles differents. On reprend donc la
   MEME logique tolerante que functions/index.js (looseKey + prefixe
   borne), en refusant les faux positifs.

   Les villes sans correspondance fiable sont CONSERVEES telles quelles
   et listees : aucun prix n est devine.

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

const MIN_PREFIX = 8;

function normalizeKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function looseKey(raw) {
  return normalizeKey(raw).replace(/[^a-z0-9]/g, '');
}

/* Marqueurs qui designent un LIEU DIFFERENT et non une variante
   orthographique. Present d un seul cote => pas de prefixe. */
const DISTINCT_MARKERS = [
  'sidi', 'oulad', 'ouled', 'ait', 'bir', 'dar', 'souk', 'sebt', 'ksar',
  'el', 'al', 'ain', 'jorf', 'bou', 'ben', 'bni', 'zaouiat', 'zaouyat'
];

function hasDistinctMarker(a, b) {
  const wa = new Set(normalizeKey(a).split(' ').filter(Boolean));
  const wb = new Set(normalizeKey(b).split(' ').filter(Boolean));
  for (const m of DISTINCT_MARKERS) {
    if (wa.has(m) !== wb.has(m)) return true;
  }
  return false;
}

/* CORRECTIF C10 : alias verifies a la main (audit 2026-11-16).
   Cle = cle de villes.json, valeur = cle exacte dans la grille Livo.
   Uniquement des cas OU la correspondance est certaine. Les villes
   reellement absentes de Livo (lahraouiyine, khemisset, berrechid,
   sidi slimane, ain harouda, el jorf, bejaad...) ne sont PAS listees :
   leur prix doit etre arbitre commercialement, pas invente. */
const MANUAL_ALIASES = {
  'errahma': 'errahma',
  'errahma ville': 'errahma',
  'fquih ben salah': 'fkih ben salah',
  'souk el arbaa': 'souk el arbaa du gharb',
  'settat': 'settat - sidi hajaj'
};

function main() {
  if (!fs.existsSync(FEES_JSON)) {
    console.error('ECHEC: ' + FEES_JSON + ' introuvable. Lancer scripts/import-livo-fees.cjs');
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(FEES_JSON, 'utf8'));
  const villes = JSON.parse(fs.readFileSync(VILLES_JSON, 'utf8'));

  const byExact = new Map();
  const byLoose = new Map();
  for (const c of snapshot.cities) {
    const fee = Number(c.fee);
    const nk = normalizeKey(c.key || c.name);
    const lk = looseKey(c.key || c.name);
    if (nk && !byExact.has(nk)) byExact.set(nk, { fee, ref: c.key });
    if (lk && !byLoose.has(lk)) byLoose.set(lk, { fee, ref: c.key });
  }

  function match(v) {
    /* 0) Alias manuel explicite. */
    for (const cand of [v.key, v.nameFr].filter(Boolean)) {
      const nk = normalizeKey(cand);
      if (nk && MANUAL_ALIASES[nk] && byExact.has(normalizeKey(MANUAL_ALIASES[nk]))) {
        return { ...byExact.get(normalizeKey(MANUAL_ALIASES[nk])), how: 'alias' };
      }
    }
    for (const cand of [v.key, v.nameFr, v.nameEn].filter(Boolean)) {
      const nk = normalizeKey(cand);
      if (nk && byExact.has(nk)) return { ...byExact.get(nk), how: 'exact' };
    }
    for (const cand of [v.key, v.nameFr, v.nameEn].filter(Boolean)) {
      const lk = looseKey(cand);
      if (lk && byLoose.has(lk)) return { ...byLoose.get(lk), how: 'loose' };
    }
    let best = null;
    for (const cand of [v.key, v.nameFr].filter(Boolean)) {
      const lk = looseKey(cand);
      if (!lk || lk.length < MIN_PREFIX) continue;
      for (const [lkLivo, info] of byLoose) {
        if (lkLivo.length < MIN_PREFIX) continue;
        if (!(lk.startsWith(lkLivo) || lkLivo.startsWith(lk))) continue;
        const shorter = Math.min(lk.length, lkLivo.length);
        const longer = Math.max(lk.length, lkLivo.length);
        if (shorter / longer < 0.75) continue;
        if (hasDistinctMarker(cand, info.ref)) continue;
        if (!best || lkLivo.length > looseKey(best.ref).length) best = { ...info, how: 'prefix' };
      }
    }
    return best;
  }

  let changed = 0, same = 0;
  const unmatched = [];
  const details = [];

  for (const v of villes) {
    const m = match(v);
    if (!m) { unmatched.push(v); continue; }
    const before = Number(v.price);
    if (before === m.fee) { same++; continue; }
    if (WRITE) v.price = m.fee;
    changed++;
    if (details.length < 20) details.push({ ville: v.nameFr || v.key, before, after: m.fee, how: m.how, ref: m.ref });
  }

  if (WRITE) fs.writeFileSync(VILLES_JSON, JSON.stringify(villes, null, 2) + '\n', 'utf8');

  console.log('============================================================');
  console.log(' APPLY LIVO FEES -> villes.json' + (WRITE ? '  [ECRITURE]' : '  [SIMULATION]'));
  console.log('============================================================');
  console.log('villes.json         : ' + villes.length);
  console.log('grille Livo         : ' + snapshot.cities.length);
  console.log('prix modifies       : ' + changed);
  console.log('deja corrects       : ' + same);
  console.log('sans correspondance : ' + unmatched.length);
  console.log('');

  if (details.length) {
    console.log('--- Echantillon ---');
    for (const d of details) {
      console.log('  ' + String(d.ville).padEnd(24) + String(d.before).padStart(3) + ' -> ' + String(d.after).padStart(3) + ' DH  (' + d.how + ')');
    }
    console.log('');
  }

  if (unmatched.length) {
    console.log('--- Sans correspondance (prix CONSERVE) : ' + unmatched.length + ' ---');
    for (const u of unmatched.slice(0, 25)) {
      console.log('  ' + String(u.nameFr || u.key).padEnd(26) + 'key=' + u.key + '  prix=' + u.price);
    }
    if (unmatched.length > 25) console.log('  ... et ' + (unmatched.length - 25) + ' autres');
  }

  if (!WRITE) console.log('\nSIMULATION — relancer avec --write pour appliquer.');
}

main();
