// js/notifications.js
// ============================================================
// NOTIFICATIONS CLIENT - SMART SWI9A
// Version 2.0.0 — Fix Double Comptage, Fuite Cache, Optimisation
// ============================================================

import {
    collection, query, where, getDocs, doc, updateDoc, deleteDoc,
    Timestamp, writeBatch, addDoc, orderBy, limit
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

const REVIEW_REQUEST_TYPE = 'review_request';

// ============================================================
// ✅ NEW : Vider le cache au logout
// ============================================================
if (typeof document !== 'undefined') {
    document.addEventListener('auth-updated', async (e) => {
        const user = e.detail?.user;
        if (!user) {
            notificationsCache = [];
            unreadCount = 0;
            updateNotificationBadge();
        } else {
            // Recharger pour le nouvel utilisateur
            await loadNotifications();
            updateNotificationBadge();
        }
    });
}

// ============================================================
// CHARGER LES NOTIFICATIONS (Optimisé)
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
        // ✅ Ajout de orderBy et limit pour économiser le quota Firestore
        const q = query(
            collection(db, "notifications"),
            where("userId", "==", user.uid),
            orderBy("createdAt", "desc"),
            limit(50)
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
        
        // ✅ FIX DOUBLE COMPTAGE : On ne compte que les non-lus qui NE SONT PAS des review_request
        unreadCount = notificationsCache.filter(n => !n.read && !isReviewRequest(n)).length;
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

    // Les review_requests restent visibles jusqu'à ce qu'un avis soit déposé
    const pendingReviews = notificationsCache.filter(n => isReviewRequest(n)).length;

    // ✅ Calcul propre sans doublon
    const totalBadge = unreadCount + pendingReviews;

    if (totalBadge > 0) {
        badge.textContent = totalBadge > 9 ? '9+' : totalBadge;
        badge.style.display = 'flex';
        
        if (unreadCount === 0 && pendingReviews > 0) {
            badge.style.background = 'var(--gold)'; // Couleur spéciale si que des avis
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
        [REVIEW_REQUEST_TYPE]:                '⭐'
    };
    return icons[type] || '🔔';
}

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

    const closePanel = () => {
        releaseFocusTrap();
        panel.remove();
        document.removeEventListener('keydown', escHandler);
    };

    const escHandler = (e) => { if (e.key === 'Escape') closePanel(); };
    document.addEventListener('keydown', escHandler);

    document.getElementById('closeNotificationsBtn').addEventListener('click', closePanel);
    panel.addEventListener('click', (e) => { if (e.target === panel) closePanel(); });

    const markAllBtn = document.getElementById('markAllReadBtn');
    if (markAllBtn) {
        markAllBtn.addEventListener('click', async () => {
            await markAllAsRead();
            openNotificationsPanel(); // Re-render complet pour faire disparaître le bouton
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
        container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted);"><div style="font-size:3rem;margin-bottom:0.5rem;">🔕</div><p>${t('noNotifications')}</p></div>`;
        return;
    }

    // Trier les review_request en premier
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
        const safeId = escapeHTML(notif.id);

        const borderStyle = reviewReq ? 'border:2px solid var(--gold);background:linear-gradient(135deg,rgba(165,123,46,0.08),rgba(165,123,46,0.02));' : '';
        
        const deleteBtnHtml = reviewReq
            ? `<span style="font-size:0.65rem;background:var(--gold);color:#fff;padding:0.15rem 0.5rem;border-radius:30px;font-weight:700;white-space:nowrap;">⭐ À faire</span>`
            : `<button class="notif-delete-btn" data-notif-id="${safeId}" title="Supprimer" style="background:transparent;border:none;color:var(--text-dim);cursor:pointer;font-size:1rem;">✕</button>`;

        html += `
            <div class="notification-item ${isUnread ? 'unread' : ''} ${reviewReq ? 'review-request' : ''}" data-notif-id="${safeId}" style="${borderStyle}">
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
            await deleteNotification(btn.dataset.notifId);
            renderNotificationsContent();
        });
    });
}

// ============================================================
// CLIC SUR UNE NOTIFICATION
// ============================================================
async function handleNotificationClick(notif) {
    const reviewReq = isReviewRequest(notif);

    if (!notif.read && !reviewReq) {
        await markAsRead(notif.id);
        notif.read = true;
        unreadCount = Math.max(0, unreadCount - 1);
        updateNotificationBadge();
    }

    const panel = document.getElementById('notificationsPanel');
    if (panel) { releaseFocusTrap(); panel.remove(); }

    if (reviewReq && notif.orderId) {
        document.dispatchEvent(new CustomEvent('open-account-orders', { detail: { orderId: notif.orderId, filter: 'delivered' } }));
        return;
    }

    if (notif.orderId) {
        document.dispatchEvent(new CustomEvent('open-account-orders', { detail: { orderId: notif.orderId } }));
    } else if (notif.type === NOTIFICATION_TYPES.REVIEW_APPROVED) {
        if (notif.productSlug) window.location.href = `/produit?slug=${encodeURIComponent(notif.productSlug)}`;
        else showToast('ℹ️ ' + t('productNotFound'));
    }
}

// ============================================================
// MARQUER COMME LUE / TOUT LIRE / SUPPRIMER
// ============================================================
export async function markAsRead(notifId) {
    try {
        await updateDoc(doc(db, "notifications", notifId), { read: true });
        const notif = notificationsCache.find(n => n.id === notifId);
        if (notif) notif.read = true;
    } catch (e) {
        if (e.code === 'permission-denied') showToast('⚠️ ' + t('error'));
    }
}

export async function markAllAsRead() {
    const user = getCurrentUser();
    if (!user) return;
    try {
        const batch = writeBatch(db);
        notificationsCache.forEach(notif => {
            if (!notif.read && !isReviewRequest(notif)) {
                batch.update(doc(db, "notifications", notif.id), { read: true });
                notif.read = true;
            }
        });
        await batch.commit();
        unreadCount = notificationsCache.filter(n => !n.read && !isReviewRequest(n)).length;
        updateNotificationBadge();
    } catch (e) { console.error(e); }
}

export async function deleteNotification(notifId) {
    try {
        const notif = notificationsCache.find(n => n.id === notifId);
        if (notif && isReviewRequest(notif)) {
            showToast('⚠️ Déposez d\'abord votre avis');
            return;
        }
        await deleteDoc(doc(db, "notifications", notifId));
        if (notif && !notif.read) {
            unreadCount = Math.max(0, unreadCount - 1);
            updateNotificationBadge();
        }
        notificationsCache = notificationsCache.filter(n => n.id !== notifId);
        showToast('🗑️ ' + t('delete'));
    } catch (e) { console.error(e); }
}

// ============================================================
// CRÉER / SUPPRIMER (Admin & Système)
// ============================================================
export async function createNotification(userId, type, title, message, extra = {}) {
    try {
        await addDoc(collection(db, "notifications"), {
            userId, type, title, message, read: false, createdAt: Timestamp.now(), ...extra
        });
        return true;
    } catch (e) { return false; }
}

export async function deleteReviewRequestForOrder(orderId) {
    const user = getCurrentUser();
    if (!user || !orderId) return;
    try {
        const q = query(collection(db, "notifications"), where("userId", "==", user.uid), where("orderId", "==", orderId), where("type", "==", REVIEW_REQUEST_TYPE));
        const snap = await getDocs(q);
        if (snap.empty) return;
        await Promise.allSettled(snap.docs.map(d => deleteDoc(d.ref)));
        notificationsCache = notificationsCache.filter(n => !(n.type === REVIEW_REQUEST_TYPE && n.orderId === orderId));
        updateNotificationBadge();
    } catch (e) {}
}

// ============================================================
// CLOCHE DE NOTIFICATION
// ============================================================
export function injectNotificationBell() {
    const navRight = document.querySelector('.nav-right');
    if (!navRight || document.getElementById('notificationBell')) return;

    const bell = document.createElement('button');
    bell.id = 'notificationBell';
    bell.className = 'notification-bell';
    bell.setAttribute('aria-label', 'Notifications');
    bell.style.display = 'none';
    bell.innerHTML = `🔔<span class="notification-badge" id="notificationBadge" style="display:none;">0</span>`;

    const accountBtn = document.getElementById('accountBtn');
    if (accountBtn && accountBtn.parentNode) accountBtn.parentNode.insertBefore(bell, accountBtn);
    else navRight.appendChild(bell);
}

export function initNotificationBell() {
    injectNotificationBell();
    const bell = document.getElementById('notificationBell');
    if (!bell) return;

    const user = getCurrentUser();
    bell.style.display = user ? 'flex' : 'none';
    if (user) loadNotifications();

    if (!bell._initialized) {
        bell.addEventListener('click', openNotificationsPanel);
        bell._initialized = true;
    }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ notifications.js chargé — v2.0.0 (Fix Double Comptage, Cache)');