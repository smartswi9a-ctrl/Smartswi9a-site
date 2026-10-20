// js/products.js
// ============================================================
// GESTION DES PRODUITS - SMART SWI9A
// Version 3.1.0 — Refonte filtres catégories (sous-catégories visibles)
// ============================================================
// CHANGEMENTS v3.1.0 :
// ✅ FIX #1 — renderCategoryFilters : 2 rangées (parents + enfants)
// ✅ FIX #9 — Compteurs produits par catégorie (client)
// ✅ FIX #11 — Badge catégorie sur la carte produit
// ✅ FIX #13 — Bouton "Voir toute la catégorie" quand sous-catégorie active
// ✅ FIX #4 — Fallback data-category sur le bouton complet
// ✅ (Repris v3.0.0) — C8.1, C8.2, I8.1→I8.5, M8.1→M8.3
// ============================================================

import {
    collection, getDocs, query, where, doc, updateDoc, arrayUnion, arrayRemove
} from "firebase/firestore";
import { db } from "./firebase.js";
import {
    CONFIG, CATEGORIES, SORT_OPTIONS,
    CATEGORY_GROUPS,
    productMatchesCategory,
    getCategoryById,
    getParentCategory,
    getCategoryPath,
    normalizeCategory
} from "./config.js";
import {
    t, escapeHTML, getProductName, getProductDesc, getProductImageUrl,
    getFallbackImage, getLang, fetchWithRetry, firestoreWithRetry,
    getDiscountPercent,
    toDate
} from "./utils.js";
import {
    getProducts, setProducts, getFilters, setFilters, resetFilters,
    getPagination, setPagination
} from "./store.js";
import {
    getCurrentUser, saveUserProfile, setCurrentUser
} from "./auth.js";
import { showToast } from "./ui-core.js";

// ============================================================
// CACHE STATS AVIS
// ============================================================
const _statsCache = new Map();
const STATS_CACHE_TTL = 60 * 1000;
const STATS_CACHE_MAX = 100;

// ✅ C8.2 : Guard race condition renderProducts
let _renderRequestId = 0;

// ✅ I8.5 : Invalidation sur review-submitted
if (typeof document !== 'undefined') {
    document.addEventListener('review-submitted', (e) => {
        const pid = String(e.detail?.productId || '');
        if (pid) {
            _statsCache.delete(Number(pid));
            _statsCache.delete(pid);
        }
    });
}

// ============================================================
// CHARGEMENT DES PRODUITS
// ============================================================
export async function loadProductsFromFirestore() {
    try {
        console.log('⏳ Chargement des produits depuis Firestore...');
        const snapshot = await firestoreWithRetry(async () => {
            return await getDocs(collection(db, "products"));
        });

        const products = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            products.push({
                id: doc.id,
                ...data,
                price: Number(data.price) || 0,
                oldPrice: Number(data.oldPrice) || 0,
                stock: Number(data.stock) || 0,
                salesCount: Number(data.salesCount) || 0,
                ratingAvg: Number(data.ratingAvg) || 0,
                ratingCount: Number(data.ratingCount) || 0
            });
        });

        console.log(`✅ ${products.length} produits chargés depuis Firestore.`);
        setProducts(products);
        return products;
    } catch (e) {
        console.error('❌ Erreur chargement Firestore :', e);
        return await loadProductsFromJSON();
    }
}

export async function loadProductsFromJSON() {
    try {
        console.log('⏳ Chargement des produits depuis produits.json...');
        const res = await fetchWithRetry('/produits.json');
        const data = await res.json();
        console.log(`✅ ${data.length} produits chargés depuis JSON.`);
        setProducts(data);
        return data;
    } catch (e) {
        console.error('❌ Erreur chargement JSON :', e);
        setProducts([]);
        return [];
    }
}

export async function loadAllProducts() {
    return await loadProductsFromFirestore();
}

// ============================================================
// FILTRAGE ET TRI
// ============================================================
export function getFilteredProducts() {
    const products = getProducts();
    const filters = getFilters();
    const user = getCurrentUser();
    const favs = Array.isArray(user?.favorites)
        ? user.favorites.map(Number).filter(Number.isFinite)
        : [];

    let list = [...products];

    if (filters.category === 'favorites') {
        list = list.filter(p => favs.includes(Number(p.id)));
    } else if (filters.category && filters.category !== 'all') {
        // ✅ C8.1 : productMatchesCategory gère parents + legacy
        list = list.filter(p => productMatchesCategory(p, filters.category));
    }

    if (filters.search && filters.search.trim()) {
        const q = filters.search.toLowerCase().trim();
        list = list.filter(p => {
            const name = getProductName(p).toLowerCase();
            const desc = getProductDesc(p).toLowerCase();
            return name.includes(q) || desc.includes(q);
        });
    }

    if (filters.inStock) {
        list = list.filter(p => {
            if (Array.isArray(p.variants) && p.variants.length > 0) {
                return p.variants.some(v => (Number(v.stock) || 0) > 0);
            }
            return (Number(p.stock) || 0) > 0;
        });
    }

    if (filters.promos) {
        list = list.filter(p => p.oldPrice && Number(p.oldPrice) > Number(p.price));
    }

    if (filters.priceMin > 0) list = list.filter(p => p.price >= filters.priceMin);
    if (filters.priceMax < 99999) list = list.filter(p => p.price <= filters.priceMax);

    switch (filters.sort) {
        case 'price-asc':
            list.sort((a, b) => a.price - b.price);
            break;
        case 'price-desc':
            list.sort((a, b) => b.price - a.price);
            break;
        case 'name-asc':
            list.sort((a, b) => getProductName(a).localeCompare(getProductName(b), getLang()));
            break;
        case 'name-desc':
            list.sort((a, b) => getProductName(b).localeCompare(getProductName(a), getLang()));
            break;
        case 'rating':
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

// ============================================================
// PAGINATION
// ============================================================
export function getPaginatedProducts() {
    const filtered = getFilteredProducts();
    const pagination = getPagination();
    const perPage = pagination.perPage || CONFIG.PRODUCTS.PER_PAGE;
    const start = (pagination.currentPage - 1) * perPage;
    return filtered.slice(start, start + perPage);
}

export function getTotalPages() {
    const total = getFilteredProducts().length;
    const perPage = getPagination().perPage || CONFIG.PRODUCTS.PER_PAGE;
    return Math.max(1, Math.ceil(total / perPage));
}

export function goToPage(page) {
    const total = getTotalPages();
    if (page < 1 || page > total) return;
    setPagination({ currentPage: page });
    renderProducts();
}

// ============================================================
// SETTERS DE FILTRES
// ============================================================
export function setCategory(category) {
    setFilters({ category });
    setPagination({ currentPage: 1 });
    renderProducts();
    // ✅ FIX #1 : re-render les filtres pour afficher la ligne sous-catégorie
    renderCategoryFilters();
}

export function setSort(sort) {
    setFilters({ sort });
    setPagination({ currentPage: 1 });
    renderProducts();
}

export function setSearch(search) {
    setFilters({ search });
    setPagination({ currentPage: 1 });
    renderProducts();
}

export function setInStock(inStock) {
    setFilters({ inStock });
    setPagination({ currentPage: 1 });
    renderProducts();
}

export function setPromos(promos) {
    setFilters({ promos });
    setPagination({ currentPage: 1 });
    renderProducts();
}

export function setPriceRange(min, max) {
    setFilters({ priceMin: min, priceMax: max });
    setPagination({ currentPage: 1 });
    renderProducts();
}

export function clearAllFilters() {
    resetFilters();
    setPagination({ currentPage: 1 });
    renderProducts();
    renderCategoryFilters();
}

// ============================================================
// RECHERCHE
// ============================================================
export function getProductBySlug(slug) {
    if (!slug) return null;
    return getProducts().find(p => p.slug === slug) || null;
}

export function getProductById(id) {
    if (!id) return null;
    return getProducts().find(p => String(p.id) === String(id)) || null;
}

// ============================================================
// NOUVEAUTÉS & PROMOS
// ============================================================
export function getNewProducts(limit = 10, onlyInStock = true) {
    let products = getProducts().filter(p => p.isNew === true);

    if (onlyInStock) {
        products = products.filter(p => {
            if (Array.isArray(p.variants) && p.variants.length > 0) {
                return p.variants.some(v => (Number(v.stock) || 0) > 0);
            }
            return (Number(p.stock) || 0) > 0;
        });
    }

    products.sort((a, b) => {
        const da = toDate(a.createdAt)?.getTime() || 0;
        const dbb = toDate(b.createdAt)?.getTime() || 0;
        return dbb - da;
    });
    return products.slice(0, limit);
}

export function getPromoProducts(onlyInStock = true) {
    let products = getProducts().filter(p =>
        p.oldPrice && Number(p.oldPrice) > Number(p.price)
    );

    if (onlyInStock) {
        products = products.filter(p => {
            if (Array.isArray(p.variants) && p.variants.length > 0) {
                return p.variants.some(v => (Number(v.stock) || 0) > 0);
            }
            return (Number(p.stock) || 0) > 0;
        });
    }

    return products.sort((a, b) => {
        const da = a.oldPrice > 0 ? (a.oldPrice - a.price) / a.oldPrice : 0;
        const dbb = b.oldPrice > 0 ? (b.oldPrice - b.price) / b.oldPrice : 0;
        return dbb - da;
    });
}

// ============================================================
// STATS DES AVIS (avec cache)
// ============================================================
export async function getProductStatsBatch(productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) return {};

    if (productIds.length > 30) {
        console.warn(`⚠️ getProductStatsBatch: ${productIds.length} IDs fournis (max 30 Firestore 'in') — troncature`);
    }

    const ids = productIds.slice(0, 30).map(Number).filter(Number.isFinite);
    if (ids.length === 0) return {};

    const now = Date.now();
    const toFetch = [];
    const result = {};

    ids.forEach(pid => {
        const cached = _statsCache.get(pid);
        if (cached && (now - cached.timestamp) < STATS_CACHE_TTL) {
            result[pid] = cached.stats;
        } else {
            toFetch.push(pid);
        }
    });

    if (toFetch.length === 0) return result;

    try {
        const q = query(
            collection(db, "reviews"),
            where("productId", "in", toFetch),
            where("status", "==", "approved")
        );
        const snap = await getDocs(q);

        const ratings = {};
        toFetch.forEach(pid => { ratings[pid] = { sum: 0, count: 0 }; });

        snap.forEach(doc => {
            const r = doc.data();
            const pid = Number(r.productId);
            if (!ratings[pid]) return;
            ratings[pid].sum += Number(r.rating) || 0;
            ratings[pid].count++;
        });

        toFetch.forEach(pid => {
            const stat = ratings[pid];
            const stats = stat.count > 0
                ? { avg: (stat.sum / stat.count).toFixed(1), count: stat.count }
                : { avg: null, count: 0 };
            result[pid] = stats;

            if (_statsCache.size >= STATS_CACHE_MAX) {
                const firstKey = _statsCache.keys().next().value;
                if (firstKey !== undefined) _statsCache.delete(firstKey);
            }
            _statsCache.set(pid, { stats, timestamp: now });
        });

        return result;
    } catch (e) {
        console.warn('⚠️ Erreur getProductStatsBatch :', e);
        return result;
    }
}

// ============================================================
// ✅ FIX #9 : CALCUL COMPTEURS PAR CATÉGORIE (cache court)
// ------------------------------------------------------------
// Compte les produits par :
//  - 'all'       → total
//  - 'favorites' → non calculé ici (dépend du user, calculé séparément)
//  - parent      → produits dont catégorie appartient au parent
//  - child       → produits dont catégorie === child (ou legacy normalisé)
// ============================================================
let _categoryCountsCache = null;
let _categoryCountsTime = 0;
const CATEGORY_COUNTS_TTL = 30 * 1000; // 30s

function computeCategoryCounts() {
    const now = Date.now();
    if (_categoryCountsCache && (now - _categoryCountsTime) < CATEGORY_COUNTS_TTL) {
        return _categoryCountsCache;
    }

    const products = getProducts();
    const counts = { all: products.length };

    // Compteurs enfants
    CATEGORY_GROUPS.forEach(group => {
        let parentCount = 0;
        group.children.forEach(child => {
            const childCount = products.filter(p =>
                p.category === child.id || normalizeCategory(p.category) === child.id
            ).length;
            counts[child.id] = childCount;
            parentCount += childCount;
        });
        // ✅ Compteur parent = somme des enfants + produits directement dans le parent
        const directCount = products.filter(p => p.category === group.id).length;
        counts[group.id] = parentCount + directCount;
    });

    _categoryCountsCache = counts;
    _categoryCountsTime = now;
    return counts;
}

// Invalidation sur chargement produits
export function invalidateCategoryCountsCache() {
    _categoryCountsCache = null;
    _categoryCountsTime = 0;
}

// ============================================================
// HELPER : Message vide contextuel
// ============================================================
function getEmptyProductsMessage() {
    const filters = getFilters();
    const category = filters.category;

    if (category === 'favorites') {
        const msg = t('noFavorites');
        return (msg && msg !== 'noFavorites') ? msg : 'Aucun favori pour le moment';
    }

    if (category && category !== 'all') {
        const msg = t('noProductsInCategory');
        if (msg && msg !== 'noProductsInCategory') return msg;
        const lang = getLang();
        const fallback = {
            fr: "Aucun produit disponible dans cette catégorie en ce moment.",
            ar: "لا توجد منتجات متاحة في هذه الفئة حالياً.",
            en: "No products available in this category at the moment."
        };
        return fallback[lang] || fallback.fr;
    }

    return t('noProductsFound');
}

// ============================================================
// RENDU DE LA GRILLE
// ============================================================
export async function renderProducts() {
    const grid = document.getElementById('productsGrid');
    if (!grid) return;

    const thisRequest = ++_renderRequestId;

    grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:3rem 1rem;">
            <div class="spinner" style="margin:0 auto;"></div>
        </div>
    `;

    const paginationEl = document.getElementById('paginationContainer');
    if (paginationEl) paginationEl.innerHTML = '';

    const user = getCurrentUser();
    const favs = Array.isArray(user?.favorites)
        ? user.favorites.map(Number).filter(Number.isFinite)
        : [];

    const pageProducts = getPaginatedProducts();
    const totalPages = getTotalPages();
    const currentPage = getPagination().currentPage;

    const productIds = pageProducts.map(p => Number(p.id)).filter(Number.isFinite);
    const stats = await getProductStatsBatch(productIds);

    if (thisRequest !== _renderRequestId) return;

    if (pageProducts.length === 0) {
        const emptyMessage = getEmptyProductsMessage();
        grid.innerHTML = `
            <div style="text-align:center;padding:3rem 1rem;color:var(--text-muted);grid-column:1/-1;font-size:0.95rem;">
                <div style="font-size:3rem;margin-bottom:1rem;line-height:1;">🔍</div>
                <p style="margin:0;">${emptyMessage}</p>
            </div>
        `;
        return;
    }

    let html = '';
    pageProducts.forEach(p => {
        const pid = Number(p.id);
        if (!Number.isFinite(pid)) return;

        const isFav = favs.includes(pid);
        const name = escapeHTML(getProductName(p));
        const desc = escapeHTML(getProductDesc(p));
        const img = getProductImageUrl(p);
        const price = p.price;
        const oldPrice = p.oldPrice;
        const stock = Number(p.stock) || 0;
        const isPromo = oldPrice && Number(oldPrice) > Number(price);
        const isNew = p.isNew || false;
        const discountPercent = getDiscountPercent(oldPrice, price);

        const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
        const optionsBadge = hasVariants
            ? `<span class="badge" style="background:var(--info);color:#fff;font-size:0.6rem;padding:0.15rem 0.4rem;border-radius:30px;position:absolute;top:0.5rem;right:0.5rem;z-index:2;">⚙️ Options</span>`
            : '';

        const r = stats[pid] || { avg: null, count: 0 };
        const hasReviews = r.count > 0;
        const avgRating = hasReviews ? r.avg : '--';
        const reviewCount = r.count || 0;

        const favAriaLabel = isFav ? t('favRemoved') : t('favAdded');

        const btnHtml = hasVariants
            ? `<button class="btn-choose-options" data-slug="${escapeHTML(p.slug || '')}" style="background:var(--gold);color:#fff;border:none;padding:0.3rem 0.7rem;border-radius:30px;font-size:0.7rem;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:0.3rem;">⚙️ ${t('chooseOptions') || 'Choisir les options'}</button>`
            : `<button class="btn-add-to-cart" data-id="${pid}">🛒 ${t('addToCart')}</button>`;

        const isOutOfStock = hasVariants
            ? !p.variants.some(v => (Number(v.stock) || 0) > 0)
            : stock === 0;

        // ✅ FIX #11 : badge catégorie (parent › enfant)
        const catPath = getCategoryPath(p.category);
        let catBadgeHtml = '';
        if (catPath.length > 0) {
            const child = catPath[catPath.length - 1];
            const parent = catPath.length > 1 ? catPath[0] : null;
            const label = parent
                ? `${parent.emoji} ${t(parent.label)} › ${t(child.label)}`
                : `${child.emoji} ${t(child.label)}`;
            catBadgeHtml = `<div style="font-size:0.65rem;color:var(--text-dim);margin-bottom:0.2rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(label)}</div>`;
        }

        html += `
            <div class="product-card" data-id="${pid}" data-slug="${escapeHTML(p.slug || '')}">
                <div class="product-img">
                    <img src="${img}" alt="${name}" loading="lazy" onerror="this.onerror=null; this.src='${getFallbackImage(name)}'">
                    <button class="favorite-btn ${isFav ? 'is-fav' : ''}" data-id="${pid}" aria-label="${favAriaLabel}">${isFav ? '❤️' : '🤍'}</button>
                    ${optionsBadge}
                    ${isOutOfStock ? `<span class="badge badge-hot">${t('outOfStock')}</span>` : ''}
                    ${isPromo ? `<span class="badge badge-promo">-${discountPercent}%</span>` : ''}
                    ${isNew && !isOutOfStock && !isPromo ? `<span class="badge badge-new">${t('trending')}</span>` : ''}
                </div>
                <div class="product-body">
                    ${catBadgeHtml}
                    <div class="p-name">${name}</div>
                    <div class="p-desc">${desc}</div>
                    <div class="p-stats">⭐ ${avgRating} <span style="color:var(--text-muted)">(${reviewCount})</span></div>
                    <div class="p-footer">
                        <div class="p-price">${price} ${t('currency')} ${oldPrice ? `<small>${oldPrice} ${t('currency')}</small>` : ''}</div>
                        ${btnHtml}
                    </div>
                </div>
            </div>
        `;
    });

    grid.innerHTML = html;

    grid.querySelectorAll('.btn-choose-options').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const slug = btn.dataset.slug;
            if (slug) {
                window.location.href = `/produit?slug=${encodeURIComponent(slug)}`;
            }
        });
    });

    if (!paginationEl) return;
    if (totalPages <= 1) { paginationEl.innerHTML = ''; return; }

    let pgHtml = `<span class="pagination-info">${currentPage}/${totalPages}</span>`;
    pgHtml += `<button class="pagination-btn ${currentPage === 1 ? 'disabled' : ''}" data-page="${currentPage - 1}">‹</button>`;
    for (let i = 1; i <= totalPages; i++) {
        pgHtml += `<button class="pagination-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    pgHtml += `<button class="pagination-btn ${currentPage === totalPages ? 'disabled' : ''}" data-page="${currentPage + 1}">›</button>`;
    paginationEl.innerHTML = pgHtml;
}

// ============================================================
// ✅ FIX #1 + #9 + #13 : FILTRES CATÉGORIES (2 rangées)
// ------------------------------------------------------------
// Rangée 1 : [Tout] [❤️ Favoris] [📱 Électronique (N)] [🏠 Maison (N)] ...
// Rangée 2 : n'apparaît QUE si un parent est actif :
//   [↳ Tout Électronique] [📱 Smartphones (N)] [📟 Tablettes (N)] ...
// ============================================================
export function renderCategoryFilters() {
    const container = document.getElementById('filtersCategories');
    if (!container) return;

    const filters = getFilters();
    const activeCat = filters.category || 'all';
    const counts = computeCategoryCounts();

    // ============================================
    // Déterminer le parent actif (si sous-catégorie active)
    // ============================================
    const activeCatObj = getCategoryById(activeCat);
    const activeParent = activeCatObj && !activeCatObj.isParent && activeCatObj.parentId
        ? getCategoryById(activeCatObj.parentId)
        : (activeCatObj && activeCatObj.isParent ? activeCatObj : null);

    // ============================================
    // RANGÉE 1 — Parents + Tout + Favoris
    // ============================================
    let htmlRow1 = '<div class="filters-categories-row filters-categories-parents">';

    // [Tout]
    const allActive = activeCat === 'all';
    htmlRow1 += `
        <button class="filter-btn ${allActive ? 'active' : ''}"
                data-action="products:filter"
                data-category="all"
                type="button">
            🛍️ ${t('filterAll')} (${counts.all || 0})
        </button>
    `;

    // [Favoris]
    const favActive = activeCat === 'favorites';
    htmlRow1 += `
        <button class="filter-btn ${favActive ? 'active' : ''}"
                data-action="products:filter"
                data-category="favorites"
                type="button">
            ❤️ ${t('filterFavorites')}
        </button>
    `;

    // [Parents]
    CATEGORY_GROUPS.forEach(group => {
        const isActive = activeCat === group.id || (activeParent && activeParent.id === group.id);
        const count = counts[group.id] || 0;
        htmlRow1 += `
            <button class="filter-btn filter-btn-parent ${isActive ? 'active' : ''}"
                    data-action="products:filter"
                    data-category="${group.id}"
                    type="button">
                ${group.emoji} ${t(group.label)} (${count})
            </button>
        `;
    });

    htmlRow1 += '</div>';

    // ============================================
    // RANGÉE 2 — Enfants du parent actif (si applicable)
    // ============================================
    let htmlRow2 = '';
    if (activeParent && activeParent.children && activeParent.children.length > 0) {
        const isParentActive = activeCat === activeParent.id;

        htmlRow2 += '<div class="filters-categories-row filters-categories-children">';

        // Bouton "Voir toute la catégorie"
        htmlRow2 += `
            <button class="filter-btn filter-btn-all-children ${isParentActive ? 'active' : ''}"
                    data-action="products:filter"
                    data-category="${activeParent.id}"
                    type="button"
                    title="Voir tous les produits de ${t(activeParent.label)}">
                ↳ ${t('filterAllOf') || 'Tout'} ${t(activeParent.label)}
            </button>
        `;

        // Enfants
        activeParent.children.forEach(child => {
            const isChildActive = activeCat === child.id;
            const count = counts[child.id] || 0;
            // Ne pas afficher les enfants vides (sauf si actif)
            if (count === 0 && !isChildActive) return;
            htmlRow2 += `
                <button class="filter-btn filter-btn-child ${isChildActive ? 'active' : ''}"
                        data-action="products:filter"
                        data-category="${child.id}"
                        type="button">
                    ${child.emoji} ${t(child.label)} (${count})
                </button>
            `;
        });

        htmlRow2 += '</div>';
    }

    container.innerHTML = htmlRow1 + htmlRow2;

    // ============================================
    // Listener "clear temp filter" pour le bouton actif
    // ============================================
    // (géré par events.js via data-action)
}

// ============================================================
// RENDU DU SELECT DE TRI
// ============================================================
export function renderSortOptions() {
    const select = document.getElementById('sortSelect');
    if (!select) return;
    if (!Array.isArray(SORT_OPTIONS) || SORT_OPTIONS.length === 0) return;

    const currentValue = select.value || 'default';
    let html = '';
    SORT_OPTIONS.forEach(opt => {
        html += `<option value="${opt.value}">${t(opt.label)}</option>`;
    });
    select.innerHTML = html;

    if ([...select.options].some(o => o.value === currentValue)) {
        select.value = currentValue;
    }
}

// ============================================================
// TOGGLE FAVORI (arrayUnion/arrayRemove — atomique)
// ============================================================
export async function toggleFavorite(productId) {
    const user = getCurrentUser();

    if (!user || !user.uid) {
        showToast('🔒 ' + t('loginRequired'));
        document.dispatchEvent(new CustomEvent('open-account'));
        return;
    }

    const pid = Number(productId);
    if (!Number.isFinite(pid)) {
        console.warn('⚠️ toggleFavorite : ID invalide', productId);
        return;
    }

    const currentFavs = Array.isArray(user.favorites)
        ? user.favorites.map(Number).filter(Number.isFinite)
        : [];
    const isAdding = !currentFavs.includes(pid);

    try {
        await updateDoc(doc(db, "users", user.uid), {
            favorites: isAdding ? arrayUnion(pid) : arrayRemove(pid)
        });

        const newFavs = isAdding
            ? [...new Set([...currentFavs, pid])]
            : currentFavs.filter(id => id !== pid);

        setCurrentUser({ ...user, favorites: newFavs });

        showToast(isAdding ? '❤️ ' + t('favAdded') : '💔 ' + t('favRemoved'));

        if (document.getElementById('productsGrid')) {
            await renderProducts();
        }
    } catch (e) {
        console.error('❌ toggleFavorite :', e);
        showToast('❌ ' + t('error'));
    }
}

// ============================================================
// NAVIGATION VERS PAGE PRODUIT
// ============================================================
export function openProductPage(slug) {
    if (!slug) return;
    window.location.href = `/produit?slug=${encodeURIComponent(slug)}`;
}

// ============================================================
// LOG
// ============================================================
console.log('✅ products.js chargé — v3.1.0 (filtres 2 rangées + compteurs)');