// js/products.js
// ============================================================
// GESTION DES PRODUITS - SMART SWI9A
// Version 3.0.0 — Fixes critiques (filtres parents, races, cache)
// ============================================================
// CHANGEMENTS v3.0.0 :
// ✅ C8.1 — Filtre parent via productMatchesCategory (config.js)
// ✅ C8.2 — renderProducts guard _renderRequestId (fin race)
// ✅ I8.1 — btn-choose-options séparé (au lieu de btn-add-to-cart)
// ✅ I8.2 — toggleFavorite arrayUnion/arrayRemove (fin race)
// ✅ I8.3 — Filtre inStock : variant-aware
// ✅ I8.4 — Loading spinner immédiat
// ✅ I8.5 — getProductStatsBatch : cache + TTL + invalidation
// ✅ M8.1 — getNewProducts(onlyInStock = true)
// ✅ M8.2 — getPromoProducts(onlyInStock = true)
// ✅ M8.3 — Warning clair si > 30 IDs (limite Firestore 'in')
// ✅ M8.x — Guards + favorites normalisés + favoris visibles
// ============================================================

import {
    collection, getDocs, query, where, doc, updateDoc, arrayUnion, arrayRemove
} from "firebase/firestore";
import { db } from "./firebase.js";
import {
    CONFIG, CATEGORIES, SORT_OPTIONS,
    productMatchesCategory
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
// CACHE STATS AVIS (I8.5)
// ------------------------------------------------------------
// TTL 60s + invalidation sur 'review-submitted'
// Cap à 100 entrées (évite fuite mémoire)
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
// ✅ C8.1 — productMatchesCategory (parents + legacy)
// ✅ I8.3 — inStock variant-aware
// ============================================================
export function getFilteredProducts() {
    const products = getProducts();
    const filters = getFilters();
    const user = getCurrentUser();
    const favs = Array.isArray(user?.favorites)
        ? user.favorites.map(Number).filter(Number.isFinite)
        : [];

    let list = [...products];

    // Favoris
    if (filters.category === 'favorites') {
        list = list.filter(p => favs.includes(Number(p.id)));
    }
    // Catégorie (parent OU enfant, gère legacy)
    else if (filters.category && filters.category !== 'all') {
        // ✅ C8.1 : productMatchesCategory gère parents + legacy
        list = list.filter(p => productMatchesCategory(p, filters.category));
    }

    // Recherche
    if (filters.search && filters.search.trim()) {
        const q = filters.search.toLowerCase().trim();
        list = list.filter(p => {
            const name = getProductName(p).toLowerCase();
            const desc = getProductDesc(p).toLowerCase();
            return name.includes(q) || desc.includes(q);
        });
    }

    // ✅ I8.3 : En stock (variant-aware)
    if (filters.inStock) {
        list = list.filter(p => {
            if (Array.isArray(p.variants) && p.variants.length > 0) {
                return p.variants.some(v => (Number(v.stock) || 0) > 0);
            }
            return (Number(p.stock) || 0) > 0;
        });
    }

    // En promo
    if (filters.promos) {
        list = list.filter(p => p.oldPrice && Number(p.oldPrice) > Number(p.price));
    }

    // Prix
    if (filters.priceMin > 0) list = list.filter(p => p.price >= filters.priceMin);
    if (filters.priceMax < 99999) list = list.filter(p => p.price <= filters.priceMax);

    // Tri
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
// ✅ M8.1 — NOUVEAUTÉS (onlyInStock par défaut)
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

// ============================================================
// ✅ M8.2 — PROMOS (onlyInStock par défaut)
// ============================================================
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
// ✅ I8.5 — STATS DES AVIS (avec cache)
// ============================================================
export async function getProductStatsBatch(productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) return {};

    // ✅ M8.3 : warning explicite si > 30
    if (productIds.length > 30) {
        console.warn(`⚠️ getProductStatsBatch: ${productIds.length} IDs fournis (max 30 Firestore 'in') — troncature`);
    }

    const ids = productIds.slice(0, 30).map(Number).filter(Number.isFinite);
    if (ids.length === 0) return {};

    const now = Date.now();
    const toFetch = [];
    const result = {};

    // 1. Servir depuis le cache
    ids.forEach(pid => {
        const cached = _statsCache.get(pid);
        if (cached && (now - cached.timestamp) < STATS_CACHE_TTL) {
            result[pid] = cached.stats;
        } else {
            toFetch.push(pid);
        }
    });

    if (toFetch.length === 0) return result;

    // 2. Fetch le reste
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

            // Cap taille cache
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
// ✅ C8.2 + I8.1 + I8.4 — RENDU DE LA GRILLE
// ============================================================
export async function renderProducts() {
    const grid = document.getElementById('productsGrid');
    if (!grid) return;

    // ✅ C8.2 : guard anti-race
    const thisRequest = ++_renderRequestId;

    // ✅ I8.4 : loading immédiat
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

    // Fetch stats (await)
    const productIds = pageProducts.map(p => Number(p.id)).filter(Number.isFinite);
    const stats = await getProductStatsBatch(productIds);

    // ✅ C8.2 : abandon si une autre requête a démarré entre-temps
    if (thisRequest !== _renderRequestId) return;

    // Empty state
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

        // ✅ I8.1 : bouton différent pour les variantes
        const btnHtml = hasVariants
            ? `<button class="btn-choose-options" data-slug="${escapeHTML(p.slug || '')}" style="background:var(--gold);color:#fff;border:none;padding:0.3rem 0.7rem;border-radius:30px;font-size:0.7rem;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:0.3rem;">⚙️ ${t('chooseOptions') || 'Choisir les options'}</button>`
            : `<button class="btn-add-to-cart" data-id="${pid}">🛒 ${t('addToCart')}</button>`;

        // Stock status : si variants, vérifier s'il y en a au moins une en stock
        const isOutOfStock = hasVariants
            ? !p.variants.some(v => (Number(v.stock) || 0) > 0)
            : stock === 0;

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

    // ✅ I8.1 : handler dédié pour "Choisir les options"
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

    // ✅ I8.1 : les boutons "Ajouter au panier" sont gérés par events.js
    // (délégation via .btn-add-to-cart) — pas besoin de listener ici

    // Pagination
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
// ✅ M8.x — FILTRES CATÉGORIES (favoris maintenant visibles)
// ============================================================
export function renderCategoryFilters() {
    const container = document.getElementById('filtersCategories');
    if (!container) return;

    const filters = getFilters();
    const categories = CATEGORIES || [];

    let html = '';
    categories.forEach(cat => {
        // Afficher : 'all', 'favorites', et catégories parentes uniquement
        const isVisible = cat.id === 'all'
            || cat.id === 'favorites'
            || cat.isParent;

        if (!isVisible) return;

        const isActive = filters.category === cat.id;
        html += `
            <button class="filter-btn ${isActive ? 'active' : ''}" data-action="products:filter" data-category="${cat.id}" type="button">
                ${cat.emoji || ''} ${t(cat.label)}
            </button>
        `;
    });
    container.innerHTML = html;
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
// ✅ I8.2 — TOGGLE FAVORI (arrayUnion/arrayRemove — atomique)
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
        // ✅ I8.2 : opération atomique (pas de replace du tableau)
        await updateDoc(doc(db, "users", user.uid), {
            favorites: isAdding ? arrayUnion(pid) : arrayRemove(pid)
        });

        // Sync local
        const newFavs = isAdding
            ? [...new Set([...currentFavs, pid])]
            : currentFavs.filter(id => id !== pid);

        setCurrentUser({ ...user, favorites: newFavs });

        showToast(isAdding ? '❤️ ' + t('favAdded') : '💔 ' + t('favRemoved'));

        // Re-render (si sur home)
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
console.log('✅ products.js chargé — v3.0.0 (filtres parents, races, cache)');