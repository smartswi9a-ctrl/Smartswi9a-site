/* ============================================================
   js/analytics-core.js
   Logique PURE de la mesure d audience (aucune dependance).
   ------------------------------------------------------------
   Separee de js/analytics.js pour deux raisons :
     1. elle est testable sans Firebase ni DOM (tests/analytics.test.mjs) ;
     2. les calculs de periodes restent identiques entre le dashboard
        admin et les tests.

   Regle de confidentialite : on ne manipule qu un identifiant de
   visiteur pseudonyme (UUID local), un chemin de page et une date.
   Aucune IP, aucun nom, aucun email.
   ============================================================ */

export const DAY_MS = 24 * 60 * 60 * 1000;

/* Retenue d une presence avant purge par la politique TTL Firestore.
   7 jours : tres au-dela de la fenetre "en ligne" (5 min), donc un
   document encore actif n est jamais candidat a la suppression. */
export const PRESENCE_TTL_MS = 7 * DAY_MS;

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Cle de jour UTC (YYYY-MM-DD).
 * UTC volontairement : les docs ne dependent pas du fuseau du navigateur.
 * @param {Date|number|string} [date]
 * @returns {string|null}
 */
export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Liste des cles de jour entre deux dates (incluses), ordre croissant.
 * Borne de securite : 400 cles maximum.
 * @param {Date|string} from
 * @param {Date|string} to
 * @returns {string[]}
 */
export function dayKeysBetween(from, to) {
  const start = from instanceof Date ? from : new Date(from);
  const end = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const keys = [];
  let cursor = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate()
  );
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());

  while (cursor <= last && keys.length < 400) {
    keys.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }

  return keys;
}

/* Pages qui ne doivent jamais etre comptees : back-office, outils,
   pages de connexion. Elles gonfleraient les chiffres sans valeur. */
const IGNORED_PREFIXES = [
  "/admin",
  "/vendor",
  "/reset-password",
  "/generer-villes",
  "/404",
];

/**
 * Ce chemin doit-il etre mesure ?
 * @param {string} path
 * @returns {boolean}
 */
export function isTrackablePath(path) {
  const p = String(path || "");
  if (!p.startsWith("/")) return false;
  return !IGNORED_PREFIXES.some(
    (prefix) =>
      p === prefix ||
      p.startsWith(prefix + "/") ||
      p.startsWith(prefix + ".") ||
      p.startsWith(prefix + "-")
  );
}

/**
 * Normalise un chemin mesure : sans query, sans ancre, 120 caracteres max.
 * @param {string} path
 * @returns {string}
 */
export function normalizeTrackedPath(path) {
  const raw = String(path || "/").split("?")[0].split("#")[0].trim();
  return (raw || "/").slice(0, 120);
}

/**
 * Faut-il enregistrer une vue ? (une seule par session et par jour)
 * @param {string} lastKey valeur memorisee localement
 * @param {string} dateKey jour courant
 * @param {string} sessionId session courante
 * @returns {boolean}
 */
export function shouldRecordView(lastKey, dateKey, sessionId) {
  if (!dateKey || !sessionId) return false;
  return String(lastKey || "") !== String(dateKey) + "|" + String(sessionId);
}

function visitorSet(entries) {
  const set = new Set();
  for (const entry of entries) {
    const visitors = entry && entry.visitors;
    if (!Array.isArray(visitors)) continue;
    for (const id of visitors) {
      if (id) set.add(String(id));
    }
  }
  return set;
}

function sumViews(entries) {
  let total = 0;
  for (const entry of entries) {
    total += Math.max(0, Math.floor(Number(entry && entry.views) || 0));
  }
  return total;
}

/**
 * Agrege les documents analytics_daily en 4 periodes.
 *
 * Les visiteurs uniques sont dedoublonnes sur la periode (union des
 * identifiants), et non pas additionnes jour par jour : un visiteur qui
 * revient le lendemain ne compte qu une fois.
 *
 * @param {Array<{id:string, views:number, visitors:string[]}>} entries
 * @param {Date} [now]
 * @returns {{today:object, week:object, month:object, year:object, total:object}}
 */
export function aggregateTraffic(entries, now = new Date()) {
  const list = Array.isArray(entries)
    ? entries.filter((e) => e && DAY_KEY_PATTERN.test(String(e.id || "")))
    : [];
  const byId = new Map(list.map((e) => [String(e.id), e]));
  const todayK = dayKey(now);

  const todayDoc = todayK ? byId.get(todayK) : null;
  const todayDocs = todayDoc ? [todayDoc] : [];

  const period = (days) => {
    const keys = dayKeysBetween(
      new Date(now.getTime() - (days - 1) * DAY_MS),
      now
    );
    const docs = keys.map((k) => byId.get(k)).filter(Boolean);
    return {
      days,
      views: sumViews(docs),
      visitors: visitorSet(docs).size,
      entries: docs.length,
    };
  };

  return {
    today: {
      days: 1,
      views: sumViews(todayDocs),
      visitors: visitorSet(todayDocs).size,
      entries: todayDocs.length,
    },
    week: period(7),
    month: period(30),
    year: period(365),
    total: {
      views: sumViews(list),
      visitors: visitorSet(list).size,
      entries: list.length,
    },
  };
}

/**
 * Construit une serie continue de N jours pour le graphique du dashboard.
 * Les jours sans donnees sont completes par des zeros (le graphique ne
 * doit jamais avoir de trou).
 *
 * @param {Array<{id:string, views:number, visitors:string[]}>} entries
 * @param {number} [days] nombre de jours (1 a 365)
 * @param {Date} [now]
 * @returns {Array<{date:string, views:number, visitors:number}>}
 */
export function buildTrafficSeries(entries, days = 14, now = new Date()) {
  const raw = Math.floor(Number(days));
  const n = Number.isFinite(raw) ? Math.max(1, Math.min(365, raw)) : 14;
  const list = Array.isArray(entries) ? entries : [];
  const byId = new Map();

  for (const entry of list) {
    if (!entry) continue;
    const id = String(entry.id || "");
    if (!DAY_KEY_PATTERN.test(id)) continue;
    byId.set(id, entry);
  }

  const keys = dayKeysBetween(new Date(now.getTime() - (n - 1) * DAY_MS), now);

  return keys.map((date) => {
    const doc = byId.get(date);
    return {
      date,
      views: Math.max(0, Math.floor(Number(doc && doc.views) || 0)),
      visitors: doc && Array.isArray(doc.visitors) ? doc.visitors.length : 0,
    };
  });
}

/**
 * Visiteurs en ligne : lastSeen dans la fenetre TTL.
 * @param {Array<{path:string, lastSeen:Date|number|object}>} presences
 * @param {Date} [now]
 * @param {number} [ttlMs]
 * @returns {{count:number, pages:Array<{path:string,count:number}>}}
 */
export function computeOnline(
  presences,
  now = new Date(),
  ttlMs = 5 * 60 * 1000
) {
  const list = Array.isArray(presences) ? presences : [];
  const nowMs = now.getTime();
  const byPage = new Map();
  let count = 0;

  for (const presence of list) {
    if (!presence) continue;
    const raw = presence.lastSeen;
    let ms = NaN;
    if (raw instanceof Date) ms = raw.getTime();
    else if (typeof raw === "number") ms = raw;
    else if (raw && typeof raw.toDate === "function") ms = raw.toDate().getTime();
    if (!Number.isFinite(ms)) continue;
    if (nowMs - ms > ttlMs) continue;

    const page = normalizeTrackedPath(presence.path || "/");
    if (!isTrackablePath(page)) continue;

    count += 1;
    byPage.set(page, (byPage.get(page) || 0) + 1);
  }

  const pages = [...byPage.entries()]
    .map(([path, n]) => ({ path, count: n }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  return { count, pages };
}

/**
 * Date d expiration d une presence, utilisee par la politique TTL
 * Firestore sur presence.expireAt.
 *
 * Pourquoi un champ dedie : le TTL Firestore prend la valeur du champ
 * comme date d expiration, sans decalage. Mettre le TTL sur lastSeen
 * rendrait chaque document "deja expire" et pourrait supprimer un
 * visiteur actif entre deux battements de coeur.
 *
 * @param {number} nowMs horodatage courant en millisecondes
 * @param {number} [ttlMs] retenue, 7 jours par defaut
 * @returns {number} horodatage d expiration en millisecondes
 */
export function presenceExpireAt(nowMs, ttlMs = PRESENCE_TTL_MS) {
  const now = Number(nowMs);
  const ttl = Number(ttlMs);
  const base = Number.isFinite(now) && now > 0 ? now : Date.now();
  const duree = Number.isFinite(ttl) && ttl > 0 ? ttl : PRESENCE_TTL_MS;
  return base + duree;
}
