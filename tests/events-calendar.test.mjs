#!/usr/bin/env node
/* ============================================================
   TESTS : calendrier des bannières saisonnières
   (js/events-calendar.js + events.css)
   ------------------------------------------------------------
   Couvre uniquement les fonctions PURES (aucun DOM, aucun réseau) :
     - conversion heure murale Africa/Casablanca -> UTC ;
     - priorité Ramadan 2027 > Soldes d'hiver 2027 ;
     - bornes exclusives et retour à la bannière par défaut ;
     - `?preview_event=` (id, alias, nom de fichier, default) ;
     - présence réelle des 11 WebP dans assets/ ;
     - absence totale d'ancien système (cadres, overlays, décors).

   Usage : node tests/events-calendar.test.mjs
   ============================================================ */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASSETS_VERSION,
  DECOR_THEMES,
  DEFAULT_IMAGE,
  EVENTS,
  decorThemeFor,
  eventImageUrl,
  findEvent,
  moroccoOffsetMinutes,
  nextTransitionAt,
  normalizeEvent,
  normalizeEvents,
  parsePreviewParam,
  parseWallClock,
  resolveEventAt,
  zonedParts,
} from "../js/events-calendar.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "assets");

let verifications = 0;
let echecs = 0;

function ok(nom) {
  verifications++;
  console.log("PASS: " + nom);
}

function ko(nom, detail) {
  verifications++;
  echecs++;
  console.error("ECHEC: " + nom + (detail ? " -> " + detail : ""));
}

function check(nom, fn) {
  try {
    fn();
    ok(nom);
  } catch (error) {
    ko(nom, error.message);
  }
}

const iso = (ms) => new Date(ms).toISOString();
const localMs = (wall) => parseWallClock(wall);
const at = (utcIso) => new Date(utcIso).getTime();

/**
 * Lit les dimensions d'un WebP sans dépendance externe.
 * Gère VP8X (étendu), VP8 (lossy) et VP8L (lossless).
 * @param {string} file
 * @returns {{width:number,height:number}|null}
 */
function readWebpSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WEBP") return null;

  const type = buf.toString("ascii", 12, 16);

  if (type === "VP8X") {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }

  if (type === "VP8 ") {
    if (buf[20] & 0x01) return null; /* pas une keyframe */
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }

  if (type === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }

  return null;
}

/* ------------------------------------------------------------
   1. Calendrier embarqué : 11 visuels, cohérents et présents
   ------------------------------------------------------------ */

check("11 événements déclarés", () => {
  assert.equal(EVENTS.length, 11);
});

check("identifiants uniques", () => {
  const ids = EVENTS.map((ev) => ev.id);
  assert.equal(new Set(ids).size, 11);
});

check("chaque plage est valide (début < fin)", () => {
  for (const ev of EVENTS) {
    const start = localMs(ev.start);
    const end = localMs(ev.end);
    assert.ok(start != null && end != null, ev.id + " : date illisible");
    assert.ok(end > start, ev.id + " : fin <= début");
  }
});

check("priorités uniquement 1 ou 2", () => {
  for (const ev of EVENTS) {
    assert.ok(ev.priority === 1 || ev.priority === 2, ev.id);
  }
});

check("les 11 WebP existent dans assets/", () => {
  for (const ev of EVENTS) {
    const file = path.join(ASSETS, path.basename(ev.image));
    assert.ok(fs.existsSync(file), "absent : " + ev.image);
    assert.ok(fs.statSync(file).size > 1000, "fichier vide : " + ev.image);
  }
});

check("les 11 WebP mesurent exactement 2179x722", () => {
  for (const ev of EVENTS) {
    const size = readWebpSize(path.join(ASSETS, path.basename(ev.image)));
    assert.ok(size, "dimensions illisibles : " + ev.image);
    assert.equal(size.width, 2179, ev.id + " : largeur");
    assert.equal(size.height, 722, ev.id + " : hauteur");
  }
});

check("newphoto.webp a la même taille (parité stricte)", () => {
  const size = readWebpSize(path.join(ASSETS, "newphoto.webp"));
  assert.deepEqual(size, { width: 2179, height: 722 });
});

check("aucun ancien cadre frame-* dans assets/", () => {
  const frames = fs
    .readdirSync(ASSETS)
    .filter((name) => /^frame-.*\.webp$/i.test(name));
  assert.deepEqual(frames, []);
});

/* ------------------------------------------------------------
   2. Fuseau Africa/Casablanca (UTC+1, puis UTC+0 au Ramadan)
   ------------------------------------------------------------ */

check("Black Friday 2026 : 25/11 00:00 Casablanca = 24/11 23:00 UTC", () => {
  assert.equal(iso(localMs("2026-11-25T00:00:00")), "2026-11-24T23:00:00.000Z");
});

check("Ramadan 2027 : passage à UTC+0 (03/2027 = 00:00 UTC)", () => {
  assert.equal(iso(localMs("2027-03-01T00:00:00")), "2027-03-01T00:00:00.000Z");
});

check("règle légale Maroc : +60 min hors Ramadan, 0 pendant", () => {
  assert.equal(moroccoOffsetMinutes(at("2026-11-25T00:00:00Z")), 60);
  assert.equal(moroccoOffsetMinutes(at("2027-01-10T00:00:00Z")), 60);
  assert.equal(moroccoOffsetMinutes(at("2027-03-01T00:00:00Z")), 0);
  assert.equal(moroccoOffsetMinutes(at("2027-05-07T00:00:00Z")), 60);
  assert.equal(moroccoOffsetMinutes(at("2027-12-05T00:00:00Z")), 60);
});

check("aller-retour horaire pour les 22 bornes", () => {
  for (const ev of EVENTS) {
    for (const wall of [ev.start, ev.end]) {
      const ms = localMs(wall);
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(wall);
      const p = zonedParts(ms);
      assert.equal(p.year, Number(m[1]), wall);
      assert.equal(p.month, Number(m[2]), wall);
      assert.equal(p.day, Number(m[3]), wall);
      assert.equal(p.hour, Number(m[4]), wall);
      assert.equal(p.minute, Number(m[5]), wall);
      assert.equal(p.second, Number(m[6]), wall);
    }
  }
});

/* ------------------------------------------------------------
   3. Résolution par priorité
   ------------------------------------------------------------ */

check("25/11/2026 12:00 UTC -> Black Friday 2026", () => {
  assert.equal(resolveEventAt(at("2026-11-25T12:00:00Z")).id, "hero-black-friday");
});

check("10/01/2027 -> Soldes d'hiver", () => {
  assert.equal(resolveEventAt(at("2027-01-10T12:00:00Z")).id, "hero-winter-sales");
});

check("15/02/2027 -> Ramadan (priorité 2 sur Soldes d'hiver)", () => {
  const active = resolveEventAt(at("2027-02-15T12:00:00Z"));
  assert.equal(active.id, "hero-ramadan");
  assert.equal(active.priority, 2);
});

check("01/03/2027 (UTC+0) -> Ramadan", () => {
  assert.equal(resolveEventAt(at("2027-03-01T12:00:00Z")).id, "hero-ramadan");
});

check("09/03/2027 00:00 Casablanca -> Aïd el-Fitr (fin Ramadan exclusive)", () => {
  assert.equal(resolveEventAt(localMs("2027-03-09T00:00:00")).id, "hero-eid-fitr");
});

check("02/12/2026 -> bannière par défaut (aucun événement)", () => {
  assert.equal(resolveEventAt(at("2026-12-02T12:00:00Z")), null);
});

check("03/01/2028 -> bannière par défaut (fin du calendrier)", () => {
  assert.equal(resolveEventAt(at("2028-01-03T12:00:00Z")), null);
});

check("fin de Black Friday 2026 exclusive (01/12 00:00 local)", () => {
  assert.equal(resolveEventAt(localMs("2026-12-01T00:00:00")), null);
});

/* ------------------------------------------------------------
   4. Prochaine bascule (minuteur unique)
   ------------------------------------------------------------ */

check("prochaine bascule le 24/11/2026 à 23:00 UTC", () => {
  const next = nextTransitionAt(at("2026-11-24T12:00:00Z"));
  assert.equal(iso(next.at), "2026-11-24T23:00:00.000Z");
  assert.equal(next.type, "start");
  assert.equal(next.eventId, "hero-black-friday");
});

/* ------------------------------------------------------------
   5. Prévisualisation par URL
   ------------------------------------------------------------ */

check("parsePreviewParam lit ?preview_event=", () => {
  assert.equal(parsePreviewParam("?preview_event=hero-ramadan"), "hero-ramadan");
  assert.equal(parsePreviewParam("preview_event=hero1111"), "hero1111");
  assert.equal(parsePreviewParam("?foo=1"), null);
});

check("findEvent accepte id, alias, .webp et hero1111", () => {
  assert.equal(findEvent(EVENTS, "hero-ramadan").id, "hero-ramadan");
  assert.equal(findEvent(EVENTS, "ramadan").id, "hero-ramadan");
  assert.equal(findEvent(EVENTS, "hero-black-friday.webp").id, "hero-black-friday");
  assert.equal(findEvent(EVENTS, "hero1111").id, "hero1111");
  assert.equal(findEvent(EVENTS, "black-friday-2027").id, "hero-black-friday-2027");
  assert.equal(findEvent(EVENTS, "default"), null);
});

check("URL d'image versionnée (cache-busting)", () => {
  assert.equal(ASSETS_VERSION, "8");
  assert.equal(
    eventImageUrl(findEvent(EVENTS, "hero-christmas-2027")),
    "/assets/hero-christmas-2027.webp?v=8"
  );
});

/* ------------------------------------------------------------
   6. Robustesse Firestore (données invalides rejetées)
   ------------------------------------------------------------ */

check("normalizeEvent rejette une URL externe", () => {
  const bad = normalizeEvent({
    id: "hack",
    image: "https://evil.example/x.webp",
    start: "2027-01-01T00:00:00",
    end: "2027-01-02T00:00:00",
    priority: 2,
  });
  assert.equal(bad, null);
});

check("normalizeEvent rejette une plage inversée", () => {
  const bad = normalizeEvent({
    id: "bad",
    image: "/assets/hero-ramadan.webp",
    start: "2027-02-10T00:00:00",
    end: "2027-02-01T00:00:00",
    priority: 1,
  });
  assert.equal(bad, null);
});

check("normalizeEvents dédoublonne et trie", () => {
  const list = normalizeEvents([
    { id: "b", image: "/assets/hero-christmas.webp", start: "2026-12-05T00:00:00", end: "2027-01-02T00:00:00", priority: 1 },
    { id: "a", image: "/assets/hero-black-friday.webp", start: "2026-11-25T00:00:00", end: "2026-12-01T00:00:00", priority: 1 },
    { id: "a", image: "/assets/hero-black-friday.webp", start: "2026-11-25T00:00:00", end: "2026-12-01T00:00:00", priority: 1 },
  ]);
  assert.deepEqual(list.map((ev) => ev.id), ["a", "b"]);
});

/* ------------------------------------------------------------
   7. Garde-fous de réinitialisation (aucun ancien système)
   ------------------------------------------------------------ */

check("events.css : ratio verrouillé et cadre unique", () => {
  const css = fs.readFileSync(path.join(ROOT, "events.css"), "utf8").toLowerCase();
  assert.ok(css.includes("aspect-ratio: 2179 / 722"), "ratio 2179/722 absent");
  assert.ok(css.includes("overflow: hidden"), "overflow hidden absent");
  assert.ok(css.includes("object-fit: cover"), "object-fit cover absent");
  assert.ok(css.includes("border-radius: var(--radius-lg"), "rayon desktop absent");
  assert.ok(css.includes("border-radius: var(--radius-md"), "rayon mobile absent");
  assert.ok(css.includes("@media (max-width: 600px)"), "media query mobile absente");
  for (const mot of ["garland", "event-badge", "conic-gradient", "background-image", "frame-"]) {
    assert.ok(!css.includes(mot), "résidu interdit : " + mot);
  }
});

check("events-calendar.js : aucun cadre ni overlay", () => {
  const js = fs.readFileSync(path.join(ROOT, "js", "events-calendar.js"), "utf8");
  for (const mot of ["frame-", "event-garland", "event-badge", "conic-gradient"]) {
    assert.ok(!js.includes(mot), "résidu interdit : " + mot);
  }
  assert.ok(js.includes(DEFAULT_IMAGE), "bannière par défaut absente");
});

check("index.html : bannière par défaut intacte", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(html.includes('src="/assets/newphoto.webp"'), "newphoto absente");
  assert.ok(html.includes('class="responsive-hero-image"'), "classe hero absente");
});

/* ------------------------------------------------------------
   8. Décorations suspendues (ruban sous la navbar)
   ------------------------------------------------------------ */

const EXPECTED_DECOR = {
  "hero-christmas": "christmas",
  "hero-christmas-2027": "christmas",
  "hero-ramadan": "ramadan",
  "hero-eid-adha": "eid-adha",
  "hero-eid-fitr": "eid-fitr",
  "hero-black-friday": "black-friday",
  "hero-black-friday-2027": "black-friday",
  "hero-winter-sales": "winter-sales",
  "hero-summer-sales": "summer-sales",
  "hero-back-to-school": "back-to-school",
  hero1111: "11-11",
};

check("chaque événement a un thème de décoration", () => {
  for (const ev of EVENTS) {
    assert.equal(decorThemeFor(ev.id), EXPECTED_DECOR[ev.id], ev.id);
  }
});

check("mode défaut / inconnu : aucune décoration", () => {
  assert.equal(decorThemeFor(null), null);
  assert.equal(decorThemeFor(undefined), null);
  assert.equal(decorThemeFor(""), null);
  assert.equal(decorThemeFor("default"), null);
  assert.equal(decorThemeFor("hero-inconnu"), null);
});

check("9 thèmes, tous déclarés dans DECOR_THEMES", () => {
  const themes = new Set(Object.values(EXPECTED_DECOR));
  assert.equal(themes.size, 9);
  for (const theme of themes) {
    assert.ok(DECOR_THEMES[theme], "thème manquant : " + theme);
    assert.ok(DECOR_THEMES[theme].items.length >= 9, theme + " : trop peu de motifs");
  }
});

check("Noël : uniquement des ampoules LED (aucune boule, aucun flocon)", () => {
  for (const kind of DECOR_THEMES.christmas.items) {
    assert.ok(kind.indexOf("bulb:") === 0, "motif interdit : " + kind);
  }
});

check("events.css : ruban sans clic + animations + mobile", () => {
  const css = fs.readFileSync(path.join(ROOT, "events.css"), "utf8").toLowerCase();
  assert.ok(css.includes(".event-decoration"), "conteneur absent");
  assert.ok(css.includes("pointer-events: none"), "pointer-events absent");
  assert.ok(css.includes("@keyframes sw-deco-swing"), "balancement absent");
  assert.ok(css.includes("@keyframes sw-deco-twinkle"), "scintillement absent");
  assert.ok(css.includes(".event-deco__item.is-spare"), "allègement mobile absent");
});

console.log("\n" + verifications + " verification(s), " + echecs + " echec(s)");
process.exit(echecs === 0 ? 0 : 1);
