#!/usr/bin/env node
/* ============================================================
   REMPLACEMENT TOTAL : villes.json = grille Livo, telle quelle
   ------------------------------------------------------------
   Decision produit (2026-11-16) : le site ne doit proposer QUE les
   villes reellement desservies par Livo. Toute ville de villes.json
   absente de la grille Livo est SUPPRIMEE du fichier.

   Source de verite : docs/livo/fees-livo.json (snapshot de
   GET https://rest.livo.ma/fees/public, 404 villes).

   Sortie : villes.json reconstruit a partir de Livo, avec
     - id     : identifiant numerique stable (reutilise celui du
                document existant s il y a lieu, sinon attribue) ;
     - key    : cle normalisee Livo ;
     - nameFr/nameEn/nameAr : libelle Livo (les noms arabes des villes
                conservees sont repris du fichier actuel quand ils
                existent, pour ne pas perdre la traduction) ;
     - price  : tarif Livo exact, sans marge ;
     - delay  : conserve du fichier actuel si present, sinon 48h.

   Les villes conservees gardent leur `id` d origine : les commandes
   passees qui referencent cities/<id> restent valides.

   Usage :
     node scripts/rebuild-villes-from-livo.cjs           # simulation
     node scripts/rebuild-villes-from-livo.cjs --write   # ecriture
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

/* Alias verifies a la main (audit 2026-11-16) : cle actuelle -> cle Livo.
   Le script teste l alias dans les deux sens, pour que ni la ville Livo ni
   la ville actuelle ne soit ecartee a tort. Uniquement des cas certains :
   les villes reellement absentes de Livo ne sont PAS listees. */
const MANUAL_ALIASES = {
  'errahma': 'errahma',
  'errahma ville': 'errahma',
  'fquih ben salah': 'fkih ben salah',
  'souk el arbaa': 'souk el arbaa du gharb',
  'settat': 'settat - sidi hajaj',
  /* Livo ecrit "sidi sliman" (sans e) ; la ville actuelle "sidi slimane". */
  'sidi slimane': 'sidi sliman',
  'el kelaa des sraghna': 'kelaa des sraghna',
  'sebt el guerdane': 'sebt lguerdan',
  'imi oudadr': 'imi ouaddar',
  'tamesloht': 'tamesluht'
};

function main() {
  if (!fs.existsSync(FEES_JSON)) {
    console.error('ECHEC: ' + FEES_JSON + ' introuvable. Lancer scripts/import-livo-fees.cjs');
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(FEES_JSON, 'utf8'));
  const current = JSON.parse(fs.readFileSync(VILLES_JSON, 'utf8'));

  /* Index du fichier actuel : on cherche a quel document existant chaque
     ville Livo correspond, pour lui conserver son id / son nom arabe. */
  const curByExact = new Map();
  const curByLoose = new Map();
  const curList = [];
  for (const v of current) {
    const nk = normalizeKey(v.key || v.nameFr);
    const lk = looseKey(v.key || v.nameFr);
    if (nk) curByExact.set(nk, v);
    if (lk) {
      if (!curByLoose.has(lk)) curByLoose.set(lk, v);
      curList.push({ lk, v });
    }
  }

  function findCurrent(livoKey) {
    const nk = normalizeKey(livoKey);

    /* 1) La ville Livo porte un alias manuel vers une cle actuelle. */
    const aliasTarget = MANUAL_ALIASES[nk];
    if (aliasTarget && curByExact.has(normalizeKey(aliasTarget))) {
      return curByExact.get(normalizeKey(aliasTarget));
    }
    if (curByExact.has(nk)) return curByExact.get(nk);

    /* 2) Une cle actuelle porte un alias manuel vers cette ville Livo
       (ex. "souk el arbaa" -> "souk el arbaa du gharb").
       Sans cette passe inverse, la ville actuelle serait ecartee alors
       qu elle EST desservie. */
    for (const [curKey, target] of Object.entries(MANUAL_ALIASES)) {
      if (normalizeKey(target) === nk && curByExact.has(normalizeKey(curKey))) {
        return curByExact.get(normalizeKey(curKey));
      }
    }

    const lk = looseKey(livoKey);
    if (!lk) return null;
    if (curByLoose.has(lk)) return curByLoose.get(lk);

    if (lk.length < MIN_PREFIX) return null;
    let best = null;
    for (const c of curList) {
      if (c.lk.length < MIN_PREFIX) continue;
      if (!(lk.startsWith(c.lk) || c.lk.startsWith(lk))) continue;
      const shorter = Math.min(lk.length, c.lk.length);
      const longer = Math.max(lk.length, c.lk.length);
      if (shorter / longer < 0.75) continue;
      if (hasDistinctMarker(livoKey, c.v.key || c.v.nameFr)) continue;
      if (!best || c.lk.length > best.lk.length) best = c;
    }
    return best ? best.v : null;
  }

  /* Attribution des ids : on reutilise ceux du fichier actuel, puis on
     complete a partir de maxId+1 pour les villes Livo sans equivalent. */
  let maxId = 0;
  for (const v of current) {
    const n = Number(v.id) || 0;
    if (n > maxId) maxId = n;
  }
  let nextId = maxId + 1;

  const usedIds = new Set();
  const rebuilt = [];
  const kept = [];

  for (const c of snapshot.cities) {
    const name = String(c.name || c.key || '').trim();
    const livoKey = normalizeKey(c.key || name);
    const existing = findCurrent(livoKey);

    let id;
    if (existing && Number(existing.id) > 0 && !usedIds.has(Number(existing.id))) {
      id = Number(existing.id);
      kept.push(existing.key || existing.nameFr);
    } else {
      while (usedIds.has(nextId)) nextId++;
      id = nextId++;
    }
    usedIds.add(id);

    const display = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    rebuilt.push({
      id,
      key: livoKey,
      nameAr: (existing && existing.nameAr) || display,
      nameFr: (existing && existing.nameFr) || display,
      nameEn: (existing && existing.nameEn) || display,
      price: Number(c.fee),
      delay: (existing && existing.delay) || '48h'
    });
  }

  rebuilt.sort((a, b) => a.id - b.id);

  const removed = current.filter(v => !rebuilt.some(r => Number(r.id) === Number(v.id) &&
    normalizeKey(r.key) === normalizeKey(v.key || v.nameFr)));

  console.log('============================================================');
  console.log(' REBUILD villes.json DEPUIS LIVO' + (WRITE ? '  [ECRITURE]' : '  [SIMULATION]'));
  console.log('============================================================');
  console.log('villes.json actuel  : ' + current.length);
  console.log('grille Livo         : ' + snapshot.cities.length);
  console.log('nouvelles villes    : ' + rebuilt.length);
  console.log('ids reutilises      : ' + kept.length);
  console.log('anciennes ecartees  : ' + (current.length - kept.length));
  console.log('');

  if (rebuilt.length) {
    console.log('--- Echantillon conserve/reconstruit ---');
    for (const r of rebuilt.slice(0, 10)) {
      console.log('  id=' + String(r.id).padStart(4) + '  ' + String(r.nameFr).padEnd(24) + r.price + ' DH');
    }
    console.log('');
  }

  if (WRITE) {
    fs.writeFileSync(VILLES_JSON, JSON.stringify(rebuilt, null, 2) + '\n', 'utf8');
    console.log('ECRIT : ' + path.relative(ROOT, VILLES_JSON));
  } else {
    console.log('SIMULATION — relancer avec --write pour appliquer.');
  }
}

main();
