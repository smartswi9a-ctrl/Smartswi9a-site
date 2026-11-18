/* ============================================================
   js/ranking.js
   TRI INTELLIGENT LOCAL (A1)
   ============================================================
   Objectif : ordonner le catalogue selon l interet reel de
   l utilisateur, sans jamais envoyer de donnee personnelle a un
   tiers. Tout est calcule dans le navigateur.

   SCORE (pondere)          poids
     achat                    5
     clic produit             3
     recherche                2
     popularite (ventes/avis) 2
     promotion active         1

   DECROISSANCE (sur la date du dernier evenement)
     moins de 7 jours   -> plein
     7 a 30 jours       -> moitie
     plus de 30 jours   -> ignore

   ORDRE STABLE
     La graine (seed) est stockee et ne change que toutes les 6 h :
     un rechargement ne remelange donc pas les cartes. Les ex aequo
     sont departages par une valeur deterministe (produit + graine).

   FUSION
     Deux sources (locale et distante) fusionnent par evenement :
     on garde le plus grand compte ET la date la plus recente. Une
     source ne peut donc jamais ecraser l autre.

   Ce fichier est PUR : aucun acces DOM, aucun reseau. Les fonctions
   de stockage sont isolees en bas et se desactivent hors navigateur,
   ce qui permet de tester toutes les regles sous Node.

   ALERTE 1 : aucun commentaire de ligne dans ce fichier.
   ============================================================ */

export const RANKING_STORAGE_KEY = "swi9a_ranking_v1";
export const RANKING_VERSION = 1;

export const RANKING_EVENT_WEIGHTS = {
  purchase: 5,
  click: 3,
  search: 2,
};

export const RANKING_POPULARITY_WEIGHT = 2;
export const RANKING_PROMO_WEIGHT = 1;

export const RANKING_FULL_MS = 7 * 24 * 60 * 60 * 1000;
export const RANKING_HALF_MS = 30 * 24 * 60 * 60 * 1000;
export const RANKING_SEED_TTL_MS = 6 * 60 * 60 * 1000;
export const RANKING_MAX_PRODUCTS = 100;

function seedFrom(now) {
  return Math.floor(Number(now) / 1000) % 2147483647 || 1;
}

/**
 * Etat vide (horloge fournie pour rester testable).
 * @param {number} now
 * @returns {object}
 */
export function createEmptyRanking(now = Date.now()) {
  return {
    version: RANKING_VERSION,
    seed: seedFrom(now),
    seedAt: now,
    events: {},
  };
}

/**
 * Repare un etat lu depuis le stockage (donnee corrompue, ancienne version).
 * @param {object} raw
 * @param {number} now
 * @returns {object}
 */
export function normalizeRanking(raw, now = Date.now()) {
  const empty = createEmptyRanking(now);
  if (!raw || typeof raw !== "object") return empty;

  const events = {};
  const source = raw.events && typeof raw.events === "object" ? raw.events : {};

  for (const productId of Object.keys(source)) {
    const value = source[productId];
    if (!value || typeof value !== "object") continue;
    const clean = {};
    for (const type of Object.keys(RANKING_EVENT_WEIGHTS)) {
      const entry = value[type];
      if (!entry || typeof entry !== "object") continue;
      const count = Math.max(0, Math.floor(Number(entry.n) || 0));
      const lastAt = Math.max(0, Number(entry.t) || 0);
      if (count > 0 && lastAt > 0) clean[type] = { n: count, t: lastAt };
    }
    if (Object.keys(clean).length > 0) events[String(productId)] = clean;
  }

  return {
    version: RANKING_VERSION,
    seed: Number(raw.seed) || empty.seed,
    seedAt: Number(raw.seedAt) || now,
    events,
  };
}

/**
 * Facteur de decroissance applique a un evenement.
 * @param {number} lastAt
 * @param {number} now
 * @returns {number} 1, 0.5 ou 0
 */
export function decayFactor(lastAt, now = Date.now()) {
  const stamp = Number(lastAt) || 0;
  if (stamp <= 0) return 0;
  const age = Math.max(0, Number(now) - stamp);
  if (age < RANKING_FULL_MS) return 1;
  if (age <= RANKING_HALF_MS) return 0.5;
  return 0;
}

/**
 * Un produit est-il en promotion ?
 * Prix barre OU vente flash active.
 * @param {object} product
 * @returns {boolean}
 */
export function isPromoted(product) {
  if (!product) return false;
  const price = Number(product.price) || 0;
  const oldPrice = Number(product.oldPrice) || 0;
  if (oldPrice > price && price > 0) return true;
  const flash = Number(product.flashPrice) || 0;
  return flash > 0 && price > 0 && flash < price;
}

/**
 * Popularite normalisee (0 a 1) : ventes et note ponderee par le nombre d avis.
 * @param {object} product
 * @returns {number}
 */
export function popularityScore(product) {
  if (!product) return 0;
  const sales = Math.max(0, Number(product.salesCount) || 0);
  const ratingCount = Math.max(0, Number(product.ratingCount) || 0);
  const rating = Math.min(5, Math.max(0, Number(product.ratingAvg) || 0));
  const salesPart = Math.min(1, sales / 50);
  const ratingPart = (rating / 5) * Math.min(1, ratingCount / 20);
  return Math.min(1, salesPart + ratingPart);
}

/**
 * Score d un produit pour un etat donne.
 * @param {object} product
 * @param {object} events table productId -> { type: { n, t } }
 * @param {number} now
 * @returns {number}
 */
export function scoreProduct(product, events, now = Date.now()) {
  if (!product) return 0;
  const entry = (events && events[String(product.id)]) || {};

  let score = 0;
  for (const type of Object.keys(RANKING_EVENT_WEIGHTS)) {
    const event = entry[type];
    if (!event) continue;
    score +=
      RANKING_EVENT_WEIGHTS[type] * event.n * decayFactor(event.t, now);
  }

  score += RANKING_POPULARITY_WEIGHT * popularityScore(product);
  if (isPromoted(product)) score += RANKING_PROMO_WEIGHT;

  return Math.round(score * 100) / 100;
}

/**
 * Valeur deterministe 0..1 pour departager deux scores egaux.
 * Meme produit + meme graine = meme valeur, a chaque chargement.
 * @param {string|number} productId
 * @param {number} seed
 * @returns {number}
 */
export function stableJitter(productId, seed) {
  const text = String(productId ?? "") + "|" + String(seed ?? "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

/**
 * Ordonne une liste de produits par pertinence.
 * @param {Array} products
 * @param {object} state etat du classement (events + seed)
 * @param {number} now
 * @returns {Array} nouvelle liste ordonnee
 */
export function sortByRelevance(products, state, now = Date.now()) {
  const list = Array.isArray(products) ? products : [];
  const events = state && state.events ? state.events : {};
  const seed = (state && state.seed) || 1;

  return list
    .map((product) => ({
      product,
      score: scoreProduct(product, events, now),
      jitter: stableJitter(product && product.id, seed),
    }))
    .sort((a, b) => b.score - a.score || a.jitter - b.jitter)
    .map((entry) => entry.product);
}

/**
 * Enregistre un evenement dans un etat (mutation volontaire, sans stockage).
 * @param {object} state
 * @param {string|number} productId
 * @param {string} type purchase | click | search
 * @param {number} now
 * @param {number} delta
 * @returns {object} le meme etat
 */
export function trackEvent(state, productId, type, now = Date.now(), delta = 1) {
  if (!state || typeof state !== "object") return state;
  if (!Object.prototype.hasOwnProperty.call(RANKING_EVENT_WEIGHTS, type)) {
    return state;
  }
  const key = String(productId ?? "");
  if (!key) return state;

  if (!state.events || typeof state.events !== "object") state.events = {};
  const entry = state.events[key] || (state.events[key] = {});
  const previous = entry[type] || { n: 0, t: 0 };
  const step = Math.max(1, Math.floor(Number(delta) || 1));

  entry[type] = { n: Math.max(0, previous.n + step), t: now };
  return state;
}

/**
 * Fusionne deux etats (local + distant) par evenement.
 * Regle : on garde le plus grand compte ET la date la plus recente.
 * Aucune source n ecrase l autre, aucun evenement n est perdu.
 * @param {object} local
 * @param {object} remote
 * @returns {object} nouvel etat
 */
export function mergeRanking(local, remote) {
  const a = normalizeRanking(local);
  const b = normalizeRanking(remote);
  const events = {};
  const ids = new Set([...Object.keys(a.events), ...Object.keys(b.events)]);

  for (const id of ids) {
    const left = a.events[id] || {};
    const right = b.events[id] || {};
    const merged = {};
    for (const type of Object.keys(RANKING_EVENT_WEIGHTS)) {
      const l = left[type];
      const r = right[type];
      if (!l && !r) continue;
      merged[type] = {
        n: Math.max(l ? l.n : 0, r ? r.n : 0),
        t: Math.max(l ? l.t : 0, r ? r.t : 0),
      };
    }
    if (Object.keys(merged).length > 0) events[id] = merged;
  }

  return { version: RANKING_VERSION, seed: a.seed, seedAt: a.seedAt, events };
}

/**
 * Fait tourner la graine toutes les 6 h (et seulement la).
 * @param {object} state
 * @param {number} now
 * @returns {object}
 */
export function ensureSeed(state, now = Date.now()) {
  const base =
    state && typeof state === "object" ? state : createEmptyRanking(now);
  const seedAt = Number(base.seedAt) || 0;
  if (!Number(base.seed) || !seedAt || now - seedAt > RANKING_SEED_TTL_MS) {
    return { ...base, seed: seedFrom(now), seedAt: now };
  }
  return base;
}

/**
 * Borne la taille de l etat pour le stockage (local et Firestore).
 * On garde les produits dont le dernier evenement est le plus recent.
 * @param {object} state
 * @param {number} max
 * @returns {object}
 */
export function trimRanking(state, max = RANKING_MAX_PRODUCTS) {
  const base = state && typeof state === "object" ? state : createEmptyRanking();
  const entries = Object.entries(base.events || {});
  const limit = Math.max(1, Math.floor(Number(max) || RANKING_MAX_PRODUCTS));
  if (entries.length <= limit) return base;

  const latest = (entry) => {
    let stamp = 0;
    for (const type of Object.keys(entry || {})) {
      stamp = Math.max(stamp, Number(entry[type] && entry[type].t) || 0);
    }
    return stamp;
  };

  entries.sort((a, b) => latest(b[1]) - latest(a[1]));
  return { ...base, events: Object.fromEntries(entries.slice(0, limit)) };
}

/* ---------------------------------------------
   Stockage local (le seul code impur du fichier).
   Hors navigateur (tests Node), ces fonctions sont inactives.
   --------------------------------------------- */

function hasStorage() {
  try {
    return typeof localStorage !== "undefined" && localStorage !== null;
  } catch (e) {
    return false;
  }
}

export function loadRankingState(now = Date.now()) {
  if (!hasStorage()) return createEmptyRanking(now);
  try {
    const raw = localStorage.getItem(RANKING_STORAGE_KEY);
    if (!raw) return createEmptyRanking(now);
    return normalizeRanking(JSON.parse(raw), now);
  } catch (e) {
    return createEmptyRanking(now);
  }
}

export function saveRankingState(state) {
  if (!hasStorage() || !state) return false;
  try {
    localStorage.setItem(RANKING_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Enregistre un evenement et persiste l etat.
 * @param {string|number} productId
 * @param {string} type
 * @param {number} delta
 * @param {number} now
 * @returns {object}
 */
export function trackRankingEvent(productId, type, delta = 1, now = Date.now()) {
  const state = ensureSeed(loadRankingState(now), now);
  trackEvent(state, productId, type, now, delta);
  saveRankingState(state);
  /* Signal pour la synchronisation (js/ranking-sync.js), sans coupler ce
     module pur a Firestore. */
  if (typeof document !== "undefined") {
    try {
      document.dispatchEvent(new CustomEvent("ranking-updated"));
    } catch (e) {
      /* environnement sans CustomEvent : on ignore */
    }
  }
  return state;
}

/**
 * Etat pret pour le tri (graine verifiee et persistee si necessaire).
 * @param {number} now
 * @returns {object}
 */
export function getRankingSnapshot(now = Date.now()) {
  const loaded = loadRankingState(now);
  const withSeed = ensureSeed(loaded, now);
  /* On persiste aussi le PREMIER passage : sans cela la graine serait
     recalculee a chaque rechargement et l ordre des ex aequo changerait. */
  let stored = null;
  if (hasStorage()) {
    try {
      stored = localStorage.getItem(RANKING_STORAGE_KEY);
    } catch (e) {
      stored = null;
    }
  }
  if (withSeed !== loaded || !stored) saveRankingState(withSeed);
  return withSeed;
}

export function clearRankingState() {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(RANKING_STORAGE_KEY);
  } catch (e) {
    /* stockage indisponible : rien a faire */
  }
}