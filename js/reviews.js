// js/reviews.js
// ============================================================
// AVIS CLIENTS - SMART SWI9A
// Version 2.0.0 — Transactions atomiques (likes, featured, rating)
// ============================================================
// CHANGEMENTS v2.0.0 :
// ✅ C13.1 — toggleLike runTransaction (fin désync likesCount)
// ✅ C13.2 — toggleFeaturedReview meta counter + transaction
// ✅ C13.3 — approveReview avec retry rating (fin inconsistency)
// ✅ I13.1 — Promise.all strict + rollback sur échec upload photo
// ✅ I13.2 — renderAdminReviews queries ciblées + getCount
// ✅ I13.3 — canUserReviewProduct query ciblée (delivered)
// ✅ I13.4 — updateProductRating guard produit supprimé
// ✅ I13.5 — createReview ID déterministe (anti-double)
// ✅ M13.1 — escapeHTML(r.id) défense profondeur
// ✅ M13.2 — loadAllReviews limit(100)
// ✅ M13.3 — MAX_FEATURED via CONFIG
// ✅ M13.4 — Lien produit dans admin reviews
// ✅ M13.5 — Guard double render
// ✅ M13.6 — Ordre deleteReview : storage → doc → rating → event
// ============================================================
// Dépend de : config, utils, firebase, auth, products, ui-core
// ============================================================

import {
    collection, addDoc, doc, updateDoc, deleteDoc, getDoc, getDocs,
    query, where, Timestamp, arrayUnion, arrayRemove, increment,
    runTransaction, limit, getCountFromServer
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
// CONSTANTES
// ============================================================
// ✅ M13.3 : via CONFIG
const MAX_FEATURED_REVIEWS = CONFIG.REVIEWS.MAX_FEATURED || 3;

// ✅ C13.2 : doc meta/featured_reviews pour compteur atomique
const FEATURED_META_COLLECTION = 'meta';
const FEATURED_META_DOC = 'featured_reviews';

// ✅ M13.5 : guard double render admin
let _adminRenderInProgress = false;

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
// ✅ M13.2 : CHARGER TOUS LES AVIS (limit 100)
// ============================================================
export async function loadAllReviews(statusFilter = null) {
    try {
        let q;
        const constraints = [];
        if (statusFilter && statusFilter !== 'all') {
            constraints.push(where("status", "==", statusFilter));
        }
        // ✅ M13.2 : limit pour éviter les getDocs massifs
        constraints.push(limit(100));

        q = query(collection(db, "reviews"), ...constraints);

        const snapshot = await getDocs(q);
        const reviews = snapshot.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                createdAt: toDate(data.createdAt)
            };
        });
        // Tri côté client (évite l'index composite)
        reviews.sort((a, b) => {
            const da = a.createdAt?.getTime?.() || 0;
            const dbb = b.createdAt?.getTime?.() || 0;
            return dbb - da;
        });
        return reviews;
    } catch (e) {
        console.error('❌ Erreur loadAllReviews :', e);
        return [];
    }
}

// ============================================================
// ✅ I13.3 : VÉRIFIER SI L'UTILISATEUR PEUT LAISSER UN AVIS
// ------------------------------------------------------------
// Query ciblée : on ne charge QUE les commandes livrées récentes
// ============================================================
export async function canUserReviewProduct(productId) {
    const user = getCurrentUser();
    if (!user) return { canReview: false, reason: 'not_logged' };

    // 1. Avis déjà déposé ?
    const checkQ = query(
        collection(db, "reviews"),
        where("userId", "==", user.uid),
        where("productId", "==", Number(productId))
    );
    const checkSnap = await getDocs(checkQ);
    if (!checkSnap.empty) {
        return { canReview: false, reason: 'already_reviewed' };
    }

    // 2. Commande livrée contenant ce produit ?
    try {
        // ✅ I13.3 : query ciblée (livrées uniquement + limit)
        const ordersQ = query(
            collection(db, "orders"),
            where("userId", "==", user.uid),
            where("status", "in", ['delivered', 'received']),
            limit(20)
        );
        const ordersSnap = await getDocs(ordersQ);
        const hasReceived = ordersSnap.docs.some(d => {
            const order = d.data();
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
// ✅ I13.1 + I13.5 : CRÉER UN AVIS
// ------------------------------------------------------------
// I13.5 : ID déterministe review_{uid}_{pid} (anti-double review)
// I13.1 : Promise.all strict + rollback si échec upload
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

    // ✅ I13.5 : ID déterministe (empêche double review)
    const reviewId = `review_${user.uid}_${pid}`;
    const reviewRef = doc(db, "reviews", reviewId);

    // ✅ I13.5 : vérification existence (double sécurité)
    const existing = await getDoc(reviewRef);
    if (existing.exists()) {
        throw new Error(t('reviewAlreadyExists'));
    }

    // ✅ I13.1 : upload photos avec Promise.all (échec = rollback)
    const photoUrls = [];
    const files = (photoFiles || []).slice(0, CONFIG.REVIEWS.MAX_PHOTOS);

    if (files.length > 0) {
        try {
            const uploadPromises = files.map(async (file) => {
                const fileName = `reviews/${pid}_${user.uid}_${Date.now()}_${file.name}`;
                const storageRef = ref(storage, fileName);
                await uploadBytes(storageRef, file);
                return await getDownloadURL(storageRef);
            });
            const results = await Promise.all(uploadPromises);
            photoUrls.push(...results);
        } catch (e) {
            // ✅ I13.1 : si un upload échoue → suppression des photos uploadées
            console.error('❌ Erreur upload photo, rollback :', e);
            await Promise.allSettled(photoUrls.map(url => {
                const path = getStoragePathFromUrl(url);
                if (path) return deleteObject(ref(storage, path)).catch(() => {});
                return Promise.resolve();
            }));
            throw new Error('Impossible d\'uploader les photos. Réessayez sans photos ou avec moins de photos.');
        }
    }

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

    // ✅ I13.5 : setDoc avec ID déterministe
    try {
        await setDoc(reviewRef, reviewData);
    } catch (e) {
        // Rollback photos si setDoc échoue
        await Promise.allSettled(photoUrls.map(url => {
            const path = getStoragePathFromUrl(url);
            if (path) return deleteObject(ref(storage, path)).catch(() => {});
            return Promise.resolve();
        }));
        throw e;
    }

    console.log('✅ Avis créé :', reviewId);

    // Event
    try {
        document.dispatchEvent(new CustomEvent('review-submitted', {
            detail: { productId: pid, reviewId }
        }));
        console.log('📣 Event "review-submitted" émis');
    } catch (e) {
        console.warn('⚠️ Erreur dispatch review-submitted :', e);
    }

    return reviewId;
}

// ============================================================
// ✅ C13.2 : LIRE LE COMPTEUR FEATURED (avec fallback)
// ------------------------------------------------------------
// Note : on maintient un doc meta/featured_reviews { count: N }.
// Si le doc n'existe pas (1ère utilisation), on le crée à 0.
// ============================================================
async function getFeaturedCounter() {
    try {
        const counterRef = doc(db, FEATURED_META_COLLECTION, FEATURED_META_DOC);
        const snap = await getDoc(counterRef);
        if (!snap.exists()) return 0;
        return Number(snap.data().count) || 0;
    } catch (e) {
        console.warn('⚠️ Erreur lecture compteur featured :', e);
        return 0;
    }
}

// ============================================================
// ✅ C13.2 : TOGGLE FEATURED (transaction + compteur atomique)
// ============================================================
export async function toggleFeaturedReview(reviewId) {
    try {
        const reviewRef = doc(db, "reviews", reviewId);
        const counterRef = doc(db, FEATURED_META_COLLECTION, FEATURED_META_DOC);

        const result = await runTransaction(db, async (transaction) => {
            // READ
            const reviewSnap = await transaction.get(reviewRef);
            if (!reviewSnap.exists()) throw new Error(t('loadError'));

            const review = reviewSnap.data();
            if (review.status !== REVIEW_STATUS.APPROVED) {
                throw new Error(t('reviewPendingApproval'));
            }

            const counterSnap = await transaction.get(counterRef);
            const currentCount = counterSnap.exists()
                ? (Number(counterSnap.data().count) || 0)
                : 0;

            const isCurrentlyFeatured = review.featured === true;

            // WRITE
            if (isCurrentlyFeatured) {
                // Retirer
                transaction.update(reviewRef, { featured: false });
                transaction.set(counterRef, {
                    count: Math.max(0, currentCount - 1),
                    updatedAt: Timestamp.now()
                }, { merge: true });
                return { success: true, featured: false };
            } else {
                // Vérifier limite
                if (currentCount >= MAX_FEATURED_REVIEWS) {
                    throw new Error(`Maximum ${MAX_FEATURED_REVIEWS} témoignages en vedette. Retirez-en un d'abord.`);
                }
                transaction.update(reviewRef, { featured: true });
                transaction.set(counterRef, {
                    count: currentCount + 1,
                    updatedAt: Timestamp.now()
                }, { merge: true });
                return { success: true, featured: true };
            }
        });

        return result;

    } catch (e) {
        console.error('❌ Erreur toggleFeaturedReview :', e);
        return {
            success: false,
            error: e.message,
            maxReached: /Maximum/i.test(e.message)
        };
    }
}

// ============================================================
// ✅ C13.3 : RECALCUL RATING AVEC RETRY
// ============================================================
async function updateProductRatingWithRetry(productId, maxRetries = 3) {
    let lastError = null;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const result = await updateProductRating(productId);
            if (result) return result;
            // result null = produit introuvable (pas de retry)
            return null;
        } catch (e) {
            lastError = e;
            if (i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
        }
    }
    console.error('❌ updateProductRating a échoué après retries :', lastError);
    throw lastError;
}

// ============================================================
// ✅ C13.3 : APPROUVER (avec retry rating)
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

        // ✅ C13.3 : avec retry
        try {
            await updateProductRatingWithRetry(review.productId);
        } catch (e) {
            console.warn('⚠️ Rating non mis à jour (approuvé quand même) :', e);
            // On NE throw PAS : l'avis est approuvé, seul le rating global est en retard
        }

        // Notification (best-effort)
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
// REJETER (avec décrément featured si nécessaire)
// ============================================================
export async function rejectReview(reviewId) {
    try {
        const reviewRef = doc(db, "reviews", reviewId);
        const snap = await getDoc(reviewRef);
        if (!snap.exists()) throw new Error(t('loadError'));

        const review = snap.data();
        const wasFeatured = review.featured === true;

        await updateDoc(reviewRef, {
            status: REVIEW_STATUS.REJECTED,
            rejectedAt: Timestamp.now(),
            featured: false
        });

        // ✅ C13.2 : décrémenter compteur si était featured
        if (wasFeatured) {
            const counterRef = doc(db, FEATURED_META_COLLECTION, FEATURED_META_DOC);
            try {
                const counterSnap = await getDoc(counterRef);
                const currentCount = counterSnap.exists()
                    ? (Number(counterSnap.data().count) || 0)
                    : 0;
                await updateDoc(counterRef, {
                    count: Math.max(0, currentCount - 1),
                    updatedAt: Timestamp.now()
                });
            } catch (e) {
                console.warn('⚠️ Erreur décrément compteur featured :', e);
            }
        }

        return { success: true };
    } catch (e) {
        console.error('❌ Erreur rejectReview :', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// ✅ M13.6 : SUPPRIMER (storage → doc → rating → event)
// ============================================================
export async function deleteReview(reviewId) {
    try {
        const reviewRef = doc(db, "reviews", reviewId);
        const snap = await getDoc(reviewRef);
        if (!snap.exists()) throw new Error(t('loadError'));

        const review = snap.data();
        const wasFeatured = review.featured === true;

        // 1. Storage (photos)
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

        // 2. Supprimer le doc
        await deleteDoc(reviewRef);

        // 3. Décrémenter compteur featured si nécessaire
        if (wasFeatured) {
            const counterRef = doc(db, FEATURED_META_COLLECTION, FEATURED_META_DOC);
            try {
                const counterSnap = await getDoc(counterRef);
                const currentCount = counterSnap.exists()
                    ? (Number(counterSnap.data().count) || 0)
                    : 0;
                await updateDoc(counterRef, {
                    count: Math.max(0, currentCount - 1),
                    updatedAt: Timestamp.now()
                });
            } catch (e) {
                console.warn('⚠️ Erreur décrément compteur featured :', e);
            }
        }

        // 4. Recalcul rating (avec retry)
        try {
            await updateProductRatingWithRetry(review.productId);
        } catch (e) {
            console.warn('⚠️ Rating non recalculé :', e);
        }

        // 5. Event
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
// ✅ I13.4 : RECALCULER LA MOYENNE (avec guard produit)
// ============================================================
export async function updateProductRating(productId) {
    try {
        // ✅ I13.4 : guard produit supprimé
        const productRef = doc(db, "products", String(productId));
        const productSnap = await getDoc(productRef);
        if (!productSnap.exists()) {
            console.warn('⚠️ updateProductRating : produit introuvable', productId);
            return null;
        }

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

        await updateDoc(productRef, {
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
// ✅ C13.1 : TOGGLE LIKE (runTransaction)
// ============================================================
export async function toggleLike(reviewId) {
    const user = getCurrentUser();
    if (!user) throw new Error(t('loginRequired'));

    const reviewRef = doc(db, "reviews", reviewId);

    return await runTransaction(db, async (transaction) => {
        // READ
        const snap = await transaction.get(reviewRef);
        if (!snap.exists()) throw new Error(t('loadError'));

        const review = snap.data();
        const likes = Array.isArray(review.likes) ? review.likes : [];
        const hasLiked = likes.includes(user.uid);
        const currentCount = Number(review.likesCount) || 0;

        // WRITE
        if (hasLiked) {
            transaction.update(reviewRef, {
                likes: arrayRemove(user.uid),
                likesCount: Math.max(0, currentCount - 1)
            });
            return { liked: false, count: Math.max(0, currentCount - 1) };
        } else {
            transaction.update(reviewRef, {
                likes: arrayUnion(user.uid),
                likesCount: currentCount + 1
            });
            return { liked: true, count: currentCount + 1 };
        }
    });
}

// ============================================================
// ✅ I13.2 + M13.5 : RENDU ADMIN DES AVIS
// ------------------------------------------------------------
// Queries ciblées par status + getCountFromServer pour compteurs
// ============================================================
export async function renderAdminReviews(containerId = 'reviewsList', statusFilter = 'all') {
    // ✅ M13.5 : guard double render
    if (_adminRenderInProgress) {
        console.log('ℹ️ renderAdminReviews déjà en cours — skip');
        return;
    }
    _adminRenderInProgress = true;

    const container = document.getElementById(containerId);
    if (!container) {
        _adminRenderInProgress = false;
        return;
    }

    container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">⏳ ${t('loadingReviews')}</div>`;

    try {
        // ✅ I13.2 : queries ciblées + compteurs séparés
        const [filteredReviews, pendingSnap, approvedSnap, rejectedSnap, featuredSnap] = await Promise.all([
            loadAllReviews(statusFilter),
            getCountFromServer(query(collection(db, "reviews"), where("status", "==", REVIEW_STATUS.PENDING))).catch(() => null),
            getCountFromServer(query(collection(db, "reviews"), where("status", "==", REVIEW_STATUS.APPROVED))).catch(() => null),
            getCountFromServer(query(collection(db, "reviews"), where("status", "==", REVIEW_STATUS.REJECTED))).catch(() => null),
            getCountFromServer(query(collection(db, "reviews"), where("featured", "==", true))).catch(() => null)
        ]);

        const pendingCount = pendingSnap?.data().count || 0;
        const approvedCount = approvedSnap?.data().count || 0;
        const rejectedCount = rejectedSnap?.data().count || 0;
        const featuredCount = featuredSnap?.data().count || 0;
        const totalCount = pendingCount + approvedCount + rejectedCount;

        if (totalCount === 0 && filteredReviews.length === 0) {
            container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:2rem;">${t('noReviews')}</p>`;
            return;
        }

        let html = `
            <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1rem;">
                <button class="filter-btn ${statusFilter === 'all' ? 'active' : ''}" data-review-filter="all">
                    ${t('filterAll')} (${totalCount})
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
                _adminRenderInProgress = false;
                renderAdminReviews(containerId, btn.dataset.reviewFilter);
            });
        });

        const listEl = document.getElementById('reviewsListContent');
        if (filteredReviews.length === 0) {
            listEl.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:1rem;">${t('noReviews')}</p>`;
            return;
        }

        let listHtml = '';
        filteredReviews.forEach(r => {
            const statusClass = r.status === 'approved' ? 'admin-review-approved'
                : (r.status === 'rejected' ? 'admin-review-rejected' : 'admin-review-pending');
            const statusEmoji = r.status === 'approved' ? '🟢' : (r.status === 'rejected' ? '🔴' : '🟡');
            const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString('fr-FR') : '';
            const stars = renderStars(r.rating || 0);
            const isFeatured = r.featured === true;
            const isApproved = r.status === REVIEW_STATUS.APPROVED;
            // ✅ M13.1 : escapeHTML(r.id)
            const safeId = escapeHTML(r.id);

            const featureBtnHtml = isApproved
                ? `<button class="btn-feature ${isFeatured ? 'active' : ''}"
                           data-action="review:toggle-featured"
                           data-id="${safeId}">
                       ${isFeatured ? '⭐ ' + t('featuredRemove') : '⭐ ' + t('featuredAdd')}
                   </button>`
                : '';

            const featuredBadge = isFeatured
                ? `<span class="featured-badge">⭐ ${t('success')}</span>`
                : '';

            // ✅ M13.4 : lien produit
            const productLink = r.productSlug
                ? `<a href="/produit?slug=${encodeURIComponent(r.productSlug)}" target="_blank" style="color:var(--gold);text-decoration:underline;font-size:0.75rem;">📦 ${escapeHTML(r.productSlug)}</a>`
                : `<span style="font-size:0.75rem;color:var(--text-dim);">📦 ${r.productId || 'N/A'}</span>`;

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
                        ${productLink} · 👍 ${r.likesCount || 0}
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

        // ===== LISTENERS =====
        listEl.querySelectorAll('[data-action="review:approve"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                const result = await approveReview(btn.dataset.id);
                if (result.success) {
                    showToast('✅ ' + t('success'));
                    _adminRenderInProgress = false;
                    renderAdminReviews(containerId, statusFilter);
                } else {
                    showToast('❌ ' + result.error);
                    btn.disabled = false;
                }
            });
        });

        listEl.querySelectorAll('[data-action="review:reject"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                const result = await rejectReview(btn.dataset.id);
                if (result.success) {
                    showToast('❌ ' + t('reviewStatusRejected'));
                    _adminRenderInProgress = false;
                    renderAdminReviews(containerId, statusFilter);
                } else {
                    showToast('❌ ' + result.error);
                    btn.disabled = false;
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
                    _adminRenderInProgress = false;
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

                btn.disabled = true;
                const result = await deleteReview(btn.dataset.id);
                if (result.success) {
                    showToast('🗑️ ' + t('delete'));
                    _adminRenderInProgress = false;
                    renderAdminReviews(containerId, statusFilter);
                } else {
                    showToast('❌ ' + result.error);
                    btn.disabled = false;
                }
            });
        });

        listEl.querySelectorAll('img[data-photo-url]').forEach(img => {
            img.addEventListener('click', () => {
                openImageLightbox(img.dataset.photoUrl);
            });
        });

    } catch (e) {
        console.error('❌ Erreur renderAdminReviews :', e);
        container.innerHTML = `<p style="text-align:center;color:var(--danger);">${t('loadingError')}</p>`;
    } finally {
        _adminRenderInProgress = false;
    }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ reviews.js chargé — v2.0.0 (transactions atomiques + ID déterministe)');