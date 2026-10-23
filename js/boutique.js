// js/boutique.js
// ============================================================
// PAGE BOUTIQUE PUBLIQUE VENDEUR - SMART SWI9A
// Version 1.0.0 — Affiche uniquement les produits d'un vendeur
// ============================================================

import { doc, getDoc, collection, query, where, getDocs } from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG, VENDOR_STATUS, PRODUCT_STATUS, getCategoryById } from "./config.js";
import {
    t, escapeHTML, getProductName, getProductImageUrl, getFallbackImage,
    getDiscountPercent, toDate
} from "./utils.js";
import { getCurrentUser } from "./auth.js";

// ============================================================
// ÉTAT LOCAL
// ============================================================
let currentVendor = null;
let vendorProducts = [];
let filteredProducts = [];
let activeCategory = 'all';
let currentPage = 1;
const PRODUCTS_PER_PAGE = 12;

// ============================================================
// INIT
// ============================================================
async function initBoutique() {
    const params = new URLSearchParams(window.location.search);
    const vendorUid = params.get('v');

    if (!vendorUid) {
        showError('not_found');
        return;
    }

    try {
        // 1. Charger le vendeur
        const vendorSnap = await getDoc(doc(db, "users", vendorUid));
        if (!vendorSnap.exists()) {
            showError('not_found');
            return;
        }

        const vendorData = vendorSnap.data();
        if (vendorData.role !== 'vendor') {
            showError('not_found');
            return;
        }

        const vendorInfo = vendorData.vendorInfo || {};

        // 2. Vérifier le statut du vendeur
        if (vendorInfo.status !== VENDOR_STATUS.APPROVED) {
            if (vendorInfo.status === VENDOR_STATUS.SUSPENDED) {
                showError('suspended');
            } else {
                showError('not_found');
            }
            return;
        }

        currentVendor = {
            uid: vendorUid,
            shopName: vendorInfo.shopName || vendorData.name || 'Boutique',
            description: vendorInfo.description || '',
            status: vendorInfo.status,
            createdAt: toDate(vendorData.createdAt)
        };

        // 3. Charger les produits approuvés du vendeur
        const productsSnap = await getDocs(query(
            collection(db, "products"),
            where("vendorId", "==", vendorUid),
            where("status", "==", PRODUCT_STATUS.APPROVED)
        ));

        vendorProducts = productsSnap.docs.map(d => {
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

        // 4. Afficher
        renderBoutique();
        applyCategoryFilter('all');
        setupEventListeners();

        // SEO dynamique
        document.title = `${currentVendor.shopName} | Smart Swi9a`;
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
            metaDesc.setAttribute('content',
                `Découvrez les ${vendorProducts.length} produits de la boutique ${currentVendor.shopName} sur Smart Swi9a. Livraison 24-72h, paiement à la livraison.`
            );
        }

        document.getElementById('boutiqueLoading').style.display = 'none';
        document.getElementById('boutiqueContent').style.display = 'block';

    } catch (e) {
        console.error('❌ Erreur chargement boutique :', e);
        showError('error');
    }
}

// ============================================================
// AFFICHAGE ERREUR
// ============================================================
function showError(type) {
    document.getElementById('boutiqueLoading').style.display = 'none';

    const errorEl = document.getElementById('boutiqueError');
    const titleEl = document.getElementById('boutiqueErrorTitle');
    const textEl = document.getElementById('boutiqueErrorText');

    if (type === 'suspended') {
        titleEl.textContent = t('boutiqueSuspended') || 'Boutique momentanément indisponible';
        textEl.textContent = t('boutiqueSuspendedText') || 'Cette boutique n\'est pas disponible pour le moment. Réessayez plus tard.';
    } else if (type === 'error') {
        titleEl.textContent = t('error') || 'Erreur';
        textEl.textContent = t('loadingError') || 'Impossible de charger la boutique.';
    } else {
        titleEl.textContent = t('boutiqueNotFound') || 'Boutique introuvable';
        textEl.textContent = t('boutiqueNotFoundText') || 'Cette boutique n\'existe pas ou a été retirée.';
    }

    errorEl.style.display = 'block';
}

// ============================================================
// RENDER : EN-TÊTE
// ============================================================
function renderBoutique() {
    document.getElementById('boutiqueName').textContent = currentVendor.shopName;
    document.getElementById('boutiqueBreadcrumbCurrent').textContent = currentVendor.shopName;

    const initial = currentVendor.shopName.charAt(0).toUpperCase();
    document.getElementById('boutiqueAvatar').textContent = initial;

    const meta = document.getElementById('boutiqueMeta');
    const productCount = vendorProducts.length;

    const productsWithRating = vendorProducts.filter(p => p.ratingCount > 0);
    let avgRating = null;
    if (productsWithRating.length > 0) {
        avgRating = (
            productsWithRating.reduce((sum, p) => sum + p.ratingAvg, 0) / productsWithRating.length
        ).toFixed(1);
    }

    let metaHtml = `
        <span class="boutique-verified-badge">
            ✅ ${t('boutiqueVerified') || 'Boutique vérifiée'}
        </span>
        <span class="boutique-meta-item">
            📦 ${productCount} ${productCount > 1 ? (t('items') || 'produits') : (t('cartItemSingular') || 'produit')}
        </span>
    `;
    if (avgRating) {
        metaHtml += `<span class="boutique-meta-item">⭐ ${avgRating} / 5</span>`;
    }
    meta.innerHTML = metaHtml;

    const desc = document.getElementById('boutiqueDesc');
    if (currentVendor.description) {
        desc.textContent = currentVendor.description;
    } else {
        desc.style.display = 'none';
    }

    renderFilters();
}

// ============================================================
// FILTRES CATÉGORIES
// ============================================================
function renderFilters() {
    const container = document.getElementById('boutiqueFilters');
    if (!container) return;

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
        return;
    }

    let html = `<button class="boutique-filter-btn active" data-category="all">
        🛍️ ${t('filterAll') || 'Tout'} (${vendorProducts.length})
    </button>`;

    [...categories.values()].forEach(cat => {
        html += `
            <button class="boutique-filter-btn" data-category="${cat.id}">
                ${cat.emoji} ${cat.label} (${cat.count})
            </button>
        `;
    });

    container.innerHTML = html;
}

// ============================================================
// FILTRER PAR CATÉGORIE
// ============================================================
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

// ============================================================
// RENDER GRILLE PRODUITS
// ============================================================
function renderGrid() {
    const grid = document.getElementById('boutiqueGrid');
    if (!grid) return;

    if (filteredProducts.length === 0) {
        grid.innerHTML = `
            <div class="boutique-empty">
                <div class="boutique-empty-icon">📦</div>
                <p>${t('boutiqueNoProducts') || 'Aucun produit dans cette catégorie'}</p>
            </div>
        `;
        return;
    }

    const start = (currentPage - 1) * PRODUCTS_PER_PAGE;
    const pageProducts = filteredProducts.slice(start, start + PRODUCTS_PER_PAGE);

    const user = getCurrentUser();
    const favs = Array.isArray(user?.favorites)
        ? user.favorites.map(Number).filter(Number.isFinite)
        : [];

    let html = '';
    pageProducts.forEach(p => {
        const pid = Number(p.id);
        const isFav = favs.includes(pid);
        const name = escapeHTML(getProductName(p));
        const img = getProductImageUrl(p);
        const price = p.price;
        const oldPrice = p.oldPrice;
        const stock = Number(p.stock) || 0;
        const isPromo = oldPrice && oldPrice > price;
        const discountPercent = getDiscountPercent(oldPrice, price);
        const isNew = p.isNew || false;
        const isOutOfStock = stock === 0;

        const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
        const variantBadge = hasVariants
            ? `<span class="badge" style="background:var(--info);color:#fff;font-size:0.6rem;padding:0.15rem 0.4rem;border-radius:30px;position:absolute;top:0.5rem;right:0.5rem;z-index:2;">⚙️</span>`
            : '';

        const btnHtml = hasVariants
            ? `<button class="btn-choose-options" data-slug="${escapeHTML(p.slug || '')}" style="background:var(--gold);color:#fff;border:none;padding:0.3rem 0.7rem;border-radius:30px;font-size:0.7rem;font-weight:600;cursor:pointer;">⚙️ ${t('chooseOptions') || 'Choisir'}</button>`
            : `<button class="btn-add-to-cart" data-id="${pid}">🛒 ${t('addToCart') || 'Ajouter'}</button>`;

        const avgRating = p.ratingCount > 0 ? p.ratingAvg : '--';

        html += `
            <div class="product-card" data-id="${pid}" data-slug="${escapeHTML(p.slug || '')}">
                <div class="product-img">
                    <img src="${img}" alt="${name}" loading="lazy" onerror="this.onerror=null; this.src='${getFallbackImage(name)}'">
                    <button class="favorite-btn ${isFav ? 'is-fav' : ''}" data-id="${pid}">${isFav ? '❤️' : '🤍'}</button>
                    ${variantBadge}
                    ${isOutOfStock ? `<span class="badge badge-hot">${t('outOfStock') || 'Épuisé'}</span>` : ''}
                    ${isPromo ? `<span class="badge badge-promo">-${discountPercent}%</span>` : ''}
                    ${isNew && !isOutOfStock && !isPromo ? `<span class="badge badge-new">${t('trending') || 'Nouveau'}</span>` : ''}
                </div>
                <div class="product-body">
                    <div class="p-name">${name}</div>
                    <div class="p-stats">⭐ ${avgRating} <span style="color:var(--text-muted)">(${p.ratingCount || 0})</span></div>
                    <div class="p-footer">
                        <div class="p-price">${price} ${t('currency') || 'MAD'} ${oldPrice ? `<small>${oldPrice} ${t('currency') || 'MAD'}</small>` : ''}</div>
                        ${btnHtml}
                    </div>
                </div>
            </div>
        `;
    });

    grid.innerHTML = html;
    attachGridEvents(grid);
}

// ============================================================
// ÉVÉNEMENTS GRILLE
// ============================================================
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
            e.preventDefault();
            e.stopPropagation();
            const slug = btn.dataset.slug;
            if (slug) window.location.href = `/produit?slug=${encodeURIComponent(slug)}`;
        });
    });

    grid.querySelectorAll('.btn-add-to-cart').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = parseInt(btn.dataset.id);
            if (!isNaN(id)) {
                try {
                    const { addToCart } = await import('./cart.js');
                    addToCart(id);
                } catch (err) {
                    console.warn('⚠️ addToCart error:', err);
                }
            }
        });
    });

    grid.querySelectorAll('.favorite-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = parseInt(btn.dataset.id);
            if (!isNaN(id)) {
                try {
                    const { toggleFavorite } = await import('./products.js');
                    await toggleFavorite(id);
                } catch (err) {
                    console.warn('⚠️ toggleFavorite error:', err);
                }
            }
        });
    });
}

// ============================================================
// PAGINATION
// ============================================================
function renderPagination() {
    const container = document.getElementById('boutiquePagination');
    if (!container) return;

    const totalPages = Math.ceil(filteredProducts.length / PRODUCTS_PER_PAGE);
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }

    let html = `
        <div class="pagination-container" style="margin-top:2rem;">
            <button class="pagination-btn ${currentPage === 1 ? 'disabled' : ''}" data-page="${currentPage - 1}">‹</button>
    `;

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

// ============================================================
// LISTENERS GLOBAUX
// ============================================================
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

// ============================================================
// DÉMARRAGE
// ============================================================
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBoutique);
} else {
    initBoutique();
}

console.log('✅ boutique.js chargé — v1.0.0');