// js/notifications.js
// ============================================================
// NOTIFICATIONS CLIENT - SMART SWI9A
// Version 1.2.1 — FIX : URLs cleanUrls (/produit au lieu de /produit.html)
// ============================================================
// Dépend de : config, utils, firebase, auth, ui-core
// ============================================================

import {
    collection, query, where, getDocs, doc, updateDoc, deleteDoc,
    Timestamp, writeBatch, addDoc
} from "firebase/firestore";
import { db } from "./firebase.js";
import { NOTIFICATION_TYPES } from "./config.js";
import { t, escapeHTML, formatDateTime, toDate } from "./utils.js";
import { getCurrentUser } from "./auth.js";
import { showToast, trapFocus, releaseFocusTrap } from "./ui-core.js";

// ============================================================
// ÉTAT LOCAL
// ============================================================
let notificationsCache = [];
let unreadCount = 0;

// ============================================================
// CONSTANTE : type review_request
// (non défini dans CONFIG.NOTIFICATIONS.TYPES, on utilise la string)
// ============================================================
const REVIEW_REQUEST_TYPE = 'review_request';

// ============================================================
// CHARGER LES NOTIFICATIONS
// ============================================================
export async function loadNotifications() {
    const user = getCurrentUser();
    if (!user) {
        notificationsCache = [];
        unreadCount = 0;
        updateNotificationBadge();
        return [];
    }

    try {
        const q = query(
            collection(db, "notifications"),
            where("userId", "==", user.uid)
        );
        const snapshot = await getDocs(q);
        notificationsCache = snapshot.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                createdAt: toDate(data.createdAt)
            };
        });
        notificationsCache.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        unreadCount = notificationsCache.filter(n => !n.read).length;
        updateNotificationBadge();
        return notificationsCache;
    } catch (e) {
        console.error('❌ Erreur chargement notifications :', e);
        return [];
    }
}

// ============================================================
// BADGE
// ============================================================
export function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    const bell = document.getElementById('notificationBell');

    if (bell) {
        const user = getCurrentUser();
        bell.style.display = user ? 'flex' : 'none';
    }

    if (!badge) return;

    // ✅ NEW v1.2.0 : Les review_request comptent même si lues
    const pendingReviews = notificationsCache.filter(n =>
        n.type === REVIEW_REQUEST_TYPE
    ).length;

    const totalBadge = unreadCount + pendingReviews;

    if (totalBadge > 0) {
        badge.textContent = totalBadge > 9 ? '9+' : totalBadge;
        badge.style.display = 'flex';
        // ✅ NEW : couleur différente si uniquement des review_request
        if (unreadCount === 0 && pendingReviews > 0) {
            badge.style.background = 'var(--gold)';
        } else {
            badge.style.background = 'var(--danger)';
        }
    } else {
        badge.style.display = 'none';
    }
}

// ============================================================
// ICÔNE SELON LE TYPE
// ============================================================
function getNotificationIcon(type) {
    const icons = {
        [NOTIFICATION_TYPES.ORDER_CREATED]:   '🛒',
        [NOTIFICATION_TYPES.ORDER_CONFIRMED]: '✅',
        [NOTIFICATION_TYPES.ORDER_SHIPPING]:  '🚚',
        [NOTIFICATION_TYPES.ORDER_DELIVERED]: '📦',
        [NOTIFICATION_TYPES.ORDER_RETURNED]:  '↩️',
        [NOTIFICATION_TYPES.ORDER_CANCELLED]: '❌',
        [NOTIFICATION_TYPES.REVIEW_APPROVED]: '⭐',
        [REVIEW_REQUEST_TYPE]:                '⭐',
        'order_validated': '✅',
        'order_received': '📦'
    };
    return icons[type] || '🔔';
}

// ============================================================
// HELPER : Est-ce une notif review_request ?
// ============================================================
function isReviewRequest(notif) {
    return notif && notif.type === REVIEW_REQUEST_TYPE;
}

// ============================================================
// OUVRIR LE PANNEAU
// ============================================================
export async function openNotificationsPanel() {
    const user = getCurrentUser();
    if (!user) {
        showToast('🔒 ' + t('loginRequired'));
        return;
    }

    await loadNotifications();

    const existing = document.getElementById('notificationsPanel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'notificationsPanel';
    panel.className = 'modal-overlay open';
    panel.style.zIndex = '2500';
    panel.innerHTML = `
        <div class="modal" style="max-width:500px;">
            <button class="modal-close" id="closeNotificationsBtn">✕</button>
            <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:1rem;">
                🔔 ${t('notifications')}
            </h2>
            <div id="notificationsContent" style="max-height:60vh;overflow-y:auto;"></div>
            ${notificationsCache.filter(n => !n.read && !isReviewRequest(n)).length > 0 ? `
                <button id="markAllReadBtn" class="btn-secondary" style="width:100%;margin-top:1rem;justify-content:center;">
                    ✅ ${t('markAllRead')}
                </button>
            ` : ''}
        </div>
    `;
    document.body.appendChild(panel);

    renderNotificationsContent();

    const modalEl = panel.querySelector('.modal');
    trapFocus(modalEl);

    document.getElementById('closeNotificationsBtn').addEventListener('click', () => {
        releaseFocusTrap();
        panel.remove();
    });
    panel.addEventListener('click', (e) => {
        if (e.target === panel) {
            releaseFocusTrap();
            panel.remove();
        }
    });

    const markAllBtn = document.getElementById('markAllReadBtn');
    if (markAllBtn) {
        markAllBtn.addEventListener('click', async () => {
            await markAllAsRead();
            renderNotificationsContent();
            showToast('✅ ' + t('markAllRead'));
        });
    }
}

// ============================================================
// RENDU DU CONTENU
// ============================================================
function renderNotificationsContent() {
    const container = document.getElementById('notificationsContent');
    if (!container) return;

    if (notificationsCache.length === 0) {
        container.innerHTML = `
            <div style="text-align:center;padding:2rem;color:var(--text-muted);">
                <div style="font-size:3rem;margin-bottom:0.5rem;">🔕</div>
                <p>${t('noNotifications')}</p>
            </div>
        `;
        return;
    }

    // ✅ NEW v1.2.0 : Trier les review_request en premier
    const sorted = [...notificationsCache].sort((a, b) => {
        const aIsReview = isReviewRequest(a);
        const bIsReview = isReviewRequest(b);
        if (aIsReview && !bIsReview) return -1;
        if (!aIsReview && bIsReview) return 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
    });

    let html = '';
    sorted.forEach(notif => {
        const icon = getNotificationIcon(notif.type);
        const isUnread = !notif.read;
        const reviewReq = isReviewRequest(notif);
        const date = formatDateTime(notif.createdAt);

        // ✅ NEW v1.2.0 : Style spécial pour review_request (bordure dorée)
        const borderStyle = reviewReq
            ? 'border:2px solid var(--gold);background:linear-gradient(135deg,rgba(165,123,46,0.08),rgba(165,123,46,0.02));'
            : '';

        // ✅ NEW v1.2.0 : Pas de bouton de suppression pour review_request
        const deleteBtnHtml = reviewReq
            ? `<span class="review-req-badge" title="${t('leaveReview') || 'Laisser un avis'}"
                style="font-size:0.65rem;background:var(--gold);color:#fff;padding:0.15rem 0.5rem;border-radius:30px;font-weight:700;white-space:nowrap;">
                ⭐ ${t('reviewStatusPending') || 'À faire'}
               </span>`
            : `<button class="notif-delete-btn" data-notif-id="${notif.id}" title="${t('delete') || 'Supprimer'}"
                style="background:transparent;border:none;color:var(--text-dim);cursor:pointer;font-size:1rem;">✕</button>`;

        html += `
            <div class="notification-item ${isUnread ? 'unread' : ''} ${reviewReq ? 'review-request' : ''}" data-notif-id="${notif.id}" style="${borderStyle}">
                <div class="notification-icon">${icon}</div>
                <div class="notification-content">
                    <div class="notification-title">${escapeHTML(notif.title || '')}</div>
                    <div class="notification-message">${escapeHTML(notif.message || '')}</div>
                    <div class="notification-date">${date}</div>
                </div>
                ${deleteBtnHtml}
            </div>
        `;
    });
    container.innerHTML = html;

    container.querySelectorAll('.notification-item').forEach(item => {
        item.addEventListener('click', async (e) => {
            if (e.target.closest('.notif-delete-btn')) return;
            const notifId = item.dataset.notifId;
            const notif = notificationsCache.find(n => n.id === notifId);
            if (notif) await handleNotificationClick(notif);
        });
    });

    container.querySelectorAll('.notif-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const notifId = btn.dataset.notifId;
            const notif = notificationsCache.find(n => n.id === notifId);
            // ✅ NEW v1.2.0 : Sécurité — empêche la suppression d'une review_request
            if (notif && isReviewRequest(notif)) {
                showToast('⚠️ ' + (t('reviewOnlyAfterOrder') || 'Déposez d\'abord votre avis'));
                return;
            }
            await deleteNotification(notifId);
            renderNotificationsContent();
        });
    });
}

// ============================================================
// CLIC SUR UNE NOTIFICATION
// ============================================================
async function handleNotificationClick(notif) {
    // ✅ NEW v1.2.0 : Ne pas marquer comme lue les review_request
    // (elles restent "en attente" tant que l'avis n'est pas déposé)
    const reviewReq = isReviewRequest(notif);

    if (!notif.read && !reviewReq) {
        await markAsRead(notif.id);
        notif.read = true;
        unreadCount = Math.max(0, unreadCount - 1);
        updateNotificationBadge();
    }

    const panel = document.getElementById('notificationsPanel');
    if (panel) {
        releaseFocusTrap();
        panel.remove();
    }

    // ✅ NEW v1.2.0 : Les review_request ouvrent les commandes avec le filtre "delivered"
    if (reviewReq && notif.orderId) {
        document.dispatchEvent(new CustomEvent('open-account-orders', {
            detail: { orderId: notif.orderId, filter: 'delivered' }
        }));
        return;
    }

    if (notif.orderId) {
        document.dispatchEvent(new CustomEvent('open-account-orders', {
            detail: { orderId: notif.orderId }
        }));
    } else if (notif.type === NOTIFICATION_TYPES.REVIEW_APPROVED && notif.productSlug) {
        // ✅ FIX v1.2.1 : cleanUrls → /produit (sans .html)
        window.location.href = `/produit?slug=${encodeURIComponent(notif.productSlug)}`;
    }
}

// ============================================================
// MARQUER COMME LUE
// ============================================================
export async function markAsRead(notifId) {
    try {
        await updateDoc(doc(db, "notifications", notifId), { read: true });
        const notif = notificationsCache.find(n => n.id === notifId);
        if (notif) notif.read = true;
    } catch (e) {
        console.error('❌ Erreur markAsRead :', e);
    }
}

// ============================================================
// TOUT MARQUER COMME LU
// ============================================================
export async function markAllAsRead() {
    const user = getCurrentUser();
    if (!user) return;

    try {
        const batch = writeBatch(db);
        notificationsCache.forEach(notif => {
            // ✅ NEW v1.2.0 : Ne pas marquer les review_request comme lues
            // (elles doivent rester visibles tant que l'avis n'est pas déposé)
            if (!notif.read && !isReviewRequest(notif)) {
                batch.update(doc(db, "notifications", notif.id), { read: true });
                notif.read = true;
            }
        });
        await batch.commit();

        // Recalculer unreadCount
        unreadCount = notificationsCache.filter(n => !n.read).length;
        updateNotificationBadge();
    } catch (e) {
        console.error('❌ Erreur markAllAsRead :', e);
    }
}

// ============================================================
// SUPPRIMER UNE NOTIFICATION
// ============================================================
export async function deleteNotification(notifId) {
    try {
        const notif = notificationsCache.find(n => n.id === notifId);

        // ✅ NEW v1.2.0 : Bloquer la suppression des review_request
        if (notif && isReviewRequest(notif)) {
            showToast('⚠️ ' + (t('reviewOnlyAfterOrder') || 'Déposez d\'abord votre avis'));
            return;
        }

        await deleteDoc(doc(db, "notifications", notifId));

        if (notif && !notif.read) {
            unreadCount = Math.max(0, unreadCount - 1);
            updateNotificationBadge();
        }
        notificationsCache = notificationsCache.filter(n => n.id !== notifId);
        showToast('🗑️ ' + t('delete'));
    } catch (e) {
        console.error('❌ Erreur deleteNotification :', e);
    }
}

// ============================================================
// CRÉER UNE NOTIFICATION
// ============================================================
export async function createNotification(userId, type, title, message, extra = {}) {
    try {
        await addDoc(collection(db, "notifications"), {
            userId,
            type,
            title,
            message,
            read: false,
            createdAt: Timestamp.now(),
            ...extra
        });
        return true;
    } catch (e) {
        console.error('❌ Erreur createNotification :', e);
        return false;
    }
}

// ============================================================
// ✅ NEW v1.2.0 : SUPPRIMER TOUTES LES NOTIFICATIONS review_request D'UNE COMMANDE
// ============================================================
/**
 * Supprime la notification review_request liée à une commande.
 * Appelée par orders.js après dépôt d'avis sur tous les produits.
 */
export async function deleteReviewRequestForOrder(orderId) {
    const user = getCurrentUser();
    if (!user || !orderId) return;

    try {
        const q = query(
            collection(db, "notifications"),
            where("userId", "==", user.uid),
            where("orderId", "==", orderId),
            where("type", "==", REVIEW_REQUEST_TYPE)
        );
        const snap = await getDocs(q);
        if (snap.empty) return;

        await Promise.allSettled(snap.docs.map(d => deleteDoc(d.ref)));
        notificationsCache = notificationsCache.filter(n =>
            !(n.type === REVIEW_REQUEST_TYPE && n.orderId === orderId)
        );
        updateNotificationBadge();
        console.log(`🧹 Notif review_request supprimée pour commande ${orderId}`);
    } catch (e) {
        console.warn('⚠️ Erreur deleteReviewRequestForOrder :', e);
    }
}

// ============================================================
// INJECTER LA CLOCHE DANS LA NAVBAR
// ============================================================
export function injectNotificationBell() {
    const navRight = document.querySelector('.nav-right');
    if (!navRight) return;
    if (document.getElementById('notificationBell')) return;

    const bell = document.createElement('button');
    bell.id = 'notificationBell';
    bell.className = 'notification-bell';
    bell.setAttribute('aria-label', 'Notifications');
    bell.style.display = 'none';
    bell.innerHTML = `
        🔔
        <span class="notification-badge" id="notificationBadge" style="display:none;">0</span>
    `;

    const accountBtn = document.getElementById('accountBtn');
    if (accountBtn && accountBtn.parentNode) {
        accountBtn.parentNode.insertBefore(bell, accountBtn);
    } else {
        navRight.appendChild(bell);
    }
}

// ============================================================
// INITIALISATION DE LA CLOCHE
// ============================================================
export function initNotificationBell() {
    injectNotificationBell();

    const bell = document.getElementById('notificationBell');
    if (!bell) return;

    const user = getCurrentUser();
    bell.style.display = user ? 'flex' : 'none';

    if (user) {
        loadNotifications();
    }

    if (!bell._initialized) {
        bell.addEventListener('click', openNotificationsPanel);
        bell._initialized = true;
    }
}

// ============================================================
// ✅ NEW v1.2.0 : ÉCOUTE DE L'EVENT review-submitted
// (rafraîchit le badge après dépôt d'avis)
// ============================================================
if (typeof document !== 'undefined') {
    document.addEventListener('review-submitted', async () => {
        console.log('⭐ [notifications] Event review-submitted reçu — refresh');
        await loadNotifications();
    });
}

// ============================================================
// LOG
// ============================================================
console.log('✅ notifications.js chargé — v1.2.1 (fix cleanUrls)');