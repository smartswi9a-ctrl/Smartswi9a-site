// js/product-detail.js
// ============================================================
// PAGE PRODUIT DYNAMIQUE - SMART SWI9A
// Version 3.1.0 — Breadcrumb complet + produits similaires parent-aware
// ============================================================
// CHANGEMENTS v3.1.0 :
// ✅ FIX #6 — renderRelatedProducts() : parent-aware (siblings inclus)
// ✅ FIX #7 — renderBreadcrumbs() : hiérarchie complète
//              Accueil › Électronique › Smartphones › Produit
// ✅ FIX #20 — Breadcrumb : fallback legacy via getCategoryPath
// ✅ (Repris v3.0.0) — C7.1→C7.3, I7.1→I7.5, M7.1→M7.6
// ============================================================

import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "./firebase.js";
import {
    CONFIG, VIDEO_BASE_URL,
    getCategoryPath, getCategoryById, getParentCategory, normalizeCategory
} from "./config.js";
import {
    t, escapeHTML, getProductName, getProductDesc, getProductFeatures,
    getProductImageUrl, getFallbackImage, renderStars,
    getDiscountPercent
} from "./utils.js";
import { getProducts } from "./store.js";
import { getCurrentUser } from "./auth.js";
import { toggleFavorite } from "./products.js";
import { createReview, canUserReviewProduct, toggleLike } from "./reviews.js";
import { addToCart } from "./cart.js";
import { showToast, openImageLightbox } from "./ui-core.js";

// ============================================================
// ÉTAT LOCAL
// ============================================================
let currentProduct = null;
let currentVideoElement = null;

let selectedSize = null;
let selectedColor = null;
let currentVariant = null;

let _relatedProductsCache = null;
let _relatedForProductId = null;

// ============================================================
// LECTURE DU SLUG
// ============================================================
function getSlugFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('slug');
}

// ============================================================
// RENDU PRINCIPAL
// ============================================================
export async function renderProductDetail() {
    const mainEl = document.querySelector('main[data-product-page]');
    if (!mainEl) return;

    const slug = getSlugFromUrl();

    if (!slug) {
        renderNotFound(mainEl);
        return;
    }

    let products = getProducts();
    if (!products || products.length === 0) {
        try {
            const { getProductsLoadedPromise } = await import("./store.js");
            const promise = getProductsLoadedPromise();
            if (promise) {
                await promise;
                products = getProducts();
            }
        } catch (e) {
            console.warn('⚠️ Attente produits échouée :', e);
        }
    }

    const product = products.find(p => p.slug === slug);
    if (!product) {
        renderNotFound(mainEl);
        return;
    }

    currentProduct = product;
    selectedSize = null;
    selectedColor = null;
    currentVariant = null;
    _relatedProductsCache = null;
    _relatedForProductId = null;

    document.title = `${getProductName(product)} | Smart Swi9a`;

    updateMetaTags(product);
    renderBreadcrumbs(product);
    renderMediaGallery(product);
    renderInfoSection(product);
    renderVariantsSection(product);
    renderDimensions(product);
    renderFeaturesSection(product);
    await renderReviewsSection(product);
    renderRelatedProducts(product);

    attachProductEvents(product);
}

// ============================================================
// PRODUIT NON TROUVÉ
// ============================================================
function renderNotFound(mainEl) {
    mainEl.innerHTML = `
        <div style="text-align:center;padding:4rem 1rem;">
            <div style="font-size:4rem;margin-bottom:1rem;">🔍</div>
            <h1 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:1rem;">${t('productNotFound')}</h1>
            <p style="color:var(--text-muted);margin-bottom:2rem;">${t('noProductsFound')}</p>
            <a href="/" class="btn-primary">← ${t('productBreadcrumbHome')}</a>
        </div>
    `;
}

// ============================================================
// META TAGS DYNAMIQUES (SEO)
// ============================================================
function updateMetaTags(product) {
    const name = getProductName(product);
    const desc = getProductDesc(product);
    const img = getProductImageUrl(product);
    const url = window.location.href;

    setMeta('name', 'description', desc.substring(0, 160));
    setMeta('property', 'og:title', name);
    setMeta('property', 'og:description', desc.substring(0, 200));
    setMeta('property', 'og:image', img.startsWith('http') ? img : `${CONFIG.SHOP.URL}${img}`);
    setMeta('property', 'og:url', url);
    setMeta('property', 'og:type', 'product');
    setMeta('property', 'product:price:amount', String(product.price || 0));
    setMeta('property', 'product:price:currency', 'MAD');
    setMeta('name', 'twitter:card', 'summary_large_image');
    setMeta('name', 'twitter:title', name);
    setMeta('name', 'twitter:image', img.startsWith('http') ? img : `${CONFIG.SHOP.URL}${img}`);

    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
        canonical = document.createElement('link');
        canonical.rel = 'canonical';
        document.head.appendChild(canonical);
    }
    canonical.href = url;

    const schemaId = 'product-schema-ld';
    let schemaEl = document.getElementById(schemaId);
    if (!schemaEl) {
        schemaEl = document.createElement('script');
        schemaEl.id = schemaId;
        schemaEl.type = 'application/ld+json';
        document.head.appendChild(schemaEl);
    }

    const price = Number(product.price) || 0;
    const schema = {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": name,
        "description": desc,
        "image": img.startsWith('http') ? img : `${CONFIG.SHOP.URL}${img}`,
        "brand": { "@type": "Brand", "name": "Smart Swi9a" }
    };

    if (price > 0) {
        schema.offers = {
            "@type": "Offer",
            "price": price,
            "priceCurrency": "MAD",
            "availability": (Number(product.stock) || 0) > 0
                ? "https://schema.org/InStock"
                : "https://schema.org/OutOfStock",
            "url": url
        };
    }

    if (product.ratingAvg && Number(product.ratingAvg) > 0) {
        schema.aggregateRating = {
            "@type": "AggregateRating",
            "ratingValue": Number(product.ratingAvg),
            "reviewCount": Number(product.ratingCount) || 1
        };
    }

    schemaEl.textContent = JSON.stringify(schema);
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

// ============================================================
// ✅ FIX #7 + #20 : BREADCRUMBS COMPLET (avec catégories)
// ------------------------------------------------------------
// AVANT : Accueil › Produits › Produit
// APRÈS : Accueil › Électronique › Smartphones › Produit
// Gère legacy : produit 'smartphone' → breadcrumb 'Électronique › Smartphones'
// ============================================================
function renderBreadcrumbs(product) {
    const el = document.getElementById('breadcrumbs');
    if (!el) return;

    // Construire le chemin de catégories
    const catPath = getCategoryPath(product.category);

    // Construire les items du breadcrumb
    const items = [
        {
            name: t('productBreadcrumbHome'),
            url: CONFIG.SHOP.URL,
            isLink: true
        }
    ];

    // Ajouter les catégories (parents puis enfants)
    catPath.forEach(cat => {
        const label = t(cat.label);
        const url = `${CONFIG.SHOP.URL}/#produits?cat=${cat.id}`;
        items.push({
            name: `${cat.emoji || ''} ${label}`.trim(),
            url: url,
            isLink: true,
            isCategory: true,
            categoryId: cat.id
        });
    });

    // Si aucune catégorie n'est trouvée, fallback "Produits"
    if (catPath.length === 0) {
        items.push({
            name: t('productBreadcrumbProducts'),
            url: `${CONFIG.SHOP.URL}/#produits`,
            isLink: true
        });
    }

    // Ajouter le produit final (non cliquable)
    items.push({
        name: getProductName(product),
        url: window.location.href,
        isLink: false
    });

    // Schema.org BreadcrumbList
    const breadcrumbSchema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": items.map((item, idx) => ({
            "@type": "ListItem",
            "position": idx + 1,
            "name": item.name,
            ...(item.isLink ? { "item": item.url } : {})
        }))
    };

    let schemaEl = document.getElementById('breadcrumb-schema');
    if (!schemaEl) {
        schemaEl = document.createElement('script');
        schemaEl.id = 'breadcrumb-schema';
        schemaEl.type = 'application/ld+json';
        document.head.appendChild(schemaEl);
    }
    schemaEl.textContent = JSON.stringify(breadcrumbSchema);

    // Rendu HTML
    const sep = ' <span style="color:var(--text-dim);margin:0 0.2rem;">›</span> ';
    const htmlParts = items.map(item => {
        if (item.isLink) {
            return `<a href="${escapeHTML(item.url)}" style="color:var(--gold);text-decoration:none;">${escapeHTML(item.name)}</a>`;
        } else {
            return `<span style="color:var(--text-muted);">${escapeHTML(item.name)}</span>`;
        }
    });

    el.innerHTML = htmlParts.join(sep);

    // Met à jour le breadcrumbCurrent (ancien element, garde compatibilité)
    const currentSpan = document.getElementById('breadcrumbCurrent');
    if (currentSpan) {
        currentSpan.textContent = getProductName(product);
        currentSpan.removeAttribute('data-key');
    }
}

// ============================================================
// SECTION GALERIE MÉDIA (Images + Vidéo unifiées)
// ============================================================
function renderMediaGallery(product) {
    const wrapper = document.getElementById('mainMediaWrapper');
    const galleryContainer = document.getElementById('galleryThumbnails');
    if (!wrapper || !galleryContainer) return;

    const mainImageUrl = getProductImageUrl(product);
    galleryContainer.innerHTML = '';

    if (currentVideoElement) {
        currentVideoElement.pause();
        currentVideoElement = null;
    }
    wrapper.innerHTML = '';

    const showImage = (src, activeThumb) => {
        if (currentVideoElement) {
            currentVideoElement.pause();
            currentVideoElement = null;
        }
        wrapper.innerHTML = `
            <img id="mainImage" class="main-media-element" src="${escapeHTML(src)}" alt="${escapeHTML(getProductName(product))}" loading="eager">
        `;
        const newMainImg = document.getElementById('mainImage');
        newMainImg.addEventListener('click', () => openImageLightbox(newMainImg.src));
        galleryContainer.querySelectorAll('.thumb-img, .thumb-video').forEach(el => el.classList.remove('active'));
        if (activeThumb) activeThumb.classList.add('active');
    };

    const showVideo = (videoUrl, activeThumb) => {
        wrapper.innerHTML = `
            <video id="mainVideo" class="main-media-element" src="${escapeHTML(videoUrl)}" controls preload="metadata" playsinline poster="${escapeHTML(mainImageUrl)}" style="background: #000;"></video>
        `;
        currentVideoElement = document.getElementById('mainVideo');
        galleryContainer.querySelectorAll('.thumb-img, .thumb-video').forEach(el => el.classList.remove('active'));
        if (activeThumb) activeThumb.classList.add('active');
    };

    const images = (product.gallery && product.gallery.length > 0)
        ? [product.img, ...product.gallery]
        : [product.img];

    let firstImageThumb = null;

    images.forEach((imgUrl, index) => {
        if (!imgUrl) return;
        const thumb = document.createElement('img');
        thumb.className = 'thumb-img';
        thumb.src = (imgUrl.startsWith('http') || imgUrl.startsWith('/')) ? imgUrl : '/' + imgUrl;
        thumb.alt = `${getProductName(product)} - ${index + 1}`;
        thumb.loading = 'lazy';
        thumb.addEventListener('click', () => showImage(thumb.src, thumb));
        if (index === 0) firstImageThumb = thumb;
        galleryContainer.appendChild(thumb);
    });

    const hasVideo = typeof product.video === 'string' && product.video.trim() !== '';
    let videoThumb = null;

    if (hasVideo) {
        const baseUrl = VIDEO_BASE_URL.endsWith('/') ? VIDEO_BASE_URL : VIDEO_BASE_URL + '/';
        const videoUrl = baseUrl + product.video.trim();

        videoThumb = document.createElement('div');
        videoThumb.className = 'thumb-video';
        videoThumb.innerHTML = `
            <img src="${escapeHTML(mainImageUrl)}" style="filter: brightness(0.5);">
            <div class="play-icon-overlay">
                <div>
                    <svg viewBox="0 0 24 24" fill="white" width="14" height="14" style="margin-left: 2px;"><path d="M8 5v14l11-7z"/></svg>
                </div>
            </div>
        `;
        videoThumb.addEventListener('click', () => showVideo(videoUrl, videoThumb));

        galleryContainer.insertBefore(videoThumb, galleryContainer.firstChild);
        showVideo(videoUrl, videoThumb);
        if (firstImageThumb) firstImageThumb.classList.remove('active');
    } else {
        showImage(mainImageUrl, firstImageThumb);
    }
}

// ============================================================
// SECTION INFO (Prix, Stock, Boutons)
// ============================================================
function renderInfoSection(product) {
    const titleEl = document.getElementById('productTitleEl');
    const priceEl = document.getElementById('productPrice');
    const oldPriceEl = document.getElementById('productOldPrice');
    const descEl = document.getElementById('productDescEl');
    const stockEl = document.getElementById('productStockStatus');
    const stock = Number(product.stock) || 0;
    const discountPercent = getDiscountPercent(product.oldPrice, product.price);
    const isPromo = discountPercent > 0;
    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;

    if (titleEl) {
        titleEl.textContent = getProductName(product);
        titleEl.removeAttribute('data-key');
    }

    if (priceEl) priceEl.textContent = `${product.price} ${t('currency')}`;

    if (oldPriceEl) {
        if (isPromo && !hasVariants) {
            oldPriceEl.textContent = `${product.oldPrice} ${t('currency')}`;
            oldPriceEl.style.display = 'inline-block';
        } else {
            oldPriceEl.style.display = 'none';
        }
    }

    if (descEl) descEl.textContent = getProductDesc(product);

    const priceBlock = document.querySelector('.product-price-block');
    if (priceBlock) {
        const existing = priceBlock.querySelector('.discount-badge');
        if (existing) existing.remove();
        if (isPromo && !hasVariants) {
            const badge = document.createElement('span');
            badge.className = 'discount-badge';
            badge.style.cssText = 'background:var(--danger);color:white;padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;';
            badge.textContent = `-${discountPercent}%`;
            priceBlock.appendChild(badge);
        }
    }

    if (stockEl) {
        if (stock > 0) {
            stockEl.innerHTML = `<span style="color:#22c55e;">${t('productInStock')}</span>`;
        } else {
            stockEl.innerHTML = `<span style="color:#b03a2e;">${t('productOutOfStock')}</span>`;
        }
    }

    const addBtn = document.getElementById('addToCartBtn');
    if (addBtn) {
        addBtn.dataset.id = product.id;
        if (stock === 0 && !hasVariants) {
            addBtn.disabled = true;
            addBtn.style.opacity = '0.5';
            addBtn.style.cursor = 'not-allowed';
        } else {
            addBtn.disabled = false;
            addBtn.style.opacity = '1';
            addBtn.style.cursor = 'pointer';
        }
    }
}

// ============================================================
// SECTION DES VARIANTES
// ============================================================
function renderVariantsSection(product) {
    const root = document.getElementById('productVariantsRoot');
    if (!root) return;

    if (!product.variants || product.variants.length === 0) {
        root.innerHTML = '';
        return;
    }

    const sizes = [...new Set(product.variants.map(v => v.size).filter(Boolean))];
    const colors = [...new Set(product.variants.map(v => v.color).filter(Boolean))];

    let html = '';

    const hasRealSizeGuideData = !!(product.hasSizeGuide && product.sizeGuideData);
    const guideBtnHtml = hasRealSizeGuideData
        ? `<button class="size-guide-btn" id="openSizeGuideBtn">📏 Guide des tailles</button>`
        : '';

    if (sizes.length > 0) {
        html += `
            <div class="variant-options-group">
                <div class="variant-label">
                    <span>${t('comboSize') || 'Taille'} : <span id="selectedSizeLabel" style="color:var(--gold);">Sélectionnez</span></span>
                    ${guideBtnHtml}
                </div>
                <div class="variant-buttons" id="sizeButtons">
                    ${sizes.map(s => `<button type="button" class="variant-btn" data-size="${escapeHTML(s)}">${escapeHTML(s)}</button>`).join('')}
                </div>
            </div>
        `;
    }

    if (colors.length > 0) {
        html += `
            <div class="variant-options-group">
                <div class="variant-label">
                    <span>${t('comboColor') || 'Couleur'} : <span id="selectedColorLabel" style="color:var(--gold);">Sélectionnez</span></span>
                </div>
                <div class="variant-buttons" id="colorButtons">
                    ${colors.map(c => `<button type="button" class="variant-btn" data-color="${escapeHTML(c)}">${escapeHTML(c)}</button>`).join('')}
                </div>
            </div>
        `;
    }

    root.innerHTML = html;

    if (guideBtnHtml) {
        document.getElementById('openSizeGuideBtn')?.addEventListener('click', openSizeGuideModal);
    }

    document.querySelectorAll('#sizeButtons .variant-btn').forEach(btn => {
        btn.addEventListener('click', () => selectVariantOption('size', btn.dataset.size));
    });

    document.querySelectorAll('#colorButtons .variant-btn').forEach(btn => {
        btn.addEventListener('click', () => selectVariantOption('color', btn.dataset.color));
    });

    if (sizes.length === 1) selectVariantOption('size', sizes[0]);
    if (colors.length === 1) selectVariantOption('color', colors[0]);
}

function selectVariantOption(type, value) {
    if (type === 'size') {
        selectedSize = value;
        document.getElementById('selectedSizeLabel').textContent = value;
        document.querySelectorAll('#sizeButtons .variant-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.size === value);
        });
    } else if (type === 'color') {
        selectedColor = value;
        document.getElementById('selectedColorLabel').textContent = value;
        document.querySelectorAll('#colorButtons .variant-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.color === value);
        });
    }

    const variant = currentProduct.variants.find(v => {
        const matchSize = !selectedSize || v.size === selectedSize;
        const matchColor = !selectedColor || v.color === selectedColor;
        return matchSize && matchColor;
    });

    currentVariant = variant;
    updateVariantDisplay();
}

function updateVariantDisplay() {
    const priceEl = document.getElementById('productPrice');
    const oldPriceEl = document.getElementById('productOldPrice');
    const stockEl = document.getElementById('productStockStatus');
    const addBtn = document.getElementById('addToCartBtn');

    if (oldPriceEl) oldPriceEl.style.display = 'none';
    const badge = document.querySelector('.discount-badge');
    if (badge) badge.style.display = 'none';

    if (!currentVariant) {
        const totalStock = currentProduct.variants.reduce((sum, v) => sum + (v.stock || 0), 0);
        if (selectedSize && selectedColor) {
            stockEl.innerHTML = `<span style="color:var(--danger);font-weight:700;">❌ Combinaison indisponible</span>`;
        } else if (totalStock > 0) {
            stockEl.innerHTML = `<span style="color:var(--text-muted);">👆 Sélectionnez ${!selectedSize ? 'taille' : ''}${!selectedSize && !selectedColor ? ' et ' : ''}${!selectedColor ? 'couleur' : ''}</span>`;
        } else {
            stockEl.innerHTML = `<span style="color:#b03a2e;">${t('productOutOfStock')}</span>`;
        }
        if (addBtn) {
            addBtn.disabled = true;
            addBtn.style.opacity = '0.5';
        }
        return;
    }

    if (priceEl) priceEl.textContent = `${currentVariant.price} ${t('currency')}`;

    if (currentVariant.stock > 0) {
        stockEl.innerHTML = `<span style="color:#22c55e;">${t('productInStock')} (${currentVariant.stock})</span>`;
        if (addBtn) {
            addBtn.disabled = false;
            addBtn.style.opacity = '1';
            addBtn.style.cursor = 'pointer';
        }
    } else {
        stockEl.innerHTML = `<span style="color:#b03a2e;">${t('productOutOfStock')}</span>`;
        if (addBtn) {
            addBtn.disabled = true;
            addBtn.style.opacity = '0.5';
            addBtn.style.cursor = 'not-allowed';
        }
    }
}

function openSizeGuideModal() {
    document.getElementById('sizeGuideModal')?.remove();

    const modalHtml = `
        <div class="modal-overlay open" id="sizeGuideModal" style="z-index:2000;">
            <div class="modal" style="max-width:600px;">
                <button class="modal-close" id="closeSizeGuideBtn">✕</button>
                <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:1rem;">📏 Guide des tailles</h2>
                <div style="background:var(--bg-surface);padding:1rem;border-radius:var(--radius-sm);">
                    <p style="font-size:0.85rem;color:var(--text-muted);text-align:center;">
                        Guide en cours de préparation. Contactez-nous sur WhatsApp pour toute question.
                    </p>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = document.getElementById('sizeGuideModal');
    const closeModal = () => {
        modal?.remove();
        document.removeEventListener('keydown', escHandler);
    };
    const escHandler = (e) => { if (e.key === 'Escape') closeModal(); };

    document.getElementById('closeSizeGuideBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', escHandler);
}

// ============================================================
// SECTION DES DIMENSIONS
// ============================================================
function renderDimensions(product) {
    const root = document.getElementById('productDimensionsRoot');
    if (!root) return;

    if (!product.dimensions) {
        root.innerHTML = '';
        return;
    }

    const { weight, length, width, height } = product.dimensions;

    if (!weight && !length && !width && !height) {
        root.innerHTML = '';
        return;
    }

    let html = `
        <h4 style="font-family:var(--font-secondary);color:var(--gold);margin-top:1.5rem;margin-bottom:0.5rem;font-size:1.1rem;">📏 Dimensions & Poids</h4>
        <table class="dimensions-table">
    `;

    if (weight) html += `<tr><th>Poids</th><td>${weight} g</td></tr>`;
    if (length) html += `<tr><th>Longueur</th><td>${length} cm</td></tr>`;
    if (width) html += `<tr><th>Largeur</th><td>${width} cm</td></tr>`;
    if (height) html += `<tr><th>Hauteur</th><td>${height} cm</td></tr>`;

    html += `</table>`;
    root.innerHTML = html;
}

// ============================================================
// SECTION CARACTÉRISTIQUES
// ============================================================
function renderFeaturesSection(product) {
    const el = document.getElementById('productFeaturesEl');
    if (!el) return;

    const parentDiv = document.getElementById('productFeaturesSection');
    const features = getProductFeatures(product) || [];

    if (features.length === 0) {
        if (parentDiv) parentDiv.style.display = 'none';
        el.innerHTML = '';
        return;
    }

    if (parentDiv) parentDiv.style.display = '';

    el.innerHTML = features
        .map(f => `<li><span class="feature-check">✓</span><span class="feature-text">${escapeHTML(f)}</span></li>`)
        .join('');
}

// ============================================================
// SECTION AVIS
// ============================================================
async function renderReviewsSection(product) {
    const container = document.getElementById('productReviewsRoot');
    if (!container) return;

    container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">⏳ ${t('loadingReviews')}</div>`;

    const pid = Number(product.id);
    if (!Number.isFinite(pid)) {
        container.innerHTML = `<p style="text-align:center;color:var(--danger);">${t('productNotFound')}</p>`;
        return;
    }

    try {
        const q = query(
            collection(db, "reviews"),
            where("productId", "==", pid),
            where("status", "==", "approved")
        );

        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT')), 8000)
        );
        const snapshot = await Promise.race([getDocs(q), timeout]);

        const reviews = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        reviews.sort((a, b) => {
            const da = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
            const dbb = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
            return dbb - da;
        });

        const user = getCurrentUser();
        const reviewCheck = user
            ? await canUserReviewProduct(pid).catch(() => ({ canReview: false, reason: 'error' }))
            : { canReview: false, reason: 'not_logged' };

        let html = `
            <h3 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:1rem;font-size:1.3rem;">
                ⭐ ${t('reviews')} (${reviews.length})
            </h3>
        `;

        if (reviews.length > 0) {
            const avg = (reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length).toFixed(1);
            html += `
                <div style="display:flex;align-items:center;gap:0.8rem;margin-bottom:1.5rem;padding:1rem;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);">
                    <div style="font-size:2rem;font-weight:800;color:var(--gold);">${avg}</div>
                    <div>
                        <div style="color:var(--gold);font-size:1.1rem;">${renderStars(Math.round(avg))}</div>
                        <div style="font-size:0.8rem;color:var(--text-muted);">${reviews.length} ${t('reviews').toLowerCase()}</div>
                    </div>
                </div>
            `;
        }

        if (reviews.length === 0) {
            html += `<p style="color:var(--text-muted);font-size:0.9rem;text-align:center;padding:1rem;">${t('noReviewsYet')}</p>`;
        } else {
            reviews.forEach(r => {
                const userName = escapeHTML(r.userName || 'Anonyme');
                const title = escapeHTML(r.title || '');
                const comment = escapeHTML(r.comment || '');
                const photos = r.photos || [];
                const likes = r.likes || [];
                const likeCount = likes.length;
                const isLiked = user ? likes.includes(user.uid) : false;
                const dateStr = r.createdAt?.toDate
                    ? r.createdAt.toDate().toLocaleDateString()
                    : (r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '');

                html += `
                    <div class="review-item">
                        <div class="review-header">
                            <div class="review-user-name">👤 ${userName}</div>
                            ${r.verifiedPurchase ? `<span class="review-verified-badge">✅ ${t('reviewVerifiedPurchase')}</span>` : ''}
                            <div class="review-date">${dateStr}</div>
                        </div>
                        <div class="review-stars">${renderStars(r.rating || 0)}</div>
                        ${title ? `<div class="review-title">${title}</div>` : ''}
                        <div class="review-comment">${comment}</div>
                        ${photos.length > 0 ? `
                            <div class="review-photos">
                                ${photos.map(url => `<img src="${escapeHTML(url)}" alt="${t('reviewPhotos')}" loading="lazy" data-photo-url="${escapeHTML(url)}">`).join('')}
                            </div>
                        ` : ''}
                        <button class="review-like-btn ${isLiked ? 'liked' : ''}" data-review-id="${r.id}" data-liked="${isLiked}">
                            👍 ${t('reviewHelpful')} (${likeCount})
                        </button>
                    </div>
                `;
            });
        }

        if (reviewCheck.canReview) {
            html += renderReviewForm();
        } else if (!user) {
            html += `<p style="font-size:0.85rem;color:var(--text-muted);margin-top:1rem;text-align:center;">🔒 ${t('loginRequired')}</p>`;
        } else if (reviewCheck.reason === 'not_purchased') {
            html += `<p style="font-size:0.85rem;color:var(--text-muted);margin-top:1rem;text-align:center;">🛒 ${t('reviewOnlyAfterOrder')}</p>`;
        } else if (reviewCheck.reason === 'already_reviewed') {
            html += `<p style="font-size:0.85rem;color:var(--text-muted);margin-top:1rem;text-align:center;">✅ ${t('reviewAlreadyExists')}</p>`;
        }

        container.innerHTML = html;
        attachReviewEvents(product);

    } catch (e) {
        console.error('Erreur chargement avis :', e);
        const message = e?.message === 'TIMEOUT'
            ? 'Délai dépassé. Réessayez.'
            : t('loadingError');
        container.innerHTML = `<p style="text-align:center;color:var(--danger);">${message}</p>`;
    }
}

// ============================================================
// FORMULAIRE D'AVIS
// ============================================================
function renderReviewForm() {
    return `
        <div class="review-form" style="margin-top:1.5rem;">
            <h4 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:1rem;">
                ✍️ ${t('leaveReview')}
            </h4>
            <div id="reviewFormMessage" style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem;"></div>
            <label style="display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.3rem;">${t('reviews')} *</label>
            <div class="review-star-input" id="reviewStarInput">
                <span class="star" data-star="1">★</span>
                <span class="star" data-star="2">★</span>
                <span class="star" data-star="3">★</span>
                <span class="star" data-star="4">★</span>
                <span class="star" data-star="5">★</span>
            </div>
            <label style="display:block;font-size:0.85rem;color:var(--text-muted);margin:0.5rem 0 0.3rem;">${t('reviewTitle')}</label>
            <input type="text" id="reviewTitleInput" placeholder="${t('reviewTitle')}" maxlength="80" style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text);margin-bottom:0.5rem;">
            <label style="display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.3rem;">${t('reviewComment')} *</label>
            <textarea id="reviewCommentInput" placeholder="${t('reviewComment')}" rows="3" maxlength="500" style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text);margin-bottom:0.5rem;font-family:inherit;"></textarea>
            <label style="display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.3rem;">${t('reviewPhotos')}</label>
            <input type="file" id="reviewPhotoInput" accept="image/*" multiple style="margin-bottom:0.5rem;color:var(--text);">
            <div id="reviewPhotoPreviews" class="review-photo-grid"></div>
            <button class="btn-primary" id="submitReviewBtn" style="width:100%;justify-content:center;margin-top:1rem;">
                📤 ${t('reviewSubmit')}
            </button>
        </div>
    `;
}

// ============================================================
// ÉVÉNEMENTS DES AVIS
// ============================================================
function attachReviewEvents(product) {
    const starInput = document.getElementById('reviewStarInput');
    let selectedRating = 0;
    const stars = starInput ? starInput.querySelectorAll('.star') : [];

    stars.forEach(star => {
        star.addEventListener('click', () => {
            selectedRating = parseInt(star.dataset.star);
            stars.forEach(s => {
                const val = parseInt(s.dataset.star);
                s.classList.toggle('active', val <= selectedRating);
            });
        });
    });

    const photoInput = document.getElementById('reviewPhotoInput');
    const photoPreviews = document.getElementById('reviewPhotoPreviews');
    let selectedPhotos = [];

    if (photoInput && photoPreviews) {
        photoInput.addEventListener('change', () => {
            const files = Array.from(photoInput.files).slice(0, 5);
            selectedPhotos = files;
            photoPreviews.innerHTML = '';
            files.forEach((file) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const div = document.createElement('div');
                    div.className = 'review-photo-slot';
                    div.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
                    photoPreviews.appendChild(div);
                };
                reader.readAsDataURL(file);
            });
        });
    }

    const submitBtn = document.getElementById('submitReviewBtn');
    if (submitBtn) {
        submitBtn.addEventListener('click', async () => {
            const title = document.getElementById('reviewTitleInput')?.value.trim() || '';
            const comment = document.getElementById('reviewCommentInput')?.value.trim() || '';
            const msgEl = document.getElementById('reviewFormMessage');

            if (selectedRating < 1) {
                if (msgEl) { msgEl.textContent = '⚠️ ' + t('reviews'); msgEl.style.color = 'var(--danger)'; }
                return;
            }
            if (!comment) {
                if (msgEl) { msgEl.textContent = '⚠️ ' + t('reviewComment'); msgEl.style.color = 'var(--danger)'; }
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = '⏳ ' + t('loading');
            if (msgEl) msgEl.textContent = '';

            try {
                await createReview(Number(product.id), {
                    rating: selectedRating,
                    title,
                    comment,
                    photoFiles: selectedPhotos
                });
                if (msgEl) {
                    msgEl.textContent = '✅ ' + t('reviewThanks') + ' ' + t('reviewPendingApproval');
                    msgEl.style.color = 'var(--success)';
                }
                showToast('✅ ' + t('reviewThanks'));
                document.getElementById('reviewCommentInput').value = '';
                document.getElementById('reviewTitleInput').value = '';
                selectedRating = 0;
                stars.forEach(s => s.classList.remove('active'));
                photoPreviews.innerHTML = '';
                selectedPhotos = [];
            } catch (e) {
                console.error('Erreur envoi avis :', e);
                if (msgEl) {
                    msgEl.textContent = '❌ ' + (e.message || t('error'));
                    msgEl.style.color = 'var(--danger)';
                }
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = '📤 ' + t('reviewSubmit');
            }
        });
    }

    document.querySelectorAll('.review-like-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const reviewId = btn.dataset.reviewId;
            const user = getCurrentUser();
            if (!user) {
                showToast('🔒 ' + t('loginRequired'));
                document.dispatchEvent(new CustomEvent('open-account'));
                return;
            }
            try {
                const result = await toggleLike(reviewId);
                const countMatch = btn.textContent.match(/\((\d+)\)/);
                const newCount = countMatch ? parseInt(countMatch[1]) + (result.liked ? 1 : -1) : (result.liked ? 1 : 0);
                btn.innerHTML = `👍 ${t('reviewHelpful')} (${Math.max(0, newCount)})`;
                btn.classList.toggle('liked', result.liked);
            } catch (e) {
                console.error('Erreur like :', e);
            }
        });
    });

    document.querySelectorAll('.review-photos img[data-photo-url]').forEach(img => {
        img.addEventListener('click', () => openImageLightbox(img.dataset.photoUrl));
    });
}

// ============================================================
// ✅ FIX #6 : PRODUITS SIMILAIRES (parent-aware)
// ------------------------------------------------------------
// AVANT : match exact de catégorie uniquement
//   produit 'Smartphones' → suggère que d'autres 'Smartphones'
// APRÈS :
//   1. Priorité 1 : même sous-catégorie (ex: Smartphones)
//   2. Priorité 2 : même parent, autres sous-catégories (ex: Tablettes, Audio…)
//   3. Priorité 3 : autres produits du catalogue
// ============================================================
function renderRelatedProducts(product) {
    const container = document.getElementById('relatedProductsRoot');
    if (!container) return;

    if (_relatedForProductId !== product.id || !_relatedProductsCache) {
        const all = getProducts().filter(p => p.id !== product.id);

        // Résoudre la catégorie du produit courant (avec legacy)
        const normalized = normalizeCategory(product.category);
        const catInfo = getCategoryById(normalized);
        const parentId = catInfo?.parentId || (catInfo?.isParent ? catInfo.id : null);

        // Catégorie "locale" : la sous-catégorie du produit
        const localCatId = catInfo?.isParent ? null : catInfo?.id;

        // ✅ Priorité 1 : même sous-catégorie
        const sameLocalCat = all.filter(p => {
            const pNorm = normalizeCategory(p.category);
            return localCatId && (p.category === localCatId || pNorm === localCatId);
        });

        // ✅ Priorité 2 : même parent, autres sous-catégories (siblings)
        const sameParent = parentId
            ? all.filter(p => {
                if (sameLocalCat.some(s => s.id === p.id)) return false;
                const pNorm = normalizeCategory(p.category);
                const pCat = getCategoryById(pNorm);
                return pCat && (
                    pCat.id === parentId ||
                    pCat.parentId === parentId
                );
            })
            : [];

        // ✅ Priorité 3 : le reste
        const others = all.filter(p =>
            !sameLocalCat.some(s => s.id === p.id) &&
            !sameParent.some(s => s.id === p.id)
        );

        const shuffle = (arr) => {
            const a = [...arr];
            for (let i = a.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [a[i], a[j]] = [a[j], a[i]];
            }
            return a;
        };

        // Construire avec priorité : local (3 max) + siblings (2 max) + autres (1 max)
        const prioritized = [
            ...shuffle(sameLocalCat).slice(0, 3),
            ...shuffle(sameParent).slice(0, 2),
            ...shuffle(others).slice(0, 1)
        ];

        _relatedProductsCache = prioritized.slice(0, 6);
        _relatedForProductId = product.id;
    }

    const random = _relatedProductsCache;

    if (random.length === 0) {
        container.innerHTML = '';
        return;
    }

    const user = getCurrentUser();
    const favs = Array.isArray(user?.favorites) ? user.favorites.map(Number) : [];

    let html = `<h4 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:1rem;font-size:1.2rem;">${t('productRelatedTitle')}</h4>`;
    html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem;">`;

    random.forEach(p => {
        const pid = Number(p.id);
        if (!Number.isFinite(pid)) return;

        const isFav = favs.includes(pid);
        const name = escapeHTML(getProductName(p));
        const img = getProductImageUrl(p);
        const price = p.price;
        const oldPrice = p.oldPrice;
        const safeImg = escapeHTML(img);
        const safeFallback = getFallbackImage(name).replace(/'/g, "%27");

        html += `
            <div class="product-card" data-id="${pid}" data-slug="${escapeHTML(p.slug || '')}" style="cursor:pointer;">
                <div class="product-img">
                    <img src="${safeImg}" alt="${name}" loading="lazy" onerror="this.onerror=null; this.src='${safeFallback}'">
                    <button class="favorite-btn ${isFav ? 'is-fav' : ''}" data-id="${pid}">${isFav ? '❤️' : '🤍'}</button>
                </div>
                <div class="product-body" style="padding:0.8rem;">
                    <div class="p-name" style="font-size:0.85rem;">${name}</div>
                    <div class="p-price" style="font-size:0.95rem;">
                        ${price} ${t('currency')}
                        ${oldPrice ? `<small>${oldPrice} ${t('currency')}</small>` : ''}
                    </div>
                </div>
            </div>
        `;
    });

    html += `</div>`;
    container.innerHTML = html;

    container.querySelectorAll('.product-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.favorite-btn')) return;
            const slug = card.dataset.slug;
            if (slug) window.location.href = `/produit?slug=${encodeURIComponent(slug)}`;
        });
        const favBtn = card.querySelector('.favorite-btn');
        if (favBtn) {
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFavorite(parseInt(favBtn.dataset.id));
            });
        }
    });
}

// ============================================================
// ÉVÉNEMENTS PRINCIPAUX (guard + WhatsApp)
// ============================================================
function attachProductEvents(product) {
    const addBtn = document.getElementById('addToCartBtn');
    if (addBtn && !addBtn._listenerAttached) {
        addBtn._listenerAttached = true;
        addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (!currentProduct) return;

            const hasVariants = Array.isArray(currentProduct.variants) && currentProduct.variants.length > 0;

            if (hasVariants) {
                if (!selectedSize && currentProduct.variants.some(v => v.size)) {
                    showToast('⚠️ Veuillez choisir une taille');
                    return;
                }
                if (!selectedColor && currentProduct.variants.some(v => v.color)) {
                    showToast('⚠️ Veuillez choisir une couleur');
                    return;
                }
                if (!currentVariant) {
                    showToast('⚠️ Cette combinaison est introuvable');
                    return;
                }
                if (currentVariant.stock <= 0) {
                    showToast('⚠️ ' + t('outOfStock'));
                    return;
                }
                addToCart(currentProduct.id, currentVariant);
            } else {
                addToCart(currentProduct.id);
            }
        });
    }

    const waBtn = document.getElementById('whatsappOrderBtn');
    if (waBtn && !waBtn._listenerAttached) {
        waBtn._listenerAttached = true;
        waBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            handleWhatsAppOrder(currentProduct);
        }, true);
    }

    console.log('📦 Page produit prête :', product.slug);
}

// ============================================================
// Handler WhatsApp (avec variants)
// ============================================================
function handleWhatsAppOrder(product) {
    if (!product) return;

    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;

    if (hasVariants) {
        if (!selectedSize && product.variants.some(v => v.size)) {
            showToast('⚠️ Veuillez choisir une taille');
            return;
        }
        if (!selectedColor && product.variants.some(v => v.color)) {
            showToast('⚠️ Veuillez choisir une couleur');
            return;
        }
        if (!currentVariant) {
            showToast('⚠️ Combinaison indisponible');
            return;
        }
        if (currentVariant.stock <= 0) {
            showToast('⚠️ ' + t('outOfStock'));
            return;
        }
    }

    const name = getProductName(product);
    const price = currentVariant ? Number(currentVariant.price) : Number(product.price);
    const variantText = currentVariant
        ? ` (${[selectedSize, selectedColor].filter(Boolean).join(' / ')})`
        : '';
    const url = `${CONFIG.SHOP.URL}/produit?slug=${encodeURIComponent(product.slug || '')}`;

    let msg = `🛒 *${t('waNewOrder')}*\n\n`;
    msg += `📦 *${t('waProduct')} :* ${name}${variantText}\n`;
    msg += `💰 *${t('waPrice')} :* ${price} ${t('currency')}\n`;
    msg += `🔗 ${url}\n\n`;
    msg += `👤 ${t('waName')} : \n`;
    msg += `📞 ${t('waPhone')} : \n`;
    msg += `📍 ${t('waAddress')} : \n`;
    msg += `🏙️ ${t('waCity')} : \n\n`;
    msg += `${t('waThanks')}`;

    window.open(
        `https://wa.me/${CONFIG.SHOP.WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`,
        '_blank',
        'noopener,noreferrer'
    );
}

// ============================================================
// LOG
// ============================================================
console.log('✅ product-detail.js chargé — v3.1.0 (breadcrumb complet + parent-aware)');