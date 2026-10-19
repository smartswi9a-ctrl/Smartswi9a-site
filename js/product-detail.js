// js/product-detail.js
// ============================================================
// PAGE PRODUIT DYNAMIQUE - SMART SWI9A
// Version 1.4.2 — FIX: Prix barré sur mobile (inline-block)
// ============================================================
// Dépend de : config, utils, store, firebase, auth, products,
//             ui-core, cart, whatsapp, reviews
// URL      : /produit?slug=xxx  (Firebase cleanUrls)
// ============================================================

import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG } from "./config.js";
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
    renderImageSection(product);
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
// SECTION IMAGES
// ============================================================
function renderImageSection(product) {
    const mainImg = document.getElementById('mainImage');
    const galleryContainer = document.getElementById('galleryThumbnails');
    if (!mainImg) return;

    const mainImageUrl = getProductImageUrl(product);
    mainImg.src = mainImageUrl;
    mainImg.alt = escapeHTML(getProductName(product));

    mainImg.style.cursor = 'zoom-in';
    if (mainImg._lightboxClick) {
        mainImg.removeEventListener('click', mainImg._lightboxClick);
    }
    mainImg._lightboxClick = () => openImageLightbox(mainImg.src);
    mainImg.addEventListener('click', mainImg._lightboxClick);

    if (galleryContainer) {
        galleryContainer.innerHTML = '';
        const images = (product.gallery && product.gallery.length > 0)
            ? [product.img, ...product.gallery]
            : [product.img];

        images.forEach((imgUrl, index) => {
            if (!imgUrl) return;
            const thumb = document.createElement('img');
            thumb.src = imgUrl.startsWith('http') || imgUrl.startsWith('/') ? imgUrl : '/' + imgUrl;
            thumb.alt = `${getProductName(product)} - ${index + 1}`;
            thumb.loading = 'lazy';
            if (index === 0) thumb.classList.add('active');

            thumb.addEventListener('click', () => {
                mainImg.src = thumb.src;
                galleryContainer.querySelectorAll('img').forEach(i => i.classList.remove('active'));
                thumb.classList.add('active');
            });

            galleryContainer.appendChild(thumb);
        });
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
            // ✅ FIX : 'inline-block' au lieu de 'inline' pour que le barré s'affiche sur mobile
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
            stockEl.innerHTML = `<span style="color:#22c55e;">${t('productInStock')}</span>`;
        } else {
            stockEl.innerHTML = `<span style="color:#b03a2e;">${t('productOutOfStock')}</span>`;
        }
    }

    const addBtn = document.getElementById('addToCartBtn');
    if (addBtn) {
        addBtn.dataset.id = product.id;
        if (stock === 0) {
            addBtn.disabled = true;
            addBtn.style.opacity = '0.5';
            addBtn.style.cursor = 'not-allowed';
        } else {
            addBtn.disabled = false;
            addBtn.style.opacity = '1';
            addBtn.style.cursor = 'pointer';
        }
    }

    const waBtn = document.getElementById('whatsappOrderBtn');
    if (waBtn) waBtn.dataset.id = product.id;
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

    try {
        const q = query(
            collection(db, "reviews"),
            where("productId", "==", Number(product.id)),
            where("status", "==", "approved")
        );
        const snapshot = await getDocs(q);
        const reviews = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

        reviews.sort((a, b) => {
            const da = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
            const dbb = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
            return dbb - da;
        });

        const user = getCurrentUser();
        const reviewCheck = user
            ? await canUserReviewProduct(Number(product.id))
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
        container.innerHTML = `<p style="text-align:center;color:var(--danger);">${t('loadingError')}</p>`;
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
            if (msgEl) { msgEl.textContent = ''; }

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
        img.addEventListener('click', () => {
            openImageLightbox(img.dataset.photoUrl);
        });
    });
}

// ============================================================
// PRODUITS SIMILAIRES (avec shuffle aléatoire)
// ------------------------------------------------------------
// ✅ FIX BUG #10c : utilise /produit?slug= (cleanUrls)
// ============================================================
function renderRelatedProducts(product) {
    const container = document.getElementById('relatedProductsRoot');
    if (!container) return;

    const all = getProducts();
    const sameCategory = all.filter(p => p.category === product.category && p.id !== product.id);
    const others = all.filter(p => p.id !== product.id && p.category !== product.category);

    const shuffle = (arr) => {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    };

    const random = [...shuffle(sameCategory), ...shuffle(others)].slice(0, 6);

    if (random.length === 0) {
        container.innerHTML = '';
        return;
    }

    const user = getCurrentUser();
    const favs = user?.favorites || [];

    let html = `<h4 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:1rem;font-size:1.2rem;">${t('productRelatedTitle')}</h4>`;
    html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem;">`;

    random.forEach(p => {
        const pid = Number(p.id);
        const isFav = favs.includes(pid);
        const name = escapeHTML(getProductName(p));
        const img = getProductImageUrl(p);
        const price = p.price;
        const oldPrice = p.oldPrice;

        html += `
            <div class="product-card" data-id="${pid}" data-slug="${escapeHTML(p.slug || '')}" style="cursor:pointer;">
                <div class="product-img">
                    <img src="${img}" alt="${name}" loading="lazy" onerror="this.src='${getFallbackImage(name)}'">
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
            // ✅ FIX BUG #10c : URL cleanUrls
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
// ÉVÉNEMENTS PRINCIPAUX
// ============================================================
function attachProductEvents(product) {
    console.log('📦 Page produit prête :', product.slug);
}

// ============================================================
// LOG
// ============================================================
console.log('✅ product-detail.js chargé — v1.4.2 (fix prix barré)');