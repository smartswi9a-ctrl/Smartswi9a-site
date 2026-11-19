/* ============================================================
   tests/traffic-chart.test.mjs
   GARDE-FOU : graphique SVG du trafic (js/traffic-chart.js).
   ------------------------------------------------------------
   Verifie que le SVG est bien forme, sans dependance, et que le
   nombre d elements correspond a la serie :
     - une barre et un point par jour ;
     - un axe avec au moins 3 libelles ;
     - aucune valeur NaN ni "undefined" ;
     - serie vide geree proprement.
   ============================================================ */

import assert from "node:assert";
import { buildTrafficSvg } from "../js/traffic-chart.js";
import { buildTrafficSeries } from "../js/analytics-core.js";

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

const SERIES = buildTrafficSeries(
  [
    { id: "2026-11-18", views: 12, visitors: ["a", "b", "c"] },
    { id: "2026-11-17", views: 5, visitors: ["a"] },
  ],
  7,
  new Date("2026-11-18T12:00:00Z")
);

check("buildTrafficSvg : balise svg complete", () => {
  const svg = buildTrafficSvg(SERIES);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(svg.includes('role="img"'));
  assert.ok(svg.includes("aria-label="));
  assert.ok(svg.includes("<title>"));
});

check("buildTrafficSvg : une barre et un point par jour", () => {
  const svg = buildTrafficSvg(SERIES);
  assert.strictEqual((svg.match(/<rect /g) || []).length, SERIES.length);
  assert.strictEqual((svg.match(/<circle /g) || []).length, SERIES.length);
});

check("buildTrafficSvg : ligne des visiteurs presente", () => {
  const svg = buildTrafficSvg(SERIES);
  assert.strictEqual((svg.match(/<polyline /g) || []).length, 1);
  const points = svg.match(/points="([^"]+)"/);
  assert.ok(points && points[1].split(" ").length === SERIES.length);
});

check("buildTrafficSvg : grille et libelles d axe", () => {
  const svg = buildTrafficSvg(SERIES);
  assert.ok((svg.match(/<line /g) || []).length >= 3);
  assert.ok((svg.match(/<text /g) || []).length >= 3);
});

check("buildTrafficSvg : aucune valeur invalide", () => {
  const svg = buildTrafficSvg(SERIES);
  assert.strictEqual(/NaN|undefined|null/.test(svg), false);
});

check("buildTrafficSvg : valeurs des derniers jours", () => {
  const svg = buildTrafficSvg(SERIES);
  assert.ok(svg.includes("2026-11-18 : 12 vue(s)"));
  assert.ok(svg.includes("2026-11-18 : 3 visiteur(s)"));
  assert.ok(svg.includes("2026-11-17 : 1 visiteur(s)"));
});

check("buildTrafficSvg : serie vide geree", () => {
  const svg = buildTrafficSvg([]);
  assert.ok(svg.includes("Aucune donnée"));
  assert.strictEqual(svg.includes("<svg"), false);
});

check("buildTrafficSvg : entrees invalides tolerees", () => {
  const svg = buildTrafficSvg([null, { views: 5 }, { date: "2026-11-18", views: -3 }]);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes("2026-11-18 : 0 vue(s)"));
});

check("buildTrafficSvg : options de taille", () => {
  const svg = buildTrafficSvg(SERIES, { width: 400, height: 160 });
  assert.ok(svg.includes('viewBox="0 0 400 160"'));
});

/* Le navigateur rejette height="auto" sur un <svg> (attribut de longueur) :
   "Expected length, auto". La hauteur auto doit passer par le style. */
check("buildTrafficSvg : hauteur auto en CSS, jamais en attribut", () => {
  const svg = buildTrafficSvg(SERIES);
  assert.strictEqual(/<svg[^>]*height="auto"/.test(svg), false);
  assert.strictEqual(/style="[^"]*height:auto/.test(svg), true);
});

/* --------------------------------------------- resume */

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Graphique du trafic : SVG verifie.");
