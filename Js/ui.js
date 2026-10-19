// js/ui.js
// ============================================================
// INTERFACE UTILISATEUR - SMART SWI9A
// Version 2.9.1 — FIX : cache getPendingReviewCount (perf)
// ============================================================

import { CONFIG } from "./config.js";
import {
    t, escapeHTML, getProductName, getProductImageUrl, getFallbackImage,
    safeGetItem, safeSetItem, formatDateTime, toDate,
    getCityName
} from "./utils.js";
import {
    getCart, getProducts, getState, setSelectedCity, getSelectedCity
} from "./store.js";
import {
    getCurrentUser, loginUser, logoutUser, requestPasswordReset,
    registerWithFirebase, resendVerificationEmail, resendVerificationForEmail,
    loginWithGoogle, loginWithFacebook,
    saveUserProfile, updateUserPassword, isAuthReady, authReadyPromise
} from "./auth.js";
import {
    getCartSubtotal, getCartTotalItems, getCartSavings, getCartDiscount,
    getCartDeliveryFee, getCartTotal, updateCartQuantity, removeFromCart,
    clearCart, checkout, checkAbandonedCart
} from "./cart.js";
import { renderUserOrders } from "./orders.js";
import {
    initNotificationBell, updateNotificationBadge,
    loadNotifications
} from "./notifications.js";
import { openProductPage } from "./products.js";
import {
    showToast, trapFocus, releaseFocusTrap, openModal, closeModal,
    confirmAction, openImageLightbox
} from "./ui-core.js";

// ============================================================
// ÉTAT LOCAL
// ============================================================
let pendingVerificationEmail = null;

// ✅ Référence globale à la notification panier abandonné
let _abandonedCartNotifEl = null;

// ✅ NEW v2.9.0 : Garde-fou pour le toast de rappel d'avis (1x/session)
let _reviewReminderShownThisSession = false;

// ============================================================
// ✅ FIX v2.9.1 : Cache du compteur d'avis en attente
// ------------------------------------------------------------
// Évite de recharger toutes les notifications Firestore à
// chaque ouverture de modal compte (2-3 requêtes → 1 max/15s).
// ============================================================
const PENDING_REVIEWS_CACHE_TTL = 15000; // 15 secondes
let _pendingReviewsCache = {
    count: 0,
    timestamp: 0,
    userId: null
};

/**
 * Invalide le cache du compteur d'avis en attente.
 * Appelé automatiquement sur review-submitted, review-deleted, auth-updated.
 */
export function invalidatePendingReviewsCache() {
    _pendingReviewsCache = { count: 0, timestamp: 0, userId: null };
    console.log('🔄 [ui.js] Cache pendingReviews invalidé');
}

// ============================================================
// ✅ NEW v2.9.0 : COMPTER LES AVIS EN ATTENTE (avec cache v2.9.1)
// ------------------------------------------------------------
// Source de vérité : les notifications "review_request" en cours.
// Une commande livrée non reviewée = 1 notif review_request.
// ============================================================
async function getPendingReviewCount(force = false) {
    const user = getCurrentUser();
    if (!user) return 0;

    // ✅ FIX v2.9.1 : utiliser le cache si valide et même user
    const now = Date.now();
    const cacheValid = !force
        && _pendingReviewsCache.userId === user.uid
        && (now - _pendingReviewsCache.timestamp) < PENDING_REVIEWS_CACHE_TTL;

    if (cacheValid) {
        return _pendingReviewsCache.count;
    }

    try {
        const notifications = await loadNotifications();
        const count = notifications.filter(n => n.type === 'review_request').length;
        _pendingReviewsCache = {
            count,
            timestamp: now,
            userId: user.uid
        };
        return count;
    } catch (e) {
        console.warn('⚠️ Erreur getPendingReviewCount :', e);
        return _pendingReviewsCache.count;
    }
}

// ============================================================
// HELPERS boutons flottants
// ============================================================
function hideFloatingButtons() {
    const cartBtn = document.querySelector('.cart-btn-float');
    const backToTop = document.querySelector('.back-to-top');
    const notifBell = document.querySelector('.notification-bell');

    if (cartBtn) cartBtn.style.display = 'none';
    if (backToTop) backToTop.style.display = 'none';
    if (notifBell) notifBell.style.display = 'none';
}

function showFloatingButtons() {
    const cartBtn = document.querySelector('.cart-btn-float');
    const backToTop = document.querySelector('.back-to-top');
    const notifBell = document.querySelector('.notification-bell');

    if (cartBtn) cartBtn.style.display = '';
    if (backToTop) backToTop.style.display = '';
    if (notifBell) notifBell.style.display = '';
}

// ============================================================
// INJECTION UI PARTAGÉE
// ============================================================
export function injectSharedUI() {
    if (!document.getElementById('accountModal')) {
        const modalHTML = `
            <div class="modal-overlay account-modal" id="accountModal">
                <div class="modal">
                    <button class="modal-close" id="accountModalClose" aria-label="${t('close')}">✕</button>
                    <h2 id="accountTitle" data-key="account">👤 ${t('account')}</h2>
                    <div id="accountContent"></div>
                </div>
            </div>
        `;
        const div = document.createElement('div');
        div.innerHTML = modalHTML;
        document.body.appendChild(div);
    }

    attachGlobalUIEvents();
}

// ============================================================
// ÉVÉNEMENTS GLOBAUX DE L'UI
// ============================================================
function attachGlobalUIEvents() {
    const accClose = document.getElementById('accountModalClose');
    if (accClose && !accClose._initialized) {
        accClose.addEventListener('click', closeAccountModal);
        accClose._initialized = true;
    }

    const accModal = document.getElementById('accountModal');
    if (accModal && !accModal._initialized) {
        accModal.addEventListener('click', (e) => {
            if (e.target === accModal) closeAccountModal();
        });
        accModal._initialized = true;
    }

    initNotificationBell();

    document.addEventListener('open-account', openAccountModal);
    document.addEventListener('close-account', closeAccountModal);
    document.addEventListener('auth-updated', () => {
        updateAccountButton();
        updateNotificationBadge();
        // Reset du garde-fou toast quand on change d'utilisateur
        _reviewReminderShownThisSession = false;
        // ✅ FIX v2.9.1 : invalider le cache (nouvel utilisateur = nouveaux avis)
        invalidatePendingReviewsCache();
    });

    // ✅ v2.9.0 : Support du filtre 'delivered' au clic sur notif review_request
    document.addEventListener('open-account-orders', (e) => {
        openAccountModal().then(() => {
            const orderId = e.detail?.orderId;
            const filter = e.detail?.filter;

            setTimeout(async () => {
                // Cliquer sur l'onglet "Commandes"
                const tabBtn = document.querySelector('#accountContent [data-tab="orders"]');
                if (tabBtn) tabBtn.click();

                // Attendre que les commandes soient rendues
                await new Promise(resolve => setTimeout(resolve, 600));

                // ✅ Appliquer le filtre 'delivered' si demandé
                if (filter) {
                    const filterBtn = document.querySelector(`[data-order-filter="${filter}"]`);
                    if (filterBtn) filterBtn.click();
                }

                // ✅ Ouvrir la modal de détails si orderId fourni
                if (orderId) {
                    const { openOrderDetails } = await import("./orders.js");
                    setTimeout(() => openOrderDetails(orderId, false), 300);
                }
            }, 300);
        });
    });

    // ✅ NEW v2.9.0 : Écouter review-submitted pour rafraîchir le menu compte
    document.addEventListener('review-submitted', async () => {
        console.log('⭐ [ui.js] Event review-submitted — refresh menu compte si ouvert');
        // ✅ FIX v2.9.1 : invalider le cache (nouvel avis déposé)
        invalidatePendingReviewsCache();
        const modal = document.getElementById('accountModal');
        if (modal && modal.classList.contains('open')) {
            // Rafraîchir le badge "Commandes" du menu compte
            await refreshOrdersTabBadge();
        }
    });

    // ✅ FIX v2.9.1 : Écouter review-deleted pour invalider aussi
    document.addEventListener('review-deleted', () => {
        console.log('⭐ [ui.js] Event review-deleted — invalidation cache');
        invalidatePendingReviewsCache();
    });

    // ============================================================
    // LANG CHANGE : re-render modal compte + notification panier
    // ============================================================
    document.addEventListener('lang-changed', () => {
        // Re-render la modal compte si ouverte
        const modal = document.getElementById('accountModal');
        if (modal && modal.classList.contains('open')) {
            console.log('🔄 [ui.js] Re-render modal compte en langue :', document.documentElement.lang);
            renderAccountContent();
        }

        // ✅ Re-render la notification panier abandonné si présente
        if (_abandonedCartNotifEl) {
            console.log('🔄 [ui.js] Re-render notification panier abandonné');
            showAbandonedCartNotification();
        }

        // Met aussi à jour le bouton compte
        updateAccountButton();
    });
}

// ============================================================
// ✅ NEW v2.9.0 : RAFRAÎCHIR LE BADGE "Commandes" DANS LE MENU COMPTE
// ============================================================
async function refreshOrdersTabBadge() {
    const ordersTabBtn = document.querySelector('#accountContent [data-tab="orders"]');
    if (!ordersTabBtn) return;

    // ✅ FIX v2.9.1 : passer force=true pour être sûr d'avoir le bon compte
    // (l'appelant vient de review-submitted, donc cache invalidé juste avant,
    // mais on force par sécurité)
    const count = await getPendingReviewCount(true);
    const label = ordersTabBtn.querySelector('.orders-tab-label');
    const badge = ordersTabBtn.querySelector('.orders-tab-badge');

    if (count > 0) {
        if (badge) {
            badge.textContent = `⭐${count}`;
        } else {
            // Créer le badge s'il n'existe pas
            const span = document.createElement('span');
            span.className = 'orders-tab-badge';
            span.style.cssText = 'background:var(--gold);color:#fff;font-size:0.65rem;padding:0.1rem 0.45rem;border-radius:30px;margin-left:0.3rem;font-weight:700;';
            span.textContent = `⭐${count}`;
            ordersTabBtn.appendChild(span);
        }
    } else if (badge) {
        badge.remove();
    }
}

// ============================================================
// PANIER - REDIRECTION vers page /panier
// ============================================================
export function openCart() {
    const currentPath = window.location.pathname;
    if (currentPath === '/panier' || currentPath.endsWith('/panier') || currentPath.endsWith('panier.html')) {
        console.log('ℹ️ Déjà sur la page panier');
        return;
    }
    window.location.href = '/panier';
}

export function closeCart() {
    console.log('ℹ️ closeCart() appelée — page panier dédiée');
    const overlay = document.getElementById('cartOverlay');
    const sidebar = document.getElementById('cartSidebar');
    if (overlay) overlay.classList.remove('open');
    if (sidebar) sidebar.classList.remove('open');
    document.body.style.overflow = '';
    showFloatingButtons();
    releaseFocusTrap();
}

export function renderCartContent() {
    console.log('ℹ️ renderCartContent() appelée — page panier dédiée désormais');
}

export function updateCartTotalsUI() {
    // Géré par panier.js
}

export function initCitySearch() {
    // Géré par panier.js
}

// ============================================================
// MODAL COMPTE - OUVRIR / FERMER
// ============================================================
export async function openAccountModal() {
    const modal = document.getElementById('accountModal');
    if (!modal) return;
    if (!isAuthReady()) await authReadyPromise;

    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    updateAccountButton();
    await renderAccountContent();
    trapFocus(modal);

    // ✅ NEW v2.9.0 : Toast de rappel (1 fois par session)
    if (!_reviewReminderShownThisSession) {
        const pending = await getPendingReviewCount();
        if (pending > 0) {
            _reviewReminderShownThisSession = true;
            setTimeout(() => {
                showToast(`⭐ Vous avez ${pending} avis à donner !`);
            }, 500);
        }
    }
}

export function closeAccountModal() {
    const modal = document.getElementById('accountModal');
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
    releaseFocusTrap();
}

// ============================================================
// BOUTON COMPTE (navbar)
// ============================================================
export function updateAccountButton() {
    const user = getCurrentUser();
    const btn = document.getElementById('accountBtn');
    const mobileBtn = document.getElementById('mobileAccountBtn');

    let displayText;
    let fullDisplay;

    if (user) {
        const firstName = (user.firstName || '').trim();
        const fullName  = (user.name || '').trim();
        const emailUser = user.email ? user.email.split('@')[0] : '';

        const firstWord = fullName.split(' ')[0] || '';
        fullDisplay = firstName || firstWord || emailUser || 'Mon compte';

        displayText = fullDisplay.length > 10
            ? fullDisplay.substring(0, 10) + '…'
            : fullDisplay;
    } else {
        displayText = t('navAccount');
        fullDisplay = displayText;
    }

    const dataKeyAttr = user ? '' : ' data-key="navAccount"';
    const safeText = escapeHTML(displayText);
    const safeTitle = escapeHTML(fullDisplay);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

    if (btn) {
        btn.innerHTML = `${svg}<span${dataKeyAttr} title="${safeTitle}">${safeText}</span>`;
        btn.setAttribute('aria-label', user ? `Mon compte : ${safeTitle}` : t('ariaAccount'));
        btn.classList.toggle('is-logged-in', !!user);
    }
    if (mobileBtn) {
        mobileBtn.innerHTML = `👤<span${dataKeyAttr}>${safeText}</span>`;
    }

    updateNotificationBadge();
}

// ============================================================
// RENDU DU CONTENU DU COMPTE
// ============================================================
export async function renderAccountContent() {
    const container = document.getElementById('accountContent');
    if (!container) return;

    const user = getCurrentUser();

    if (!user) {
        if (pendingVerificationEmail) {
            container.innerHTML = renderVerifyEmailView(pendingVerificationEmail);
            attachVerifyEmailEvents();
            return;
        }
        container.innerHTML = renderAuthViews();
        attachAuthEvents();
        return;
    }

    let verifyBanner = '';
    if (user.emailVerified === false && user.signupMethod === 'otp') {
        verifyBanner = `
            <div style="background:var(--warning-bg);border:1px solid var(--warning);border-radius:var(--radius-sm);padding:0.8rem;margin-bottom:1rem;font-size:0.85rem;">
                📧 <strong>${t('verifyEmailTitle')}</strong><br>
                ${t('verifyEmailMessage')}
                <button id="resendVerifBtn" style="background:transparent;border:1px solid var(--gold);color:var(--gold);padding:0.3rem 0.8rem;border-radius:30px;font-size:0.75rem;margin-top:0.5rem;cursor:pointer;">
                    🔄 ${t('verifyEmailResendBtn')}
                </button>
            </div>
        `;
    }

    // ✅ NEW v2.9.0 : Calculer les avis en attente AVANT le rendu
    // ✅ FIX v2.9.1 : utilise le cache
    const pendingReviews = await getPendingReviewCount();

    container.innerHTML = verifyBanner + renderDashboard(user, pendingReviews);
    attachDashboardEvents(user);
    loadDashboardTab('dashboard', user);
}

// ============================================================
// ÉCRAN DE VÉRIFICATION EMAIL
// ============================================================
function renderVerifyEmailView(email) {
    return `
        <div style="text-align:center;padding:1rem 0;">
            <div style="font-size:4rem;margin-bottom:1rem;line-height:1;">📧</div>
            <h2 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:1rem;font-size:1.3rem;">
                ${t('verifyEmailTitle')}
            </h2>
            <p style="color:var(--text-muted);font-size:0.95rem;margin-bottom:0.5rem;line-height:1.6;">
                ${t('verifyEmailMessage')}
            </p>
            <p style="color:var(--gold);font-weight:700;font-size:1rem;margin:1rem 0;word-break:break-all;">
                📩 ${escapeHTML(email)}
            </p>
            <div style="background:var(--info-bg);border:1px solid var(--info);border-radius:var(--radius-sm);padding:0.9rem;margin:1.5rem 0;font-size:0.85rem;color:var(--text-muted);line-height:1.7;text-align:left;">
                <div style="margin-bottom:0.5rem;">💡 <strong>${t('verifyEmailSteps')}</strong></div>
                <div>1️⃣ ${t('verifyEmailStep1')}</div>
                <div>2️⃣ ${t('verifyEmailStep2')}</div>
                <div>3️⃣ ${t('verifyEmailStep3')}</div>
            </div>

            <button id="resendVerifBtn" style="width:100%;padding:0.85rem;background:linear-gradient(135deg,var(--gold),#7d5a1d);color:#fff;border:none;border-radius:50px;font-weight:700;cursor:pointer;font-size:0.9rem;margin-bottom:0.8rem;">
                🔄 ${t('verifyEmailResendBtn')}
            </button>

            <button id="backToLoginBtn" style="width:100%;padding:0.7rem;background:transparent;border:1px solid var(--border);color:var(--text-muted);border-radius:50px;font-weight:600;cursor:pointer;font-size:0.85rem;">
                ↩️ ${t('backToLogin')}
            </button>

            <div id="verifyEmailMsg" style="font-size:0.85rem;margin-top:1rem;min-height:1.2rem;"></div>
        </div>
    `;
}

function attachVerifyEmailEvents() {
    const resendBtn = document.getElementById('resendVerifBtn');
    const backBtn = document.getElementById('backToLoginBtn');
    const msgEl = document.getElementById('verifyEmailMsg');

    if (resendBtn) {
        resendBtn.addEventListener('click', async () => {
            resendBtn.disabled = true;
            resendBtn.textContent = '⏳ ' + t('loading');
            if (msgEl) msgEl.textContent = '';

            if (msgEl) {
                msgEl.textContent = '💡 ' + t('verifyEmailResendHint');
                msgEl.style.color = 'var(--gold)';
            }
            resendBtn.textContent = '🔄 ' + t('verifyEmailResendBtn');
            resendBtn.disabled = false;
        });
    }

    if (backBtn) {
        backBtn.addEventListener('click', () => {
            pendingVerificationEmail = null;
            renderAccountContent();
        });
    }
}

// ============================================================
// VUES AUTH
// ============================================================
function renderAuthViews() {
    return `
        <div class="account-form" id="accountForm">
            <div id="authView">

                <div class="social-login-buttons">
                    <button class="btn-social btn-social-google" id="googleLoginBtn" type="button">
                        <svg viewBox="0 0 24 24">
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
                        <span>${t('socialGoogle')}</span>
                    </button>
                    <button class="btn-social btn-social-facebook" id="facebookLoginBtn" type="button">
                        <svg viewBox="0 0 24 24" fill="white">
                            <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                        </svg>
                        <span>${t('socialFacebook')}</span>
                    </button>
                </div>

                <div class="auth-separator">${t('socialOr')}</div>

                <div id="loginView">
                    <label style="font-size:0.85rem;color:var(--text-muted);">📧 ${t('accountEmailPlaceholder')}</label>
                    <input type="email" id="authEmailLogin" placeholder="${t('accountEmailPlaceholder')}" autocomplete="email">

                    <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">🔒 ${t('accountPasswordPlaceholder')}</label>
                    <input type="password" id="authPasswordLogin" placeholder="${t('accountPasswordPlaceholder')}" autocomplete="current-password">

                    <button class="btn-submit" id="loginBtn">🔓 ${t('login')}</button>
                    <div class="switch-mode" id="switchToRegister">${t('noAccount')} <span>${t('register')}</span></div>
                    <div class="switch-mode" id="switchToForgot" style="font-size:0.75rem;margin-top:0.3rem;">${t('forgotPassword')}</div>
                </div>

                <div id="registerView" style="display:none;">
                    <label style="font-size:0.85rem;color:var(--text-muted);">👤 ${t('accountLastNamePlaceholder')}</label>
                    <input type="text" id="regLastName" placeholder="${t('accountLastNamePlaceholder')}" autocomplete="family-name">

                    <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">👤 ${t('accountFirstNamePlaceholder')}</label>
                    <input type="text" id="regFirstName" placeholder="${t('accountFirstNamePlaceholder')}" autocomplete="given-name">

                    <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">🎂 ${t('accountDobPlaceholder')}</label>
                    <input type="date" id="regDob" class="date-input">

                    <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">📧 ${t('accountEmailPlaceholder')}</label>
                    <input type="email" id="regEmail" placeholder="${t('accountEmailPlaceholder')}" autocomplete="email">

                    <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">📞 ${t('accountPhonePlaceholder')}</label>
                    <input type="tel" id="regPhone" placeholder="${t('accountPhonePlaceholder')}" autocomplete="tel">

                    <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">🔒 ${t('accountPasswordPlaceholder')}</label>
                    <input type="password" id="regPassword" placeholder="${t('accountPasswordPlaceholder')}" autocomplete="new-password">

                    <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">🔒 ${t('accountConfirmPasswordPlaceholder')}</label>
                    <input type="password" id="regConfirmPassword" placeholder="${t('accountConfirmPasswordPlaceholder')}" autocomplete="new-password">

                    <button class="btn-submit" id="registerBtn">✨ ${t('register')}</button>
                    <div class="switch-mode" id="switchToLogin">${t('alreadyHaveAccount')} <span>${t('login')}</span></div>
                </div>

                <div id="forgotView" style="display:none;">
                    <p style="font-size:0.85rem;color:var(--text-muted);text-align:center;margin-bottom:0.8rem;">
                        📧 ${t('resetPassword')}
                    </p>
                    <label style="font-size:0.85rem;color:var(--text-muted);">📧 ${t('accountEmailPlaceholder')}</label>
                    <input type="email" id="forgotEmail" placeholder="${t('accountEmailPlaceholder')}" autocomplete="email">
                    <button class="btn-submit" id="forgotBtn">📧 ${t('resetPassword')}</button>
                    <div class="switch-mode" id="switchToLoginFromForgot" style="font-size:0.75rem;margin-top:0.3rem;">↩️ ${t('backToLogin')}</div>
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// ÉVÉNEMENTS DES VUES AUTH
// ============================================================
function attachAuthEvents() {
    const dobInput = document.getElementById('regDob');
    if (dobInput) {
        dobInput.style.cursor = 'pointer';
        dobInput.addEventListener('click', (e) => {
            if (typeof dobInput.showPicker === 'function') {
                try { dobInput.showPicker(); } catch (err) { /* silencieux */ }
            }
        });
        dobInput.addEventListener('focus', () => {
            if (typeof dobInput.showPicker === 'function') {
                try { dobInput.showPicker(); } catch (err) { /* silencieux */ }
            }
        });
    }

    const googleBtn = document.getElementById('googleLoginBtn');
    if (googleBtn) {
        googleBtn.addEventListener('click', async () => {
            googleBtn.disabled = true;
            const originalText = googleBtn.innerHTML;
            googleBtn.innerHTML = '⏳...';
            const user = await loginWithGoogle();
            if (user) {
                await renderAccountContent();
                await loadDashboardTab('dashboard', user);
            } else {
                googleBtn.disabled = false;
                googleBtn.innerHTML = originalText;
            }
        });
    }

    const facebookBtn = document.getElementById('facebookLoginBtn');
    if (facebookBtn) {
        facebookBtn.addEventListener('click', async () => {
            facebookBtn.disabled = true;
            const originalText = facebookBtn.innerHTML;
            facebookBtn.innerHTML = '⏳...';
            const user = await loginWithFacebook();
            if (user) {
                await renderAccountContent();
                await loadDashboardTab('dashboard', user);
            } else {
                facebookBtn.disabled = false;
                facebookBtn.innerHTML = originalText;
            }
        });
    }

    const switchToRegister = document.getElementById('switchToRegister');
    if (switchToRegister) switchToRegister.addEventListener('click', () => switchAuthView('register'));

    const switchToLogin = document.getElementById('switchToLogin');
    if (switchToLogin) switchToLogin.addEventListener('click', () => switchAuthView('login'));

    const switchToForgot = document.getElementById('switchToForgot');
    if (switchToForgot) switchToForgot.addEventListener('click', () => switchAuthView('forgot'));

    const switchToLoginFromForgot = document.getElementById('switchToLoginFromForgot');
    if (switchToLoginFromForgot) switchToLoginFromForgot.addEventListener('click', () => switchAuthView('login'));

    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) loginBtn.addEventListener('click', handleLogin);

    const registerBtn = document.getElementById('registerBtn');
    if (registerBtn) registerBtn.addEventListener('click', handleRegister);

    const forgotBtn = document.getElementById('forgotBtn');
    if (forgotBtn) forgotBtn.addEventListener('click', handleForgot);
}

function switchAuthView(view) {
    const views = ['loginView', 'registerView', 'forgotView'];
    views.forEach(v => {
        const el = document.getElementById(v);
        if (el) el.style.display = 'none';
    });
    const target = document.getElementById(view + 'View');
    if (target) target.style.display = 'block';
}

// ============================================================
// HANDLER LOGIN
// ============================================================
async function handleLogin() {
    const email = document.getElementById('authEmailLogin').value.trim();
    const password = document.getElementById('authPasswordLogin').value.trim();
    if (!email || !password) { showToast('⚠️ ' + t('fillAllFields')); return; }

    const loginBtn = document.getElementById('loginBtn');
    loginBtn.disabled = true;
    loginBtn.textContent = '⏳...';

    const result = await loginUser(email, password);

    if (!result.success && result.reason === 'email_not_verified') {
        pendingVerificationEmail = result.email || email;
        showToast('📧 ' + t('verifyEmailResent'));
        renderAccountContent();
        return;
    }

    if (result.success) {
        showToast('✅ ' + t('loginSuccess'));
        // Reset du garde-fou pour afficher le toast de rappel d'avis
        _reviewReminderShownThisSession = false;
        await renderAccountContent();
        await loadDashboardTab('dashboard', result.user);
        return;
    }

    loginBtn.disabled = false;
    loginBtn.textContent = '🔓 ' + t('login');
    if (result.message) showToast('❌ ' + result.message);
}

// ============================================================
// INSCRIPTION
// ============================================================
async function handleRegister() {
    const lastName = document.getElementById('regLastName').value.trim();
    const firstName = document.getElementById('regFirstName').value.trim();
    const dob = document.getElementById('regDob').value;
    const email = document.getElementById('regEmail').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirm = document.getElementById('regConfirmPassword').value;

    if (!lastName || !firstName || !email || !phone || !password) {
        showToast('⚠️ ' + t('fillAllFields'));
        return;
    }
    if (password.length < 6) {
        showToast('⚠️ ' + t('passwordTooShort'));
        return;
    }
    if (password !== confirm) {
        showToast('⚠️ ' + t('passwordMismatch'));
        return;
    }

    const fullName = `${firstName} ${lastName}`;

    const registerBtn = document.getElementById('registerBtn');
    registerBtn.disabled = true;
    registerBtn.textContent = '⏳ ' + t('register');

    const result = await registerWithFirebase(fullName, email, phone, dob, password);

    if (result.success) {
        pendingVerificationEmail = result.email || email;
        showToast('📧 ' + t('verifyEmailSent'));
        renderAccountContent();
        return;
    }

    registerBtn.disabled = false;
    registerBtn.textContent = '✨ ' + t('register');
}

async function handleForgot() {
    const email = document.getElementById('forgotEmail').value.trim();
    if (!email) { showToast('⚠️ ' + t('fillAllFields')); return; }
    const success = await requestPasswordReset(email);
    if (success) {
        showToast('✅ ' + t('resetPassword'));
        switchAuthView('login');
    }
}

// ============================================================
// DASHBOARD CLIENT
// ============================================================
function renderDashboard(user, pendingReviews = 0) {
    // ✅ NEW v2.9.0 : Badge sur l'onglet "Commandes" + bannière de rappel
    const ordersBadge = pendingReviews > 0
        ? `<span class="orders-tab-badge" style="background:var(--gold);color:#fff;font-size:0.65rem;padding:0.1rem 0.45rem;border-radius:30px;margin-left:0.3rem;font-weight:700;">⭐${pendingReviews}</span>`
        : '';

    const reminderBanner = pendingReviews > 0
        ? `
            <div class="review-reminder-banner" style="background:linear-gradient(135deg,rgba(165,123,46,0.12),rgba(165,123,46,0.04));border:1px solid var(--border-gold);border-radius:var(--radius-md);padding:0.9rem 1rem;margin-bottom:1rem;display:flex;align-items:center;gap:0.7rem;flex-wrap:wrap;animation:pulse-review 2s ease-in-out infinite;">
                <span style="font-size:1.8rem;">⭐</span>
                <div style="flex:1;min-width:0;font-size:0.88rem;line-height:1.4;">
                    <strong style="color:var(--gold);">Vous avez ${pendingReviews} avis à donner !</strong><br>
                    <span style="color:var(--text-muted);font-size:0.8rem;">Partagez votre expérience sur vos produits livrés.</span>
                </div>
                <button id="goToReviewsBtn" style="background:linear-gradient(135deg,var(--gold),#7d5a1d);color:#fff;border:none;border-radius:30px;padding:0.5rem 1rem;font-weight:700;cursor:pointer;font-size:0.8rem;white-space:nowrap;">
                    ⭐ ${t('leaveReview') || 'Laisser un avis'}
                </button>
            </div>
        `
        : '';

    return `
        <div style="text-align:center;padding:0.5rem 0 1rem;">
            <div style="font-size:1.1rem;font-weight:700;color:var(--gold);">
                👋 ${t('emailHello')}, ${escapeHTML(user.name || user.firstName || user.email)}
            </div>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem;">
                📧 ${escapeHTML(user.email)}
            </div>
        </div>

        ${reminderBanner}

        <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:0.5rem;">
            <button class="tab-btn active" data-tab="dashboard">📊 ${t('dashboard')}</button>
            <button class="tab-btn" data-tab="orders">📦 ${t('orders')}${ordersBadge}</button>
            <button class="tab-btn" data-tab="favorites">❤️ ${t('favorites')}</button>
            <button class="tab-btn" data-tab="myreviews">⭐ ${t('myReviews')}</button>
            <button class="tab-btn" data-tab="settings">⚙️ ${t('profile')}</button>
            <button class="logout-btn" id="logoutBtn" style="margin-left:auto;">🚪 ${t('logout')}</button>
        </div>

        <div id="tabContent" style="min-height:200px;"></div>
    `;
}

function attachDashboardEvents(user) {
    const resendBtn = document.getElementById('resendVerifBtn');
    if (resendBtn) {
        resendBtn.addEventListener('click', async () => {
            resendBtn.disabled = true;
            resendBtn.textContent = '⏳...';
            const ok = await resendVerificationEmail();
            if (ok) {
                resendBtn.textContent = '✅ ' + t('success');
            } else {
                resendBtn.disabled = false;
                resendBtn.textContent = '🔄 ' + t('verifyEmailResendBtn');
            }
        });
    }

    // ✅ NEW v2.9.0 : Bouton "Laisser un avis" de la bannière → aller sur l'onglet Commandes
    const goToReviewsBtn = document.getElementById('goToReviewsBtn');
    if (goToReviewsBtn) {
        goToReviewsBtn.addEventListener('click', () => {
            const ordersTabBtn = document.querySelector('#accountContent [data-tab="orders"]');
            if (ordersTabBtn) {
                document.querySelectorAll('#accountContent .tab-btn').forEach(b => b.classList.remove('active'));
                ordersTabBtn.classList.add('active');
                loadDashboardTab('orders', user).then(async () => {
                    // Filtrer sur "delivered" après le rendu
                    await new Promise(resolve => setTimeout(resolve, 400));
                    const filterBtn = document.querySelector('[data-order-filter="delivered"]');
                    if (filterBtn) filterBtn.click();
                });
            }
        });
    }

    document.querySelectorAll('#accountContent .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#accountContent .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadDashboardTab(btn.dataset.tab, user);
        });
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await logoutUser();
            showToast('👋 ' + t('logout'));
            closeAccountModal();
            updateAccountButton();
        });
    }
}

async function loadDashboardTab(tab, user) {
    const container = document.getElementById('tabContent');
    if (!container) return;

    if (tab === 'dashboard') {
        container.innerHTML = `
            <div style="text-align:center;padding:1rem;">
                <div style="font-size:1.2rem;font-weight:700;color:var(--gold);">${escapeHTML(user.name || user.email)}</div>
                <div style="margin-top:0.5rem;font-size:0.85rem;color:var(--text-muted);">
                    📧 ${escapeHTML(user.email || '')}<br>
                    ${user.phone ? `📞 ${escapeHTML(user.phone)}` : ''}
                </div>
            </div>
        `;
    } else if (tab === 'orders') {
        await renderUserOrders('tabContent');
    } else if (tab === 'favorites') {
        renderFavorites(container, user);
    } else if (tab === 'myreviews') {
        renderMyReviews(container, user);
    } else if (tab === 'settings') {
        renderSettingsForm(container, user);
    }
}

// ============================================================
// FAVORIS
// ============================================================
function renderFavorites(container, user) {
    const favs = user.favorites || [];
    const products = getProducts().filter(p => favs.includes(Number(p.id)) || favs.includes(p.id));

    if (products.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted);">❤️ ${t('noFavorites')}</div>`;
        return;
    }

    let html = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:0.8rem;">`;
    products.forEach(p => {
        html += `
            <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.5rem;text-align:center;cursor:pointer;" data-product-slug="${escapeHTML(p.slug || '')}">
                <img src="${getProductImageUrl(p)}" style="width:100%;aspect-ratio:1;object-fit:contain;border-radius:8px;" loading="lazy">
                <div style="font-size:0.8rem;font-weight:600;margin-top:0.3rem;">${escapeHTML(getProductName(p))}</div>
                <div style="font-size:0.85rem;color:var(--gold);">${p.price} ${t('currency')}</div>
            </div>
        `;
    });
    html += `</div>`;
    container.innerHTML = html;

    container.querySelectorAll('[data-product-slug]').forEach(card => {
        card.addEventListener('click', () => {
            const slug = card.dataset.productSlug;
            if (slug) {
                closeAccountModal();
                setTimeout(() => openProductPage(slug), 200);
            }
        });
    });
}

// ============================================================
// MES AVIS
// ============================================================
async function renderMyReviews(container, user) {
    container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">⏳ ${t('loadingReviews')}</div>`;

    try {
        const { collection, query, where, getDocs } = await import("firebase/firestore");
        const { db } = await import("./firebase.js");

        const q = query(
            collection(db, "reviews"),
            where("userId", "==", user.uid)
        );
        const snap = await getDocs(q);
        const reviews = snap.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                createdAt: toDate(data.createdAt)
            };
        }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        if (reviews.length === 0) {
            container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted);">⭐ ${t('noReviews')}</div>`;
            return;
        }

        let html = '';
        reviews.forEach(r => {
            const statusEmoji = r.status === 'approved' ? '🟢' : (r.status === 'rejected' ? '🔴' : '🟡');
            const statusLabel = r.status === 'approved' ? t('reviewPublished') : (r.status === 'rejected' ? t('reviewStatusRejected') : t('reviewPendingApproval'));
            html += `
                <div class="review-item" style="margin-bottom:0.8rem;">
                    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.3rem;">
                        <div style="color:var(--gold);">${'★'.repeat(r.rating || 0)}${'☆'.repeat(5 - (r.rating || 0))}</div>
                        <div style="font-size:0.75rem;">${statusEmoji} ${statusLabel}</div>
                    </div>
                    ${r.title ? `<div style="font-weight:600;font-size:0.9rem;margin-top:0.3rem;">${escapeHTML(r.title)}</div>` : ''}
                    <div style="font-size:0.85rem;color:var(--text-muted);margin:0.3rem 0;">${escapeHTML(r.comment || '')}</div>
                    ${(r.photos && r.photos.length > 0) ? `<div class="review-photos">${r.photos.map(url => `<img src="${escapeHTML(url)}" alt="Photo" data-photo-url="${escapeHTML(url)}" style="cursor:zoom-in;">`).join('')}</div>` : ''}
                    <div style="font-size:0.7rem;color:var(--text-dim);">${formatDateTime(r.createdAt)}</div>
                </div>
            `;
        });
        container.innerHTML = html;

        container.querySelectorAll('img[data-photo-url]').forEach(img => {
            img.addEventListener('click', () => openImageLightbox(img.dataset.photoUrl));
        });
    } catch (e) {
        console.error('Erreur mes avis :', e);
        container.innerHTML = `<div style="text-align:center;color:var(--danger);">${t('loadingError')}</div>`;
    }
}

// ============================================================
// PARAMÈTRES (PROFIL)
// ============================================================
function renderSettingsForm(container, user) {
    container.innerHTML = `
        <div class="edit-profile-form">
            <h3 style="margin-bottom:1rem;color:var(--gold);font-family:var(--font-secondary);">⚙️ ${t('editProfile')}</h3>
            <div id="editProfileMsg" style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem;"></div>

            <label style="font-size:0.85rem;color:var(--text-muted);">👤 ${t('accountNamePlaceholder')}</label>
            <input type="text" id="editName" value="${escapeHTML(user.name || '')}">

            <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">📞 ${t('accountPhonePlaceholder')}</label>
            <input type="tel" id="editPhone" value="${escapeHTML(user.phone || '')}">

            <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">🔒 ${t('newPassword')} (${t('leaveEmpty')})</label>
            <input type="password" id="editNewPassword">

            <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">🔒 ${t('confirmPassword')}</label>
            <input type="password" id="editConfirmPassword">

            <div style="display:flex;gap:0.5rem;margin-top:1rem;">
                <button class="btn-save-profile" id="saveProfileBtn">💾 ${t('save')}</button>
                <button class="btn-cancel-edit" id="cancelEditBtn">❌ ${t('cancel')}</button>
            </div>
        </div>
    `;

    document.getElementById('saveProfileBtn').addEventListener('click', async () => {
        const name = document.getElementById('editName').value.trim();
        const phone = document.getElementById('editPhone').value.trim();
        const newPassword = document.getElementById('editNewPassword').value;
        const confirmPassword = document.getElementById('editConfirmPassword').value;
        const msgEl = document.getElementById('editProfileMsg');

        if (newPassword && newPassword !== confirmPassword) {
            if (msgEl) { msgEl.textContent = '⚠️ ' + t('passwordMismatch'); msgEl.style.color = 'var(--danger)'; }
            return;
        }
        if (newPassword && newPassword.length < 6) {
            if (msgEl) { msgEl.textContent = '⚠️ ' + t('passwordTooShort'); msgEl.style.color = 'var(--danger)'; }
            return;
        }

        try {
            const updates = {};
            if (name && name !== user.name) updates.name = name;
            if (phone && phone !== user.phone) updates.phone = phone;
            if (Object.keys(updates).length > 0) {
                await saveUserProfile(user.uid, updates);
                Object.assign(user, updates);
            }
            if (newPassword) {
                await updateUserPassword(newPassword);
            }
            showToast('✅ ' + t('profileUpdated'));
            if (msgEl) { msgEl.textContent = '✅ ' + t('profileUpdated'); msgEl.style.color = 'var(--success)'; }
        } catch (e) {
            console.error(e);
            showToast('❌ ' + (e.message || t('error')));
        }
    });

    document.getElementById('cancelEditBtn').addEventListener('click', () => {
        renderAccountContent();
    });
}

// ============================================================
// THÈME
// ============================================================
export function toggleTheme() {
    console.log('ℹ️ Mode clair unique — toggle désactivé');
}

export function loadTheme() {
    document.body.classList.remove('light-mode');
}

// ============================================================
// COOKIE CONSENT
// ============================================================
export function initCookieConsent() {
    const key = CONFIG.STORAGE_KEYS.COOKIE_CONSENT;
    if (safeGetItem(key) === 'accepted' || safeGetItem(key) === 'declined') return;

    const banner = document.createElement('div');
    banner.id = 'cookieConsent';
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:var(--bg-card);border-top:1px solid var(--border-gold);padding:1rem 1.5rem;z-index:99999;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;backdrop-filter:blur(12px);box-shadow:var(--shadow-lg);';
    banner.innerHTML = `
        <div style="flex:1;min-width:200px;">
            <p style="margin:0;font-size:0.85rem;color:var(--text-muted);">
                🍪 ${t('privacyText')}
                <a href="/#legal" style="color:var(--gold);">${t('privacySummary')}</a>
            </p>
        </div>
        <div style="display:flex;gap:0.5rem;">
            <button id="cookieAcceptBtn" style="padding:0.5rem 1.2rem;background:var(--gold);color:#fff;border:none;border-radius:30px;font-weight:700;cursor:pointer;">✅ ${t('confirm')}</button>
            <button id="cookieDeclineBtn" style="padding:0.5rem 1.2rem;background:transparent;border:1px solid var(--border);color:var(--text-muted);border-radius:30px;cursor:pointer;">${t('cancel')}</button>
        </div>
    `;
    document.body.appendChild(banner);

    document.getElementById('cookieAcceptBtn').addEventListener('click', () => {
        safeSetItem(key, 'accepted');
        banner.remove();
    });
    document.getElementById('cookieDeclineBtn').addEventListener('click', () => {
        safeSetItem(key, 'declined');
        banner.remove();
    });
}

// ============================================================
// NOTIFICATION PANIER ABANDONNÉ (re-render à chaque langue)
// ============================================================
export function showAbandonedCartNotification() {
    if (_abandonedCartNotifEl) {
        try { _abandonedCartNotifEl.remove(); } catch (e) { /* ignore */ }
        _abandonedCartNotifEl = null;
    }

    document.querySelectorAll('.abandoned-cart-notification').forEach(el => el.remove());

    const abandoned = checkAbandonedCart();
    if (!abandoned || !abandoned.items || abandoned.items.length === 0) return;

    const count = abandoned.items.reduce((s, i) => s + (i.quantity || 0), 0);

    const notif = document.createElement('div');
    notif.className = 'abandoned-cart-notification show';
    notif.innerHTML = `
        <div class="abandoned-cart-content">
            <div class="abandoned-cart-icon">🛒</div>
            <div class="abandoned-cart-text">
                <strong>${t('abandonedCartTitle')}</strong>
                <span>${t('abandonedCartMessage').replace('{count}', count)}</span>
            </div>
            <div class="abandoned-cart-actions">
                <button class="btn-abandoned-cart">${t('abandonedCartView')}</button>
                <button class="btn-abandoned-dismiss">✕</button>
            </div>
        </div>
    `;
    document.body.appendChild(notif);
    _abandonedCartNotifEl = notif;

    notif.querySelector('.btn-abandoned-cart').addEventListener('click', () => {
        openCart();
        notif.remove();
        _abandonedCartNotifEl = null;
    });
    notif.querySelector('.btn-abandoned-dismiss').addEventListener('click', () => {
        notif.remove();
        _abandonedCartNotifEl = null;
        localStorage.removeItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
    });

    console.log(`🛒 Notification panier abandonné affichée en langue : ${document.documentElement.lang}`);
}

// ============================================================
// LOG
// ============================================================
console.log('✅ ui.js chargé — v2.9.1 (cache getPendingReviewCount)');