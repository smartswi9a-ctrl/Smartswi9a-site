#!/usr/bin/env node
/* ============================================================
   AUDIT : coherence tarifs Livo <-> villes.json du site
   ------------------------------------------------------------
   Compare la grille publique Livo (GET /fees/public, sans cle API)
   avec les prix affiches aux clients dans villes.json.

   Un ecart positif = le site facture PLUS cher que le cout reel Livo
   (marge ou erreur). Un ecart negatif = le site facture MOINS cher
   que le cout Livo -> perte seche sur chaque commande.

   Usage : node scripts/audit-livo-fees.cjs
   Aucune ecriture : lecture seule, aucune dependance externe.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const SITE_ROOT = path.join(__dirname, '..');
const VILLES_JSON = path.join(SITE_ROOT, 'villes.json');
const LIVO_FEES_URL = 'https://rest.livo.ma/fees/public';

async function main() {
  const res = await fetch(LIVO_FEES_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    console.error('ECHEC: /fees/public a repondu ' + res.status);
    process.exit(1);
  }
  const payload = await res.json();
  const fees = payload?.data?.data?.order_fees;
  if (!Array.isArray(fees)) {
    console.error('ECHEC: structure de reponse inattendue (order_fees absent).');
    process.exit(1);
  }

  const livo = new Map();
  for (const f of fees) {
    if (!f || typeof f.city !== 'string') continue;
    livo.set(f.city.trim().toLowerCase(), Number(f.fee));
  }

  const villes = JSON.parse(fs.readFileSync(VILLES_JSON, 'utf8'));
  if (!Array.isArray(villes)) {
    console.error('ECHEC: villes.json n\'est pas un tableau.');
    process.exit(1);
  }

  const same = [];
  const gaps = [];
  const missing = [];

  for (const v of villes) {
    const key = String(v.key || '').toLowerCase();
    if (!livo.has(key)) { missing.push(v); continue; }
    const sitePrice = Number(v.price);
    const livoPrice = livo.get(key);
    if (sitePrice === livoPrice) same.push(v);
    else gaps.push({ ville: v.nameFr || v.key, key, site: sitePrice, livo: livoPrice, ecart: sitePrice - livoPrice });
  }

  const under = gaps.filter((g) => g.ecart < 0);
  const over = gaps.filter((g) => g.ecart > 0);

  console.log('============================================================');
  console.log(' AUDIT TARIFS  Livo <-> site  (' + new Date().toISOString() + ')');
  console.log('============================================================');
  console.log('Villes dans villes.json : ' + villes.length);
  console.log('Villes dans Livo        : ' + livo.size);
  console.log('  identiques            : ' + same.length);
  console.log('  ecarts                : ' + gaps.length + '  (sous-facture: ' + under.length + ', sur-facture: ' + over.length + ')');
  console.log('  absentes de Livo      : ' + missing.length);
  console.log('');

  if (under.length) {
    console.log('--- CRITIQUE : site MOINS cher que Livo (perte seche) ---');
    for (const g of under.sort((a, b) => a.ecart - b.ecart).slice(0, 30)) {
      console.log('  ' + String(g.ville).padEnd(22) + ' site=' + String(g.site).padStart(3) + '  livo=' + String(g.livo).padStart(3) + '  ecart=' + g.ecart);
    }
    console.log('');
  }

  if (over.length) {
    console.log('--- Site PLUS cher que Livo (marge / arrondi) ---');
    for (const g of over.sort((a, b) => b.ecart - a.ecart).slice(0, 30)) {
      console.log('  ' + String(g.ville).padEnd(22) + ' site=' + String(g.site).padStart(3) + '  livo=' + String(g.livo).padStart(3) + '  ecart=+' + g.ecart);
    }
    console.log('');
  }

  if (missing.length) {
    console.log('--- Villes du site absentes de la grille Livo ---');
    for (const m of missing.slice(0, 30)) console.log('  ' + (m.nameFr || m.key) + '  (key=' + m.key + ', prix site=' + m.price + ')');
    if (missing.length > 30) console.log('  ... et ' + (missing.length - 30) + ' autres');
    console.log('');
  }

  const livoOnly = [...livo.keys()].filter((k) => !villes.some((v) => String(v.key).toLowerCase() === k));
  console.log('Villes Livo non proposees sur le site : ' + livoOnly.length);
  if (livoOnly.length) console.log('  ex: ' + livoOnly.slice(0, 12).join(', '));
}

main().catch((e) => { console.error('ERREUR: ' + e.message); process.exit(1); });
