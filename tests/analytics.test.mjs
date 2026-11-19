/* ============================================================
   tests/analytics.test.mjs
   GARDE-FOU : logique de mesure d audience (js/analytics-core.js).
   ------------------------------------------------------------
   Verifie les calculs qui alimentent le dashboard admin :
     - cles de jour en UTC (pas de decalage de fuseau) ;
     - periodes jour / 7 jours / 30 jours / 365 jours ;
     - visiteurs uniques dedoublonnes sur la periode ;
     - visiteurs en ligne (TTL) et repartition par page ;
     - exclusions (admin, vendor, reset-password...).

   Aucune dependance Firebase : le module est pur.
   ============================================================ */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  dayKey,
  dayKeysBetween,
  isTrackablePath,
  normalizeTrackedPath,
  shouldRecordView,
  aggregateTraffic,
  computeOnline,
  buildTrafficSeries,
  DAY_MS,
} from "../js/analytics-core.js";

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

/* --------------------------------------------- cles de date */

check("dayKey : date UTC", () => {
  assert.strictEqual(dayKey(new Date("2026-11-18T00:00:00Z")), "2026-11-18");
  assert.strictEqual(dayKey(new Date("2026-11-18T23:59:59Z")), "2026-11-18");
});

check("dayKey : entree invalide -> null", () => {
  assert.strictEqual(dayKey(new Date("nope")), null);
});

check("dayKeysBetween : 7 cles consecutives", () => {
  const keys = dayKeysBetween(
    new Date("2026-11-12T00:00:00Z"),
    new Date("2026-11-18T00:00:00Z")
  );
  assert.strictEqual(keys.length, 7);
  assert.strictEqual(keys[0], "2026-11-12");
  assert.strictEqual(keys[6], "2026-11-18");
});

check("dayKeysBetween : bornes inversees -> vide", () => {
  const keys = dayKeysBetween(
    new Date("2026-11-18T00:00:00Z"),
    new Date("2026-11-12T00:00:00Z")
  );
  assert.strictEqual(keys.length, 0);
});

/* --------------------------------------------- chemins */

check("isTrackablePath : pages publiques mesurees", () => {
  assert.strictEqual(isTrackablePath("/"), true);
  assert.strictEqual(isTrackablePath("/koulchi"), true);
  assert.strictEqual(isTrackablePath("/boutique.html"), true);
  assert.strictEqual(isTrackablePath("/produit"), true);
});

check("isTrackablePath : back-office exclu", () => {
  assert.strictEqual(isTrackablePath("/admin"), false);
  assert.strictEqual(isTrackablePath("/admin.html"), false);
  assert.strictEqual(isTrackablePath("/vendor/dashboard"), false);
  assert.strictEqual(isTrackablePath("/vendor-login.html"), false);
  assert.strictEqual(isTrackablePath("/reset-password"), false);
  assert.strictEqual(isTrackablePath("/generer-villes.html"), false);
});

check("normalizeTrackedPath : query et ancre retirees", () => {
  assert.strictEqual(normalizeTrackedPath("/produit?slug=abc#avis"), "/produit");
  assert.strictEqual(normalizeTrackedPath(""), "/");
  assert.strictEqual(normalizeTrackedPath("/" + "x".repeat(300)).length, 120);
});

/* --------------------------------------------- dedup */

check("shouldRecordView : une vue par session et par jour", () => {
  assert.strictEqual(shouldRecordView("", "2026-11-18", "s1"), true);
  assert.strictEqual(shouldRecordView("2026-11-18|s1", "2026-11-18", "s1"), false);
  assert.strictEqual(shouldRecordView("2026-11-17|s1", "2026-11-18", "s1"), true);
  assert.strictEqual(shouldRecordView("2026-11-18|s2", "2026-11-18", "s1"), true);
  assert.strictEqual(shouldRecordView("", null, "s1"), false);
});

/* --------------------------------------------- agregations */

const NOW = new Date("2026-11-18T12:00:00Z");
const ENTRIES = [
  { id: "2026-11-18", views: 5, visitors: ["v1", "v2"] },
  { id: "2026-11-17", views: 3, visitors: ["v2", "v3"] },
  { id: "2026-10-01", views: 10, visitors: ["v4"] },
  { id: "2025-01-01", views: 100, visitors: ["v5"] },
  { id: "pas-une-date", views: 999, visitors: ["v9"] },
];

check("aggregateTraffic : doc anonyme (vues sans identifiant)", () => {
  const docs = [{ id: "2026-11-18", views: 4 }];
  const t = aggregateTraffic(docs, NOW);
  assert.strictEqual(t.today.views, 4);
  assert.strictEqual(t.today.visitors, 0);
  const s = buildTrafficSeries(docs, 1, NOW);
  assert.strictEqual(s[0].views, 4);
  assert.strictEqual(s[0].visitors, 0);
});

check("aggregateTraffic : aujourd hui", () => {
  const t = aggregateTraffic(ENTRIES, NOW);
  assert.strictEqual(t.today.views, 5);
  assert.strictEqual(t.today.visitors, 2);
});

check("aggregateTraffic : 7 jours (vues + uniques dedoublonnes)", () => {
  const t = aggregateTraffic(ENTRIES, NOW);
  assert.strictEqual(t.week.views, 8);
  assert.strictEqual(t.week.visitors, 3);
});

check("aggregateTraffic : 30 jours exclut le 1er octobre", () => {
  const t = aggregateTraffic(ENTRIES, NOW);
  assert.strictEqual(t.month.views, 8);
  assert.strictEqual(t.month.visitors, 3);
});

check("aggregateTraffic : 12 mois inclut le 1er octobre", () => {
  const t = aggregateTraffic(ENTRIES, NOW);
  assert.strictEqual(t.year.views, 18);
  assert.strictEqual(t.year.visitors, 4);
});

check("aggregateTraffic : total et doc invalide ignore", () => {
  const t = aggregateTraffic(ENTRIES, NOW);
  assert.strictEqual(t.total.views, 118);
  assert.strictEqual(t.total.visitors, 5);
  assert.strictEqual(t.total.entries, 4);
});

check("aggregateTraffic : entrees vides ou nulles", () => {
  const t = aggregateTraffic(null, NOW);
  assert.strictEqual(t.today.views, 0);
  assert.strictEqual(t.week.visitors, 0);
  assert.strictEqual(t.total.entries, 0);
});

/* --------------------------------------------- en ligne */

const PRESENCES = [
  { path: "/", lastSeen: new Date(NOW.getTime() - 60 * 1000) },
  { path: "/koulchi", lastSeen: new Date(NOW.getTime() - 4 * 60 * 1000) },
  { path: "/koulchi", lastSeen: new Date(NOW.getTime() - 6 * 60 * 1000) },
  { path: "/produit?slug=x", lastSeen: new Date(NOW.getTime() - 30 * 1000) },
  { path: "/admin", lastSeen: new Date(NOW.getTime() - 10 * 1000) },
];

check("computeOnline : 3 en ligne dans les 5 minutes", () => {
  const o = computeOnline(PRESENCES, NOW);
  assert.strictEqual(o.count, 3);
});

check("computeOnline : page admin jamais comptee", () => {
  const o = computeOnline(PRESENCES, NOW);
  assert.strictEqual(o.pages.some((p) => p.path.startsWith("/admin")), false);
});

check("computeOnline : repartition par page", () => {
  const o = computeOnline(PRESENCES, NOW);
  assert.strictEqual(o.pages.length, 3);
  assert.strictEqual(o.pages.find((p) => p.path === "/koulchi").count, 1);
});

check("computeOnline : TTL personnalise", () => {
  const o = computeOnline(PRESENCES, NOW, 2 * 60 * 1000);
  assert.strictEqual(o.count, 2);
});

check("computeOnline : entrees invalides ignorees", () => {
  const o = computeOnline([null, { path: "/" }, { lastSeen: "nope" }], NOW);
  assert.strictEqual(o.count, 0);
});

check("DAY_MS : 24 heures", () => {
  assert.strictEqual(DAY_MS, 86400000);
});

/* --------------------------------------------- serie du graphique */

check("buildTrafficSeries : 14 points, du plus ancien a aujourd hui", () => {
  const s = buildTrafficSeries(ENTRIES, 14, NOW);
  assert.strictEqual(s.length, 14);
  assert.strictEqual(s[13].date, "2026-11-18");
  assert.strictEqual(s[12].date, "2026-11-17");
});

check("buildTrafficSeries : valeurs et jours vides a zero", () => {
  const s = buildTrafficSeries(ENTRIES, 14, NOW);
  assert.strictEqual(s[13].views, 5);
  assert.strictEqual(s[13].visitors, 2);
  assert.strictEqual(s[12].views, 3);
  assert.strictEqual(s[0].views, 0);
  assert.strictEqual(s[0].visitors, 0);
});

check("buildTrafficSeries : bornes 1 a 365", () => {
  assert.strictEqual(buildTrafficSeries(ENTRIES, 0, NOW).length, 1);
  assert.strictEqual(buildTrafficSeries(ENTRIES, 9999, NOW).length, 365);
});

check("buildTrafficSeries : entrees invalides ignorees", () => {
  const s = buildTrafficSeries(null, 7, NOW);
  assert.strictEqual(s.length, 7);
  assert.strictEqual(s.every((d) => d.views === 0 && d.visitors === 0), true);
});

/* --------------------------------------------- collecte (source) */

check("collecte : vues anonymes pour tous, identifiant seulement si consentement", () => {
  const src = readFileSync(new URL("../js/analytics.js", import.meta.url), "utf8");

  /* 1. Compteur anonyme : aucune donnee identifiante. */
  const anon = src.match(/export function trackAnonymousView\(\)[\s\S]*?^}/m);
  assert.ok(anon, "trackAnonymousView introuvable");
  assert.match(anon[0], /views: increment\(1\)/);
  assert.doesNotMatch(anon[0], /visitors/);
  assert.doesNotMatch(anon[0], /getVisitorId|getSessionId/);

  /* 2. Vue consentie : identifiant seul (pas de double comptage). */
  const consent = src.match(/async function recordConsentedView\(\)[\s\S]*?^}/m);
  assert.ok(consent, "recordConsentedView introuvable");
  assert.match(consent[0], /visitors: arrayUnion\(getVisitorId\(\)\)/);
  assert.doesNotMatch(consent[0], /views: increment/);

  /* 3. La vue anonyme est comptee avant le test de consentement. */
  const init = src.match(/export function initAnalytics\(\)[\s\S]*?^}/m);
  assert.ok(init, "initAnalytics introuvable");
  const posAnon = init[0].indexOf("trackAnonymousView()");
  const posConsent = init[0].indexOf("hasAnalyticsConsent()");
  assert.ok(posAnon >= 0, "trackAnonymousView doit etre appelee dans initAnalytics");
  assert.ok(posConsent > posAnon, "la vue anonyme doit preceder le test de consentement");
});

/* --------------------------------------------- resume */

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Mesure d audience : calculs verifies.");
