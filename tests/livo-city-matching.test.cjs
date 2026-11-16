#!/usr/bin/env node
/* ============================================================
   TEST DE LA LOGIQUE DE RAPPROCHEMENT DES VILLES (correctif C3)
   ------------------------------------------------------------
   Reproduit findExisting()/looseCityKey() de functions/index.js et
   verifie les cas constates en production le 2026-11-16.

   Aucun acces reseau ni Firestore : la logique est recopiee ici a
   l'identique. Si elle change dans index.js, mettre ce test a jour.

   Usage : node tests/livo-city-matching.test.cjs
   ============================================================ */
'use strict';

const assert = require('assert');

/* --- Copie de normalizeCityKey (functions/index.js) --- */
function normalizeCityKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const MIN_PREFIX = 8;

function looseCityKey(raw) {
  return normalizeCityKey(raw).replace(/[^a-z0-9]/g, '');
}

/* Construit l'index comme le fait syncLivoCitiesFromApi. */
function buildIndex(existingDocs) {
  const byKey = new Map();
  const byLoose = new Map();
  const list = [];
  for (const d of existingDocs) {
    const key = normalizeCityKey(d.key || d.nameFr || '');
    const loose = looseCityKey(d.key || d.nameFr || '');
    const entry = { id: d.id, key: d.key };
    if (key) byKey.set(key, entry);
    if (loose) {
      if (!byLoose.has(loose)) byLoose.set(loose, entry);
      list.push({ loose, entry });
    }
  }
  return { byKey, byLoose, list };
}

function findExisting(index, livoKey) {
  const strict = index.byKey.get(livoKey);
  if (strict) return strict;
  const loose = looseCityKey(livoKey);
  if (!loose) return null;
  const byLoose = index.byLoose.get(loose);
  if (byLoose) return byLoose;
  if (loose.length >= MIN_PREFIX) {
    let best = null;
    for (const cand of index.list) {
      if (cand.loose.length < MIN_PREFIX) continue;
      const isPrefix = loose.startsWith(cand.loose) || cand.loose.startsWith(loose);
      if (!isPrefix) continue;
      const shorter = Math.min(loose.length, cand.loose.length);
      const longer = Math.max(loose.length, cand.loose.length);
      if (shorter / longer < 0.75) continue;
      if (!best || cand.loose.length > best.loose.length) best = cand;
    }
    if (best) return best.entry;
  }
  return null;
}

/* --- Jeu de donnees reel (documents observes en production) --- */
const EXISTING = [
  { id: '19', key: 'sidi slimane' },
  { id: '108', key: 'bni bouayach' },
  { id: '109', key: 'ajdir' },
  { id: '2', key: 'lahraouiyine' },
  { id: '1', key: 'casablanca' },
  { id: '10', key: 'dar bouazza' },
  { id: '11', key: 'sidi rahhal' },
  { id: 'city_sidi_sliman', key: 'sidi sliman' },
  { id: 'city_ajdir_al_hoceima', key: 'ajdir al hoceima' },
  { id: 'city_bni_bouayach_al_hoceima', key: 'bni bouayach al hoceima' }
];

const index = buildIndex(EXISTING);

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log('PASS: ' + name); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log('FAIL: ' + name + ' -> ' + e.message); }
}

check('M1 : "casablanca" -> document exact existant', () => {
  const r = findExisting(index, 'casablanca');
  assert.ok(r, 'doit trouver un document');
  assert.strictEqual(r.id, '1');
});

check('M2 : "sidi sliman" (Livo) rapproche "sidi slimane" (legacy) par prefixe', () => {
  const r = findExisting(index, 'sidi sliman');
  assert.ok(r, 'doit trouver un document');
  assert.ok(r.id === '19' || r.id === 'city_sidi_sliman',
    'doit cibler un des deux documents sidi sliman(e), recu: ' + r.id);
});

check('M3 : "ajdir al hoceima" (Livo) rapproche "ajdir" (legacy)', () => {
  const r = findExisting(index, 'ajdir al hoceima');
  assert.ok(r, 'doit trouver un document');
  assert.ok(r.id === '109' || r.id === 'city_ajdir_al_hoceima',
    'doit cibler ajdir, recu: ' + r.id);
});

check('M4 : "bni bouayach al hoceima" (Livo) rapproche "bni bouayach" (legacy)', () => {
  const r = findExisting(index, 'bni bouayach al hoceima');
  assert.ok(r, 'doit trouver un document');
  assert.ok(r.id === '108' || r.id === 'city_bni_bouayach_al_hoceima',
    'doit cibler bni bouayach, recu: ' + r.id);
});

check('M5 : "lahraouiyine" (absent de Livo) -> document conserve, non supprime', () => {
  const r = findExisting(index, 'lahraouiyine');
  assert.ok(r, 'le document legacy doit etre retrouve par cle exacte');
  assert.strictEqual(r.id, '2');
});

check('M6 : villes distinctes non fusionnees (dar bouazza vs sidi rahhal)', () => {
  const a = findExisting(index, 'dar bouazza');
  const b = findExisting(index, 'sidi rahhal');
  assert.notStrictEqual(a.id, b.id, 'deux villes differentes ne doivent pas partager un id');
});

check('M7 : ville inconnue -> null (creation attendue)', () => {
  const r = findExisting(index, 'ville totalement inedite xyz');
  assert.strictEqual(r, null);
});

check('M8 : prefixe trop court ignore (bir jdid / bir)', () => {
  const small = buildIndex([{ id: 'X', key: 'bir' }]);
  const r = findExisting(small, 'bir jdid');
  assert.strictEqual(r, null, 'un prefixe < MIN_PREFIX ne doit pas fusionner');
});

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' verifications PASS');
if (failed.length) {
  console.log('ECHECS: ' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
