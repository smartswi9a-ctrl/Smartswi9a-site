/* ============================================================
   tests/koulchi-server.test.cjs
   K3 - verifie que le serveur applique EXACTEMENT le bareme de
   js/koulchi.js et qu aucune sortie ne peut facturer un mauvais prix.

   Test statique (functions/index.js ne peut pas etre importe en Node :
   firebase-admin + exports de Cloud Functions). Il verifie donc des
   invariants de source, comme tests/livo-compliance.test.cjs.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "functions", "index.js"), "utf8");
const CLIENT = fs.readFileSync(path.join(ROOT, "js", "koulchi.js"), "utf8");

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log("PASS: " + name);
  } catch (e) {
    fail += 1;
    console.log("FAIL: " + name + " -> " + e.message);
  }
}

function block(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error("marqueur introuvable: " + startMarker);
  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error("fin introuvable: " + endMarker);
  return text.slice(start, end);
}

/* --------------------------------------------- S1 : constantes */
console.log("\n--- S1 : le bareme serveur egale le client ---");

check("S1a : KOULCHI_MIN_ITEMS identique", () => {
  const client = Number(/export const KOULCHI_MIN_ITEMS = (\d+);/.exec(CLIENT)[1]);
  const server = Number(/const KOULCHI_MIN_ITEMS = (\d+);/.exec(SERVER)[1]);
  assert.strictEqual(server, client);
  assert.strictEqual(server, 3);
});

check("S1b : KOULCHI_MAX_ITEMS identique", () => {
  const client = Number(/export const KOULCHI_MAX_ITEMS = (\d+);/.exec(CLIENT)[1]);
  const server = Number(/const KOULCHI_MAX_ITEMS = (\d+);/.exec(SERVER)[1]);
  assert.strictEqual(server, client);
  assert.strictEqual(server, 10);
});

check("S1c : paliers identiques (min/percent)", () => {
  const readTiers = (text) => {
    const body = block(text, "KOULCHI_TIERS = [", "];");
    return [...body.matchAll(/min:\s*(\d+),\s*percent:\s*(\d+)/g)].map(
      (m) => Number(m[1]) + ":" + Number(m[2])
    );
  };
  const client = readTiers(CLIENT);
  const server = readTiers(SERVER);
  assert.deepStrictEqual(server, client);
  assert.deepStrictEqual(client, ["9:10", "6:5", "3:2"]);
});

/* --------------------------------------------- S2 : securite */
console.log("\n--- S2 : le client ne peut pas imposer un prix ---");

check("S2a : le serveur relit product.koulchiPrice", () => {
  assert.strictEqual(/data\.koulchiPrice/.test(SERVER), true);
});

check("S2b : le serveur ignore tout prix Koulchi envoye par le client", () => {
  assert.strictEqual(/it\??\.koulchiPrice/.test(SERVER), false);
  assert.strictEqual(/input\.koulchiPrice/.test(SERVER), false);
});

check("S2c : le prix de groupe n est retenu que s il est inferieur", () => {
  const body = block(SERVER, "koulchiPrice: !flashApplied", "flashSale: flashApplied");
  assert.strictEqual(/< unitPrice/.test(body), true);
  assert.strictEqual(/: null/.test(body), true);
});

check("S2d : les variantes sont exclues du prix de groupe", () => {
  const body = block(SERVER, "koulchiPrice: !flashApplied", "flashSale: flashApplied");
  assert.strictEqual(/!item\.variant/.test(body), true);
});

check("S2e : un produit en vente flash est exclu de Koulchi", () => {
  const body = block(SERVER, "koulchiPrice: !flashApplied", "flashSale: flashApplied");
  assert.strictEqual(/!flashApplied/.test(body), true);
});

/* --------------------------------------------- S3 : remise volume */
console.log("\n--- S3 : la remise volume de 5 % est neutralisee ---");

check("S3a : volumeDiscount depend de pricingVersion", () => {
  const body = block(SERVER, "const volumeDiscount = pricingVersion >= 2", "const itemDiscount");
  assert.strictEqual(/pricingVersion >= 2/.test(body), true);
  assert.strictEqual(/\? 0/.test(body), true);
});

check("S3b : le 5 % ne subsiste que dans la branche legacy", () => {
  const occurrences = SERVER.split("Math.round(subtotal * 0.05)").length - 1;
  assert.strictEqual(occurrences, 1);
  const legacyIndex = SERVER.indexOf("Math.round(subtotal * 0.05)");
  const gateIndex = SERVER.indexOf("const volumeDiscount = pricingVersion >= 2");
  assert.strictEqual(gateIndex > 0, true);
  assert.strictEqual(legacyIndex > gateIndex, true);
});

check("S3c : la remise des articles utilise itemDiscount partout", () => {
  const body = block(SERVER, "const productDiscount = Math.min(subtotal,", ";");
  assert.strictEqual(/itemDiscount \+/.test(body), true);
  assert.strictEqual(/volumeDiscount \+/.test(body), false);
});

/* --------------------------------------------- S4 : sorties */
console.log("\n--- S4 : toutes les sorties portent le bon montant ---");

check("S4a : orderData contient discount, koulchiDiscount et koulchiPercent", () => {
  const body = block(SERVER, "const orderData = {", "vendorCredits: {}");
  assert.strictEqual(/discount: itemDiscount/.test(body), true);
  assert.strictEqual(/koulchiDiscount,/.test(body), true);
  assert.strictEqual(/koulchiPercent,/.test(body), true);
});

check("S4b : responseData contient le meme montant", () => {
  const body = block(SERVER, "const responseData = {", "validatedItems");
  assert.strictEqual(/discount: itemDiscount/.test(body), true);
  assert.strictEqual(/koulchiDiscount,/.test(body), true);
  assert.strictEqual(/koulchiPercent,/.test(body), true);
});

check("S4c : aucun chemin ne renvoie plus volumeDiscount", () => {
  assert.strictEqual(/discount: volumeDiscount/.test(SERVER), false);
});

/* --------------------------------------------- S5 : fusion */
console.log("\n--- S5 : fusion des lignes ---");

check("S5a : la zone fait partie de la cle de fusion serveur", () => {
  assert.strictEqual(
    /JSON\.stringify\(\[productId, v\?\.size \|\| '', v\?\.color \|\| '', mode \|\| ''\]\)/.test(SERVER),
    true
  );
});

check("S5b : la zone est transmise dans le hash idempotent", () => {
  const body = block(SERVER, "const requestPayloadHash", "digest('hex')");
  assert.strictEqual(/mode: item\.mode \|\| null/.test(body), true);
  assert.strictEqual(/pricingVersion,/.test(body), true);
});

/* --------------------------------------------- Resume */
console.log("\n" + pass + "/" + (pass + fail) + " verifications PASS");
if (fail > 0) {
  console.log("ECHECS: voir ci-dessus");
  process.exit(1);
}
console.log("K3 : le serveur applique le bareme Koulchi sans confiance au client.");