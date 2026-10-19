// js/product-detail.js
// ============================================================
// PAGE PRODUIT DYNAMIQUE - SMART SWI9A
// Version 1.8.0 — Vidéo sans autoplay + dimensions maîtrisées
// ============================================================

import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG, VIDEO_BASE_URL } from "./config.js";
import {
    t, escapeHTML, getProductName, getProductDesc, getProductFeatures,
    getProductImageUrl, getFallbackImage, renderStars,
    getDiscountPercent
} from "./utils.js";
import { getProducts } from "./store.js";
import { getCurrentUser } from "./auth.js";
import { toggleFavorite } from "./products.js";
import { createReview, canUserReviewProduct, toggleLike } from "./reviews.js";
import { showToast, openImageLightbox } from "./ui-core.js";

// ============================================================
// ÉTAT LOCAL
// ============================================================
let currentProduct = null;
let currentVideoElement = null;

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
    document.title = `${getProductName(product)} | Smart Swi9a`;

    updateMetaTags(product);
    renderBreadcrumbs(product);
    
    // ✅ Rendu unifié des images et de la vidéo
    renderMediaGallery(product);

    renderInfoSection(product);
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

    document.title = `${name} | Smart Swi9a`;

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
    schemaEl.textContent = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        "name": name,
        "description": desc,
        "image": img.startsWith('http') ? img : `${CONFIG.SHOP.URL}${img}`,
        "brand": { "@type": "Brand", "name": "Smart Swi9a" },
        "offers": {
            "@type": "Offer",
            "price": product.price,
            "priceCurrency": "MAD",
            "availability": (product.stock || 0) > 0
                ? "https://schema.org/InStock"
                : "https://schema.org/OutOfStock",
            "url": url
        },
        "aggregateRating": product.ratingAvg ? {
            "@type": "AggregateRating",
            "ratingValue": product.ratingAvg,
            "reviewCount": product.ratingCount || 1
        } : undefined
    });
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
// BREADCRUMBS
// ============================================================
function renderBreadcrumbs(product) {
    const el = document.getElementById('breadcrumbs');
    if (!el) return;

    const breadcrumbSchema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {
                "@type": "ListItem",
                "position": 1,
                "name": t('productBreadcrumbHome'),
                "item": CONFIG.SHOP.URL
            },
            {
                "@type": "ListItem",
                "position": 2,
                "name": t('productBreadcrumbProducts'),
                "item": `${CONFIG.SHOP.URL}/#produits`
            },
            {
                "@type": "ListItem",
                "position": 3,
                "name": getProductName(product)
            }
        ]
    };

    let schemaEl = document.getElementById('breadcrumb-schema');
    if (!schemaEl) {
        schemaEl = document.createElement('script');
        schemaEl.id = 'breadcrumb-schema';
        schemaEl.type = 'application/ld+json';
        document.head.appendChild(schemaEl);
    }
    schemaEl.textContent = JSON.stringify(breadcrumbSchema);

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
    
    // Nettoyer le wrapper pour le préparer
    wrapper.innerHTML = '';
    if (currentVideoElement) {
        currentVideoElement.pause();
        currentVideoElement = null;
    }

    // Fonction pour afficher une image dans le grand cadre
    const showImage = (src, activeThumb) => {
        if (currentVideoElement) {
            currentVideoElement.pause();
            currentVideoElement = null;
        }
        wrapper.innerHTML = `
            <img id="mainImage" class="main-media-element" src="${src}" alt="${escapeHTML(getProductName(product))}" loading="eager">
        `;
        
        const newMainImg = document.getElementById('mainImage');
        newMainImg.addEventListener('click', () => openImageLightbox(newMainImg.src));

        galleryContainer.querySelectorAll('.thumb-img, .thumb-video').forEach(el => el.classList.remove('active'));
        if (activeThumb) activeThumb.classList.add('active');
    };

    // Fonction pour afficher la vidéo dans le grand cadre
    const showVideo = (videoUrl, activeThumb) => {
        wrapper.innerHTML = `
            <video id="mainVideo" class="main-media-element" src="${videoUrl}" controls preload="metadata" playsinline poster="${mainImageUrl}" style="background: #000;"></video>
        `;
        currentVideoElement = document.getElementById('mainVideo');

        galleryContainer.querySelectorAll('.thumb-img, .thumb-video').forEach(el => el.classList.remove('active'));
        if (activeThumb) activeThumb.classList.add('active');
    };

    // 1. Créer les miniatures des photos
    const images = (product.gallery && product.gallery.length > 0)
        ? [product.img, ...product.gallery]
        : [product.img];
    
    let firstImageThumb = null;

    images.forEach((imgUrl, index) => {
        if (!imgUrl) return;
        const thumb = document.createElement('img');
        thumb.className = 'thumb-img';
        thumb.src = imgUrl.startsWith('http') || imgUrl.startsWith('/') ? imgUrl : '/' + imgUrl;
        thumb.alt = `${getProductName(product)} - ${index + 1}`;
        thumb.loading = 'lazy';
        
        thumb.addEventListener('click', () => showImage(thumb.src, thumb));

        if (index === 0) firstImageThumb = thumb;

        galleryContainer.appendChild(thumb);
    });

    // 2. Ajouter la vidéo si elle existe
    const hasVideo = product.video && product.video.trim() !== '';
    let videoThumb = null;

    if (hasVideo) {
        const baseUrl = VIDEO_BASE_URL.endsWith('/') ? VIDEO_BASE_URL : VIDEO_BASE_URL + '/';
        const videoUrl = baseUrl + product.video.trim();

        videoThumb = document.createElement('div');
        videoThumb.className = 'thumb-video';
        // On utilise la première image comme fond pour la miniature vidéo
        videoThumb.innerHTML = `
            <img src="${mainImageUrl}" style="filter: brightness(0.5);">
            <div class="play-icon-overlay">
                <div>
                    <svg viewBox="0 0 24 24" fill="white" width="14" height="14" style="margin-left: 2px;"><path d="M8 5v14l11-7z"/></svg>
                </div>
            </div>
        `;

        videoThumb.addEventListener('click', () => showVideo(videoUrl, videoThumb));

        // Placer la vidéo en première position
        galleryContainer.insertBefore(videoThumb, galleryContainer.firstChild);
        
        // ✅ AFFICHER LA VIDÉO PAR DÉFAUT DANS LE GRAND CADRE
        showVideo(videoUrl, videoThumb);
        
        // Retirer l'état actif de la première image
        if (firstImageThumb) firstImageThumb.classList.remove('active');

    } else {
        // S'il n'y a pas de vidéo, afficher l'image principale par défaut
        showImage(mainImageUrl, firstImageThumb);
    }
}

// ============================================================
// SECTION INFO
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

    if (titleEl) {
        titleEl.textContent = getProductName(product);
        titleEl.removeAttribute('data-key');
    }

    if (priceEl) priceEl.textContent = `${product.price} ${t('currency')}`;

    if (oldPriceEl) {
        if (isPromo) {
            oldPriceEl.textContent = `${product.oldPrice} ${t('currency')}`;
            oldPriceEl.style.display = 'inline-block'; 
        } else {
            oldPriceEl.style.display = 'none';
        }
    }

    if (descEl) descEl.textContent = getProductDesc(product);

    if (isPromo) {
        const priceBlock = document.querySelector('.product-price-block');
        if (priceBlock) {
            const existing = priceBlock.querySelector('.discount-badge');
            if (existing) existing.remove();
            const badge = document.createElement('span');
            badge.className = 'discount-badge';
            badge.style.cssText = 'background:var(--danger);color:white;padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;';
            badge.textContent = `-${discountPercent}%`;
            priceBlock.appendChild(badge);
        }
    }

    if (stockEl) {
        if (stock > 0) {
            stockEl.innerHTML = `<span style="color:#22c55e;">${t('productInStock')}</span