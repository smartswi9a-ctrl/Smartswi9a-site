// js/reviews.js
// ============================================================
// AVIS CLIENTS - SMART SWI9A
// Version 1.5.0 — Émission d'events review-submitted / review-deleted
// ============================================================
// Dépend de : config, utils, firebase, auth, products, ui-core
// Utilisé par : product-detail.js, admin.js, orders.js
// ============================================================

import {
    collection, addDoc, doc, updateDoc, deleteDoc, getDoc, getDocs,
    query, where, orderBy, Timestamp, arrayUnion, arrayRemove, increment
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
import { showToast, confirmAction } from "./ui-core.js";

// ============================================================
// CONSTANTE : Nombre max de témoignages en vedette
// ============================================================
const MAX_FEATURED_REVIEWS = 3;

// ============================================================
// CHARGER LES AVIS D'UN PRODUIT (public)
// ============================================================
export async function loadReviews(productId, onlyApproved = true) {
    try {
        let q;
        if (onlyApproved) {
            q = query(
                collection(db, "reviews"),
                where("productId", "==", Number(productId)),
                where("status", "==", REVIEW_STATUS.APPROVED)
            );
        } else {
            q = query(
                collection(db, "reviews"),
                where("productId", "==", Number(productId))
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
// CHARGER TOUS LES AVIS (ADMIN)
// ============================================================
export async function loadAllReviews(statusFilter = null) {
    try {
        let q;
        if (statusFilter && statusFilter !== 'all') {
            q = query(
                collection(db, "reviews"),
                where("status", "==", statusFilter)
            );
        } else {
            q = query(collection(db, "reviews"), orderBy("createdAt", "desc"));
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
        if (statusFilter && statusFilter !== 'all') {
            reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        }
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

    const checkQ = query(
        collection(db, "reviews"),
        where("userId", "==", user.uid),
        where("productId", "==", Number(productId))
    );
    const checkSnap = await getDocs(checkQ);
    if (!checkSnap.empty) {
        return { canReview: false, reason: 'already_reviewed' };
    }

    try {
        const ordersQ = query(
            collection(db, "orders"),
            where("userId", "==", user.uid)
        );
        const ordersSnap = await getDocs(ordersQ);
        const hasReceived = ordersSnap.docs.some(d => {
            const order = d.data();
            const status = order.status === 'validated' ? 'confirmed'
                         : order.status === 'received' ? 'delivered'
                         : order.status;
            if (status !== 'delivered') return false;
            return order.items?.some(it => Number(it.productId) === Number(productId));
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
// CRÉER UN AVIS
// ============================================================
export async function createReview(productId, { rating, title, comment, photoFiles = [] }) {
    const user = getCurrentUser();
    if (!user) throw new Error(t('loginRequired'));

    const pid = Number(productId);
    const product = getProductById(pid);
    if (!product) throw new Error(t('productNotFound'));

    if (!rating || rating < 1 || rating > 5) throw new Error(t('reviews'));
    if (!comment || !comment.trim()) throw new Error(t('reviewComment'));

    const check = await canUserReviewProduct(pid);
    if (!check.canReview) {
        if (check.reason === 'already_reviewed') throw new Error(t('reviewAlreadyExists'));
        if (check.reason === 'not_purchased') throw new Error(t('reviewOnlyAfterOrder'));
        throw new Error(t('loginRequired'));
    }

    const photoUrls = [];
    const files = (photoFiles || []).slice(0, CONFIG.REVIEWS.MAX_PHOTOS);

    const uploadPromises = files.map(async (file) => {
        try {
            const fileName = `reviews/${pid}_${user.uid}_${Date.now()}_${file.name}`;
            const storageRef = ref(storage, fileName);
            await uploadBytes(storageRef, file);
            return await getDownloadURL(storageRef);
        } catch (e) {
            console.warn('⚠️ Erreur upload photo avis :', e);
            return null;
        }
    });

    const results = await Promise.all(uploadPromises);
    results.forEach(url => { if (url) photoUrls.push(url); });

    const reviewData = {
        productId: pid,
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

    const docRef = await addDoc(collection(db, "reviews"), reviewData);
    console.log('✅ Avis créé :', docRef.id);

    // ============================================================
    // ✅ NEW v1.5.0 : Émettre l'event "review-submitted"
    // ------------------------------------------------------------
    // Permet à orders.js, notifications.js et ui.js de se
    // rafraîchir automatiquement (badge, cache, bannière, etc.)
    // ============================================================
    try {
        document.dispatchEvent(new CustomEvent('review-submitted', {
            detail: { productId: pid, reviewId: docRef.id }
        }));
        console.log('📣 Event "review-submitted" émis');
    } catch (e) {
        console.warn('⚠️ Erreur dispatch review-submitted :', e);
    }

    return docRef.id;
}

// ============================================================
// ✅ AJOUTER / RETIRER UN AVIS DES TÉMOIGNAGES (ADMIN)
// ============================================================
export async function toggleFeaturedReview(reviewId) {
    try {
        const reviewRef = doc(db, "reviews", reviewId);
        const reviewSnap = await getDoc(reviewRef);
        if (!reviewSnap.exists()) throw new Error(t('loadError'));

        const review = reviewSnap.data();

        if (review.status !== REVIEW_STATUS.APPROVED) {
            return {
                success: false,
                error: t('reviewPendingApproval')
            };
        }

        const isCurrentlyFeatured = review.featured === true;

        if (isCurrentlyFeatured) {
            await updateDoc(reviewRef, { featured: false });
            return { success: true, featured: false };
        }

        const featuredQ = query(
            collection(db, "reviews"),
            where("status", "==", REVIEW_STATUS.APPROVED),
            where("featured", "==", true)
        );
        const featuredSnap = await getDocs(featuredQ);
        const currentlyFeaturedCount = featuredSnap.size;

        if (currentlyFeaturedCount >= MAX_FEATURED_REVIEWS) {
            return {
                success: false,
                error: `Maximum ${MAX_FEATURED_REVIEWS}`,
                maxReached: true
            };
        }

        await updateDoc(reviewRef, { featured: true });
        return { success: true, featured: true };

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

        await updateProductRating(review.productId);

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
// SUPPRIMER UN AVIS (ADMIN) — avec suppression des photos Storage
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
                try {
                    await deleteObject(ref(storage, path));
                    console.log('✅ Photo supprimée :', path);
                } catch (e) {
                    console.warn('⚠️ Photo non supprimée :', path, e.message);
                }
            });
            await Promise.allSettled(deletePromises);
        }

        await deleteDoc(reviewRef);
        await updateProductRating(review.productId);

        // ============================================================
        // ✅ NEW v1.5.0 : Émettre l'event "review-deleted"
        // ------------------------------------------------------------
        // Permet aux modules d'avis de se rafraîchir (au cas où
        // l'admin supprime un avis d'un client).
        // ============================================================
        try {
            document.dispatchEvent(new CustomEvent('review-deleted', {
                detail: { productId: review.productId, reviewId }
            }));
        } catch (e) {
            console.warn('⚠️ Erreur dispatch review-deleted :', e);
        }

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
    try {
        const q = query(
            collection(db, "reviews"),
            where("productId", "==", Number(productId)),
            where("status", "==", REVIEW_STATUS.APPROVED)
        );
        const snap = await getDocs(q);
        const reviews = snap.docs.map(d => d.data());

        const ratingCount = reviews.length;
        const ratingAvg = ratingCount > 0
            ? Number((reviews.reduce((s, r) => s + (r.rating || 0), 0) / ratingCount).toFixed(1))
            : 0;

        await updateDoc(doc(db, "products", String(productId)), {
            ratingAvg,
            ratingCount
        });

        return { ratingAvg, ratingCount };
    } catch (e) {
        console.error('❌ Erreur updateProductRating :', e);
        return null;
    }
}

// ============================================================
// TOGGLE LIKE
// ============================================================
export async function toggleLike(reviewId) {
    const user = getCurrentUser();
    if (!user) throw new Error(t('loginRequired'));

    const reviewRef = doc(db, "reviews", reviewId);
    const snap = await getDoc(reviewRef);
    if (!snap.exists()) throw new Error(t('loadError'));

    const review = snap.data();
    const likes = review.likes || [];
    const hasLiked = likes.includes(user.uid);

    if (hasLiked) {
        await updateDoc(reviewRef, {
            likes: arrayRemove(user.uid),
            likesCount: increment(-1)
        });
        return { liked: false, count: Math.max(0, (review.likesCount || 0) - 1) };
    } else {
        await updateDoc(reviewRef, {
            likes: arrayUnion(user.uid),
            likesCount: increment(1)
        });
        return { liked: true, count: (review.likesCount || 0) + 1 };
    }
}

// ============================================================
// RENDU ADMIN DES AVIS
// ============================================================
export async function renderAdminReviews(containerId = 'reviewsList', statusFilter = 'all') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">⏳ ${t('loadingReviews')}</div>`;

    try {
        const allReviews = await loadAllReviews('all');

        if (allReviews.length === 0) {
            container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:2rem;">${t('noReviews')}</p>`;
            return;
        }

        const pendingCount = allReviews.filter(r => r.status === REVIEW_STATUS.PENDING).length;
        const approvedCount = allReviews.filter(r => r.status === REVIEW_STATUS.APPROVED).length;
        const rejectedCount = allReviews.filter(r => r.status === REVIEW_STATUS.REJECTED).length;
        const featuredCount = allReviews.filter(r => r.featured === true).length;

        let filtered = allReviews;
        if (statusFilter !== 'all') {
            filtered = allReviews.filter(r => r.status === statusFilter);
        }

        let html = `
            <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1rem;">
                <button class="filter-btn ${statusFilter === 'all' ? 'active' : ''}" data-review-filter="all">
                    ${t('filterAll')} (${allReviews.length})
                </button>
                <button class="filter-btn ${statusFilter === 'pending' ? 'active' : ''}" data-review-filter="pending">
                    🟡 ${t('reviewStatusPending')} (${pendingCount})
                </button>
                <button class="filter-btn ${statusFilter === 'approved' ? 'active' : ''}" data-review-filter="approved">
                    🟢 ${t('reviewStatusApproved')} (${approvedCount})
                </button>
                <button class="filter-btn ${statusFilter === 'rejected' ? 'active' : ''}" data-review-filter="rejected">
                    🔴 ${t('reviewStatusRejected')} (${rejectedCount})
                </button>
            </div>

            <div style="background:rgba(var(--gold-rgb), 0.08);border:1px solid var(--border-gold);border-radius:var(--radius-sm);padding:0.7rem 1rem;margin-bottom:1rem;font-size:0.82rem;color:var(--text-muted);display:flex;align-items:center;gap:0.5rem;">
                ⭐ <strong style="color:var(--gold);">${t('avisVerifiedPurchase')} :</strong>
                <span style="font-weight:700;color:var(--gold);">${featuredCount} / ${MAX_FEATURED_REVIEWS}</span>
            </div>

            <div id="reviewsListContent"></div>
        `;
        container.innerHTML = html;

        container.querySelectorAll('[data-review-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                renderAdminReviews(containerId, btn.dataset.reviewFilter);
            });
        });

        const listEl = document.getElementById('reviewsListContent');
        if (filtered.length === 0) {
            listEl.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:1rem;">${t('noReviews')}</p>`;
            return;
        }

        let listHtml = '';
        filtered.forEach(r => {
            const statusClass = r.status === 'approved' ? 'admin-review-approved'
                : (r.status === 'rejected' ? 'admin-review-rejected' : 'admin-review-pending');
            const statusEmoji = r.status === 'approved' ? '🟢' : (r.status === 'rejected' ? '🔴' : '🟡');
            const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString('fr-FR') : '';
            const stars = renderStars(r.rating || 0);
            const isFeatured = r.featured === true;
            const isApproved = r.status === REVIEW_STATUS.APPROVED;

            const featureBtnHtml = isApproved
                ? `<button class="btn-feature ${isFeatured ? 'active' : ''}"
                           data-action="review:toggle-featured"
                           data-id="${r.id}">
                       ${isFeatured ? '⭐ ' + t('featuredRemove') : '⭐ ' + t('featuredAdd')}
                   </button>`
                : '';

            const featuredBadge = isFeatured
                ? `<span class="featured-badge">⭐ ${t('success')}</span>`
                : '';

            listHtml += `
                <div class="admin-review-item ${statusClass} ${isFeatured ? 'is-featured' : ''}"
                     style="flex-direction:column;align-items:stretch;background:var(--bg-surface);border-radius:var(--radius-sm);padding:1rem;margin-bottom:0.8rem;border:1px solid var(--border);">
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
                            ${r.photos.map(url => `<img src="${escapeHTML(url)}" alt="${t('reviewPhotos')}" data-photo-url="${escapeHTML(url)}" style="cursor:pointer;">`).join('')}
                        </div>
                    ` : ''}
                    <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:0.5rem;">
                        📦 ${t('product')} : ${escapeHTML(r.productSlug || 'N/A')} · 👍 ${r.likesCount || 0}
                    </div>
                    <div class="admin-review-actions">
                        ${r.status === REVIEW_STATUS.PENDING ? `
                            <button class="btn-approve" data-action="review:approve" data-id="${r.id}">✅ ${t('verifyButton')}</button>
                            <button class="btn-reject" data-action="review:reject" data-id="${r.id}">❌ ${t('reviewStatusRejected')}</button>
                        ` : ''}
                        ${featureBtnHtml}
                        <button class="btn-danger" data-action="review:delete" data-id="${r.id}" style="padding:0.4rem 1rem;border-radius:30px;background:var(--danger);color:white;border:none;cursor:pointer;font-size:0.8rem;">🗑️ ${t('delete')}</button>
                    </div>
                </div>
            `;
        });
        listEl.innerHTML = listHtml;

        listEl.querySelectorAll('[data-action="review:approve"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const result = await approveReview(btn.dataset.id);
                if (result.success) {
                    showToast('✅ ' + t('success'));
                    renderAdminReviews(containerId, statusFilter);
                } else {
                    showToast('❌ ' + result.error);
                }
            });
        });

        listEl.querySelectorAll('[data-action="review:reject"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const result = await rejectReview(btn.dataset.id);
                if (result.success) {
                    showToast('❌ ' + t('reviewStatusRejected'));
                    renderAdminReviews(containerId, statusFilter);
                }
            });
        });

        listEl.querySelectorAll('[data-action="review:toggle-featured"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                const originalText = btn.textContent;
                btn.textContent = '⏳...';

                const result = await toggleFeaturedReview(btn.dataset.id);

                if (result.success) {
                    showToast(result.featured
                        ? '⭐ ' + t('featuredAdd')
                        : '✅ ' + t('featuredRemove'));
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
                const confirmed = await confirmAction(
                    t('confirmDeleteReviewMsg'),
                    {
                        title: t('confirmDeleteReviewTitle'),
                        confirmText: t('confirmDeleteYes'),
                        cancelText: t('confirmDeleteNo'),
                        variant: 'danger'
                    }
                );
                if (!confirmed) return;

                const result = await deleteReview(btn.dataset.id);
                if (result.success) {
                    showToast('🗑️ ' + t('delete'));
                    renderAdminReviews(containerId, statusFilter);
                } else {
                    showToast('❌ ' + result.error);
                }
            });
        });

        listEl.querySelectorAll('img[data-photo-url]').forEach(img => {
            img.addEventListener('click', async () => {
                const { openImageLightbox } = await import("./ui-core.js");
                openImageLightbox(img.dataset.photoUrl);
            });
        });

    } catch (e) {
        console.error('❌ Erreur renderAdminReviews :', e);
        container.innerHTML = `<p style="text-align:center;color:var(--danger);">${t('loadingError')}</p>`;
    }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ reviews.js chargé — v1.5.0 (events review-submitted / review-deleted)');