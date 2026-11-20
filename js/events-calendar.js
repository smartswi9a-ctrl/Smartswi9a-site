/* ============================================================
   js/events-calendar.js — MOTEUR DE CALENDRIER COMMERCIAL ANNUEL
   ------------------------------------------------------------
   Active/désactive automatiquement 8 thèmes saisonniers aux dates
   exactes (heure légale marocaine, offsets ISO explicites), puis
   restaure le design d'origine (newphoto.webp).

   CONTRAINTES RESPECTÉES :
   - Aucune dépendance (ni three, ni gsap, ni framer-motion) :
     CSS 3D/SVG uniquement, animations GPU (transform/opacity).
   - Zéro destruction : le hero d'origine, ses attributs et tous les
     textes sont mémorisés puis restaurés à l'identique.
   - Le module n'importe RIEN au niveau racine (hors constantes) : il
     est donc testable sous Node sans DOM.

   PRIORITÉ DE RÉSOLUTION (spécifiée dans l'audit produit) :
     1. Firestore `config/theme.forcedEvent`
        - un id d'événement  -> force ce thème
        - "none"              -> force le thème par défaut
        - null / absent       -> calendrier automatique
     2. Calendrier (plage [start, end] contenant l'instant courant)
     3. Aucun événement -> design d'origine

   MODE APERÇU : `?previewDate=2027-11-26T18:00:00+01:00`
   - gèle l'horloge sur cette date ;
   - ignore le forçage Firestore (on veut voir ce que le calendrier
     produirait) ;
   - n'arme aucun minuteur (captures déterministes).
   ============================================================ */

/** Identifiant du document Firestore contenant le forçage manuel. */
export const THEME_CONFIG_PATH = { collection: "config", doc: "theme" };

/**
 * Les 8 événements, dans l'ordre chronologique.
 * Les offsets sont explicites : +01:00 (heure normale du Maroc) et
 * +00:00 pendant le Ramadan 2027, conformément au calendrier fourni.
 * @type {ReadonlyArray<{id:string,start:string,end:string,image:string,label:object,accent:string}>}
 */
export const EVENTS = Object.freeze([
  {
    id: "christmas",
    start: "2026-11-30T00:00:00+01:00",
    end: "2027-01-02T06:00:00+01:00",
    image: "/assets/hero-christmas.webp",
    accent: "#a57b2e",
    label: { fr: "Noël & fin d'année", en: "Christmas & year-end", ar: "عيد الميلاد ونهاية السنة" },
  },
  {
    id: "winter-sales",
    start: "2027-01-15T00:00:00+01:00",
    end: "2027-02-03T23:59:59+01:00",
    image: "/assets/hero-winter-sales.webp",
    accent: "#1e6bff",
    label: { fr: "Soldes d'Hiver", en: "Winter Sales", ar: "تخفيضات الشتاء" },
  },
  {
    id: "ramadan",
    start: "2027-02-04T00:00:00+01:00",
    end: "2027-03-06T23:59:59+00:00",
    image: "/assets/hero-ramadan.webp",
    accent: "#c9a227",
    label: { fr: "Ramadan 2027", en: "Ramadan 2027", ar: "رمضان 2027" },
  },
  {
    id: "eid-fitr",
    start: "2027-03-07T00:00:00+00:00",
    end: "2027-03-13T06:00:00+01:00",
    image: "/assets/hero-eid-fitr.webp",
    accent: "#0f8a5f",
    label: { fr: "Aïd al-Fitr", en: "Eid al-Fitr", ar: "عيد الفطر" },
  },
  {
    id: "eid-adha",
    start: "2027-05-07T00:00:00+01:00",
    end: "2027-05-20T06:00:00+01:00",
    image: "/assets/hero-eid-adha.webp",
    accent: "#c47b1f",
    label: { fr: "Aïd al-Adha", en: "Eid al-Adha", ar: "عيد الأضحى" },
  },
  {
    id: "summer-sales",
    start: "2027-07-01T00:00:00+01:00",
    end: "2027-07-31T23:59:59+01:00",
    image: "/assets/hero-summer-sales.webp",
    accent: "#ff7a1a",
    label: { fr: "Soldes d'Été", en: "Summer Sales", ar: "تخفيضات الصيف" },
  },
  {
    id: "back-to-school",
    start: "2027-08-25T00:00:00+01:00",
    end: "2027-09-15T23:59:59+01:00",
    image: "/assets/hero-back-to-school.webp",
    accent: "#1b4fd8",
    label: { fr: "Rentrée scolaire", en: "Back to School", ar: "الدخول المدرسي" },
  },
  {
    id: "black-friday",
    start: "2027-11-20T00:00:00+01:00",
    end: "2027-11-29T23:59:59+01:00",
    image: "/assets/hero-black-friday.webp",
    accent: "#c8102e",
    label: { fr: "Black Friday", en: "Black Friday", ar: "الجمعة السوداء" },
  },
]);

/** Identifiant qui force le retour au design d'origine. */
export const FORCE_NONE = "none";

/**
 * Convertit une chaîne ISO en Date, sans tolérer une valeur invalide.
 * @param {string} iso
 * @returns {Date|null}
 */
export function parseIsoDate(iso) {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Retrouve un événement par identifiant.
 * @param {string} id
 * @returns {object|null}
 */
export function getEventById(id) {
  if (!id) return null;
  return EVENTS.find((event) => event.id === String(id)) || null;
}

/**
 * Résout le thème applicable à un instant donné.
 *
 * @param {Date|string} date instant à évaluer
 * @param {{forcedEvent?: string|null}} [options] valeur Firestore `forcedEvent`
 * @returns {{event: object|null, forced: boolean, reason: string}}
 */
export function resolveEventAt(date, options = {}) {
  const at = date instanceof Date ? date : parseIsoDate(String(date));
  if (!at || Number.isNaN(at.getTime())) {
    return { event: null, forced: false, reason: "invalid-date" };
  }

  const forced = options && options.forcedEvent != null ? String(options.forcedEvent).trim() : "";

  if (forced === FORCE_NONE) {
    return { event: null, forced: true, reason: "forced-none" };
  }
  if (forced !== "") {
    const forcedEvent = getEventById(forced);
    if (forcedEvent) return { event: forcedEvent, forced: true, reason: "forced" };
  }

  const t = at.getTime();
  let match = null;
  let matchStart = -Infinity;

  for (const event of EVENTS) {
    const start = parseIsoDate(event.start);
    const end = parseIsoDate(event.end);
    if (!start || !end) continue;
    if (t >= start.getTime() && t <= end.getTime() && start.getTime() > matchStart) {
      match = event;
      matchStart = start.getTime();
    }
  }

  return { event: match, forced: false, reason: match ? "calendar" : "none" };
}

/**
 * Prochaine bascule (début ou fin d'événement) strictement après `date`.
 * Sert à armer un setTimeout unique au lieu de sonder chaque seconde.
 *
 * @param {Date} date
 * @returns {{at: Date, type: "start"|"end", eventId: string}|null}
 */
export function nextTransitionAt(date) {
  const at = date instanceof Date ? date : parseIsoDate(String(date));
  if (!at || Number.isNaN(at.getTime())) return null;
  const now = at.getTime();
  let best = null;

  for (const event of EVENTS) {
    const start = parseIsoDate(event.start);
    const end = parseIsoDate(event.end);
    const candidates = [
      start ? { time: start.getTime(), type: "start" } : null,
      end ? { time: end.getTime(), type: "end" } : null,
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate.time <= now) continue;
      if (!best || candidate.time < best.time) {
        best = { time: candidate.time, type: candidate.type, eventId: event.id };
      }
    }
  }

  return best ? { at: new Date(best.time), type: best.type, eventId: best.eventId } : null;
}

/**
 * Lit `?previewDate=` dans une query string.
 * @param {string} search `window.location.search` (avec ou sans "?")
 * @returns {{date: Date, raw: string}|null} null si absent ou invalide
 */
export function parsePreviewDate(search) {
  try {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const raw = params.get("previewDate");
    if (!raw) return null;
    /* Un `+` non encodé dans l'URL devient un espace : "…T12:00:00 01:00".
       On le rétablit pour que les liens collés à la main fonctionnent. */
    const cleaned = raw.trim().replace(/\s(\d{2}:\d{2})$/, "+$1");
    const date = parseIsoDate(cleaned);
    return date ? { date, raw } : null;
  } catch (e) {
    return null;
  }
}

/**
 * Libellé traduit d'un événement.
 * @param {object|null} event
 * @param {string} [lang]
 * @returns {string}
 */
export function getEventLabel(event, lang = "fr") {
  if (!event || !event.label) return "";
  return event.label[lang] || event.label.fr || "";
}

/**
 * Décide s'il faut couper les effets (accessibilité / économie de data).
 * @param {string} search
 * @param {boolean} prefersReducedMotion
 * @returns {boolean}
 */
export function shouldDisableEffects(search, prefersReducedMotion) {
  if (prefersReducedMotion) return true;
  try {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    return params.get("fx") === "off";
  } catch (e) {
    return false;
  }
}


/* ============================================================
   PARTIE DOM — appliquée uniquement dans le navigateur
   ============================================================ */

const STATE = {
  originalHero: null,
  currentEventId: null,
  timer: null,
  preview: null,
  started: false,
};

/** Photos mémorisées au premier passage (zéro destruction). */
function captureOriginalHero() {
  if (STATE.originalHero) return STATE.originalHero;
  const img = document.querySelector(".responsive-hero-image");
  if (!img) return null;
  STATE.originalHero = {
    el: img,
    src: img.getAttribute("src") || "",
    width: img.getAttribute("width"),
    height: img.getAttribute("height"),
    alt: img.getAttribute("alt") || "",
    className: img.className,
  };
  return STATE.originalHero;
}

/** Restaure strictement l'image et ses attributs d'origine. */
function restoreHero() {
  const original = captureOriginalHero();
  if (!original) return;
  const img = original.el;
  if (original.src) img.setAttribute("src", original.src);
  if (original.width != null) img.setAttribute("width", original.width);
  if (original.height != null) img.setAttribute("height", original.height);
  img.setAttribute("alt", original.alt);
  img.className = original.className;
}

/** Remplace l'image du hero par celle de l'événement. */
function swapHero(event) {
  const original = captureOriginalHero();
  if (!original) return;
  const img = original.el;
  /* Les visuels ont EXACTEMENT les dimensions de newphoto.webp (2179x722) :
     on ne touche ni à width ni à height, donc aucun décalage de mise en page.
     Aucun texte n'est ajouté : les visuels contiennent déjà leur titrage. */
  img.setAttribute("src", event.image);
  img.setAttribute("alt", `${original.alt} — ${getEventLabel(event, currentLang())}`);
  img.classList.add("is-event-hero");
}

/** Précharge un visuel sans bloquer le rendu. */
function preloadImage(src) {
  if (!src || typeof Image === "undefined") return;
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
  } catch (e) {
    /* non bloquant */
  }
}

/* Aucun texte n'est ajouté à la page : les titres d'événement sont déjà
   intégrés DANS les visuels. L'ancien badge `.event-badge` a été supprimé
   (demande client du 2026-11-20) : rien ne doit se superposer aux images. */

/** Langue courante sans dépendre de js/utils.js (module testable hors DOM). */
function currentLang() {
  const lang = document.documentElement.getAttribute("lang") || "fr";
  return ["fr", "ar", "en"].includes(lang) ? lang : "fr";
}

/** Applique un événement (ou le design d'origine si `event` est null). */
function applyState(event) {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  const previous = STATE.currentEventId;
  STATE.currentEventId = event ? event.id : null;

  if (!event) {
    html.removeAttribute("data-event");
    html.style.removeProperty("--ev-accent");
    restoreHero();
  } else {
    html.setAttribute("data-event", event.id);
    html.style.setProperty("--ev-accent", event.accent);
    swapHero(event);
    preloadImage(event.image);
  }

  if (previous !== STATE.currentEventId) {
    try {
      document.dispatchEvent(
        new CustomEvent("smartswika:event-changed", {
          detail: { eventId: STATE.currentEventId, event },
        })
      );
    } catch (e) {
      /* non bloquant */
    }
  }
}


/** Relit `config/theme` (une seule lecture, tolérante aux erreurs de règles). */
async function readForcedEvent() {
  try {
    const { db } = await import("./firebase.js");
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, THEME_CONFIG_PATH.collection, THEME_CONFIG_PATH.doc));
    if (!snap.exists()) return null;
    const value = snap.get("forcedEvent");
    return value == null ? null : String(value);
  } catch (e) {
    /* Règles Firestore, réseau coupé, mode privé : on suit le calendrier. */
    console.warn("[events] forçage Firestore indisponible :", e && e.code ? e.code : e && e.message);
    return null;
  }
}

/** Arme un minuteur unique jusqu'à la prochaine bascule. */
function scheduleNext(now, forcedEvent) {
  if (STATE.preview) return; /* aperçu = horloge gelée */
  if (STATE.timer) clearTimeout(STATE.timer);
  const next = nextTransitionAt(now);
  if (!next) return;
  const delay = Math.min(next.at.getTime() - now.getTime(), 2147483000);
  if (delay <= 0) return;
  STATE.timer = setTimeout(async () => {
    const at = new Date();
    const forced = await readForcedEvent();
    applyState(resolveEventAt(at, { forcedEvent: forced }).event);
    scheduleNext(at, forced);
  }, delay);
}

/** Recalcule l'état courant et l'applique. */
async function refresh() {
  const now = STATE.preview || new Date();
  const forced = STATE.preview ? null : await readForcedEvent();
  applyState(resolveEventAt(now, { forcedEvent: forced }).event);
  scheduleNext(now, forced);
  return STATE.currentEventId;
}

/**
 * Initialise le calendrier (idempotent).
 * @param {{previewDate?: string, disableEffects?: boolean}} [options]
 * @returns {Promise<string|null>} identifiant d'événement actif
 */
export async function initEventsCalendar(options = {}) {
  if (typeof document === "undefined") return null;
  if (STATE.started) return STATE.currentEventId;
  STATE.started = true;

  const preview = options.previewDate || parsePreviewDate(window.location.search);
  if (preview) {
    STATE.preview = preview.date ? preview.date : parseIsoDate(String(preview));
    document.documentElement.setAttribute("data-preview-date", STATE.preview.toISOString());
  }

  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (options.disableEffects || shouldDisableEffects(window.location.search, reduceMotion)) {
    document.documentElement.setAttribute("data-fx", "off");
  }

  /* Onglet en arrière-plan : minuteurs throttlés, on resynchronise. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !STATE.preview) refresh();
  });

  const activeId = await refresh();

  /* Préchargement du prochain thème (évite un flash au changement). */
  const next = nextTransitionAt(STATE.preview || new Date());
  if (next) {
    const nextEvent = getEventById(next.eventId);
    if (nextEvent) preloadImage(nextEvent.image);
  }

  return activeId;
}

/** État courant (tests / debug). */
export function getCalendarState() {
  return {
    eventId: STATE.currentEventId,
    preview: STATE.preview ? STATE.preview.toISOString() : null,
    hasTimer: Boolean(STATE.timer),
  };
}

export default initEventsCalendar;

