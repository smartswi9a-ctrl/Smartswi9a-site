/* ============================================================
   tests/cart-intent.test.mjs
   GARDE-FOU : intention d'achat en attente de connexion.
   ------------------------------------------------------------
   L'ajout au panier exige un compte (decision produit). Ce module
   conserve le produit clique le temps que le visiteur se connecte,
   puis cart.js l'ajoute automatiquement.

   Verifie : serialisation, variante et mode, expiration, donnees
   invalides, horodatage incoherent.
   ============================================================ */

import assert from "node:assert";
import { buildCartIntent, readCartIntent, CART_INTENT_TTL_MS } from "../js/cart-intent.js";

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

const NOW = 1_700_000_000_000;

check("buildCartIntent : produit seul", () => {
  const raw = buildCartIntent("pr123", null, null, NOW);
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.productId, "pr123");
  assert.strictEqual(parsed.variant, null);
  assert.strictEqual(parsed.mode, null);
  assert.strictEqual(parsed.at, NOW);
});

check("buildCartIntent : variante et mode koulchi", () => {
  const parsed = JSON.parse(buildCartIntent("pr9", "bleu", "koulchi", NOW));
  assert.strictEqual(parsed.variant, "bleu");
  assert.strictEqual(parsed.mode, "koulchi");
});

check("buildCartIntent : mode inconnu ignore", () => {
  const parsed = JSON.parse(buildCartIntent("pr9", null, "autre", NOW));
  assert.strictEqual(parsed.mode, null);
});

check("readCartIntent : aller-retour complet", () => {
  const raw = buildCartIntent("pr42", "noir", "koulchi", NOW);
  const intent = readCartIntent(raw, NOW + 1000);
  assert.deepStrictEqual(intent, { productId: "pr42", variant: "noir", mode: "koulchi" });
});

check("readCartIntent : expiree apres le TTL", () => {
  const raw = buildCartIntent("pr42", null, null, NOW);
  assert.strictEqual(readCartIntent(raw, NOW + CART_INTENT_TTL_MS + 1), null);
});

check("readCartIntent : valide juste avant le TTL", () => {
  const raw = buildCartIntent("pr42", null, null, NOW);
  const intent = readCartIntent(raw, NOW + CART_INTENT_TTL_MS - 1);
  assert.strictEqual(intent.productId, "pr42");
});

check("readCartIntent : entrees invalides", () => {
  assert.strictEqual(readCartIntent(null, NOW), null);
  assert.strictEqual(readCartIntent("", NOW), null);
  assert.strictEqual(readCartIntent("pas du json", NOW), null);
  assert.strictEqual(readCartIntent("null", NOW), null);
  assert.strictEqual(readCartIntent(JSON.stringify({ at: NOW }), NOW), null);
});

check("readCartIntent : horodatage dans le futur rejete", () => {
  const raw = buildCartIntent("pr42", null, null, NOW + 60_000);
  assert.strictEqual(readCartIntent(raw, NOW), null);
});

check("readCartIntent : horodatage absent rejete", () => {
  const raw = JSON.stringify({ productId: "pr42" });
  assert.strictEqual(readCartIntent(raw, NOW), null);
});

check("readCartIntent : TTL personnalise", () => {
  const raw = buildCartIntent("pr42", null, null, NOW);
  assert.strictEqual(readCartIntent(raw, NOW + 5000, 1000), null);
  assert.strictEqual(readCartIntent(raw, NOW + 500, 1000).productId, "pr42");
});

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Intention d achat : logique verifiee.");
