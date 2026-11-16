#!/usr/bin/env node
/* ============================================================
   PURGE Firestore `cities` : ne garder que les villes Livo
   ------------------------------------------------------------
   Decision produit (2026-11-16) : le site ne propose que les villes
   desservies par Livo. Ce script supprime de `cities` tout document
   qui ne correspond a aucune ville de docs/livo/fees-livo.json.

   SECURITE :
     - mode simulation par defaut, ecriture uniquement avec --write ;
     - les commandes (`orders`) embarquent un snapshot de la ville
       (delivery.city / cityFr / cityId) : les supprimer ne casse
       aucun historique. On verifie quand meme ci-dessous ;
     - si un document est reference par une commande existante, il est
       CONSERVE et signale (sauf --force).

   Prerequis : firebase-admin + credentials (GOOGLE_APPLICATION_CREDENTIALS
   ou `firebase login`).

   Usage :
     node scripts/purge-non-livo-cities.cjs            # simulation
     node scripts/purge-non-livo-cities.cjs --write    # suppression
     node scripts/purge-non-livo-cities.cjs --write --force
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FEES_JSON = path.join(ROOT, 'docs', 'livo', 'fees-livo.json');
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

function normalizeKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function main() {
  if (!fs.existsSync(FEES_JSON)) {
    console.error('ECHEC: ' + FEES_JSON + ' introuvable.');
    process.exit(1);
  }
  const snapshot = JSON.parse(fs.readFileSync(FEES_JSON, 'utf8'));
  const livoKeys = new Set(snapshot.cities.map(c => normalizeKey(c.key || c.name)));

  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'smartswi9a-31063' });
  const db = getFirestore();

  const citiesSnap = await db.collection('cities').get();
  const ordersSnap = await db.collection('orders').get();

  /* Ids de villes references par des commandes existantes. */
  const referenced = new Set();
  for (const o of ordersSnap.docs) {
    const d = o.data() || {};
    const dv = d.delivery || {};
    if (dv.cityId != null) referenced.add(String(dv.cityId));
  }

  const toDelete = [];
  const kept = [];

  for (const doc of citiesSnap.docs) {
    const data = doc.data() || {};
    const nk = normalizeKey(data.key || data.nameFr || '');
    if (nk && livoKeys.has(nk)) { kept.push(doc.id); continue; }
    if (referenced.has(String(data.id)) && !FORCE) {
      kept.push(doc.id + ' (reference par une commande)');
      continue;
    }
    toDelete.push({ id: doc.id, ref: doc.ref, key: data.key, nameFr: data.nameFr, price: data.price });
  }

  console.log('============================================================');
  console.log(' PURGE cities HORS LIVO' + (WRITE ? '  [ECRITURE]' : '  [SIMULATION]'));
  console.log('============================================================');
  console.log('grille Livo        : ' + snapshot.cities.length);
  console.log('documents cities   : ' + citiesSnap.docs.length);
  console.log('commandes lues     : ' + ordersSnap.docs.length);
  console.log('villes conservees  : ' + kept.length);
  console.log('villes a supprimer : ' + toDelete.length);
  console.log('');

  if (toDelete.length) {
    console.log('--- Echantillon des suppressions ---');
    for (const d of toDelete.slice(0, 25)) {
      console.log('  ' + String(d.id).padEnd(28) + 'key=' + String(d.key).padEnd(24) + String(d.price) + ' DH');
    }
    if (toDelete.length > 25) console.log('  ... et ' + (toDelete.length - 25) + ' autres');
    console.log('');
  }

  if (!WRITE) {
    console.log('SIMULATION — relancer avec --write pour supprimer.');
    return;
  }

  const BATCH = 400;
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const batch = db.batch();
    toDelete.slice(i, i + BATCH).forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += Math.min(BATCH, toDelete.length - i);
    console.log('  supprime ' + deleted + '/' + toDelete.length);
  }
  console.log('');
  console.log('TERMINE : ' + deleted + ' documents supprimes.');
}

main().catch((e) => { console.error('ERREUR: ' + e.message); process.exit(1); });
