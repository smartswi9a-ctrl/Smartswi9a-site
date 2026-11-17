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
import { toDate } from "./utils.js";

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
  if (ms <= 0) return "Terminée";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}j ${pad(h)}:${pad(m)}:${pad(s)}`;
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
