/* ============================================================
   tests/cart-savings.test.mjs
   GARDE-FOU : ligne "Economies" du recapitulatif panier.
   ------------------------------------------------------------
   BUG corrige le 2026-11-18 : getCartSavings() comparait le prix
   barre (oldPrice) au prix NORMAL du produit (p.price). Un article
   facture au prix Koulchi (ou au prix flash) etait donc compte
   comme paye au prix normal : le recapitulatif annoncait 581 MAD
   d economies alors que le client en economisait ~905.

   Le calcul vit maintenant dans js/koulchi.js
   (computeDisplayedSavings) : il est pur, donc testable sans DOM.
   cart.js ne fait plus que lui passer les lignes des deux zones.

   Regle verifiee :
     Economies = somme (oldPrice - prix effectif) x quantite
       -> prix effectif = computeCartZones().effectiveUnitPrice
       -> la remise de palier reste affichee a part (koulchiDiscount)
       -> aucune ligne a variante (oldPrice est un prix produit)

   Invariant : sur un panier ou tous les produits ont un oldPrice,
     somme(oldPrice x qty) - economies == zone.subtotal
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"),
  ".."
);

/* Meme technique que koulchi.test.mjs : le fichier source est un module
   ES. On le copie en .mjs DANS LE PROJET, sinon Node le relit en
   CommonJS (le dossier temporaire n a pas de package.json) et echoue sur
   "Unexpected token export". */
const SRC = path.join(ROOT, "js", "koulchi.js");
const TMP = path.join(ROOT, "js", "__koulchi_savings_test_tmp.mjs");

fs.copyFileSync(SRC, TMP);

let api;
try {
  api = await import(pathToFileURL(TMP).href);
} finally {
  try { fs.unlinkSync(TMP); } catch (_) { /* ignore */ }
}

const CART = fs.readFileSync(path.join(ROOT, "js", "cart.js"), "utf8");

let verifications = 0;
let echecs = 0;

function check(nom, fn) {
  verifications++;
  try {
    fn();
    console.log("PASS: " + nom);
  } catch (e) {
    echecs++;
    console.error("ECHEC: " + nom + " -> " + e.message);
  }
}

/* Ligne telle que buildZoneLines() la produit. */
function ligne(productId, quantity, classicUnitPrice, koulchiUnitPrice, extra) {
  return {
    productId,
    quantity,
    mode: koulchiUnitPrice === null ? null : "koulchi",
    classicUnitPrice,
    koulchiUnitPrice,
    variant: null,
    ...(extra || {}),
  };
}

/* Ligne de zone -> economies, exactement comme cart.js le fait. */
function economies(zones, products) {
  return api.computeDisplayedSavings(
    [...zones.classicLines, ...zones.koulchiLines],
    products
  );
}

const CATALOGUE = [
  { id: "a", price: 200, oldPrice: 250, koulchiPrice: 190 },
  { id: "b", price: 100, oldPrice: 120, koulchiPrice: 95 },
  { id: "c", price: 50, oldPrice: 60, koulchiPrice: 48 },
];

/* --------------------------------------------- S1 : panier Koulchi */

console.log("\n--- S1 : panier Koulchi (3 articles, palier 5 %) ---");

const z1 = api.computeCartZones([
  ligne("a", 1, 200, 190),
  ligne("b", 1, 100, 95),
  ligne("c", 1, 50, 48),
]);

check("S1a : la zone est active (3 articles -> 5 %)", () => {
  assert.strictEqual(z1.koulchiValid, true);
  assert.strictEqual(z1.percent, 5);
});

check("S1b : sous-total brut = 333, remise = 17, net = 316", () => {
  assert.strictEqual(z1.subtotal, 333);
  assert.strictEqual(z1.koulchiDiscount, 17);
  assert.strictEqual(z1.itemsTotal, 316);
});

check("S1c : economies basees sur le prix Koulchi = 97", () => {
  assert.strictEqual(economies(z1, CATALOGUE), 97);
});

check("S1d : l ancien calcul (p.price) sous-estimait (80 < 97)", () => {
  const ancien = (250 - 200) + (120 - 100) + (60 - 50);
  assert.strictEqual(ancien, 80);
  assert.ok(
    economies(z1, CATALOGUE) > ancien,
    "les economies doivent depasser l ancien calcul"
  );
});

/* --------------------------------------------- S2 : zone inactive */

console.log("\n--- S2 : zone Koulchi sous le minimum (2 articles) ---");

const z2 = api.computeCartZones([ligne("a", 2, 200, 190)]);

check("S2a : zone inactive -> prix normal, aucune remise", () => {
  assert.strictEqual(z2.koulchiValid, false);
  assert.strictEqual(z2.koulchiDiscount, 0);
  assert.strictEqual(z2.subtotal, 400);
});

check("S2b : economies retombent sur le prix normal (100)", () => {
  assert.strictEqual(economies(z2, CATALOGUE), 100);
});

/* --------------------------------------------- S3 : panier mixte */

console.log("\n--- S3 : panier mixte (groupe + classique + flash) ---");

const CATALOGUE_MIXTE = [
  { id: "a", price: 200, oldPrice: 250, koulchiPrice: 190 },
  { id: "b", price: 100, oldPrice: 120, koulchiPrice: 95 },
  { id: "c", price: 50, oldPrice: 60, koulchiPrice: 48 },
  { id: "d", price: 80, oldPrice: 110 },
  { id: "e", price: 240, oldPrice: 300, flashPrice: 200 },
];

const z3 = api.computeCartZones([
  ligne("a", 1, 200, 190),
  ligne("b", 2, 100, 95),
  ligne("c", 1, 50, 48),
  ligne("d", 2, 80, null),
  ligne("e", 1, 200, null),
]);

check("S3a : totaux (subtotal 788, remise 21, net 767)", () => {
  assert.strictEqual(z3.subtotal, 788);
  assert.strictEqual(z3.koulchiDiscount, 21);
  assert.strictEqual(z3.itemsTotal, 767);
});

check("S3b : economies = 282", () => {
  assert.strictEqual(economies(z3, CATALOGUE_MIXTE), 282);
});

check("S3c : invariant prix barre - economies = sous-total", () => {
  const prixBarre = 250 + 120 * 2 + 60 + 110 * 2 + 300;
  assert.strictEqual(prixBarre, 1070);
  assert.strictEqual(prixBarre - economies(z3, CATALOGUE_MIXTE), z3.subtotal);
});

check("S3d : economies + remise de palier = prix barre - net", () => {
  assert.strictEqual(
    economies(z3, CATALOGUE_MIXTE) + z3.koulchiDiscount,
    1070 - z3.itemsTotal
  );
});

/* --------------------------------------------- S4 : exclusions */

console.log("\n--- S4 : exclusions (variante, sans oldPrice, produit inconnu) ---");

const z4 = api.computeCartZones([
  {
    productId: "e",
    quantity: 1,
    mode: null,
    classicUnitPrice: 310,
    koulchiUnitPrice: null,
    variant: { size: "M", price: 310 },
  },
  ligne("d", 3, 80, null),
  ligne("inconnu", 2, 55, null),
]);

check("S4a : ligne a variante ignoree (elle n ajoute aucune economie)", () => {
  /* Seule la ligne "d" compte : (110 - 80) x 3 = 90. La variante (310)
     et le produit inconnu ne doivent rien ajouter. */
  assert.strictEqual(economies(z4, CATALOGUE_MIXTE), 90);
});

check("S4b : produit sans oldPrice -> 0", () => {
  const sansOld = api.computeCartZones([ligne("d", 2, 80, null)]);
  assert.strictEqual(economies(sansOld, [{ id: "d", price: 80 }]), 0);
});

/* --------------------------------------------- S5 : robustesse */

console.log("\n--- S5 : robustesse ---");

check("S5a : entrees nulles ou vides", () => {
  assert.strictEqual(api.computeDisplayedSavings(null, null), 0);
  assert.strictEqual(api.computeDisplayedSavings([], CATALOGUE), 0);
  assert.strictEqual(
    api.computeDisplayedSavings([ligne("a", 1, 200, 190)], null),
    0
  );
});

check("S5b : quantite nulle ou negative ignoree", () => {
  const z = api.computeCartZones([
    ligne("a", 0, 200, 190),
    ligne("a", -3, 200, 190),
  ]);
  assert.strictEqual(economies(z, CATALOGUE), 0);
});

check("S5c : oldPrice absent, nul ou inferieur au prix paye -> 0", () => {
  const lignes = [
    { productId: "x", quantity: 1, effectiveUnitPrice: 100, variant: null },
    { productId: "y", quantity: 1, effectiveUnitPrice: 100, variant: null },
    { productId: "z", quantity: 1, effectiveUnitPrice: 100, variant: null },
  ];
  const produits = [
    { id: "x", price: 100 },
    { id: "y", price: 100, oldPrice: null },
    { id: "z", price: 100, oldPrice: 90 },
  ];
  assert.strictEqual(api.computeDisplayedSavings(lignes, produits), 0);
});

check("S5d : ligne sans effectiveUnitPrice ignoree (pas de surevaluation)", () => {
  const lignes = [{ productId: "a", quantity: 2, variant: null }];
  assert.strictEqual(api.computeDisplayedSavings(lignes, CATALOGUE), 0);
});

/* --------------------------------------------- S6 : branchement cart.js */

console.log("\n--- S6 : branchement dans cart.js ---");

check("S6a : computeDisplayedSavings est exportee", () => {
  assert.strictEqual(typeof api.computeDisplayedSavings, "function");
});

check("S6b : getCartSavings utilise les lignes des deux zones", () => {
  const debut = CART.indexOf("export function getCartSavings");
  const fin = CART.indexOf("export function getCartDiscount");
  assert.ok(debut > 0, "getCartSavings introuvable");
  assert.ok(fin > debut, "getCartDiscount doit suivre getCartSavings");
  const bloc = CART.slice(debut, fin);
  assert.strictEqual(
    /computeDisplayedSavings\(/.test(bloc),
    true,
    "getCartSavings doit deleguer a computeDisplayedSavings"
  );
  assert.strictEqual(
    /zone\.classicLines/.test(bloc) && /zone\.koulchiLines/.test(bloc),
    true,
    "les deux zones doivent etre transmises"
  );
  assert.strictEqual(
    /p\.price/.test(bloc),
    false,
    "le prix normal ne doit plus servir au calcul des economies"
  );
});

check("S6c : computeDisplayedSavings est importee par cart.js", () => {
  assert.strictEqual(
    /import\s*\{[^}]*computeDisplayedSavings[^}]*\}\s*from\s*"\.\/koulchi\.js"/s.test(
      CART
    ),
    true
  );
});

/* --------------------------------------------- Resume */

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Economies du recapitulatif : calcul base sur le prix effectif.");


