// js/products.js
// ============================================================
// GESTION DES PRODUITS - SMART SWI9A
// Version 3.3.0 — Bande défilante visuelle (23 catégories)
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

let _renderRequestId = 0;

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
        const filters = getFilters();
        let emptyMessage = t('noProductsFound');
        if (filters.category === 'favorites') emptyMessage = t('noFavorites');
        else if (filters.category !== 'all') emptyMessage = t('noProductsInCategory');

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
// ✅ RENDU DES CATÉGORIES (BANDE DÉFILANTE)
// ============================================================
export function renderCategoryFilters() {
    const mainContainer = document.getElementById('filtersCategories');
    if (!mainContainer) return;

    const filters = getFilters();
    const activeCat = filters.category || 'all';
    const activeCatObj = getCategoryById(activeCat);
    
    // Déterminer si on est sur un parent ou un enfant
    const activeParentId = activeCatObj?.parentId || (activeCatObj?.isParent ? activeCatObj.id : null);

    // ============================================
    // BANDE 1 : PARENTS (Toujours visible)
    // ============================================
    let mainHtml = `<div class="categories-scroll-row">`;
    
    // Bouton "Tout"
    mainHtml += `
        <button class="category-scroll-item ${activeCat === 'all' ? 'active' : ''}" data-action="products:filter" data-category="all">
            <div class="category-scroll-img" style="background:var(--bg-surface);font-size:1.8rem;">🛍️</div>
            <span class="category-scroll-label">${t('filterAll')}</span>
        </button>
    `;

    // Bouton "Favoris"
    mainHtml += `
        <button class="category-scroll-item ${activeCat === 'favorites' ? 'active' : ''}" data-action="products:filter" data-category="favorites">
            <div class="category-scroll-img" style="background:var(--bg-surface);font-size:1.8rem;">❤️</div>
            <span class="category-scroll-label">${t('filterFavorites')}</span>
        </button>
    `;

    // 23 Catégories Parents
    CATEGORY_GROUPS.forEach(group => {
        const isActive = activeCat === group.id || activeParentId === group.id;
        const imgPath = `/assets/categories/${group.id}.webp`;
        mainHtml += `
            <button class="category-scroll-item ${isActive ? 'active' : ''}" data-action="products:filter" data-category="${group.id}">
                <div class="category-scroll-img">
                    <img src="${imgPath}" alt="${t(group.label)}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="category-scroll-fallback" style="display:none;">${group.emoji}</div>
                </div>
                <span class="category-scroll-label">${t(group.label)}</span>
            </button>
        `;
    });
    mainHtml += `</div>`;
    mainContainer.innerHTML = mainHtml;

    // ============================================
    // BANDE 2 : ENFANTS (Affiché seulement si un parent est sélectionné)
    // ============================================
    let childContainer = document.getElementById('subFiltersCategories');
    if (!childContainer) {
        childContainer = document.createElement('div');
        childContainer.id = 'subFiltersCategories';
        childContainer.style.marginTop = '0.5rem';
        mainContainer.appendChild(childContainer);
    }

    if (activeParentId) {
        const parentGroup = CATEGORY_GROUPS.find(g => g.id === activeParentId);
        if (parentGroup && parentGroup.children.length > 0) {
            let childHtml = `<div class="categories-scroll-row sub-row">`;
            
            // Bouton "Tout [Parent]"
            childHtml += `
                <button class="category-scroll-item child-item ${activeCat === parentGroup.id ? 'active' : ''}" data-action="products:filter" data-category="${parentGroup.id}">
                    <div class="category-scroll-img" style="border-style:dashed; border-color:var(--gold);">
                        <span style="font-size:1.5rem;color:var(--gold);">↳</span>
                    </div>
                    <span class="category-scroll-label" style="color:var(--gold);">Tout</span>
                </button>
            `;

            parentGroup.children.forEach(child => {
                const isActive = activeCat === child.id;
                const imgPath = `/assets/categories/${child.id}.webp`;
                childHtml += `
                    <button class="category-scroll-item child-item ${isActive ? 'active' : ''}" data-action="products:filter" data-category="${child.id}">
                        <div class="category-scroll-img">
                            <img src="${imgPath}" alt="${t(child.label)}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                            <div class="category-scroll-fallback" style="display:none;">${child.emoji}</div>
                        </div>
                        <span class="category-scroll-label">${t(child.label)}</span>
                    </button>
                `;
            });
            childHtml += `</div>`;
            childContainer.innerHTML = childHtml;
            childContainer.style.display = 'block';
            
            // Scroll auto au début
            setTimeout(() => {
                const row = childContainer.querySelector('.categories-scroll-row');
                if (row) row.scrollLeft = 0;
            }, 50);
        } else {
            childContainer.style.display = 'none';
        }
    } else {
        childContainer.style.display = 'none';
        childContainer.innerHTML = '';
    }
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
console.log('✅ products.js chargé — v3.3.0 (Bande défilante visuelle)');