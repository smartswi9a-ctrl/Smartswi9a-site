// js/reviews.js
// ============================================================
// AVIS CLIENTS - SMART SWI9A
// Version 2.1.0 — Fix IDs strings vendeurs (P1-a)
//   - normalizeProductId : supporte IDs Firestore auto (produits vendeurs)
//   - reviewId déterministe : review_<uid>_<normalizedPid>
//   - loadReviews / canUserReviewProduct / updateProductRating adaptés
//   - Comparaisons via String() pour mixed types
// ============================================================

import {
    collection, addDoc, setDoc, doc, updateDoc, deleteDoc, getDoc, getDocs,
    query, where, orderBy, limit, Timestamp, arrayUnion, arrayRemove, increment,
    runTransaction, writeBatch, getCountFromServer
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { db, storage } from "./firebase.js";
import { CONFIG, REVIEW_STATUS } from "./config.js";
import {
    t, escapeHTML, renderStars,
    getStoragePathFromUrl, isStorageUrl, toDate
} from "./utils.js";
import { getCurrentUser } from "./auth.js";
import { getProductById } from "./products.js";
import { showToast, confirmAction, openImageLightbox } from "./ui-core.js";

// ============================================================
// NORMALISATION D'ID PRODUIT
// - "42" (chaîne numérique) → 42 (Number) — compat favoris/avis historiques
// - "abc123" (auto-ID Firestore vendeur) → "abc123" (String)
// - null/undefined/"" → null
// Doit rester IDENTIQUE à la version de products.js / product-detail.js / boutique.js
// ============================================================
function normalizeProductId(id) {
    if (id == null || id === '') return null;
    const n = Number(id);
    return Number.isFinite(n) && String(n) === String(id) ? n : String(id);
}

// ============================================================
// CONSTANTE : Nombre max de témoignages en vedette
// ============================================================
const MAX_FEATURED_REVIEWS = 3;

// ============================================================
// CHARGER LES AVIS D'UN PRODUIT (public)
// ============================================================
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
            q = query(
                collection(db, "reviews"),
                where("productId", "==", pid)
            );
        }

        const snapshot = await getDocs(q);
        const reviews = snapshot.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                createdAt: toDate(data.createdAt),
                approvedAt: data.approvedAt ? toDate(data.approvedAt) : null,
                rejectedAt: data.rejectedAt ? toDate(data.rejectedAt) : null
            };
        });

        reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return reviews;
    } catch (e) {
        console.error('❌ Erreur loadReviews :', e);
        return [];
    }
}

// ============================================================
// CHARGER TOUS LES AVIS (ADMIN) — Version optimisée
// ============================================================
export async function loadAllReviews(statusFilter = null) {
    try {
        let q;
        if (statusFilter && statusFilter !== 'all') {
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
        const reviews = snapshot.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                createdAt: toDate(data.createdAt)
            };
        });
        return reviews;
    } catch (e) {
        console.error('❌ Erreur loadAllReviews :', e);
        return [];
    }
}

// ============================================================
// VÉRIFIER SI L'UTILISATEUR PEUT LAISSER UN AVIS
// ============================================================
export async function canUserReviewProduct(productId) {
    const user = getCurrentUser();
    if (!user) return { canReview: false, reason: 'not_logged' };

    const pid = normalizeProductId(productId);
    if (pid == null) return { canReview: false, reason: 'invalid_product' };

    // ID déterministe (support IDs Number ET String)
    const reviewId = `review_${user.uid}_${pid}`;
    const reviewSnap = await getDoc(doc(db, "reviews", reviewId));
    if (reviewSnap.exists()) {
        return { canReview: false, reason: 'already_reviewed' };
    }

    try {
        const ordersQ = query(
            collection(db, "orders"),
            where("userId", "==", user.uid),
            where("status", "in", ["delivered", "received"]),
            limit(20)
        );
        const ordersSnap = await getDocs(ordersQ);
        const targetStr = String(pid);
        const hasReceived = ordersSnap.docs.some(d => {
            const order = d.data();
            return order.items?.some(it => String(it.productId) === targetStr);
        });

        if (!hasReceived) {
            return { canReview: false, reason: 'not_purchased' };
        }
    } catch (e) {
        console.warn('⚠️ Vérification achat impossible :', e);
    }

    return { canReview: true, reason: 'ok' };
}

// ============================================================
// CRÉER UN AVIS (Anti-doublons avec setDoc)
// ============================================================
export async function createReview(productId, { rating, title, comment, photoFiles = [] }) {
    const user = getCurrentUser();
    if (!user) throw new Error(t('loginRequired'));

    const pid = normalizeProductId(productId);
    if (pid == null) throw new Error(t('productNotFound'));

    const product = getProductById(pid);
    if (!product) throw new Error(t('productNotFound'));

    if (!rating || rating < 1 || rating > 5) throw new Error('Veuillez sélectionner une note.');
    if (!comment || !comment.trim()) throw new Error('Veuillez écrire un commentaire.');

    const check = await canUserReviewProduct(pid);
    if (!check.canReview) {
        if (check.reason === 'already_reviewed') throw new Error(t('reviewAlreadyExists'));
        if (check.reason === 'not_purchased') throw new Error(t('reviewOnlyAfterOrder'));
        throw new Error(t('loginRequired'));
    }

    const photoUrls = [];
    const files = (photoFiles || []).slice(0, CONFIG.REVIEWS.MAX_PHOTOS);

    const uploadPromises = files.map(async (file) => {
        const fileName = `reviews/${pid}_${user.uid}_${Date.now()}_${file.name}`;
        const storageRef = ref(storage, fileName);
        await uploadBytes(storageRef, file);
        return await getDownloadURL(storageRef);
    });

    try {
        const results = await Promise.all(uploadPromises);
        results.forEach(url => { if (url) photoUrls.push(url); });
    } catch (e) {
        console.warn('⚠️ Erreur upload photo avis :', e);
        throw new Error("Erreur lors de l'upload des photos.");
    }

    const reviewId = `review_${user.uid}_${pid}`;
    const reviewData = {
        productId: pid,                                  // Number (Smart) ou String (vendeur)
        productSlug: product.slug || '',
        userId: user.uid,
        userName: user.name || user.email || 'Anonyme',
        rating: Number(rating),
        title: (title || '').substring(0, 80),
        comment: (comment || '').substring(0, 500),
        photos: photoUrls,
        status: REVIEW_STATUS.PENDING,
        verifiedPurchase: true,
        likes: [],
        likesCount: 0,
        featured: false,
        createdAt: Timestamp.now()
    };

    await setDoc(doc(db, "reviews", reviewId), reviewData);
    console.log('✅ Avis créé :', reviewId);

    try {
        document.dispatchEvent(new CustomEvent('review-submitted', {
            detail: { productId: pid, reviewId }
        }));
    } catch (e) { }

    return reviewId;
}

// ============================================================
// AJOUTER / RETIRER UN AVIS DES TÉMOIGNAGES (ADMIN)
// ============================================================
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
            if (!reviewSnap.exists()) throw new Error(t('loadError'));

            const review = reviewSnap.data();
            if (review.status !== REVIEW_STATUS.APPROVED) {
                return { success: false, error: t('reviewPendingApproval') };
            }

            const isCurrentlyFeatured = review.featured === true;

            if (isCurrentlyFeatured) {
                transaction.update(reviewRef, { featured: false });
                return { success: true, featured: false };
            } else {
                if (featuredSnap.size >= MAX_FEATURED_REVIEWS) {
                    return { success: false, error: `Maximum ${MAX_FEATURED_REVIEWS} avis. Désactivez-en un d'abord.`, maxReached: true };
                }
                transaction.update(reviewRef, { featured: true });
                return { success: true, featured: true };
            }
        });
    } catch (e) {
        console.error('❌ Erreur toggleFeaturedReview :', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// APPROUVER UN AVIS (ADMIN)
// ============================================================
export async function approveReview(reviewId) {
    try {
        const reviewRef = doc(db, "reviews", reviewId);
        const reviewSnap = await getDoc(reviewRef);
        if (!reviewSnap.exists()) throw new Error(t('loadError'));

        const review = reviewSnap.data();

        await updateDoc(reviewRef, {
            status: REVIEW_STATUS.APPROVED,
            approvedAt: Timestamp.now()
        });

        await updateProductRatingWithRetry(review.productId);

        try {
            const { createNotification } = await import("./notifications.js");
            await createNotification(
                review.userId,
                'review_approved',
                t('notificationReviewApproved'),
                t('notificationReviewApprovedMsg').replace('{product}', review.productSlug || '—'),
                { productSlug: review.productSlug }
            );
        } catch (e) {
            console.warn('⚠️ Notification avis échouée :', e);
        }

        return { success: true };
    } catch (e) {
        console.error('❌ Erreur approveReview :', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// REJETER UN AVIS (ADMIN)
// ============================================================
export async function rejectReview(reviewId) {
    try {
        await updateDoc(doc(db, "reviews", reviewId), {
            status: REVIEW_STATUS.REJECTED,
            rejectedAt: Timestamp.now(),
            featured: false
        });
        return { success: true };
    } catch (e) {
        console.error('❌ Erreur rejectReview :', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// SUPPRIMER UN AVIS (ADMIN)
// ============================================================
export async function deleteReview(reviewId) {
    try {
        const reviewRef = doc(db, "reviews", reviewId);
        const snap = await getDoc(reviewRef);
        if (!snap.exists()) throw new Error(t('loadError'));

        const review = snap.data();

        if (review.photos && review.photos.length > 0) {
            const deletePromises = review.photos.map(async (url) => {
                if (!isStorageUrl(url)) return;
                const path = getStoragePathFromUrl(url);
                if (!path) return;
                try { await deleteObject(ref(storage, path)); } catch (e) { }
            });
            await Promise.allSettled(deletePromises);
        }

        await deleteDoc(reviewRef);
        await updateProductRatingWithRetry(review.productId);

        try {
            document.dispatchEvent(new CustomEvent('review-deleted', {
                detail: { productId: review.productId, reviewId }
            }));
        } catch (e) { }

        return { success: true };
    } catch (e) {
        console.error('❌ Erreur deleteReview :', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// RECALCULER LA MOYENNE D'UN PRODUIT
// ============================================================
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
        const reviews = snap.docs.map(d => d.data());

        const ratingCount = reviews.length;
        const ratingAvg = ratingCount > 0
            ? Number((reviews.reduce((s, r) => s + (r.rating || 0), 0) / ratingCount).toFixed(1))
            : 0;

        const productRef = doc(db, "products", String(pid));
        const productSnap = await getDoc(productRef);

        if (!productSnap.exists()) {
            console.warn(`⚠️ Produit ${pid} introuvable, rating non mis à jour`);
            return null;
        }

        await updateDoc(productRef, { ratingAvg, ratingCount });
        return { ratingAvg, ratingCount };
    } catch (e) {
        console.error('❌ Erreur updateProductRating :', e);
        return null;
    }
}

// Helper avec retry pour éviter les désynchronisations
async function updateProductRatingWithRetry(productId, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const result = await updateProductRating(productId);
            if (result) return result;
        } catch (e) {
            if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
}

// ============================================================
// TOGGLE LIKE (Correction Race Condition)
// ============================================================
export async function toggleLike(reviewId) {
    const user = getCurrentUser();
    if (!user) throw new Error(t('loginRequired'));

    const reviewRef = doc(db, "reviews", reviewId);

    return await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(reviewRef);
        if (!snap.exists()) throw new Error(t('loadError'));

        const review = snap.data();
        const likes = review.likes || [];
        const hasLiked = likes.includes(user.uid);

        if (hasLiked) {
            transaction.update(reviewRef, {
                likes: arrayRemove(user.uid),
                likesCount: increment(-1)
            });
            return { liked: false, count: Math.max(0, (review.likesCount || 0) - 1) };
        } else {
            transaction.update(reviewRef, {
                likes: arrayUnion(user.uid),
                likesCount: increment(1)
            });
            return { liked: true, count: (review.likesCount || 0) + 1 };
        }
    });
}

// ============================================================
// RENDU ADMIN DES AVIS (Optimisé)
// ============================================================
export async function renderAdminReviews(containerId = 'reviewsList', statusFilter = 'all') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">⏳ ${t('loadingReviews')}</div>`;

    try {
        const filteredReviews = await loadAllReviews(statusFilter);

        const [pendingCount, approvedCount, rejectedCount, featuredCount, totalCount] = await Promise.allSettled([
            getCountFromServer(query(collection(db, "reviews"), where("status", "==", "pending"))),
            getCountFromServer(query(collection(db, "reviews"), where("status", "==", "approved"))),
            getCountFromServer(query(collection(db, "reviews"), where("status", "==", "rejected"))),
            getCountFromServer(query(collection(db, "reviews"), where("status", "==", "approved"), where("featured", "==", true))),
            getCountFromServer(collection(db, "reviews"))
        ]);

        const counts = {
            pending: pendingCount.value?.data().count || 0,
            approved: approvedCount.value?.data().count || 0,
            rejected: rejectedCount.value?.data().count || 0,
            featured: featuredCount.value?.data().count || 0,
            all: totalCount.value?.data().count || 0
        };

        if (counts.all === 0) {
            container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:2rem;">${t('noReviews')}</p>`;
            return;
        }

        let html = `
            <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1rem;">
                <button class="filter-btn ${statusFilter === 'all' ? 'active' : ''}" data-review-filter="all">${t('filterAll')} (${counts.all})</button>
                <button class="filter-btn ${statusFilter === 'pending' ? 'active' : ''}" data-review-filter="pending">🟡 ${t('reviewStatusPending')} (${counts.pending})</button>
                <button class="filter-btn ${statusFilter === 'approved' ? 'active' : ''}" data-review-filter="approved">🟢 ${t('reviewStatusApproved')} (${counts.approved})</button>
                <button class="filter-btn ${statusFilter === 'rejected' ? 'active' : ''}" data-review-filter="rejected">🔴 ${t('reviewStatusRejected')} (${counts.rejected})</button>
            </div>

            <div style="background:rgba(var(--gold-rgb), 0.08);border:1px solid var(--border-gold);border-radius:var(--radius-sm);padding:0.7rem 1rem;margin-bottom:1rem;font-size:0.82rem;color:var(--text-muted);display:flex;align-items:center;gap:0.5rem;">
                ⭐ <strong style="color:var(--gold);">En vedette sur l'accueil :</strong>
                <span style="font-weight:700;color:var(--gold);">${counts.featured} / ${MAX_FEATURED_REVIEWS}</span>
            </div>

            <div id="reviewsListContent"></div>
        `;
        container.innerHTML = html;

        container.querySelectorAll('[data-review-filter]').forEach(btn => {
            btn.addEventListener('click', () => renderAdminReviews(containerId, btn.dataset.reviewFilter));
        });

        const listEl = document.getElementById('reviewsListContent');
        if (filteredReviews.length === 0) {
            listEl.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:1rem;">${t('noReviews')}</p>`;
            return;
        }

        let listHtml = '';
        filteredReviews.forEach(r => {
            const statusClass = r.status === 'approved' ? 'admin-review-approved' : (r.status === 'rejected' ? 'admin-review-rejected' : 'admin-review-pending');
            const statusEmoji = r.status === 'approved' ? '🟢' : (r.status === 'rejected' ? '🔴' : '🟡');
            const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString('fr-FR') : '';
            const stars = renderStars(r.rating || 0);
            const isFeatured = r.featured === true;
            const isApproved = r.status === REVIEW_STATUS.APPROVED;
            const safeId = escapeHTML(r.id);

            const featureBtnHtml = isApproved
                ? `<button class="btn-feature ${isFeatured ? 'active' : ''}" data-action="review:toggle-featured" data-id="${safeId}">
                       ${isFeatured ? '⭐ Retirer de l\'accueil' : '⭐ Afficher sur l\'accueil'}
                   </button>`
                : '';

            const featuredBadge = isFeatured ? `<span class="featured-badge">⭐ Accueil</span>` : '';

            listHtml += `
                <div class="admin-review-item ${statusClass} ${isFeatured ? 'is-featured' : ''}" style="flex-direction:column;align-items:stretch;background:var(--bg-surface);border-radius:var(--radius-sm);padding:1rem;margin-bottom:0.8rem;border:1px solid var(--border);">
                    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.5rem;">
                        <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
                            <strong style="color:var(--gold);">${statusEmoji} ${escapeHTML(r.userName || 'Anonyme')}</strong>
                            ${r.verifiedPurchase ? `<span class="review-verified-badge">✅ ${t('reviewVerifiedPurchase')}</span>` : ''}
                            ${featuredBadge}
                        </div>
                        <small style="color:var(--text-muted);">${dateStr}</small>
                    </div>
                    <div style="color:var(--gold);margin-bottom:0.3rem;">${stars}</div>
                    ${r.title ? `<div style="font-weight:700;font-size:0.95rem;margin-bottom:0.3rem;">${escapeHTML(r.title)}</div>` : ''}
                    <div style="font-size:0.9rem;color:var(--text-muted);margin-bottom:0.5rem;">${escapeHTML(r.comment || '')}</div>
                    ${(r.photos && r.photos.length > 0) ? `
                        <div class="review-photos" style="margin-bottom:0.6rem;">
                            ${r.photos.map(url => `<img src="${escapeHTML(url)}" alt="Photo avis" data-photo-url="${escapeHTML(url)}" style="cursor:pointer;">`).join('')}
                        </div>
                    ` : ''}
                    <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:0.5rem;">
                        📦 ${t('product')} : ${escapeHTML(r.productSlug || 'N/A')} · 👍 ${r.likesCount || 0}
                    </div>
                    <div class="admin-review-actions">
                        ${r.status === REVIEW_STATUS.PENDING ? `
                            <button class="btn-approve" data-action="review:approve" data-id="${safeId}">✅ ${t('verifyButton')}</button>
                            <button class="btn-reject" data-action="review:reject" data-id="${safeId}">❌ ${t('reviewStatusRejected')}</button>
                        ` : ''}
                        ${featureBtnHtml}
                        <button class="btn-danger" data-action="review:delete" data-id="${safeId}" style="padding:0.4rem 1rem;border-radius:30px;background:var(--danger);color:white;border:none;cursor:pointer;font-size:0.8rem;">🗑️ ${t('delete')}</button>
                    </div>
                </div>
            `;
        });
        listEl.innerHTML = listHtml;

        // Attacher les événements
        listEl.querySelectorAll('[data-action="review:approve"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const result = await approveReview(btn.dataset.id);
                if (result.success) { showToast('✅ ' + t('success')); renderAdminReviews(containerId, statusFilter); }
                else { showToast('❌ ' + result.error); }
            });
        });

        listEl.querySelectorAll('[data-action="review:reject"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const result = await rejectReview(btn.dataset.id);
                if (result.success) { showToast('❌ ' + t('reviewStatusRejected')); renderAdminReviews(containerId, statusFilter); }
            });
        });

        listEl.querySelectorAll('[data-action="review:toggle-featured"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                const originalText = btn.textContent;
                btn.textContent = '⏳...';
                const result = await toggleFeaturedReview(btn.dataset.id);
                if (result.success) {
                    showToast(result.featured ? '⭐ Ajouté à l\'accueil' : '✅ Retiré de l\'accueil');
                    renderAdminReviews(containerId, statusFilter);
                } else {
                    showToast('⚠️ ' + result.error);
                    btn.disabled = false;
                    btn.textContent = originalText;
                }
            });
        });

        listEl.querySelectorAll('[data-action="review:delete"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const confirmed = await confirmAction(t('confirmDeleteReviewMsg'), {
                    title: t('confirmDeleteReviewTitle'), confirmText: t('confirmDeleteYes'), cancelText: t('confirmDeleteNo'), variant: 'danger'
                });
                if (!confirmed) return;
                const result = await deleteReview(btn.dataset.id);
                if (result.success) { showToast('🗑️ ' + t('delete')); renderAdminReviews(containerId, statusFilter); }
                else { showToast('❌ ' + result.error); }
            });
        });

        listEl.querySelectorAll('img[data-photo-url]').forEach(img => {
            img.addEventListener('click', () => openImageLightbox(img.dataset.photoUrl));
        });

    } catch (e) {
        console.error('❌ Erreur renderAdminReviews :', e);
        container.innerHTML = `<p style="text-align:center;color:var(--danger);">${t('loadingError')}</p>`;
    }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ reviews.js chargé — v2.1.0 (Fix IDs strings vendeurs)');