/* ============================================================ js/products.js GESTION DES PRODUITS - SMARTSWIKA Version 9.0.0 - Lot 9/30 : corrections critiques + fallback stats CHANGEMENTS v9.0.0 : - B1 (P0) : getProductStatsBatch — fallback automatique sur query simple (limit 500) si l'index Firestore (productId + status) est manquant (code failed-precondition). Warning émis une seule fois par session. Notes étoiles visibles même sans index. - P0-5 (P0) : loadProductsFromFirestore — messages structurés pour guider l'admin si le catalogue est vide (migration produits non faite + règles Firestore strictes = silence radio). - P1-9 (P2) : fallback complet limité à 1000 produits (évite la surcharge Firestore sur grosse base). - X1 (P1) : processSnapshot filtre les Smart products avec status présent et != 'approved' (cohérent avec vendeurs). Legacy sans status conservé. - Dead code retiré : imports getProductOwner, CATEGORIES, normalizeCategory (non utilisés). - JSDoc sur exports publics. - Bump version 8.3.0 -> 9.0.0. ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import {
  collection,
  getDocs,
  query,
  where,
  doc,
  updateDoc,
  arrayUnion,
  arrayRemove,
  limit,
} from "firebase/firestore";
import { db } from "./firebase.js";
import {
  CONFIG,
  SORT_OPTIONS,
  CATEGORY_GROUPS,
  productMatchesCategory,
  getCategoryById,
} from "./config.js?v=2";
import {
  getRankingSnapshot,
  sortByRelevance,
  trackRankingEvent,
} from "./ranking.js";
import {
  t,
  escapeHTML,
  getProductName,
  getProductDesc,
  getProductImageUrl,
  getFallbackImage,
  getLang,
  fetchWithRetry,
  firestoreWithRetry,
  getDiscountPercent,
  toDate,
} from "./utils.js";
import { shopT } from "./shop-i18n.js";
/* Vente flash : remise temporaire appliquee par-dessus product.price. */
import { applyFlashSales, getEffectivePrice, startFlashCountdown } from "./flash-sales.js";
import {
  getProducts,
  setProducts,
  getFilters,
  setFilters,
  resetFilters,
  getPagination,
  setPagination,
} from "./store.js";
import { getCurrentUser, setCurrentUser } from "./auth.js";
import { showToast } from "./ui-core.js";
import {
  preloadVendorsForProducts,
  getProductVendorLabelSync,
} from "./vendor-attribution.js";
import { normalizeProductId } from "./domain/product-id.js";

/* ============================================================ CACHE STATS AVIS ============================================================ Clé = String(normalizedPid) pour supporter Number ET String. TTL = 60s. MAX = 100 entrées (éviction FIFO). ============================================================ */
const _statsCache = new Map();
const STATS_CACHE_TTL = 60 * 1000;
const STATS_CACHE_MAX = 100;

/* B1 : flag pour n'émettre le warning "index manquant" qu'une seule fois par session (évite de spammer la console). */
let _statsIndexWarned = false;

/* Guards de render concurrent. */
let _renderRequestId = 0;
let _lastRenderedParentId = null;
let _lastRenderedLang = null;

/* ============================================================ NORMALISATION D'ID PRODUIT ============================================================ - "42" (chaîne numérique) -> 42 (Number) - compat favoris/avis - "abc123" (auto-ID Firestore vendeur) -> "abc123" (String) - null/undefined/"" -> null Doit rester IDENTIQUE à reviews.js / product-detail.js / boutique.js. ============================================================ */

if (typeof document !== "undefined") {
  document.addEventListener("review-submitted", (e) => {
    const pid = normalizeProductId(e.detail?.productId);
    if (pid != null) {
      _statsCache.delete(String(pid));
      _statsCache.delete(Number(pid));
    }
  });
}

/* ============================================================ CSS INJECTION (scroll horizontal des catégories) ============================================================ */
const CATEGORIES_SCROLL_CSS_ID = "categories-scroll-css";

function injectCategoriesScrollCSS() {
  if (typeof document === "undefined") return;
  if (document.getElementById(CATEGORIES_SCROLL_CSS_ID)) return;

  const style = document.createElement("style");
  style.id = CATEGORIES_SCROLL_CSS_ID;
  style.textContent = ` .categories-scroll-wrapper { position: relative; width: 100%; } .categories-scroll-btn { position: absolute; top: 50%; transform: translateY(-50%); width: 34px; height: 34px; border-radius: 50%; background: rgba(var(--gold-rgb, 212, 163, 75), 0.15); border: 1px solid var(--border-gold, rgba(180, 130, 40, 0.4)); color: var(--gold, #a57b2e); display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 10; transition: all 0.2s ease; font-size: 1.2rem; font-weight: 700; line-height: 1; padding: 0; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); } .categories-scroll-btn:hover:not(:disabled) { background: var(--gold, #a57b2e); color: #ffffff; transform: translateY(-50%) scale(1.08); box-shadow: 0 4px 12px rgba(165, 123, 46, 0.35); } .categories-scroll-btn:disabled { opacity: 0.35; cursor: not-allowed; pointer-events: none; } .categories-scroll-btn.prev { left: 4px; } .categories-scroll-btn.next { right: 4px; } [dir="rtl"] .categories-scroll-btn.prev { left: auto; right: 4px; } [dir="rtl"] .categories-scroll-btn.next { right: auto; left: 4px; } .categories-scroll-wrapper .categories-scroll-row { padding-left: 0; padding-right: 0; } @media (max-width: 900px), (hover: none) { .categories-scroll-btn { display: none !important; } } #subFiltersCategories .categories-scroll-btn { width: 28px; height: 28px; font-size: 1rem; } `;
  document.head.appendChild(style);
}

/* ============================================================ SCROLL BUTTONS ============================================================ */
const SCROLL_STEP = 300;
let _globalScrollListenersAttached = false;

function attachScrollButtons(wrapper) {
  if (!wrapper || wrapper._scrollBtnsAttached) return;
  wrapper._scrollBtnsAttached = true;
  const row = wrapper.querySelector(".categories-scroll-row");
  const prevBtn = wrapper.querySelector(".categories-scroll-btn.prev");
  const nextBtn = wrapper.querySelector(".categories-scroll-btn.next");
  if (!row || !prevBtn || !nextBtn) return;

  prevBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.scrollBy({ left: -SCROLL_STEP, behavior: "smooth" });
  });
  nextBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.scrollBy({ left: SCROLL_STEP, behavior: "smooth" });
  });
  requestAnimationFrame(() => updateScrollBtnVisibility(wrapper));
}

function updateScrollBtnVisibility(wrapper) {
  if (!wrapper) return;
  const row = wrapper.querySelector(".categories-scroll-row");
  const prevBtn = wrapper.querySelector(".categories-scroll-btn.prev");
  const nextBtn = wrapper.querySelector(".categories-scroll-btn.next");
  if (!row || !prevBtn || !nextBtn) return;

  const maxScroll = row.scrollWidth - row.clientWidth;
  if (maxScroll <= 5) {
    prevBtn.style.display = "none";
    nextBtn.style.display = "none";
    return;
  }
  prevBtn.style.display = "";
  nextBtn.style.display = "";

  const isRtl = document.documentElement.dir === "rtl";
  const sl = row.scrollLeft;
  if (isRtl) {
    prevBtn.disabled = sl <= -maxScroll + 5;
    nextBtn.disabled = sl >= -5;
  } else {
    prevBtn.disabled = sl <= 5;
    nextBtn.disabled = sl >= maxScroll - 5;
  }
}

function ensureGlobalScrollListeners() {
  if (_globalScrollListenersAttached) return;
  _globalScrollListenersAttached = true;
  window.addEventListener(
    "resize",
    () => {
      document
        .querySelectorAll(".categories-scroll-wrapper")
        .forEach(updateScrollBtnVisibility);
    },
    { passive: true }
  );
  document.addEventListener(
    "scroll",
    (e) => {
      const row = e.target;
      if (
        row &&
        row.classList &&
        row.classList.contains("categories-scroll-row")
      ) {
        const wrapper = row.closest(".categories-scroll-wrapper");
        if (wrapper) updateScrollBtnVisibility(wrapper);
      }
    },
    { passive: true, capture: true }
  );
}

function restoreScrollPosition(row, savedValue, shouldReset) {
  if (!row) return;
  if (shouldReset || savedValue === 0) {
    row.scrollLeft = 0;
    return;
  }
  row.scrollLeft = savedValue;
  requestAnimationFrame(() => {
    if (!row.isConnected) return;
    if (Math.abs(row.scrollLeft - savedValue) > 1) row.scrollLeft = savedValue;
  });
}

/* ============================================================ CHARGEMENT DES PRODUITS ============================================================ Stratégie 3 tentatives : 1. Requête filtrée (compatible nouvelles règles Firestore). 2. Fallback complet (anciennes règles, ou migration produits pas encore lancée). Limité à 1000 produits. 3. JSON local (fallback ultime si Firestore totalement HS). SCÉNARIO CATASTROPHE documenté : - Nouvelles règles Firestore exigent status='approved'. - Migration produits (admin.html -> Outils) NON lancée. - Tentative 1 retourne 0 produit. - Tentative 2 échoue avec permission-denied. - Tentative 3 JSON vide. => Catalogue vide, message admin EXPLICITE dans la console. ============================================================ */

/** Transforme un snapshot Firestore en tableau de produits normalisé. */
function processSnapshot(snapshot) {
  const raw = [];
  snapshot.forEach((doc) => {
    const data = doc.data();

    const isVendor = data.vendorId && data.vendorId !== "smartswi9a";

    /* Filtre vendeur : seul 'approved' passe. */
    if (isVendor && data.status !== "approved") return;

    /* X1 : filtre Smart - status présent et != 'approved' -> exclu. Legacy sans status = OK (produits créés avant la migration). */
    if (!isVendor && data.status && data.status !== "approved") return;

    raw.push({
      id: doc.id,
      ...data,
      price: Number(data.price) || 0,
      oldPrice: Number(data.oldPrice) || 0,
      stock: Number(data.stock) || 0,
      salesCount: Number(data.salesCount) || 0,
      ratingAvg: Number(data.ratingAvg) || 0,
      ratingCount: Number(data.ratingCount) || 0,
    });
  });
  return raw;
}

/** Applique le filtrage vendeurs (suspendus/rejetés exclus). */
async function filterVendors(raw) {
  let products = raw;
  try {
    await preloadVendorsForProducts(raw);
    products = raw.filter((p) => {
      const label = getProductVendorLabelSync(p);
      if (label.type === "smart") return true;
      return label.status !== "suspended" && label.status !== "rejected";
    });
  } catch (e) {
    console.warn(
      "[products] Préchargement vendeurs indisponible :",
      e?.code || e
    );
  }
  return products;
}

/** * Charge les produits depuis Firestore (stratégie filtrée + fallback). * @returns {Promise<Array>} */
export async function loadProductsFromFirestore() {
  /* Correctif audit 2026-11-20 (FinOps) : la requête n'était pas bornée.
     Sur un catalogue de plusieurs milliers de fiches, chaque visiteur
     payait l'intégralité des lectures. Plafond explicite + alerte : au
     delà, il faut passer à une pagination serveur (limit + startAfter). */
  const MAX_PRODUCTS = 500;
  try {
    const q = query(
      collection(db, "products"),
      where("status", "==", "approved"),
      limit(MAX_PRODUCTS)
    );
    const snapshot = await firestoreWithRetry(async () => await getDocs(q));

    if (snapshot.size >= MAX_PRODUCTS) {
      console.warn(
        `[products] Plafond de ${MAX_PRODUCTS} produits atteint : le catalogue ` +
        "est tronqué. Migrer vers une pagination serveur (limit + startAfter)."
      );
    }

    if (snapshot.size > 0) {
      const raw = processSnapshot(snapshot);
      const products = await filterVendors(raw);
      /* Vente flash : ajoute flashPrice/flashPercent sur les produits
         concernes par une vente active. Fail-open : en cas d erreur, les
         prix normaux restent en place. */
      try {
        await applyFlashSales(products);
      } catch (e) {
        console.warn("[products] ventes flash indisponibles :", e?.message);
      }
      console.log(
        `[products] Chargé ${products.length} produit(s) approuvés (requête filtrée)`
      );
      setProducts(products);
      return products;
    }

    /* Catalogue vide = état valide (avant publication), pas une anomalie :
       console.info évite un warning trompeur en production. */
    console.info(
      "[products] Aucun produit approuvé chargé : catalogue vide, repli JSON."
    );
    return await loadProductsFromJSON();
  } catch (e) {
    console.error(
      "[products] Chargement Firestore impossible :",
      e?.code || e?.message
    );
    return await loadProductsFromJSON();
  }
}

/** * Charge les produits depuis le fichier JSON local (fallback ultime). * @returns {Promise<Array>} */
export async function loadProductsFromJSON() {
  try {
    const res = await fetchWithRetry("/produits.json");
    const data = await res.json();
    const products = Array.isArray(data) ? data : [];
    /* Meme traitement que la voie Firestore : sans cela, un repli JSON
       afficherait des prix sans les ventes flash actives. Fail-open. */
    try {
      await applyFlashSales(products);
    } catch (e) {
      console.warn(
        "[products] ventes flash indisponibles (repli JSON) :",
        e?.message
      );
    }
    setProducts(products);
    return products;
  } catch (e) {
    setProducts([]);
    return [];
  }
}

/** * Point d'entrée principal du chargement des produits. * Délègue à loadProductsFromFirestore(). * @returns {Promise<Array>} */
export async function loadAllProducts() {
  return await loadProductsFromFirestore();
}

/* ============================================================ FILTRAGE ET TRI ============================================================ */

/** * Retourne la liste filtrée et triée des produits selon les filtres actifs. * @returns {Array} */
export function getFilteredProducts() {
  const products = getProducts();
  const filters = getFilters();
  const user = getCurrentUser();

  const favs = Array.isArray(user?.favorites)
    ? user.favorites.map(normalizeProductId).filter((f) => f != null)
    : [];

  let list = [...products];

  if (filters.category === "favorites") {
    list = list.filter((p) => favs.includes(normalizeProductId(p.id)));
  } else if (filters.category && filters.category !== "all") {
    list = list.filter((p) => productMatchesCategory(p, filters.category));
  }

  if (filters.search && filters.search.trim()) {
    const q = filters.search.toLowerCase().trim();
    list = list.filter((p) => {
      const name = getProductName(p).toLowerCase();
      const desc = getProductDesc(p).toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }

  if (filters.inStock) {
    list = list.filter((p) =>
      Array.isArray(p.variants) && p.variants.length > 0
        ? p.variants.some((v) => (Number(v.stock) || 0) > 0)
        : (Number(p.stock) || 0) > 0
    );
  }

  if (filters.promos) {
    list = list.filter(
      (p) => p.oldPrice && Number(p.oldPrice) > Number(p.price)
    );
  }

  if (filters.priceMin > 0)
    list = list.filter((p) => p.price >= filters.priceMin);
  if (filters.priceMax < 99999)
    list = list.filter((p) => p.price <= filters.priceMax);

  /* Filtres rapides vitrine (pills). Aucun impact sur le tri. */
  const quick = filters.quick || "all";
  if (quick === "new") {
    list = list.filter((p) => p.isNew === true);
  } else if (quick === "flash") {
    list = list.filter(
      (p) => Number(p.flashPrice) > 0 && Number(p.flashPrice) < Number(p.price)
    );
  } else if (quick === "smart") {
    list = list.filter((p) => !p.vendorId || p.vendorId === "smartswi9a");
  } else if (quick === "vendors") {
    list = list.filter((p) => p.vendorId && p.vendorId !== "smartswi9a");
  } else if (quick === "stock") {
    list = list.filter((p) =>
      Array.isArray(p.variants) && p.variants.length > 0
        ? p.variants.some((v) => (Number(v.stock) || 0) > 0)
        : (Number(p.stock) || 0) > 0
    );
  }

  switch (filters.sort) {
    case "relevance":
      list = sortByRelevance(list, getRankingSnapshot());
      break;
    case "price-asc":
      list.sort((a, b) => a.price - b.price);
      break;
    case "price-desc":
      list.sort((a, b) => b.price - a.price);
      break;
    case "name-asc":
      list.sort((a, b) =>
        getProductName(a).localeCompare(getProductName(b), getLang())
      );
      break;
    case "name-desc":
      list.sort((a, b) =>
        getProductName(b).localeCompare(getProductName(a), getLang())
      );
      break;
    case "rating":
      list.sort((a, b) => (b.ratingAvg || 0) - (a.ratingAvg || 0));
      break;
    default:
      list.sort((a, b) => {
        const da = toDate(a.createdAt)?.getTime() || 0;
        const dbb = toDate(b.createdAt)?.getTime() || 0;
        return dbb - da;
      });
  }
  return list;
}

/** * Retourne la page courante de produits filtrés. * @returns {Array} */
export function getPaginatedProducts() {
  const filtered = getFilteredProducts();
  const pagination = getPagination();
  const perPage = pagination.perPage || CONFIG.PRODUCTS.PER_PAGE;
  const start = (pagination.currentPage - 1) * perPage;
  return filtered.slice(start, start + perPage);
}

/** * Retourne le nombre total de pages. * @returns {number} */
export function getTotalPages() {
  const total = getFilteredProducts().length;
  const perPage = getPagination().perPage || CONFIG.PRODUCTS.PER_PAGE;
  return Math.max(1, Math.ceil(total / perPage));
}

/** * Navigue vers une page de produits. * @param {number} page */
export function goToPage(page) {
  const total = getTotalPages();
  if (page < 1 || page > total) return;
  setPagination({ currentPage: page });
  renderProducts();
}

/* ============================================================ SETTERS DE FILTRES ============================================================ */

/** Change la catégorie active et re-render. */
export function setCategory(category) {
  setFilters({ category });
  setPagination({ currentPage: 1 });
  renderProducts();
  renderCategoryFilters();
}

/** Change le tri actif et re-render. */
export function setSort(sort) {
  setFilters({ sort });
  setPagination({ currentPage: 1 });
  renderProducts();
}

/** Change la recherche et re-render. */
export function setSearch(search) {
  setFilters({ search });
  setPagination({ currentPage: 1 });
  trackSearchInterest(search);
  renderProducts();
}

/* A1 : une recherche exprime un interet. On ne compte qu une fois par
   terme (le champ est deja debounce a 300 ms) et on ignore les saisies
   trop courtes pour rester pertinent. */
let lastTrackedSearch = "";
function trackSearchInterest(search) {
  const term = String(search || "").trim().toLowerCase();
  if (term.length < 3 || term === lastTrackedSearch) return;
  lastTrackedSearch = term;
  const matches = getProducts()
    .filter((p) => {
      const name = getProductName(p).toLowerCase();
      const desc = getProductDesc(p).toLowerCase();
      return name.includes(term) || desc.includes(term);
    })
    .slice(0, 20);
  for (const product of matches) {
    trackRankingEvent(product.id, "search");
  }
}

/** Active/désactive le filtre "en stock" et re-render. */
export function setInStock(inStock) {
  setFilters({ inStock });
  setPagination({ currentPage: 1 });
  renderProducts();
}

/** Active/désactive le filtre "en promo" et re-render. */
export function setPromos(promos) {
  setFilters({ promos });
  setPagination({ currentPage: 1 });
  renderProducts();
}

/** Change la plage de prix et re-render. */
export function setPriceRange(min, max) {
  setFilters({ priceMin: min, priceMax: max });
  setPagination({ currentPage: 1 });
  renderProducts();
}

/** Réinitialise tous les filtres. */
export function clearAllFilters() {
  resetFilters();
  setPagination({ currentPage: 1 });
  renderProducts();
  renderCategoryFilters();
}

/* ============================================================ HELPERS PRODUITS ============================================================ */

/** Retourne un produit par slug (ou null). */
export function getProductBySlug(slug) {
  return !slug ? null : getProducts().find((p) => p.slug === slug) || null;
}

/** Retourne un produit par ID (Number ou String). */
export function getProductById(id) {
  if (id == null) return null;
  const target = normalizeProductId(id);
  return getProducts().find((p) => normalizeProductId(p.id) === target) || null;
}

/** Retourne les N derniers produits marqués isNew. */
export function getNewProducts(limitCount = 10, onlyInStock = true) {
  let products = getProducts().filter((p) => p.isNew === true);
  if (onlyInStock)
    products = products.filter((p) =>
      Array.isArray(p.variants) && p.variants.length > 0
        ? p.variants.some((v) => (Number(v.stock) || 0) > 0)
        : (Number(p.stock) || 0) > 0
    );
  products.sort(
    (a, b) =>
      (toDate(b.createdAt)?.getTime() || 0) -
      (toDate(a.createdAt)?.getTime() || 0)
  );
  return products.slice(0, limitCount);
}

/** Retourne les produits en promotion, triés par % de remise décroissant. */
export function getPromoProducts(onlyInStock = true) {
  let products = getProducts().filter(
    (p) => p.oldPrice && Number(p.oldPrice) > Number(p.price)
  );
  if (onlyInStock)
    products = products.filter((p) =>
      Array.isArray(p.variants) && p.variants.length > 0
        ? p.variants.some((v) => (Number(v.stock) || 0) > 0)
        : (Number(p.stock) || 0) > 0
    );
  return products.sort((a, b) => {
    const da = a.oldPrice > 0 ? (a.oldPrice - a.price) / a.oldPrice : 0;
    const dbb = b.oldPrice > 0 ? (b.oldPrice - b.price) / b.oldPrice : 0;
    return dbb - da;
  });
}

/* ============================================================ STATS AVIS (batch) ============================================================ B1 : si l'index Firestore reviews(productId + status) est manquant, on bascule automatiquement sur une query simple (status == 'approved', limit 500) puis on filtre côté client. Le warning n'est émis qu'une seule fois par session. ============================================================ */

/** * Fallback : charge les 500 derniers avis approuvés et filtre * côté client. Moins efficace que la query indexée mais fonctionne * sans index Firestore. * @param {Array<number|string>} productIds * @returns {Promise<Object>} Map<String(pid), { avg, count }> */
async function getProductStatsBatchFallback(productIds) {
  const result = {};
  productIds.forEach((pid) => {
    result[String(pid)] = { avg: null, count: 0 };
  });

  try {
    const q = query(
      collection(db, "reviews"),
      where("status", "==", "approved"),
      limit(500)
    );
    const snap = await getDocs(q);

    const idsSet = new Set(productIds.map((pid) => String(pid)));
    const ratings = {};
    productIds.forEach((pid) => {
      ratings[String(pid)] = { sum: 0, count: 0 };
    });

    snap.forEach((d) => {
      const r = d.data();
      if (r.productId == null) return;
      const key = String(r.productId);
      if (!idsSet.has(key)) return;
      ratings[key].sum += Number(r.rating) || 0;
      ratings[key].count++;
    });

    const now = Date.now();
    for (const pid of productIds) {
      const key = String(pid);
      const stat = ratings[key];
      const stats =
        stat.count > 0
          ? { avg: (stat.sum / stat.count).toFixed(1), count: stat.count }
          : { avg: null, count: 0 };
      result[key] = stats;

      if (_statsCache.size >= STATS_CACHE_MAX) {
        const firstKey = _statsCache.keys().next().value;
        if (firstKey !== undefined) _statsCache.delete(firstKey);
      }
      _statsCache.set(key, { stats, timestamp: now });
    }

    return result;
  } catch (fallbackErr) {
    console.warn(
      "[products] Fallback stats échoué aussi :",
      fallbackErr?.code || fallbackErr
    );
    return result;
  }
}

/** * Récupère en batch les stats d'avis (moyenne + nombre) pour une liste * d'IDs produits. Utilise un cache local (TTL 60s) + fallback si l'index * Firestore est manquant. * * @param {Array<number|string>} productIds - IDs produits. * @returns {Promise<Object>} Map<String(pid), { avg, count }>. */
export async function getProductStatsBatch(productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) return {};

  const normalizedIds = [];
  const seen = new Set();
  for (const id of productIds) {
    const pid = normalizeProductId(id);
    if (pid == null) continue;
    const key = String(pid);
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedIds.push(pid);
    if (normalizedIds.length >= 30) break;
  }
  if (normalizedIds.length === 0) return {};

  const now = Date.now();
  const toFetch = [];
  const result = {};

  for (const pid of normalizedIds) {
    const key = String(pid);
    const cached = _statsCache.get(key);
    if (cached && now - cached.timestamp < STATS_CACHE_TTL) {
      result[key] = cached.stats;
    } else {
      toFetch.push(pid);
    }
  }

  if (toFetch.length === 0) return result;

  try {
    const q = query(
      collection(db, "reviews"),
      where("productId", "in", toFetch),
      where("status", "==", "approved")
    );
    const snap = await getDocs(q);

    const ratings = {};
    for (const pid of toFetch) {
      ratings[String(pid)] = { sum: 0, count: 0 };
    }

    snap.forEach((doc) => {
      const r = doc.data();
      if (r.productId == null) return;
      const key = String(r.productId);
      if (!ratings[key]) return;
      ratings[key].sum += Number(r.rating) || 0;
      ratings[key].count++;
    });

    for (const pid of toFetch) {
      const key = String(pid);
      const stat = ratings[key];
      const stats =
        stat.count > 0
          ? { avg: (stat.sum / stat.count).toFixed(1), count: stat.count }
          : { avg: null, count: 0 };
      result[key] = stats;

      if (_statsCache.size >= STATS_CACHE_MAX) {
        const firstKey = _statsCache.keys().next().value;
        if (firstKey !== undefined) _statsCache.delete(firstKey);
      }
      _statsCache.set(key, { stats, timestamp: now });
    }

    return result;
  } catch (e) {
    /* B1 : index Firestore manquant -> fallback côté client. Le code exact de Firestore pour "index requis" est 'failed-precondition'. */
    if (e?.code === "failed-precondition") {
      if (!_statsIndexWarned) {
        _statsIndexWarned = true;
        console.warn(
          "[products] Index Firestore manquant pour reviews(productId + status).\n" +
            " -> Fallback activé : notes étoiles calculées côté client.\n" +
            " -> Pour supprimer ce warning : ajouter l'index dans firestore.indexes.json (Lot 48)."
        );
      }
      return await getProductStatsBatchFallback(toFetch);
    }
    console.warn("[products] getProductStatsBatch erreur :", e?.code || e);
    for (const pid of toFetch) {
      if (!result[String(pid)]) result[String(pid)] = { avg: null, count: 0 };
    }
    return result;
  }
}

/* ============================================================ RENDU DE LA GRILLE ============================================================ */

/** * Re-render la grille de produits (page d'accueil principalement). * @returns {Promise<void>} */
export async function renderProducts() {
  const grid = document.getElementById("productsGrid");
  if (!grid) return;

  const thisRequest = ++_renderRequestId;

  grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem 1rem;"><div class="spinner" style="margin:0 auto;"></div></div>`;
  const paginationEl = document.getElementById("paginationContainer");
  if (paginationEl) paginationEl.innerHTML = "";

  const user = getCurrentUser();
  const favs = Array.isArray(user?.favorites)
    ? user.favorites.map(normalizeProductId).filter((f) => f != null)
    : [];

  const pageProducts = getPaginatedProducts();
  const totalPages = getTotalPages();
  const currentPage = getPagination().currentPage;

  try {
    await preloadVendorsForProducts(pageProducts);
  } catch (_) {
    /* ignore */
  }

  const productIds = pageProducts
    .map((p) => normalizeProductId(p.id))
    .filter((id) => id != null);
  const stats = await getProductStatsBatch(productIds);

  if (thisRequest !== _renderRequestId) return;

  if (pageProducts.length === 0) {
    const filters = getFilters();
    const catalogEmpty = getProducts().length === 0;
    let emptyTitle = shopT("catalogFilterEmpty");
    if (catalogEmpty) emptyTitle = shopT("catalogPreparingTitle");
    else if (filters.category === "favorites") emptyTitle = t("noFavorites");
    else if (filters.category !== "all") emptyTitle = t("noProductsInCategory");

    const emptyDesc = catalogEmpty ? shopT("catalogPreparingDesc") : "";
    const resetHtml = catalogEmpty
      ? ""
      : `<button type="button" class="shop-empty-reset" data-action="products:filter-reset">${escapeHTML(shopT("catalogReset"))}</button>`;

    grid.innerHTML = `<div class="shop-catalog-empty" role="status" aria-live="polite">
      <div class="shop-catalog-empty-icon" aria-hidden="true">${catalogEmpty ? "🏬" : "🔍"}</div>
      <h3>${escapeHTML(emptyTitle)}</h3>
      ${emptyDesc ? `<p>${escapeHTML(emptyDesc)}</p>` : ""}
      ${resetHtml}
    </div>`;
    return;
  }

  let html = "";
  pageProducts.forEach((p) => {
    const pid = normalizeProductId(p.id);
    if (pid == null) return;

    const isFav = favs.includes(pid);
    const name = escapeHTML(getProductName(p));
    const desc = escapeHTML(getProductDesc(p));
    const img = getProductImageUrl(p);
    const price = getEffectivePrice(p);
    const oldPrice = p.oldPrice;
    const stock = Number(p.stock) || 0;
    /* Vente flash (js/flash-sales.js) : remise temporaire prioritaire.
       `flashPrice` est ajoute par applyFlashSales() ; le prix normal reste
       dans `p.price` et sert de prix de reference barre. */
    const hasFlash = Number.isFinite(p.flashPrice) && p.flashPrice > 0 && p.flashPrice < Number(p.price);
    const flashEndsAt = p.flashEndsAt || null;
    const isPromo = !hasFlash && oldPrice && Number(oldPrice) > Number(price);
    const isNew = p.isNew || false;
    const discountPercent = hasFlash
      ? (p.flashPercent || 0)
      : getDiscountPercent(oldPrice, price);

    const vendorInfo = getProductVendorLabelSync(p);
    const vendorOwner =
      p.vendorId && p.vendorId !== "smartswi9a" ? p.vendorId : null;

    const isSmartProduct = vendorInfo.type === "smart";
    const vendorName = escapeHTML(vendorInfo.name || "");
    const vendorSep = `<span class="shop-origin-sep" aria-hidden="true">${escapeHTML(shopT("badgeVendorSep"))}</span>`;
    let vendorBadgeHtml;
    if (isSmartProduct) {
      vendorBadgeHtml = `<div class="shop-origin shop-origin--smart">${escapeHTML(shopT("badgeSmart"))}</div>`;
    } else if (vendorOwner) {
      vendorBadgeHtml = `<div class="shop-origin shop-origin--vendor">${escapeHTML(shopT("badgeVendor"))}${vendorSep}<a href="/boutique.html?v=${encodeURIComponent(vendorOwner)}" class="shop-vendor-name" onclick="event.stopPropagation();">${vendorName}</a></div>`;
    } else {
      vendorBadgeHtml = `<div class="shop-origin shop-origin--vendor">${escapeHTML(shopT("badgeVendor"))}${vendorSep}<span class="shop-vendor-name">${vendorName}</span></div>`;
    }
    const koulchiEligible =
      !(Array.isArray(p.variants) && p.variants.length > 0) &&
      Number(p.koulchiPrice) > 0 &&
      Number(p.koulchiPrice) < Number(p.price);
    const koulchiBadgeHtml = koulchiEligible
      ? `<span class="shop-koulchi-badge">${escapeHTML(shopT("badgeKoulchi"))}</span>`
      : "";

    const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
    const optionsBadge = hasVariants
      ? `<span class="badge shop-badge-options">⚙️ ${escapeHTML(shopT("badgeOptions"))}</span>`
      : "";

    /* Badge vente flash : prioritaire sur le badge promo classique.
       Affiche -X% + un compte a rebours court (donnees fetchhees). */
    const flashBadgeHtml = hasFlash
      ? `<span class="badge flash-badge shop-flash-badge" data-flash-ends="${escapeHTML(flashEndsAt ? new Date(flashEndsAt).toISOString() : "")}">⚡ -${discountPercent}%</span>`
      : "";

    /* Prix de reference barre : le prix normal quand une vente flash court,
       sinon l ancien prix. */
    const strikePrice = hasFlash ? Number(p.price) : (oldPrice ? Number(oldPrice) : 0);
    const flashBannerHtml = hasFlash
      ? `<div class="flash-card-countdown shop-flash-banner" data-flash-ends="${escapeHTML(flashEndsAt ? new Date(flashEndsAt).toISOString() : "")}">⚡ ${escapeHTML(shopT("quickFlash"))} <span class="flash-timer">--:--:--</span></div>`
      : "";

    const r = stats[String(pid)] || { avg: null, count: 0 };
    const hasReviews = r.count > 0;
    const avgRating = hasReviews ? r.avg : "--";
    const reviewCount = r.count || 0;
    const favAriaLabel = isFav ? t("favRemoved") : t("favAdded");

    const isOutOfStock = hasVariants
      ? !p.variants.some((v) => (Number(v.stock) || 0) > 0)
      : stock === 0;

    const productUrl = `https://smartswika.ma/produit?slug=${encodeURIComponent(p.slug || pid)}`;
    const waMessage = shopT("whatsappPrefill", {
      product: getProductName(p),
      url: productUrl,
    });
    const waHref = `https://wa.me/212656613303?text=${encodeURIComponent(waMessage)}`;
    const addAria = escapeHTML(shopT("shopAriaAdd", { product: getProductName(p) }));
    const waAria = escapeHTML(shopT("shopAriaWhatsApp", { product: getProductName(p) }));

    const btnHtml = hasVariants
      ? `<button class="btn-choose-options shop-btn shop-btn--primary" data-slug="${escapeHTML(p.slug || "")}" aria-label="${escapeHTML(shopT("shopChooseOptions"))}">⚙️ <span>${escapeHTML(shopT("shopChooseOptions"))}</span></button>`
      : `<button class="btn-add-to-cart shop-btn shop-btn--primary" data-id="${escapeHTML(String(pid))}" aria-label="${addAria}"><span class="btn-label">🛒 ${escapeHTML(shopT("shopAddToCart"))}</span></button>`;
    const waBtn = `<a class="shop-wa-btn" href="${waHref}" target="_blank" rel="noopener noreferrer" aria-label="${waAria}" onclick="event.stopPropagation();"><span aria-hidden="true">💬</span><span>${escapeHTML(shopT("shopWhatsApp"))}</span></a>`;

    html += ` <div class="product-card shop-card ${ isSmartProduct ? "shop-card--smart" : "shop-card--vendor" }${ hasFlash ? " has-flash" : "" }" data-id="${escapeHTML( String(pid) )}" data-slug="${escapeHTML(p.slug || "")}" data-origin="${ isSmartProduct ? "smart" : "vendor" }"> <div class="product-img"> <img src="${img}" alt="${name}" width="400" height="400" loading="lazy" decoding="async" onerror="this.onerror=null; this.src='${getFallbackImage( name )}'"> <button class="favorite-btn ${ isFav ? "is-fav" : "" }" data-id="${escapeHTML( String(pid) )}" aria-label="${favAriaLabel}">${isFav ? "❤️" : "🤍"}</button> <div class="shop-card-badges"> ${optionsBadge} ${ isOutOfStock ? `<span class="badge badge-hot shop-badge-stock">${escapeHTML(shopT("shopOutOfStock"))}</span>` : "" } ${flashBadgeHtml} ${ isPromo ? `<span class="badge badge-promo shop-badge-discount">-${discountPercent}%</span>` : "" } ${ isNew && !isOutOfStock && !isPromo && !hasFlash ? `<span class="badge badge-new shop-badge-new">${t( "trending" )}</span>` : "" } </div> </div> <div class="product-body"> ${flashBannerHtml} <div class="p-name">${name}</div> ${vendorBadgeHtml} ${koulchiBadgeHtml} <div class="p-desc">${desc}</div> <div class="p-stats shop-stars">⭐ ${avgRating} <span style="color:var(--text-muted)">(${reviewCount})</span></div> <div class="p-footer"> <div class="p-price${ hasFlash ? " p-price-flash" : "" }">${price} ${t("currency")} ${ strikePrice > 0 ? `<small>${strikePrice} ${t("currency")}</small>` : "" }</div> <div class="p-actions">${btnHtml}${waBtn}</div> </div> </div> </div> `;
  });

  grid.innerHTML = html;
  document.dispatchEvent(
    new CustomEvent("shop-products-rendered", { detail: { count: pageProducts.length } })
  );

  /* Compte a rebours des ventes flash affichees sur cette page. */
  startFlashCountdown();

  grid.querySelectorAll(".btn-choose-options").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const slug = btn.dataset.slug;
      if (slug)
        window.location.href = `/produit?slug=${encodeURIComponent(slug)}`;
    });
  });

  if (!paginationEl) return;
  if (totalPages <= 1) {
    paginationEl.innerHTML = "";
    return;
  }

  let pgHtml = `<span class="pagination-info">${currentPage}/${totalPages}</span>`;
  pgHtml += `<button class="pagination-btn ${ currentPage === 1 ? "disabled" : "" }" data-page="${currentPage - 1}">‹</button>`;
  for (let i = 1; i <= totalPages; i++) {
    pgHtml += `<button class="pagination-btn ${ i === currentPage ? "active" : "" }" data-page="${i}">${i}</button>`;
  }
  pgHtml += `<button class="pagination-btn ${ currentPage === totalPages ? "disabled" : "" }" data-page="${currentPage + 1}">›</button>`;
  paginationEl.innerHTML = pgHtml;
}

/* ============================================================ RENDU DES CATÉGORIES ============================================================ */
export function renderCategoryFilters() {
  const mainContainer = document.getElementById("filtersCategories");
  if (!mainContainer) return;

  injectCategoriesScrollCSS();
  ensureGlobalScrollListeners();

  const filters = getFilters();
  const activeCat = filters.category || "all";
  const activeCatObj = getCategoryById(activeCat);
  const activeParentId =
    activeCatObj?.parentId || (activeCatObj?.isParent ? activeCatObj.id : null);

  const oldParentRow = mainContainer.querySelector(".categories-scroll-row");
  const savedParentScroll = oldParentRow ? oldParentRow.scrollLeft : 0;
  const oldChildContainer = document.getElementById("subFiltersCategories");
  const oldChildRow = oldChildContainer?.querySelector(
    ".categories-scroll-row"
  );
  const savedChildScroll = oldChildRow ? oldChildRow.scrollLeft : 0;

  const currentLang = getLang();
  const langChanged =
    _lastRenderedLang !== null && _lastRenderedLang !== currentLang;
  const parentChanged = _lastRenderedParentId !== activeParentId;
  const shouldResetChildScroll = parentChanged || langChanged;

  let parentItemsHtml = "";
  parentItemsHtml += `<button class="category-scroll-item ${ activeCat === "all" ? "active" : "" }" data-action="products:filter" data-category="all"><div class="category-scroll-img" style="background:var(--bg-surface);font-size:1.8rem;">🛍️</div><span class="category-scroll-label">${t( "filterAll" )}</span></button>`;
  parentItemsHtml += `<button class="category-scroll-item ${ activeCat === "favorites" ? "active" : "" }" data-action="products:filter" data-category="favorites"><div class="category-scroll-img" style="background:var(--bg-surface);font-size:1.8rem;">❤️</div><span class="category-scroll-label">${t( "filterFavorites" )}</span></button>`;

  CATEGORY_GROUPS.forEach((group) => {
    const isActive = activeCat === group.id || activeParentId === group.id;
    const imgPath = `/assets/${group.id}.webp`;
    parentItemsHtml += ` <button class="category-scroll-item ${ isActive ? "active" : "" }" data-action="products:filter" data-category="${group.id}"> <div class="category-scroll-img"><img src="${imgPath}" alt="${t( group.label )}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"><div class="category-scroll-fallback" style="display:none;">${ group.emoji }</div></div> <span class="category-scroll-label">${t(group.label)}</span> </button> `;
  });

  mainContainer.innerHTML = `<div class="categories-scroll-wrapper" id="parentScrollWrapper"><button class="categories-scroll-btn prev" data-scroll-btn="parent" aria-label="Précédent">‹</button><div class="categories-scroll-row" id="parentScrollRow">${parentItemsHtml}</div><button class="categories-scroll-btn next" data-scroll-btn="parent" aria-label="Suivant">›</button></div>`;

  const newParentRow = document.getElementById("parentScrollRow");
  restoreScrollPosition(newParentRow, savedParentScroll, langChanged);
  const parentWrapper = document.getElementById("parentScrollWrapper");
  if (parentWrapper) attachScrollButtons(parentWrapper);

  let childContainer = document.getElementById("subFiltersCategories");
  if (!childContainer) {
    childContainer = document.createElement("div");
    childContainer.id = "subFiltersCategories";
    childContainer.style.marginTop = "0.5rem";
    mainContainer.appendChild(childContainer);
  }

  if (activeParentId) {
    const parentGroup = CATEGORY_GROUPS.find((g) => g.id === activeParentId);
    if (parentGroup && parentGroup.children.length > 0) {
      let childItemsHtml = "";
      childItemsHtml += `<button class="category-scroll-item child-item ${ activeCat === parentGroup.id ? "active" : "" }" data-action="products:filter" data-category="${ parentGroup.id }"><div class="category-scroll-img" style="border-style:dashed; border-color:var(--gold);"><span style="font-size:1.5rem;color:var(--gold);">↳</span></div><span class="category-scroll-label" style="color:var(--gold);">Tout</span></button>`;

      parentGroup.children.forEach((child) => {
        const isActive = activeCat === child.id;
        const imgPath = `/assets/${child.id}.webp`;
        childItemsHtml += ` <button class="category-scroll-item child-item ${ isActive ? "active" : "" }" data-action="products:filter" data-category="${ child.id }"> <div class="category-scroll-img"><img src="${imgPath}" alt="${t( child.label )}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"><div class="category-scroll-fallback" style="display:none;">${ child.emoji }</div></div> <span class="category-scroll-label">${t( child.label )}</span> </button> `;
      });

      childContainer.innerHTML = `<div class="categories-scroll-wrapper" id="childScrollWrapper"><button class="categories-scroll-btn prev" data-scroll-btn="child" aria-label="Précédent">‹</button><div class="categories-scroll-row sub-row" id="childScrollRow">${childItemsHtml}</div><button class="categories-scroll-btn next" data-scroll-btn="child" aria-label="Suivant">›</button></div>`;
      childContainer.style.display = "block";

      const newChildRow = document.getElementById("childScrollRow");
      restoreScrollPosition(
        newChildRow,
        savedChildScroll,
        shouldResetChildScroll
      );
      const childWrapper = document.getElementById("childScrollWrapper");
      if (childWrapper) attachScrollButtons(childWrapper);
    } else {
      childContainer.style.display = "none";
      childContainer.innerHTML = "";
    }
  } else {
    childContainer.style.display = "none";
    childContainer.innerHTML = "";
  }
  _lastRenderedParentId = activeParentId;
  _lastRenderedLang = currentLang;
}

export function renderSortOptions() {
  const select = document.getElementById("sortSelect");
  if (!select) return;
  if (!Array.isArray(SORT_OPTIONS) || SORT_OPTIONS.length === 0) return;

  const currentValue = select.value || getFilters().sort || "relevance";
  let html = "";
  SORT_OPTIONS.forEach((opt) => {
    html += `<option value="${opt.value}">${t(opt.label)}</option>`;
  });
  select.innerHTML = html;

  if ([...select.options].some((o) => o.value === currentValue))
    select.value = currentValue;
}

/** * Ajoute ou retire un produit des favoris de l'utilisateur connecté. * @param {number|string} productId */
export async function toggleFavorite(productId) {
  const user = getCurrentUser();
  if (!user || !user.uid) {
    showToast(t("loginRequired"));
    document.dispatchEvent(new CustomEvent("open-account"));
    return;
  }

  const pid = normalizeProductId(productId);
  if (pid == null) return;

  const currentFavs = Array.isArray(user.favorites)
    ? user.favorites.map(normalizeProductId).filter((f) => f != null)
    : [];
  const isAdding = !currentFavs.includes(pid);

  const storedValue = pid;

  try {
    await updateDoc(doc(db, "users", user.uid), {
      favorites: isAdding ? arrayUnion(storedValue) : arrayRemove(storedValue),
    });

    const newFavs = isAdding
      ? [...new Set([...currentFavs, pid])]
      : currentFavs.filter((id) => id !== pid);
    setCurrentUser({ ...user, favorites: newFavs });
    showToast(isAdding ? "❤️ " + t("favAdded") : "💔 " + t("favRemoved"));

    if (document.getElementById("productsGrid")) await renderProducts();
  } catch (e) {
    showToast(t("error"));
  }
}

/** * Navigue vers la page détail d'un produit. * @param {string} slug */
export function openProductPage(slug) {
  if (!slug) return;
  /* A1 : l ouverture d une fiche est un signal d interet fort. */
  try {
    const product = getProducts().find((p) => p && p.slug === slug);
    if (product) trackRankingEvent(product.id, "click");
  } catch (e) {
    /* classement local indisponible : la navigation reste prioritaire */
  }
  window.location.href = `/produit?slug=${encodeURIComponent(slug)}`;
}

console.log(
  "✅ products.js chargé - v9.0.0 (Lot 9 : fallback stats + filtre X1 + messages admin)"
);