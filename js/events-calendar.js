/* ============================================================
   js/events-calendar.js — CALENDRIER DES BANNIÈRES SAISONNIÈRES
   ------------------------------------------------------------
   11 visuels autonomes (aucun cadre, aucun overlay, aucun décor).

   FUSEAU : Africa/Casablanca (heure légale marocaine). Les bornes
   sont stockées en heures murales « sans offset » et converties par
   `wallClockToUtc()` selon la règle légale marocaine explicite
   (UTC+1 ; UTC+0 pendant Ramadan), indépendamment de l'ICU/tzdata
   du runtime qui diverge selon les plateformes (constat du
   2026-11-24 entre Node Windows et Node Ubuntu).

   PRIORITÉ DE RÉSOLUTION :
     0. `?preview_event=<id|default>` force un visuel (session).
     1. Firestore `config/events` : tableau `events[]` (lecture
        publique), modifiable depuis la console sans redéploiement.
     2. Calendrier embarqué ci-dessous (secours hors-ligne).
     3. Hors plage active -> /assets/newphoto.webp (bannière
        d'origine, jamais modifiée).

   Le module ne touche au DOM que dans les fonctions appelées par
   le navigateur : il reste importable sous Node pour les tests
   (`tests/events-calendar.test.mjs`).
   ============================================================ */

export const TIME_ZONE = "Africa/Casablanca";
export const EVENTS_DOC = Object.freeze({ collection: "config", doc: "events" });
export const DEFAULT_IMAGE = "/assets/newphoto.webp";
export const DEFAULT_SIZE = Object.freeze({ width: 2179, height: 722 });

/**
 * Version des visuels. Les images sont servies avec
 * `Cache-Control: max-age=86400` : ce suffixe crée une nouvelle clé
 * de cache (navigateur + Cloudflare) et évite d'afficher l'ancienne
 * bannière pendant 24 h. À incrémenter à chaque régénération.
 */
export const ASSETS_VERSION = "8";

/**
 * Calendrier de secours, identique au document Firestore
 * `config/events` créé le 2026-11-24.
 * `start` / `end` : heures murales Africa/Casablanca (sans offset).
 * `end` est exclusif (à 00:00:00 le visuel suivant prend le relais).
 * `priority` : 2 = Haute, 1 = Normale.
 * @type {ReadonlyArray<object>}
 */
export const EVENTS = Object.freeze([
  {
    id: "hero-black-friday",
    image: "/assets/hero-black-friday.webp",
    start: "2026-11-25T00:00:00",
    end: "2026-12-01T00:00:00",
    priority: 1,
    width: 2179,
    height: 722,
    label: "Black Friday 2026",
  },
  {
    id: "hero-christmas",
    image: "/assets/hero-christmas.webp",
    start: "2026-12-05T00:00:00",
    end: "2027-01-02T00:00:00",
    priority: 1,
    width: 2179,
    height: 722,
    label: "Noël & Nouvel An 2026",
  },
  {
    id: "hero-winter-sales",
    image: "/assets/hero-winter-sales.webp",
    start: "2027-01-05T00:00:00",
    end: "2027-02-28T23:59:59",
    priority: 1,
    width: 2179,
    height: 722,
    label: "Soldes d'hiver 2027",
  },
  {
    id: "hero-ramadan",
    image: "/assets/hero-ramadan.webp",
    start: "2027-02-01T00:00:00",
    end: "2027-03-09T00:00:00",
    priority: 2,
    width: 2179,
    height: 722,
    label: "Ramadan 2027",
  },
  {
    id: "hero-eid-fitr",
    image: "/assets/hero-eid-fitr.webp",
    start: "2027-03-09T00:00:00",
    end: "2027-03-13T00:00:00",
    priority: 2,
    width: 2179,
    height: 722,
    label: "Aïd el-Fitr 2027",
  },
  {
    id: "hero-eid-adha",
    image: "/assets/hero-eid-adha.webp",
    start: "2027-05-07T00:00:00",
    end: "2027-05-20T00:00:00",
    priority: 1,
    width: 2179,
    height: 722,
    label: "Aïd el-Adha 2027",
  },
  {
    id: "hero-summer-sales",
    image: "/assets/hero-summer-sales.webp",
    start: "2027-07-01T00:00:00",
    end: "2027-08-01T00:00:00",
    priority: 1,
    width: 2179,
    height: 722,
    label: "Soldes d'été 2027",
  },
  {
    id: "hero-back-to-school",
    image: "/assets/hero-back-to-school.webp",
    start: "2027-08-20T00:00:00",
    end: "2027-09-15T00:00:00",
    priority: 1,
    width: 2179,
    height: 722,
    label: "Rentrée scolaire 2027",
  },
  {
    id: "hero1111",
    image: "/assets/hero1111.webp",
    start: "2027-11-08T00:00:00",
    end: "2027-11-13T00:00:00",
    priority: 1,
    width: 2179,
    height: 722,
    label: "Promo 11.11 2027",
  },
  {
    id: "hero-black-friday-2027",
    image: "/assets/hero-black-friday-2027.webp",
    start: "2027-11-24T00:00:00",
    end: "2027-11-30T00:00:00",
    priority: 1,
    width: 2179,
    height: 722,
    label: "Black Friday 2027",
  },
  {
    id: "hero-christmas-2027",
    image: "/assets/hero-christmas-2027.webp",
    start: "2027-12-05T00:00:00",
    end: "2028-01-02T00:00:00",
    priority: 1,
    width: 2179,
    height: 722,
    label: "Noël & Nouvel An 2027",
  },
]);

/* ============================================================
   1. FUSEAU HORAIRE — Africa/Casablanca
   ============================================================ */

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const IMAGE_RE = /^\/assets\/[a-z0-9][a-z0-9._-]*\.webp$/i;

/**
 * Heure légale marocaine : UTC+1 toute l'année, UTC+0 pendant le
 * Ramadan (décret 2-18-346). Les dates lunaires sont indicatives et
 * couvrent la fenêtre du calendrier (2026-2028).
 *
 * POURQUOI CE N'EST PAS CALCULÉ PAR Intl :
 * les bases tzdata/ICU divergent selon la plateforme. Constaté le
 * 2026-11-24 : Node 22 Windows renvoie UTC+1 pour le 25/11/2026,
 * Node 22 Ubuntu (CI GitHub) renvoie UTC+0 pour la même date. Un
 * décalage d'une heure déplacerait l'activation d'une bannière.
 * La règle légale est donc codée explicitement : comportement
 * identique sur tous les navigateurs, toutes les CI, tous les OS.
 * @type {ReadonlyArray<readonly [number, number]>} bornes UTC (ms)
 */
const MOROCCO_UTC0_PERIODS = Object.freeze([
  [Date.parse("2026-02-15T02:00:00Z"), Date.parse("2026-03-22T01:00:00Z")],
  [Date.parse("2027-02-07T02:00:00Z"), Date.parse("2027-03-14T01:00:00Z")],
  [Date.parse("2028-01-23T02:00:00Z"), Date.parse("2028-02-27T01:00:00Z")],
].map((period) => Object.freeze(period)));

/** Écart légal Maroc (minutes) à un instant UTC. */
export function moroccoOffsetMinutes(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t)) return 60;
  for (const [start, end] of MOROCCO_UTC0_PERIODS) {
    if (t >= start && t < end) return 0;
  }
  return 60;
}

/**
 * Décompose un instant (ms UTC) en heure murale Africa/Casablanca.
 * Utilisé par les tests et le debug (déterministe, sans Intl).
 * @param {number} ms
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}}
 */
export function zonedParts(ms) {
  const shifted = new Date(Number(ms) + moroccoOffsetMinutes(ms) * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/**
 * Convertit une heure murale Africa/Casablanca en instant UTC (ms).
 * Aucun offset codé en dur par événement : la règle Maroc s'applique
 * (UTC+1, UTC+0 pendant Ramadan), avec une seconde passe pour les
 * bornes proches d'une transition.
 * @returns {number|null} null si la date est invalide
 */
export function wallClockToUtc(year, month, day, hour, minute, second = 0) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(wall)) return null;

  let ts = wall - 60 * 60000;
  let offset = moroccoOffsetMinutes(ts);
  if (offset !== 60) ts = wall - offset * 60000;

  const confirmed = moroccoOffsetMinutes(ts);
  if (confirmed !== offset) ts = wall - confirmed * 60000;
  return ts;
}

/**
 * Lit « 2026-11-25T00:00:00 » (heure murale) et retourne l'instant UTC.
 * @param {string} value
 * @returns {number|null}
 */
export function parseWallClock(value) {
  if (typeof value !== "string") return null;
  const m = WALL_CLOCK_RE.exec(value.trim());
  if (!m) return null;
  return wallClockToUtc(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    m[6] ? Number(m[6]) : 0
  );
}

/**
 * Normalise une entrée de calendrier (Firestore ou embarquée).
 * Rejette tout visuel hors /assets/*.webp (aucune URL externe injectée).
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const image = typeof raw.image === "string" ? raw.image.trim() : "";
  if (!id || !IMAGE_RE.test(image)) return null;

  const startMs = parseWallClock(raw.start);
  const endMs = parseWallClock(raw.end);
  if (startMs == null || endMs == null || endMs <= startMs) return null;

  const width = Number(raw.width);
  const height = Number(raw.height);

  return Object.freeze({
    id,
    image,
    startMs,
    endMs,
    priority: Number(raw.priority) === 2 ? 2 : 1,
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 2179,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 722,
    label:
      typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id,
  });
}

/**
 * Normalise + dédoublonne + trie une liste d'événements.
 * @param {ReadonlyArray<object>} list
 * @returns {ReadonlyArray<object>}
 */
export function normalizeEvents(list) {
  if (!Array.isArray(list)) return Object.freeze([]);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const ev = normalizeEvent(raw);
    if (!ev || seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return Object.freeze(out);
}

/** Calendrier embarqué, normalisé une seule fois. */
const EVENTS_NORMALIZED = normalizeEvents(EVENTS);

/**
 * Visuel actif à un instant donné.
 * Priorité la plus haute gagnante ; à priorité égale, le plus récent.
 * Exemple : Ramadan 2027 (priority 2) prend le relais sur les Soldes
 * d'hiver 2027 (priority 1) dès le 2027-02-01 00:00 Casablanca.
 * @param {Date|number} date
 * @param {ReadonlyArray<object>} [events]
 * @returns {object|null}
 */
export function resolveEventAt(date, events = EVENTS) {
  const t = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(t)) return null;
  const list = events === EVENTS ? EVENTS_NORMALIZED : events;
  let best = null;
  for (const ev of list) {
    if (t < ev.startMs || t >= ev.endMs) continue;
    if (
      !best ||
      ev.priority > best.priority ||
      (ev.priority === best.priority && ev.startMs > best.startMs)
    ) {
      best = ev;
    }
  }
  return best;
}

/**
 * Prochaine bascule (début ou fin) strictement après `date`.
 * @param {Date|number} date
 * @param {ReadonlyArray<object>} [events]
 * @returns {{at:number,type:"start"|"end",eventId:string}|null}
 */
export function nextTransitionAt(date, events = EVENTS) {
  const t = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(t)) return null;
  const list = events === EVENTS ? EVENTS_NORMALIZED : events;
  let best = null;
  for (const ev of list) {
    const candidates = [
      { at: ev.startMs, type: "start" },
      { at: ev.endMs, type: "end" },
    ];
    for (const c of candidates) {
      if (c.at <= t) continue;
      if (!best || c.at < best.at) {
        best = { at: c.at, type: c.type, eventId: ev.id };
      }
    }
  }
  return best;
}

/**
 * Retrouve un événement par identifiant, nom de fichier ou alias court
 * (« black-friday » -> « hero-black-friday »).
 * @param {ReadonlyArray<object>} events
 * @param {string} needle
 * @returns {object|null}
 */
export function findEvent(events, needle) {
  const key = String(needle == null ? "" : needle)
    .trim()
    .toLowerCase()
    .replace(/\.webp$/, "");
  if (!key) return null;
  return (
    events.find((ev) => ev.id.toLowerCase() === key) ||
    events.find((ev) => ev.id.toLowerCase().replace(/^hero-?/, "") === key) ||
    events.find((ev) => ev.image.toLowerCase() === `/assets/${key}.webp`) ||
    null
  );
}

/**
 * Lit `?preview_event=` (avec ou sans « ? »).
 * @param {string} search
 * @returns {string|null} null si le paramètre est absent
 */
export function parsePreviewParam(search) {
  try {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const raw = params.get("preview_event");
    return raw == null ? null : raw.trim();
  } catch (error) {
    return null;
  }
}

/** URL servie avec cache-busting (navigateur + Cloudflare). */
export function eventImageUrl(event) {
  if (!event || !event.image) return "";
  return `${event.image}?v=${ASSETS_VERSION}`;
}

/* ============================================================
   1 bis. DÉCORATIONS SUSPENDUES (une par événement)
   ------------------------------------------------------------
   Ruban SVG + animations CSS, inséré dans le flux entre la navbar
   et le bandeau promo : il ne recouvre donc JAMAIS la bannière
   Hero. `pointer-events: none` : les menus restent cliquables.
   En mode défaut, le noeud est retiré du DOM (retour à l'original).
   ============================================================ */

/** Fil festonné : 4 festons sur une viewBox de 1200 x 50. */
const DECOR_WIRE_PATH =
  "M0 8 Q150 36 300 8 Q450 36 600 8 Q750 36 900 8 Q1050 36 1200 8";

/** Icônes vectorielles fines (aucune image, aucun emoji). */
export const DECOR_ICONS = Object.freeze({
  bulb:
    '<svg viewBox="0 0 14 20"><path d="M7 1v4" class="deco-line"/><circle cx="7" cy="12" r="5" class="deco-fill"/><circle cx="7" cy="12" r="2.1" class="deco-core"/></svg>',
  lantern:
    '<svg viewBox="0 0 20 30"><path d="M10 1v2.4" class="deco-line"/><path d="M5.6 3.6h8.8l1.6 3H4z" class="deco-fill"/><path d="M5 6.8h10l-1.2 15.4H6.2z" class="deco-fill-soft"/><circle cx="10" cy="14.4" r="3.4" class="deco-lamp"/><path d="M6.6 22.4h6.8l-1 3.6H7.6z" class="deco-fill"/></svg>',
  crescent:
    '<svg viewBox="0 0 16 16"><path d="M11.8 1.4a6.8 6.8 0 1 0 0 13.2A7.8 7.8 0 0 1 11.8 1.4z" class="deco-fill"/></svg>',
  star:
    '<svg viewBox="0 0 16 16"><path d="M8 .6l2.1 5 5.4.5-4.1 3.6 1.2 5.3L8 12.2 3.4 15l1.2-5.3L.5 6.1 5.9 5.6z" class="deco-fill"/></svg>',
  sheep:
    '<svg viewBox="0 0 64 52" preserveAspectRatio="xMidYMin meet"><circle cx="30" cy="4" r="2.6" fill="none" stroke="#C89B3C" stroke-width="1.6"/><path d="M30 6.6v4" stroke="#C89B3C" stroke-width="1.4" stroke-linecap="round"/><g stroke="#9A6B26" stroke-width="2.4" stroke-linecap="round"><path d="M18 33v10"/><path d="M26 34v9"/><path d="M34 34v9"/><path d="M41 33v10"/></g><g fill="#4A3219"><rect x="15.8" y="42.4" width="4.4" height="3.2" rx="1.2"/><rect x="23.8" y="42.4" width="4.4" height="3.2" rx="1.2"/><rect x="31.8" y="42.4" width="4.4" height="3.2" rx="1.2"/><rect x="38.8" y="42.4" width="4.4" height="3.2" rx="1.2"/></g><path d="M12 32c-3.2 0-5.6-2.3-5.6-5.2 0-2.3 1.5-4.3 3.6-5-1.1-3 .8-6.2 4.1-6.6 1-3 4.2-4.9 7.4-4.2 1.9-2.7 5.8-3.1 8.3-.9 3-1.6 6.8.2 7.7 3.5 3.2.4 5.5 3.2 5.2 6.4 1.9 1.6 2.3 4.4.9 6.5-1.2 1.9-3.3 3-5.6 3z" fill="#FFFDF7" stroke="#9A6B26" stroke-width="1.5" stroke-linejoin="round"/><ellipse cx="43.6" cy="21.6" rx="3.4" ry="2" transform="rotate(-25 43.6 21.6)" fill="#D9B38C" stroke="#9A6B26" stroke-width="1.2"/><ellipse cx="54.4" cy="21.6" rx="3.4" ry="2" transform="rotate(25 54.4 21.6)" fill="#D9B38C" stroke="#9A6B26" stroke-width="1.2"/><path d="M44.6 19.4c-2.6-1.6-2-5.6 1-6.4 2.2-.6 3.8 1 3.8 2.6" fill="none" stroke="#C89B3C" stroke-width="2.4" stroke-linecap="round"/><path d="M53.4 19.4c2.6-1.6 2-5.6-1-6.4-2.2-.6-3.8 1-3.8 2.6" fill="none" stroke="#C89B3C" stroke-width="2.4" stroke-linecap="round"/><ellipse cx="49" cy="25" rx="7.4" ry="6.6" fill="#D9B38C" stroke="#9A6B26" stroke-width="1.4"/><ellipse cx="53.4" cy="27.6" rx="3.2" ry="2.6" fill="#E8C9A8" stroke="#9A6B26" stroke-width="1"/><circle cx="52.4" cy="27.4" r=".7" fill="#5C4033"/><circle cx="47.6" cy="23.4" r="1.5" fill="#2B1B0F"/><circle cx="48.1" cy="22.9" r=".5" fill="#FFFDF7"/></svg>',
  tag: '<svg viewBox="0 0 18 18"><path d="M1.6 1.6h6.6l8.2 8.2-6 6L2.2 7.6z" class="deco-fill-soft"/><circle cx="5.4" cy="5.4" r="1.1" class="deco-hole"/><text x="9.6" y="13.2" class="deco-text">%</text></svg>',
  flake:
    '<svg viewBox="0 0 18 18"><g class="deco-line"><path d="M9 1.2v15.6M1.2 9h15.6M3.5 3.5l11 11M14.5 3.5l-11 11"/></g></svg>',
  sun: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.8" class="deco-fill"/><g class="deco-line"><path d="M10 1.2v2.4M10 16.4v2.4M1.2 10h2.4M16.4 10h2.4M3.6 3.6l1.7 1.7M14.7 14.7l1.7 1.7M16.4 3.6l-1.7 1.7M5.3 14.7l-1.7 1.7"/></g></svg>',
  pennant:
    '<svg viewBox="0 0 14 18"><path d="M7 1v2.4" class="deco-line"/><path d="M1 3.4h12L7 12.6z" class="deco-fill"/></svg>',
});

/**
 * Thèmes de décoration. Chaque entrée liste les motifs suspendus,
 * dans l'ordre, et la couleur du fil.
 * @type {Readonly<Record<string, {items: ReadonlyArray<string>}>>}
 */
export const DECOR_THEMES = Object.freeze({
  christmas: {
    items: [
      "bulb:red", "bulb:green", "bulb:blue", "bulb:gold", "bulb:pink",
      "bulb:cyan", "bulb:red", "bulb:green", "bulb:blue", "bulb:gold",
      "bulb:pink",
    ],
  },
  ramadan: {
    items: ["lantern", "crescent", "star", "lantern", "star", "lantern", "crescent", "star", "lantern", "star", "lantern"],
  },
  "eid-adha": {
    items: ["sheep", "star", "sheep", "star", "sheep", "star", "sheep", "star", "sheep", "star", "sheep"],
  },
  "eid-fitr": {
    items: ["crescent", "star", "lantern", "star", "crescent", "star", "lantern", "star", "crescent", "star", "crescent"],
  },
  "black-friday": {
    items: ["tag", "bulb:red", "vip", "bulb:gold", "tag", "bulb:red", "vip", "bulb:gold", "tag", "bulb:red", "tag"],
  },
  "winter-sales": {
    items: ["flake", "flake", "flake", "flake", "flake", "flake", "flake", "flake", "flake", "flake", "flake"],
  },
  "summer-sales": {
    items: ["sun", "star", "sun", "star", "sun", "star", "sun", "star", "sun", "star", "sun"],
  },
  "back-to-school": {
    items: ["pennant", "star", "pennant", "star", "pennant", "star", "pennant", "star", "pennant", "star", "pennant"],
  },
  "11-11": {
    items: ["badge1111", "star", "badge1111", "star", "badge1111", "star", "badge1111", "star", "badge1111", "star", "badge1111"],
  },
});

/** Association identifiant d'événement -> thème de décoration. */
const DECOR_BY_EVENT = Object.freeze({
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
});

/**
 * Thème de décoration d'un événement (null = aucune décoration).
 * @param {string|null|undefined} eventId
 * @returns {string|null}
 */
export function decorThemeFor(eventId) {
  if (!eventId) return null;
  return DECOR_BY_EVENT[String(eventId)] || null;
}


/* ============================================================
   2. DOM (navigateur uniquement)
   ============================================================ */

const STATE = {
  original: null,
  currentId: null,
  currentEvent: null,
  events: EVENTS_NORMALIZED,
  timer: null,
  preview: null,
  started: false,
  decorEl: null,
  decorTheme: null,
};

/** Mémorise la bannière d'origine (jamais détruite, jamais convertie). */
function captureOriginal(img) {
  if (STATE.original) return STATE.original;
  STATE.original = {
    el: img,
    src: img.getAttribute("src") || DEFAULT_IMAGE,
    width: img.getAttribute("width"),
    height: img.getAttribute("height"),
    alt: img.getAttribute("alt") || "",
    className: img.className,
    wrapper: img.closest(".newphoto-banner-wrapper"),
  };
  img.addEventListener("error", () => {
    /* Un WebP d'événement indisponible ne doit jamais laisser un
       trou : on restaure immédiatement la bannière par défaut. */
    if (!STATE.currentId) return;
    console.warn("[events] visuel indisponible :", STATE.currentEvent?.image);
    applyEvent(null);
  });
  return STATE.original;
}

/** Restaure à l'identique la bannière d'origine. */
function restoreOriginal() {
  const original = STATE.original;
  if (!original) return;
  const img = original.el;
  if (original.src) img.setAttribute("src", original.src);
  if (original.width != null) img.setAttribute("width", original.width);
  if (original.height != null) img.setAttribute("height", original.height);
  img.setAttribute("alt", original.alt);
  img.className = original.className;
  if (original.wrapper) original.wrapper.classList.remove("is-event-banner");
}

/**
 * Construit un motif suspendu positionné sur la courbe du fil.
 * @param {string} kind ex. "lantern", "bulb:red", "vip", "badge1111"
 * @param {number} index
 * @param {number} total
 * @returns {string}
 */
function buildDecorItem(kind, index, total) {
  const t = total <= 1 ? 0 : index / (total - 1);
  const phase = (t * 4) % 1;
  const yPct = (((8 + 14 * Math.sin(Math.PI * phase)) / 50) * 100).toFixed(2);
  const xPct = (3 + t * 94).toFixed(2);
  const delay = ((index % 6) * 0.23).toFixed(2);
  const duration = (3.8 + (index % 3) * 0.45).toFixed(2);

  let inner;
  let colorClass = index % 2 ? " is-alt" : "";

  if (kind === "vip") {
    inner = '<span class="event-deco__badge">VIP</span>';
    colorClass = " is-alt";
  } else if (kind === "badge1111") {
    inner = '<span class="event-deco__badge">11.11</span>';
    colorClass = "";
  } else if (kind.indexOf("bulb:") === 0) {
    inner = DECOR_ICONS.bulb;
    colorClass = " is-" + kind.slice(5);
  } else {
    inner = DECOR_ICONS[kind] || DECOR_ICONS.star;
    if (kind === "tag") colorClass += " is-tag";
    if (kind === "sheep") colorClass += " is-sheep";
    if (
      kind === "lantern" ||
      kind === "sheep" ||
      kind === "tag" ||
      kind === "sun" ||
      kind === "flake" ||
      kind === "pennant"
    ) {
      colorClass += " is-lg";
    }
  }

  const spare = index % 2 ? " is-spare" : "";
  return (
    '<span class="event-deco__item' +
    spare +
    '" style="--x:' +
    xPct +
    "%;--y:" +
    yPct +
    "%;--delay:" +
    delay +
    "s;--dur:" +
    duration +
    's" aria-hidden="true"><span class="event-deco__icon' +
    colorClass +
    '">' +
    inner +
    "</span></span>"
  );
}

/** Monte (ou remplace) le ruban décoratif d'un thème. */
function mountDecoration(themeId) {
  if (typeof document === "undefined" || !themeId) return;
  if (STATE.decorTheme === themeId && STATE.decorEl) return;

  removeDecoration();

  const theme = DECOR_THEMES[themeId];
  if (!theme) return;

  const el = document.createElement("div");
  el.className = "event-decoration event-decoration--" + themeId;
  el.setAttribute("aria-hidden", "true");
  el.innerHTML =
    '<svg class="event-decoration__wire" viewBox="0 0 1200 50" preserveAspectRatio="none" focusable="false" aria-hidden="true"><path d="' +
    DECOR_WIRE_PATH +
    '" vector-effect="non-scaling-stroke"/></svg>' +
    theme.items.map((kind, i) => buildDecorItem(kind, i, theme.items.length)).join("");

  const promo = document.querySelector(".navbar-promo-banner");
  if (promo && promo.parentNode) {
    promo.parentNode.insertBefore(el, promo);
  } else {
    const nav = document.getElementById("navbar");
    if (nav && nav.parentNode) nav.parentNode.insertBefore(el, nav.nextSibling);
    else document.body.insertBefore(el, document.body.firstChild);
  }

  STATE.decorEl = el;
  STATE.decorTheme = themeId;
}

/** Retire totalement le ruban (mode défaut). */
function removeDecoration() {
  if (STATE.decorEl && STATE.decorEl.parentNode) {
    STATE.decorEl.parentNode.removeChild(STATE.decorEl);
  }
  STATE.decorEl = null;
  STATE.decorTheme = null;
}

/**
 * Applique un visuel d'événement, ou la bannière par défaut si null.
 * Aucune décoration n'est ajoutée : seul le `src` change.
 * @param {object|null} event
 */
export function applyEvent(event) {
  if (typeof document === "undefined") return;
  const original = STATE.original;
  if (!original) return;

  const html = document.documentElement;
  const previousId = STATE.currentId;
  STATE.currentId = event ? event.id : null;
  STATE.currentEvent = event || null;

  if (!event) {
    html.removeAttribute("data-event");
    restoreOriginal();
    removeDecoration();
  } else {
    const img = original.el;
    img.setAttribute("src", eventImageUrl(event));
    img.setAttribute("width", String(event.width));
    img.setAttribute("height", String(event.height));
    img.setAttribute("alt", `${original.alt} — ${event.label}`);
    img.classList.add("is-event-hero");
    img.classList.remove("is-event-missing");
    if (original.wrapper) original.wrapper.classList.add("is-event-banner");
    html.setAttribute("data-event", event.id);
    /* Ruban suspendu sous la navbar, propre au thème de l'événement. */
    mountDecoration(decorThemeFor(event.id));
  }

  if (previousId !== STATE.currentId) {
    try {
      document.dispatchEvent(
        new CustomEvent("smartswika:event-changed", {
          detail: { eventId: STATE.currentId, event: STATE.currentEvent },
        })
      );
    } catch (error) {
      /* CustomEvent indisponible : non bloquant. */
    }
  }
}

/** Précharge un visuel sans bloquer le rendu. */
function preloadImage(src) {
  if (!src || typeof Image === "undefined") return;
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
  } catch (error) {
    /* non bloquant */
  }
}

/**
 * Lit `config/events` (lecture publique). Toute anomalie retombe
 * silencieusement sur le calendrier embarqué : le site ne casse jamais.
 * @returns {Promise<ReadonlyArray<object>|null>}
 */
async function loadRemoteEvents() {
  try {
    const { db } = await import("./firebase.js");
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, EVENTS_DOC.collection, EVENTS_DOC.doc));
    if (!snap.exists()) return null;
    const data = snap.data() || {};
    const events = normalizeEvents(Array.isArray(data.events) ? data.events : []);
    if (!events.length) {
      console.warn("[events] config/events vide ou invalide : calendrier embarqué utilisé");
      return null;
    }
    return events;
  } catch (error) {
    console.warn(
      "[events] config/events indisponible :",
      error && error.code ? error.code : error && error.message
    );
    return null;
  }
}

/**
 * Arme UN minuteur jusqu'à la prochaine bascule (début ou fin).
 * Évite tout sondage : la transition à minuit est exacte à ~250 ms.
 */
function scheduleNext() {
  if (STATE.preview) return;
  if (STATE.timer) clearTimeout(STATE.timer);
  const now = Date.now();
  const next = nextTransitionAt(now, STATE.events);
  if (!next) return;
  const delay = Math.min(next.at - now + 250, 2147483000);
  STATE.timer = setTimeout(async () => {
    const remote = await loadRemoteEvents();
    if (remote) STATE.events = remote;
    applyEvent(resolveEventAt(Date.now(), STATE.events));
    scheduleNext();
  }, Math.max(delay, 250));
}

/** Recalcule l'état courant (retour d'onglet, bfcache). */
async function refresh() {
  if (STATE.preview) return STATE.currentId;
  const remote = await loadRemoteEvents();
  if (remote) STATE.events = remote;
  applyEvent(resolveEventAt(Date.now(), STATE.events));
  scheduleNext();
  return STATE.currentId;
}

/**
 * Initialise le calendrier des bannières (idempotent).
 *
 * Ordre volontaire : rendu SYNCHRONE avec le calendrier embarqué,
 * puis synchronisation Firestore en arrière-plan. La bannière est
 * donc correcte dès le premier pixel, même sans réseau.
 *
 * @param {{previewEvent?: string|null}} [options]
 * @returns {Promise<string|null>} identifiant actif (null = défaut)
 */
export async function initEventsCalendar(options = {}) {
  if (typeof document === "undefined") return null;
  if (STATE.started) return STATE.currentId;

  const raw =
    options.previewEvent !== undefined
      ? options.previewEvent
      : parsePreviewParam(window.location.search);
  const wantsDefault =
    raw != null && /^(default|none|off)$/i.test(String(raw).trim());
  const previewEvent =
    raw != null && !wantsDefault ? findEvent(EVENTS, raw) : null;
  if (raw != null && !wantsDefault && !previewEvent) {
    console.warn("[events] preview_event inconnu :", raw);
  }

  const img = document.querySelector(".responsive-hero-image");
  if (!img) return null; /* page sans bannière : rien à faire */

  captureOriginal(img);
  STATE.started = true;

  if (wantsDefault) {
    STATE.preview = "default";
    applyEvent(null);
    return null;
  }

  if (previewEvent) {
    STATE.preview = previewEvent.id;
    applyEvent(previewEvent);
    preloadImage(eventImageUrl(previewEvent));
    return previewEvent.id;
  }

  /* 1. Rendu immédiat (calendrier embarqué). */
  applyEvent(resolveEventAt(Date.now(), STATE.events));
  scheduleNext();

  /* 2. Firestore : peut ajuster les dates lunaires sans redéploiement. */
  Promise.resolve()
    .then(async () => {
      const remote = await loadRemoteEvents();
      if (!remote) return;
      STATE.events = remote;
      applyEvent(resolveEventAt(Date.now(), STATE.events));
      scheduleNext();
      const next = nextTransitionAt(Date.now(), STATE.events);
      const nextEvent = next
        ? STATE.events.find((ev) => ev.id === next.eventId)
        : null;
      if (nextEvent) preloadImage(eventImageUrl(nextEvent));
    })
    .catch(() => {});

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh().catch(() => {});
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) refresh().catch(() => {});
  });

  return STATE.currentId;
}

/** État courant (tests / debug console). */
export function getCalendarState() {
  return {
    eventId: STATE.currentId,
    preview: STATE.preview,
    hasTimer: Boolean(STATE.timer),
    source: STATE.events === EVENTS_NORMALIZED ? "embedded" : "firestore",
  };
}

export default initEventsCalendar;
