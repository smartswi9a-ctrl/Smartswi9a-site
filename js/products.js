// js/products.js
// ============================================================
// GESTION DES PRODUITS - SMART SWI9A
// Version 1.6.1 — FIX : favoris persistants + bannière Nouveautés (isNew)
// ============================================================
// Dépend de : config, utils, store, firebase, auth, ui-core
// ============================================================

import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG, CATEGORIES, SORT_OPTIONS } from "./config.js";
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
    getCurrentUser, getUserProfile, saveUserProfile, setCurrentUser
} from "./auth.js";
import { showToast } from "./ui-core.js";

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
    // ✅ Normalisation des favoris en Number
    const favs = Array.isArray(user?.favorites)
        ? user.favorites.map(Number)
        : [];

    let list = [...products];

    if (filters.category === 'favorites') {
        list = list.filter(p => favs.includes(Number(p.id)));
    } else if (filters.category && filters.category !== 'all') {
        list = list.filter(p => p.category === filters.category);
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
        list = list.filter(p => (p.stock || 0) > 0);
    }

    if (filters.promos) {
        list = list.filter(p => p.oldPrice && p.oldPrice > p.price);
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
    const start = (pagination.currentPage - 1) * pagination.perPage;
    return filtered.slice(start, start + pagination.perPage);
}

export function getTotalPages() {
    const total = getFilteredProducts().length;
    return Math.max(1, Math.ceil(total / getPagination().perPage));
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
// RECHERCHE PAR SLUG / ID
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
// NOUVEAUTÉS ET PROMOS
// ============================================================
export function getNewProducts(limit = 10) {
    // ✅ FIX v1.6.1 : Filtre uniquement les produits avec la case "Nouveau" cochée
    const products = getProducts().filter(p => p.isNew === true);
    
    products.sort((a, b) => {
        const da = toDate(a.createdAt)?.getTime() || 0;
        const dbb = toDate(b.createdAt)?.getTime() || 0;
        return dbb - da;
    });
    return products.slice(0, limit);
}

export function getPromoProducts() {
    return getProducts()
        .filter(p => p.oldPrice && p.oldPrice > p.price)
        .sort((a, b) => {
            const da = a.oldPrice > 0 ? (a.oldPrice - a.price) / a.oldPrice : 0;
            const dbb = b.oldPrice > 0 ? (b.oldPrice - b.price) / b.oldPrice : 0;
            return dbb - da;
        });
}

// ============================================================
// STATS DES AVIS (batch pour cartes produit)
// ============================================================
export async function getProductStatsBatch(productIds) {
    if (!productIds || productIds.length === 0) return {};

    if (productIds.length > 30) {
        console.warn(`⚠️ getProductStatsBatch : ${productIds.length} IDs fournis (max 30). Troncature.`);
    }

    try {
        const ids = productIds.slice(0, 30).map(Number);
        const q = query(
            collection(db, "reviews"),
            where("productId", "in", ids),
            where("status", "==", "approved")
        );
        const snap = await getDocs(q);
        const ratings = {};
        snap.forEach(doc => {
            const r = doc.data();
            if (!ratings[r.productId]) ratings[r.productId] = { sum: 0, count: 0 };
            ratings[r.productId].sum += r.rating || 0;
            ratings[r.productId].count++;
        });
        const result = {};
        for (const pid in ratings) {
            result[pid] = {
                avg: (ratings[pid].sum / ratings[pid].count).toFixed(1),
                count: ratings[pid].count
            };
        }
        return result;
    } catch (e) {
        console.warn('⚠️ Erreur stats avis :', e);
        return {};
    }
}

// ============================================================
// ✅ HELPER : Message vide contextuel
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
// RENDU DE LA GRILLE PRODUITS
// ============================================================
export async function renderProducts() {
    const grid = document.getElementById('productsGrid');
    if (!grid) return;

    const pagination = document.getElementById('paginationContainer');
    const user = getCurrentUser();
    // ✅ Normalisation des favoris en Number
    const favs = Array.isArray(user?.favorites)
        ? user.favorites.map(Number)
        : [];
    const pageProducts = getPaginatedProducts();
    const totalPages = getTotalPages();
    const currentPage = getPagination().currentPage;

    const productIds = pageProducts.map(p => Number(p.id));
    const stats = await getProductStatsBatch(productIds);

    if (pageProducts.length === 0) {
        const emptyMessage = getEmptyProductsMessage();
        grid.innerHTML = `
            <div style="
                text-align:center;
                padding:3rem 1rem;
                color:var(--text-muted);
                grid-column:1/-1;
                font-size:0.95rem;
            ">
                <div style="font-size:3rem;margin-bottom:1rem;line-height:1;">🔍</div>
                <p style="margin:0;">${emptyMessage}</p>
            </div>
        `;
        if (pagination) pagination.innerHTML = '';
        return;
    }

    let html = '';
    pageProducts.forEach(p => {
        const pid = Number(p.id);
        const isFav = favs.includes(pid);
        const name = escapeHTML(getProductName(p));
        const desc = escapeHTML(getProductDesc(p));
        const img = getProductImageUrl(p);
        const price = p.price;
        const oldPrice = p.oldPrice;
        const stock = Number(p.stock) || 0;
        const isPromo = oldPrice && oldPrice > price;
        const isNew = p.isNew || false;
        const discountPercent = getDiscountPercent(oldPrice, price);

        const r = stats[pid] || { avg: null, count: 0 };
        const hasReviews = r.count > 0;
        const avgRating = hasReviews ? r.avg : '--';
        const reviewCount = r.count || 0;

        const favAriaLabel = isFav ? t('favRemoved') : t('favAdded');

        html += `
            <div class="product-card" data-id="${pid}" data-slug="${escapeHTML(p.slug || '')}">
                <div class="product-img">
                    <img src="${img}" alt="${name}" loading="lazy" onerror="this.src='${getFallbackImage(name)}'">
                    <button class="favorite-btn ${isFav ? 'is-fav' : ''}" data-id="${pid}" aria-label="${favAriaLabel}">${isFav ? '❤️' : '🤍'}</button>
                    ${stock === 0 ? `<span class="badge badge-hot">${t('outOfStock')}</span>` : ''}
                    ${isPromo ? `<span class="badge badge-promo">-${discountPercent}%</span>` : ''}
                    ${isNew && stock > 0 ? `<span class="badge badge-new">${t('trending')}</span>` : ''}
                </div>
                <div class="product-body">
                    <div class="p-name">${name}</div>
                    <div class="p-desc">${desc}</div>
                    <div class="p-stats">⭐ ${avgRating} <span style="color:var(--text-muted)">(${reviewCount})</span></div>
                    <div class="p-footer">
                        <div class="p-price">${price} ${t('currency')} ${oldPrice ? `<small>${oldPrice} ${t('currency')}</small>` : ''}</div>
                        <button class="btn-add-to-cart" data-id="${pid}">🛒 ${t('addToCart')}</button>
                    </div>
                </div>
            </div>
        `;
    });
    grid.innerHTML = html;

    if (!pagination) return;
    if (totalPages <= 1) { pagination.innerHTML = ''; return; }

    let pgHtml = `<span class="pagination-info">${currentPage}/${totalPages}</span>`;
    pgHtml += `<button class="pagination-btn ${currentPage === 1 ? 'disabled' : ''}" data-page="${currentPage - 1}">‹</button>`;
    for (let i = 1; i <= totalPages; i++) {
        pgHtml += `<button class="pagination-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    pgHtml += `<button class="pagination-btn ${currentPage === totalPages ? 'disabled' : ''}" data-page="${currentPage + 1}">›</button>`;
    pagination.innerHTML = pgHtml;
}

// ============================================================
// RENDU DES FILTRES CATÉGORIES
// ============================================================
export function renderCategoryFilters() {
    const container = document.getElementById('filtersCategories');
    if (!container) return;

    const filters = getFilters();
    const categories = CATEGORIES || [];

    let html = '';
    categories.forEach(cat => {
        const isActive = filters.category === cat.id;
        html += `
            <button
                class="filter-btn ${isActive ? 'active' : ''}"
                data-action="products:filter"
                data-category="${cat.id}"
                type="button">
                ${cat.emoji || ''} ${t(cat.label)}
            </button>
        `;
    });
    container.innerHTML = html;
}

// ============================================================
// RENDU DU SELECT DE TRI (dynamique)
// ============================================================
export function renderSortOptions() {
    const select = document.getElementById('sortSelect');
    if (!select) return;
    if (!SORT_OPTIONS || SORT_OPTIONS.length === 0) return;

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
// ✅ TOGGLE FAVORI — v1.6.1 FIX PERSISTANCE
// ============================================================
export async function toggleFavorite(productId) {
    const user = getCurrentUser();

    // 1. Vérifier connexion
    if (!user || !user.uid) {
        showToast('🔒 ' + t('loginRequired'));
        document.dispatchEvent(new CustomEvent('open-account'));
        return;
    }

    // 2. Normaliser l'ID
    const pid = Number(productId);
    if (!Number.isFinite(pid)) {
        console.warn('⚠️ toggleFavorite : ID invalide', productId);
        return;
    }

    // 3. Récupérer les favoris locaux (source de vérité)
    const currentFavs = Array.isArray(user.favorites)
        ? user.favorites.map(Number).filter(Number.isFinite)
        : [];
    const favs = [...currentFavs];
    const existingIdx = favs.indexOf(pid);

    // 4. Ajouter ou retirer
    let isAdding = false;
    if (existingIdx !== -1) {
        favs.splice(existingIdx, 1);
    } else {
        favs.push(pid);
        isAdding = true;
    }

    console.log(`🔄 [toggleFavorite] ${isAdding ? 'Ajout' : 'Retrait'} produit #${pid}`, favs);

    // 5. Sauvegarder dans Firestore
    const ok = await saveUserProfile(user.uid, { favorites: favs });

    if (!ok) {
        console.error('❌ [toggleFavorite] Échec de la sauvegarde Firestore');
        showToast('❌ ' + t('error'));
        return;
    }

    // 6. ✅ Mettre à jour l'état global (store + localStorage)
    setCurrentUser({ ...user, favorites: favs });

    // 7. Toast de confirmation
    if (isAdding) {
        showToast('❤️ ' + t('favAdded'));
    } else {
        showToast('💔 ' + t('favRemoved'));
    }

    // 8. Re-render les produits
    renderProducts();
}

// ============================================================
// NAVIGATION VERS PAGE PRODUIT
// ============================================================
export function openProductPage(slug) {
    if (!slug) return;
    // ✅ On garde votre URL propre (sans .html) qui fonctionne avec Cloudflare
    window.location.href = `/produit?slug=${encodeURIComponent(slug)}`;
}

// ============================================================
// LOG
// ============================================================
console.log('✅ products.js chargé — v1.6.1 (favoris + bannière Nouveautés fixés)');