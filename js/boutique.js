/* ============================================================
   js/boutique.js
   PAGE BOUTIQUE PUBLIQUE VENDEUR - SMART SWI9A
   Version 9.0.0 - Lot 18/30 : fix showError + pending + guard

   CHANGEMENTS v9.0.0 :
     - B-BOUT-1 (P1) : showError() cache boutiqueContent au lieu
       de le rendre visible. Fini le hero vide + erreur empilés.
     - B-BOUT-2 (P2) : status 'pending' affiche le message
       "suspended" (boutique momentanément indisponible) au lieu
       de "not_found" (mensonger pour une boutique en attente).
       'rejected' reste 'not_found' (comme retirée).
     - B-BOUT-3 (P2) : meta description adaptée si 0 produit.
     - B-BOUT-4 (P2) : guard _initInProgress sur initBoutique.
     - B-BOUT-5 (P2) : safeImageUrl rejette javascript:, data:,
       tout protocole non http(s) et non relatif. Défense en
       profondeur (browsers bloquent déjà).
     - B-BOUT-6 (P2) : guard currentVendor avant renderBoutique
       et setupEventListeners.
     - JSDoc sur initBoutique et helpers.
     - Bump version 1.1.0 -> 9.0.0.

   LIMITATION CONNUE :
     La query products utilise limit(100) (MAX_PRODUCTS_PER_VENDOR).
     Un vendeur avec >100 produits n'en affiche que 100.
     Si besoin, ajouter pagination serveur (nécessitera un index
     Firestore composite - voir Lot 48).

   NOTE SÉCURITÉ (rappel) :
     Ce module lit vendorsPublic/{uid} (données publiques :
     shopName, status) et products (données publiques après
     approbation). AUCUNE lecture de users/{uid} pour éviter
     toute fuite PII (email, phone, iceCin).

   ALERTE 1 : plus aucun commentaire de ligne (//) en début de
   ligne utile. Tout est en bloc.
   ============================================================ */

import {
    doc, getDoc, collection, query, where, getDocs, limit
} from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG, VENDOR_STATUS, PRODUCT_STATUS, getCategoryById } from "./config.js";
import {
    t, escapeHTML, getProductName, getProductImageUrl, getFallbackImage,
    getDiscountPercent, toDate
} from "./utils.js";
import { getCurrentUser } from "./auth.js";

/* ============================================================
   HELPERS LOCAUX
   ============================================================ */

/**
 * Normalise un ID produit :
 * - "42" (chaîne numérique) -> 42 (compat favoris/reviews)
 * - "abc123" (auto-ID Firestore) -> "abc123" (produits vendeurs)
 * - null/undefined/"" -> null
 */
function normalizeProductId(id) {
    if (id == null || id === '') return null;
    const n = Number(id);
    return Number.isFinite(n) && String(n) === String(id) ? n : String(id);
}

/**
 * Retourne une URL d'image sûre ou '' si invalide.
 * B-BOUT-5 : rejette javascript:, data:, et tout protocole
 * non http(s). Accepte les chemins absolus (/...).
 */
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
const MAX_PRODUCTS_PER_VENDOR = 100;

/* B-BOUT-4 : guard concurrent. */
let _initInProgress = false;

/* ============================================================
   INIT
   ============================================================ */

/**
 * Point d'entrée : charge le vendeur + ses produits, puis render.
 * B-BOUT-4 : guard concurrent.
 * @returns {Promise<void>}
 */
async function initBoutique() {
    /* B-BOUT-4 : guard concurrent. */
    if (_initInProgress) {
        console.log('[boutique] Init déjà en cours - skip');
        return;
    }

    const params = new URLSearchParams(window.location.search);
    const vendorUid = params.get('v');

    if (!vendorUid) {
        showError('not_found');
        return;
    }

    _initInProgress = true;

    try {
        /* 1. Lire vendorsPublic (aucune PII). */
        const vendorSnap = await getDoc(doc(db, "vendorsPublic", vendorUid));
        if (!vendorSnap.exists()) {
            showError('not_found');
            return;
        }

        const vendorPublic = vendorSnap.data() || {};
        const status = vendorPublic.status;

        /* 2. Vérifier statut. */
        if (status !== VENDOR_STATUS.APPROVED) {
            /* B-BOUT-2 : pending -> "indisponible" (honnête),
               rejected -> "not_found" (comme retirée),
               suspended -> "suspended". */
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

        /* 3. Charger les produits approuvés du vendeur. */
        const productsSnap = await getDocs(query(
            collection(db, "products"),
            where("vendorId", "==", vendorUid),
            where("status", "==", PRODUCT_STATUS.APPROVED),
            limit(MAX_PRODUCTS_PER_VENDOR)
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

        if (vendorProducts.length >= MAX_PRODUCTS_PER_VENDOR) {
            console.warn(
                `[boutique] Limite de ${MAX_PRODUCTS_PER_VENDOR} produits atteinte. ` +
                `Certains produits du vendeur ne sont pas affichés.`
            );
        }

        /* 4. Guard B-BOUT-6 : currentVendor non null avant render. */
        if (!currentVendor) {
            console.error('[boutique] currentVendor null après chargement - abandon');
            showError('error');
            return;
        }

        /* 5. Afficher. */
        renderBoutique();
        setupEventListeners();
        applyCategoryFilter('all');

        /* 6. SEO dynamique. */
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
   AFFICHAGE ERREUR / LOADING
   ============================================================ */

/**
 * Affiche le loader ou le contenu (mutuellement exclusifs).
 * @param {boolean} show - true = loader, false = contenu
 */
function toggleLoading(show) {
    const loadingEl = document.getElementById('boutiqueLoading');
    const contentEl = document.getElementById('boutiqueContent');
    if (loadingEl) loadingEl.style.display = show ? '' : 'none';
    if (contentEl) contentEl.style.display = show ? 'none' : 'block';
}

/**
 * Affiche l'erreur et cache le contenu.
 * B-BOUT-1 : plus de content vide affiché en plus de l'erreur.
 * @param {'not_found'|'suspended'|'error'} type
 */
function showError(type) {
    const loadingEl = document.getElementById('boutiqueLoading');
    const contentEl = document.getElementById('boutiqueContent');
    const errorEl = document.getElementById('boutiqueError');
    const titleEl = document.getElementById('boutiqueErrorTitle');
    const textEl = document.getElementById('boutiqueErrorText');

    /* B-BOUT-1 : on cache le contenu (ne PAS le rendre visible). */
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

    /* B-BOUT-3 : description adaptée si 0 produit. */
    const description = count > 0
        ? `Découvrez les ${count} produits de la boutique ${name} sur Smart Swi9a. Livraison 24-72h, paiement à la livraison.`
        : `Découvrez la boutique ${name} sur Smart Swi9a. Livraison 24-72h, paiement à la livraison.`;

    const url = `${CONFIG.SHOP.URL}/boutique.html?v=${encodeURIComponent(currentVendor.uid)}`;

    document.title = `${name} | Smart Swi9a`;

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
   RENDER : EN-TÊTE
   ============================================================ */
function renderBoutique() {
    /* B-BOUT-6 : guard défensif. */
    if (!currentVendor) {
        console.error('[boutique] renderBoutique sans currentVendor');
        return;
    }

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
            avgRating = (
                productsWithRating.reduce((sum, p) => sum + p.ratingAvg, 0) / productsWithRating.length
            ).toFixed(1);
        }

        let metaHtml = `
            <span class="boutique-verified-badge">
                ${t('boutiqueVerified') || 'Boutique vérifiée'}
            </span>
            <span class="boutique-meta-item">
                ${productCount} ${productCount > 1 ? (t('items') || 'produits') : (t('cartItemSingular') || 'produit')}
            </span>
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

    /* Pas de filtres si aucun produit. */
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

    let html = `<button class="boutique-filter-btn active" data-category="all">
        ${t('filterAll') || 'Tout'} (${vendorProducts.length})
    </button>`;

    [...categories.values()].forEach(cat => {
        html += `
            <button class="boutique-filter-btn" data-category="${escapeHTML(cat.id)}">
                ${cat.emoji} ${escapeHTML(cat.label)} (${cat.count})
            </button>
        `;
    });

    container.innerHTML = html;
}

/* ============================================================
   FILTRER PAR CATÉGORIE
   ============================================================ */
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
   RENDER GRILLE PRODUITS
   ============================================================ */
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
        ? user.favorites.map(normalizeProductId).filter(f => f != null)
        : [];

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
        const variantBadge = hasVariants
            ? `<span class="badge" style="background:var(--info);color:#fff;font-size:0.6rem;padding:0.15rem 0.4rem;border-radius:30px;position:absolute;top:0.5rem;right:0.5rem;z-index:2;">⚙️</span>`
            : '';

        const btnHtml = hasVariants
            ? `<button class="btn-choose-options" data-slug="${escapeHTML(p.slug || '')}" style="background:var(--gold);color:#fff;border:none;padding:0.3rem 0.7rem;border-radius:30px;font-size:0.7rem;font-weight:600;cursor:pointer;">${t('chooseOptions') || 'Choisir'}</button>`
            : `<button class="btn-add-to-cart" data-id="${escapeHTML(String(pid))}">${t('addToCart') || 'Ajouter'}</button>`;

        const avgRating = p.ratingCount > 0 ? p.ratingAvg : '--';

        html += `
            <div class="product-card" data-id="${escapeHTML(String(pid))}" data-slug="${escapeHTML(p.slug || '')}">
                <div class="product-img">
                    <img src="${img}" alt="${name}" loading="lazy" onerror="this.onerror=null; this.src='${fallback}'">
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

    grid.innerHTML = html;
    attachGridEvents(grid);
}

/* ============================================================
   ÉVÉNEMENTS GRILLE
   ============================================================ */
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
            e.preventDefault();
            e.stopPropagation();
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
   PAGINATION
   ============================================================ */
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

console.log('✅ boutique.js chargé - v9.0.0 (Lot 18 : fix showError + pending + guard)');