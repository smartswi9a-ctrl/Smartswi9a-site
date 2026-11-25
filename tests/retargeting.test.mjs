#!/usr/bin/env node
/* ============================================================
   TESTS : RECIBLAGE INTELLIGENT (10 règles) + rotation + emails
   ------------------------------------------------------------
   Vérifie les décisions pures (aucun réseau, aucun Firebase) :
   visite 500→400, expiration 30 j, digest, panier abandonné,
   push avant email, plafond 3/7, créneaux Maroc, stock faible,
   cycle 10:1, et l'isolation du module client (lecture seule).
   Usage : node tests/retargeting.test.mjs
   ============================================================ */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const core = require(path.join(ROOT, "functions", "retargeting-core.js"));
const rotation = require(path.join(ROOT, "functions", "rotation-core.js"));
const policy = require(path.join(ROOT, "functions", "email-policy.js"));

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

const NOW = Date.parse("2026-11-24T14:00:00Z"); // 15h00 Casablanca (pic)
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function view(overrides = {}) {
  return {
    uid: "uid1",
    productId: "p1",
    seenPrice: 500,
    viewCount: 2,
    engaged: true,
    inAbandonedCart: false,
    lastViewedAtMs: NOW - HOUR,
    promoEmailSent: false,
    lowStockAlertSent: false,
    promoEmailTimestamps: [],
    ...overrides
  };
}

/* ---------- Règle 1 : visite préalable + baisse significative ---------- */

check("500 MAD vu → 400 MAD : client éligible", () => {
  const { eligible, rejected } = core.rankCandidates([view()], { newPrice: 400, nowMs: NOW });
  assert.equal(eligible.length, 1);
  assert.equal(rejected.notSeen, 0);
});

check("client n'ayant jamais visité : jamais éligible", () => {
  const { eligible } = core.rankCandidates([], { newPrice: 400, nowMs: NOW });
  assert.equal(eligible.length, 0);
  assert.equal(core.isEligibleView({ seenPrice: 400, newPrice: 400 }), false);
});

check("déjà acheté ou email déjà envoyé : exclu", () => {
  const purchased = view({ purchased: true });
  const sent = view({ promoEmailSent: true });
  assert.equal(core.rankCandidates([purchased], { newPrice: 300, nowMs: NOW }).eligible.length, 0);
  assert.equal(core.rankCandidates([sent], { newPrice: 300, nowMs: NOW }).eligible.length, 0);
});

/* ---------- Règle 4 : baisse >= 10 % ou >= 30 MAD ---------- */

check("baisse trop faible : 500 → 475 (25 MAD, 5 %) refusée", () => {
  assert.equal(core.isSignificantDrop(500, 475), false);
  assert.equal(core.isSignificantDrop(500, 470), true, "30 MAD pile = accepté");
  assert.equal(core.isSignificantDrop(500, 449), true, "10,2 %");
  assert.equal(core.isSignificantDrop(200, 170), true, "30 MAD pile");
});

/* ---------- Règle 2 : expiration 30 jours ---------- */

check("visite de plus de 30 jours : ignorée", () => {
  const old = view({ lastViewedAtMs: NOW - 31 * DAY });
  const fresh = view({ lastViewedAtMs: NOW - 29 * DAY });
  assert.equal(core.isFresh(old.lastViewedAtMs, NOW), false);
  assert.equal(core.isFresh(fresh.lastViewedAtMs, NOW), true);
  assert.equal(core.rankCandidates([old], { newPrice: 300, nowMs: NOW }).eligible.length, 0);
});

/* ---------- Règle 3 : intérêt réel ---------- */

check("intérêt réel : 2 visites, 20 s ou panier abandonné", () => {
  assert.equal(core.isEngaged({ viewCount: 1, engaged: false }), false);
  assert.equal(core.isEngaged({ viewCount: 2 }), true);
  assert.equal(core.isEngaged({ viewCount: 1, engaged: true }), true);
  assert.equal(core.isEngaged({ viewCount: 1, inAbandonedCart: true }), true);
});

/* ---------- Règle 5 : priorité panier abandonné ---------- */

check("panier abandonné classé avant les autres", () => {
  const normal = view({ uid: "a", seenPrice: 900 });
  const abandoned = view({ uid: "b", seenPrice: 600, inAbandonedCart: true });
  const { eligible } = core.rankCandidates([normal, abandoned], { newPrice: 400, nowMs: NOW });
  assert.equal(eligible[0].uid, "b");
});

/* ---------- Règle 7 : push gratuit d'abord ---------- */

check("push actif sans panier : aucun email consommé", () => {
  const choice = core.chooseChannel({ view: view(), hasPush: true, quotaRemaining: 100, nowMs: NOW });
  assert.equal(choice.channel, "push");
  assert.equal(choice.reason, "push_available");
});

check("sans push : email autorisé en heure de pic", () => {
  const choice = core.chooseChannel({ view: view(), hasPush: false, quotaRemaining: 100, nowMs: NOW });
  assert.equal(choice.channel, "email");
});

check("panier abandonné : email même si push actif", () => {
  const choice = core.chooseChannel({
    view: view({ inAbandonedCart: true }),
    hasPush: true,
    quotaRemaining: 100,
    nowMs: NOW
  });
  assert.equal(choice.channel, "email");
  assert.equal(choice.reason, "abandoned_cart");
});

check("quota promotionnel épuisé : 100 % push", () => {
  const choice = core.chooseChannel({ view: view(), hasPush: false, quotaRemaining: 0, nowMs: NOW });
  assert.equal(choice.channel, "push");
  assert.equal(choice.reason, "quota_reached");
});

/* ---------- Règle 8 : plafond 3 emails / 7 jours ---------- */

check("plafond 3 emails sur 7 jours glissants", () => {
  const three = [NOW - DAY, NOW - 2 * DAY, NOW - 3 * DAY];
  assert.equal(core.withinFatigueCap(three, NOW), false);
  assert.equal(core.withinFatigueCap(three.slice(0, 2), NOW), true);
  assert.equal(core.withinFatigueCap([NOW - 8 * DAY, NOW - 9 * DAY, NOW - 10 * DAY], NOW), true);
  const choice = core.chooseChannel({
    view: view({ promoEmailTimestamps: three }),
    hasPush: false,
    quotaRemaining: 50,
    nowMs: NOW
  });
  assert.equal(choice.channel, "push");
  assert.equal(choice.reason, "fatigue_cap");
});

/* ---------- Règle 9 : créneaux de pic Maroc ---------- */

check("heures de pic : 15h envoi immédiat, 23h programmé à 11h30", () => {
  assert.equal(core.isPeakWindow(Date.parse("2026-11-24T14:00:00Z")), true, "15h00 Casablanca");
  assert.equal(core.isPeakWindow(Date.parse("2026-11-24T22:00:00Z")), false, "23h00 Casablanca");
  const night = Date.parse("2026-11-24T22:00:00Z");
  assert.equal(new Date(core.nextPeakSlot(night)).toISOString(), "2026-11-25T10:30:00.000Z");
  const choice = core.chooseChannel({ view: view(), hasPush: false, quotaRemaining: 50, nowMs: night });
  assert.equal(choice.channel, "schedule");
});

check("créneau du soir 20h00 quand il est 15h", () => {
  const slot = core.nextPeakSlot(Date.parse("2026-11-24T14:00:00Z"));
  assert.equal(new Date(slot).toISOString(), "2026-11-24T19:00:00.000Z");
});

/* ---------- Règle 6 : digest unique ---------- */

check("digest : plusieurs baisses = 1 seul email récapitulatif", () => {
  const digest = core.buildDigest(
    [
      { productId: "p1", title: "A", seenPrice: 500, newPrice: 400 },
      { productId: "p2", title: "B", seenPrice: 300, newPrice: 250 }
    ],
    NOW
  );
  assert.equal(digest.count, 2);
  assert.equal(digest.totalDrop, 150);
  assert.match(digest.title, /2 articles/);
  assert.equal(core.buildDigest([], NOW), null);
});

/* ---------- Règle 10 : stock faible ---------- */

check("stock faible : visité + engagé + non acheté uniquement", () => {
  assert.equal(core.shouldAlertLowStock({ stock: 2, view: view(), nowMs: NOW }), true);
  assert.equal(core.shouldAlertLowStock({ stock: 4, view: view(), nowMs: NOW }), false);
  assert.equal(core.shouldAlertLowStock({ stock: 0, view: view(), nowMs: NOW }), false);
  assert.equal(core.shouldAlertLowStock({ stock: 2, view: view({ lowStockAlertSent: true }), nowMs: NOW }), false);
  assert.equal(core.shouldAlertLowStock({ stock: 2, view: view({ lastViewedAtMs: NOW - 40 * DAY }), nowMs: NOW }), false);
  assert.equal(core.shouldAlertLowStock({ stock: 2, view: view({ purchased: true }), nowMs: NOW }), false);
});

/* ---------- Rotation 10:1 ---------- */

check("cycle 10 produits > 500 MAD puis 1 ≤ 500 MAD puis reset", () => {
  let state = { premiumCount: 0, lowPriceQueue: [] };
  for (let i = 0; i < 10; i += 1) {
    const decision = rotation.decideRotation(state, 700, "p" + i);
    assert.equal(decision.broadcast, true);
    state = { premiumCount: decision.premiumCount, lowPriceQueue: decision.lowPriceQueue };
  }
  assert.equal(state.premiumCount, 10);
  const low = rotation.decideRotation(state, 300, "cheap");
  assert.equal(low.broadcast, true);
  assert.equal(low.premiumCount, 0);
});

/* ---------- Emails : 5 autorisés, 0 admin ---------- */

check("emails autorisés : 4 vendeur + 1 client, jamais l'admin", () => {
  assert.equal(policy.SELLER_TYPES.length, 4);
  assert.equal(policy.CLIENT_TYPES.length, 1);
  for (const type of [...policy.SELLER_TYPES, ...policy.CLIENT_TYPES, "promo_digest", "campaign"]) {
    assert.equal(policy.shouldSendEmail("admin", type), false, "admin ne doit jamais recevoir " + type);
  }
});

/* ---------- Isolation du module client ---------- */

check("tracker client : 100 % lecture seule, aucun module métier importé", () => {
  const src = read("js/retargeting.js");
  assert.ok(src.includes("localStorage.getItem"), "la lecture du panier est autorisée");
  assert.equal(/localStorage\.(setItem|removeItem|clear)/.test(src), false, "aucune écriture localStorage");
  assert.equal(/from ['"]\.\/(cart|store|products|app)\.js['"]/.test(src), false, "aucun import métier");
  assert.ok(read("produit.html").includes("/js/retargeting.js"));
});

/* ---------- Règles Firestore ---------- */

check("règles : product_views propriétaire + scheduled_emails serveur only", () => {
  const rules = read("firestore.rules");
  assert.ok(
    /match \/product_views\/\{viewId\}[\s\S]*?request\.resource\.data\.get\('uid', ''\) == request\.auth\.uid/.test(rules)
  );
  assert.ok(/match \/scheduled_emails\/\{docId\}[\s\S]*?allow write: if false/.test(rules));
});

/* ---------- SVG mouton Aïd el-Adha ---------- */

check("SVG mouton : viewBox 64x52, toison, cornes, sabots", () => {
  const src = read("js/events-calendar.js");
  const start = src.indexOf("sheep:");
  const sheep = src.slice(start, src.indexOf("tag:", start));
  for (const token of ['viewBox="0 0 64 52"', "#FFFDF7", "#9A6B26", "#C89B3C", "#4A3219"]) {
    assert.ok(sheep.includes(token), "élément manquant : " + token);
  }
  assert.ok(read("events.css").includes(".event-deco__icon.is-sheep"));
});

/* ---------- Bilan ---------- */

console.log("\n" + (checks - failures) + "/" + checks + " vérifications OK");
if (failures > 0) {
  console.error(failures + " échec(s)");
  process.exit(1);
}
