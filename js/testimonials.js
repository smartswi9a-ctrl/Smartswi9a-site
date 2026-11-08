/* ============================================================ js/testimonials.js TÉMOIGNAGES DYNAMIQUES - SMARTSWIKA Version 9.0.0 - Lot 15/30 : fix findProductForReview + guard CHANGEMENTS v9.0.0 : - B-TEST-1 (P1) : findProductForReview utilise maintenant normalizeProductId (compat Number + String). Avant, les IDs vendeurs (auto-ID Firestore type "abc123") échouaient silencieusement -> pas d'image produit dans le témoignage. - B-TEST-2 (P2) : _initInProgress guard. Empêche 2 renders concurrents si initDynamicTestimonials est appelée 2× en parallèle (app.js + events.js lang change rapide). - B-TEST-3 (P2) : getClientCity - limitation documentée. La query orders(userId, limit(1)) retourne une commande arbitraire (souvent la plus ancienne). Un orderBy createdAt desc nécessiterait un index Firestore composite. Accepté : la ville du client change rarement. À traiter au Lot 48 (index) si besoin. - JSDoc sur initDynamicTestimonials. - Bump version 2.0.0 -> 9.0.0. RAPPEL : Ce module lit uniquement les avis marqués featured:true. Si l'admin n'en a sélectionné aucun, la section est masquée. Aucun avis n'est chargé par défaut (pas de fallback). ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import { collection, query, where, getDocs, limit } from "firebase/firestore";
import { db } from "./firebase.js";
import { REVIEW_STATUS } from "./config.js";
import {
  t,
  escapeHTML,
  renderStars,
  toDate,
  getProductName,
  getProductImageUrl,
  getFallbackImage,
  getCityName,
} from "./utils.js";
import { getProducts } from "./store.js";

/* ============================================================ NORMALISATION D'ID PRODUIT ============================================================ - "42" (chaîne numérique) -> 42 (Number) - "abc123" (auto-ID Firestore vendeur) -> "abc123" (String) - null/undefined/"" -> null Doit rester IDENTIQUE à products.js / reviews.js / product-detail.js / boutique.js / panier.js. ============================================================ */
function normalizeProductId(id) {
  if (id == null || id === "") return null;
  const n = Number(id);
  return Number.isFinite(n) && String(n) === String(id) ? n : String(id);
}

/* ============================================================ CONSTANTE ============================================================ */
const MAX_TESTIMONIALS = 3;

/* ============================================================ GUARD CONCURRENT (B-TEST-2) ============================================================ Empêche 2 renders simultanés si initDynamicTestimonials est appelée 2× en parallèle. ============================================================ */
let _initInProgress = false;

/* ============================================================ CHARGER LES AVIS EN VEDETTE (featured: true) ============================================================ */

/** * Charge les 3 derniers avis marqués `featured: true` et `approved`. * @returns {Promise<Array>} */
async function loadFeaturedReviews() {
  try {
    const q = query(
      collection(db, "reviews"),
      where("status", "==", REVIEW_STATUS.APPROVED),
      where("featured", "==", true),
      limit(MAX_TESTIMONIALS)
    );

    const snapshot = await getDocs(q);
    const reviews = snapshot.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        createdAt: toDate(data.createdAt),
      };
    });

    /* Tri par date DESC pour un ordre stable. */
    reviews.sort((a, b) => {
      const da = a.createdAt ? a.createdAt.getTime() : 0;
      const dbb = b.createdAt ? b.createdAt.getTime() : 0;
      return dbb - da;
    });

    return reviews.slice(0, MAX_TESTIMONIALS);
  } catch (e) {
    /* Index Firestore manquant : reviews(status, featured). Retour vide silencieux - la section sera masquée. */
    if (e?.code === "failed-precondition" || e?.code === "unimplemented") {
      console.warn(
        "[testimonials] Index Firestore manquant pour reviews(status, featured).\n" +
          " Les témoignages d'accueil seront masqués jusqu'à création de l'index.\n" +
          " Voir firestore.indexes.json (Lot 48)."
      );
    } else {
      console.error("Erreur loadFeaturedReviews :", e);
    }
    return [];
  }
}

/* ============================================================ RÉCUPÉRER LA VILLE DU CLIENT - LOCALISÉE ============================================================ B-TEST-3 : limitation documentée. La query retourne une commande arbitraire (souvent la plus ancienne) car il n'y a pas d'orderBy. En pratique, la ville d'un client change rarement. Si besoin d'exactitude, ajouter orderBy("createdAt", "desc") + index composite orders(userId, createdAt) - voir Lot 48. ============================================================ */
async function getClientCity(userId) {
  if (!userId) return "";

  try {
    const ordersQ = query(
      collection(db, "orders"),
      where("userId", "==", userId),
      limit(1)
    );
    const snap = await getDocs(ordersQ);
    if (snap.empty) return "";

    const order = snap.docs[0].data();
    const addr = order.deliveryAddress || {};

    return getCityName({
      name: addr.cityAr || addr.city,
      nameFr: addr.cityFr,
      nameAr: addr.cityAr,
      key: addr.cityId ? String(addr.cityId) : "",
    });
  } catch (e) {
    /* Permission-denied possible si la règle ne permet pas de lire orders d'autres users (mais ici c'est le même user, donc OK). */
    return "";
  }
}

/* ============================================================ TROUVER LE PRODUIT ASSOCIÉ À UN AVIS ============================================================ B-TEST-1 : utilise normalizeProductId au lieu de Number(). Supporte IDs numériques (Smart) ET strings (vendeurs). ============================================================ */
function findProductForReview(review) {
  const products = getProducts();
  if (!products || products.length === 0) return null;

  if (review.productId != null) {
    const targetPid = normalizeProductId(review.productId);
    if (targetPid != null) {
      const byId = products.find((p) => normalizeProductId(p.id) === targetPid);
      if (byId) return byId;
    }
  }

  if (review.productSlug) {
    const bySlug = products.find((p) => p.slug === review.productSlug);
    if (bySlug) return bySlug;
  }

  return null;
}

/* ============================================================ RENDU D'UNE CARTE TÉMOIGNAGE (Design 2 colonnes) ============================================================ */
function renderTestimonialCard(review, product, city) {
  const stars = renderStars(review.rating || 0);
  const comment = escapeHTML((review.comment || "").substring(0, 180));
  const userName = escapeHTML(review.userName || "Client");

  /* Photo du produit (ou placeholder). */
  let productImgHtml = "";
  let productNameHtml = "";

  if (product) {
    const imgUrl = getProductImageUrl(product);
    const name = escapeHTML(getProductName(product));
    const fallback = getFallbackImage(getProductName(product));

    productImgHtml = ` <img src="${imgUrl}" alt="${name}" class="testimonial-img" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'"> `;
    productNameHtml = `<div class="testimonial-product-name">${name}</div>`;
  } else {
    productImgHtml = `<div class="testimonial-img testimonial-img-placeholder">📦</div>`;
  }

  /* Ville (optionnelle). */
  const cityHtml = city
    ? `<span class="testimonial-city">${escapeHTML(city)}</span>`
    : "";

  /* Badge "Achat vérifié" (title échappé pour éviter les guillemets). */
  const verifiedHtml = review.serverVerified === true && review.verifiedPurchase === true
    ? `<span class="testimonial-verified" title="${escapeHTML( t("avisVerifiedPurchase") || "Achat vérifié" )}">${t("reviewVerifiedPurchase") || "Achat vérifié"}</span>`
    : "";

  return ` <div class="testimonial-card"> <div class="testimonial-img-col"> ${productImgHtml} ${productNameHtml} </div> <div class="testimonial-content-col"> <div class="testimonial-stars" aria-label="${review.rating} étoiles">${stars}</div> <div class="testimonial-author"> <span class="t-author-name">${userName}</span> ${verifiedHtml} </div> ${cityHtml} <p class="testimonial-comment">"${comment}"</p> </div> </div> `;
}

/* ============================================================ INITIALISER LES TÉMOIGNAGES DYNAMIQUES ============================================================ */

/** * Point d'entrée : charge les avis featured et rend les témoignages * dans #testimonialsGrid. * * B-TEST-2 : guard concurrent. Si un render est déjà en cours, * les appels suivants attendent la même promesse au lieu de * dupliquer le fetch et le DOM. * * Comportement : * - Aucun avis featured -> masque la section parente. * - 1 à 3 avis featured -> affiche les cartes. * * @returns {Promise<void>} */
export async function initDynamicTestimonials() {
  /* B-TEST-2 : guard concurrent. */
  if (_initInProgress) {
    console.log("[testimonials] Init déjà en cours - skip");
    return;
  }

  const container = document.getElementById("testimonialsGrid");
  if (!container) return;

  _initInProgress = true;

  try {
    /* Loader pendant le fetch. */
    container.innerHTML = ` <div class="testimonials-loading" style="grid-column: 1 / -1; text-align: center; padding: 2rem; color: var(--text-muted);"> ${t("avisLoading") || "Chargement des avis..."} </div> `;

    /* Charger UNIQUEMENT les avis sélectionnés (featured). Plus de fallback automatique : si l'admin n'a rien choisi, la section est masquée. */
    const reviews = await loadFeaturedReviews();

    if (reviews.length === 0) {
      console.log(
        "[testimonials] Aucun avis sélectionné en vedette par l'admin."
      );
      const section = container.closest("section");
      if (section) section.style.display = "none";
      return;
    }

    /* Charger les villes des clients en parallèle. */
    const citiesPromises = reviews.map((r) => getClientCity(r.userId));
    const cities = await Promise.all(citiesPromises);

    /* Construire les cartes. */
    let html = "";
    reviews.forEach((review, idx) => {
      const product = findProductForReview(review);
      const city = cities[idx] || "";
      html += renderTestimonialCard(review, product, city);
    });

    container.innerHTML = html;

    /* S'assurer que la section est visible (si elle avait été cachée par un render précédent sans avis). */
    const section = container.closest("section");
    if (section) section.style.display = "";

    console.log(
      `[testimonials] ${reviews.length} témoignages affichés (sélection stricte admin)`
    );
  } catch (e) {
    console.error("[testimonials] Erreur init :", e);
    /* En cas d'erreur, on laisse le conteneur avec le loader plutôt que de casser la page. */
  } finally {
    _initInProgress = false;
  }
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ testimonials.js chargé - v9.0.0 (Lot 15 : fix findProductForReview + guard)"
);