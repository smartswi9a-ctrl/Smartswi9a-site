/* ============================================================
   js/analytics.js
   Mesure d audience - SMARTSWIKA
   ------------------------------------------------------------
   Collecte minimale et respectueuse :
     - UNIQUEMENT si le visiteur a accepte les cookies
       (CONFIG.ANALYTICS.RESPECT_COOKIE_CONSENT) ;
     - identifiant de visiteur pseudonyme (UUID local, 365 jours) ;
     - aucune IP, aucun nom, aucun email, aucun user-agent complet ;
     - pages de back-office exclues (voir analytics-core.js).

   Deux ecritures Firestore :
     1. analytics_daily/{AAAA-MM-JJ} : views (+1) et visitors (union)
        -> alimente jour / 7 j / 30 j / 12 mois du dashboard admin ;
     2. presence/{visitorId} : lastSeen -> "en ligne" si < 5 min ;
        expireAt -> purge automatique par TTL Firestore apres 7 jours.

   Volume maitrise : une vue par session et par jour, un battement de
   coeur toutes les 60 s maximum et seulement si l onglet est visible.
   ============================================================ */

import { db } from "./firebase.js";
import {
  doc,
  setDoc,
  increment,
  arrayUnion,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { CONFIG } from "./config.js?v=2";
import { safeGetItem, safeSetItem } from "./utils.js";
import {
  dayKey,
  isTrackablePath,
  normalizeTrackedPath,
  shouldRecordView,
  presenceExpireAt,
} from "./analytics-core.js";

const A = CONFIG.ANALYTICS;
const KEYS = CONFIG.STORAGE_KEYS;

/* Plancher de 60 s : CONFIG.ANALYTICS.HEARTBEAT_INTERVAL_MS vaut 30 s,
   ce qui doublerait inutilement les ecritures Firestore. */
const HEARTBEAT_MS = Math.max(60000, Number(A.HEARTBEAT_INTERVAL_MS) || 60000);
const LIVE_TTL_MS = Number(A.LIVE_TTL_MS) || 5 * 60 * 1000;

let started = false;
let heartbeatTimer = null;
let currentVisitorId = null;
let currentSessionId = null;

function uuid() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (e) {
    /* ignore */
  }
  return (
    "v-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * Le visiteur a-t-il accepte la mesure d audience ?
 * @returns {boolean}
 */
export function hasAnalyticsConsent() {
  return safeGetItem(KEYS.COOKIE_CONSENT) === "accepted";
}

/**
 * Identifiant pseudonyme du visiteur (localStorage, renouvele apres
 * VISITOR_ID_RETENTION_MS). Aucune donnee personnelle.
 * @returns {string}
 */
export function getVisitorId() {
  if (currentVisitorId) return currentVisitorId;

  try {
    const raw = safeGetItem(KEYS.VISITOR_ID);
    if (raw && typeof raw === "object" && raw.id) {
      const age = Date.now() - Number(raw.createdAt || 0);
      if (Number.isFinite(age) && age >= 0 && age < A.VISITOR_ID_RETENTION_MS) {
        currentVisitorId = String(raw.id);
        return currentVisitorId;
      }
    }
  } catch (e) {
    /* ignore */
  }

  currentVisitorId = uuid();
  safeSetItem(KEYS.VISITOR_ID, { id: currentVisitorId, createdAt: Date.now() });
  return currentVisitorId;
}

/**
 * Identifiant de session (sessionStorage, expiration 30 min).
 * @returns {string}
 */
export function getSessionId() {
  if (currentSessionId) return currentSessionId;

  try {
    const raw = safeGetItem(KEYS.SESSION_ID);
    if (raw && typeof raw === "object" && raw.id) {
      const idle = Date.now() - Number(raw.lastAt || 0);
      if (Number.isFinite(idle) && idle >= 0 && idle < A.SESSION_TIMEOUT_MS) {
        currentSessionId = String(raw.id);
        safeSetItem(KEYS.SESSION_ID, { id: currentSessionId, lastAt: Date.now() });
        return currentSessionId;
      }
    }
  } catch (e) {
    /* ignore */
  }

  currentSessionId = uuid();
  safeSetItem(KEYS.SESSION_ID, { id: currentSessionId, lastAt: Date.now() });
  return currentSessionId;
}

/** Supprime les identifiants locaux (refus du consentement, RGPD). */
export function clearLocalAnalyticsIds() {
  currentVisitorId = null;
  currentSessionId = null;
  try {
    localStorage.removeItem(KEYS.VISITOR_ID);
    sessionStorage.removeItem(KEYS.SESSION_ID);
    localStorage.removeItem(KEYS.ANALYTICS_LAST);
  } catch (e) {
    /* ignore */
  }
}

/**
 * Vue anonyme : comptee pour TOUS les visiteurs, y compris ceux qui n ont
 * pas encore repondu au bandeau cookies. Aucun identifiant, aucun cookie,
 * aucun stockage local : c est un simple compteur de pages vues (mesure
 * d audience agregee, non personnelle, donc hors consentement).
 */
export function trackAnonymousView() {
  if (typeof window === "undefined") return;

  const path = normalizeTrackedPath(window.location.pathname);
  if (!isTrackablePath(path)) return;

  const date = dayKey(new Date());
  if (!date) return;

  try {
    setDoc(
      doc(db, "analytics_daily", date),
      { views: increment(1), updatedAt: serverTimestamp() },
      { merge: true }
    ).catch(() => {
      /* mesure non bloquante : une erreur reseau ne doit rien casser */
    });
  } catch (e) {
    /* ignore */
  }
}

/**
 * Vue consentie : ajoute l identifiant pseudonyme du visiteur pour le
 * comptage des visiteurs uniques (1 fois par session et par jour).
 * Le volume de vues, lui, est deja compte par trackAnonymousView().
 */
async function recordConsentedView() {
  if (typeof window === "undefined") return;

  const path = normalizeTrackedPath(window.location.pathname);
  if (!isTrackablePath(path)) return;

  const date = dayKey(new Date());
  const sessionId = getSessionId();
  if (!shouldRecordView(safeGetItem(KEYS.ANALYTICS_LAST), date, sessionId)) return;

  try {
    await setDoc(
      doc(db, "analytics_daily", date),
      {
        visitors: arrayUnion(getVisitorId()),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    safeSetItem(KEYS.ANALYTICS_LAST, date + "|" + sessionId);
  } catch (e) {
    /* mesure non bloquante : une erreur reseau ne doit rien casser */
  }
}

/** Ecrit le battement de coeur de presence (onglet visible seulement). */
async function writePresence() {
  if (typeof window === "undefined") return;
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    return;
  }

  const path = normalizeTrackedPath(window.location.pathname);
  if (!isTrackablePath(path)) return;

  try {
    await setDoc(
      doc(db, "presence", getVisitorId()),
      {
        lastSeen: serverTimestamp(),
        /* Purge par TTL Firestore : voir firestore.rules et
           docs/runbooks/FIRESTORE-TTL-PRESENCE.md. */
        expireAt: Timestamp.fromMillis(presenceExpireAt(Date.now())),
        sessionId: getSessionId(),
        path,
      },
      { merge: true }
    );
  } catch (e) {
    /* ignore */
  }
}

/** Demarre la mesure (si consentement). Idempotent. */
export function startAnalytics() {
  if (started || typeof window === "undefined") return;
  if (!hasAnalyticsConsent()) return;

  started = true;
  recordConsentedView();
  writePresence();

  heartbeatTimer = setInterval(() => {
    writePresence();
  }, HEARTBEAT_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") writePresence();
  });

  /* Retour depuis le cache de navigation (bouton precedent). */
  window.addEventListener("pageshow", (event) => {
    if (event && event.persisted) writePresence();
  });
}

/** Arrete la mesure (tests, deconnexion). */
export function stopAnalytics() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  started = false;
}

/**
 * Point d entree, appele une fois par js/app.js.
 * Demarre si le consentement est deja donne, sinon attend le clic
 * "Confirmer" du bandeau cookies (evenement cookie-consent-changed).
 */
export function initAnalytics() {
  if (typeof document === "undefined") return;

  /* 1. Volume de trafic : compte pour TOUS les visiteurs, sans identifiant.
     Aucune donnee personnelle, aucun stockage : pas de consentement requis. */
  trackAnonymousView();

  /* 2. Mesure individuelle (visiteurs uniques + presence) : consentement. */
  if (hasAnalyticsConsent()) {
    startAnalytics();
  } else {
    /* Refus explicite : on ne garde aucun identifiant. */
    if (safeGetItem(KEYS.COOKIE_CONSENT) === "declined") clearLocalAnalyticsIds();
  }

  document.addEventListener("cookie-consent-changed", (event) => {
    const value = event && event.detail ? event.detail.value : null;
    if (value === "accepted") startAnalytics();
    else if (value === "declined") {
      stopAnalytics();
      clearLocalAnalyticsIds();
    }
  });
}

/* Exporte pour le dashboard admin (meme fenetre de "en ligne"). */
export const ANALYTICS_LIVE_TTL_MS = LIVE_TTL_MS;

