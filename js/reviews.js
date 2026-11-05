/* ============================================================ js/reviews.js AVIS CLIENTS - SMART SWI9A Version 9.0.0 - Lot 13/30 : corrections critiques canReview CHANGEMENTS v9.0.0 : - B2 (P0) : canUserReviewProduct - en cas d'erreur de query (index manquant, réseau, permission), retourne { canReview: false, reason: 'check_failed' } au lieu de laisser passer l'utilisateur. Empêche les faux avis "Achat vérifié". - B3 (P1) : createReview - verifiedPurchase dérivé du check (check.verifiedPurchase === true), plus forcé à true. - B1 (P1) : trois index Firestore manquants détectés via error.code === 'failed-precondition' et loggés une seule fois par session (_reviewsIndexWarned / _ordersIndexWarned). Détail : voir Lot 48 firestore.indexes.json. - Dette (P2) : createReview appelle désormais deleteReviewRequestForOrder(check.orderId) pour nettoyer la notification review_request après dépôt d'avis. - Race (P2) : toggleFeaturedReview - documentation du risque de dépassement de MAX_FEATURED_REVIEWS en cas d'admin concurrent (rare, non corrigé : nécessiterait lock distribué). - Dead code : addDoc, writeBatch retirés des imports. - JSDoc sur 11 exports publics. - Bump version 2.1.0 -> 9.0.0. INDEX FIRESTORE REQUIS (à ajouter dans firestore.indexes.json) : 1. reviews(productId ASC, status ASC) - loadReviews, updateProductRating 2. reviews(status ASC, featured ASC) - toggleFeaturedReview, renderAdminReviews (count) 3. orders(userId ASC, status ASC) - canUserReviewProduct Sans ces index, les fonctions concernées basculent en mode dégradé (retour vide / refus de review) avec warning console. Une fois les index créés dans la console Firebase, tout redevient fonctionnel automatiquement (aucun redéploiement nécessaire). ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import {
  collection,
  setDoc,
  doc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
  arrayUnion,
  arrayRemove,
  increment,
  runTransaction,
  getCountFromServer,
} from "firebase/firestore";
import {
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "firebase/storage";
import { db, storage } from "./firebase.js";
import { CONFIG, REVIEW_STATUS } from "./config.js";
import {
  t,
  escapeHTML,
  renderStars,
  getStoragePathFromUrl,
  isStorageUrl,
  toDate,
} from "./utils.js";
import { getCurrentUser } from "./auth.js";
import { getProductById } from "./products.js";
import { showToast, confirmAction, openImageLightbox } from "./ui-core.js";

/* ============================================================ NORMALISATION D'ID PRODUIT ============================================================ - "42" (chaîne numérique) -> 42 (Number) - "abc123" (auto-ID Firestore vendeur) -> "abc123" (String) - null/undefined/"" -> null Doit rester IDENTIQUE à la version de products.js / product-detail.js / boutique.js / panier.js. ============================================================ */
function normalizeProductId(id) {
  if (id == null || id === "") return null;
  const n = Number(id);
  return Number.isFinite(n) && String(n) === String(id) ? n : String(id);
}

/* ============================================================ CONSTANTE : Nombre max de témoignages en vedette ============================================================ */
const MAX_FEATURED_REVIEWS = 3;

/* ============================================================ ÉTAT : WARNING INDEX FIRESTORE (B1) ============================================================ Empêche de spammer la console si un index manque et qu'une fonction est appelée plusieurs fois. ============================================================ */
let _reviewsIndexWarned = false;
let _ordersIndexWarned = false;

function _warnMissingReviewsIndex(context, err) {
  if (_reviewsIndexWarned) return;
  _reviewsIndexWarned = true;
  console.warn(
    "[reviews] Index Firestore manquant pour la collection reviews.\n" +
      " Contexte : " +
      context +
      "\n" +
      " Index requis :\n" +
      " - reviews(productId ASC, status ASC)\n" +
      " - reviews(status ASC, featured ASC)\n" +
      " Action : ajouter dans firestore.indexes.json (Lot 48) puis\n" +
      " exécuter `firebase deploy --only firestore:indexes`.\n" +
      " Le lien de création auto est souvent présent dans le message\n" +
      " d'erreur Firebase ci-dessous :",
    err?.message || err
  );
}

function _warnMissingOrdersIndex(context, err) {
  if (_ordersIndexWarned) return;
  _ordersIndexWarned = true;
  console.warn(
    "[reviews] Index Firestore manquant pour la collection orders.\n" +
      " Contexte : " +
      context +
      "\n" +
      " Index requis : orders(userId ASC, status ASC)\n" +
      " Action : ajouter dans firestore.indexes.json (Lot 48).\n" +
      " Détail :",
    err?.message || err
  );
}

/* ============================================================ CHARGER LES AVIS D'UN PRODUIT (public) ============================================================ */

/** * Charge les avis d'un produit. * @param {number|string} productId * @param {boolean} [onlyApproved=true] - Si true, ne charge que les approuvés. * @returns {Promise<Array>} Liste d'avis triés du plus récent au plus ancien. */
export async function loadReviews(productId, onlyApproved = true) {
  const pid = normalizeProductId(productId);
  if (pid == null) return [];

  try {
    let q;
    if (onlyApproved) {
      q = query(
        collection(db, "reviews"),
        where("productId", "==", pid),
        where("status", "==", REVIEW_STATUS.APPROVED)
      );
    } else {
      q = query(collection(db, "reviews"), where("productId", "==", pid));
    }

    const snapshot = await getDocs(q);
    const reviews = snapshot.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        createdAt: toDate(data.createdAt),
        approvedAt: data.approvedAt ? toDate(data.approvedAt) : null,
        rejectedAt: data.rejectedAt ? toDate(data.rejectedAt) : null,
      };
    });

    reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return reviews;
  } catch (e) {
    /* B1 : index manquant -> warning une fois + retour vide. */
    if (e?.code === "failed-precondition" || e?.code === "unimplemented") {
      _warnMissingReviewsIndex("loadReviews", e);
    } else {
      console.error("Erreur loadReviews :", e);
    }
    return [];
  }
}

/* ============================================================ CHARGER TOUS LES AVIS (ADMIN) - Version optimisée ============================================================ */

/** * Charge les avis pour l'admin (tous statuts). * Limité à 100 avis les plus récents (pas de pagination implémentée). * * @param {string|null} [statusFilter=null] - 'pending' | 'approved' | 'rejected' | 'all' | null. * @returns {Promise<Array>} */
export async function loadAllReviews(statusFilter = null) {
  try {
    let q;
    if (statusFilter && statusFilter !== "all") {
      q = query(
        collection(db, "reviews"),
        where("status", "==", statusFilter),
        orderBy("createdAt", "desc"),
        limit(100)
      );
    } else {
      q = query(
        collection(db, "reviews"),
        orderBy("createdAt", "desc"),
        limit(100)
      );
    }
    const snapshot = await getDocs(q);
    const reviews = snapshot.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        createdAt: toDate(data.createdAt),
      };
    });
    return reviews;
  } catch (e) {
    console.error("Erreur loadAllReviews :", e);
    return [];
  }
}

/* ============================================================ VÉRIFIER SI L'UTILISATEUR PEUT LAISSER UN AVIS ============================================================ B2 : NE JAMAIS retourner canReview: true sur erreur de query. B3 : Retourne verifiedPurchase: true (dérivé du check) + orderId pour permettre le nettoyage de la notification review_request. ============================================================ */

/** * Vérifie si l'utilisateur courant peut laisser un avis sur un produit. * * Signatures de retour : * - { canReview: false, reason: 'not_logged' } * - { canReview: false, reason: 'invalid_product' } * - { canReview: false, reason: 'already_reviewed' } * - { canReview: false, reason: 'not_purchased' } * - { canReview: false, reason: 'check_failed', error } * - { canReview: true, reason: 'ok', verifiedPurchase: true, orderId } * * @param {number|string} productId * @returns {Promise<Object>} */
export async function canUserReviewProduct(productId) {
  const user = getCurrentUser();
  if (!user) return { canReview: false, reason: "not_logged" };

  const pid = normalizeProductId(productId);
  if (pid == null) return { canReview: false, reason: "invalid_product" };

  /* 1. Vérifier si l'avis existe déjà. */
  const reviewId = `review_${user.uid}_${pid}`;

  const token = await user.getIdToken();
  const response = await fetch("/api/createVerifiedReview", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      productId: String(pid),
      rating: Number(rating),
      title: (title || "").substring(0, 80),
      comment: (comment || "").substring(0, 500),
      photos: photoUrls
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true) {
    throw new Error(result.message || "Impossible de publier cet avis.");
  }
  console.log("Avis créé :", result.reviewId || reviewId);

  /* Dette : nettoyer la notification review_request liée à la commande. Non bloquant. */
  if (check.orderId) {
    try {
      const { deleteReviewRequestForOrder } = await import(
        "./notifications.js"
      );
      await deleteReviewRequestForOrder(result.orderId);
    } catch (e) {
      console.warn(
        "Nettoyage notification review_request échoué :",
        e?.message || e
      );
    }
  }

  try {
    document.dispatchEvent(
      new CustomEvent("review-submitted", {
        detail: { productId: pid, reviewId: result.reviewId || reviewId, orderId: result.orderId || null },
      })
    );
  } catch (e) {
    /* ignore */
  }

  return reviewId;
}

/* ============================================================ AJOUTER / RETIRER UN AVIS DES TÉMOIGNAGES (ADMIN) ============================================================ Race (P2) : si 2 admins cliquent simultanément sur "feature", ils peuvent tous deux voir featuredSnap.size < 3 et dépasser MAX_FEATURED_REVIEWS. Corriger nécessiterait un lock distribué (non implémenté). Rare en pratique (peu d'admins, action peu fréquente). ============================================================ */

/** * Ajoute ou retire un avis des témoignages d'accueil. * @param {string} reviewId * @returns {Promise<{ success: boolean, featured?: boolean, error?: string, maxReached?: boolean }>} */
export async function toggleFeaturedReview(reviewId) {
  try {
    const featuredQ = query(
      collection(db, "reviews"),
      where("status", "==", REVIEW_STATUS.APPROVED),
      where("featured", "==", true)
    );
    const featuredSnap = await getDocs(featuredQ);

    return await runTransaction(db, async (transaction) => {
      const reviewRef = doc(db, "reviews", reviewId);
      const reviewSnap = await transaction.get(reviewRef);
      if (!reviewSnap.exists()) throw new Error(t("loadError"));

      const review = reviewSnap.data();
      if (review.status !== REVIEW_STATUS.APPROVED) {
        return { success: false, error: t("reviewPendingApproval") };
      }

      const isCurrentlyFeatured = review.featured === true;

      if (isCurrentlyFeatured) {
        transaction.update(reviewRef, { featured: false });
        return { success: true, featured: false };
      } else {
        if (featuredSnap.size >= MAX_FEATURED_REVIEWS) {
          return {
            success: false,
            error: `Maximum ${MAX_FEATURED_REVIEWS} avis. Désactivez-en un d'abord.`,
            maxReached: true,
          };
        }
        transaction.update(reviewRef, { featured: true });
        return { success: true, featured: true };
      }
    });
  } catch (e) {
    /* B1 : index manquant pour la query featured. */
    if (e?.code === "failed-precondition" || e?.code === "unimplemented") {
      _warnMissingReviewsIndex("toggleFeaturedReview", e);
    } else {
      console.error("Erreur toggleFeaturedReview :", e);
    }
    return { success: false, error: e.message };
  }
}

/* ============================================================ APPROUVER UN AVIS (ADMIN) ============================================================ */

/** * Approuve un avis (statut -> 'approved'). * Recalcule la note moyenne du produit et notifie l'auteur. * @param {string} reviewId * @returns {Promise<{ success: boolean, error?: string }>} */
export async function approveReview(reviewId) {
  try {
    const reviewRef = doc(db, "reviews", reviewId);
    const reviewSnap = await getDoc(reviewRef);
    if (!reviewSnap.exists()) throw new Error(t("loadError"));

    const review = reviewSnap.data();

    await updateDoc(reviewRef, {
      status: REVIEW_STATUS.APPROVED,
      approvedAt: Timestamp.now(),
    });

    await updateProductRatingWithRetry(review.productId);

    try {
      const { createNotification } = await import("./notifications.js");
      await createNotification(
        review.userId,
        "review_approved",
        t("notificationReviewApproved"),
        t("notificationReviewApprovedMsg").replace(
          "{product}",
          review.productSlug || "—"
        ),
        { productSlug: review.productSlug }
      );
    } catch (e) {
      console.warn("Notification avis échouée :", e);
    }

    return { success: true };
  } catch (e) {
    console.error("Erreur approveReview :", e);
    return { success: false, error: e.message };
  }
}

/* ============================================================ REJETER UN AVIS (ADMIN) ============================================================ */

/** * Rejette un avis (statut -> 'rejected', featured -> false). * @param {string} reviewId * @returns {Promise<{ success: boolean, error?: string }>} */
export async function rejectReview(reviewId) {
  try {
    await updateDoc(doc(db, "reviews", reviewId), {
      status: REVIEW_STATUS.REJECTED,
      rejectedAt: Timestamp.now(),
      featured: false,
    });
    return { success: true };
  } catch (e) {
    console.error("Erreur rejectReview :", e);
    return { success: false, error: e.message };
  }
}

/* ============================================================ SUPPRIMER UN AVIS (ADMIN) ============================================================ */

/** * Supprime un avis et ses photos Storage. * Recalcule la note moyenne du produit. * @param {string} reviewId * @returns {Promise<{ success: boolean, error?: string }>} */
export async function deleteReview(reviewId) {
  try {
    const reviewRef = doc(db, "reviews", reviewId);
    const snap = await getDoc(reviewRef);
    if (!snap.exists()) throw new Error(t("loadError"));

    const review = snap.data();

    if (review.photos && review.photos.length > 0) {
      const deletePromises = review.photos.map(async (url) => {
        if (!isStorageUrl(url)) return;
        const path = getStoragePathFromUrl(url);
        if (!path) return;
        try {
          await deleteObject(ref(storage, path));
        } catch (e) {
          /* ignore */
        }
      });
      await Promise.allSettled(deletePromises);
    }

    await deleteDoc(reviewRef);
    await updateProductRatingWithRetry(review.productId);

    try {
      document.dispatchEvent(
        new CustomEvent("review-deleted", {
          detail: { productId: review.productId, reviewId },
        })
      );
    } catch (e) {
      /* ignore */
    }

    return { success: true };
  } catch (e) {
    console.error("Erreur deleteReview :", e);
    return { success: false, error: e.message };
  }
}

/* ============================================================ RECALCULER LA MOYENNE D'UN PRODUIT ============================================================ */

/** * Recalcule ratingAvg + ratingCount d'un produit à partir * de tous ses avis approuvés. * @param {number|string} productId * @returns {Promise<{ ratingAvg: number, ratingCount: number } | null>} */
export async function updateProductRating(productId) {
  const pid = normalizeProductId(productId);
  if (pid == null) return null;

  try {
    const q = query(
      collection(db, "reviews"),
      where("productId", "==", pid),
      where("status", "==", REVIEW_STATUS.APPROVED)
    );
    const snap = await getDocs(q);
    const reviews = snap.docs.map((d) => d.data());

    const ratingCount = reviews.length;
    const ratingAvg =
      ratingCount > 0
        ? Number(
            (
              reviews.reduce((s, r) => s + (r.rating || 0), 0) / ratingCount
            ).toFixed(1)
          )
        : 0;

    const productRef = doc(db, "products", String(pid));
    const productSnap = await getDoc(productRef);

    if (!productSnap.exists()) {
      console.warn(`Produit ${pid} introuvable, rating non mis à jour`);
      return null;
    }

    await updateDoc(productRef, { ratingAvg, ratingCount });
    return { ratingAvg, ratingCount };
  } catch (e) {
    /* B1 : index manquant. */
    if (e?.code === "failed-precondition" || e?.code === "unimplemented") {
      _warnMissingReviewsIndex("updateProductRating", e);
    } else {
      console.error("Erreur updateProductRating :", e);
    }
    return null;
  }
}

/** * Wrapper avec retry (max 3 tentatives, backoff linéaire). * Évite les désynchronisations transitoires. */
async function updateProductRatingWithRetry(productId, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await updateProductRating(productId);
      if (result) return result;
    } catch (e) {
      if (i < maxRetries - 1)
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

/* ============================================================ TOGGLE LIKE (transaction atomique) ============================================================ */

/** * Ajoute ou retire un like sur un avis (transaction Firestore). * @param {string} reviewId * @returns {Promise<{ liked: boolean, count: number }>} * @throws {Error} si non connecté ou avis introuvable. */
export async function toggleLike(reviewId) {
  const user = getCurrentUser();
  if (!user) throw new Error(t("loginRequired"));

  const reviewRef = doc(db, "reviews", reviewId);

  return await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(reviewRef);
    if (!snap.exists()) throw new Error(t("loadError"));

    const review = snap.data();
    const likes = review.likes || [];
    const hasLiked = likes.includes(user.uid);

    if (hasLiked) {
      transaction.update(reviewRef, {
        likes: arrayRemove(user.uid),
        likesCount: increment(-1),
      });
      return { liked: false, count: Math.max(0, (review.likesCount || 0) - 1) };
    } else {
      transaction.update(reviewRef, {
        likes: arrayUnion(user.uid),
        likesCount: increment(1),
      });
      return { liked: true, count: (review.likesCount || 0) + 1 };
    }
  });
}

/* ============================================================ RENDU ADMIN DES AVIS (Optimisé) ============================================================ */

/** * Rendu complet de la section "Avis" du panneau admin. * @param {string} [containerId='reviewsList'] * @param {string} [statusFilter='all'] * @returns {Promise<void>} */
export async function renderAdminReviews( containerId = "reviewsList", statusFilter = "all" ) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">${t( "loadingReviews" )}</div>`;

  try {
    const filteredReviews = await loadAllReviews(statusFilter);

    const [
      pendingCount,
      approvedCount,
      rejectedCount,
      featuredCount,
      totalCount,
    ] = await Promise.allSettled([
      getCountFromServer(
        query(collection(db, "reviews"), where("status", "==", "pending"))
      ),
      getCountFromServer(
        query(collection(db, "reviews"), where("status", "==", "approved"))
      ),
      getCountFromServer(
        query(collection(db, "reviews"), where("status", "==", "rejected"))
      ),
      getCountFromServer(
        query(
          collection(db, "reviews"),
          where("status", "==", "approved"),
          where("featured", "==", true)
        )
      ),
      getCountFromServer(collection(db, "reviews")),
    ]);

    /* Si le count featured échoue (index manquant), on log un warning une seule fois. */
    if (featuredCount.status === "rejected") {
      _warnMissingReviewsIndex(
        "renderAdminReviews (count featured)",
        featuredCount.reason
      );
    }

    const counts = {
      pending:
        pendingCount.status === "fulfilled"
          ? pendingCount.value?.data()?.count || 0
          : 0,
      approved:
        approvedCount.status === "fulfilled"
          ? approvedCount.value?.data()?.count || 0
          : 0,
      rejected:
        rejectedCount.status === "fulfilled"
          ? rejectedCount.value?.data()?.count || 0
          : 0,
      featured:
        featuredCount.status === "fulfilled"
          ? featuredCount.value?.data()?.count || 0
          : 0,
      all:
        totalCount.status === "fulfilled"
          ? totalCount.value?.data()?.count || 0
          : 0,
    };

    if (counts.all === 0) {
      container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:2rem;">${t( "noReviews" )}</p>`;
      return;
    }

    let html = ` <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1rem;"> <button class="filter-btn ${ statusFilter === "all" ? "active" : "" }" data-review-filter="all">${t("filterAll")} (${ counts.all })</button> <button class="filter-btn ${ statusFilter === "pending" ? "active" : "" }" data-review-filter="pending">${t("reviewStatusPending")} (${ counts.pending })</button> <button class="filter-btn ${ statusFilter === "approved" ? "active" : "" }" data-review-filter="approved">${t( "reviewStatusApproved" )} (${counts.approved})</button> <button class="filter-btn ${ statusFilter === "rejected" ? "active" : "" }" data-review-filter="rejected">${t( "reviewStatusRejected" )} (${counts.rejected})</button> </div> <div style="background:rgba(var(--gold-rgb), 0.08);border:1px solid var(--border-gold);border-radius:var(--radius-sm);padding:0.7rem 1rem;margin-bottom:1rem;font-size:0.82rem;color:var(--text-muted);display:flex;align-items:center;gap:0.5rem;"> <strong style="color:var(--gold);">En vedette sur l'accueil :</strong> <span style="font-weight:700;color:var(--gold);">${ counts.featured } / ${MAX_FEATURED_REVIEWS}</span> </div> <div id="reviewsListContent"></div> `;
    container.innerHTML = html;

    container.querySelectorAll("[data-review-filter]").forEach((btn) => {
      btn.addEventListener("click", () =>
        renderAdminReviews(containerId, btn.dataset.reviewFilter)
      );
    });

    const listEl = document.getElementById("reviewsListContent");
    if (filteredReviews.length === 0) {
      listEl.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:1rem;">${t( "noReviews" )}</p>`;
      return;
    }

    let listHtml = "";
    filteredReviews.forEach((r) => {
      const statusClass =
        r.status === "approved"
          ? "admin-review-approved"
          : r.status === "rejected"
          ? "admin-review-rejected"
          : "admin-review-pending";
      const statusEmoji =
        r.status === "approved" ? "🟢" : r.status === "rejected" ? "🔴" : "🟡";
      const dateStr = r.createdAt
        ? new Date(r.createdAt).toLocaleDateString("fr-FR")
        : "";
      const stars = renderStars(r.rating || 0);
      const isFeatured = r.featured === true;
      const isApproved = r.status === REVIEW_STATUS.APPROVED;
      const safeId = escapeHTML(r.id);

      const featureBtnHtml = isApproved
        ? `<button class="btn-feature ${ isFeatured ? "active" : "" }" data-action="review:toggle-featured" data-id="${safeId}"> ${ isFeatured ? "Retirer de l'accueil" : "Afficher sur l'accueil" } </button>`
        : "";

      const featuredBadge = isFeatured
        ? `<span class="featured-badge">Accueil</span>`
        : "";

      listHtml += ` <div class="admin-review-item ${statusClass} ${ isFeatured ? "is-featured" : "" }" style="flex-direction:column;align-items:stretch;background:var(--bg-surface);border-radius:var(--radius-sm);padding:1rem;margin-bottom:0.8rem;border:1px solid var(--border);"> <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.5rem;"> <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;"> <strong style="color:var(--gold);">${statusEmoji} ${escapeHTML( r.userName || "Anonyme" )}</strong> ${ r.verifiedPurchase ? `<span class="review-verified-badge">${t( "reviewVerifiedPurchase" )}</span>` : "" } ${featuredBadge} </div> <small style="color:var(--text-muted);">${dateStr}</small> </div> <div style="color:var(--gold);margin-bottom:0.3rem;">${stars}</div> ${ r.title ? `<div style="font-weight:700;font-size:0.95rem;margin-bottom:0.3rem;">${escapeHTML( r.title )}</div>` : "" } <div style="font-size:0.9rem;color:var(--text-muted);margin-bottom:0.5rem;">${escapeHTML( r.comment || "" )}</div> ${ r.photos && r.photos.length > 0 ? ` <div class="review-photos" style="margin-bottom:0.6rem;"> ${r.photos .map( (url) => `<img src="${escapeHTML( url )}" alt="Photo avis" data-photo-url="${escapeHTML( url )}" style="cursor:pointer;">` ) .join("")} </div> ` : "" } <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:0.5rem;"> ${t("product")} : ${escapeHTML( r.productSlug || "N/A" )} - ${r.likesCount || 0} likes </div> <div class="admin-review-actions"> ${ r.status === REVIEW_STATUS.PENDING ? ` <button class="btn-approve" data-action="review:approve" data-id="${safeId}">${t( "verifyButton" )}</button> <button class="btn-reject" data-action="review:reject" data-id="${safeId}">${t( "reviewStatusRejected" )}</button> ` : "" } ${featureBtnHtml} <button class="btn-danger" data-action="review:delete" data-id="${safeId}" style="padding:0.4rem 1rem;border-radius:30px;background:var(--danger);color:white;border:none;cursor:pointer;font-size:0.8rem;">${t( "delete" )}</button> </div> </div> `;
    });
    listEl.innerHTML = listHtml;

    listEl.querySelectorAll('[data-action="review:approve"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const result = await approveReview(btn.dataset.id);
        if (result.success) {
          showToast(t("success"));
          renderAdminReviews(containerId, statusFilter);
        } else {
          showToast(result.error);
        }
      });
    });

    listEl.querySelectorAll('[data-action="review:reject"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const result = await rejectReview(btn.dataset.id);
        if (result.success) {
          showToast(t("reviewStatusRejected"));
          renderAdminReviews(containerId, statusFilter);
        }
      });
    });

    listEl
      .querySelectorAll('[data-action="review:toggle-featured"]')
      .forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          const originalText = btn.textContent;
          btn.textContent = "...";
          const result = await toggleFeaturedReview(btn.dataset.id);
          if (result.success) {
            showToast(
              result.featured ? "Ajouté à l'accueil" : "Retiré de l'accueil"
            );
            renderAdminReviews(containerId, statusFilter);
          } else {
            showToast(result.error);
            btn.disabled = false;
            btn.textContent = originalText;
          }
        });
      });

    listEl.querySelectorAll('[data-action="review:delete"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const confirmed = await confirmAction(t("confirmDeleteReviewMsg"), {
          title: t("confirmDeleteReviewTitle"),
          confirmText: t("confirmDeleteYes"),
          cancelText: t("confirmDeleteNo"),
          variant: "danger",
        });
        if (!confirmed) return;
        const result = await deleteReview(btn.dataset.id);
        if (result.success) {
          showToast(t("delete"));
          renderAdminReviews(containerId, statusFilter);
        } else {
          showToast(result.error);
        }
      });
    });

    listEl.querySelectorAll("img[data-photo-url]").forEach((img) => {
      img.addEventListener("click", () =>
        openImageLightbox(img.dataset.photoUrl)
      );
    });
  } catch (e) {
    console.error("Erreur renderAdminReviews :", e);
    container.innerHTML = `<p style="text-align:center;color:var(--danger);">${t( "loadingError" )}</p>`;
  }
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ reviews.js chargé - v9.0.0 (Lot 13 : B2 canReview + B3 verifiedPurchase + B1 index warnings)"
);