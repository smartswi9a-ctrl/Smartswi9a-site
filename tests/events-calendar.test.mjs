/* ============================================================
   tests/events-calendar.test.mjs
   GARDE-FOU — CALENDRIER COMMERCIAL ANNUEL
   ------------------------------------------------------------
   Vérifie, sans DOM ni réseau :
     - les 8 événements, ordre chronologique, identifiants uniques ;
     - AUCUN chevauchement de plages (sinon deux thèmes se battent) ;
     - la résolution aux 4 dates de recette demandées ;
     - les frontières exactes (fin incluse, sortie à +1 s) ;
     - la priorité du forçage Firestore (id valide / "none" / inconnu) ;
     - le mode aperçu ?previewDate= (valide / invalide) ;
     - la présence des libellés fr / ar / en.
   ============================================================ */
"use strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVENTS,
  FORCE_NONE,
  getEventById,
  getEventLabel,
  nextTransitionAt,
  parsePreviewDate,
  resolveEventAt,
  shouldDisableEffects,
} from "../js/events-calendar.js";

let checks = 0;
let failures = 0;

function check(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log("PASS: " + name);
  } else {
    failures += 1;
    console.error("ECHEC: " + name + (detail ? " -> " + detail : ""));
  }
}

const at = (iso) => resolveEventAt(new Date(iso)).event;
const idAt = (iso) => {
  const event = at(iso);
  return event ? event.id : null;
};

/* ---------- 1. Structure ---------- */
check("8 événements déclarés", EVENTS.length === 8, String(EVENTS.length));
check(
  "identifiants uniques",
  new Set(EVENTS.map((e) => e.id)).size === EVENTS.length
);
check(
  "ordre chronologique",
  EVENTS.every((e, i) => i === 0 || new Date(e.start) > new Date(EVENTS[i - 1].start))
);
check(
  "images au format /assets/hero-<id>.webp",
  EVENTS.every((e) => e.image === `/assets/hero-${e.id}.webp`)
);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

check(
  "chaque image existe dans le dossier assets",
  EVENTS.every((event) => fs.existsSync(path.join(ROOT, event.image.replace(/^\//, ""))))
);

/* ---------- 2 bis. Dimensions EXACTES de newphoto.webp ---------- */

/** Lit les dimensions d'un WebP sans aucune dépendance (VP8 / VP8L / VP8X). */
function readWebpSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

const REFERENCE_FILE = path.join(ROOT, "assets", "newphoto.webp");
const reference = readWebpSize(REFERENCE_FILE);
check(
  "référence newphoto.webp lisible",
  reference !== null,
  reference ? `${reference.width}x${reference.height}` : "illisible"
);

check(
  "visuels strictement à la dimension de newphoto.webp",
  Boolean(reference) &&
    EVENTS.every((event) => {
      const size = readWebpSize(path.join(ROOT, event.image.replace(/^\//, "")));
      return size && size.width === reference.width && size.height === reference.height;
    }),
  reference ? `attendu ${reference.width}x${reference.height}` : ""
);

check(
  "visuels ≤ 260 Ko",
  EVENTS.every(
    (event) => fs.statSync(path.join(ROOT, event.image.replace(/^\//, ""))).size <= 260 * 1024
  )
);

/* ---------- 2. Aucun chevauchement ---------- */
let overlap = null;
for (let i = 0; i < EVENTS.length - 1; i += 1) {
  const currentEnd = new Date(EVENTS[i].end).getTime();
  const nextStart = new Date(EVENTS[i + 1].start).getTime();
  if (nextStart <= currentEnd) overlap = `${EVENTS[i].id} ∩ ${EVENTS[i + 1].id}`;
}
check("aucun chevauchement entre événements", overlap === null, overlap || "");

/* ---------- 3. Dates de recette (spécification) ---------- */
check("Noël le 2026-12-15", idAt("2026-12-15T12:00:00+01:00") === "christmas", idAt("2026-12-15T12:00:00+01:00"));
check("Ramadan le 2027-02-20 (GMT+0)", idAt("2027-02-20T20:00:00+00:00") === "ramadan", idAt("2027-02-20T20:00:00+00:00"));
check("Black Friday le 2027-11-26", idAt("2027-11-26T18:00:00+01:00") === "black-friday", idAt("2027-11-26T18:00:00+01:00"));
check("Retour à l'original le 2027-01-02 06:05", idAt("2027-01-02T06:05:00+01:00") === null, String(idAt("2027-01-02T06:05:00+01:00")));

/* ---------- 4. Frontières ---------- */
check("fin incluse : 2027-01-02 06:00 = Noël", idAt("2027-01-02T06:00:00+01:00") === "christmas");
check("début exact : 2026-11-30 00:00 = Noël", idAt("2026-11-30T00:00:00+01:00") === "christmas");
check("une seconde avant : 2026-11-29 23:59:59 = défaut", idAt("2026-11-29T23:59:59+01:00") === null);
check("Ramadan fin incluse (GMT+0)", idAt("2027-03-06T23:59:59+00:00") === "ramadan");
check("Aïd al-Fitr démarre le 2027-03-07 (GMT+0)", idAt("2027-03-07T00:00:00+00:00") === "eid-fitr");

/* ---------- 5. Forçage Firestore ---------- */
check(
  "forcedEvent = none force le défaut",
  resolveEventAt(new Date("2027-02-20T20:00:00+00:00"), { forcedEvent: FORCE_NONE }).event === null
);
check(
  "forcedEvent = black-friday force hors période",
  (resolveEventAt(new Date("2027-06-01T12:00:00+01:00"), { forcedEvent: "black-friday" }).event || {}).id === "black-friday"
);
check(
  "forcedEvent inconnu retombe sur le calendrier",
  (resolveEventAt(new Date("2027-02-20T20:00:00+00:00"), { forcedEvent: "halloween" }).event || {}).id === "ramadan"
);
check(
  "forcedEvent null suit le calendrier",
  (resolveEventAt(new Date("2027-07-15T12:00:00+01:00"), { forcedEvent: null }).event || {}).id === "summer-sales"
);

/* ---------- 6. Mode aperçu ---------- */
check("previewDate valide", (parsePreviewDate("?previewDate=2027-11-26T18:00:00%2B01:00") || {}).raw != null);
check("previewDate absente", parsePreviewDate("?lang=ar") === null);
check("previewDate invalide", parsePreviewDate("?previewDate=pas-une-date") === null);

/* ---------- 7. Prochaine bascule ---------- */
const next = nextTransitionAt(new Date("2027-01-02T07:00:00+01:00"));
check("prochaine bascule après Noël", next !== null && next.at > new Date("2027-01-02T07:00:00+01:00"), next ? next.at.toISOString() : "null");
check("prochaine bascule = début des Soldes d'Hiver", next && next.type === "start" && next.eventId === "winter-sales", next ? next.eventId : "null");

/* ---------- 8. Libellés ---------- */
check(
  "libellés fr/ar/en complets",
  EVENTS.every((e) => e.label && e.label.fr && e.label.ar && e.label.en)
);
check("getEventLabel en arabe", getEventLabel(getEventById("ramadan"), "ar") === "رمضان 2027");
check("langue inconnue -> fr", getEventLabel(getEventById("christmas"), "de") === getEventLabel(getEventById("christmas"), "fr"));

/* ---------- 9. Effets ---------- */
check("?fx=off coupe les effets", shouldDisableEffects("?fx=off", false) === true);
check("effets actifs par défaut", shouldDisableEffects("", false) === false);
check("reduced-motion coupe les effets", shouldDisableEffects("", true) === true);

console.log("");
console.log(`${checks - failures}/${checks} vérifications PASS`);
if (failures > 0) {
  console.error("ECHECS: " + failures);
  process.exit(1);
}
console.log("Calendrier commercial : " + EVENTS.length + " événements validés.");
