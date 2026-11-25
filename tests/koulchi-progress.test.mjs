#!/usr/bin/env node
/* ============================================================
   TESTS : KOULCHI DIALK — seuils, exclusion Vente Flash, UI
   ------------------------------------------------------------
   Vérifie la règle métier (js/koulchi.js, inchangée) et le
   câblage du bandeau/cross-sell dans js/panier.js.
   Usage : node tests/koulchi-progress.test.mjs
   ============================================================ */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const koulchi = await import("../js/koulchi.js");

let checks = 0;
let failures = 0;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log("PASS: " + name);
  } catch (error) {
    failures += 1;
    console.error("ECHEC: " + name + " -> " + error.message);
  }
}

/* ---------- Seuils 3 / 6 / 9 ---------- */

check("paliers : 0, 1 et 2 articles → 0 %", () => {
  assert.equal(koulchi.getKoulchiPercent(0), 0);
  assert.equal(koulchi.getKoulchiPercent(1), 0);
  assert.equal(koulchi.getKoulchiPercent(2), 0);
});

check("palier 3 articles → −5 %", () => {
  assert.equal(koulchi.getKoulchiPercent(3), 5);
  assert.equal(koulchi.getKoulchiPercent(4), 5);
  assert.equal(koulchi.getKoulchiPercent(5), 5);
});

check("palier 6 articles → −10 %", () => {
  assert.equal(koulchi.getKoulchiPercent(6), 10);
  assert.equal(koulchi.getKoulchiPercent(7), 10);
  assert.equal(koulchi.getKoulchiPercent(8), 10);
});

check("palier 9 et 10 articles → −15 %", () => {
  assert.equal(koulchi.getKoulchiPercent(9), 15);
  assert.equal(koulchi.getKoulchiPercent(10), 15);
});

check("prochain palier : articles manquants exacts", () => {
  assert.deepEqual(koulchi.getNextKoulchiTier(2), { percent: 5, missing: 1 });
  assert.deepEqual(koulchi.getNextKoulchiTier(3), { percent: 10, missing: 3 });
  assert.deepEqual(koulchi.getNextKoulchiTier(5), { percent: 10, missing: 1 });
  assert.deepEqual(koulchi.getNextKoulchiTier(6), { percent: 15, missing: 3 });
  assert.deepEqual(koulchi.getNextKoulchiTier(8), { percent: 15, missing: 1 });
  assert.equal(koulchi.getNextKoulchiTier(9), null);
});

/* ---------- Calcul de la remise ---------- */

check("remise calculée sur 3, 6 et 9 articles", () => {
  assert.equal(koulchi.computeKoulchiTotals([{ quantity: 3, unitPrice: 100 }]).discount, 15);
  assert.equal(koulchi.computeKoulchiTotals([{ quantity: 6, unitPrice: 100 }]).discount, 60);
  assert.equal(koulchi.computeKoulchiTotals([{ quantity: 9, unitPrice: 100 }]).discount, 135);
});

/* ---------- Exclusion Vente Flash ---------- */

check("un produit Vente Flash est exclu du palier", () => {
  assert.equal(koulchi.isKoulchiBlockedByFlash({ flashPrice: 99, price: 200 }), true);
  assert.equal(koulchi.isKoulchiBlockedByFlash({ flashPrice: 0, price: 200 }), false);
  assert.equal(koulchi.isKoulchiBlockedByFlash({ price: 200 }), false);
  const added = koulchi.canAddProductToKoulchi([], {
    id: "f1",
    price: 200,
    flashPrice: 90,
    status: "approved",
    stock: 5
  });
  assert.equal(added.allowed, false);
  assert.equal(added.reason, "flashSale");
});

check("le compteur ne totalise que les lignes Koulchi", () => {
  const zones = koulchi.computeCartZones([
    { itemId: "a", productId: "p1", mode: "koulchi", quantity: 2, classicUnitPrice: 100, koulchiUnitPrice: 95 },
    { itemId: "b", productId: "p2", mode: "koulchi", quantity: 1, classicUnitPrice: 50, koulchiUnitPrice: 47.5 },
    { itemId: "c", productId: "p3", mode: null, quantity: 3, classicUnitPrice: 80 }
  ]);
  assert.equal(zones.koulchiQty, 3);
  assert.equal(zones.classicQty, 3);
  assert.equal(zones.percent, 5);
});

check("au-delà de 10 articles Koulchi : pas de remise de palier", () => {
  const zones = koulchi.computeCartZones([
    { itemId: "a", productId: "p1", mode: "koulchi", quantity: 11, classicUnitPrice: 100, koulchiUnitPrice: 85 }
  ]);
  assert.equal(zones.koulchiValid, false);
  assert.equal(zones.koulchiDiscount, 0);
});

/* ---------- Câblage UI (panier.js) ---------- */

const panier = read("js/panier.js");

check("bandeau : messages besoin / −5 / −10 / max + jauge", () => {
  for (const key of ["koulchiNeedTier", "koulchiNextTier", "koulchiMaxTier"]) {
    assert.ok(panier.includes(key), "clé de message manquante : " + key);
  }
  assert.ok(panier.includes("renderKoulchiProgress"), "bandeau non rendu");
  assert.ok(panier.includes('role="progressbar"'), "jauge accessible absente");
  assert.ok(panier.includes("koulchi-bar__marker"), "marqueurs de palier absents");
});

check("bandeau : rappel Vente Flash + économie en MAD", () => {
  assert.ok(panier.includes("koulchiFlashExcluded"), "rappel flash absent");
  assert.ok(panier.includes("koulchiYouSave"), "économie absente");
  assert.ok(panier.includes("isKoulchiBlockedByFlash"), "détection flash absente");
  assert.ok(panier.includes("koulchiDiscount"), "remise Koulchi non lue");
});

check("cross-sell : visible de 1 à 8 articles seulement", () => {
  assert.ok(/qty < 1 \|\| qty >= 9/.test(panier), "garde-fou 1..8 absent");
  assert.ok(panier.includes("renderCrossSell"), "bloc cross-sell non rendu");
  assert.ok(panier.includes("cart:add-xsell"), "bouton d'ajout absent");
  assert.ok(/sort\(\(a, b\) => \(Number\(a\.price\)/.test(panier), "tri par prix croissant absent");
  assert.ok(panier.includes('mode: "koulchi"'), "l'ajout doit alimenter le palier Koulchi");
});

check("i18n : clés présentes en FR, EN et AR", () => {
  const tr = read("translations.js");
  for (const key of ["koulchiNeedTier", "koulchiNextTier", "koulchiMaxTier", "crossSellTitle"]) {
    const occurrences = (tr.match(new RegExp(key + ":", "g")) || []).length;
    assert.ok(occurrences >= 3, `clé ${key} absente dans une langue (${occurrences}/3)`);
  }
});

check("CSS : propriétés logiques (RTL) et anti-débordement", () => {
  const css = read("style-patches.css");
  for (const sel of [".koulchi-progress", ".koulchi-bar__fill", ".cart-xsell", ".cart-xsell__card", ".cart-xsell__btn"]) {
    assert.ok(css.includes(sel), "sélecteur manquant : " + sel);
  }
  assert.ok(css.includes("margin-block"), "propriétés logiques absentes");
  assert.ok(/\.cart-xsell__card \{[^}]*min-inline-size: 0/.test(css), "min-inline-size manquant (débordement possible)");
});

check("syntaxe ES module valide (panier.js)", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: panier,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, "panier.js ne compile pas : " + (result.stderr || "").slice(0, 300));
});

console.log("\n" + (checks - failures) + "/" + checks + " vérifications OK");
if (failures > 0) process.exit(1);
