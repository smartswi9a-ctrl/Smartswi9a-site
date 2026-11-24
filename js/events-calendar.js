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
export const ASSETS_VERSION = "7";

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
    width: 2172,
    height: 724,
    label: "Black Friday 2026",
  },
  {
    id: "hero-christmas",
    image: "/assets/hero-christmas.webp",
    start: "2026-12-05T00:00:00",
    end: "2027-01-02T00:00:00",
    priority: 1,
    width: 2172,
    height: 724,
    label: "Noël & Nouvel An 2026",
  },
  {
    id: "hero-winter-sales",
    image: "/assets/hero-winter-sales.webp",
    start: "2027-01-05T00:00:00",
    end: "2027-02-28T23:59:59",
    priority: 1,
    width: 2172,
    height: 724,
    label: "Soldes d'hiver 2027",
  },
  {
    id: "hero-ramadan",
    image: "/assets/hero-ramadan.webp",
    start: "2027-02-01T00:00:00",
    end: "2027-03-09T00:00:00",
    priority: 2,
    width: 2172,
    height: 724,
    label: "Ramadan 2027",
  },
  {
    id: "hero-eid-fitr",
    image: "/assets/hero-eid-fitr.webp",
    start: "2027-03-09T00:00:00",
    end: "2027-03-13T00:00:00",
    priority: 2,
    width: 2172,
    height: 724,
    label: "Aïd el-Fitr 2027",
  },
  {
    id: "hero-eid-adha",
    image: "/assets/hero-eid-adha.webp",
    start: "2027-05-07T00:00:00",
    end: "2027-05-20T00:00:00",
    priority: 1,
    width: 2172,
    height: 724,
    label: "Aïd el-Adha 2027",
  },
  {
    id: "hero-summer-sales",
    image: "/assets/hero-summer-sales.webp",
    start: "2027-07-01T00:00:00",
    end: "2027-08-01T00:00:00",
    priority: 1,
    width: 2172,
    height: 724,
    label: "Soldes d'été 2027",
  },
  {
    id: "hero-back-to-school",
    image: "/assets/hero-back-to-school.webp",
    start: "2027-08-20T00:00:00",
    end: "2027-09-15T00:00:00",
    priority: 1,
    width: 2172,
    height: 724,
    label: "Rentrée scolaire 2027",
  },
  {
    id: "hero1111",
    image: "/assets/hero1111.webp",
    start: "2027-11-08T00:00:00",
    end: "2027-11-13T00:00:00",
    priority: 1,
    width: 2048,
    height: 768,
    label: "Promo 11.11 2027",
  },
  {
    id: "hero-black-friday-2027",
    image: "/assets/hero-black-friday-2027.webp",
    start: "2027-11-24T00:00:00",
    end: "2027-11-30T00:00:00",
    priority: 1,
    width: 2172,
    height: 724,
    label: "Black Friday 2027",
  },
  {
    id: "hero-christmas-2027",
    image: "/assets/hero-christmas-2027.webp",
    start: "2027-12-05T00:00:00",
    end: "2028-01-02T00:00:00",
    priority: 1,
    width: 2172,
    height: 724,
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
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 2172,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 724,
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
