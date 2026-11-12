/* ============================================================
   js/boutique.js
   PAGE BOUTIQUE PUBLIQUE VENDEUR - SMARTSWIKA
   Version 11.0.0 - Pagination Firestore corrigée (orderBy)
   ============================================================ */

import {
    doc, getDoc, collection, query, where, getDocs, limit, startAfter, orderBy
} from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG, VENDOR_STATUS, PRODUCT_STATUS, getCategoryById } from "./config.js";
import {
    t, escapeHTML, getProductName, getProductImageUrl, getFallbackImage,
    getDiscountPercent, toDate
} from "./utils.js";
import { getCurrentUser } from "./auth.js";
import { normalizeProductId } from "./domain/product-id.js";

/* ============================================================
   HELPERS
   ============================================================ */

function safeImageUrl(url) {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) return escapeHTML(trimmed);
    if (trimmed.startsWith('/')) return escapeHTML(trimmed);
    return '';
}

/* ============================================================
   ÉTAT LOCAL
   ============================================================ */
let currentVendor = null;
let vendorProducts = [];
let filteredProducts = [];
let activeCategory = 'all';
let currentPage = 1;
const PRODUCTS_PER_PAGE = 12;

/* Pagination Firestore */
const PRODUCTS_BATCH_SIZE = 50;
let lastVisibleProduct = null;
let hasMoreProducts = true;
let isLoadingMore = false;

let _initInProgress = false;

/* ============================================================
   INIT
   ============================================================ */
async function initBoutique() {
    if (_initInProgress) return;

    const params = new URLSearchParams(window.location.search);
    const vendorUid = params.get('v');

    if (!vendorUid) {
        showError('not_found');
        return;
    }

    _initInProgress = true;

    try {
        const vendorSnap = await getDoc(doc(db, "vendorsPublic", vendorUid));
        if (!vendorSnap.exists()) {
            showError('not_found');
            return;
        }

        const vendorPublic = vendorSnap.data() || {};
        const status = vendorPublic.status;

        if (status !== VENDOR_STATUS.APPROVED) {
            if (status === VENDOR_STATUS.SUSPENDED || status === VENDOR_STATUS.PENDING) {
                showError('suspended');
            } else {
                showError('not_found');
            }
            return;
        }

        currentVendor = {
            uid: vendorUid,
            shopName: vendorPublic.shopName || 'Boutique',
            description: vendorPublic.description || '',
            status: status,
            createdAt: toDate(vendorPublic.createdAt)
        };

        await loadVendorProducts(true);

        renderBoutique();
        setupEventListeners();
        applyCategoryFilter('all');
        updateBoutiqueMeta();
        toggleLoading(false);

    } catch (e) {
        console.error('[boutique] Erreur chargement :', e);
        showError('error');
    } finally {
        _initInProgress = false;
    }
}

/* ============================================================
   CHARGEMENT PRODUITS (M3 : orderBy + startAfter)
   ============================================================
   Sans orderBy, Firestore ne garantit ni l'ordre des docs ni
   le comportement de startAfter → risque de doublons / docs
   sautés. L'index composite
   products (vendorId ==, status ==, createdAt DESC) est requis
   (déjà présent dans firestore.indexes.json).
   ============================================================ */
async function loadVendorProducts(reset = false) {
    if (reset) {
        vendorProducts = [];
        lastVisibleProduct = null;
        hasMoreProducts = true;
    }
    if (!hasMoreProducts || isLoadingMore) return;

    isLoadingMore = true;
    try {
        const constraints = [
            where("vendorId", "==", currentVendor.uid),
            where("status", "==", PRODUCT_STATUS.APPROVED),
            orderBy("createdAt", "desc"),
            limit(PRODUCTS_BATCH_SIZE)
        ];
        if (lastVisibleProduct) {
            constraints.push(startAfter(lastVisibleProduct));
        }

        const q = query(collection(db, "products"), ...constraints);
        const snap = await getDocs(q);

        const newProducts = snap.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                price: Number(data.price) || 0,
                oldPrice: Number(data.oldPrice) || 0,
                stock: Number(data.stock) || 0,
                ratingAvg: Number(data.ratingAvg) || 0,
                ratingCount: Number(data.ratingCount) || 0
            };
        });

        vendorProducts = [...vendorProducts, ...newProducts];
        lastVisibleProduct = snap.docs[snap.docs.length - 1] || null;
        hasMoreProducts = snap.docs.length === PRODUCTS_BATCH_SIZE;

    } catch (e) {
        console.error('[boutique] Erreur chargement produits :', e);
        hasMoreProducts = false;
    } finally {
        isLoadingMore = false;
    }
}

/* ============================================================
   ÉTATS UI
   ============================================================ */
function toggleLoading(show) {
    const loadingEl = document.getElementById('boutiqueLoading');
    const contentEl = document.getElementById('boutiqueContent');
    if (loadingEl) loadingEl.style.display = show ? '' : 'none';
    if (contentEl) contentEl.style.display = show ? 'none' : 'block';
}

function showError(type) {
    const loadingEl = document.getElementById('boutiqueLoading');
    const contentEl = document.getElementById('boutiqueContent');
    const errorEl = document.getElementById('boutiqueError');
    const titleEl = document.getElementById('boutiqueErrorTitle');
    const textEl = document.getElementById('boutiqueErrorText');

    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'none';

    if (titleEl && textEl) {
        if (type === 'suspended') {
            titleEl.textContent = t('boutiqueSuspended') || 'Boutique momentanément indisponible';
            textEl.textContent = t('boutiqueSuspendedText') || "Cette boutique n'est pas disponible pour le moment. Réessayez plus tard.";
        } else if (type === 'error') {
            titleEl.textContent = t('error') || 'Erreur';
            textEl.textContent = t('loadingError') || 'Impossible de charger la boutique.';
        } else {
            titleEl.textContent = t('boutiqueNotFound') || 'Boutique introuvable';
            textEl.textContent = t('boutiqueNotFoundText') || "Cette boutique n'existe pas ou a été retirée.";
        }
    }

    if (errorEl) errorEl.style.display = 'block';
}

/* ============================================================
   SEO DYNAMIQUE
   ============================================================ */
function updateBoutiqueMeta() {
    if (!currentVendor) return;
    const name = currentVendor.shopName;
    const count = vendorProducts.length;
    const description = count > 0
        ? `Découvrez les produits de la boutique ${name} sur Smartswika. Livraison 24-72h, paiement à la livraison.`
        : `Découvrez la boutique ${name} sur Smartswika. Livraison 24-72h, paiement à la livraison.`;
    const url = `${CONFIG.SHOP.URL}/boutique.html?v=${encodeURIComponent(currentVendor.uid)}`;
    document.title = `${name} | Smartswika`;
    setMeta('name', 'description', description.substring(0, 160));
    setMeta('property', 'og:title', name);
    setMeta('property', 'og:description', description.substring(0, 200));
    setMeta('property', 'og:url', url);
    setMeta('property', 'og:type', 'website');
    setMeta('name', 'twitter:card', 'summary');
    setMeta('name', 'twitter:title', name);
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
        canonical = document.createElement('link');
        canonical.rel = 'canonical';
        document.head.appendChild(canonical);
    }
    canonical.href = url;
}

function setMeta(attrName, attrValue, content) {
    let el = document.querySelector(`meta[${attrName}="${attrValue}"]`);
    if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attrName, attrValue);
        document.head.appendChild(el);
    }
    el.setAttribute('content', content || '');
}

/* ============================================================
   RENDER BOUTIQUE
   ============================================================ */
function renderBoutique() {
    if (!currentVendor) return;
    const nameEl = document.getElementById('boutiqueName');
    if (nameEl) nameEl.textContent = currentVendor.shopName;
    const breadcrumbEl = document.getElementById('boutiqueBreadcrumbCurrent');
    if (breadcrumbEl) breadcrumbEl.textContent = currentVendor.shopName;
    const avatarEl = document.getElementById('boutiqueAvatar');
    if (avatarEl) {
        const initial = (currentVendor.shopName || 'B').charAt(0).toUpperCase();
        avatarEl.textContent = initial;
    }
    const meta = document.getElementById('boutiqueMeta');
    if (meta) {
        const productCount = vendorProducts.length;
        const productsWithRating = vendorProducts.filter(p => p.ratingCount > 0);
        let avgRating = null;
        if (productsWithRating.length > 0) {
            avgRating = (productsWithRating.reduce((sum, p) => sum + p.ratingAvg, 0) / productsWithRating.length).toFixed(1);
        }
        let metaHtml = `
            <span class="boutique-verified-badge">${t('boutiqueVerified') || 'Boutique vérifiée'}</span>
            <span class="boutique-meta-item">${productCount} ${productCount > 1 ? (t('items') || 'produits') : (t('cartItemSingular') || 'produit')}</span>
        `;
        if (avgRating) {
            metaHtml += `<span class="boutique-meta-item">${escapeHTML(String(avgRating))} / 5</span>`;
        }
        meta.innerHTML = metaHtml;
    }
    const desc = document.getElementById('boutiqueDesc');
    if (desc) {
        if (currentVendor.description) {
            desc.textContent = currentVendor.description;
            desc.style.display = '';
        } else {
            desc.textContent = '';
            desc.style.display = 'none';
        }
    }
    renderFilters();
}

/* ============================================================
   FILTRES CATÉGORIES
   ============================================================ */
function renderFilters() {
    const container = document.getElementById('boutiqueFilters');
    if (!container) return;
    if (vendorProducts.length === 0) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
    }
    const categories = new Map();
    vendorProducts.forEach(p => {
        if (!p.category) return;
        const cat = getCategoryById(p.category);
        if (!cat) return;
        const parentId = cat.parentId || cat.id;
        const parentCat = getCategoryById(parentId);
        if (parentCat) {
            categories.set(parentId, {
                id: parentId,
                label: t(parentCat.label) || parentCat.id,
                emoji: parentCat.emoji || '📦',
                count: (categories.get(parentId)?.count || 0) + 1
            });
        }
    });
    if (categories.size <= 1) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    container.style.display = '';
    let html = `<button class="boutique-filter-btn active" data-category="all">${t('filterAll') || 'Tout'} (${vendorProducts.length})</button>`;
    [...categories.values()].forEach(cat => {
        html += `<button class="boutique-filter-btn" data-category="${escapeHTML(cat.id)}">${cat.emoji} ${escapeHTML(cat.label)} (${cat.count})</button>`;
    });
    container.innerHTML = html;
}

function applyCategoryFilter(categoryId) {
    activeCategory = categoryId;
    if (categoryId === 'all') {
        filteredProducts = [...vendorProducts];
    } else {
        filteredProducts = vendorProducts.filter(p => {
            if (!p.category) return false;
            const cat = getCategoryById(p.category);
            if (!cat) return false;
            const parentId = cat.parentId || cat.id;
            return parentId === categoryId;
        });
    }
    currentPage = 1;
    renderGrid();
    renderPagination();
    document.querySelectorAll('.boutique-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.category === categoryId);
    });
}

/* ============================================================
   RENDER GRILLE
   ============================================================ */
function renderGrid() {
    const grid = document.getElementById('boutiqueGrid');
    if (!grid) return;
    if (filteredProducts.length === 0) {
        grid.innerHTML = `<div class="boutique-empty"><div class="boutique-empty-icon">📦</div><p>${t('boutiqueNoProducts') || 'Aucun produit dans cette catégorie'}</p></div>`;
        return;
    }
    const start = (currentPage - 1) * PRODUCTS_PER_PAGE;
    const pageProducts = filteredProducts.slice(start, start + PRODUCTS_PER_PAGE);
    const user = getCurrentUser();
    const favs = Array.isArray(user?.favorites) ? user.favorites.map(normalizeProductId).filter(f => f != null) : [];
    let html = '';
    pageProducts.forEach(p => {
        const pid = normalizeProductId(p.id);
        if (pid == null) return;
        const isFav = favs.includes(pid);
        const name = escapeHTML(getProductName(p));
        const rawImg = getProductImageUrl(p);
        const img = escapeHTML(typeof rawImg === 'string' ? rawImg : '');
        const fallback = getFallbackImage(name).replace(/'/g, '%27');
        const price = p.price;
        const oldPrice = p.oldPrice;
        const stock = Number(p.stock) || 0;
        const isPromo = oldPrice && oldPrice > price;
        const discountPercent = getDiscountPercent(oldPrice, price);
        const isNew = p.isNew || false;
        const isOutOfStock = stock === 0;
        const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
        const variantBadge = hasVariants ? `<span class="badge" style="background:var(--info);color:#fff;font-size:0.6rem;padding:0.15rem 0.4rem;border-radius:30px;position:absolute;top:0.5rem;right:0.5rem;z-index:2;">⚙️</span>` : '';
        const btnHtml = hasVariants
            ? `<button class="btn-choose-options" data-slug="${escapeHTML(p.slug || '')}" style="background:var(--gold);color:#fff;border:none;padding:0.3rem 0.7rem;border-radius:30px;font-size:0.7rem;font-weight:600;cursor:pointer;">${t('chooseOptions') || 'Choisir'}</button>`
            : `<button class="btn-add-to-cart" data-id="${escapeHTML(String(pid))}">${t('addToCart') || 'Ajouter'}</button>`;
        const avgRating = p.ratingCount > 0 ? p.ratingAvg : '--';
        html += `
            <div class="product-card" data-id="${escapeHTML(String(pid))}" data-slug="${escapeHTML(p.slug || '')}">
                <div class="product-img">
                    <img src="${img}" alt="${name}" width="400" height="400" loading="lazy" onerror="this.onerror=null; this.src='${fallback}'">
                    <button class="favorite-btn ${isFav ? 'is-fav' : ''}" data-id="${escapeHTML(String(pid))}">${isFav ? '❤️' : '🤍'}</button>
                    ${variantBadge}
                    ${isOutOfStock ? `<span class="badge badge-hot">${t('outOfStock') || 'Épuisé'}</span>` : ''}
                    ${isPromo ? `<span class="badge badge-promo">-${discountPercent}%</span>` : ''}
                    ${isNew && !isOutOfStock && !isPromo ? `<span class="badge badge-new">${t('trending') || 'Nouveau'}</span>` : ''}
                </div>
                <div class="product-body">
                    <div class="p-name">${name}</div>
                    <div class="p-stats">${escapeHTML(String(avgRating))} <span style="color:var(--text-muted)">(${p.ratingCount || 0})</span></div>
                    <div class="p-footer">
                        <div class="p-price">${price} ${t('currency') || 'MAD'} ${oldPrice ? `<small>${oldPrice} ${t('currency') || 'MAD'}</small>` : ''}</div>
                        ${btnHtml}
                    </div>
                </div>
            </div>
        `;
    });

    // Bouton "Charger plus" : uniquement si filtre "Tout" et produits restants
    if (hasMoreProducts && activeCategory === 'all') {
        html += `<div style="grid-column: 1 / -1; text-align: center; margin-top: 1rem;">
            <button id="loadMoreProductsBtn" class="btn-primary" style="padding: 0.5rem 2rem;">Charger plus de produits</button>
        </div>`;
    }

    grid.innerHTML = html;
    attachGridEvents(grid);

    const loadMoreBtn = document.getElementById('loadMoreProductsBtn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', async () => {
            loadMoreBtn.disabled = true;
            loadMoreBtn.textContent = 'Chargement...';
            try {
                await loadVendorProducts(false);
                renderBoutique();
                applyCategoryFilter('all');
            } catch (err) {
                console.warn('[boutique] loadMore error:', err);
                loadMoreBtn.disabled = false;
                loadMoreBtn.textContent = 'Charger plus de produits';
            }
        });
    }
}

function attachGridEvents(grid) {
    grid.querySelectorAll('.product-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            const slug = card.dataset.slug;
            if (slug) window.location.href = `/produit?slug=${encodeURIComponent(slug)}`;
        });
    });
    grid.querySelectorAll('.btn-choose-options').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const slug = btn.dataset.slug;
            if (slug) window.location.href = `/produit?slug=${encodeURIComponent(slug)}`;
        });
    });
    grid.querySelectorAll('.btn-add-to-cart').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            const id = normalizeProductId(btn.dataset.id);
            if (id == null) return;
            try {
                const { addToCart } = await import('./cart.js');
                addToCart(id);
            } catch (err) {
                console.warn('[boutique] addToCart error:', err);
            }
        });
    });
    grid.querySelectorAll('.favorite-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            const id = normalizeProductId(btn.dataset.id);
            if (id == null) return;
            try {
                const { toggleFavorite } = await import('./products.js');
                await toggleFavorite(id);
            } catch (err) {
                console.warn('[boutique] toggleFavorite error:', err);
            }
        });
    });
}

/* ============================================================
   PAGINATION UI
   ============================================================ */
function renderPagination() {
    const container = document.getElementById('boutiquePagination');
    if (!container) return;
    const totalPages = Math.ceil(filteredProducts.length / PRODUCTS_PER_PAGE);
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }
    let html = `<div class="pagination-container" style="margin-top:2rem;"><button class="pagination-btn ${currentPage === 1 ? 'disabled' : ''}" data-page="${currentPage - 1}">‹</button>`;
    for (let i = 1; i <= totalPages; i++) {
        html += `<button class="pagination-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    html += `<button class="pagination-btn ${currentPage === totalPages ? 'disabled' : ''}" data-page="${currentPage + 1}">›</button></div>`;
    container.innerHTML = html;
    container.querySelectorAll('[data-page]').forEach(btn => {
        btn.addEventListener('click', () => {
            const page = parseInt(btn.dataset.page);
            if (isNaN(page) || page < 1 || page > totalPages) return;
            currentPage = page;
            renderGrid();
            renderPagination();
            document.getElementById('boutiqueGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}

/* ============================================================
   LISTENERS GLOBAUX
   ============================================================ */
function setupEventListeners() {
    document.querySelectorAll('.boutique-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            applyCategoryFilter(btn.dataset.category);
        });
    });
    document.getElementById('langSelect')?.addEventListener('change', () => {
        setTimeout(() => window.location.reload(), 100);
    });
}

/* ============================================================
   DÉMARRAGE
   ============================================================ */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBoutique);
} else {
    initBoutique();
}

console.log('✅ boutique.js chargé - v11.0.0 (Pagination orderBy)');