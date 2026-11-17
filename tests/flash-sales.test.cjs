#!/usr/bin/env node
/* ============================================================
   TESTS : logique de vente flash (js/flash-sales.js)
   ------------------------------------------------------------
   Couvre les fonctions PURES (aucun Firestore, aucun DOM) :
     isFlashSaleLive, computeFlashPrice.
   Les regles testees sont celles qui protegent l argent :
     - une remise ne rend jamais le prix negatif ;
     - une remise ne depasse jamais le prix initial ;
     - une vente hors fenetre ou epuisee n est PAS live ;
     - un pourcentage > 100 est borne a 100.

   Usage : node tests/flash-sales.test.cjs
   ============================================================ */
'use strict';

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "js", "flash-sales.js");
const src = fs.readFileSync(SRC, "utf8");

/* On extrait uniquement les fonctions pures : le module importe firebase
   et utils, indisponibles hors navigateur. */
function extractPureFns() {
  const start = src.indexOf("export function isFlashSaleLive");
  const end = src.indexOf("loadLiveFlashSales");
  assert.ok(start >= 0 && end > start, "bloc des fonctions pures introuvable");
  /* On recule jusqu au debut du commentaire JSDoc de loadLiveFlashSales. */
  const cut = src.lastIndexOf("/**", end);
  let body = src.slice(start, cut > start ? cut : end);
  body = body.replace(/export /g, "");
  return body + "\n; ({ isFlashSaleLive, computeFlashPrice })";
}

/* toDate simplifie pour le sandbox : accepte Date | Timestamp-like | string. */
const toDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && typeof v.toDate === "function") return v.toDate();
  if (typeof v === "object" && v.seconds != null) return new Date(v.seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const sandbox = { toDate, Math, Date, Number, console };
vm.createContext(sandbox);
const api = vm.runInContext(extractPureFns(), sandbox);
const { isFlashSaleLive, computeFlashPrice } = api;

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log("PASS: " + name); }
  catch (e) { results.push({ name, ok: false }); console.log("FAIL: " + name + " -> " + e.message); }
}

const NOW = new Date("2026-11-16T12:00:00Z");
const PAST = new Date("2026-11-15T12:00:00Z");
const FUTURE = new Date("2026-11-17T12:00:00Z");

function sale(over) {
  return {
    id: "fs1",
    status: "active",
    startsAt: PAST,
    endsAt: FUTURE,
    discountType: "percent",
    discountValue: 20,
    productIds: ["p1"],
    soldCount: 0,
    maxQuantity: null,
    ...over
  };
}

/* ---------------- isFlashSaleLive ---------------- */

check("F1 : vente active dans la fenetre -> live", () => {
  assert.strictEqual(isFlashSaleLive(sale(), NOW), true);
});

check("F2 : vente pas encore commencee -> pas live", () => {
  assert.strictEqual(isFlashSaleLive(sale({ startsAt: FUTURE }), NOW), false);
});

check("F3 : vente terminee -> pas live", () => {
  assert.strictEqual(isFlashSaleLive(sale({ endsAt: PAST }), NOW), false);
});

check("F4 : statut different de active -> pas live", () => {
  assert.strictEqual(isFlashSaleLive(sale({ status: "draft" }), NOW), false);
  assert.strictEqual(isFlashSaleLive(sale({ status: "ended" }), NOW), false);
});

check("F5 : quantite maximale atteinte -> pas live", () => {
  assert.strictEqual(isFlashSaleLive(sale({ maxQuantity: 10, soldCount: 10 }), NOW), false);
  assert.strictEqual(isFlashSaleLive(sale({ maxQuantity: 10, soldCount: 9 }), NOW), true);
});

check("F6 : dates absentes -> pas live (fail-closed)", () => {
  assert.strictEqual(isFlashSaleLive(sale({ startsAt: null }), NOW), false);
  assert.strictEqual(isFlashSaleLive(sale({ endsAt: null }), NOW), false);
});

/* ---------------- computeFlashPrice ---------------- */

check("F7 : -20% sur 100 -> 80 (remise 20, 20%)", () => {
  const r = computeFlashPrice(100, sale());
  assert.strictEqual(r.finalPrice, 80);
  assert.strictEqual(r.discount, 20);
  assert.strictEqual(r.percent, 20);
});

check("F8 : remise fixe 30 sur 100 -> 70", () => {
  const r = computeFlashPrice(100, sale({ discountType: "fixed", discountValue: 30 }));
  assert.strictEqual(r.finalPrice, 70);
  assert.strictEqual(r.discount, 30);
});

check("F9 : remise fixe superieure au prix -> prix 0, jamais negatif", () => {
  const r = computeFlashPrice(25, sale({ discountType: "fixed", discountValue: 100 }));
  assert.strictEqual(r.finalPrice, 0);
  assert.strictEqual(r.discount, 25);
});

check("F10 : pourcentage > 100 borne a 100 -> prix 0", () => {
  const r = computeFlashPrice(100, sale({ discountValue: 250 }));
  assert.strictEqual(r.finalPrice, 0);
  assert.strictEqual(r.discount, 100);
});

check("F11 : vente non live -> prix initial inchange, remise 0", () => {
  const r = computeFlashPrice(100, sale({ status: "ended" }));
  assert.strictEqual(r.finalPrice, 100);
  assert.strictEqual(r.discount, 0);
  assert.strictEqual(r.percent, 0);
});

check("F12 : sale null -> prix initial", () => {
  const r = computeFlashPrice(49, null);
  assert.strictEqual(r.finalPrice, 49);
});

check("F13 : prix invalide -> 0 sans exception", () => {
  assert.strictEqual(computeFlashPrice(undefined, sale()).finalPrice, 0);
  assert.strictEqual(computeFlashPrice("abc", sale()).finalPrice, 0);
});

check("F14 : remise arrondie a l entier (pas de centimes)", () => {
  const r = computeFlashPrice(99, sale({ discountValue: 15 }));
  assert.strictEqual(Number.isInteger(r.finalPrice), true);
  assert.strictEqual(r.finalPrice, 84); /* 99 * 0.15 = 14.85 -> 15 */
});

const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " verifications PASS");
if (failed.length) {
  console.log("ECHECS: " + failed.map((f) => f.name).join(" | "));
  process.exit(1);
}
