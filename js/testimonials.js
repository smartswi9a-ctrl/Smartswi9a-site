// js/testimonials.js
// ============================================================
// TÉMOIGNAGES DYNAMIQUES - SMART SWI9A
// Version 2.0.0 — Sélection stricte admin + Design 2 colonnes
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
// RENDU D'UNE CARTE TÉMOIGNAGE (Nouveau Design 2 colonnes)
// ============================================================
function renderTestimonialCard(review, product, city) {
    const stars = renderStars(review.rating || 0);
    const comment = escapeHTML((review.comment || '').substring(0, 180));
    const userName = escapeHTML(review.userName || 'Client');

    // Initiale de secours si pas de photo d'avatar (on utilise juste le nom ici)
    const initial = userName ? userName.charAt(0).toUpperCase() : '?';

    // Photo du produit
    let productImgHtml = '';
    let productNameHtml = '';
    
    if (product) {
        const imgUrl = getProductImageUrl(product);
        const name = escapeHTML(getProductName(product));
        const fallback = getFallbackImage(name);
        
        productImgHtml = `
            <img src="${imgUrl}" alt="${name}" class="testimonial-img" loading="lazy" onerror="this.src='${fallback}'">
        `;
        // On peut afficher le nom du produit discrètement sous la photo
        productNameHtml = `<div class="testimonial-product-name">${name}</div>`;
    } else {
        productImgHtml = `<div class="testimonial-img testimonial-img-placeholder">📦</div>`;
    }

    // Ville (optionnelle)
    const cityHtml = city ? `<span class="testimonial-city">📍 ${escapeHTML(city)}</span>` : '';

    // Badge "Achat vérifié"
    const verifiedHtml = review.verifiedPurchase
        ? `<span class="testimonial-verified" title="${t('avisVerifiedPurchase')}">✅ ${t('reviewVerifiedPurchase') || 'Achat vérifié'}</span>`
        : '';

    return `
        <div class="testimonial-card">
            <!-- Colonne Image (Gauche en FR, Droite en AR) -->
            <div class="testimonial-img-col">
                ${productImgHtml}
                ${productNameHtml}
            </div>

            <!-- Colonne Contenu (Droite en FR, Gauche en AR) -->
            <div class="testimonial-content-col">
                <div class="testimonial-stars" aria-label="${review.rating} étoiles">${stars}</div>
                
                <div class="testimonial-author">
                    <span class="t-author-name">${userName}</span>
                    ${verifiedHtml}
                </div>

                ${cityHtml}
                
                <p class="testimonial-comment">"${comment}"</p>
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
        <div class="testimonials-loading" style="grid-column: 1 / -1; text-align: center; padding: 2rem; color: var(--text-muted);">
            ⏳ ${t('avisLoading')}
        </div>
    `;

    // Charger UNIQUEMENT les avis sélectionnés (featured) — Plus de fallback automatique
    const reviews = await loadFeaturedReviews();

    // Si l'admin n'a sélectionné aucun avis, on masque la section
    if (reviews.length === 0) {
        console.log('ℹ️ Aucun avis sélectionné en vedette par l\'admin.');
        const section = container.closest('section');
        if (section) {
            section.style.display = 'none'; // On cache toute la section sur la page d'accueil
        }
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
    
    // S'assurer que la section est visible si elle avait été cachée
    const section = container.closest('section');
    if (section) section.style.display = '';

    console.log(`✅ ${reviews.length} témoignages affichés (sélection stricte admin)`);
}

// ============================================================
// LOG
// ============================================================
console.log('✅ testimonials.js chargé — v2.0.0 (Sélection stricte admin + Design 2 colonnes)');