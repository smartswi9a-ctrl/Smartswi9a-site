/* ============================================================
   js/flash-sales.js
   VENTE FLASH — SMARTSWIKA
   ============================================================
   Une vente flash applique une remise TEMPORAIRE sur un ensemble de
   produits, sur une fenetre [startsAt, endsAt].

   MODELE Firestore — collection `flash_sales`
     title           : string  (ex. "Black Friday -50%")
     slug            : string  (identifiant lisible)
     productIds      : string[] (produits concernes)
     discountType    : 'percent' | 'fixed'
     discountValue   : number  (20 = -20% ou -20 MAD)
     startsAt        : Timestamp
     endsAt          : Timestamp
     scope           : 'platform' | 'vendor'
     vendorId        : string|null
     maxQuantity     : number|null (limite globale de ventes)
     soldCount       : number  (incremente a chaque commande)
     status          : 'draft' | 'active' | 'ended'
     createdAt/createdBy

   SECURITE
     - Le prix final est recalcule COTE SERVEUR dans createCustomerOrder :
       le client ne peut pas imposer un prix remise.

   COHERENCE PRIX
     Le prix affiche reste `product.price`. La remise flash est appliquee
     par-dessus et n ecrase JAMAIS `price` en base : desactiver la vente
     flash restitue donc immediatement le prix normal.
   ============================================================ */

import { db } from "./firebase.js";
import { collection, query, where, getDocs, limit } from "firebase/firestore";
import { t, getLang, toDate } from "./utils.js";

/* Cache memoire : evite de relire Firestore a chaque carte produit. */
let _flashCache = { at: 0, sales: [] };
const FLASH_CACHE_TTL_MS = 60 * 1000;

/**
 * Une vente flash est-elle en cours a l instant t ?
 * @param {object} sale
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isFlashSaleLive(sale, now = new Date()) {
  if (!sale || sale.status !== "active") return false;
  const start = toDate(sale.startsAt);
  const end = toDate(sale.endsAt);
  if (!start || !end) return false;
  const t = now.getTime();
  if (t < start.getTime() || t > end.getTime()) return false;
  if (sale.maxQuantity != null && Number(sale.soldCount || 0) >= Number(sale.maxQuantity)) {
    return false;
  }
  return true;
}

/**
 * Calcule le prix remise d un produit pour une vente flash donnee.
 * Le resultat est borne : jamais negatif, jamais superieur au prix initial.
 * @param {number} price
 * @param {object} sale
 * @returns {{ finalPrice: number, discount: number, percent: number }}
 */
export function computeFlashPrice(price, sale) {
  const base = Math.max(0, Number(price) || 0);
  if (!sale || !isFlashSaleLive(sale)) {
    return { finalPrice: base, discount: 0, percent: 0 };
  }
  const value = Math.max(0, Number(sale.discountValue) || 0);
  let discount = 0;
  if (sale.discountType === "percent") {
    discount = Math.round((base * Math.min(value, 100)) / 100);
  } else {
    discount = Math.min(Math.round(value), base);
  }
  const finalPrice = Math.max(0, base - discount);
  const percent = base > 0 ? Math.round((discount / base) * 100) : 0;
  return { finalPrice, discount, percent };
}

/**
 * Charge les ventes flash en cours (cache 60 s).
 * @returns {Promise<Array>}
 */
export async function loadLiveFlashSales() {
  const now = Date.now();
  if (now - _flashCache.at < FLASH_CACHE_TTL_MS) return _flashCache.sales;

  try {
    const q = query(collection(db, "flash_sales"), where("status", "==", "active"), limit(50));
    const snap = await getDocs(q);
    const sales = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((s) => isFlashSaleLive(s));
    _flashCache = { at: now, sales };
    return sales;
  } catch (e) {
    console.warn("[flash-sales] chargement impossible :", e?.code || e?.message);
    return [];
  }
}

/**
 * Retourne la vente flash applicable a un produit (la plus avantageuse).
 * @param {string} productId
 * @param {Array} [sales] ventes deja chargees (evite un appel reseau)
 * @returns {Promise<object|null>}
 */
export async function getFlashSaleForProduct(productId, sales = null) {
  const list = sales || (await loadLiveFlashSales());
  const pid = String(productId || "");
  if (!pid) return null;

  let best = null;
  let bestPercent = -1;
  for (const sale of list) {
    if (!Array.isArray(sale.productIds)) continue;
    if (!sale.productIds.map(String).includes(pid)) continue;
    const p = computeFlashPrice(1, sale).percent;
    if (p > bestPercent) { bestPercent = p; best = sale; }
  }
  return best;
}

/**
 * Applique la remise flash a une liste de produits.
 * Ajoute `flashPrice`, `flashDiscount`, `flashPercent`, `flashSaleId`.
 * Le champ `price` n est PAS modifie.
 * @param {Array} products
 * @returns {Promise<Array>}
 */
export async function applyFlashSales(products) {
  if (!Array.isArray(products) || products.length === 0) return products;
  const sales = await loadLiveFlashSales();
  if (sales.length === 0) return products;

  for (const p of products) {
    const sale = await getFlashSaleForProduct(p.id, sales);
    if (!sale) continue;
    const { finalPrice, discount, percent } = computeFlashPrice(p.price, sale);
    p.flashPrice = finalPrice;
    p.flashDiscount = discount;
    p.flashPercent = percent;
    p.flashSaleId = sale.id;
    p.flashEndsAt = toDate(sale.endsAt);
  }
  return products;
}

/**
 * Prix effectif d un produit (remise flash prioritaire sur le prix normal).
 * @param {object} product
 * @returns {number}
 */
export function getEffectivePrice(product) {
  if (!product) return 0;
  if (Number.isFinite(product.flashPrice) && product.flashPrice > 0) return product.flashPrice;
  return Math.max(0, Number(product.price) || 0);
}

/**
 * Invalide le cache (apres creation/edition d une vente flash depuis l admin).
 * @returns {void}
 */
export function invalidateFlashSalesCache() {
  _flashCache = { at: 0, sales: [] };
}

/* ============================================================
   COMPTE A REBOURS (affichage client)
   ------------------------------------------------------------
   Un SEUL timer global met a jour tous les elements portant
   data-flash-ends="<ISO>". Evite un setInterval par carte produit.
   Quand la date est passee, le texte affiche « Terminée ».
   ============================================================ */

let _countdownTimer = null;

function formatRemaining(ms) {
  if (ms <= 0) return t("flashEnded");
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}${t("flashDayShort")} ${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function tickCountdowns() {
  const nodes = document.querySelectorAll("[data-flash-ends]");
  if (nodes.length === 0) {
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
    return;
  }
  const now = Date.now();
  nodes.forEach((el) => {
    const iso = el.getAttribute("data-flash-ends");
    if (!iso) return;
    const end = new Date(iso).getTime();
    if (Number.isNaN(end)) return;
    const target = el.querySelector(".flash-timer") || el;
    if (el.classList.contains("flash-timer")) return;
    target.textContent = formatRemaining(end - now);
    if (end - now <= 0) el.classList.add("is-ended");
  });
}

/**
 * Demarre (ou relance) le compte a rebours global.
 * Idempotent : un seul interval actif. A appeler apres chaque rendu.
 * @returns {void}
 */
export function startFlashCountdown() {
  tickCountdowns();
  if (_countdownTimer) return;
  _countdownTimer = setInterval(tickCountdowns, 1000);
}

/**
 * Arrete le timer (utile au changement de page).
 * @returns {void}
 */
export function stopFlashCountdown() {
  if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
}

/* ============================================================
   SECTION DEDIEE EN HAUT DE L ACCUEIL
   ------------------------------------------------------------
   Affiche un carrousel horizontal des produits en vente flash.
   La section est masquee si aucune vente active : pas de bloc vide.
   Le compte a rebours affiche la FIN LA PLUS PROCHE parmi les ventes
   en cours (c est l urgence reelle pour le visiteur).
   ============================================================ */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function pickImage(product) {
  const p = product || {};
  if (Array.isArray(p.images) && p.images.length) {
    const first = p.images.find(Boolean);
    if (first) return String(first);
  }
  if (p.image) return String(p.image);
  return "";
}

/**
 * Miniature carree d un produit en vente flash. Markup ET classes
 * identiques a la vitrine Koulchi (.duo-thumb) : les deux cartes du duo
 * ont donc la meme grille de miniatures 1:1.
 * @param {object} product
 * @returns {string}
 */
function renderFlashThumb(product) {
  const img = pickImage(product);
  const lang = getLang();
  const name = String(
    (lang === "ar" && product.nameAr) ||
      (lang === "en" && product.nameEn) ||
      product.nameFr ||
      product.nameEn ||
      "Produit"
  );
  const slug = String(product.slug || product.id || "");
  const pct = Number(product.flashPercent) || 0;

  return `<a class="duo-thumb flash-duo-thumb" role="listitem" href="/produit?slug=${encodeURIComponent(
    slug
  )}" title="${esc(name)}" aria-label="${esc(name)}">
      ${img ? `<img src="${esc(img)}" alt="${esc(name)}" loading="lazy" width="160" height="160">` : ""}
      ${pct > 0 ? `<span class="duo-thumb-off">−${pct} %</span>` : ""}
    </a>`;
}

/**
 * Emplacements vides : trois carres de meme taille que les vraies
 * miniatures. La carte garde donc EXACTEMENT la hauteur de la carte
 * Koulchi dialk, meme quand aucune vente flash n est active.
 * @returns {string}
 */
function renderFlashPlaceholders() {
  const slot = `<span class="duo-thumb is-empty" role="listitem" aria-hidden="true">🛍️</span>`;
  return slot.repeat(3);
}

/**
 * Trois pastilles compactes : les meilleures remises en cours.
 * @param {Array} items
 * @returns {string}
 */
function renderFlashStats(items) {
  const percents = [];
  for (const product of items) {
    const pct = Number(product.flashPercent) || 0;
    if (pct > 0 && !percents.includes(pct)) percents.push(pct);
  }
  const slots = percents.slice(0, 3);
  while (slots.length < 3) {
    slots.push(slots.length ? slots[slots.length - 1] : 0);
  }
  return slots
    .map(
      (pct) =>
        `<li class="duo-stat flash-duo-stat" role="listitem">${
          pct > 0 ? `−${pct} %` : "—"
        }</li>`
    )
    .join("");
}

/**
 * Construit et affiche la carte ventes flash de l accueil.
 * La carte est JUMELLE de la vitrine Koulchi : elle reste affichee en
 * 2 colonnes, avec un etat vide harmonise si aucune vente n est active.
 * Ne fait rien si la section n existe pas dans le DOM.
 * @param {Array} products liste complete des produits charges
 * @returns {Promise<void>}
 */
export async function renderFlashHero(products) {
  const section = document.getElementById("flashSection");
  const track = document.getElementById("flashHeroTrack");
  if (!section || !track) return;

  const statsEl = document.getElementById("flashHeroStats");
  const timerEl = document.getElementById("flashHeroTimer");
  const subEl = section.querySelector(".flash-hero-sub");
  const list = Array.isArray(products) ? products : [];

  /* Produits effectivement en vente flash. */
  const items = list.filter(
    (p) =>
      Number.isFinite(p.flashPrice) &&
      p.flashPrice > 0 &&
      p.flashPrice < Number(p.price)
  );

  section.hidden = false;
  section.dataset.flashCount = String(items.length);

  /* Etat vide harmonise : meme hauteur que la carte Koulchi (3 carres). */
  if (items.length === 0) {
    if (timerEl) {
      timerEl.removeAttribute("data-flash-ends");
      timerEl.textContent = "--:--:--";
    }
    if (subEl) subEl.textContent = t("flashEmpty");
    if (statsEl) statsEl.innerHTML = renderFlashStats([]);
    track.innerHTML = renderFlashPlaceholders();
    return;
  }

  if (subEl) subEl.textContent = t("flashSub");
  if (statsEl) statsEl.innerHTML = renderFlashStats(items);

  /* La fin la plus proche : c est elle qui doit s afficher dans le bandeau. */
  let nearestEnd = null;
  for (const p of items) {
    const d = p.flashEndsAt ? new Date(p.flashEndsAt).getTime() : null;
    if (d && (!nearestEnd || d < nearestEnd)) nearestEnd = d;
  }

  if (timerEl) {
    if (nearestEnd) {
      timerEl.setAttribute("data-flash-ends", new Date(nearestEnd).toISOString());
    } else {
      timerEl.removeAttribute("data-flash-ends");
    }
  }

  /* Trois miniatures maximum, comme la vitrine Koulchi (2 sous 1024 px). */
  track.innerHTML = items.slice(0, 3).map(renderFlashThumb).join("");

  startFlashCountdown();
}

/* ============================================================
   RE-RENDU AU CHANGEMENT DE LANGUE
   ------------------------------------------------------------
   Les libelles de la section flash sont generes en JS : ils ne sont
   pas couverts par applyTranslations(). On re-rend donc la section
   quand l utilisateur change de langue, avec la liste de produits
   actuellement affichee.
   ============================================================ */

let _lastProducts = null;

/**
 * Memorise les produits pour permettre un re-rendu sans rechargement.
 * @param {Array} products
 * @returns {void}
 */
export function rememberFlashProducts(products) {
  _lastProducts = Array.isArray(products) ? products : null;
}

/**
 * Re-rend la section flash dans la langue courante.
 * @returns {Promise<void>}
 */
export async function refreshFlashHeroLang() {
  if (!_lastProducts) return;
  await renderFlashHero(_lastProducts);
}

/* Re-rend la section dans la nouvelle langue (meme pattern que panier.js). */
document.addEventListener("lang-changed", () => {
  refreshFlashHeroLang();
});
