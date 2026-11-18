/* ============================================================
   tests/ranking.test.mjs
   Verifie le tri intelligent local (A1).
   Module pur : aucun DOM, aucun reseau.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"),
  ".."
);

const SRC = path.join(ROOT, "js", "ranking.js");
const TMP = path.join(ROOT, "js", "__ranking_test_tmp.mjs");

fs.copyFileSync(SRC, TMP);

let api;
try {
  api = await import(pathToFileURL(TMP).href);
} finally {
  try {
    fs.unlinkSync(TMP);
  } catch (_) {
    /* ignore */
  }
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

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/* --------------------------------------------- A1 */
console.log("\n--- A1 : decroissance ---");

check("A1a : moins de 7 jours -> plein", () => {
  assert.strictEqual(api.decayFactor(NOW - 6 * DAY, NOW), 1);
  assert.strictEqual(api.decayFactor(NOW, NOW), 1);
});

check("A1b : 7 a 30 jours -> moitie", () => {
  assert.strictEqual(api.decayFactor(NOW - 8 * DAY, NOW), 0.5);
  assert.strictEqual(api.decayFactor(NOW - 30 * DAY, NOW), 0.5);
});

check("A1c : plus de 30 jours -> ignore", () => {
  assert.strictEqual(api.decayFactor(NOW - 31 * DAY, NOW), 0);
});

check("A1d : date absente ou nulle -> 0", () => {
  assert.strictEqual(api.decayFactor(0, NOW), 0);
  assert.strictEqual(api.decayFactor(null, NOW), 0);
});

/* --------------------------------------------- A2 */
console.log("\n--- A2 : score pondere ---");

check("A2a : achat x5, clic x3, recherche x2", () => {
  const events = {
    p1: {
      purchase: { n: 1, t: NOW },
      click: { n: 1, t: NOW },
      search: { n: 1, t: NOW },
    },
  };
  assert.strictEqual(api.scoreProduct({ id: "p1" }, events, NOW), 10);
});

check("A2b : popularite x2 maximum", () => {
  const solde = api.scoreProduct(
    { id: "p2", salesCount: 500, ratingAvg: 5, ratingCount: 100 },
    {},
    NOW
  );
  assert.strictEqual(solde, 2);
});

check("A2c : promotion +1", () => {
  const promo = api.scoreProduct({ id: "p3", price: 100, oldPrice: 150 }, {}, NOW);
  assert.strictEqual(promo, 1);
});

check("A2d : vente flash compte comme promotion", () => {
  assert.strictEqual(api.isPromoted({ price: 100, flashPrice: 80 }), true);
  assert.strictEqual(api.isPromoted({ price: 100, flashPrice: 120 }), false);
});

check("A2e : produit inconnu -> score 0", () => {
  assert.strictEqual(api.scoreProduct({ id: "inconnu" }, {}, NOW), 0);
});

check("A2f : evenement vieux de 40 jours ignore", () => {
  const events = { p1: { purchase: { n: 3, t: NOW - 40 * DAY } } };
  assert.strictEqual(api.scoreProduct({ id: "p1" }, events, NOW), 0);
});

check("A2g : evenement de 10 jours divise par deux", () => {
  const events = { p1: { purchase: { n: 2, t: NOW - 10 * DAY } } };
  assert.strictEqual(api.scoreProduct({ id: "p1" }, events, NOW), 5);
});

/* --------------------------------------------- A3 */
console.log("\n--- A3 : ordre stable ---");

check("A3a : score le plus haut en premier", () => {
  const state = { seed: 42, events: { b: { purchase: { n: 2, t: NOW } } } };
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const sorted = api.sortByRelevance(list, state, NOW);
  assert.strictEqual(sorted[0].id, "b");
  assert.strictEqual(sorted.length, 3);
});

check("A3b : deux appels avec la meme graine donnent le meme ordre", () => {
  const state = { seed: 7, events: {} };
  const list = [{ id: "x" }, { id: "y" }, { id: "z" }, { id: "w" }];
  const first = api.sortByRelevance(list, state, NOW).map((p) => p.id);
  const second = api.sortByRelevance(list, state, NOW).map((p) => p.id);
  assert.deepStrictEqual(first, second);
});

check("A3c : graines differentes -> ordre different (ex aequo)", () => {
  const list = [{ id: "x" }, { id: "y" }, { id: "z" }, { id: "w" }];
  const a = api.sortByRelevance(list, { seed: 1, events: {} }, NOW).map((p) => p.id);
  const b = api.sortByRelevance(list, { seed: 999, events: {} }, NOW).map((p) => p.id);
  assert.notDeepStrictEqual(a, b);
});

check("A3d : jitter deterministe et borne", () => {
  const v1 = api.stableJitter("p1", 5);
  const v2 = api.stableJitter("p1", 5);
  assert.strictEqual(v1, v2);
  assert.strictEqual(v1 >= 0 && v1 < 1, true);
});

check("A3e : liste vide -> liste vide", () => {
  assert.deepStrictEqual(api.sortByRelevance([], { seed: 1, events: {} }, NOW), []);
  assert.deepStrictEqual(api.sortByRelevance(null, null, NOW), []);
});

/* --------------------------------------------- A4 */
console.log("\n--- A4 : graine de 6 h ---");

check("A4a : graine conservee avant 6 h", () => {
  const state = { seed: 123, seedAt: NOW - 5 * 60 * 60 * 1000, events: {} };
  const same = api.ensureSeed(state, NOW);
  assert.strictEqual(same.seed, 123);
});

check("A4b : graine renouvelee apres 6 h", () => {
  const state = { seed: 123, seedAt: NOW - 7 * 60 * 60 * 1000, events: {} };
  const rotated = api.ensureSeed(state, NOW);
  assert.notStrictEqual(rotated.seed, 123);
  assert.strictEqual(rotated.seedAt, NOW);
});

/* --------------------------------------------- A5 */
console.log("\n--- A5 : fusion sans perte ---");

check("A5a : union des produits et des types", () => {
  const local = { seed: 1, seedAt: NOW, events: { a: { click: { n: 1, t: NOW } } } };
  const remote = { seed: 1, seedAt: NOW, events: { b: { purchase: { n: 2, t: NOW } } } };
  const merged = api.mergeRanking(local, remote);
  assert.strictEqual(Boolean(merged.events.a), true);
  assert.strictEqual(Boolean(merged.events.b), true);
});

check("A5b : garde le plus grand compte et la date la plus recente", () => {
  const local = { seed: 1, seedAt: NOW, events: { a: { click: { n: 5, t: NOW - 2 * DAY } } } };
  const remote = { seed: 1, seedAt: NOW, events: { a: { click: { n: 2, t: NOW } } } };
  const merged = api.mergeRanking(local, remote);
  assert.strictEqual(merged.events.a.click.n, 5);
  assert.strictEqual(merged.events.a.click.t, NOW);
});

check("A5c : aucune source n ecrase l autre", () => {
  const local = { seed: 1, seedAt: NOW, events: { a: { search: { n: 3, t: NOW } } } };
  const remote = { seed: 1, seedAt: NOW, events: { a: { purchase: { n: 1, t: NOW - DAY } } } };
  const merged = api.mergeRanking(local, remote);
  assert.strictEqual(merged.events.a.search.n, 3);
  assert.strictEqual(merged.events.a.purchase.n, 1);
});

check("A5d : fusion avec une source vide", () => {
  const local = { seed: 1, seedAt: NOW, events: { a: { click: { n: 1, t: NOW } } } };
  const merged = api.mergeRanking(local, null);
  assert.strictEqual(merged.events.a.click.n, 1);
});

/* --------------------------------------------- A6 */
console.log("\n--- A6 : enregistrement et robustesse ---");

check("A6a : un evenement incremente et met la date a jour", () => {
  const state = { seed: 1, seedAt: NOW, events: {} };
  api.trackEvent(state, "a", "click", NOW);
  api.trackEvent(state, "a", "click", NOW + 1000);
  assert.strictEqual(state.events.a.click.n, 2);
  assert.strictEqual(state.events.a.click.t, NOW + 1000);
});

check("A6b : type inconnu ignore", () => {
  const state = { seed: 1, seedAt: NOW, events: {} };
  api.trackEvent(state, "a", "hack", NOW);
  assert.deepStrictEqual(state.events, {});
});

check("A6c : identifiant vide ignore", () => {
  const state = { seed: 1, seedAt: NOW, events: {} };
  api.trackEvent(state, "", "click", NOW);
  assert.deepStrictEqual(state.events, {});
});

check("A6d : donnee corrompue toleree", () => {
  const state = api.normalizeRanking({ events: { a: "nimporte" }, seed: "x" }, NOW);
  assert.deepStrictEqual(state.events, {});
  assert.strictEqual(state.seed > 0, true);
});

check("A6e : etat nul -> etat vide valide", () => {
  const state = api.normalizeRanking(null, NOW);
  assert.strictEqual(state.version, api.RANKING_VERSION);
  assert.strictEqual(typeof state.seed, "number");
});

/* --------------------------------------------- Resume */
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log("\n" + pass + "/" + results.length + " verifications PASS");
if (fail > 0) {
  console.log("ECHECS: " + results.filter((r) => !r.ok).map((r) => r.name).join(" | "));
  process.exit(1);
}
console.log("Tri intelligent : toutes les regles sont verifiees.");