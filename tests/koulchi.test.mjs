/* ============================================================
   tests/koulchi.test.mjs
   Verifie les regles du panier groupe Koulchi dialk.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");

/* CHARGEMENT DU MODULE
   Le fichier source est un module ES (export). Pour l importer en Node
   il faut que le fichier soit interprete comme module :
     - package.json declare "type": "module" (fait) ;
     - ou l extension est .mjs.
   On copie donc koulchi.js en .mjs DANS LE DOSSIER DU PROJET (et non
   dans le dossier temporaire, qui n a pas de package.json et retombe
   en CommonJS -> "Unexpected token 'export'").

   Historique des pistes ecartees, pour ne pas les retenter :
     - new Function : refuse la syntaxe module ;
     - vm.runInContext : n expose pas les declarations function ;
     - retirer `export` par regex : casse le fichier (CRLF). */

const SRC = path.join(ROOT, "js", "koulchi.js");
const TMP = path.join(ROOT, "js", "__koulchi_test_tmp.mjs");

fs.copyFileSync(SRC, TMP);

let api;
try {
  api = await import(pathToFileURL(TMP).href);
} finally {
  try { fs.unlinkSync(TMP); } catch (_) { /* ignore */ }
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log("PASS: " + name);
  } catch (e) {
    results.push({ name, ok: false });
    console.log("FAIL: " + name + " -> " + e.message);
  }
}


/* --------------------------------------------- K1 */
console.log("\n--- K1 : validation du prix de groupe ---");

check("K1a : 189 < 199 -> valide", () => {
  assert.strictEqual(api.isValidKoulchiPrice(189, 199), true);
});

check("K1b : egal au prix normal -> refuse", () => {
  assert.strictEqual(api.isValidKoulchiPrice(199, 199), false);
});

check("K1c : superieur (250 > 199) -> refuse", () => {
  assert.strictEqual(api.isValidKoulchiPrice(250, 199), false);
});

check("K1d : 0 ou negatif -> refuse", () => {
  assert.strictEqual(api.isValidKoulchiPrice(0, 199), false);
  assert.strictEqual(api.isValidKoulchiPrice(-5, 199), false);
});

check("K1e : absents ou non numeriques -> refuse (fail-closed)", () => {
  assert.strictEqual(api.isValidKoulchiPrice(null, 199), false);
  assert.strictEqual(api.isValidKoulchiPrice(undefined, 199), false);
  assert.strictEqual(api.isValidKoulchiPrice("abc", 199), false);
  assert.strictEqual(api.isValidKoulchiPrice(150, null), false);
});

/* --------------------------------------------- K2 */
console.log("\n--- K2 : eligibilite produit ---");

check("K2a : produit avec prix valide -> eligible", () => {
  assert.strictEqual(api.isKoulchiEligible({ price: 199, koulchiPrice: 189 }), true);
});

check("K2b : sans prix Koulchi -> exclu (tolerant en lecture)", () => {
  assert.strictEqual(api.isKoulchiEligible({ price: 199 }), false);
});

check("K2c : produit null -> exclu sans exception", () => {
  assert.strictEqual(api.isKoulchiEligible(null), false);
});

check("K2d : filterKoulchiProducts ne garde que les eligibles", () => {
  const list = [
    { id: "a", price: 199, koulchiPrice: 189 },
    { id: "b", price: 99 },
    { id: "c", price: 50, koulchiPrice: 60 },
    { id: "d", price: 80, koulchiPrice: 70 },
  ];
  const out = api.filterKoulchiProducts(list);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((p) => p.id), ["a", "d"]);
});

check("K2e : non-tableau -> tableau vide", () => {
  assert.deepStrictEqual(api.filterKoulchiProducts(null), []);
  assert.deepStrictEqual(api.filterKoulchiProducts(undefined), []);
});


/* --------------------------------------------- K3 */
console.log("\n--- K3 : paliers de remise ---");

check("K3a : 0 a 2 articles -> 0%", () => {
  for (const n of [0, 1, 2]) assert.strictEqual(api.getKoulchiPercent(n), 0);
});

check("K3b : 3 a 5 articles -> 2%", () => {
  for (const n of [3, 4, 5]) assert.strictEqual(api.getKoulchiPercent(n), 2);
});

check("K3c : 6 a 8 articles -> 5%", () => {
  for (const n of [6, 7, 8]) assert.strictEqual(api.getKoulchiPercent(n), 5);
});

check("K3d : 9 a 10 articles -> 10%", () => {
  for (const n of [9, 10]) assert.strictEqual(api.getKoulchiPercent(n), 10);
});

check("K3e : prochain palier depuis 0 -> 3 articles, 2%", () => {
  assert.deepStrictEqual(api.getNextKoulchiTier(0), { percent: 2, missing: 3 });
});

check("K3f : depuis 2 -> il manque 1 article pour 2%", () => {
  assert.deepStrictEqual(api.getNextKoulchiTier(2), { percent: 2, missing: 1 });
});

check("K3g : depuis 4 -> il manque 2 pour 5%", () => {
  assert.deepStrictEqual(api.getNextKoulchiTier(4), { percent: 5, missing: 2 });
});

check("K3h : depuis 7 -> il manque 2 pour 10%", () => {
  assert.deepStrictEqual(api.getNextKoulchiTier(7), { percent: 10, missing: 2 });
});

check("K3i : palier max atteint (9, 10) -> null", () => {
  assert.strictEqual(api.getNextKoulchiTier(9), null);
  assert.strictEqual(api.getNextKoulchiTier(10), null);
});

/* --------------------------------------------- K4 */
console.log("\n--- K4 : total et remise ---");

check("K4a : 3 x 189 = 567, -2% -> remise 11, total 556", () => {
  const r = api.computeKoulchiTotals([{ productId: "a", quantity: 3, unitPrice: 189 }]);
  assert.strictEqual(r.itemCount, 3);
  assert.strictEqual(r.subtotal, 567);
  assert.strictEqual(r.percent, 2);
  assert.strictEqual(r.discount, 11);
  assert.strictEqual(r.total, 556);
  assert.strictEqual(r.isValid, true);
});

check("K4b : 6 x 100 = 600, -5% -> remise 30, total 570", () => {
  const r = api.computeKoulchiTotals([{ productId: "a", quantity: 6, unitPrice: 100 }]);
  assert.strictEqual(r.percent, 5);
  assert.strictEqual(r.discount, 30);
  assert.strictEqual(r.total, 570);
});

check("K4c : 9 x 100 = 900, -10% -> remise 90, total 810", () => {
  const r = api.computeKoulchiTotals([{ productId: "a", quantity: 9, unitPrice: 100 }]);
  assert.strictEqual(r.percent, 10);
  assert.strictEqual(r.discount, 90);
  assert.strictEqual(r.total, 810);
});

check("K4d : 2 articles -> 0% de remise, isValid false", () => {
  const r = api.computeKoulchiTotals([{ productId: "a", quantity: 2, unitPrice: 50 }]);
  assert.strictEqual(r.percent, 0);
  assert.strictEqual(r.discount, 0);
  assert.strictEqual(r.total, 100);
  assert.strictEqual(r.isValid, false);
});

check("K4e : 3x189 + 3x49 = 714, -5% -> remise 36, total 678", () => {
  const r = api.computeKoulchiTotals([
    { productId: "a", quantity: 3, unitPrice: 189 },
    { productId: "b", quantity: 3, unitPrice: 49 },
  ]);
  assert.strictEqual(r.itemCount, 6);
  assert.strictEqual(r.subtotal, 714);
  assert.strictEqual(r.percent, 5);
  assert.strictEqual(r.discount, 36);
  assert.strictEqual(r.total, 678);
});

check("K4f : remise toujours entiere (pas de centimes)", () => {
  const r = api.computeKoulchiTotals([{ productId: "a", quantity: 3, unitPrice: 49 }]);
  assert.strictEqual(Number.isInteger(r.discount), true);
  assert.strictEqual(Number.isInteger(r.total), true);
});

check("K4g : lignes invalides ignorees sans casser le calcul", () => {
  const r = api.computeKoulchiTotals([
    null,
    { productId: "a", quantity: 0, unitPrice: 100 },
    { productId: "b", quantity: 3, unitPrice: 100 },
    { productId: "c", quantity: 2, unitPrice: 0 },
  ]);
  assert.strictEqual(r.itemCount, 3);
  assert.strictEqual(r.subtotal, 300);
});

check("K4h : panier vide -> tout a zero, pas d exception", () => {
  const r = api.computeKoulchiTotals([]);
  assert.strictEqual(r.itemCount, 0);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.isValid, false);
});

check("K4i : 11 articles -> overLimit true, isValid false", () => {
  const r = api.computeKoulchiTotals([{ productId: "a", quantity: 11, unitPrice: 10 }]);
  assert.strictEqual(r.overLimit, true);
  assert.strictEqual(r.isValid, false);
});

/* --------------------------------------------- K5 */
console.log("\n--- K5 : repartition par ligne ---");

check("K5a : la somme des lineTotal egale le total", () => {
  const lines = [
    { productId: "a", quantity: 3, unitPrice: 189 },
    { productId: "b", quantity: 3, unitPrice: 49 },
    { productId: "c", quantity: 2, unitPrice: 39 },
  ];
  const totals = api.computeKoulchiTotals(lines);
  const dist = api.distributeKoulchiDiscount(lines, totals.discount);
  const sum = dist.reduce((s, l) => s + l.lineTotal, 0);
  assert.strictEqual(sum, totals.total);
});

check("K5b : la somme des lineDiscount egale la remise totale", () => {
  const lines = [
    { productId: "a", quantity: 3, unitPrice: 189 },
    { productId: "b", quantity: 3, unitPrice: 49 },
  ];
  const totals = api.computeKoulchiTotals(lines);
  const dist = api.distributeKoulchiDiscount(lines, totals.discount);
  const sum = dist.reduce((s, l) => s + l.lineDiscount, 0);
  assert.strictEqual(sum, totals.discount);
});

check("K5c : remise nulle -> toutes les lignes a 0", () => {
  const lines = [{ productId: "a", quantity: 2, unitPrice: 100 }];
  const dist = api.distributeKoulchiDiscount(lines, 0);
  assert.strictEqual(dist[0].lineDiscount, 0);
  assert.strictEqual(dist[0].lineTotal, 200);
});

check("K5d : aucune ligne ne devient negative", () => {
  const lines = [
    { productId: "a", quantity: 1, unitPrice: 10 },
    { productId: "b", quantity: 9, unitPrice: 10 },
  ];
  const totals = api.computeKoulchiTotals(lines);
  const dist = api.distributeKoulchiDiscount(lines, totals.discount);
  for (const l of dist) assert.ok(l.lineTotal >= 0);
});

/* --------------------------------------------- K6 */
console.log("\n--- K6 : garde-fous d ajout ---");

check("K6a : panier vide -> ajout autorise", () => {
  const r = api.canAddToKoulchi([], "a", 1);
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.reason, null);
});

check("K6b : 3 exemplaires du meme produit -> refus maxPerProduct", () => {
  const r = api.canAddToKoulchi([{ productId: "a", quantity: 3 }], "a", 1);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "maxPerProduct");
  assert.strictEqual(r.maxAddable, 0);
});

check("K6c : 2 exemplaires du meme produit -> 1 de plus autorise", () => {
  assert.strictEqual(api.canAddToKoulchi([{ productId: "a", quantity: 2 }], "a", 1).allowed, true);
});

check("K6d : 10 articles atteints -> refus maxItems", () => {
  const lines = [
    { productId: "a", quantity: 3 },
    { productId: "b", quantity: 3 },
    { productId: "c", quantity: 3 },
    { productId: "d", quantity: 1 },
  ];
  const r = api.canAddToKoulchi(lines, "e", 1);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "maxItems");
});

check("K6e : 9 articles -> 1 place restante autorisee", () => {
  const lines = [
    { productId: "a", quantity: 3 },
    { productId: "b", quantity: 3 },
    { productId: "c", quantity: 3 },
  ];
  assert.strictEqual(api.canAddToKoulchi(lines, "d", 1).allowed, true);
});

check("K6f : ajouter 2 alors qu il reste 1 place -> refus", () => {
  const lines = [
    { productId: "a", quantity: 3 },
    { productId: "b", quantity: 3 },
    { productId: "c", quantity: 3 },
  ];
  const r = api.canAddToKoulchi(lines, "d", 2);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "maxItems");
});

check("K6g : productId vide -> refus invalid", () => {
  const r = api.canAddToKoulchi([], "", 1);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "invalid");
});

/* --------------------------------------------- K7 */
console.log("\n--- K7 : etat du panier ---");

check("K7a : panier vide -> manque 3 articles, 10 places", () => {
  const s = api.getKoulchiState([]);
  assert.strictEqual(s.itemCount, 0);
  assert.strictEqual(s.missingForMin, 3);
  assert.strictEqual(s.remainingSlots, 10);
  assert.strictEqual(s.isValid, false);
});

check("K7b : 4 articles a 189 -> valide, -2%, 6 places", () => {
  const s = api.getKoulchiState([{ productId: "a", quantity: 4, unitPrice: 189 }]);
  assert.strictEqual(s.isValid, true);
  assert.strictEqual(s.percent, 2);
  assert.strictEqual(s.remainingSlots, 6);
  assert.strictEqual(s.missingForMin, 0);
  assert.deepStrictEqual(s.nextTier, { percent: 5, missing: 2 });
});

check("K7c : 10 articles -> plus de place, palier max", () => {
  const s = api.getKoulchiState([{ productId: "a", quantity: 10, unitPrice: 100 }]);
  assert.strictEqual(s.remainingSlots, 0);
  assert.strictEqual(s.percent, 10);
  assert.strictEqual(s.nextTier, null);
});

/* --------------------------------------------- K8 */
console.log("\n--- K8 : panier a deux zones (remise volume 5% supprimee) ---");

check("K8a : panier vide -> tout a zero", () => {
  const z = api.computeCartZones([]);
  assert.strictEqual(z.classicQty, 0);
  assert.strictEqual(z.koulchiQty, 0);
  assert.strictEqual(z.subtotal, 0);
  assert.strictEqual(z.itemsTotal, 0);
  assert.strictEqual(z.koulchiValid, false);
});

check("K8b : 3 articles classiques -> AUCUNE remise de 5%", () => {
  const z = api.computeCartZones([
    { mode: null, quantity: 3, classicUnitPrice: 100, koulchiUnitPrice: 90 },
  ]);
  assert.strictEqual(z.classicSubtotal, 300);
  assert.strictEqual(z.koulchiDiscount, 0);
  assert.strictEqual(z.totalDiscount, 0);
  assert.strictEqual(z.itemsTotal, 300);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(z, "volumeDiscount"),
    false
  );
});

check("K8c : zone Koulchi sous le minimum -> prix classique, jamais 0", () => {
  const z = api.computeCartZones([
    { mode: "koulchi", quantity: 2, classicUnitPrice: 100, koulchiUnitPrice: 95 },
  ]);
  assert.strictEqual(z.koulchiQty, 2);
  assert.strictEqual(z.koulchiValid, false);
  assert.strictEqual(z.percent, 0);
  assert.strictEqual(z.koulchiDiscount, 0);
  assert.strictEqual(z.koulchiSubtotalRaw, 200);
  assert.strictEqual(z.koulchiSavings, 0);
  assert.strictEqual(z.koulchiLines[0].effectiveUnitPrice, 100);
});

check("K8d : 3 articles Koulchi -> -2% sur le total de la zone", () => {
  const z = api.computeCartZones([
    { mode: "koulchi", quantity: 3, classicUnitPrice: 100, koulchiUnitPrice: 95 },
  ]);
  assert.strictEqual(z.koulchiValid, true);
  assert.strictEqual(z.percent, 2);
  assert.strictEqual(z.koulchiSubtotalRaw, 285);
  assert.strictEqual(z.koulchiDiscount, 6);
  assert.strictEqual(z.koulchiSubtotal, 279);
  assert.strictEqual(z.koulchiSavings, 15);
  assert.strictEqual(z.itemsTotal, 279);
});

check("K8e : 6 articles -> -5%, 9 articles -> -10%", () => {
  const six = api.computeCartZones([
    { mode: "koulchi", quantity: 6, classicUnitPrice: 100, koulchiUnitPrice: 90 },
  ]);
  assert.strictEqual(six.percent, 5);
  assert.strictEqual(six.koulchiDiscount, 27);
  const nine = api.computeCartZones([
    { mode: "koulchi", quantity: 9, classicUnitPrice: 100, koulchiUnitPrice: 90 },
  ]);
  assert.strictEqual(nine.percent, 10);
  assert.strictEqual(nine.koulchiDiscount, 81);
});

check("K8f : panier mixte -> deux sous-totaux, remise Koulchi seule", () => {
  const z = api.computeCartZones([
    { mode: null, quantity: 2, classicUnitPrice: 100, koulchiUnitPrice: 95 },
    { mode: "koulchi", quantity: 3, classicUnitPrice: 100, koulchiUnitPrice: 95 },
  ]);
  assert.strictEqual(z.classicQty, 2);
  assert.strictEqual(z.koulchiQty, 3);
  assert.strictEqual(z.totalQty, 5);
  assert.strictEqual(z.classicSubtotal, 200);
  assert.strictEqual(z.koulchiSubtotalRaw, 285);
  assert.strictEqual(z.subtotal, 485);
  assert.strictEqual(z.koulchiDiscount, 6);
  assert.strictEqual(z.itemsTotal, 479);
});

check("K8g : ligne Koulchi sans prix de groupe -> prix classique", () => {
  const z = api.computeCartZones([
    { mode: "koulchi", quantity: 3, classicUnitPrice: 100, koulchiUnitPrice: null },
  ]);
  assert.strictEqual(z.koulchiValid, true);
  assert.strictEqual(z.percent, 2);
  assert.strictEqual(z.koulchiSubtotalRaw, 300);
  assert.strictEqual(z.koulchiLines[0].koulchiPriceUsable, false);
  assert.strictEqual(z.koulchiLines[0].effectiveUnitPrice, 100);
  assert.strictEqual(z.koulchiDiscount, 6);
});

check("K8h : prix de groupe superieur au prix normal -> refuse", () => {
  const z = api.computeCartZones([
    { mode: "koulchi", quantity: 3, classicUnitPrice: 100, koulchiUnitPrice: 120 },
  ]);
  assert.strictEqual(z.koulchiLines[0].effectiveUnitPrice, 100);
  assert.strictEqual(z.koulchiSavings, 0);
});

check("K8i : 11 articles Koulchi -> zone invalide, prix classique", () => {
  const z = api.computeCartZones([
    { mode: "koulchi", quantity: 11, classicUnitPrice: 100, koulchiUnitPrice: 90 },
  ]);
  assert.strictEqual(z.koulchiValid, false);
  assert.strictEqual(z.koulchiDiscount, 0);
  assert.strictEqual(z.itemsTotal, 1100);
});

check("K8j : quantite nulle ignoree", () => {
  const z = api.computeCartZones([
    { mode: "koulchi", quantity: 0, classicUnitPrice: 100, koulchiUnitPrice: 90 },
    { mode: null, quantity: 1, classicUnitPrice: 50, koulchiUnitPrice: 40 },
  ]);
  assert.strictEqual(z.koulchiQty, 0);
  assert.strictEqual(z.classicQty, 1);
  assert.strictEqual(z.subtotal, 50);
});

check("K8k : message palier 4 articles -> -5% dans 2 articles", () => {
  const m = api.getKoulchiTierMessage(4, 380);
  assert.strictEqual(m.currentPercent, 2);
  assert.strictEqual(m.nextPercent, 5);
  assert.strictEqual(m.missing, 2);
  assert.strictEqual(m.gain, 11);
});

check("K8l : message palier max -> null", () => {
  assert.strictEqual(api.getKoulchiTierMessage(10, 900), null);
});

check("K8m : message zone vide -> 3 articles pour -2%", () => {
  const m = api.getKoulchiTierMessage(0, 0);
  assert.strictEqual(m.currentPercent, 0);
  assert.strictEqual(m.nextPercent, 2);
  assert.strictEqual(m.missing, 3);
  assert.strictEqual(m.gain, 0);
});

check("K8n : remise par ligne exacte, derniere ligne absorbe l arrondi", () => {
  const z = api.computeCartZones([
    { productId: "a", mode: "koulchi", quantity: 1, classicUnitPrice: 100, koulchiUnitPrice: 99 },
    { productId: "b", mode: "koulchi", quantity: 1, classicUnitPrice: 100, koulchiUnitPrice: 99 },
    { productId: "c", mode: "koulchi", quantity: 1, classicUnitPrice: 100, koulchiUnitPrice: 99 },
  ]);
  const lines = api.getKoulchiLineDisplay(z.koulchiLines, z.koulchiDiscount);
  const sum = lines.reduce((s, l) => s + l.lineDiscount, 0);
  assert.strictEqual(sum, z.koulchiDiscount);
  assert.strictEqual(lines[0].unitPrice, 99);
  assert.strictEqual(
    z.koulchiDiscount - lines[0].lineDiscount - lines[1].lineDiscount,
    lines[2].lineDiscount
  );
});

check("K8o : regle metier unique, aucun cumul volume + Koulchi", () => {
  const z = api.computeCartZones([
    { mode: null, quantity: 5, classicUnitPrice: 100, koulchiUnitPrice: 90 },
    { mode: "koulchi", quantity: 5, classicUnitPrice: 100, koulchiUnitPrice: 90 },
  ]);
  assert.strictEqual(z.totalDiscount, z.koulchiDiscount);
  assert.strictEqual(z.percent, 2);
  assert.strictEqual(z.classicSubtotal, 500);
  assert.strictEqual(z.koulchiSubtotalRaw, 450);
  assert.strictEqual(z.subtotal, 950);
  assert.strictEqual(z.koulchiDiscount, 9);
  assert.strictEqual(z.itemsTotal, 941);
});

/* --------------------------------------------- K9 */
console.log("\n--- K9 : ajout d un produit a la zone Koulchi ---");

check("K9a : produit eligible, panier vide -> autorise", () => {
  const r = api.canAddProductToKoulchi([], { id: "p1", price: 199, koulchiPrice: 189 }, 1);
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.reason, null);
});

check("K9b : produit sans prix de groupe -> refuse", () => {
  const r = api.canAddProductToKoulchi([], { id: "p1", price: 199 }, 1);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "notEligible");
});

check("K9c : produit a variantes -> refuse", () => {
  const r = api.canAddProductToKoulchi(
    [],
    { id: "p1", price: 199, koulchiPrice: 189, variants: [{ size: "M", color: "noir" }] },
    1
  );
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "variant");
});

check("K9d : 3 exemplaires deja presents -> refuse maxPerProduct", () => {
  const r = api.canAddProductToKoulchi(
    [{ productId: "p1", quantity: 3 }],
    { id: "p1", price: 199, koulchiPrice: 189 },
    1
  );
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "maxPerProduct");
  assert.strictEqual(r.maxAddable, 0);
});

check("K9e : 10 articles au total -> refuse maxItems", () => {
  const lines = [
    { productId: "a", quantity: 3 },
    { productId: "b", quantity: 3 },
    { productId: "c", quantity: 3 },
    { productId: "d", quantity: 1 },
  ];
  const r = api.canAddProductToKoulchi(lines, { id: "p1", price: 199, koulchiPrice: 189 }, 1);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "maxItems");
});

check("K9f : produit null -> refuse sans exception", () => {
  const r = api.canAddProductToKoulchi([], null, 1);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "invalid");
});

check("K9g : produit en vente flash -> refuse (pas de cumul)", () => {
  const r = api.canAddProductToKoulchi(
    [],
    { id: "p1", price: 199, koulchiPrice: 189, flashPrice: 150 },
    1
  );
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "flashSale");
  assert.strictEqual(api.isKoulchiBlockedByFlash({ flashPrice: 150 }), true);
  assert.strictEqual(api.isKoulchiBlockedByFlash({ flashPrice: 0 }), false);
});

/* --------------------------------------------- Catalogue de la page /koulchi */

check("C1 : getKoulchiCatalog garde les prix de groupe valides", () => {
  const cat = api.getKoulchiCatalog([
    { id: 1, price: 500, koulchiPrice: 450, stock: 5 },
    { id: 2, price: 500, stock: 5 },
    { id: 3, price: 500, koulchiPrice: 600, stock: 5 },
    { id: 4, price: 500, koulchiPrice: 450, stock: 5 },
  ]);
  assert.deepStrictEqual(cat.map((p) => p.id), [1, 4]);
});

check("C2 : getKoulchiCatalog exclut stock 0 et variantes", () => {
  const cat = api.getKoulchiCatalog([
    { id: 1, price: 500, koulchiPrice: 450, stock: 0 },
    { id: 2, price: 500, koulchiPrice: 450, stock: 3, variants: [{ size: "M" }] },
    { id: 3, price: 500, koulchiPrice: 450, stock: 2 },
  ]);
  assert.deepStrictEqual(cat.map((p) => p.id), [3]);
});

check("C3 : getKoulchiCatalog exclut les ventes flash", () => {
  const cat = api.getKoulchiCatalog([
    { id: 1, price: 500, koulchiPrice: 450, stock: 5, flashPrice: 400 },
    { id: 2, price: 500, koulchiPrice: 450, stock: 5, flashPrice: 0 },
  ]);
  assert.deepStrictEqual(cat.map((p) => p.id), [2]);
});

check("C4 : getKoulchiCatalog exclut les statuts non approuves", () => {
  const cat = api.getKoulchiCatalog([
    { id: 1, price: 500, koulchiPrice: 450, stock: 5, status: "pending" },
    { id: 2, price: 500, koulchiPrice: 450, stock: 5, status: "approved" },
    { id: 3, price: 500, koulchiPrice: 450, stock: 5 },
  ]);
  assert.deepStrictEqual(cat.map((p) => p.id), [2, 3]);
});

check("C5 : getKoulchiCatalog tolere une liste invalide", () => {
  assert.deepStrictEqual(api.getKoulchiCatalog(null), []);
  assert.deepStrictEqual(api.getKoulchiCatalog(undefined), []);
});

/* --------------------------------------------- Resume */
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log("\n" + pass + "/" + results.length + " verifications PASS");
if (fail > 0) {
  console.log("ECHECS: " + results.filter((r) => !r.ok).map((r) => r.name).join(" | "));
  process.exit(1);
}
console.log("Koulchi dialk : toutes les regles sont verifiees.");

