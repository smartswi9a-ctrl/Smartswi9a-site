// js/testimonials.js
// ============================================================
// TÉMOIGNAGES DYNAMIQUES - SMART SWI9A
// Version 1.3.0 — FIX: fallback initial "?" pour avatar
// ============================================================
// Dépend de : config, utils, firebase, store
// Affiche les vrais avis clients sur la page d'accueil
// ============================================================

import { collection, query, where, getDocs, limit } from "firebase/firestore";
import { db } from "./firebase.js";
import { REVIEW_STATUS } from "./config.js";
import {
    t, escapeHTML, renderStars, toDate,
    getProductName, getProductImageUrl, getFallbackImage,
    getCityName
} from "./utils.js";
import { getProducts } from "./store.js";

// ============================================================
// CONSTANTE
// ============================================================
const MAX_TESTIMONIALS = 3;

// ============================================================
// CHARGER LES AVIS EN VEDETTE (featured: true)
// ============================================================
async function loadFeaturedReviews() {
    try {
        const q = query(
            collection(db, "reviews"),
            where("status", "==", REVIEW_STATUS.APPROVED),
            where("featured", "==", true),
            limit(MAX_TESTIMONIALS)
        );

        const snapshot = await getDocs(q);
        const reviews = snapshot.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                createdAt: toDate(data.createdAt)
            };
        });

        // Tri par date DESC pour un ordre stable
        reviews.sort((a, b) => {
            const da = a.createdAt ? a.createdAt.getTime() : 0;
            const dbb = b.createdAt ? b.createdAt.getTime() : 0;
            return dbb - da;
        });

        return reviews.slice(0, MAX_TESTIMONIALS);
    } catch (e) {
        console.error('❌ Erreur loadFeaturedReviews :', e);
        return [];
    }
}

// ============================================================
// CHARGER LES AVIS APPROUVÉS RÉCENTS (fallback)
// ============================================================
async function loadRecentApprovedReviews(excludeIds = [], count = MAX_TESTIMONIALS) {
    try {
        const q = query(
            collection(db, "reviews"),
            where("status", "==", REVIEW_STATUS.APPROVED),
            limit(50)
        );

        const snapshot = await getDocs(q);
        const reviews = snapshot.docs
            .map(d => {
                const data = d.data();
                return {
                    id: d.id,
                    ...data,
                    createdAt: toDate(data.createdAt)
                };
            })
            .filter(r => !excludeIds.includes(r.id)); // Exclure ceux déjà en vedette

        // Tri par date DESC
        reviews.sort((a, b) => {
            const da = a.createdAt ? a.createdAt.getTime() : 0;
            const dbb = b.createdAt ? b.createdAt.getTime() : 0;
            return dbb - da;
        });

        return reviews.slice(0, count);
    } catch (e) {
        console.error('❌ Erreur loadRecentApprovedReviews :', e);
        return [];
    }
}

// ============================================================
// CHARGER LES 3 TÉMOIGNAGES (featured + fallback)
// ============================================================
async function loadTestimonials() {
    // 1. Charger les avis en vedette
    const featured = await loadFeaturedReviews();
    console.log(`⭐ ${featured.length} avis en vedette`);

    // 2. Si on a déjà 3 vedettes → terminé
    if (featured.length >= MAX_TESTIMONIALS) {
        return featured.slice(0, MAX_TESTIMONIALS);
    }

    // 3. Sinon, compléter avec les plus récents approuvés
    const needed = MAX_TESTIMONIALS - featured.length;
    const excludeIds = featured.map(r => r.id);
    const recent = await loadRecentApprovedReviews(excludeIds, needed);
    console.log(`🔄 ${recent.length} avis complémentaires (fallback)`);

    // 4. Fusionner
    return [...featured, ...recent];
}

// ============================================================
// RÉCUPÉRER LA VILLE DU CLIENT — LOCALISÉE
// ============================================================
async function getClientCity(userId) {
    if (!userId) return '';

    try {
        const ordersQ = query(
            collection(db, "orders"),
            where("userId", "==", userId),
            limit(1)
        );
        const snap = await getDocs(ordersQ);
        if (snap.empty) return '';

        const order = snap.docs[0].data();
        const addr = order.deliveryAddress || {};

        // ✅ Ville localisée via getCityName() avec fallback sur toutes les variantes
        return getCityName({
            name: addr.cityAr || addr.city,
            nameFr: addr.cityFr,
            nameAr: addr.cityAr,
            key: addr.cityId ? String(addr.cityId) : ''
        });
    } catch (e) {
        return '';
    }
}

// ============================================================
// TROUVER LE PRODUIT ASSOCIÉ À UN AVIS
// ============================================================
function findProductForReview(review) {
    const products = getProducts();
    if (!products || products.length === 0) return null;

    // Par productId
    if (review.productId) {
        const byId = products.find(p => Number(p.id) === Number(review.productId));
        if (byId) return byId;
    }

    // Par productSlug
    if (review.productSlug) {
        const bySlug = products.find(p => p.slug === review.productSlug);
        if (bySlug) return bySlug;
    }

    return null;
}

// ============================================================
// RENDU D'UNE CARTE TÉMOIGNAGE
// ============================================================
function renderTestimonialCard(review, product, city) {
    const stars = renderStars(review.rating || 0);
    const comment = escapeHTML((review.comment || '').substring(0, 150));
    const userName = escapeHTML(review.userName || '');

    // ✅ Fallback initial : "?" si pas de nom (au lieu de "—" qui donne un tiret comme avatar)
    const initial = userName
        ? userName.charAt(0).toUpperCase()
        : '?';

    // Photo produit
    let productImgHtml = '';
    let productNameHtml = '';
    if (product) {
        const imgUrl = getProductImageUrl(product);
        const name = escapeHTML(getProductName(product));
        const fallback = getFallbackImage(name);
        productImgHtml = `
            <img src="${imgUrl}" alt="${name}" class="testimonial-product-img"
                 loading="lazy" onerror="this.src='${fallback}'">
        `;
        productNameHtml = `<div class="testimonial-product-name">${name}</div>`;
    } else {
        productImgHtml = `<div class="testimonial-product-img testimonial-product-placeholder">📦</div>`;
    }

    // Ville (optionnelle)
    const cityHtml = city
        ? `<span class="testimonial-city">📍 ${escapeHTML(city)}</span>`
        : '';

    // Badge "Achat vérifié"
    const verifiedHtml = review.verifiedPurchase
        ? `<span class="testimonial-verified" title="${t('avisVerifiedPurchase')}">✅</span>`
        : '';

    return `
        <div class="t-card testimonial-card">
            <div class="testimonial-product-thumb">
                ${productImgHtml}
                ${productNameHtml}
            </div>
            <div class="testimonial-body">
                <div class="t-stars" aria-label="${review.rating}">${stars}</div>
                <p class="testimonial-comment">"${comment}"</p>
                <div class="testimonial-author-block">
                    <div class="testimonial-avatar">${escapeHTML(initial)}</div>
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
// INITIALISER LES TÉMOIGNAGES DYNAMIQUES
// ============================================================
export async function initDynamicTestimonials() {
    const container = document.getElementById('testimonialsGrid');
    if (!container) return;

    // Afficher un loader
    container.innerHTML = `
        <div class="testimonials-loading">
            ⏳ ${t('avisLoading')}
        </div>
    `;

    // Charger les témoignages (featured + fallback)
    const reviews = await loadTestimonials();

    // Si vraiment aucun avis en base → fallback sur faux témoignages
    if (reviews.length === 0) {
        console.log('ℹ️ Aucun avis disponible, fallback sur témoignages par défaut');
        renderFallbackTestimonials(container);
        return;
    }

    // Charger les villes des clients en parallèle (localisées)
    const citiesPromises = reviews.map(r => getClientCity(r.userId));
    const cities = await Promise.all(citiesPromises);

    // Construire les cartes
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
console.log('✅ testimonials.js chargé — v1.3.0 (fallback initial ?)');