// js/testimonials.js
// ============================================================
// TÉMOIGNAGES DYNAMIQUES - SMART SWI9A
// Version 2.0.0 — Perf (limit, timeout, cache) + UX
// ============================================================
// CHANGEMENTS v2.0.0 :
// ✅ I15.1 — loadRecentApprovedReviews limit(count*3) (9 au lieu de 50)
// ✅ I15.2 — getClientCity : cache Map + user.lastCity + fallback orders
// ✅ I15.3 — Timeout 8s sur tous les getDocs
// ✅ M15.1 — Initiales 2 lettres
// ✅ M15.2 — Emoji fallback
// ✅ M15.3 — Image produit cliquable
// ✅ M15.4 — Bouton "Voir le produit"
// ✅ M15.5 — Cache invalidé sur review-submitted/deleted
// ============================================================
// Dépend de : config, utils, firebase, store
// ============================================================

import { collection, query, where, getDocs, limit, doc, getDoc } from "firebase/firestore";
import { db } from "./firebase.js";
import { REVIEW_STATUS } from "./config.js";
import {
    t, escapeHTML, renderStars, toDate,
    getProductName, getProductImageUrl, getFallbackImage,
    getCityName
} from "./utils.js";
import { getProducts } from "./store.js";

// ============================================================
// CONSTANTES
// ============================================================
const MAX_TESTIMONIALS = 3;
const TIMEOUT_MS = 8000;

// ✅ I15.2 : Cache villes (uid → city)
const _cityCache = new Map();

// ✅ M15.5 : Cache témoignages (invalidation events)
let _testimonialsCache = null;
let _testimonialsCacheTime = 0;
const TESTIMONIALS_CACHE_TTL = 60000; // 60s

// Invalidation sur nouveaux avis / suppressions
if (typeof document !== 'undefined') {
    document.addEventListener('review-submitted', () => {
        _testimonialsCache = null;
        _testimonialsCacheTime = 0;
    });
    document.addEventListener('review-deleted', () => {
        _testimonialsCache = null;
        _testimonialsCacheTime = 0;
    });
}

// ============================================================
// ✅ I15.3 : Timeout helper
// ============================================================
function withTimeout(promise, ms = TIMEOUT_MS) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT')), ms)
        )
    ]);
}

// ============================================================
// ✅ M15.1 : Initiales (2 lettres max)
// ============================================================
function getInitials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// ============================================================
// ✅ I15.1 : CHARGER LES AVIS EN VEDETTE
// ============================================================
async function loadFeaturedReviews() {
    try {
        const q = query(
            collection(db, "reviews"),
            where("status", "==", REVIEW_STATUS.APPROVED),
            where("featured", "==", true),
            limit(MAX_TESTIMONIALS)
        );

        const snapshot = await withTimeout(getDocs(q));
        const reviews = snapshot.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                createdAt: toDate(data.createdAt)
            };
        });

        reviews.sort((a, b) => {
            const da = a.createdAt?.getTime?.() || 0;
            const dbb = b.createdAt?.getTime?.() || 0;
            return dbb - da;
        });

        return reviews.slice(0, MAX_TESTIMONIALS);
    } catch (e) {
        console.error('❌ Erreur loadFeaturedReviews :', e);
        return [];
    }
}

// ============================================================
// ✅ I15.1 : CHARGER LES AVIS APPROUVÉS RÉCENTS (fallback)
// limit = count * 3 (au lieu de 50)
// ============================================================
async function loadRecentApprovedReviews(excludeIds = [], count = MAX_TESTIMONIALS) {
    try {
        const q = query(
            collection(db, "reviews"),
            where("status", "==", REVIEW_STATUS.APPROVED),
            // ✅ I15.1 : 3x le nombre demandé (marge pour les doublons/dates)
            limit(Math.max(count * 3, 9))
        );

        const snapshot = await withTimeout(getDocs(q));
        const reviews = snapshot.docs
            .map(d => {
                const data = d.data();
                return {
                    id: d.id,
                    ...data,
                    createdAt: toDate(data.createdAt)
                };
            })
            .filter(r => !excludeIds.includes(r.id));

        reviews.sort((a, b) => {
            const da = a.createdAt?.getTime?.() || 0;
            const dbb = b.createdAt?.getTime?.() || 0;
            return dbb - da;
        });

        return reviews.slice(0, count);
    } catch (e) {
        console.error('❌ Erreur loadRecentApprovedReviews :', e);
        return [];
    }
}

// ============================================================
// ✅ M15.5 : CHARGER LES 3 TÉMOIGNAGES (avec cache)
// ============================================================
async function loadTestimonials() {
    // Cache check
    const now = Date.now();
    if (_testimonialsCache && (now - _testimonialsCacheTime) < TESTIMONIALS_CACHE_TTL) {
        return _testimonialsCache;
    }

    // 1. Featured
    const featured = await loadFeaturedReviews();
    console.log(`⭐ ${featured.length} avis en vedette`);

    if (featured.length >= MAX_TESTIMONIALS) {
        _testimonialsCache = featured.slice(0, MAX_TESTIMONIALS);
        _testimonialsCacheTime = now;
        return _testimonialsCache;
    }

    // 2. Compléter avec récents
    const needed = MAX_TESTIMONIALS - featured.length;
    const excludeIds = featured.map(r => r.id);
    const recent = await loadRecentApprovedReviews(excludeIds, needed);
    console.log(`🔄 ${recent.length} avis complémentaires (fallback)`);

    const result = [...featured, ...recent];
    _testimonialsCache = result;
    _testimonialsCacheTime = now;
    return result;
}

// ============================================================
// ✅ I15.2 + I15.3 : VILLE DU CLIENT (cache + user.lastCity + timeout)
// ------------------------------------------------------------
// Ordre de priorité :
//  1. Cache Map (mémoire session)
//  2. users/{uid}.lastCity (si rempli)
//  3. orders/{...}.deliveryAddress (fallback)
// ============================================================
async function getClientCity(userId) {
    if (!userId) return '';

    // ✅ I15.2 : cache
    if (_cityCache.has(userId)) return _cityCache.get(userId);

    // ✅ I15.2 : tentative users.lastCity (1 lecture, souvent suffit)
    try {
        const userRef = doc(db, "users", userId);
        const userSnap = await withTimeout(getDoc(userRef), 3000);
        if (userSnap.exists()) {
            const data = userSnap.data();
            if (data.lastCity) {
                const city = getCityName({
                    name: data.lastCity.name || data.lastCity.city || '',
                    nameFr: data.lastCity.nameFr,
                    nameAr: data.lastCity.nameAr,
                    key: data.lastCity.key || ''
                });
                if (city) {
                    _cityCache.set(userId, city);
                    return city;
                }
            }
        }
    } catch (e) {
        // Silencieux (timeout ou permission)
    }

    // ✅ Fallback : orders (1 seule commande suffit)
    try {
        const ordersQ = query(
            collection(db, "orders"),
            where("userId", "==", userId),
            limit(1)
        );
        const snap = await withTimeout(getDocs(ordersQ));
        if (snap.empty) {
            _cityCache.set(userId, '');
            return '';
        }

        const order = snap.docs[0].data();
        const addr = order.deliveryAddress || {};
        const city = getCityName({
            name: addr.cityAr || addr.city,
            nameFr: addr.cityFr,
            nameAr: addr.cityAr,
            key: addr.cityId ? String(addr.cityId) : ''
        });

        _cityCache.set(userId, city);
        return city;
    } catch (e) {
        return '';
    }
}

// ============================================================
// TROUVER LE PRODUIT ASSOCIÉ
// ============================================================
function findProductForReview(review) {
    const products = getProducts();
    if (!products || products.length === 0) return null;

    if (review.productId) {
        const byId = products.find(p => Number(p.id) === Number(review.productId));
        if (byId) return byId;
    }

    if (review.productSlug) {
        const bySlug = products.find(p => p.slug === review.productSlug);
        if (bySlug) return bySlug;
    }

    return null;
}

// ============================================================
// ✅ M15.1-4 : RENDU D'UNE CARTE TÉMOIGNAGE
// ============================================================
function renderTestimonialCard(review, product, city) {
    const stars = renderStars(review.rating || 0);
    const comment = escapeHTML((review.comment || '').substring(0, 150));
    const userName = escapeHTML(review.userName || '');

    // ✅ M15.1 : initiales 2 lettres
    const initials = getInitials(review.userName);

    // ✅ M15.2 : fallback emoji si pas de nom
    const avatarContent = initials === '?'
        ? '👤'
        : escapeHTML(initials);

    // Photo produit
    let productImgHtml = '';
    let productNameHtml = '';
    let productLink = '';

    if (product) {
        const imgUrl = getProductImageUrl(product);
        const name = escapeHTML(getProductName(product));
        const fallback = getFallbackImage(name);
        const slug = product.slug || '';

        // ✅ M15.3 : image cliquable
        productImgHtml = `
            <a href="/produit?slug=${encodeURIComponent(slug)}" style="display:block;text-decoration:none;" class="testimonial-product-link">
                <img src="${imgUrl}" alt="${name}" class="testimonial-product-img"
                     loading="lazy" onerror="this.onerror=null; this.src='${fallback}'">
            </a>
        `;
        productNameHtml = `<div class="testimonial-product-name">${name}</div>`;

        // ✅ M15.4 : bouton "Voir le produit"
        productLink = `
            <a href="/produit?slug=${encodeURIComponent(slug)}"
               style="display:inline-flex;align-items:center;gap:0.2rem;font-size:0.72rem;color:var(--gold);text-decoration:none;font-weight:600;margin-top:0.3rem;padding:0.2rem 0.5rem;border:1px solid var(--border-gold);border-radius:30px;transition:all 0.2s;"
               onmouseover="this.style.background='var(--gold)';this.style.color='white';"
               onmouseout="this.style.background='transparent';this.style.color='var(--gold)';">
                👁️ Voir
            </a>
        `;
    } else {
        productImgHtml = `<div class="testimonial-product-img testimonial-product-placeholder">📦</div>`;
    }

    // Ville
    const cityHtml = city
        ? `<span class="testimonial-city">📍 ${escapeHTML(city)}</span>`
        : '';

    // Badge vérifié
    const verifiedHtml = review.verifiedPurchase
        ? `<span class="testimonial-verified" title="${t('avisVerifiedPurchase')}">✅</span>`
        : '';

    return `
        <div class="t-card testimonial-card">
            <div class="testimonial-product-thumb">
                ${productImgHtml}
                ${productNameHtml}
                ${productLink}
            </div>
            <div class="testimonial-body">
                <div class="t-stars" aria-label="${review.rating}">${stars}</div>
                <p class="testimonial-comment">"${comment}"</p>
                <div class="testimonial-author-block">
                    <div class="testimonial-avatar">${avatarContent}</div>
                    <div class="testimonial-author-info">
                        <div class="t-author">
                            ${userName || '—'}
                            ${verifiedHtml}
                        </div>
                        ${cityHtml}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// INITIALISER LES TÉMOIGNAGES
// ============================================================
export async function initDynamicTestimonials() {
    const container = document.getElementById('testimonialsGrid');
    if (!container) return;

    container.innerHTML = `
        <div class="testimonials-loading">
            ⏳ ${t('avisLoading')}
        </div>
    `;

    const reviews = await loadTestimonials();

    if (reviews.length === 0) {
        console.log('ℹ️ Aucun avis disponible, fallback sur témoignages par défaut');
        renderFallbackTestimonials(container);
        return;
    }

    // Villes en parallèle (avec cache + timeout)
    const citiesPromises = reviews.map(r => getClientCity(r.userId));
    const cities = await Promise.all(citiesPromises);

    let html = '';
    reviews.forEach((review, idx) => {
        const product = findProductForReview(review);
        const city = cities[idx] || '';
        html += renderTestimonialCard(review, product, city);
    });

    container.innerHTML = html;
    console.log(`✅ ${reviews.length} témoignages affichés`);
}

// ============================================================
// FALLBACK — Témoignages par défaut (si aucun avis en BD)
// ============================================================
function renderFallbackTestimonials(container) {
    const fallbacks = [
        { comment: "Produits de qualité, livraison rapide. Je recommande Smart Swi9a.", author: "Mohamed", city: "Casablanca" },
        { comment: "La montre connectée est superbe, rapport qualité-prix excellent. Merci !", author: "Fatima", city: "Rabat" },
        { comment: "Service client réactif, produit conforme. Je suis très satisfait.", author: "Youssef", city: "Marrakech" }
    ];

    let html = '';
    fallbacks.forEach(f => {
        html += `
            <div class="t-card">
                <div class="t-stars">★★★★★</div>
                <p>"${escapeHTML(f.comment)}"</p>
                <div class="t-author">- ${escapeHTML(f.author)}, ${escapeHTML(f.city)}</div>
            </div>
        `;
    });
    container.innerHTML = html;
}

// ============================================================
// LOG
// ============================================================
console.log('✅ testimonials.js chargé — v2.0.0 (cache + timeout + lastCity)');