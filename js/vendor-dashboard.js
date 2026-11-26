/* ============================================================
   js/vendor-dashboard.js
   Logique du dashboard vendeur - Smartswika
   Version 10.0.0 - Gestion commandes + API Retraits
   ============================================================ */

import {
    doc, getDoc, collection, query, where, getDocs, limit,
    addDoc, setDoc, serverTimestamp, updateDoc, deleteDoc,
    orderBy, startAfter, Timestamp
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { db, storage, auth } from "./firebase.js";
import {
    getCurrentUser,
    logoutUser,
    initAuthListener,
    isAuthReady,
    authReadyPromise,
    resendVerificationEmail
} from "./auth.js";
import {
    CONFIG,
    ROLES,
    VENDOR_STATUS,
    CONTRACT_STATUS,
    LANGUAGES,
    DEFAULT_LANGUAGE,
    PRODUCT_STATUS,
    calculateVendorCommission,
    CATEGORY_GROUPS
} from "./config.js?v=2";
import { showToast, confirmAction } from "./ui-core.js";
import { buildCode128Svg } from "./barcode-code128.js";
import { initLang } from "./utils.js";
import { applyTranslations } from "./events.js";
import {
    signVendorContract,
    computeContractTextHash,
    needsResign,
    verifyContractIntegrity
} from "./vendor-contract.js";
import {
    getContractText,
    buildTermsSnapshot
} from "./vendor-contract-text.js";

/* ============================================================
   ÉTAT MODULE
   ============================================================ */
let currentVendor = null;
let currentWallet = null;
let currentUserUid = null;
let authBound = false;
let cachedWithdrawals = [];
let cachedWalletTransactions = [];
let cachedProducts = [];
let cachedPickupRequests = [];
let cachedOrders = [];
let currentProductIdEditing = null;
let ordersLastDoc = null;
let ordersHasMore = false;
let ordersLoading = false;

let currentContractDoc = null;

let _contractTextHash = null;
let _contractLang = DEFAULT_LANGUAGE;
let _contractVersion = null;
let _contractTermsSnapshot = null;
let _contractScrollReached = false;
let _contractReadOnly = false;
let _contractSignatureSource = "dashboard";

let _productsLoading = false;
let _renderInProgress = false;

/* --- Tableau de bord vendeur moderne (2026-11-25) --- */
let overviewOrders = [];
let overviewStats = null;
let overviewPeriod = 7;
let vendorChartInstances = [];
let warehouseState = {
    loaded: false,
    received: false,
    pending: false,
    approvedNotReceived: false
};

/* ============================================================
   HELPERS FORMATAGE
   ============================================================ */
const madFormatter = new Intl.NumberFormat('fr-MA', {
    style: 'currency', currency: 'MAD', minimumFractionDigits: 2, maximumFractionDigits: 2
});

function formatMAD(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return madFormatter.format(0);
    return madFormatter.format(n);
}

/* i18n du nouveau tableau de bord vendeur (js/vendor-ui.js). */
function vt(key, fallback) {
    return window.__vendorT ? window.__vendorT(key, fallback) : (fallback || key);
}

function buildVendorPromoUrl(product) {
    const vendorId = String((product && product.vendorId) || currentUserUid || "");
    return `https://www.smartswika.ma/produit.html?id=${encodeURIComponent(String(product.id))}` +
        `&utm_source=vendor_${encodeURIComponent(vendorId)}&utm_medium=social&utm_campaign=vendor_promo`;
}

async function copyVendorPromoUrl(url) {
    if (typeof window.__vendorCopyText === "function") {
        return window.__vendorCopyText(url);
    }
    try {
        await navigator.clipboard.writeText(url);
        return true;
    } catch (e) {
        return false;
    }
}
function vfmt(value) {
    return window.__vendorFormatMAD ? window.__vendorFormatMAD(value) : formatMAD(value);
}

function escapeHTML(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeImageUrl(url) {
    if (typeof url !== 'string') return '';
    if (/^https?:\/\//i.test(url) || url.startsWith('/')) return escapeHTML(url);
    return '';
}

function getCurrentLanguage() {
    const htmlLang = (document.documentElement.lang || '').toLowerCase();
    if (LANGUAGES.includes(htmlLang)) return htmlLang;
    try {
        const stored = localStorage.getItem(CONFIG.STORAGE_KEYS.LANG);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (typeof parsed === 'string' && LANGUAGES.includes(parsed)) return parsed;
        }
    } catch (_) { /* ignore */ }
    return DEFAULT_LANGUAGE;
}

/* ============================================================
   I18N
   ============================================================ */
const MINIMAL_FALLBACKS = {
    "vendor.contract.loadFailed": { fr: "Impossible de charger le contrat.", ar: "تعذّر تحميل العقد.", en: "Cannot load contract." },
    "vendor.contract.verifyFail": { fr: "Intégrité non vérifiable : {reason}", ar: "تعذّر التحقق: {reason}", en: "Cannot verify: {reason}" },
    "vendor.contract.verifyRunning": { fr: "Vérification...", ar: "جارٍ التحقق...", en: "Verifying..." },
    "vendor.error.authNotReady": { fr: "Session non initialisée. Redirection vers l'accueil...", ar: "الجلسة غير مهيأة. إعادة التوجيه...", en: "Session not ready. Redirecting..." },
    "vendor.error.notVendor": { fr: "Ce compte n'est pas un compte vendeur. Redirection...", ar: "هذا الحساب ليس حساب بائع.", en: "This account is not a vendor account." },
    "vendor.error.profileMissing": { fr: "Profil vendeur introuvable. Contactez le support.", ar: "ملف البائع غير موجود.", en: "Vendor profile missing." },
    "vendor.error.loading": { fr: "Erreur de chargement des données.", ar: "خطأ في تحميل البيانات.", en: "Failed to load data." }
};

function tr(key, fallback) {
    const lang = getCurrentLanguage();
    const dict = (window.translations && window.translations[lang]) || {};
    const frDict = (window.translations && window.translations[DEFAULT_LANGUAGE]) || {};
    const fb = MINIMAL_FALLBACKS[key];
    return dict[key] || frDict[key] || (fb && (fb[lang] || fb[DEFAULT_LANGUAGE])) || fallback || key;
}

function trParams(key, params, fallback) {
    let value = tr(key, fallback);
    for (const p in params) value = value.replace('{' + p + '}', params[p]);
    return value;
}

function applyLanguageDirection() {
    const lang = getCurrentLanguage();
    if (document.documentElement.lang !== lang) document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

function translateStatus(status) {
    // PR 8.2 : le workflow enrichi (PR 8.1) ajoute preparing / prepared /
    // pickup_requested / picked_up / in_transit. Sans ces entrees, le vendeur
    // voyait le code brut anglais dans son tableau de commandes.
    const map = {
        'pending': tr('orderStatusPending', 'En attente'),
        'confirmed': tr('orderStatusConfirmed', 'Confirmée'),
        'preparing': tr('orderStatusPreparing', 'En préparation'),
        'prepared': tr('orderStatusPrepared', 'Prête à expédier'),
        'pickup_requested': tr('orderStatusPickupRequested', 'En attente de ramassage'),
        'picked_up': tr('orderStatusPickedUp', 'Colis récupéré'),
        'in_transit': tr('orderStatusInTransit', 'En cours de livraison'),
        'shipping': tr('orderStatusShipping', 'En livraison'),
        'delivered': tr('orderStatusDelivered', 'Livrée'),
        'returned': tr('orderStatusReturned', 'Retournée'),
        'cancelled': tr('orderStatusCancelled', 'Annulée')
    };
    return map[status] || status;
}

function formatDate(ts) {
    if (!ts) return '—';
    try {
        if (typeof ts.toDate === 'function') return ts.toDate().toLocaleDateString('fr-FR');
        if (ts instanceof Date) return ts.toLocaleDateString('fr-FR');
    } catch (_) { /* ignore */ }
    return '—';
}

/* ============================================================
   ÉTAT DÉRIVÉ
   ============================================================ */
function getVendorStatus() { return (currentVendor?.vendorInfo?.status) || VENDOR_STATUS.PENDING; }
function getContractStatus() { return (currentVendor?.vendorInfo?.contractStatus) || CONTRACT_STATUS.PENDING; }
function isVendorApproved() {
    return getVendorStatus() === VENDOR_STATUS.APPROVED &&
        getContractStatus() === CONTRACT_STATUS.ACCEPTED &&
        String(currentVendor?.vendorInfo?.contractVersion || '') === CONFIG.VENDOR.CONTRACT_VERSION;
}

/* ============================================================
   ENTREPÔT — VERROU & WORKFLOW GUIDE
   ============================================================ */
function getVendorCommissionRate() {
    const rate = Number(currentVendor?.vendorInfo?.commissionRate);
    if (Number.isFinite(rate) && rate > 0 && rate < 1) return rate;
    return Number(CONFIG.VENDOR.COMMISSION_RATE) || 0.07;
}

function hasWarehouseReceipt() {
    return warehouseState.received === true;
}

function updateVendorBadges() {
    const setBadge = (id, count) => {
        const el = document.getElementById(id);
        if (!el) return;
        const n = Math.max(0, Number(count) || 0);
        if (n > 0) {
            el.textContent = n > 99 ? '99+' : String(n);
            el.hidden = false;
        } else {
            el.hidden = true;
        }
    };

    const pendingProducts = (cachedProducts || []).filter(
        (p) => (p.status || PRODUCT_STATUS.PENDING_ADMIN_APPROVAL) === PRODUCT_STATUS.PENDING_ADMIN_APPROVAL
    ).length;
    const lowStock = (cachedProducts || []).filter(
        (p) => p.status === PRODUCT_STATUS.APPROVED && (Number(p.stock) || 0) <= 5
    ).length;
    setBadge('navProductsBadge', pendingProducts + lowStock);

    setBadge('navStockBadge', (cachedPickupRequests || []).filter((r) => r.status === 'pending').length);
    setBadge('navOrdersBadge', (cachedOrders || []).filter((o) => (o.status || 'pending') === 'pending').length);
    setBadge('navWalletBadge', (cachedWithdrawals || []).filter(
        (w) => normalizePayoutStatus(w.status) === 'pending'
    ).length);

    if (window.__vendorI18n && typeof window.__vendorI18n.refreshNotifications === 'function') {
        window.__vendorI18n.refreshNotifications();
    }
}

function renderWarehouseWorkflow() {
    const host = document.getElementById('vWarehouseWorkflow');
    if (!host) return;
    if (!warehouseState.loaded || warehouseState.received) {
        host.innerHTML = '';
        return;
    }

    const step1Done = warehouseState.pending || warehouseState.approvedNotReceived;
    const step1DoneClass = step1Done ? ' is-done' : ' is-current';
    const step2DoneClass = warehouseState.approvedNotReceived ? ' is-current' : '';
    const showCta = !warehouseState.pending && !warehouseState.approvedNotReceived;

    host.innerHTML = `
        <div class="v-workflow-head">
            <h2 class="v-workflow-title">${escapeHTML(vt('wfTitle', 'Débloquez la publication de vos produits'))}</h2>
            <span class="v-shop-status pending">${escapeHTML(vt('wfWaiting', 'En attente de réception'))}</span>
        </div>
        <p class="v-workflow-intro">${escapeHTML(vt('wfIntro', "Le stock vendeur est stocké à l'entrepôt Smart Swika. Suivez ces 3 étapes pour activer l'ajout de produits."))}</p>
        <div class="v-workflow-steps">
            <div class="v-workflow-step${step1DoneClass}">
                <span class="v-workflow-num">1</span>
                <div><p class="v-workflow-step-title">${escapeHTML(vt('wfStep1Title', 'Créer une demande de ramassage'))}</p><p class="v-workflow-step-desc">${escapeHTML(vt('wfStep1Desc', 'Déclarez vos produits et quantités à remettre à l’entrepôt.'))}</p></div>
            </div>
            <div class="v-workflow-step${step2DoneClass}">
                <span class="v-workflow-num">2</span>
                <div><p class="v-workflow-step-title">${escapeHTML(vt('wfStep2Title', 'Réception et contrôle à l’entrepôt'))}</p><p class="v-workflow-step-desc">${escapeHTML(vt('wfStep2Desc', 'L’équipe Smart Swika vérifie et réceptionne physiquement la marchandise.'))}</p></div>
            </div>
            <div class="v-workflow-step">
                <span class="v-workflow-num">3</span>
                <div><p class="v-workflow-step-title">${escapeHTML(vt('wfStep3Title', 'Déblocage automatique'))}</p><p class="v-workflow-step-desc">${escapeHTML(vt('wfStep3Desc', 'L’ajout de produits est débloqué dès que la réception est confirmée.'))}</p></div>
            </div>
        </div>
        ${showCta ? `<div style="margin-top:.8rem;"><button type="button" class="v-btn v-btn-primary" data-vendor-goto="stock">${escapeHTML(vt('wfCtaPickup', 'Créer ma demande de ramassage'))}</button></div>` : ''}
    `;

    host.querySelectorAll('[data-vendor-goto]').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelector(`.v-nav-link[data-tab="${btn.getAttribute('data-vendor-goto')}"]`)?.click();
        });
    });
}

async function refreshWarehouseState() {
    await loadPickupRequests();
    const requests = cachedPickupRequests || [];
    warehouseState = {
        loaded: true,
        received: requests.some((r) => r.status === 'approved' && r.received_at_warehouse === true),
        pending: requests.some((r) => r.status === 'pending'),
        approvedNotReceived: requests.some((r) => r.status === 'approved' && r.received_at_warehouse !== true)
    };
    renderWarehouseWorkflow();
    updateVendorBadges();
    if (currentVendor) updateSidebarUI(currentVendor);
    return warehouseState;
}

window.__vendorRefreshWarehouse = refreshWarehouseState;
window.__vendorWarehouseReceived = hasWarehouseReceipt;

function getPendingWithdrawalTotal() {
    return cachedWithdrawals.filter(w => w.status === 'pending').reduce((sum, w) => sum + (Number(w.amount) || 0), 0);
}

function getVirtualAvailableBalance() {
    const available = Math.max(0, Number(currentWallet?.availableBalance) || 0);
    return Math.max(0, available - getPendingWithdrawalTotal());
}

function canRequestWithdrawal() {
    if (!isVendorApproved()) return false;
    if (!currentWallet) return false;
    if ((Number(currentWallet.negativeBalance) || 0) < -0.0001) return false;
    return getVirtualAvailableBalance() >= CONFIG.VENDOR.MIN_WITHDRAWAL;
}

function vendorNeedsResign() {
    const vendorInfo = currentVendor?.vendorInfo;
    if (!vendorInfo || !vendorInfo.contractVersion) return false;
    return needsResign(vendorInfo);
}

function getResignGraceDeadline() {
    const vendorInfo = currentVendor?.vendorInfo;
    if (!vendorInfo) return null;
    const graceDays = Number(CONFIG.VENDOR.CONTRACT_RESIGN_GRACE_DAYS);
    if (!Number.isFinite(graceDays) || graceDays <= 0) return null;
    let baseMs = 0;
    try {
        const v = vendorInfo.contractVersionChangedAt;
        if (v && typeof v.toDate === 'function') baseMs = v.toDate().getTime();
        else if (v && typeof v.seconds === 'number') baseMs = v.seconds * 1000;
        else if (v instanceof Date) baseMs = v.getTime();
    } catch (_) { /* ignore */ }
    if (!baseMs) {
        try {
            const v = vendorInfo.contractSignedAt;
            if (v && typeof v.toDate === 'function') baseMs = v.toDate().getTime();
            else if (v && typeof v.seconds === 'number') baseMs = v.seconds * 1000;
            else if (v instanceof Date) baseMs = v.getTime();
        } catch (_) { /* ignore */ }
    }
    if (!baseMs && currentContractDoc?.data) {
        try {
            const v = currentContractDoc.data.acceptedAt;
            if (v && typeof v.toDate === 'function') baseMs = v.toDate().getTime();
            else if (v && typeof v.seconds === 'number') baseMs = v.seconds * 1000;
            else if (v instanceof Date) baseMs = v.getTime();
        } catch (_) { /* ignore */ }
    }
    if (!baseMs) return null;
    return new Date(baseMs + graceDays * 24 * 3600 * 1000);
}

/* ============================================================
   BANNIÈRES
   ============================================================ */
function renderBanners(banners) {
    const container = document.getElementById('vBanners');
    if (!container) return;
    if (!banners || !banners.length) { container.innerHTML = ''; return; }
    container.innerHTML = banners.map(b => {
        const type = ['info', 'warning', 'danger', 'success'].includes(b.type) ? b.type : 'info';
        const action = b.actionId ? `<button type="button" class="v-btn v-btn-secondary" data-banner-action="${escapeHTML(b.actionId)}">${escapeHTML(b.actionLabel || 'OK')}</button>` : '';
        return `<div class="v-banner v-banner--${type}"><span>${escapeHTML(b.text)}</span>${action}</div>`;
    }).join('');
}

function attachBannerActions(handlers) {
    const container = document.getElementById('vBanners');
    if (!container) return;
    container.querySelectorAll('[data-banner-action]').forEach(btn => {
        const id = btn.getAttribute('data-banner-action');
        const handler = handlers[id];
        if (typeof handler === 'function') btn.addEventListener('click', handler);
    });
}

function buildBanners(profile) {
    const banners = [];
    const params = new URLSearchParams(location.search);
    const user = getCurrentUser();
    const emailVerified = (user && user.emailVerified === true);
    const vendorInfo = (profile?.vendorInfo) || {};
    const status = vendorInfo.status || VENDOR_STATUS.PENDING;
    const contractStatus = vendorInfo.contractStatus || CONTRACT_STATUS.PENDING;

    if (params.get('welcome') === '1') banners.push({ type: 'success', text: tr('vendor.banner.welcome', "Bienvenue sur votre espace vendeur ! Votre compte est en cours d'examen.") });
    if (params.get('verifyEmail') === '1' && !emailVerified) banners.push({ type: 'warning', text: tr('vendor.banner.verifyEmail', "Vérifiez votre adresse e-mail : un lien vous a été envoyé. Cliquez sur « Renvoyer » si besoin."), actionId: 'resendVerify', actionLabel: tr('vendor.banner.resend', 'Renvoyer') });
    if (params.get('contractFailed') === '1' && contractStatus !== CONTRACT_STATUS.ACCEPTED) banners.push({ type: 'danger', text: tr('vendor.banner.contractFailed', "La signature de votre contrat a échoué. Cliquez sur « Signer maintenant » pour finaliser."), actionId: 'resignContract', actionLabel: tr('vendor.banner.resign', 'Signer maintenant') });
    
    if (vendorInfo.contractVersion && needsResign(vendorInfo) && contractStatus === CONTRACT_STATUS.ACCEPTED) {
        const currentVer = CONFIG.VENDOR.CONTRACT_VERSION;
        const graceDeadline = getResignGraceDeadline();
        let text = trParams('vendor.banner.resignRequired', { version: currentVer, date: graceDeadline ? graceDeadline.toLocaleDateString('fr-FR') : '—' }, 'Une nouvelle version du contrat ({version}) est disponible.');
        banners.push({ type: 'warning', text, actionId: 'resignContract', actionLabel: tr('vendor.banner.resignNow', 'Signer maintenant') });
    }

    if (params.has('welcome') || params.has('verifyEmail') || params.has('contractFailed')) {
        params.delete('welcome'); params.delete('verifyEmail'); params.delete('contractFailed');
        const newUrl = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
        history.replaceState({}, '', newUrl);
    }

    if (status === VENDOR_STATUS.PENDING) banners.push({ type: 'warning', text: tr('vendor.banner.pending', "Votre compte est en attente d'approbation par l'administration. Certaines fonctionnalités sont limitées.") });
    else if (status === VENDOR_STATUS.REJECTED) banners.push({ type: 'danger', text: tr('vendor.banner.rejected', "Votre inscription a été refusée. Contactez le support pour plus d'informations.") });
    else if (status === VENDOR_STATUS.SUSPENDED) banners.push({ type: 'danger', text: tr('vendor.banner.suspended', "Votre compte est suspendu. Vous ne pouvez plus vendre. Contactez le support.") });

    if (!emailVerified && !params.get('verifyEmail')) banners.push({ type: 'warning', text: tr('vendor.banner.emailNotVerified', "Votre e-mail n'est pas vérifié. Cliquez sur « Renvoyer » pour recevoir un nouveau lien."), actionId: 'resendVerify', actionLabel: tr('vendor.banner.resend', 'Renvoyer') });

    return banners;
}

/* ============================================================
   SIDEBAR
   ============================================================ */
function updateSidebarUI(profile) {
    const shopNameEl = document.getElementById('vShopName');
    const statusEl = document.getElementById('vShopStatus');
    if (!shopNameEl || !statusEl) return;

    const vendorInfo = profile.vendorInfo || {};
    const shopName = vendorInfo.shopName || profile.name || tr('vendor.shop.fallbackName', 'Ma boutique');
    shopNameEl.textContent = shopName;
    shopNameEl.removeAttribute('data-i18n');

    const status = vendorInfo.status || VENDOR_STATUS.PENDING;
    const mapping = {
        [VENDOR_STATUS.APPROVED]:  warehouseState.loaded && !warehouseState.received
            ? { text: vt('statusAwaitingWarehouse', 'En attente entrepôt'), cls: 'pending' }
            : { text: vt('statusActive', 'Actif'), cls: 'approved' },
        [VENDOR_STATUS.PENDING]:   { text: tr('vendor.shop.status.pending',   'En attente'), cls: 'pending' },
        [VENDOR_STATUS.REJECTED]:  { text: tr('vendor.shop.status.rejected',  'Rejeté'),     cls: 'rejected' },
        [VENDOR_STATUS.SUSPENDED]: { text: tr('vendor.shop.status.suspended', 'Suspendu'),   cls: 'suspended' }
    };
    const entry = mapping[status] || mapping[VENDOR_STATUS.PENDING];
    statusEl.textContent = entry.text;
    statusEl.className = `v-shop-status ${entry.cls}`;
    statusEl.removeAttribute('data-i18n');

    const shippingEl = document.getElementById('vShippingMode');
    const stockTab = document.querySelector('.v-nav-link[data-tab="stock"]');
    const shippingMethod = vendorInfo.shippingMethod;
    if (shippingEl) {
        /* Mode unique depuis le 2026-11-19 : entrepot Smart Swika. */
        shippingEl.textContent = shippingMethod === 'fulfillment'
            ? tr('vendor.shipping.fulfillment', 'Mode logistique : Entrepôt Smart Swika')
            : tr('vendor.shipping.unset', 'Mode logistique : à configurer');
        shippingEl.className = `v-shop-status ${shippingMethod === 'fulfillment' ? 'approved' : 'pending'}`;
        shippingEl.style.display = 'block';
        shippingEl.style.margin = '0.65rem auto 0';
        shippingEl.style.maxWidth = 'max-content';
    }
    if (stockTab) stockTab.hidden = shippingMethod !== 'fulfillment';

    updateVendorBadges();
    renderWarehouseWorkflow();
}

/* ============================================================
   CHARGEMENT DES DONNÉES VENDEUR
   ============================================================ */
async function loadVendorData(uid) {
    if (!uid) return { profile: null, wallet: null, reason: 'not-authenticated' };

    let profile = null;
    try {
        const vendorDoc = await getDoc(doc(db, "users", uid));
        profile = vendorDoc.exists() ? vendorDoc.data() : null;
    } catch (e) {
        console.error('[vendor-dashboard] Lecture users/{uid} impossible :', e);
        throw e;
    }

    if (!profile) return { profile: null, wallet: null, reason: 'profile-missing' };
    if (profile.role !== ROLES.VENDOR) return { profile: null, wallet: null, reason: 'not-vendor' };

    const vendorStatus = profile.vendorInfo?.status || VENDOR_STATUS.PENDING;
    const contractStatus = profile.vendorInfo?.contractStatus || CONTRACT_STATUS.PENDING;
    if (vendorStatus !== VENDOR_STATUS.APPROVED ||
        contractStatus !== CONTRACT_STATUS.ACCEPTED ||
        String(profile.vendorInfo?.contractVersion || '') !== CONFIG.VENDOR.CONTRACT_VERSION) {
        return { profile, wallet: null, reason: 'vendor-not-active' };
    }

    let wallet = null;
    try {
        const walletDoc = await getDoc(doc(db, "wallets", uid));
        wallet = walletDoc.exists() ? walletDoc.data() : null;
    } catch (e) {
        console.warn('[vendor-dashboard] Lecture wallets/{uid} impossible :', e);
        wallet = null;
    }
    return { profile, wallet, reason: null };
}

async function loadCurrentContract() {
    if (!currentUserUid) return null;
    const vendorInfo = (currentVendor?.vendorInfo) || {};
    const candidates = [];
    if (vendorInfo.currentContractId) candidates.push(vendorInfo.currentContractId);
    if (vendorInfo.contractVersion) candidates.push(`contract_${currentUserUid}_v${vendorInfo.contractVersion}`);
    candidates.push(`contract_${currentUserUid}`);

    for (const id of candidates) {
        try {
            const snap = await getDoc(doc(db, "contracts", id));
            if (snap.exists()) return { id, data: snap.data() };
        } catch (e) {
            console.warn('[vendor-dashboard] Lecture contrat ' + id + ' :', e);
        }
    }
    return null;
}

/* ============================================================
   INJECTION DES MODALES
   ============================================================ */
function injectModals() {
    if (document.getElementById('vModalsRoot')) return;
    const root = document.createElement('div');
    root.id = 'vModalsRoot';
    root.innerHTML = `
        <div class="modal-overlay" id="vWithdrawModal" style="z-index:2500;">
            <div class="modal" style="max-width:480px;">
                <button class="modal-close" id="closeWithdrawModal">✕</button>
                <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:1rem;">Demander un retrait</h2>
                <p style="text-align:center;font-size:0.85rem;color:var(--text-muted);margin-bottom:1.2rem;">Solde disponible : <strong id="vWithdrawAvailable">0 MAD</strong><br>Minimum : <strong>${CONFIG.VENDOR.MIN_WITHDRAWAL} MAD</strong></p>
                <div class="v-field">
                    <label class="v-label">Prénom *</label>
                    <input type="text" id="vWithdrawFirstName" class="v-input" maxlength="60" placeholder="Prénom (comme sur la CIN)" autocomplete="given-name">
                </div>
                <div class="v-field">
                    <label class="v-label">Nom *</label>
                    <input type="text" id="vWithdrawLastName" class="v-input" maxlength="60" placeholder="Nom (comme sur la CIN)" autocomplete="family-name">
                </div>
                <div class="v-field">
                    <label class="v-label">CIN *</label>
                    <input type="text" id="vWithdrawCin" class="v-input" maxlength="12" placeholder="Ex : AB123456" autocomplete="off">
                    <span class="v-hint">Numéro de la carte d'identité nationale marocaine.</span>
                </div>
                <div class="v-field">
                    <label class="v-label">Téléphone *</label>
                    <input type="tel" id="vWithdrawAccount" class="v-input" placeholder="06XXXXXXXX" autocomplete="tel">
                    <span class="v-hint" id="vWithdrawHint">Numéro de téléphone marocain (06XXXXXXXX ou 07XXXXXXXX).</span>
                </div>
                <div class="v-field">
                    <label class="v-label">Montant à retirer (MAD) *</label>
                    <input type="number" id="vWithdrawAmount" class="v-input" min="${CONFIG.VENDOR.MIN_WITHDRAWAL}" step="1" placeholder="${CONFIG.VENDOR.MIN_WITHDRAWAL}">
                </div>
                <div class="v-field">
                    <label class="v-label">Réseau de retrait *</label>
                    <select id="vWithdrawMethod" class="v-input"><option value="Wafacash">Wafacash</option><option value="CashPlus">CashPlus</option></select>
                    <span class="v-hint">Vous retirerez votre argent dans une agence du réseau choisi.</span>
                </div>
                <div style="background:rgba(231,76,60,0.08);border:1px solid var(--danger);border-radius:var(--radius-sm);padding:0.75rem 0.9rem;margin:0.75rem 0;font-size:0.8rem;line-height:1.45;color:var(--text-muted);">
                    ⚠️ Des frais de retrait seront déduits par l'agence Wafacash/CashPlus au moment du retrait. Renseignez-vous auprès de votre agence pour le montant exact. Le montant reçu en main sera inférieur au montant demandé.
                </div>
                <div id="vWithdrawError" style="color:var(--danger);font-size:0.85rem;min-height:1.2rem;text-align:center;margin:0.5rem 0;"></div>
                <button type="button" id="vWithdrawSubmitBtn" class="v-btn v-btn-primary v-btn-block">Envoyer la demande</button>
            </div>
        </div>

        <div class="modal-overlay" id="vProductModal" style="z-index:2500;">
            <div class="modal" style="max-width:600px; max-height:90vh; overflow-y:auto;">
                <button class="modal-close" id="closeProductModal">✕</button>
                <h2 id="vProductModalTitle" style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:1rem;">Nouveau produit</h2>
                <input type="hidden" id="vProdId" value="">
                <div class="v-field">
                    <label class="v-label" for="vProdPickupRequest">Stock réceptionné à l'entrepôt *</label>
                    <select id="vProdPickupRequest" class="v-input">
                        <option value="">Aucun ramassage approuvé</option>
                    </select>
                    <small style="display:block;font-size:0.72rem;color:var(--text-muted);margin-top:0.25rem;">
                        Obligatoire : le produit doit être physiquement reçu à l'entrepôt Smart Swika.
                        Demandez un ramassage dans l'onglet Stock et attendez l'approbation admin.
                    </small>
                </div>
                <div class="v-field"><label class="v-label">Nom du produit (Français) *</label><input type="text" id="vProdNameFr" class="v-input" placeholder="Ex: Montre connectée"></div>
                <div class="v-field"><label class="v-label">Nom du produit (Arabe)</label><input type="text" id="vProdNameAr" class="v-input" placeholder="ساعة ذكية"></div>
                <div class="v-field"><label class="v-label">Nom du produit (Anglais)</label><input type="text" id="vProdNameEn" class="v-input" placeholder="Smartwatch"></div>
                <div class="v-field"><label class="v-label" for="vProdParentCategory">Catégorie principale *</label><select id="vProdParentCategory" class="v-input"><option value="">Choisir une catégorie</option></select></div>
                <div class="v-field"><label class="v-label" for="vProdCategory">Sous-catégorie *</label><select id="vProdCategory" class="v-input" disabled><option value="">Choisissez d’abord une catégorie</option></select></div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.8rem;">
                    <div class="v-field"><label class="v-label">Prix de vente (MAD) *</label><input type="number" id="vProdPrice" class="v-input" min="1" step="0.5"></div>
                    <div class="v-field"><label class="v-label">Ancien prix (MAD)</label><input type="number" id="vProdOldPrice" class="v-input" min="0" step="0.5"></div>
                </div>
                <div class="v-field"><label class="v-label">Prix Koulchi (MAD) *</label><input type="number" id="vProdKoulchiPrice" class="v-input" min="1" step="0.5"><small style="display:block;font-size:0.7rem;color:#8a8a8a;">Obligatoire, strictement inférieur au prix de vente.</small></div>
                <div class="v-field">
                    <label class="v-label">Mode de livraison</label>
                    <div id="vProdWarehouseInfo" style="padding:0.8rem 0.9rem;border:1px solid var(--border-gold);border-radius:var(--radius-sm);background:rgba(212,175,55,0.08);font-size:0.82rem;line-height:1.55;">
                        <strong>🏬 Entrepôt Smart Swika (obligatoire)</strong>
                        <div id="vProdWarehouseAddress" style="margin-top:0.3rem;color:var(--text-muted);"></div>
                        <div style="margin-top:0.5rem;font-weight:600;">Envoyez votre stock à cet entrepôt (ou demandez un ramassage depuis l'onglet Stock). Smart Swika stocke et prépare les colis ; Livo les livre aux acheteurs.</div>
                    </div>
                </div>
                <div class="v-field"><label class="v-label">Stock total *</label><input type="number" id="vProdStock" class="v-input" min="0" value="1"></div>
                <h3 class="v-card-title">Tailles et couleurs</h3>
                <div class="v-field"><label class="v-label">Tailles (séparées par des virgules)</label><input type="text" id="vProdSizes" class="v-input" placeholder="S, M, L, XL"></div>
                <div class="v-field"><label class="v-label">Couleurs (séparées par des virgules)</label><input type="text" id="vProdColors" class="v-input" placeholder="Noir, Blanc"></div>
                <button type="button" id="vProdGenerateVariants" class="v-btn v-btn-secondary" style="margin-bottom:0.75rem;">Créer les variantes</button>
                <div id="vProdVariantsContainer" style="display:none;overflow-x:auto;margin-bottom:1rem;">
                    <table class="acc-table"><thead><tr><th>Variante</th><th>Prix (MAD)</th><th>Stock</th></tr></thead><tbody id="vProdVariantsBody"></tbody></table>
                </div>
                <label class="v-checkbox" style="margin:0 0 1rem;"><input type="checkbox" id="vProdSizeGuide"><span>Ajouter un guide des tailles</span></label>
                <h3 class="v-card-title">Dimensions pour Livo</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.8rem;">
                    <div class="v-field"><label class="v-label">Poids (g)</label><input type="number" id="vProdWeight" class="v-input" min="0" step="1"></div>
                    <div class="v-field"><label class="v-label">Longueur (cm)</label><input type="number" id="vProdLength" class="v-input" min="0" step="0.1"></div>
                    <div class="v-field"><label class="v-label">Largeur (cm)</label><input type="number" id="vProdWidth" class="v-input" min="0" step="0.1"></div>
                    <div class="v-field"><label class="v-label">Hauteur (cm)</label><input type="number" id="vProdHeight" class="v-input" min="0" step="0.1"></div>
                </div>
                <h3 class="v-card-title">Descriptions</h3>
                <div class="v-field"><label class="v-label">Français</label><textarea id="vProdDescFr" class="v-input" rows="3" placeholder="Décrivez votre produit..."></textarea></div>
                <div class="v-field"><label class="v-label">العربية</label><textarea id="vProdDescAr" class="v-input" rows="3" dir="rtl"></textarea></div>
                <div class="v-field"><label class="v-label">English</label><textarea id="vProdDescEn" class="v-input" rows="3"></textarea></div>
                <h3 class="v-card-title">Points forts (un point par ligne)</h3>
                <div class="v-field"><label class="v-label">Français</label><textarea id="vProdFeaturesFr" class="v-input" rows="3"></textarea></div>
                <div class="v-field"><label class="v-label">العربية</label><textarea id="vProdFeaturesAr" class="v-input" rows="3" dir="rtl"></textarea></div>
                <div class="v-field"><label class="v-label">English</label><textarea id="vProdFeaturesEn" class="v-input" rows="3"></textarea></div>
                <div class="v-field">
                    <label class="v-label">Image principale (max 2 Mo) *</label>
                    <input type="file" id="vProdImageFile" accept="image/jpeg,image/png,image/webp" class="v-input">
                    <div id="vProdImagePreview" style="margin-top:0.5rem;"></div>
                </div>
                <div class="v-field"><label class="v-label">Images supplémentaires (max 2 Mo chacune)</label><input type="file" id="vProdGalleryFiles" accept="image/jpeg,image/png,image/webp" class="v-input" multiple><div id="vProdGalleryPreview" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem;"></div></div>
                <div id="vProdError" style="color:var(--danger);font-size:0.85rem;min-height:1.2rem;text-align:center;margin:0.5rem 0;"></div>
                <button type="button" id="vProdSubmitBtn" class="v-btn v-btn-primary v-btn-block">Envoyer pour validation</button>
            </div>
        </div>

        <div class="modal-overlay" id="vContractModal" style="z-index:2500;">
            <div class="modal" style="max-width:800px;padding:0;display:flex;flex-direction:column;height:90vh;">
                <div style="padding:1.5rem;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
                    <h2 id="vContractTitle" style="font-family:var(--font-secondary);color:var(--gold);margin:0;">Contrat de Partenariat</h2>
                    <button type="button" id="closeContractModal" aria-label="Fermer" style="background:none;border:none;font-size:1.5rem;cursor:pointer;">✕</button>
                </div>
                <div id="vContractText" tabindex="0" style="flex:1;overflow-y:auto;padding:2rem;font-size:0.9rem;line-height:1.7;color:#444;background:#fafafa;"></div>
                <div style="padding:1.5rem;border-top:1px solid #eee;background:#fff;text-align:center;">
                    <p id="vContractHint" style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.75rem;">Faites défiler pour lire l'intégralité du contrat.</p>
                    <div id="vContractMeta" style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.75rem;"></div>
                    <div id="vContractSignZone">
                        <label class="v-checkbox" for="vContractCheckbox"><input type="checkbox" id="vContractCheckbox"><span>J'ai lu et j'accepte le contrat dans son intégralité</span></label>
                        <button type="button" id="vContractAcceptBtn" class="v-btn v-btn-primary v-btn-block" disabled style="opacity:0.5;margin-top:0.75rem;">Signer le contrat</button>
                    </div>
                    <div id="vContractReadZone" style="display:none;gap:0.5rem;flex-wrap:wrap;justify-content:center;">
                        <button type="button" id="vContractPrintBtn" class="v-btn v-btn-secondary">Imprimer</button>
                        <button type="button" id="vContractDownloadBtn" class="v-btn v-btn-secondary">Télécharger</button>
                        <button type="button" id="vContractVerifyBtn" class="v-btn v-btn-secondary">Vérifier l'intégrité</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(root);
}

/* ============================================================
   RETRAIT (API)
   ============================================================ */
function openWithdrawModal() {
    if (!canRequestWithdrawal()) {
        const virtualAvailable = getVirtualAvailableBalance();
        if (!isVendorApproved()) showToast(tr('vendor.wallet.withdrawLockedNotApproved', "Compte non approuvé : retrait verrouillé."));
        else if (getPendingWithdrawalTotal() > 0) showToast("Vous avez déjà une demande de retrait en cours. Attendez son traitement.", 4000);
        else if (virtualAvailable < CONFIG.VENDOR.MIN_WITHDRAWAL) showToast(tr('vendor.wallet.withdrawLockedMin', "Solde insuffisant (minimum : {min}).").replace('{min}', CONFIG.VENDOR.MIN_WITHDRAWAL + ' MAD'));
        return;
    }
    const modal = document.getElementById('vWithdrawModal');
    if (!modal) return;
    document.getElementById('vWithdrawAvailable').textContent = formatMAD(getVirtualAvailableBalance());
    document.getElementById('vWithdrawAmount').value = '';
    // Préremplissage depuis le profil vendeur (l'admin relève déjà ces infos).
    const profileName = String(currentVendor?.name || '').trim();
    const profilePhone = normalizeMoroccanPhone(currentVendor?.phone || '');
    document.getElementById('vWithdrawFirstName').value = String(currentVendor?.firstName || profileName.split(' ')[0] || '').trim();
    document.getElementById('vWithdrawLastName').value = String(currentVendor?.lastName || profileName.split(' ').slice(1).join(' ') || '').trim();
    document.getElementById('vWithdrawCin').value = '';
    document.getElementById('vWithdrawAccount').value = profilePhone;
    document.getElementById('vWithdrawAccount').placeholder = '06XXXXXXXX';
    document.getElementById('vWithdrawError').textContent = '';
    handleWithdrawMethodChange();
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('vWithdrawAmount')?.focus(), 100);
}

function closeWithdrawModal() {
    const modal = document.getElementById('vWithdrawModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
}

function normalizeMoroccanPhone(value) {
    const raw = String(value || '').replace(/[\s.-]/g, '');
    if (/^\+212[67]\d{8}$/.test(raw)) return '0' + raw.slice(4);
    return raw;
}

function isValidMoroccanCin(value) {
    // CIN marocaine : 1 à 3 lettres suivies de 4 à 8 chiffres (même règle que functions/index.js).
    return /^[A-Z]{1,3}\d{4,8}$/.test(String(value || '').trim().toUpperCase());
}

function handleWithdrawMethodChange() {
    // Le numéro de téléphone de réception est le même quel que soit le reseau
    // (Wafacash ou CashPlus) : seul le libelle d'aide change.
    const method = document.getElementById('vWithdrawMethod')?.value;
    const hint = document.getElementById('vWithdrawHint');
    if (!hint) return;
    hint.textContent = method === 'CashPlus'
        ? 'Numéro de téléphone marocain (06 ou 07). CashPlus vous contactera pour le retrait.'
        : 'Numéro de téléphone marocain (06 ou 07). Présentez-vous en agence Wafacash avec votre CIN.';
}

async function submitWithdrawal() {
    const firstNameEl = document.getElementById('vWithdrawFirstName');
    const lastNameEl = document.getElementById('vWithdrawLastName');
    const cinEl = document.getElementById('vWithdrawCin');
    const amountEl = document.getElementById('vWithdrawAmount');
    const methodEl = document.getElementById('vWithdrawMethod');
    const accountEl = document.getElementById('vWithdrawAccount');
    const errEl = document.getElementById('vWithdrawError');
    const btn = document.getElementById('vWithdrawSubmitBtn');

    const firstName = (firstNameEl.value || '').trim();
    const lastName = (lastNameEl.value || '').trim();
    const cin = (cinEl.value || '').trim().toUpperCase();
    const amount = parseFloat(amountEl.value);
    const method = methodEl.value;
    const phone = normalizeMoroccanPhone(accountEl.value);
    const virtualAvailable = getVirtualAvailableBalance();

    errEl.textContent = '';

    if (firstName.length < 2) { errEl.textContent = 'Prénom invalide (2 caractères minimum).'; return; }
    if (lastName.length < 2) { errEl.textContent = 'Nom invalide (2 caractères minimum).'; return; }
    if (!isValidMoroccanCin(cin)) { errEl.textContent = 'CIN invalide (ex : AB123456).'; return; }
    if (!/^(?:\+212|0)[67]\d{8}$/.test(phone)) { errEl.textContent = 'Numéro de téléphone invalide (06XXXXXXXX ou 07XXXXXXXX).'; return; }
    if (getPendingWithdrawalTotal() > 0) { errEl.textContent = 'Vous avez déjà une demande en cours de traitement.'; return; }
    if (!Number.isFinite(amount) || amount < CONFIG.VENDOR.MIN_WITHDRAWAL) { errEl.textContent = `Minimum : ${CONFIG.VENDOR.MIN_WITHDRAWAL} MAD.`; return; }
    if (amount > virtualAvailable) { errEl.textContent = `Solde insuffisant (${formatMAD(virtualAvailable)} disponibles).`; return; }
    if (!['Wafacash', 'CashPlus'].includes(method)) { errEl.textContent = 'Réseau de retrait invalide.'; return; }

    btn.disabled = true;
    btn.textContent = '...';

    try {
        const user = auth.currentUser;
        if (!user) throw new Error("Session expirée.");
        const idToken = await user.getIdToken(true);

        const response = await fetch('/api/requestWithdrawal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({
                amount,
                method,
                account: phone,
                phone,
                firstName,
                lastName,
                cin,
                vendorName: currentVendor.vendorInfo?.shopName || currentVendor.name || 'Vendeur'
            })
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) {
            throw new Error(result.message || "Erreur lors de la demande de retrait.");
        }

        showToast('Demande de retrait envoyée ! Vous serez notifié dès que le transfert sera envoyé à l\'agence.');
        closeWithdrawModal();
        btn.disabled = false;
        btn.textContent = 'Envoyer la demande';
        await loadWithdrawals();
        await renderWallet(document.getElementById('vTabContent'));
    } catch (e) {
        console.error('[vendor-dashboard] Erreur retrait :', e);
        errEl.textContent = 'Erreur : ' + (e.message || 'inconnue');
        btn.disabled = false;
        btn.textContent = 'Envoyer la demande';
    }
}

async function loadWithdrawals() {
    try {
        const q = query(collection(db, "payout_requests"), where("vendorId", "==", currentUserUid));
        const snap = await getDocs(q);
        cachedWithdrawals = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
            const ta = a.requestedAt?.toDate?.()?.getTime?.() || 0;
            const tb = b.requestedAt?.toDate?.()?.getTime?.() || 0;
            return tb - ta;
        });
    } catch (e) {
        console.warn('[vendor-dashboard] Lecture retraits échouée :', e);
        cachedWithdrawals = [];
    }
}

async function loadWalletTransactions() {
    if (!currentUserUid) {
        cachedWalletTransactions = [];
        return;
    }
    try {
        // Requête volontairement simple : tri local pour éviter de dépendre
        // d'un index composite vendorId + createdAt.
        const q = query(
            collection(db, "wallet_transactions"),
            where("vendorId", "==", currentUserUid),
            limit(100)
        );
        const snap = await getDocs(q);
        cachedWalletTransactions = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
            const ta = a.createdAt?.toDate?.()?.getTime?.() || 0;
            const tb = b.createdAt?.toDate?.()?.getTime?.() || 0;
            return tb - ta;
        });
    } catch (e) {
        console.warn('[vendor-dashboard] Lecture historique portefeuille échouée :', e);
        cachedWalletTransactions = [];
    }
}

function getWalletTransactionLabel(tx) {
    const labels = {
        sale: 'Crédit de vente',
        return_fee: 'Frais de retour',
        payout: 'Retrait payé',
        adjustment: 'Ajustement',
        refund: 'Remboursement'
    };
    return labels[tx.type] || tx.description || 'Mouvement portefeuille';
}

/* ============================================================
   PRODUITS (CRUD et suppression)
   ============================================================ */
function generateSlug(str) {
    const base = String(str || '').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    if (base && base.length >= 2) return base;
    return 'product-' + Date.now().toString(36);
}

function initializeVendorProductCategories(selectedCategory = '') {
    const parent = document.getElementById('vProdParentCategory');
    const child = document.getElementById('vProdCategory');
    if (!parent || !child) return;
    if (!parent.dataset.initialized) {
        parent.innerHTML = '<option value="">Choisir une catégorie</option>' + CATEGORY_GROUPS.map(group =>
            `<option value="${escapeHTML(group.id)}">${group.emoji} ${escapeHTML(tr(group.label, group.id))}</option>`
        ).join('');
        parent.addEventListener('change', () => {
            const group = CATEGORY_GROUPS.find(item => item.id === parent.value);
            child.innerHTML = group
                ? '<option value="">Choisir une sous-catégorie</option>' + group.children.map(item =>
                    `<option value="${escapeHTML(item.id)}">${item.emoji} ${escapeHTML(tr(item.label, item.id))}</option>`
                ).join('')
                : '<option value="">Choisissez d’abord une catégorie</option>';
            child.disabled = !group;
        });
        parent.dataset.initialized = 'true';
    }
    const group = CATEGORY_GROUPS.find(item => item.children.some(childItem => childItem.id === selectedCategory));
    parent.value = group?.id || '';
    parent.dispatchEvent(new Event('change'));
    child.value = selectedCategory || '';
}

function productCsvValues(id) {
    return [...new Set(String(document.getElementById(id)?.value || '').split(',').map(value => value.trim()).filter(Boolean))];
}

function renderVendorVariantRows(existingVariants = []) {
    const container = document.getElementById('vProdVariantsContainer');
    const tbody = document.getElementById('vProdVariantsBody');
    const sizes = productCsvValues('vProdSizes');
    const colors = productCsvValues('vProdColors');
    if (!sizes.length && !colors.length && !existingVariants.length) {
        container.style.display = 'none';
        tbody.innerHTML = '';
        return true;
    }
    const sizeValues = sizes.length ? sizes : [''];
    const colorValues = colors.length ? colors : [''];
    let combinations = existingVariants.length ? existingVariants.map(variant => ({
        size: String(variant.size || ''), color: String(variant.color || ''),
        price: Number(variant.price), stock: Number(variant.stock)
    })) : sizeValues.flatMap(size => colorValues.map(color => ({ size, color })));
    if (combinations.length > 100) return false;
    const totalStock = Math.max(0, parseInt(document.getElementById('vProdStock').value, 10) || 0);
    const basePrice = Math.max(0, parseFloat(document.getElementById('vProdPrice').value) || 0);
    const allocatedBase = Math.floor(totalStock / combinations.length);
    let remainder = totalStock % combinations.length;
    tbody.innerHTML = combinations.map(variant => {
        const label = [variant.size, variant.color].filter(Boolean).join(' · ') || 'Variante';
        const fallbackStock = allocatedBase + (remainder-- > 0 ? 1 : 0);
        const price = Number.isFinite(variant.price) ? variant.price : basePrice;
        const stock = Number.isFinite(variant.stock) ? variant.stock : fallbackStock;
        return `<tr data-size="${escapeHTML(variant.size)}" data-color="${escapeHTML(variant.color)}"><td>${escapeHTML(label)}</td><td><input type="number" class="v-variant-price v-input" min="0" step="0.5" value="${price}"></td><td><input type="number" class="v-variant-stock v-input" min="0" step="1" value="${stock}"></td></tr>`;
    }).join('');
    container.style.display = 'block';
    return true;
}

function linesFromProductField(id) {
    return String(document.getElementById(id)?.value || '').split('\n').map(value => value.trim()).filter(Boolean);
}

function getProductDeliveryMode() {
    /* Mode unique : tout le stock passe par l entrepot Smart Swika. */
    return 'smartswika_warehouse';
}

function updateWarehouseInfoVisibility() {
    const info = document.getElementById('vProdWarehouseInfo');
    if (!info) return;
    const isWarehouse = getProductDeliveryMode() === 'smartswika_warehouse';
    info.style.display = isWarehouse ? 'block' : 'none';
    if (!isWarehouse) return;
    const warehouse = CONFIG.SMART_SWIKA_WAREHOUSE || {};
    const parts = [warehouse.name, warehouse.address, warehouse.city, warehouse.phone ? 'Tél : ' + warehouse.phone : '']
        .map(part => String(part || '').trim())
        .filter(Boolean);
    const addressEl = document.getElementById('vProdWarehouseAddress');
    if (addressEl) addressEl.textContent = parts.join(' · ');
}

async function loadPickupRequests() {
    try {
        const snap = await getDocs(query(
            collection(db, 'vendor_pickup_requests'),
            where('vendorId', '==', currentUserUid),
            limit(50)
        ));
        cachedPickupRequests = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => String(b.createdAt?.seconds || 0).localeCompare(String(a.createdAt?.seconds || 0)));
    } catch (e) {
        console.warn('[vendor-dashboard] demandes de ramassage :', e);
        cachedPickupRequests = [];
    }
    return cachedPickupRequests;
}

async function openProductModal(product = null) {
    const modal = document.getElementById('vProductModal');
    if (!modal) return;

    /* Verrou : pas de produit sans marchandise RECUE a l'entrepot. */
    if (!product) {
        await loadPickupRequests();
        const approved = cachedPickupRequests.filter(r => r.status === 'approved' && r.received_at_warehouse === true);
        if (!approved.length) {
            showToast('Le formulaire produit sera débloqué dès que Smart Swika confirme la réception de vos marchandises à l’entrepôt.', 7000);
            return;
        }
    }

    currentProductIdEditing = product ? product.id : null;

    const titleEl = document.getElementById('vProductModalTitle');
    const submitBtn = document.getElementById('vProdSubmitBtn');
    if (titleEl) titleEl.textContent = product ? 'Éditer le produit' : 'Nouveau produit';
    if (submitBtn) submitBtn.textContent = product ? 'Mettre à jour' : 'Envoyer pour validation';

    document.getElementById('vProdId').value = product ? product.id : '';
    const pickupSel = document.getElementById('vProdPickupRequest');
    if (pickupSel) {
        const approved = cachedPickupRequests.filter(r => r.status === 'approved' && r.received_at_warehouse === true);
        const used = new Set();
        (cachedProducts || []).forEach(p => {
            if (!p || !p.pickupRequestId) return;
            const indices = Array.isArray(p.pickupItemIndices)
                ? p.pickupItemIndices
                : (p.pickupItemIndex != null ? [p.pickupItemIndex] : []);
            indices.forEach(i => used.add(`${p.pickupRequestId}|${Number(i)}`));
        });
        const groups = new Map();
        approved.forEach(r => {
            (Array.isArray(r.items) ? r.items : []).forEach((item, index) => {
                const received = Number(item.receivedQuantity) || 0;
                if (received <= 0 || used.has(`${r.id}|${index}`)) return;
                const nameKey = String(item.name || '').trim().toLowerCase();
                if (!nameKey) return;
                const key = `${r.id}|${nameKey}`;
                if (!groups.has(key)) groups.set(key, { requestId: r.id, name: item.name, items: [] });
                groups.get(key).items.push({ ...item, index, received });
            });
        });
        const options = [...groups.entries()].map(([key, group]) => {
            const total = group.items.reduce((s, i) => s + i.received, 0);
            const variantCount = group.items.length;
            return `<option value="${escapeHTML(key)}">${escapeHTML(group.name)} — ${variantCount} variante(s) — ${total} reçu(s)</option>`;
        });
        pickupSel.innerHTML = options.length ? options.join('') : '<option value="">Aucun ramassage approuvé disponible</option>';
        if (product?.pickupRequestId) {
            pickupSel.innerHTML = `<option value="${escapeHTML(product.pickupRequestId)}|0">${escapeHTML(product.nameFr || 'Produit')} — ${escapeHTML(product.sku || '')}</option>`;
        }
        pickupSel.disabled = !!product;
        pickupSel.onchange = () => {
            const [reqId, groupKey] = String(pickupSel.value || '').split('|');
            const req = cachedPickupRequests.find(r => r.id === reqId);
            const lines = (req && Array.isArray(req.items) ? req.items : [])
                .map((item, index) => ({ ...item, index }))
                .filter(item => String(item.name || '').trim().toLowerCase() === groupKey
                    && (Number(item.receivedQuantity) || 0) > 0);
            if (!lines.length) return;
            const nameEl = document.getElementById('vProdNameFr');
            const stockEl = document.getElementById('vProdStock');
            if (nameEl && !nameEl.value.trim()) nameEl.value = lines[0].name || '';
            if (stockEl) stockEl.value = String(lines.reduce((s, i) => s + (Number(i.receivedQuantity) || 0), 0));
        };
    }
    document.getElementById('vProdNameFr').value = product ? (product.nameFr || '') : '';
    document.getElementById('vProdNameAr').value = product ? (product.nameAr || '') : '';
    document.getElementById('vProdNameEn').value = product ? (product.nameEn || '') : '';
    initializeVendorProductCategories(product?.category || '');
    document.getElementById('vProdPrice').value = product ? (product.price || '') : '';
    document.getElementById('vProdOldPrice').value = product ? (product.oldPrice || '') : '';
    document.getElementById('vProdKoulchiPrice').value = product ? (product.koulchiPrice || '') : '';
    document.getElementById('vProdStock').value = product ? (product.stock ?? '1') : '1';
    updateWarehouseInfoVisibility();
    document.getElementById('vProdDescFr').value = product ? (product.descFr || '') : '';
    document.getElementById('vProdDescAr').value = product ? (product.descAr || '') : '';
    document.getElementById('vProdDescEn').value = product ? (product.descEn || '') : '';
    document.getElementById('vProdFeaturesFr').value = product ? (product.featuresFr || []).join('\n') : '';
    document.getElementById('vProdFeaturesAr').value = product ? (product.featuresAr || []).join('\n') : '';
    document.getElementById('vProdFeaturesEn').value = product ? (product.featuresEn || []).join('\n') : '';
    document.getElementById('vProdSizes').value = product ? (product.sizes || [...new Set((product.variants || []).map(item => item.size).filter(Boolean))]).join(', ') : '';
    document.getElementById('vProdColors').value = product ? (product.colors || [...new Set((product.variants || []).map(item => item.color).filter(Boolean))]).join(', ') : '';
    document.getElementById('vProdSizeGuide').checked = !!product?.hasSizeGuide;
    document.getElementById('vProdWeight').value = product?.dimensions?.weight || '';
    document.getElementById('vProdLength').value = product?.dimensions?.length || '';
    document.getElementById('vProdWidth').value = product?.dimensions?.width || '';
    document.getElementById('vProdHeight').value = product?.dimensions?.height || '';
    document.getElementById('vProdImageFile').value = '';
    document.getElementById('vProdGalleryFiles').value = '';
    document.getElementById('vProdGalleryPreview').innerHTML = '';
    (product?.gallery || []).forEach(url => {
        const img = document.createElement('img');
        img.src = safeImageUrl(url);
        img.alt = '';
        img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:8px;';
        document.getElementById('vProdGalleryPreview').appendChild(img);
    });
    renderVendorVariantRows(product?.variants || []);

    const preview = document.getElementById('vProdImagePreview');
    if (preview) {
        if (product && product.img) {
            preview.innerHTML = `<img src="${safeImageUrl(product.img)}" alt="" style="width:80px;height:80px;object-fit:cover;border-radius:8px;">`;
        } else {
            preview.innerHTML = '';
        }
    }

    document.getElementById('vProdError').textContent = '';
    submitBtn.disabled = false;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('vProdNameFr')?.focus(), 100);
}

function closeProductModal() {
    const modal = document.getElementById('vProductModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
    currentProductIdEditing = null;
}

async function submitProduct() {
    const nameFr = (document.getElementById('vProdNameFr').value || '').trim();
    const nameAr = (document.getElementById('vProdNameAr').value || '').trim();
    const nameEn = (document.getElementById('vProdNameEn').value || '').trim();
    const price = parseFloat(document.getElementById('vProdPrice').value);
    const oldPrice = Math.max(0, parseFloat(document.getElementById('vProdOldPrice').value) || 0);
    const koulchiPrice = parseFloat(document.getElementById('vProdKoulchiPrice').value);
    let stock = parseInt(document.getElementById('vProdStock').value, 10);
    const descFr = (document.getElementById('vProdDescFr').value || '').trim();
    const descAr = (document.getElementById('vProdDescAr').value || '').trim();
    const descEn = (document.getElementById('vProdDescEn').value || '').trim();
    const parentCategory = document.getElementById('vProdParentCategory').value;
    const category = document.getElementById('vProdCategory').value;
    const file = document.getElementById('vProdImageFile').files[0];
    const galleryFiles = Array.from(document.getElementById('vProdGalleryFiles').files || []);
    const errEl = document.getElementById('vProdError');
    const btn = document.getElementById('vProdSubmitBtn');

    errEl.textContent = '';

    if (!nameFr || nameFr.length < 2) { errEl.textContent = 'Nom (FR) requis (min 2 caractères).'; return; }
    if (!CATEGORY_GROUPS.some(group => group.id === parentCategory && group.children.some(child => child.id === category))) { errEl.textContent = 'Choisissez une catégorie et une sous-catégorie valides.'; return; }
    if (!Number.isFinite(price) || price <= 0) { errEl.textContent = 'Prix invalide.'; return; }
    if (!Number.isFinite(koulchiPrice) || koulchiPrice <= 0 || koulchiPrice >= price) { errEl.textContent = 'Prix Koulchi obligatoire, strictement inférieur au prix de vente.'; return; }
    if (!Number.isFinite(stock) || stock < 0) { errEl.textContent = 'Stock invalide.'; return; }
    if (!currentProductIdEditing && !file) { errEl.textContent = 'Image requise.'; return; }
    if (file && file.size > 2 * 1024 * 1024) { errEl.textContent = 'Image trop lourde (max 2 Mo).'; return; }
    if ([file, ...galleryFiles].filter(Boolean).some(image => image.size > 2 * 1024 * 1024)) { errEl.textContent = 'Chaque image doit faire au maximum 2 Mo.'; return; }
    if ([file, ...galleryFiles].filter(Boolean).some(image => !['image/jpeg', 'image/png', 'image/webp'].includes(image.type))) { errEl.textContent = 'Utilisez des images JPG, PNG ou WebP.'; return; }
    if (galleryFiles.length > 12) { errEl.textContent = 'Ajoutez au maximum 12 images secondaires à la fois.'; return; }
    const dimensionValues = ['weight', 'length', 'width', 'height'].map(key => parseFloat(document.getElementById(`vProd${key[0].toUpperCase()}${key.slice(1)}`).value) || 0);
    if (dimensionValues.some(value => !Number.isFinite(value) || value < 0 || value > 100000)) { errEl.textContent = 'Vérifiez les dimensions et le poids.'; return; }
    const sizes = productCsvValues('vProdSizes');
    const colors = productCsvValues('vProdColors');
    if (!document.querySelector('#vProdVariantsBody tr') && (sizes.length || colors.length)) {
        if (!renderVendorVariantRows()) { errEl.textContent = 'Réduisez le nombre de combinaisons de tailles et de couleurs.'; return; }
        errEl.textContent = 'Variantes créées. Vérifiez le stock et les prix de chaque variante, puis renvoyez le produit.';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Upload...';

    let newImagePath = null;
    let newImageUrl = null;
    let oldImagePath = null;
    const uploadedPaths = [];
    let productSaved = false;

    try {
        if (currentProductIdEditing) {
            const snap = await getDoc(doc(db, "products", currentProductIdEditing));
            if (snap.exists()) {
                const oldData = snap.data();
                newImageUrl = oldData.img || null;
                if (oldData.img && /firebasestorage\.googleapis\.com/.test(oldData.img)) {
                    const m = oldData.img.match(/\/o\/([^?]+)/);
                    if (m && m[1]) oldImagePath = decodeURIComponent(m[1]);
                }
            }
        }

        if (file) {
            const ts = Date.now();
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            newImagePath = `vendors/${currentUserUid}/products/${ts}_${safeName}`;
            uploadedPaths.push(newImagePath);
            const storageRef = ref(storage, newImagePath);
            // Metadata explicite : certains navigateurs mobiles laissent File.type vide
            // et le SDK enverrait application/octet-stream, refuse par storage.rules.
            await uploadBytes(storageRef, file, { contentType: file.type || 'image/jpeg' });
            newImageUrl = await getDownloadURL(storageRef);
        }

        let gallery = [];
        if (currentProductIdEditing) {
            const existing = await getDoc(doc(db, 'products', currentProductIdEditing));
            if (existing.exists()) gallery = existing.data().gallery || [];
        }
        for (const image of galleryFiles) {
            const ts = Date.now() + uploadedPaths.length;
            const safeName = image.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const path = `vendors/${currentUserUid}/products/gallery/${ts}_${safeName}`;
            uploadedPaths.push(path);
            const galleryRef = ref(storage, path);
            await uploadBytes(galleryRef, image, { contentType: image.type || 'image/jpeg' });
            gallery.push(await getDownloadURL(galleryRef));
        }

        const variants = [];
        const variantRows = Array.from(document.querySelectorAll('#vProdVariantsBody tr'));
        for (const row of variantRows) {
            const variantPrice = parseFloat(row.querySelector('.v-variant-price').value);
            const variantStock = parseInt(row.querySelector('.v-variant-stock').value, 10);
            if (!Number.isFinite(variantPrice) || variantPrice < 0 || !Number.isInteger(variantStock) || variantStock < 0) {
                throw new Error('Vérifiez le prix et le stock de chaque variante.');
            }
            variants.push({ size: row.dataset.size || '', color: row.dataset.color || '', price: variantPrice, stock: variantStock });
        }
        if (variants.length) stock = variants.reduce((total, item) => total + item.stock, 0);

        const dimensions = Object.fromEntries(['weight', 'length', 'width', 'height'].map(key => {
            const value = parseFloat(document.getElementById(`vProd${key[0].toUpperCase()}${key.slice(1)}`).value) || 0;
            return [key, Math.max(0, value)];
        }));
        const featuresFr = linesFromProductField('vProdFeaturesFr');
        const featuresAr = linesFromProductField('vProdFeaturesAr');
        const featuresEn = linesFromProductField('vProdFeaturesEn');
        const deliveryMode = getProductDeliveryMode();
        const pickupSel = document.getElementById('vProdPickupRequest');
        const pickupValue = pickupSel ? pickupSel.value : '';
        const [pickupRequestId, pickupGroupKey] = pickupValue.split('|');
        const pickupReq = cachedPickupRequests.find(r => r.id === pickupRequestId);
        const pickupLines = !currentProductIdEditing
            ? (pickupReq && Array.isArray(pickupReq.items) ? pickupReq.items : [])
                .map((item, index) => ({ ...item, index }))
                .filter(item => String(item.name || '').trim().toLowerCase() === pickupGroupKey
                    && (Number(item.receivedQuantity) || 0) > 0)
            : [];
        const pickupItemIndex = pickupLines.length ? pickupLines[0].index : 0;
        const pickupSkuValue = pickupLines.length ? (pickupLines[0].sku || '') : '';
        if (!currentProductIdEditing && (!pickupRequestId || !pickupLines.length || !pickupSkuValue)) {
            errEl.textContent = 'Sélectionnez un ramassage approuvé : le stock doit être reçu à l’entrepôt avant de créer le produit.';
            return;
        }

        btn.textContent = 'Enregistrement...';
        const vendorName = (currentVendor?.vendorInfo?.shopName || currentVendor?.name || 'Vendeur').slice(0, 60);

        if (currentProductIdEditing) {
            const snap = await getDoc(doc(db, "products", currentProductIdEditing));
            const oldData = snap.exists() ? snap.data() : {};
            const isStockOnly = oldData.nameFr === nameFr && oldData.nameAr === (nameAr || nameFr) && oldData.nameEn === (nameEn || nameFr) &&
                Number(oldData.price) === price && Number(oldData.oldPrice || 0) === oldPrice && Number(oldData.koulchiPrice || 0) === koulchiPrice && oldData.category === category &&
                oldData.descFr === descFr && oldData.descAr === descAr && oldData.descEn === descEn &&
                JSON.stringify(oldData.featuresFr || []) === JSON.stringify(featuresFr) &&
                JSON.stringify(oldData.featuresAr || []) === JSON.stringify(featuresAr) &&
                JSON.stringify(oldData.featuresEn || []) === JSON.stringify(featuresEn) &&
                JSON.stringify(oldData.variants || []) === JSON.stringify(variants) &&
                JSON.stringify(oldData.sizes || []) === JSON.stringify(sizes) &&
                JSON.stringify(oldData.colors || []) === JSON.stringify(colors) &&
                JSON.stringify(oldData.dimensions || {}) === JSON.stringify(dimensions) &&
                oldData.delivery_mode === 'smartswika_warehouse' &&
                !!oldData.hasSizeGuide === document.getElementById('vProdSizeGuide').checked &&
                (!file || newImageUrl === oldData.img) && galleryFiles.length === 0;

            if (isStockOnly) {
                await updateDoc(doc(db, "products", currentProductIdEditing), { stock, updatedAt: serverTimestamp() });
                productSaved = true;
                showToast('Stock mis à jour.');
            } else {
                await updateDoc(doc(db, "products", currentProductIdEditing), {
                    nameFr, nameAr: nameAr || nameFr, nameEn: nameEn || nameFr,
                    category, price, basePrice: price, oldPrice, koulchiPrice, descFr, descAr, descEn,
                    featuresFr, featuresAr, featuresEn, dimensions, variants, sizes, colors,
                    delivery_mode: deliveryMode,
                    pickupRequestId: oldData.pickupRequestId || pickupRequestId,
                    pickupItemIndex: oldData.pickupItemIndex ?? pickupItemIndex,
                    warehouse_received: true,
                    hasSizeGuide: document.getElementById('vProdSizeGuide').checked,
                    img: newImageUrl || oldData.img || '', gallery, stock,
                    vendorName, status: PRODUCT_STATUS.PENDING_ADMIN_APPROVAL, updatedAt: serverTimestamp()
                });
                productSaved = true;
                showToast('Produit mis à jour et renvoyé pour validation.');
            }
        } else {
            const ts = Date.now();
            const slug = generateSlug(nameFr) + '-' + ts.toString(36).slice(-4);
            const lineVariants = pickupLines.map(line => {
                const match = (Array.isArray(variants) ? variants : [])
                    .find(v => String(v.size || '') === String(line.size || '')
                        && String(v.color || '') === String(line.color || ''));
                return {
                    size: line.size || '',
                    color: line.color || '',
                    price: match ? Number(match.price) : price,
                    stock: Number(line.receivedQuantity) || 0,
                    sku: line.sku
                };
            });
            const hasVariants = pickupLines.length > 1 || pickupLines.some(l => l.size || l.color);
            const finalVariants = hasVariants ? lineVariants : [];
            const finalStock = pickupLines.reduce((s, l) => s + (Number(l.receivedQuantity) || 0), 0);
            const productData = {
                nameFr, nameAr: nameAr || nameFr, nameEn: nameEn || nameFr, slug,
                sku: pickupSkuValue, category, basePrice: price, price,
                oldPrice, koulchiPrice, purchasePrice: 0, stock: finalStock,
                delivery_mode: deliveryMode,
                pickupRequestId,
                pickupItemIndex,
                pickupItemIndices: pickupLines.map(l => l.index),
                pickupLineSkus: pickupLines.map(l => l.sku),
                warehouse_received: true,
                isNew: false, hasSizeGuide: document.getElementById('vProdSizeGuide').checked, dimensions,
                variants: finalVariants, sizes, colors, descFr, descAr, descEn, featuresFr, featuresAr, featuresEn,
                img: newImageUrl, gallery, vendorId: currentUserUid, vendorName,
                status: PRODUCT_STATUS.PENDING_ADMIN_APPROVAL, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
            };
            /* ID deterministe : un groupe de lignes = un seul produit. */
            await setDoc(doc(db, "products", `pickup_${pickupRequestId}_${pickupItemIndex}`), productData);
            productSaved = true;
            showToast('Produit envoyé pour validation admin.');
        }

        if (file && oldImagePath && oldImagePath.startsWith(`vendors/${currentUserUid}/`)) {
            try { await deleteObject(ref(storage, oldImagePath)); } catch (_) { /* ignore */ }
        }

        closeProductModal();
        await loadVendorProducts();
        await renderProducts(document.getElementById('vTabContent'));

    } catch (e) {
        console.error('[vendor-dashboard] Erreur création/édition produit :', e);
        if (productSaved) {
            closeProductModal();
            showToast('Produit enregistré. Actualisez la page si la liste ne se met pas à jour.');
        } else {
            errEl.textContent = 'Erreur : ' + (e.message || 'inconnue');
            for (const path of uploadedPaths) { try { await deleteObject(ref(storage, path)); } catch (_) { /* ignore */ } }
            btn.disabled = false;
            btn.textContent = currentProductIdEditing ? 'Mettre à jour' : 'Envoyer pour validation';
        }
    }
}

async function loadVendorProducts() {
    if (_productsLoading) return;
    _productsLoading = true;
    try {
        const q = query(collection(db, "products"), where("vendorId", "==", currentUserUid));
        const snap = await getDocs(q);
        cachedProducts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.warn('[vendor-dashboard] Lecture products échouée :', e);
        cachedProducts = [];
    } finally {
        _productsLoading = false;
    }
}

async function deleteVendorProduct(productId) {
    const ok = await confirmAction('Supprimer ce produit définitivement ?', { title: 'Supprimer', confirmText: 'Supprimer', cancelText: 'Annuler', variant: 'danger' });
    if (!ok) return;
    try {
        const docRef = doc(db, "products", productId);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
            const data = snap.data();
            if (data.img && /firebasestorage\.googleapis\.com/.test(data.img)) {
                try {
                    const m = data.img.match(/\/o\/([^?]+)/);
                    if (m && m[1]) {
                        const path = decodeURIComponent(m[1]);
                        if (path.startsWith(`vendors/${currentUserUid}/`)) {
                            await deleteObject(ref(storage, path));
                        }
                    }
                } catch (_) { /* ignore */ }
            }
        }
        await deleteDoc(docRef);
        showToast('Produit supprimé');
        await loadVendorProducts();
        await renderProducts(document.getElementById('vTabContent'));
    } catch (e) {
        console.error('[vendor-dashboard] Erreur suppression produit :', e);
        showToast(e.message || 'Erreur');
    }
}

/* ============================================================
   MODALE CONTRAT
   ============================================================ */
async function openContractModal(modeSignature = true) {
    const modal = document.getElementById('vContractModal');
    if (!modal) return;
    _contractReadOnly = !modeSignature;
    _contractLang = getCurrentLanguage();

    if (modeSignature) {
        _contractVersion = CONFIG.VENDOR.CONTRACT_VERSION;
        try {
            _contractTermsSnapshot = buildTermsSnapshot();
        } catch (e) {
            console.error('[vendor-dashboard] buildTermsSnapshot impossible :', e);
            showToast(tr('vendor.contract.loadFailed', 'Impossible de charger le contrat.'));
            return;
        }
        _contractSignatureSource = vendorNeedsResign() ? 'resign' : 'dashboard';
        const text = getContractText(_contractLang, _contractVersion, _contractTermsSnapshot);
        const textEl = document.getElementById('vContractText');
        textEl.textContent = text;
        textEl.setAttribute('lang', _contractLang);
        textEl.setAttribute('dir', _contractLang === 'ar' ? 'rtl' : 'ltr');
        textEl.scrollTop = 0;

        try {
            _contractTextHash = await computeContractTextHash(text);
        } catch (e) {
            console.error('[vendor-dashboard] Hash contrat impossible :', e);
            showToast(tr('vendor.signup.contractSignError', 'Erreur signature contrat.'));
            return;
        }

        _contractScrollReached = false;
        document.getElementById('vContractCheckbox').checked = false;
        document.getElementById('vContractAcceptBtn').disabled = true;
        document.getElementById('vContractAcceptBtn').style.opacity = '0.5';
        document.getElementById('vContractHint').textContent = "Faites défiler pour lire l'intégralité du contrat.";
        document.getElementById('vContractHint').style.color = 'var(--text-muted)';
        document.getElementById('vContractHint').style.display = '';
        document.getElementById('vContractMeta').textContent = tr('vendor.contract.version', 'Version') + ' : ' + _contractVersion;
        document.getElementById('vContractSignZone').style.display = '';
        document.getElementById('vContractReadZone').style.display = 'none';
    } else {
        const loaded = currentContractDoc || (await loadCurrentContract());
        if (!loaded || !loaded.data) { showToast(tr('vendor.contract.notFound', 'Aucun contrat signé à afficher.')); return; }
        currentContractDoc = loaded;

        const data = loaded.data;
        const lang = (LANGUAGES.includes(data.language) ? data.language : DEFAULT_LANGUAGE);
        const version = data.version || CONFIG.VENDOR.CONTRACT_VERSION;
        const snapshot = data.termsSnapshot || null;

        let text;
        try {
            text = getContractText(lang, version, snapshot);
        } catch (e) {
            console.error('[vendor-dashboard] Reconstruction du contrat impossible :', e);
            showToast(trParams('vendor.contract.verifyFail', { reason: e.message || 'gabarit manquant' }, 'Intégrité non vérifiable : {reason}'));
            return;
        }

        _contractLang = lang; _contractVersion = version; _contractTermsSnapshot = snapshot; _contractTextHash = null;

        const textEl = document.getElementById('vContractText');
        textEl.textContent = text;
        textEl.setAttribute('lang', lang);
        textEl.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        textEl.scrollTop = 0;

        const signedDate = formatDate(data.acceptedAt);
        document.getElementById('vContractHint').style.display = 'none';
        document.getElementById('vContractMeta').innerHTML = escapeHTML(tr('vendor.contract.version', 'Version')) + ' : <strong>' + escapeHTML(version) + '</strong> · ' + escapeHTML(tr('vendor.contract.language', 'Langue')) + ' : <strong>' + escapeHTML(lang.toUpperCase()) + '</strong> · ' + escapeHTML(trParams('vendor.contract.signedOn', { date: signedDate }, 'Signé le {date}'));
        document.getElementById('vContractSignZone').style.display = 'none';
        document.getElementById('vContractReadZone').style.display = 'flex';
    }

    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (modeSignature) requestAnimationFrame(() => requestAnimationFrame(checkContractScroll));
}

function closeContractModal() {
    const modal = document.getElementById('vContractModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
}

function checkContractScroll() {
    if (_contractReadOnly) return;
    const textEl = document.getElementById('vContractText');
    if (!textEl) return;
    const sh = textEl.scrollHeight; const ch = textEl.clientHeight; const st = textEl.scrollTop;
    const tol = 8; const noScrollNeeded = sh <= ch + tol; const atEnd = (st + ch) >= (sh - tol);
    if (noScrollNeeded || atEnd) { _contractScrollReached = true; updateContractAcceptButton(); }
}

function updateContractAcceptButton() {
    if (_contractReadOnly) return;
    const btn = document.getElementById('vContractAcceptBtn');
    const cb = document.getElementById('vContractCheckbox');
    const hint = document.getElementById('vContractHint');
    if (!btn || !cb) return;
    const ready = _contractScrollReached && cb.checked;
    btn.disabled = !ready;
    btn.style.opacity = ready ? '1' : '0.5';
    if (hint) {
        if (ready) { hint.textContent = tr('vendor.contract.canSign', 'Vous pouvez maintenant signer.'); hint.style.color = 'var(--success)'; }
        else if (!_contractScrollReached) { hint.textContent = tr('vendor.contract.scrollHint', "Faites défiler pour lire l'intégralité du contrat."); hint.style.color = 'var(--text-muted)'; }
        else { hint.textContent = 'Cochez la case pour accepter.'; hint.style.color = 'var(--text-muted)'; }
    }
}

async function submitContractSignature() {
    const btn = document.getElementById('vContractAcceptBtn');
    if (!btn || btn.disabled || _contractReadOnly) return;
    if (!_contractTextHash || !_contractVersion || !_contractTermsSnapshot) { showToast(tr('vendor.signup.contractSignError', 'Erreur signature contrat.')); return; }

    btn.disabled = true;
    btn.textContent = 'Signature...';

    try {
        const text = getContractText(_contractLang, _contractVersion, _contractTermsSnapshot);
        const signResult = await signVendorContract(currentUserUid, text, {
            textHash: _contractTextHash, language: _contractLang, version: _contractVersion,
            termsSnapshot: _contractTermsSnapshot, source: _contractSignatureSource
        });
        
        if (!signResult || !signResult.contractId) throw new Error('Signature invalide.');

        showToast('Contrat signé avec succès !');
        closeContractModal();
        
        // Recharger les données (le serveur a mis à jour contractStatus)
        const loaded = await loadVendorData(currentUserUid);
        currentVendor = loaded.profile; currentWallet = loaded.wallet;
        renderBanners(buildBanners(currentVendor)); attachBannerActions(createBannerHandlers());
        updateSidebarUI(currentVendor);
        
        if (!isVendorApproved()) {
            renderVendorAccessStatus(currentVendor);
            return;
        }
        currentContractDoc = await loadCurrentContract();
        document.querySelectorAll('.v-nav-link[data-tab]').forEach(link => { link.hidden = false; });
        updateSidebarUI(currentVendor);
        setActiveTab('overview'); await renderTab('overview');
        
    } catch (e) {
        console.error('[vendor-dashboard] Signature contrat échouée :', e);
        showToast(e.message || 'Erreur lors de la signature.');
        btn.disabled = false;
        btn.textContent = tr('vendor.contract.accept', 'Signer le contrat');
    }
}

/* ============================================================
   SECTION CONTRAT
   ============================================================ */
async function renderContractSection() {
    const vendorInfo = (currentVendor?.vendorInfo) || {};
    const contractStatus = vendorInfo.contractStatus || CONTRACT_STATUS.PENDING;

    if (contractStatus !== CONTRACT_STATUS.ACCEPTED) {
        return `
            <div class="v-card">
                <h3 class="v-card-title">${escapeHTML(tr('vendor.contract.sectionTitle', 'Mon contrat'))}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">${escapeHTML(tr('vendor.contract.statusMissing', 'Aucun contrat signé'))}</p>
                <button type="button" id="vSignContractBtn" class="v-btn v-btn-primary" style="margin-top:0.75rem;">${escapeHTML(tr('vendor.contract.signNow', 'Signer le contrat'))}</button>
            </div>`;
    }

    if (!currentContractDoc) {
        try { currentContractDoc = await loadCurrentContract(); } catch (e) { console.warn('[vendor-dashboard] loadCurrentContract :', e); }
    }

    const data = (currentContractDoc?.data) || {};
    const version = data.version || vendorInfo.contractVersion || CONFIG.VENDOR.CONTRACT_VERSION;
    const language = data.language || DEFAULT_LANGUAGE;
    const signedDate = formatDate(data.acceptedAt);
    const isUpToDate = !needsResign({ contractVersion: version });

    let statusBadge;
    if (isUpToDate) {
        statusBadge = `<span style="display:inline-block;background:var(--success-bg,#e6f6ec);color:var(--success,#0a7a3b);padding:0.15rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">${escapeHTML(tr('vendor.contract.statusUpToDate', 'Contrat à jour'))}</span>`;
    } else {
        statusBadge = `<span style="display:inline-block;background:var(--warning-bg,#fff3cd);color:var(--warning,#8a6d00);padding:0.15rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">${escapeHTML(tr('vendor.contract.statusOutdated', 'Contrat obsolète - re-signature requise'))}</span>`;
    }

    return `
        <div class="v-card">
            <h3 class="v-card-title">${escapeHTML(tr('vendor.contract.sectionTitle', 'Mon contrat'))}</h3>
            <div style="font-size:0.9rem;color:var(--text);line-height:1.8;">
                <div>${escapeHTML(tr('vendor.contract.version', 'Version'))} : <strong>${escapeHTML(version)}</strong></div>
                <div>${escapeHTML(tr('vendor.contract.language', 'Langue'))} : <strong>${escapeHTML(language.toUpperCase())}</strong></div>
                <div>${escapeHTML(trParams('vendor.contract.signedOn', { date: signedDate }, 'Signé le {date}'))}</div>
                <div style="margin-top:0.4rem;">${statusBadge}</div>
            </div>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:1rem;">
                <button type="button" id="vViewContractBtn" class="v-btn v-btn-secondary">${escapeHTML(tr('vendor.contract.view', 'Voir'))}</button>
                <button type="button" id="vPrintContractBtn" class="v-btn v-btn-secondary">${escapeHTML(tr('vendor.contract.print', 'Imprimer'))}</button>
                <button type="button" id="vDownloadContractBtn" class="v-btn v-btn-secondary">${escapeHTML(tr('vendor.contract.download', 'Télécharger'))}</button>
                <button type="button" id="vVerifyContractBtn" class="v-btn v-btn-secondary">${escapeHTML(tr('vendor.contract.verify', "Vérifier l'intégrité"))}</button>
                ${!isUpToDate ? `<button type="button" id="vResignContractBtn" class="v-btn v-btn-primary">${escapeHTML(tr('vendor.contract.signNow', 'Signer le contrat'))}</button>` : ''}
            </div>
        </div>`;
}

async function handleViewContract() { await openContractModal(false); }

async function handlePrintContract() {
    const loaded = currentContractDoc || (await loadCurrentContract());
    if (!loaded || !loaded.data) { showToast(tr('vendor.contract.notFound', 'Aucun contrat signé à afficher.')); return; }
    const data = loaded.data;
    const lang = LANGUAGES.includes(data.language) ? data.language : DEFAULT_LANGUAGE;
    const version = data.version || CONFIG.VENDOR.CONTRACT_VERSION;
    let text;
    try { text = getContractText(lang, version, data.termsSnapshot || null); } catch (e) { showToast(e.message || 'Contrat non reconstructible.'); return; }
    const w = window.open('', '_blank');
    if (!w) { showToast('Popup bloquée. Autorisez les popups.'); return; }
    const safe = escapeHTML(text).replace(/\n/g, '<br>');
    w.document.write(`<!doctype html><html lang="${escapeHTML(lang)}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>Contrat ${escapeHTML(version)}</title><style>body{font-family:Georgia,serif;max-width:820px;margin:2rem auto;padding:1rem;line-height:1.7;color:#222;}footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #ccc;font-size:0.75rem;color:#666;}pre{white-space:pre-wrap;font-family:inherit;}</style></head><body><pre>${safe}</pre><footer>textHash: ${escapeHTML(data.textHash || '—')}<br>contractHash: ${escapeHTML(data.contractHash || '—')}<br>${escapeHTML(trParams('vendor.contract.signedOn', { date: formatDate(data.acceptedAt) }, 'Signé le {date}'))}</footer></body></html>`);
    w.document.close(); w.focus(); setTimeout(() => { try { w.print(); } catch (_) { /* ignore */ } }, 250);
}

async function handleDownloadContract() {
    const loaded = currentContractDoc || (await loadCurrentContract());
    if (!loaded || !loaded.data) { showToast(tr('vendor.contract.notFound', 'Aucun contrat signé à afficher.')); return; }
    const data = loaded.data;
    const lang = LANGUAGES.includes(data.language) ? data.language : DEFAULT_LANGUAGE;
    const version = data.version || CONFIG.VENDOR.CONTRACT_VERSION;
    let text;
    try { text = getContractText(lang, version, data.termsSnapshot || null); } catch (e) { showToast(e.message || 'Contrat non reconstructible.'); return; }
    const footer = ['', '—'.repeat(40), 'Version : ' + version, 'Langue : ' + lang, 'Signé le : ' + formatDate(data.acceptedAt), 'textHash : ' + (data.textHash || '—'), 'contractHash : ' + (data.contractHash || '—')].join('\n');
    const blob = new Blob([text + footer], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `contrat-smartswi9a-v${version}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function handleVerifyContract() {
    const loaded = currentContractDoc || (await loadCurrentContract());
    if (!loaded || !loaded.data) { showToast(tr('vendor.contract.notFound', 'Aucun contrat signé à afficher.')); return; }
    showToast(tr('vendor.contract.verifyRunning', 'Vérification...'));
    const result = await verifyContractIntegrity(loaded.data);
    if (result.ok) showToast(tr('vendor.contract.verifyOk', 'Intégrité vérifiée'));
    else showToast(trParams('vendor.contract.verifyFail', { reason: result.reason || 'inconnue' }, 'Intégrité non vérifiable : {reason}'), 6000);
}

/* ============================================================
   RENDU DES ONGLETS
   ============================================================ */
function renderEmptyState(icon, title, desc, actionHtml = '') {
    return `<div class="v-empty"><div class="v-empty-icon" aria-hidden="true">${icon}</div><h3 class="v-empty-title">${escapeHTML(title)}</h3><p class="v-empty-desc">${escapeHTML(desc)}</p>${actionHtml}</div>`;
}

async function renderOverview(container) {
    await prepareOverviewData();
    const contractSectionHtml = await renderContractSection();
    container.innerHTML = buildOverviewHtml(contractSectionHtml);
    attachOverviewHandlers(container);
    renderVendorCharts();
}

function normalizeVendorOrderStatus(status) {
    const s = String(status || 'pending').toLowerCase();
    if (s === 'validated') return 'confirmed';
    if (s === 'received') return 'delivered';
    return s;
}

function vendorBucketDate(value) {
    try {
        if (value && typeof value.toDate === 'function') return value.toDate();
        if (value instanceof Date) return value;
        if (typeof value === 'number') return new Date(value);
        if (typeof value === 'string') return new Date(value);
    } catch (e) { /* ignore */ }
    return null;
}

async function prepareOverviewData() {
    const rate = getVendorCommissionRate();

    if (!cachedProducts.length) {
        try { await loadVendorProducts(); } catch (e) { /* non bloquant */ }
    }

    if (!overviewOrders.length && currentUserUid) {
        try {
            const q = query(
                collection(db, "vendor_orders", currentUserUid, "orders"),
                where("privacySafe", "==", true),
                orderBy("createdAt", "desc"),
                limit(500)
            );
            const snap = await getDocs(q);
            overviewOrders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        } catch (e) {
            try {
                const snap = await getDocs(query(
                    collection(db, "vendor_orders", currentUserUid, "orders"),
                    where("privacySafe", "==", true),
                    limit(500)
                ));
                overviewOrders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            } catch (e2) {
                overviewOrders = [];
            }
        }
    }

    const delivered = overviewOrders.filter((o) => normalizeVendorOrderStatus(o.status) === 'delivered');
    const inProgress = overviewOrders.filter(
        (o) => !['delivered', 'returned', 'cancelled'].includes(normalizeVendorOrderStatus(o.status))
    );

    let gross = 0;
    delivered.forEach((o) => {
        (Array.isArray(o.items) ? o.items : []).forEach((item) => {
            gross += (Number(item.price) || 0) * (Number(item.quantity) || 0);
        });
    });
    let effectiveRate = rate;
    let net = Math.round(gross * (1 - rate) * 100) / 100;
    try {
        const commissionInfo = calculateVendorCommission(gross, currentVendor);
        if (commissionInfo && Number.isFinite(Number(commissionInfo.netToPay))) {
            net = Math.round(Number(commissionInfo.netToPay) * 100) / 100;
        }
        if (commissionInfo && Number.isFinite(Number(commissionInfo.commissionRate))) {
            effectiveRate = Number(commissionInfo.commissionRate);
        }
    } catch (e) {
        console.warn('[vendor-dashboard] commission overview :', e);
    }

    const stock = (cachedProducts || []).reduce((sum, p) => {
        const warehouse = p.delivery_mode === 'smartswika_warehouse' || p.warehouse_received === true;
        if (!warehouse) return sum;
        return sum + Math.max(0, Number(p.stock_warehouse ?? p.stock) || 0);
    }, 0);

    overviewStats = {
        rate: effectiveRate,
        gross,
        net,
        delivered: delivered.length,
        inProgress: inProgress.length,
        stock
    };
    return overviewStats;
}

function buildOverviewHtml(contractSectionHtml) {
    const s = overviewStats || { net: 0, gross: 0, delivered: 0, inProgress: 0, stock: 0 };
    return `
        <div class="v-kpi-grid">
            <div class="v-kpi-card primary">
                <span class="v-kpi-icon" aria-hidden="true">💰</span>
                <span class="v-kpi-label">${escapeHTML(vt('kpiNet', 'Revenus Nets Vendeur'))}</span>
                <p class="v-kpi-value">${vfmt(s.net)}</p>
                <span class="v-kpi-sub">${escapeHTML(vt('kpiNetSub', 'Après commission 7 % · MAD'))}</span>
            </div>
            <div class="v-kpi-card">
                <span class="v-kpi-icon" aria-hidden="true">📈</span>
                <span class="v-kpi-label">${escapeHTML(vt('kpiGross', "Chiffre d'affaires Brut"))}</span>
                <p class="v-kpi-value">${vfmt(s.gross)}</p>
                <span class="v-kpi-sub">${escapeHTML(vt('kpiGrossSub', 'Ventes livrées · MAD'))}</span>
            </div>
            <div class="v-kpi-card">
                <span class="v-kpi-icon" aria-hidden="true">📦</span>
                <span class="v-kpi-label">${escapeHTML(vt('kpiOrders', 'Commandes Livrées vs En cours'))}</span>
                <p class="v-kpi-value">${s.delivered} / ${s.inProgress}</p>
                <span class="v-kpi-sub">${escapeHTML(vt('kpiOrdersSub', 'Livrées / en cours'))}</span>
            </div>
            <div class="v-kpi-card">
                <span class="v-kpi-icon" aria-hidden="true">🏬</span>
                <span class="v-kpi-label">${escapeHTML(vt('kpiStock', "Stock à l'entrepôt Smart Swika"))}</span>
                <p class="v-kpi-value">${s.stock}</p>
                <span class="v-kpi-sub">${escapeHTML(vt('kpiStockSub', 'Unités disponibles'))}</span>
            </div>
        </div>

        <div class="v-chart-grid">
            <div class="v-chart-card">
                <div class="v-chart-head">
                    <h3>${escapeHTML(vt('chartSalesTitle', 'Évolution des ventes et revenus nets (MAD)'))}</h3>
                    <div class="v-chart-periods">
                        <button type="button" class="v-btn v-btn-secondary v-chart-period-btn active" data-vendor-chart-period="7">${escapeHTML(vt('period7', '7j'))}</button>
                        <button type="button" class="v-btn v-btn-secondary v-chart-period-btn" data-vendor-chart-period="30">${escapeHTML(vt('period30', '30j'))}</button>
                        <button type="button" class="v-btn v-btn-secondary v-chart-period-btn" data-vendor-chart-period="90">${escapeHTML(vt('period90', '90j'))}</button>
                    </div>
                </div>
                <div class="v-chart-box"><canvas id="vendorRevenueChart"></canvas></div>
            </div>
            <div class="v-chart-card">
                <div class="v-chart-head"><h3>${escapeHTML(vt('chartOrdersTitle', 'Répartition de mes commandes par statut'))}</h3></div>
                <div class="v-chart-box">
                    <canvas id="vendorOrdersChart"></canvas>
                    <div class="v-donut-total"><strong id="vendorDonutTotal">0</strong><span>${escapeHTML(vt('chartTotalOrders', 'commandes'))}</span></div>
                </div>
            </div>
            <div class="v-chart-card wide">
                <div class="v-chart-head"><h3>${escapeHTML(vt('chartTopTitle', 'Top produits les plus vendus'))}</h3></div>
                <div class="v-chart-box short"><canvas id="vendorTopProductsChart"></canvas></div>
            </div>
        </div>

        ${contractSectionHtml || ''}
    `;
}

function attachOverviewHandlers(container) {
    container.querySelectorAll('[data-vendor-chart-period]').forEach((btn) => {
        btn.addEventListener('click', () => {
            overviewPeriod = parseInt(btn.dataset.vendorChartPeriod, 10) || 7;
            container.querySelectorAll('[data-vendor-chart-period]').forEach((b) => {
                b.classList.toggle('active', b === btn);
            });
            renderVendorCharts();
        });
    });

    document.getElementById('vSignContractBtn')?.addEventListener('click', () => openContractModal(true));
    document.getElementById('vViewContractBtn')?.addEventListener('click', handleViewContract);
    document.getElementById('vPrintContractBtn')?.addEventListener('click', handlePrintContract);
    document.getElementById('vDownloadContractBtn')?.addEventListener('click', handleDownloadContract);
    document.getElementById('vVerifyContractBtn')?.addEventListener('click', handleVerifyContract);
    document.getElementById('vResignContractBtn')?.addEventListener('click', () => openContractModal(true));
}

function destroyVendorCharts() {
    vendorChartInstances.forEach((chart) => {
        try { chart.destroy(); } catch (e) { /* ignore */ }
    });
    vendorChartInstances = [];
}

function renderVendorCharts() {
    if (typeof window.Chart === 'undefined') {
        document.querySelectorAll('.v-chart-box canvas').forEach((canvas) => {
            const parent = canvas.parentElement;
            if (parent) {
                parent.innerHTML = `<div class="v-empty" style="border:0;background:transparent;padding:1rem;"><p class="v-empty-desc">${escapeHTML(vt('noData', 'Aucune donnée sur la période'))}</p></div>`;
            }
        });
        return;
    }
    destroyVendorCharts();
    renderVendorRevenueChart();
    renderVendorOrdersDonut();
    renderVendorTopProductsChart();

    /* Laisse la grille se stabiliser avant de recalculer les tailles
       (le donut peut naitre dans une colonne pas encore mesuree). */
    window.setTimeout(() => {
        vendorChartInstances.forEach((chart) => {
            try { chart.resize(); } catch (e) { /* ignore */ }
        });
    }, 80);
}

function vendorPeriodOrders(period) {
    const days = Math.max(1, Number(period) || 7);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days + 1);
    return (overviewOrders || []).filter((o) => {
        const date = vendorBucketDate(o.createdAt);
        return date && date >= start;
    });
}

function renderVendorRevenueChart() {
    const canvas = document.getElementById('vendorRevenueChart');
    if (!canvas) return;
    const isAr = window.__vendorGetLang && window.__vendorGetLang() === 'ar';
    const days = Math.max(1, Number(overviewPeriod) || 7);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days + 1);

    const buckets = {};
    for (let i = 0; i < days; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        buckets[d.toISOString().slice(0, 10)] = { date: d, gross: 0, net: 0 };
    }
    const rate = overviewStats ? overviewStats.rate : getVendorCommissionRate();
    vendorPeriodOrders(days).forEach((o) => {
        if (normalizeVendorOrderStatus(o.status) !== 'delivered') return;
        const date = vendorBucketDate(o.createdAt);
        if (!date) return;
        const key = date.toISOString().slice(0, 10);
        if (!buckets[key]) return;
        const gross = (Array.isArray(o.items) ? o.items : [])
            .reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0);
        buckets[key].gross += gross;
        buckets[key].net += gross * (1 - rate);
    });

    const keys = Object.keys(buckets).sort();
    const locale = isAr ? 'ar-MA' : (window.__vendorGetLang && window.__vendorGetLang() === 'en' ? 'en-GB' : 'fr-FR');
    const labels = keys.map((k) => buckets[k].date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }));
    const grossData = keys.map((k) => Math.round(buckets[k].gross * 100) / 100);
    const netData = keys.map((k) => Math.round(buckets[k].net * 100) / 100);

    const ctx = canvas.getContext('2d');
    const grossGradient = ctx.createLinearGradient(0, 0, 0, 300);
    grossGradient.addColorStop(0, 'rgba(180, 131, 62, 0.30)');
    grossGradient.addColorStop(1, 'rgba(180, 131, 62, 0.02)');
    const netGradient = ctx.createLinearGradient(0, 0, 0, 300);
    netGradient.addColorStop(0, 'rgba(46, 204, 113, 0.24)');
    netGradient.addColorStop(1, 'rgba(46, 204, 113, 0.02)');

    const chart = new window.Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: vt('grossSeries', 'CA brut'),
                    data: grossData,
                    borderColor: '#B4833E',
                    backgroundColor: grossGradient,
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2,
                    pointRadius: 2,
                    pointHoverRadius: 5
                },
                {
                    label: vt('netSeries', 'Revenus nets'),
                    data: netData,
                    borderColor: '#2ecc71',
                    backgroundColor: netGradient,
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2,
                    pointRadius: 2,
                    pointHoverRadius: 5
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 800, easing: 'easeOutQuart' },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'bottom', rtl: isAr, labels: { usePointStyle: true, boxWidth: 8 } },
                tooltip: {
                    rtl: isAr,
                    callbacks: {
                        label: (item) => `${item.dataset.label}: ${vfmt(item.parsed.y)}`
                    }
                }
            },
            scales: {
                x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
                y: {
                    beginAtZero: true,
                    ticks: { callback: (value) => `${value} MAD` },
                    grid: { color: 'rgba(0,0,0,0.06)' }
                }
            }
        }
    });
    vendorChartInstances.push(chart);
}

function renderVendorOrdersDonut() {
    const canvas = document.getElementById('vendorOrdersChart');
    if (!canvas) return;
    const isAr = window.__vendorGetLang && window.__vendorGetLang() === 'ar';
    const groups = {
        preparing: { key: 'statusPreparing', color: '#8e44ad', value: 0 },
        shipping: { key: 'statusShipping', color: '#3498db', value: 0 },
        delivered: { key: 'statusDelivered', color: '#2ecc71', value: 0 },
        returned: { key: 'statusReturned', color: '#e74c3c', value: 0 }
    };
    (overviewOrders || []).forEach((o) => {
        const status = normalizeVendorOrderStatus(o.status);
        if (status === 'delivered') groups.delivered.value += 1;
        else if (['in_transit', 'shipping', 'picked_up', 'pickup_requested'].includes(status)) groups.shipping.value += 1;
        else if (['returned', 'cancelled'].includes(status)) groups.returned.value += 1;
        else groups.preparing.value += 1;
    });

    const entries = Object.values(groups).filter((g) => g.value > 0);
    const total = entries.reduce((sum, g) => sum + g.value, 0);
    const totalEl = document.getElementById('vendorDonutTotal');
    if (totalEl) totalEl.textContent = String(total);
    const hasData = entries.length > 0;

    const chart = new window.Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: hasData ? entries.map((g) => vt(g.key, g.key)) : [''],
            datasets: [{
                data: hasData ? entries.map((g) => g.value) : [1],
                backgroundColor: hasData ? entries.map((g) => g.color) : ['rgba(0,0,0,0.08)'],
                borderWidth: 0,
                hoverOffset: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            animation: { duration: 800, easing: 'easeOutQuart' },
            plugins: {
                legend: { position: 'bottom', rtl: isAr, labels: { usePointStyle: true, boxWidth: 8, padding: 12 } },
                tooltip: {
                    rtl: isAr,
                    enabled: hasData,
                    callbacks: {
                        label: (item) => {
                            const value = Number(item.parsed) || 0;
                            const pct = total ? Math.round((value / total) * 100) : 0;
                            return `${item.label}: ${value} (${pct}%)`;
                        }
                    }
                }
            }
        }
    });
    vendorChartInstances.push(chart);
}

function renderVendorTopProductsChart() {
    const canvas = document.getElementById('vendorTopProductsChart');
    if (!canvas) return;
    const isAr = window.__vendorGetLang && window.__vendorGetLang() === 'ar';
    const rate = overviewStats ? overviewStats.rate : getVendorCommissionRate();
    const products = new Map();

    (overviewOrders || []).forEach((o) => {
        if (normalizeVendorOrderStatus(o.status) !== 'delivered') return;
        (Array.isArray(o.items) ? o.items : []).forEach((item) => {
            const name = String(item.name || item.productName || 'Produit').trim() || 'Produit';
            const key = String(item.productId || name);
            const qty = Number(item.quantity) || 0;
            const revenue = (Number(item.price) || 0) * qty * (1 - rate);
            const entry = products.get(key) || { name, qty: 0, revenue: 0 };
            entry.qty += qty;
            entry.revenue += revenue;
            products.set(key, entry);
        });
    });

    const top = [...products.values()].sort((a, b) => b.qty - a.qty).slice(0, 8);
    const labels = top.length ? top.map((p) => p.name) : [vt('noData', 'Aucune donnée sur la période')];
    const qtyData = top.length ? top.map((p) => p.qty) : [0];
    const revenueData = top.length ? top.map((p) => Math.round(p.revenue * 100) / 100) : [0];

    const chart = new window.Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: `${vt('qtyLabel', 'Quantité')} / ${vt('netRevenueLabel', 'Revenus nets')} (MAD)`,
                data: qtyData,
                backgroundColor: 'rgba(180, 131, 62, 0.75)',
                borderRadius: 8,
                maxBarThickness: 22
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 800, easing: 'easeOutQuart' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    rtl: isAr,
                    callbacks: {
                        label: (item) => {
                            const idx = item.dataIndex;
                            const qty = qtyData[idx] || 0;
                            const revenue = revenueData[idx] || 0;
                            return `${vt('qtyLabel', 'Quantité')}: ${qty} · ${vt('netRevenueLabel', 'Revenus nets')}: ${vfmt(revenue)}`;
                        }
                    }
                }
            },
            scales: {
                x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(0,0,0,0.06)' } },
                y: { grid: { display: false } }
            }
        }
    });
    vendorChartInstances.push(chart);
}

async function renderProducts(container) {
    if (!isVendorApproved()) {
        container.innerHTML = renderEmptyState('📦', tr('vendor.products.locked.title', 'Publication verrouillée'), tr('vendor.products.locked.desc', "Votre compte doit être approuvé et votre contrat signé pour publier des produits."));
        return;
    }

    if (!warehouseState.loaded) {
        try { await refreshWarehouseState(); } catch (e) { /* non bloquant */ }
    }
    if (!hasWarehouseReceipt()) {
        container.innerHTML = renderEmptyState(
            '🏬',
            vt('lockedTitle', 'Publication verrouillée'),
            vt('lockedDesc', "Votre marchandise doit d'abord être reçue et contrôlée à l'entrepôt Smart Swika avant de pouvoir publier un produit."),
            `<div class="v-locked-cta"><button type="button" class="v-btn v-btn-primary" data-goto-pickup>${escapeHTML(vt('lockedCta', 'Voir mes demandes de ramassage'))}</button></div>`
        );
        container.querySelector('[data-goto-pickup]')?.addEventListener('click', () => {
            document.querySelector('.v-nav-link[data-tab="stock"]')?.click();
        });
        return;
    }

    if (!cachedProducts.length) await loadVendorProducts();
    updateVendorBadges();
    const newBtnHtml = `<div style="display:flex;justify-content:flex-end;margin-bottom:1rem;"><button type="button" id="vNewProductBtn" class="v-btn v-btn-primary">${escapeHTML(vt('newProduct', 'Nouveau produit'))}</button></div>`;

    if (!cachedProducts.length) {
        container.innerHTML = newBtnHtml + renderEmptyState('📦', tr('vendor.products.empty.title', 'Aucun produit'), tr('vendor.products.empty.desc', 'Publiez votre premier produit pour commencer à vendre.'));
        document.getElementById('vNewProductBtn')?.addEventListener('click', () => openProductModal(null));
        return;
    }

    const cards = cachedProducts.map(p => {
        const image = safeImageUrl(p.img);
        const name = escapeHTML(p.nameFr || p.nameEn || '—');
        const price = formatMAD(p.price);
        const stock = Number(p.stock) || 0;
        const status = p.status || PRODUCT_STATUS.PENDING_ADMIN_APPROVAL;
        const deliveryBadge = p.delivery_mode === 'smartswika_warehouse'
            ? `<span style="display:inline-block;margin-right:0.35rem;background:rgba(212,175,55,0.15);color:var(--gold);padding:0.1rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">🏬 Entrepôt Smart Swika</span>`
            : `<span style="display:inline-block;margin-right:0.35rem;background:rgba(230,126,34,0.15);color:#b35c00;padding:0.1rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">⚠️ Mode historique à migrer</span>`;
        let statusBadge = '';
        let rejectionHtml = '';

        if (status === PRODUCT_STATUS.APPROVED) statusBadge = `<span class="v-product-status approved">${escapeHTML(tr('product.status.approved', 'Approuvé'))}</span>`;
        else if (status === PRODUCT_STATUS.REJECTED) {
            statusBadge = `<span class="v-product-status rejected">${escapeHTML(tr('product.status.rejected', 'Rejeté'))}</span>`;
            if (p.rejectionReason) rejectionHtml = `<div style="font-size:0.8rem;color:var(--danger);margin-top:0.3rem;">${escapeHTML(p.rejectionReason)}</div>`;
        } else if (status === PRODUCT_STATUS.SUSPENDED) statusBadge = `<span class="v-product-status suspended">${escapeHTML(tr('product.status.suspended', 'Suspendu'))}</span>`;
        else statusBadge = `<span class="v-product-status pending">${escapeHTML(tr('product.status.pending', 'En validation'))}</span>`;

        return `
            <div class="v-product-item">
                ${image ? `<img src="${image}" alt="${name}" loading="lazy" class="v-product-img">` : `<div class="v-product-img" style="display:flex;align-items:center;justify-content:center;font-size:1.5rem;">📦</div>`}
                <div class="v-product-info"><div class="v-product-name">${name}</div><div class="v-product-meta">${price} · ${escapeHTML(vt('stockLabel', 'Stock'))} : ${stock}</div><div style="margin-top:0.3rem;">${deliveryBadge}${statusBadge}</div>${rejectionHtml}</div>
                <div class="v-product-actions">
                    ${status === PRODUCT_STATUS.APPROVED ? `<button type="button" class="v-btn v-btn-secondary" data-promo-product="${escapeHTML(p.id)}" style="padding:0.4rem 0.8rem;font-size:0.8rem;" title="${escapeHTML(vt('copyAdLink', '📣 Copier lien pub'))}">${escapeHTML(vt('copyAdLink', '📣 Copier lien pub'))}</button>` : ''}
                    <button type="button" class="v-btn v-btn-secondary" data-edit-product="${escapeHTML(p.id)}" style="padding:0.4rem 0.8rem;font-size:0.8rem;" title="${escapeHTML(vt('edit', 'Éditer'))}">${escapeHTML(vt('edit', 'Éditer'))}</button>
                    <button type="button" class="v-btn v-btn-secondary" data-delete-product="${escapeHTML(p.id)}" style="padding:0.4rem 0.8rem;font-size:0.8rem;" title="${escapeHTML(vt('delete', 'Supprimer'))}">${escapeHTML(vt('delete', 'Supprimer'))}</button>
                </div>
            </div>`;
    }).join('');

    container.innerHTML = newBtnHtml + `<div class="v-product-list">${cards}</div>`;

    document.getElementById('vNewProductBtn')?.addEventListener('click', () => openProductModal(null));
    container.querySelectorAll('[data-edit-product]').forEach(btn => {
        btn.addEventListener('click', () => openProductModal(cachedProducts.find(pp => pp.id === btn.dataset.editProduct)));
    });
    container.querySelectorAll('[data-delete-product]').forEach(btn => {
        btn.addEventListener('click', () => deleteVendorProduct(btn.dataset.deleteProduct));
    });
    container.querySelectorAll('[data-promo-product]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const product = cachedProducts.find(pp => String(pp.id) === String(btn.dataset.promoProduct));
            if (!product) return;
            const copied = await copyVendorPromoUrl(buildVendorPromoUrl(product));
            showToast(copied
                ? vt('adLinkCopied', 'Lien publicitaire copié')
                : vt('adLinkCopyFailed', 'Copie impossible. Réessayez.'));
        });
    });
}

async function renderOrders(container) {
    if (!ordersLoading && ordersLastDoc === null) {
        container.innerHTML = `<div style="text-align:center;padding:2rem;"><div class="spinner" style="margin:0 auto;"></div></div>`;
        cachedOrders = [];
    }

    if (cachedOrders.length === 0) {
        try {
            const q = query(collection(db, "vendor_orders", currentUserUid, "orders"), where("privacySafe", "==", true), orderBy("createdAt", "desc"), limit(10));
            const snap = await getDocs(q);
            cachedOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            ordersLastDoc = snap.docs[snap.docs.length - 1] || null;
            ordersHasMore = snap.docs.length === 10;
        } catch (e) {
            console.warn('[vendor-dashboard] Lecture orders échouée :', e);
            cachedOrders = [];
        }
    }

    updateVendorBadges();
    if (!cachedOrders.length) {
        container.innerHTML = renderEmptyState('📋', tr('vendor.orders.empty.title', 'Aucune commande pour le moment'), tr('vendor.orders.empty.desc', 'Vos commandes apparaîtront ici dès que vos produits seront vendus.'));
        return;
    }

    const rows = cachedOrders.map(o => {
        const shortId = (o.id || '').slice(0, 8).toUpperCase();
        const status = o.status || 'pending';
        const date = o.createdAt?.toDate?.()?.toLocaleDateString?.('fr-FR') || '—';
        const myItems = Array.isArray(o.items) ? o.items : [];
        const myGross = myItems.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);

        let commissionInfo;
        try {
            const vendorForCommission = { vendorInfo: { commissionRate: currentVendor?.vendorInfo?.commissionRate } };
            commissionInfo = calculateVendorCommission(myGross, vendorForCommission);
        } catch (e) {
            commissionInfo = { subtotal: myGross, commissionRate: CONFIG.VENDOR.COMMISSION_RATE, commission: Math.round(myGross * CONFIG.VENDOR.COMMISSION_RATE * 100) / 100, netToPay: Math.round(myGross * (1 - CONFIG.VENDOR.COMMISSION_RATE) * 100) / 100 };
        }

        const itemsHtml = myItems.map(i => {
            const variantText = i.variant ? ` (${[i.variant.size, i.variant.color].filter(Boolean).join('-')})` : '';
            return `<div style="font-size:0.8rem;color:var(--text-muted);">${escapeHTML(i.name || 'Produit')}${escapeHTML(variantText)} × ${i.quantity}</div>`;
        }).join('');

        // Une commande multi-vendeurs partage un statut global : un seul vendeur
        // ne doit pas pouvoir faire avancer le flux de tous les autres vendeurs.
        let actionHtml = '';
        const isMultiVendorOrder = Number(o.vendorCount) > 1;
        if (isMultiVendorOrder) {
            actionHtml = `<span style="font-size:0.75rem;color:var(--text-muted);">Suivi de cette commande géré par l’administration (commande multi-vendeurs).</span>`;
        } else if (status === 'pending') {
            actionHtml = `<button class="v-btn v-btn-primary" data-action="advance-order" data-id="${o.id}" data-next="confirmed" style="padding:0.3rem 0.6rem;font-size:0.75rem;">Confirmer</button>`;
        } else {
            // PR 8.2 : le vendeur ne pilote plus l'expedition. Les transitions
            // post-confirmation (stock_warehouse, trackingStartedAt, credit
            // vendeur) sont gerees par l'admin et le webhook Livo. Un
            // updateDoc direct ecrivait shipping sans aucune de ces garanties.
            actionHtml = `<span style="font-size:0.75rem;color:var(--text-muted);">🔒 ${tr('vendor.orders.readonly', 'Suivi géré par Smart Swika')}</span>`;
        }

        return `
            <div class="v-card" style="display:flex;flex-direction:column;gap:0.5rem;">
                <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
                    <strong style="color:var(--gold);">#${shortId}</strong>
                    <span style="font-size:0.8rem;color:var(--text-muted);">${date}</span>
                </div>
                <div style="font-size:0.85rem;color:var(--text-muted);">${escapeHTML(translateStatus(status))} · ${myItems.length} article(s)</div>
                <div style="margin:0.5rem 0;">${itemsHtml}</div>
                <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px dashed var(--border);padding-top:0.5rem;font-size:0.85rem;">
                    <div>Brut : <strong>${formatMAD(myGross)}</strong></div>
                    <div>Com. (${Math.round(commissionInfo.commissionRate * 100)}%) : <strong style="color:var(--danger);">-${formatMAD(commissionInfo.commission)}</strong></div>
                    <div>Net : <strong style="color:var(--success);">${formatMAD(commissionInfo.netToPay)}</strong></div>
                </div>
                <div style="text-align:right;margin-top:0.5rem;">${actionHtml}</div>
            </div>`;
    }).join('');

    container.innerHTML = `<div style="display:flex;flex-direction:column;gap:0.8rem;">${rows}</div>${ordersHasMore ? `<div style="text-align:center;margin-top:1rem;"><button id="loadMoreOrdersBtn" class="v-btn v-btn-secondary">Charger plus</button></div>` : ''}`;

    // PR 8.2 : le bouton "Expédier" a ete retire. Le handler est conserve
    // uniquement pour l'action restante "Confirmer" (pending -> confirmed),
    // qui reste dans le perimetre du vendeur.
    container.querySelectorAll('[data-action="advance-order"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.id;
            const nextStatus = btn.dataset.next;
            if (!['confirmed'].includes(nextStatus)) {
                showToast('Action non autorisee : suivi geree par Smart Swika.');
                return;
            }
            btn.disabled = true;
            btn.textContent = '...';
            try {
                await updateDoc(doc(db, "orders", orderId), {
                    status: nextStatus,
                    updatedAt: serverTimestamp()
                });
                showToast(`Commande mise à jour : ${translateStatus(nextStatus)}`);
                cachedOrders = []; // Force le rechargement
                await renderOrders(container);
            } catch (e) {
                console.error('[vendor-dashboard] Erreur mise à jour statut :', e);
                showToast('Erreur : ' + e.message);
                btn.disabled = false;
            }
        });
    });

    document.getElementById('loadMoreOrdersBtn')?.addEventListener('click', async (e) => {
        const btn = e.target; btn.disabled = true; btn.textContent = '...';
        try {
            const q = query(collection(db, "vendor_orders", currentUserUid, "orders"), where("privacySafe", "==", true), orderBy("createdAt", "desc"), startAfter(ordersLastDoc), limit(10));
            const snap = await getDocs(q);
            const more = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            cachedOrders = [...cachedOrders, ...more];
            ordersLastDoc = snap.docs[snap.docs.length - 1] || ordersLastDoc;
            ordersHasMore = snap.docs.length === 10;
            await renderOrders(container);
        } catch (err) {
            console.error('[vendor-dashboard] Charger plus échoué :', err);
            showToast('Erreur : ' + err.message);
            btn.disabled = false; btn.textContent = 'Charger plus';
        }
    });
}


function isValidPickupDate(value) {
    const match = String(value || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return false;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date >= today;
}


async function renderStock(container) {
    const shippingMethod = currentVendor?.vendorInfo?.shippingMethod;
    if (shippingMethod !== 'fulfillment') {
        container.innerHTML = renderEmptyState('📦',
            tr('vendor.pickup.notConfiguredTitle', 'Mode logistique non configuré'),
            tr('vendor.pickup.notConfiguredBody', "Contactez l'administration pour activer le mode entrepôt Smart Swika."));
        return;
    }

    await loadPickupRequests();
    updateVendorBadges();

    const statusLabel = {
        pending: tr('vendor.pickup.status.pending', '⏳ En attente de validation admin'),
        approved: tr('vendor.pickup.status.approved', '✅ Approuvée — stock réceptionné'),
        rejected: tr('vendor.pickup.status.rejected', '❌ Refusée')
    };
    const requestsHtml = cachedPickupRequests.length
        ? cachedPickupRequests.map(r => {
            const items = Array.isArray(r.items) ? r.items : [];
            const detail = items.map(i => {
                const received = Number(i.receivedQuantity) || 0;
                return `${escapeHTML(i.name)} × ${received} — SKU <strong>${escapeHTML(i.sku || '—')}</strong>`;
            }).join('<br>');
            const totalLabels = items.reduce((s, i) => s + (Number(i.receivedQuantity) || 0), 0);
            const printLabel = trParams('vendor.pickup.printLabels', { count: totalLabels }, '🖨️ Imprimer les étiquettes ({count})');
            const printBtn = r.status === 'approved' && totalLabels > 0
                ? `<button type="button" class="v-btn v-btn-secondary" style="margin-top:.5rem;font-size:.8rem;" data-print-labels="${escapeHTML(r.id)}">${escapeHTML(printLabel)}</button>`
                : '';
            const desiredLabel = trParams('vendor.pickup.desiredDate', { date: String(r.desiredDate || '—') }, 'Date souhaitée : {date}');
            return `<div style="border:1px solid var(--border);border-radius:8px;padding:.6rem;margin-bottom:.5rem;">
                <strong>${statusLabel[r.status] || escapeHTML(String(r.status || ''))}</strong>
                <div style="font-size:.82rem;color:var(--text-muted);margin-top:.2rem;">${detail}</div>
                <div style="font-size:.75rem;color:var(--text-muted);">${escapeHTML(desiredLabel)}</div>
                ${printBtn}
            </div>`;
        }).join('')
        : `<p style="color:var(--text-muted);margin:0;">${escapeHTML(tr('vendor.pickup.empty', 'Aucune demande pour le moment.'))}</p>`;

    container.innerHTML = `
        <div class="v-card">
            <h3 class="v-card-title">${escapeHTML(tr('vendor.pickup.title', "📦 Ramassage vers l'entrepôt Smart Swika"))}</h3>
            <p style="color:var(--text-muted);font-size:.9rem;line-height:1.6;margin:0;">
                ${escapeHTML(tr('vendor.pickup.intro', "Déclarez les produits et quantités à remettre à Smart Swika. Une ligne = une variante (taille / couleur), avec son propre SKU. Après validation par l'administration, le stock est réceptionné à l'entrepôt ; vous pourrez alors créer la fiche produit."))}
                <strong>${escapeHTML(tr('vendor.pickup.introStrong', 'Aucun produit ne peut être ajouté avant cette approbation.'))}</strong>
            </p>
        </div>

        <div class="v-card" style="margin-top:1rem;">
            <h3 class="v-card-title">${escapeHTML(tr('vendor.pickup.myRequests', 'Mes demandes'))}</h3>
            ${requestsHtml}
        </div>

        <div class="v-card" style="margin-top:1rem;">
            <h3 class="v-card-title">${escapeHTML(tr('vendor.pickup.newRequest', 'Nouvelle demande de ramassage'))}</h3>
            <div id="vPickupRows"></div>
            <button type="button" id="vPickupAddRow" class="v-btn v-btn-secondary" style="margin-top:.5rem;">${escapeHTML(tr('vendor.pickup.addProduct', '＋ Ajouter un produit'))}</button>

            <div class="v-field" style="margin-top:1rem;">
                <label class="v-label" for="vPickupDate">${escapeHTML(tr('vendor.pickup.dateLabel', 'Date de ramassage souhaitée (JJ/MM/AAAA) *'))}</label>
                <input type="text" id="vPickupDate" class="v-input" inputmode="numeric" placeholder="25/05/2026" maxlength="10" autocomplete="off">
            </div>
            <div class="v-field">
                <label class="v-label" for="vPickupComment">${escapeHTML(tr('vendor.pickup.commentLabel', 'Commentaire (optionnel)'))}</label>
                <textarea id="vPickupComment" class="v-input" rows="3" maxlength="500" placeholder="${escapeHTML(tr('vendor.pickup.commentPlaceholder', 'Adresse, horaire, accès...'))}"></textarea>
            </div>
            <div id="vPickupError" style="color:var(--danger);font-size:.85rem;min-height:1.2rem;"></div>
            <button type="button" id="vPickupSmartSubmitBtn" class="v-btn v-btn-primary v-btn-block">${escapeHTML(tr('vendor.pickup.submit', 'Envoyer la demande à Smart Swika'))}</button>
        </div>
    `;

    const rows = document.getElementById('vPickupRows');
    addPickupRow(rows);
    document.getElementById('vPickupAddRow')?.addEventListener('click', () => addPickupRow(rows));
    document.getElementById('vPickupSmartSubmitBtn')?.addEventListener('click', submitSmartPickupRequest);
    container.querySelectorAll('[data-print-labels]').forEach(btn => {
        btn.addEventListener('click', () => printPickupLabels(btn.dataset.printLabels));
    });
}

function addPickupRow(rows, name = '', qty = '', size = '', color = '') {
    if (!rows || rows.children.length >= 50) return;
    const row = document.createElement('div');
    row.className = 'v-pickup-row';
    row.style.cssText = 'display:grid;grid-template-columns:2fr 70px 75px 85px 36px;gap:.4rem;margin-bottom:.4rem;';
    const phName = escapeHTML(tr('vendor.pickup.namePlaceholder', 'Nom du produit'));
    const phQty = escapeHTML(tr('vendor.pickup.qtyPlaceholder', 'Qté'));
    const phSize = escapeHTML(tr('vendor.pickup.sizePlaceholder', 'Taille'));
    const phColor = escapeHTML(tr('vendor.pickup.colorPlaceholder', 'Couleur'));
    const ariaRemove = escapeHTML(tr('vendor.pickup.removeRow', 'Retirer'));
    row.innerHTML = `<input class="v-input v-pickup-name" type="text" maxlength="120" placeholder="${phName}" value="${escapeHTML(name)}">
        <input class="v-input v-pickup-qty" type="number" min="1" step="1" placeholder="${phQty}" value="${escapeHTML(String(qty))}">
        <input class="v-input v-pickup-size" type="text" maxlength="30" placeholder="${phSize}" value="${escapeHTML(size)}">
        <input class="v-input v-pickup-color" type="text" maxlength="30" placeholder="${phColor}" value="${escapeHTML(color)}">
        <button type="button" class="v-btn v-btn-secondary" aria-label="${ariaRemove}">✕</button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    rows.appendChild(row);
}

function printPickupLabels(requestId) {
    const request = cachedPickupRequests.find(r => r.id === requestId);
    if (!request || request.status !== 'approved') {
        showToast(tr('vendor.pickup.labelsNotApproved', 'Étiquettes disponibles uniquement après approbation admin.'));
        return;
    }
    const items = Array.isArray(request.items) ? request.items : [];
    const labels = [];
    items.forEach(item => {
        const count = Number(item.receivedQuantity) || 0;
        for (let i = 0; i < count; i++) labels.push(item);
    });
    if (!labels.length) {
        showToast(tr('vendor.pickup.labelsEmpty', "Aucune unité reçue : pas d'étiquette à imprimer."));
        return;
    }

    const html = labels.map(item => {
        const svg = buildCode128Svg(String(item.sku || ''), { moduleWidth: 1.2, height: 38, margin: 4 });
        const variant = [item.size, item.color].filter(Boolean).join(' / ');
        return `<div class="v-sku-label">
            <div style="font-size:13px;font-weight:700;margin-bottom:2px;">${escapeHTML(item.name || tr('vendor.pickup.productFallback', 'Produit'))}</div>
            ${variant ? `<div style="font-size:11px;">${escapeHTML(variant)}</div>` : ''}
            <div style="font-size:11px;">SKU : <strong>${escapeHTML(item.sku || '')}</strong></div>
            <div style="margin-top:4px;">${svg}</div>
            <div style="font-size:9px;color:#555;">${escapeHTML(tr('vendor.pickup.labelFooter', 'Smart Swika — entrepôt'))}</div>
        </div>`;
    }).join('');

    const style = document.createElement('style');
    style.id = 'vSkuPrintStyle';
    style.textContent = `
        #vSkuPrintArea { display: none; }
        @media print {
            body * { visibility: hidden !important; }
            #vSkuPrintArea, #vSkuPrintArea * { visibility: visible !important; }
            #vSkuPrintArea {
                display: grid !important;
                grid-template-columns: repeat(2, 1fr);
                gap: 8px;
                position: absolute;
                left: 0; top: 0; width: 100%;
                padding: 8px; background: #fff; color: #000;
            }
            .v-sku-label {
                border: 1px dashed #999;
                padding: 8px;
                text-align: center;
                font-family: Arial, sans-serif;
                break-inside: avoid;
                page-break-inside: avoid;
            }
            @page { margin: 8mm; }
        }`;
    const area = document.createElement('div');
    area.id = 'vSkuPrintArea';
    area.innerHTML = html;
    document.head.appendChild(style);
    document.body.appendChild(area);

    window.print();
    setTimeout(() => {
        area.remove();
        style.remove();
    }, 500);
}

async function submitSmartPickupRequest() {
    const errEl = document.getElementById('vPickupError');
    const btn = document.getElementById('vPickupSmartSubmitBtn');
    const items = [...document.querySelectorAll('#vPickupRows .v-pickup-row')]
        .map(row => ({
            name: row.querySelector('.v-pickup-name')?.value.trim() || '',
            quantity: parseInt(row.querySelector('.v-pickup-qty')?.value, 10),
            size: row.querySelector('.v-pickup-size')?.value.trim() || '',
            color: row.querySelector('.v-pickup-color')?.value.trim() || ''
        }))
        .filter(i => i.name);

    if (!items.length) { if (errEl) errEl.textContent = tr('vendor.pickup.errNoItem', 'Ajoutez au moins un produit.'); return; }
    if (items.some(i => !Number.isInteger(i.quantity) || i.quantity < 1)) {
        if (errEl) errEl.textContent = tr('vendor.pickup.errQty', 'Indiquez une quantité valide pour chaque produit.');
        return;
    }
    const date = document.getElementById('vPickupDate')?.value.trim() || '';
    if (!isValidPickupDate(date)) {
        if (errEl) errEl.textContent = tr('vendor.pickup.errDate', 'Date invalide : format JJ/MM/AAAA, date non passée.');
        return;
    }
    const comment = document.getElementById('vPickupComment')?.value.trim() || '';

    if (btn) { btn.disabled = true; btn.textContent = tr('vendor.pickup.sending', 'Envoi...'); }
    try {
        await addDoc(collection(db, 'vendor_pickup_requests'), {
            vendorId: currentUserUid,
            vendorName: (currentVendor?.vendorInfo?.shopName || currentVendor?.name || 'Vendeur').slice(0, 120),
            status: 'pending',
            items,
            desiredDate: date,
            comment,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        showToast(tr('vendor.pickup.sent', 'Demande de ramassage envoyée. En attente de validation admin.'));
        cachedPickupRequests = [];
        await renderStock(document.getElementById('vTabContent'));
        try { await refreshWarehouseState(); } catch (e) { /* non bloquant */ }
    } catch (e) {
        console.error('[vendor-dashboard] demande ramassage :', e);
        if (errEl) errEl.textContent = trParams('vendor.pickup.errGeneric', { message: (e.message || 'inconnue') }, 'Erreur : {message}');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = tr('vendor.pickup.submit', 'Envoyer la demande à Smart Swika'); }
    }
}

/* Statuts de retrait : 'paid' (ancien) est aliasé en 'completed'. */
function normalizePayoutStatus(status) {
    const st = String(status || 'pending').trim().toLowerCase();
    if (st === 'paid') return 'completed';
    return st;
}

async function renderWallet(container) {
    if (!cachedWithdrawals.length) await loadWithdrawals();
    await loadWalletTransactions();
    updateVendorBadges();
    const available = formatMAD(currentWallet?.availableBalance);
    const pending = formatMAD(currentWallet?.pendingBalance);
    const negativeBalance = Math.max(0, -(Number(currentWallet?.negativeBalance) || 0));
    const debt = formatMAD(negativeBalance);
    const minWithdrawal = formatMAD(CONFIG.VENDOR.MIN_WITHDRAWAL);
    const virtualAvailable = formatMAD(getVirtualAvailableBalance());
    const hasPendingRequest = getPendingWithdrawalTotal() > 0;
    const canWithdraw = canRequestWithdrawal() && !hasPendingRequest;
    const disabledAttr = canWithdraw ? '' : 'disabled';

    let reason = '';
    if (!isVendorApproved()) reason = tr('vendor.wallet.withdrawLockedNotApproved', "Compte non approuvé : retrait verrouillé.");
    else if (negativeBalance > 0.0001) reason = `Retrait bloqué : dette à régulariser de ${debt}.`;
    else if (hasPendingRequest) reason = "Demande de retrait en cours de traitement.";
    else if (getVirtualAvailableBalance() < CONFIG.VENDOR.MIN_WITHDRAWAL) reason = tr('vendor.wallet.withdrawLockedMin', "Solde insuffisant (minimum : {min}).").replace('{min}', minWithdrawal);

    const WITHDRAWAL_BADGE = {
        pending:   `<span style="background:var(--warning-bg);color:var(--warning);padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">${escapeHTML(tr('payout.pending', 'En attente'))}</span>`,
        sent:      `<span style="background:rgba(52,152,219,0.15);color:#2f86c9;padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">${escapeHTML(tr('payout.sent', 'Envoyé — à retirer en agence'))}</span>`,
        completed: `<span style="background:var(--success-bg);color:var(--success);padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">${escapeHTML(tr('payout.completed', 'Retiré'))}</span>`,
        rejected:  `<span style="background:var(--danger-bg);color:var(--danger);padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">${escapeHTML(tr('payout.rejected', 'Rejeté'))}</span>`,
        cancelled: `<span style="background:var(--bg-surface);color:var(--text-muted);padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">${escapeHTML(tr('payout.cancelled', 'Annulé'))}</span>`
    };
    const withdrawalRows = cachedWithdrawals.length ? cachedWithdrawals.map(w => {
        // Rétro-compatibilité : l'ancien statut 'paid' est lu comme 'completed'.
        const st = normalizePayoutStatus(w.status);
        const statusBadge = WITHDRAWAL_BADGE[st] || WITHDRAWAL_BADGE.pending;
        const date = w.requestedAt?.toDate?.()?.toLocaleDateString?.('fr-FR') || '—';
        let sentBlock = '';
        if (st === 'sent') {
            const transferNumber = escapeHTML(String(w.transferNumber || '').trim() || '—');
            sentBlock = `
                <div style="flex-basis:100%;margin-top:0.5rem;background:rgba(52,152,219,0.08);border:1px solid rgba(52,152,219,0.45);border-radius:var(--radius-sm);padding:0.7rem 0.9rem;font-size:0.8rem;line-height:1.5;color:var(--text-muted);">
                    <div style="font-size:0.9rem;color:var(--text);margin-bottom:0.3rem;">Numéro de transfert : <strong style="letter-spacing:0.05em;">${transferNumber}</strong></div>
                    Présentez-vous à une agence avec votre CIN et ce numéro. Les frais de retrait seront déduits par l'agence.
                </div>`;
        } else if (st === 'rejected' && w.rejectionReason) {
            sentBlock = `
                <div style="flex-basis:100%;margin-top:0.5rem;background:rgba(231,76,60,0.08);border:1px solid rgba(231,76,60,0.45);border-radius:var(--radius-sm);padding:0.7rem 0.9rem;font-size:0.8rem;line-height:1.5;color:var(--text-muted);">
                    Motif : ${escapeHTML(String(w.rejectionReason))}
                </div>`;
        }
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.7rem 0;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:0.5rem;"><div><strong>${formatMAD(w.amount)}</strong> · ${escapeHTML(w.method || '—')} · ${date}</div><div>${statusBadge}</div></div>${sentBlock}`;
    }).join('') : `<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;">${tr('vendor.wallet.noWithdrawals', 'Aucune demande de retrait pour le moment.')}</p>`;

    const transactionRows = cachedWalletTransactions.length ? cachedWalletTransactions.map(tx => {
        const amount = Number(tx.amount) || 0;
        const positive = amount >= 0;
        const status = tx.status === 'pending' ? 'En attente de déblocage'
            : tx.status === 'released' ? 'Confirmé'
            : (tx.status || '—');
        const date = tx.createdAt?.toDate?.()?.toLocaleString?.('fr-FR') || '—';
        const details = [];
        if (tx.type === 'return_fee' && Number(tx.returnedQty) > 0) details.push(`${Number(tx.returnedQty)} article(s) retourné(s)`);
        if (Number(tx.pendingOffsetAmount) > 0) details.push(`prélevé sur attente : ${formatMAD(tx.pendingOffsetAmount)}`);
        if (Number(tx.availableOffsetAmount) > 0) details.push(`prélevé sur disponible : ${formatMAD(tx.availableOffsetAmount)}`);
        if (Number(tx.debtAmount) > 0) details.push(`dette créée : ${formatMAD(tx.debtAmount)}`);
        if (Number(tx.reversedAmount) > 0) details.push(`compensation : ${formatMAD(tx.reversedAmount)}`);
        if (Number(tx.releasedAmount) > 0 && tx.status === 'pending') details.push(`déjà débloqué : ${formatMAD(tx.releasedAmount)}`);
        return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.75rem;padding:0.75rem 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
            <div style="min-width:0;flex:1;">
                <strong>${escapeHTML(getWalletTransactionLabel(tx))}</strong>
                <div style="font-size:0.72rem;color:var(--text-muted);">${escapeHTML(date)} · ${escapeHTML(status)}</div>
                ${tx.description ? `<div style="font-size:0.75rem;color:var(--text-muted);">${escapeHTML(tx.description)}</div>` : ''}
                ${details.length ? `<div style="font-size:0.7rem;color:var(--text-muted);">${details.map(escapeHTML).join(' · ')}</div>` : ''}
            </div>
            <strong style="white-space:nowrap;color:${positive ? 'var(--success)' : 'var(--danger)'};">${positive ? '+' : '−'} ${formatMAD(Math.abs(amount))}</strong>
        </div>`;
    }).join('') : `<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;">Aucun mouvement de portefeuille pour le moment.</p>`;

    container.innerHTML = `
        <div class="v-wallet-hero">
            <div class="v-wallet-label">${escapeHTML(tr('vendor.wallet.available', 'Solde disponible'))}</div>
            <div class="v-wallet-amount">${available}</div>
            <div style="margin-top:0.5rem; color:var(--text-muted); font-size:0.9rem;">${escapeHTML(tr('vendor.wallet.pending', 'En attente'))} : ${pending}</div>
            ${negativeBalance > 0.0001 ? `<div style="margin-top:0.35rem;color:var(--danger);font-size:0.85rem;font-weight:700;">Dette à régulariser : ${debt}</div>` : ''}
            ${hasPendingRequest ? `<div style="margin-top:0.35rem;color:var(--text-muted);font-size:0.8rem;">Solde virtuel (après demandes en cours) : ${virtualAvailable}</div>` : ''}
            <button type="button" id="btnRequestWithdrawal" class="v-btn v-btn-primary" style="margin-top:1rem;" ${disabledAttr}>${escapeHTML(tr('vendor.wallet.requestWithdrawal', 'Demander un retrait'))}</button>
            ${reason ? `<div style="margin-top:0.5rem; color:var(--text-muted); font-size:0.85rem;">${escapeHTML(reason)}</div>` : ''}
        </div>
        <div class="v-card" style="margin-top:1.5rem;"><h3 class="v-card-title">${escapeHTML(tr('vendor.wallet.historyTitle', 'Historique des retraits'))}</h3>${withdrawalRows}</div>
        <div class="v-card" style="margin-top:1.5rem;"><h3 class="v-card-title">Historique des mouvements du portefeuille</h3>${transactionRows}</div>`;

    const btn = document.getElementById('btnRequestWithdrawal');
    if (btn && canWithdraw) btn.addEventListener('click', openWithdrawModal);
}

/* Guide vendeur en arabe (RTL). Meme structure que la version FR. */
function guideArHtml() {
    const card = 'class="v-card" style="margin-top:1rem;"';
    const list = 'style="line-height:1.75;padding-right:1.2rem;margin:0;"';
    return `<div dir="rtl" style="text-align:right;">
        <div class="v-card">
            <h3 class="v-card-title">📘 دليل البائع Smart Swika</h3>
            <p style="color:var(--text-muted);line-height:1.7;margin:0;">
                منذ <strong>19 نوفمبر 2026</strong>، يُخزَّن كل مخزون البائع في مستودع Smart Swika.
                يتولى Livo استلام الطرود من المستودع وتوصيلها إلى المشترين.
                لا تتولى أنت الشحن ولا النقل ولا التسليم المباشر.
            </p>
        </div>

        <div ${card}>
            <h3 class="v-card-title">1. النموذج في 3 خطوات</h3>
            <ol ${list}>
                <li><strong>انشر منتجاتك</strong> (السعر، المخزون الحقيقي، الصور).</li>
                <li><strong>أرسل المخزون إلى المستودع</strong>: إيداع مباشر أو استلام منظَّم مع الفريق.</li>
                <li><strong>Smart Swika تخزّن وتجهّز</strong>؛ وLivo يوصل إلى المشتري في كل المغرب.</li>
            </ol>
        </div>

        <div ${card}>
            <h3 class="v-card-title">2. الحساب والعقد</h3>
            <ul ${list}>
                <li>التسجيل عبر <strong>تسجيل البائع</strong>: اسم المتجر، الهاتف، المدينة، ICE أو CIN.</li>
                <li>قراءة <strong>عقد الشراكة وتوقيعه</strong> إلزاميان؛ التوقيع مؤرخ ومرتبط ببصمة النص.</li>
                <li>يجب <strong>موافقة الإدارة</strong> على الحساب قبل النشر.</li>
                <li>إذا تغيّر العقد تظهر لافتة <strong>إعادة التوقيع</strong>: وقّع النسخة الجديدة لمواصلة البيع.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">3. نشر منتج</h3>
            <p style="margin:0 0 .4rem;">تبويب <strong>منتجاتي</strong> ← <strong>منتج جديد</strong>:</p>
            <ul ${list}>
                <li>الاسم بالفرنسية (العربية والإنجليزية مستحسن)، الفئة والفئة الفرعية.</li>
                <li>سعر البيع و<strong>سعر كولشي</strong> الأقل منه بشكل صارم.</li>
                <li><strong>المخزون الحقيقي</strong> المتوفر في المستودع.</li>
                <li>صورة واحدة على الأقل (JPEG أو PNG أو WebP، 2 ميغا كحد أقصى).</li>
                <li>الوصف والخصائص. المتغيرات (المقاس، اللون) عبر <strong>إنشاء المتغيرات</strong>.</li>
            </ul>
            <p style="margin:.6rem 0 0;color:var(--text-muted);">كل إنشاء أو تعديل يعود إلى <strong>مراجعة الإدارة</strong> قبل النشر.</p>
        </div>

        <div ${card}>
            <h3 class="v-card-title">4. إرسال المخزون إلى المستودع</h3>
            <ul ${list}>
                <li><strong>وضع المستودع إلزامي</strong>: الشحن المباشر من البائع لم يعد موجودًا.</li>
                <li><strong>إيداع مباشر</strong> في العنوان المعروض في بطاقة المنتج، أو</li>
                <li><strong>استلام</strong>: تبويب <strong>المخزون</strong> ← <strong>طلب جديد</strong> (سطر لكل متغير مقاس/لون مع الكمية). توافق الإدارة بعد الاستلام، ثم تُنشأ <strong>ملصقات SKU مع رمز شريطي</strong>؛ اطبع ملصقًا لكل وحدة وألصقه على كل منتج.</li>
                <li>يجب أن يطابق المخزون المعروض المخزون المُسلَّم. أي اختلاف قد يوقف المنتج.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">5. الطلبات والحالات</h3>
            <ul ${list}>
                <li><strong>قيد الانتظار</strong> ← <strong>مؤكَّد</strong>: إنشاء الطلب ثم تأكيده (الدفع عند الاستلام).</li>
                <li><strong>قيد التجهيز</strong> ← <strong>جاهز</strong>: تجهيز الطرد في المستودع.</li>
                <li><strong>طلب استلام</strong> ← <strong>تم استلام الطرد</strong>: Livo يستلم الطرد من المستودع.</li>
                <li><strong>قيد التوصيل</strong> ← <strong>تم التوصيل</strong>: استلم المشتري الطرد.</li>
                <li><strong>مُرجَع / ملغى</strong>: يُعاد المخزون حسب قواعد العقد.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">6. المحفظة والسحب والعروض السريعة</h3>
            <ul ${list}>
                <li>تظهر الأرباح في <strong>محفظتي</strong> بعد تأكيد التوصيل.</li>
                <li>العمولة هي المذكورة في عقدك (النسبة معروضة في لوحة التحكم).</li>
                <li>يُطلب السحب من المحفظة؛ تتولى الإدارة معالجته وتُعلمك.</li>
                <li><strong>العروض السريعة</strong>: خصم مؤقت تنشئه أنت، يُنشر مباشرة دون مراجعة الإدارة. لا يُجمع مع سعر كولشي.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">7. القواعد والدعم</h3>
            <ul ${list}>
                <li>لا مخزون وهمي، لا تقليد، ولا وصف مضلل.</li>
                <li>احترم آجال العقد؛ الإرجاعات المتكررة قد تؤدي إلى توقيف الحساب.</li>
                <li>الدعم: واتساب <strong>+212 656 613 303</strong> · <strong>smartswi9a@gmail.com</strong> (اذكر المتجر أو المنتج أو الطلب).</li>
            </ul>
        </div>
    </div>`;
}

/* Guide vendeur en anglais. Meme structure que la version FR. */
function guideEnHtml() {
    const card = 'class="v-card" style="margin-top:1rem;"';
    const list = 'style="line-height:1.75;padding-left:1.2rem;margin:0;"';
    return `<div dir="ltr" style="text-align:left;">
        <div class="v-card">
            <h3 class="v-card-title">📘 Smart Swika vendor guide</h3>
            <p style="color:var(--text-muted);line-height:1.7;margin:0;">
                Since <strong>19 November 2026</strong>, all vendor stock is stored in the Smart Swika
                warehouse. Livo collects parcels at the warehouse and delivers them to buyers.
                You handle no shipping, carrier or hand delivery.
            </p>
        </div>

        <div ${card}>
            <h3 class="v-card-title">1. The model in 3 steps</h3>
            <ol ${list}>
                <li><strong>Publish your products</strong> (price, real stock, photos).</li>
                <li><strong>Send your stock to the warehouse</strong>: direct drop-off or pickup arranged with the team.</li>
                <li><strong>Smart Swika stores and prepares</strong>; Livo delivers to the buyer across Morocco.</li>
            </ol>
        </div>

        <div ${card}>
            <h3 class="v-card-title">2. Account and contract</h3>
            <ul ${list}>
                <li>Register on <strong>Vendor signup</strong>: shop name, phone, city, ICE or CIN.</li>
                <li>Reading and <strong>signing the partnership contract</strong> are mandatory; the signature is timestamped and linked to a text fingerprint.</li>
                <li>Your account must be <strong>approved</strong> by the administration before publishing.</li>
                <li>If the contract changes, a <strong>re-signature</strong> banner appears: sign the new version to keep selling.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">3. Publish a product</h3>
            <p style="margin:0 0 .4rem;">Tab <strong>My products</strong> → <strong>New product</strong>:</p>
            <ul ${list}>
                <li>French name (Arabic / English recommended), category and subcategory.</li>
                <li>Selling price and <strong>Koulchi price</strong> strictly lower.</li>
                <li><strong>Real stock</strong> available in the warehouse.</li>
                <li>At least one photo (JPEG, PNG or WebP, 2 MB max).</li>
                <li>Description and features. Variants (size, colour) via <strong>Create variants</strong>.</li>
            </ul>
            <p style="margin:.6rem 0 0;color:var(--text-muted);">Every creation or change goes back to <strong>admin review</strong> before publication.</p>
        </div>

        <div ${card}>
            <h3 class="v-card-title">4. Send stock to the warehouse</h3>
            <ul ${list}>
                <li>The <strong>warehouse mode is mandatory</strong>: direct shipping by the vendor no longer exists.</li>
                <li><strong>Direct drop-off</strong> at the address shown in the product form, or</li>
                <li><strong>pickup</strong>: tab <strong>Stock</strong> → <strong>New request</strong> (one line per size/colour variant, with quantity). Admin approves after receipt; <strong>SKU labels with barcode</strong> are generated. Print one per unit and stick it on each product.</li>
                <li>Online stock must match the stock handed over. A mismatch may suspend the product.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">5. Orders and statuses</h3>
            <ul ${list}>
                <li><strong>Pending</strong> → <strong>Confirmed</strong>: order created then validated (cash on delivery).</li>
                <li><strong>Preparing</strong> → <strong>Ready</strong>: parcel prepared at the warehouse.</li>
                <li><strong>Pickup requested</strong> → <strong>Parcel collected</strong>: Livo takes the parcel at the warehouse.</li>
                <li><strong>In transit</strong> → <strong>Delivered</strong>: the buyer received the parcel.</li>
                <li><strong>Returned / Cancelled</strong>: stock restored according to the contract.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">6. Wallet, withdrawals and flash sales</h3>
            <ul ${list}>
                <li>Earnings appear in <strong>My Wallet</strong> after delivery confirmation.</li>
                <li>The commission is the one stated in your contract (rate shown on the dashboard).</li>
                <li>Request a withdrawal from the Wallet; the administration processes it and notifies you.</li>
                <li><strong>Flash sales</strong>: temporary discount you create, published directly without admin approval. Not combined with the Koulchi price.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">7. Rules and support</h3>
            <ul ${list}>
                <li>No fake stock, no counterfeits, no misleading descriptions.</li>
                <li>Respect the contract deadlines; repeated returns may lead to suspension.</li>
                <li>Support: WhatsApp <strong>+212 656 613 303</strong> · <strong>smartswi9a@gmail.com</strong> (include shop, product or order).</li>
            </ul>
        </div>
    </div>`;
}

/* ============================================================
   KOULCHI DIALK — TEXTES (FR / AR / EN)
   Koulchi est automatique : cet onglet informe et pilote, il ne
   cree pas d offre.
   ============================================================ */
const KOULCHI_I18N = {
    fr: {
        title: '🤝 Koulchi dialk — pilotage',
        intro: 'Koulchi dialk est automatique : dès 3 articles dans le panier, la remise s\'applique au total. Vous ne créez pas d\'offre ; vous fixez le prix Koulchi de chaque produit.',
        rules: ['3 à 10 articles par panier.', '−5 % de 3 à 5 articles, −10 % de 6 à 8, −15 % de 9 à 10.', 'Non cumulable avec une vente flash.', 'Prix Koulchi obligatoire et strictement inférieur au prix de vente.'],
        statsTitle: 'Vos statistiques Koulchi',
        statOrders: 'Commandes groupées', statArticles: 'Articles vendus', statDiscount: 'Remise accordée', statRevenue: 'CA groupé (avant commission)',
        tableTitle: 'Vos produits et prix Koulchi',
        product: 'Produit', price: 'Prix normal', koulchi: 'Prix Koulchi', off: 'Remise', status: 'Statut', action: 'Action',
        edit: 'Modifier', ok: 'Conforme', fix: 'À corriger', invalid: 'Prix invalide',
        empty: 'Aucun produit pour le moment.', noStats: 'Aucune commande groupée pour le moment.',
        note: 'Statistiques calculées sur vos 500 dernières commandes. CA avant commission Smart Swika.',
        open: 'Voir la page Koulchi'
    },
    ar: {
        title: '🤝 كولشي ديالك — لوحة التحكم',
        intro: 'كولشي ديالك تلقائي: من 3 منتجات في السلة يُطبَّق الخصم على المجموع. أنت لا تنشئ عرضًا؛ بل تحدد سعر كولشي لكل منتج.',
        rules: ['من 3 إلى 10 منتجات في السلة.', 'خصم 5% من 3 إلى 5 منتجات، 10% من 6 إلى 8، 15% من 9 إلى 10.', 'لا يُجمع مع عرض سريع.', 'سعر كولشي إلزامي وأقل بشكل صارم من سعر البيع.'],
        statsTitle: 'إحصائيات كولشي',
        statOrders: 'طلبات جماعية', statArticles: 'منتجات مبيعة', statDiscount: 'الخصم الممنوح', statRevenue: 'رقم المعاملات (قبل العمولة)',
        tableTitle: 'منتجاتك وأسعار كولشي',
        product: 'المنتج', price: 'السعر العادي', koulchi: 'سعر كولشي', off: 'الخصم', status: 'الحالة', action: 'إجراء',
        edit: 'تعديل', ok: 'مطابق', fix: 'يجب التصحيح', invalid: 'سعر غير صالح',
        empty: 'لا يوجد منتج حالياً.', noStats: 'لا يوجد طلب جماعي حالياً.',
        note: 'الإحصائيات محسوبة على آخر 500 طلب. رقم المعاملات قبل عمولة Smart Swika.',
        open: 'صفحة كولشي'
    },
    en: {
        title: '🤝 Koulchi dialk — control panel',
        intro: 'Koulchi dialk is automatic: from 3 items in the cart, the discount applies to the total. You do not create an offer; you set each product\'s Koulchi price.',
        rules: ['3 to 10 items per cart.', '5% off for 3 to 5 items, 10% for 6 to 8, 15% for 9 to 10.', 'Not combined with a flash sale.', 'Koulchi price is mandatory and strictly lower than the selling price.'],
        statsTitle: 'Your Koulchi statistics',
        statOrders: 'Grouped orders', statArticles: 'Items sold', statDiscount: 'Discount granted', statRevenue: 'Grouped revenue (before commission)',
        tableTitle: 'Your products and Koulchi prices',
        product: 'Product', price: 'Normal price', koulchi: 'Koulchi price', off: 'Discount', status: 'Status', action: 'Action',
        edit: 'Edit', ok: 'Compliant', fix: 'To fix', invalid: 'Invalid price',
        empty: 'No product yet.', noStats: 'No grouped order yet.',
        note: 'Statistics based on your last 500 orders. Revenue before Smart Swika commission.',
        open: 'Open Koulchi page'
    }
};

async function renderKoulchi(container) {
    const lang = getCurrentLanguage();
    const L = KOULCHI_I18N[lang] || KOULCHI_I18N.fr;
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    const align = lang === 'ar' ? 'right' : 'left';

    if (!cachedProducts.length) await loadVendorProducts();

    const rows = (cachedProducts || []).map(p => {
        const price = Number(p.price) || 0;
        const kp = Number(p.koulchiPrice) || 0;
        const valid = price > 0 && kp > 0 && kp < price;
        const pct = valid ? Math.round((1 - kp / price) * 100) : null;
        const status = valid ? L.ok : (kp > 0 ? L.fix : L.invalid);
        const color = valid ? 'var(--success)' : 'var(--danger)';
        return `<tr>
            <td style="padding:.45rem;">${escapeHTML(p.nameFr || p.nameEn || '—')}</td>
            <td style="padding:.45rem;">${price} MAD</td>
            <td style="padding:.45rem;">${kp > 0 ? kp + ' MAD' : '—'}</td>
            <td style="padding:.45rem;">${pct != null ? '−' + pct + ' %' : '—'}</td>
            <td style="padding:.45rem;color:${color};font-weight:700;">${status}</td>
            <td style="padding:.45rem;"><button type="button" class="v-btn v-btn-secondary" style="font-size:.75rem;padding:.25rem .6rem;" data-koulchi-edit="${escapeHTML(p.id)}">${L.edit}</button></td>
        </tr>`;
    }).join('');

    container.innerHTML = `<div dir="${dir}" style="text-align:${align};">
        <div class="v-card">
            <h3 class="v-card-title">${L.title}</h3>
            <p style="color:var(--text-muted);line-height:1.7;margin:0 0 .5rem;">${L.intro}</p>
            <ul style="line-height:1.75;padding-${lang === 'ar' ? 'right' : 'left'}:1.2rem;margin:0;">
                ${L.rules.map(r => '<li>' + r + '</li>').join('')}
            </ul>
            <p style="margin:.6rem 0 0;"><a href="/koulchi.html" target="_blank" rel="noopener">${L.open}</a></p>
        </div>

        <div class="v-card" style="margin-top:1rem;">
            <h3 class="v-card-title">${L.statsTitle}</h3>
            <div id="vendorKoulchiStats" style="color:var(--text-muted);">${L.noStats}</div>
        </div>

        <div class="v-card" style="margin-top:1rem;overflow-x:auto;">
            <h3 class="v-card-title">${L.tableTitle}</h3>
            <table style="width:100%;border-collapse:collapse;font-size:.85rem;">
                <thead><tr>
                    <th style="text-align:${align};padding:.4rem;border-bottom:1px solid var(--border);">${L.product}</th>
                    <th style="text-align:${align};padding:.4rem;border-bottom:1px solid var(--border);">${L.price}</th>
                    <th style="text-align:${align};padding:.4rem;border-bottom:1px solid var(--border);">${L.koulchi}</th>
                    <th style="text-align:${align};padding:.4rem;border-bottom:1px solid var(--border);">${L.off}</th>
                    <th style="text-align:${align};padding:.4rem;border-bottom:1px solid var(--border);">${L.status}</th>
                    <th style="text-align:${align};padding:.4rem;border-bottom:1px solid var(--border);">${L.action}</th>
                </tr></thead>
                <tbody>${rows || `<tr><td colspan="6" style="padding:.6rem;">${L.empty}</td></tr>`}</tbody>
            </table>
            <p style="color:var(--text-muted);font-size:.78rem;margin:.6rem 0 0;">${L.note}</p>
        </div>
    </div>`;

    container.querySelectorAll('[data-koulchi-edit]').forEach(btn => {
        btn.addEventListener('click', () => {
            const product = (cachedProducts || []).find(p => p.id === btn.dataset.koulchiEdit);
            if (product) openProductModal(product);
        });
    });

    try {
        const snap = await getDocs(query(
            collection(db, 'vendor_orders', currentUserUid, 'orders'),
            where('privacySafe', '==', true),
            limit(500)
        ));
        let kOrders = 0, articles = 0, discount = 0, revenue = 0;
        snap.forEach(d => {
            const o = d.data() || {};
            const items = Array.isArray(o.items) ? o.items : [];
            const kItems = items.filter(i => i && i.mode === 'koulchi' && (Number(i.quantity) || 0) > 0);
            if (!kItems.length) return;
            kOrders++;
            kItems.forEach(i => {
                const q = Number(i.quantity) || 0;
                const price = Number(i.price) || 0;
                const base = Number(i.basePrice) || price;
                articles += q;
                revenue += price * q;
                discount += Math.max(0, base - price) * q;
            });
            discount += Number(o.koulchiDiscount) || 0;
        });

        const el = document.getElementById('vendorKoulchiStats');
        if (el) {
            if (kOrders === 0) {
                el.textContent = L.noStats;
            } else {
                const card = (label, value) => `<div class="v-card" style="padding:.9rem;text-align:center;"><div style="font-size:1.35rem;font-weight:800;color:var(--gold);">${value}</div><div style="font-size:.78rem;color:var(--text-muted);">${label}</div></div>`;
                el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.6rem;">
                    ${card(L.statOrders, kOrders)}
                    ${card(L.statArticles, articles)}
                    ${card(L.statDiscount, discount + ' MAD')}
                    ${card(L.statRevenue, revenue + ' MAD')}
                </div>`;
            }
        }
    } catch (e) {
        console.warn('[vendor-dashboard] stats Koulchi :', e);
        const el = document.getElementById('vendorKoulchiStats');
        if (el) el.textContent = '—';
    }
}

/* ============================================================
   GUIDE VENDEUR (onglet Guide)
   Manuel du modele en vigueur depuis le 2026-11-19 : stock a
   l entrepot Smart Swika, Livo livre aux acheteurs.
   Contenu statique, aucune lecture Firestore.
   ============================================================ */
async function renderGuide(container) {
    const lang = getCurrentLanguage();
    const settingsHtml = await renderContractSection();
    const shop = currentVendor?.vendorInfo || {};

    const status = getVendorStatus();
    const statusLabel = status === VENDOR_STATUS.APPROVED
        ? tr('vendor.shop.status.approved', 'Approuvé')
        : status === VENDOR_STATUS.REJECTED
            ? tr('vendor.shop.status.rejected', 'Rejeté')
            : status === VENDOR_STATUS.SUSPENDED
                ? tr('vendor.shop.status.suspended', 'Suspendu')
                : tr('vendor.shop.status.pending', 'En attente');
    const contractLabel = getContractStatus() === CONTRACT_STATUS.ACCEPTED
        ? tr('vendor.contract.statusUpToDate', '✅ Contrat à jour')
        : tr('vendor.contract.statusMissing', '❌ Aucun contrat signé');
    const shippingLabel = shop.shippingMethod === 'fulfillment'
        ? tr('vendor.shipping.fulfillment', 'Mode logistique : Entrepôt Smart Swika')
        : tr('vendor.shipping.unset', 'Mode logistique : à configurer');

    const shopCard = `
        <div class="v-card">
            <h3 class="v-card-title">${escapeHTML(vt('settingsShopTitle', 'Boutique & contrat'))}</h3>
            <div class="v-settings-grid">
                <div><span class="v-kpi-sub">${escapeHTML(vt('settingsShopName', 'Nom de la boutique'))}</span><strong>${escapeHTML(shop.shopName || currentVendor?.name || '—')}</strong></div>
                <div><span class="v-kpi-sub">${escapeHTML(vt('settingsStatus', 'Statut du compte'))}</span><strong>${escapeHTML(statusLabel)}</strong></div>
                <div><span class="v-kpi-sub">${escapeHTML(vt('settingsShipping', 'Mode logistique'))}</span><strong>${escapeHTML(shippingLabel)}</strong></div>
                <div><span class="v-kpi-sub">${escapeHTML(vt('settingsContract', 'Contrat vendeur'))}</span><strong>${escapeHTML(contractLabel)}</strong></div>
            </div>
        </div>`;

    let guideHtml;
    if (lang === 'ar') guideHtml = guideArHtml();
    else if (lang === 'en') guideHtml = guideEnHtml();
    else {
    const card = 'class="v-card" style="margin-top:1rem;"';
    const list = 'style="line-height:1.75;padding-left:1.2rem;margin:0;"';
    guideHtml = `<div dir="ltr" style="text-align:left;">
        <div class="v-card">
            <h3 class="v-card-title">📘 Guide vendeur Smart Swika</h3>
            <p style="color:var(--text-muted);line-height:1.7;margin:0;">
                Depuis le <strong>19 novembre 2026</strong>, tout le stock vendeur est stocké à
                l'entrepôt Smart Swika. Livo récupère les colis à l'entrepôt et les livre aux
                acheteurs. Vous ne gérez ni expédition, ni transporteur, ni remise en main propre.
            </p>
        </div>

        <div ${card}>
            <h3 class="v-card-title">1. Le modèle en 3 étapes</h3>
            <ol ${list}>
                <li><strong>Publiez vos produits</strong> (prix, stock réel, photos).</li>
                <li><strong>Envoyez le stock à l'entrepôt</strong> : dépôt direct ou ramassage organisé avec l'équipe.</li>
                <li><strong>Smart Swika stocke et prépare</strong> ; Livo livre l'acheteur partout au Maroc.</li>
            </ol>
        </div>

        <div ${card}>
            <h3 class="v-card-title">2. Compte et contrat</h3>
            <ul ${list}>
                <li>Inscription sur <strong>Inscription vendeur</strong> : boutique, téléphone, ville, ICE ou CIN.</li>
                <li>Lecture et <strong>signature du contrat</strong> obligatoires ; la signature est horodatée et associée à une empreinte du texte.</li>
                <li>Le compte doit être <strong>approuvé</strong> par l'administration avant publication.</li>
                <li>Si le contrat change, une bannière de <strong>re-signature</strong> apparaît : signez pour continuer à vendre.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">3. Publier un produit</h3>
            <p style="margin:0 0 .4rem;">Onglet <strong>Mes produits</strong> → <strong>Nouveau produit</strong> :</p>
            <ul ${list}>
                <li>Nom en français (arabe / anglais recommandés), catégorie et sous-catégorie.</li>
                <li>Prix de vente et <strong>prix Koulchi</strong> strictement inférieur.</li>
                <li><strong>Stock réel</strong> disponible à l'entrepôt.</li>
                <li>Au moins une photo (JPEG, PNG ou WebP, 2 Mo max).</li>
                <li>Description et caractéristiques. Variantes (taille, couleur) via <strong>Créer les variantes</strong>.</li>
            </ul>
            <p style="margin:.6rem 0 0;color:var(--text-muted);">Toute création ou modification repasse en <strong>validation admin</strong> avant publication.</p>
        </div>

        <div ${card}>
            <h3 class="v-card-title">4. Envoyer le stock à l'entrepôt</h3>
            <ul ${list}>
                <li>Le <strong>mode entrepôt est obligatoire</strong> : l'expédition directe par le vendeur n'existe plus.</li>
                <li><strong>Dépôt direct</strong> à l'adresse affichée dans la fiche produit, ou</li>
                <li><strong>ramassage</strong> : onglet <strong>Stock</strong> → <strong>Nouvelle demande</strong> (une ligne par variante taille/couleur, avec quantité). L'admin approuve après réception ; des <strong>étiquettes SKU avec code-barres</strong> sont alors générées. Imprimez-en une par unité et collez-la sur chaque produit.</li>
                <li>Le stock en ligne doit correspondre au stock remis. Un écart peut suspendre le produit.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">5. Commandes et statuts</h3>
            <ul ${list}>
                <li><strong>En attente</strong> → <strong>Confirmée</strong> : commande créée puis validée (paiement à la livraison).</li>
                <li><strong>En préparation</strong> → <strong>Prête</strong> : colis préparé à l'entrepôt.</li>
                <li><strong>Ramassage demandé</strong> → <strong>Colis récupéré</strong> : Livo prend le colis à l'entrepôt.</li>
                <li><strong>En livraison</strong> → <strong>Livrée</strong> : l'acheteur a reçu le colis.</li>
                <li><strong>Retournée / Annulée</strong> : stock restitué selon les règles du contrat.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">6. Wallet, retraits et ventes flash</h3>
            <ul ${list}>
                <li>Les gains apparaissent dans <strong>Mon Wallet</strong> après confirmation de livraison.</li>
                <li>La commission est celle indiquée dans votre contrat (taux affiché sur le dashboard).</li>
                <li>Le retrait se demande depuis le Wallet ; l'administration le traite et vous notifie.</li>
                <li><strong>Ventes Flash</strong> : remise temporaire créée par vous, publiée directement sans validation admin. Ne se cumule pas avec le prix Koulchi.</li>
            </ul>
        </div>

        <div ${card}>
            <h3 class="v-card-title">7. Règles et support</h3>
            <ul ${list}>
                <li>Jamais de stock fictif, de contrefaçon ni de description trompeuse.</li>
                <li>Respectez les délais du contrat ; les retours répétés peuvent entraîner une suspension.</li>
                <li>Support : WhatsApp <strong>+212 656 613 303</strong> · <strong>smartswi9a@gmail.com</strong> (précisez boutique, produit ou commande).</li>
            </ul>
        </div>
    </div>`;
    }

    container.innerHTML = `${shopCard}${settingsHtml}<div id="vVendorGuideContent">${guideHtml}</div>`;

    document.getElementById('vSignContractBtn')?.addEventListener('click', () => openContractModal(true));
    document.getElementById('vViewContractBtn')?.addEventListener('click', handleViewContract);
    document.getElementById('vPrintContractBtn')?.addEventListener('click', handlePrintContract);
    document.getElementById('vDownloadContractBtn')?.addEventListener('click', handleDownloadContract);
    document.getElementById('vVerifyContractBtn')?.addEventListener('click', handleVerifyContract);
    document.getElementById('vResignContractBtn')?.addEventListener('click', () => openContractModal(true));
}

async function renderTab(tabName) {
    const container = document.getElementById('vTabContent');
    if (!container || _renderInProgress) return;
    _renderInProgress = true;
    try {
        if (tabName === 'overview') return await renderOverview(container);
        if (tabName === 'products') return await renderProducts(container);
        if (tabName === 'orders')   return await renderOrders(container);
        if (tabName === 'wallet')   return await renderWallet(container);
        if (tabName === 'stock')    return await renderStock(container);
        if (tabName === 'koulchi')  return await renderKoulchi(container);
        if (tabName === 'guide')    return await renderGuide(container);
  /* Ventes flash vendeur : module separe (js/vendor-flash.js).
     Le vendeur cree ses propres ventes, sans validation admin, sur SES
     produits uniquement. Import dynamique pour ne pas alourdir le bundle
     initial du dashboard. */
  if (tabName === 'flash') {
    const m = await import('./vendor-flash.js');
    return await m.renderVendorFlash(container);
  }
    } catch (e) {
        console.error('[vendor-dashboard] renderTab ' + tabName + ' :', e);
        container.innerHTML = renderEmptyState('⚠️', tr('vendor.error.tab', 'Erreur de chargement'), tr('vendor.error.tabDesc', 'Veuillez réessayer.'));
    } finally {
        _renderInProgress = false;
    }
}

/* ============================================================
   NAVIGATION
   ============================================================ */
const TAB_I18N_KEYS = { overview: 'vendor.page.overview', products: 'vendor.nav.products', orders: 'vendor.nav.orders', wallet: 'vendor.nav.wallet', stock: 'vendor.nav.stock', flash: 'vendor.nav.flash', koulchi: 'vendor.nav.koulchi', guide: 'vendor.nav.guide' };
const TAB_FALLBACK_TITLES = { overview: "Vue d'ensemble", products: 'Mes produits', orders: 'Commandes', wallet: 'Mon Wallet', stock: 'Stock Fulfillment', flash: 'Ventes Flash', koulchi: 'Koulchi dialk', guide: 'Guide vendeur' };

function setActiveTab(tabName) {
    document.querySelectorAll('.v-nav-link[data-tab]').forEach(l => {
        const isActive = l.dataset.tab === tabName;
        l.classList.toggle('active', isActive);
        if (l.hasAttribute('role')) l.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    const titleEl = document.getElementById('vPageTitle');
    if (titleEl) titleEl.textContent = tr(TAB_I18N_KEYS[tabName], TAB_FALLBACK_TITLES[tabName] || tabName);
}

function closeMobileSidebar() {
    const sidebar = document.getElementById('vSidebar');
    const overlay = document.getElementById('vOverlay');
    const toggle  = document.getElementById('vMobileToggle');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function setupNavigation() {
    document.querySelectorAll('.v-nav-link[data-tab]').forEach(link => {
        link.addEventListener('click', async (e) => {
            e.preventDefault();
            const tab = link.dataset.tab;
            if (!tab) return;
            setActiveTab(tab);
            await renderTab(tab);
            if (window.matchMedia('(max-width: 1024px)').matches) closeMobileSidebar();
        });
    });
    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
        try { await logoutUser(); } catch (e) { console.warn(e); }
        window.location.href = '/';
    });
    /* Le menu tiroir mobile est gere par js/vendor-ui.js (shell moderne). */
}

/* ============================================================
   BANNIÈRES - Handlers
   ============================================================ */
function createBannerHandlers() {
    return {
        resendVerify: async () => { if (await resendVerificationEmail()) showToast(tr('vendor.banner.emailResent', 'Email renvoyé')); },
        resignContract: async () => { await openContractModal(true); }
    };
}

/* ============================================================
   MODALES - LISTENERS
   ============================================================ */
function attachModalListeners() {
    document.getElementById('closeWithdrawModal')?.addEventListener('click', closeWithdrawModal);
    document.getElementById('vWithdrawModal')?.addEventListener('click', (e) => { if (e.target.id === 'vWithdrawModal') closeWithdrawModal(); });
    document.getElementById('vWithdrawSubmitBtn')?.addEventListener('click', submitWithdrawal);
    document.getElementById('vWithdrawMethod')?.addEventListener('change', handleWithdrawMethodChange);

    document.getElementById('closeProductModal')?.addEventListener('click', closeProductModal);
    document.getElementById('vProductModal')?.addEventListener('click', (e) => { if (e.target.id === 'vProductModal') closeProductModal(); });
    document.getElementById('vProdSubmitBtn')?.addEventListener('click', submitProduct);
    document.getElementById('vProdDeliveryMode')?.addEventListener('change', updateWarehouseInfoVisibility);
    document.getElementById('vProdGenerateVariants')?.addEventListener('click', () => {
        const error = document.getElementById('vProdError');
        error.textContent = renderVendorVariantRows() ? '' : 'Réduisez le nombre de combinaisons (100 maximum).';
    });
    document.getElementById('vProdImageFile')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        const preview = document.getElementById('vProdImagePreview');
        if (!preview) return;
        if (file && file.size <= 2 * 1024 * 1024) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = document.createElement('img');
                img.src = ev.target.result;
                img.alt = '';
                img.style.cssText = 'width:80px;height:80px;object-fit:cover;border-radius:8px;';
                preview.replaceChildren(img);
            };
            reader.readAsDataURL(file);
        } else if (file) {
            preview.innerHTML = '<div style="color:var(--danger);font-size:0.8rem;">Image trop lourde (max 2 Mo).</div>';
            e.target.value = '';
        }
    });
    document.getElementById('vProdGalleryFiles')?.addEventListener('change', (e) => {
        const preview = document.getElementById('vProdGalleryPreview');
        if (!preview) return;
        preview.innerHTML = '';
        for (const file of Array.from(e.target.files || [])) {
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) continue;
            const img = document.createElement('img');
            img.alt = '';
            img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:8px;';
            const reader = new FileReader();
            reader.onload = event => { img.src = event.target.result; };
            reader.readAsDataURL(file);
            preview.appendChild(img);
        }
    });

    document.getElementById('closeContractModal')?.addEventListener('click', closeContractModal);
    document.getElementById('vContractModal')?.addEventListener('click', (e) => { if (e.target.id === 'vContractModal') closeContractModal(); });
    document.getElementById('vContractText')?.addEventListener('scroll', checkContractScroll, { passive: true });
    document.getElementById('vContractCheckbox')?.addEventListener('change', updateContractAcceptButton);
    document.getElementById('vContractAcceptBtn')?.addEventListener('click', submitContractSignature);
    document.getElementById('vContractPrintBtn')?.addEventListener('click', handlePrintContract);
    document.getElementById('vContractDownloadBtn')?.addEventListener('click', handleDownloadContract);
    document.getElementById('vContractVerifyBtn')?.addEventListener('click', handleVerifyContract);
    window.addEventListener('resize', () => {
        const modal = document.getElementById('vContractModal');
        if (modal && modal.classList.contains('open') && !_contractReadOnly) checkContractScroll();
    });
}

/* ============================================================
   ÉCRAN DE STATUT AVANT ACTIVATION
   ============================================================ */
function renderVendorAccessStatus(profile) {
    const info = profile?.vendorInfo || {};
    const status = info.status || VENDOR_STATUS.PENDING;
    const contractStatus = info.contractStatus || CONTRACT_STATUS.PENDING;
    const content = document.getElementById('vTabContent');
    const title = document.getElementById('vPageTitle');

    document.querySelectorAll('.v-nav-link[data-tab]').forEach(link => { link.hidden = true; });

    let state;
    if (status === VENDOR_STATUS.REJECTED) {
        state = {
            icon: '⚠️', label: 'DEMANDE REFUSÉE', heading: 'Votre inscription vendeur n’a pas été approuvée',
            text: 'L’administration n’a pas approuvé votre demande vendeur.',
            note: 'Veuillez contacter le support Smartswika pour obtenir plus d’informations.'
        };
    } else if (status === VENDOR_STATUS.SUSPENDED) {
        state = {
            icon: '🔒', label: 'COMPTE SUSPENDU', heading: 'Votre compte vendeur est suspendu',
            text: 'L’accès aux fonctionnalités vendeur est temporairement désactivé.',
            note: 'Veuillez contacter le support Smartswika pour obtenir de l’aide.'
        };
    } else if (contractStatus !== CONTRACT_STATUS.ACCEPTED || needsResign(info)) {
        const outdated = contractStatus === CONTRACT_STATUS.ACCEPTED && needsResign(info);
        state = {
            icon: '📝',
            label: outdated ? 'NOUVEAU CONTRAT REQUIS' : 'CONTRAT À SIGNER',
            heading: outdated ? 'Une nouvelle version du contrat doit être acceptée' : 'Finalisez votre inscription vendeur',
            text: outdated
                ? 'Votre ancien contrat reste enregistré, mais vous devez accepter la version actuelle pour retrouver les fonctionnalités vendeur.'
                : 'Pour terminer votre inscription, veuillez lire et accepter le contrat de partenariat.',
            note: status === VENDOR_STATUS.APPROVED
                ? 'Votre boutique sera réactivée dès la signature de la version actuelle.'
                : 'Après signature, votre dossier restera en attente de validation par l’administration.'
        };
    } else {
        state = {
            icon: '⏳', label: 'EN ATTENTE DE CONFIRMATION', heading: 'Votre compte vendeur est en attente de validation',
            text: 'Votre inscription et votre contrat ont bien été enregistrés. Votre dossier est en attente de confirmation par notre équipe administrative.',
            note: 'Vous pourrez accéder aux commandes, produits, stock et portefeuille dès que votre compte sera approuvé.'
        };
    }

    if (title) title.textContent = status === VENDOR_STATUS.PENDING ? 'Statut du compte vendeur' : 'Espace vendeur';
    if (!content) return;

    const showSignButton = (contractStatus !== CONTRACT_STATUS.ACCEPTED || needsResign(info))
        && status !== VENDOR_STATUS.REJECTED && status !== VENDOR_STATUS.SUSPENDED;

    content.innerHTML = `
        <section class="v-access-status" style="max-width:760px;margin:2rem auto;padding:clamp(1.25rem,4vw,2.5rem);background:var(--surface,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:20px;text-align:center;box-shadow:0 10px 35px rgba(0,0,0,.06);">
            <div aria-hidden="true" style="font-size:3rem;margin-bottom:1rem;">${state.icon}</div>
            <p style="display:inline-block;margin:0 0 1rem;padding:.4rem .8rem;border-radius:999px;background:#fff4db;color:#8a5a00;font-weight:700;">${escapeHTML(state.label)}</p>
            <h2 style="margin:.25rem 0 1rem;font-size:clamp(1.35rem,3vw,2rem);">${escapeHTML(state.heading)}</h2>
            <p style="max-width:600px;margin:0 auto 1rem;line-height:1.7;">${escapeHTML(state.text)}</p>
            <p style="max-width:600px;margin:0 auto 1.5rem;color:var(--text-muted,#666);line-height:1.7;">${escapeHTML(state.note)}</p>
            ${contractStatus === CONTRACT_STATUS.ACCEPTED ? '<p style="margin:0 auto 1.5rem;color:var(--success,#16803d);font-weight:600;">✓ Contrat accepté</p>' : ''}
            ${showSignButton ? '<button type="button" class="v-btn v-btn-primary" id="vendorStatusSignContract">Lire et signer le contrat</button>' : ''}
            <div style="margin-top:1rem;"><button type="button" class="v-btn v-btn-secondary" id="vendorStatusLogout">Se déconnecter</button></div>
        </section>`;

    document.getElementById('vendorStatusSignContract')?.addEventListener('click', () => openContractModal(true));
    document.getElementById('vendorStatusLogout')?.addEventListener('click', async () => {
        const btn = document.getElementById('vendorStatusLogout');
        if (btn) btn.disabled = true;
        try { await logoutUser(); } catch (e) { console.warn('[vendor-dashboard] Déconnexion impossible :', e); }
        window.location.href = '/';
    });
}

/* ============================================================
   INITIALISATION
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
    /* CRITIQUE : initLang() doit tourner AVANT applyLanguageDirection().
       Sans lui, <html lang> reste "fr" (valeur figée dans le HTML) et
       getCurrentLanguage() ignore la langue choisie par le vendeur :
       tout le tableau de bord restait en français même en mode AR/EN.
       initLang() lit ?lang= puis localStorage puis le navigateur, et
       écrit lang + dir sur <html>. */
    try { initLang(); } catch (e) { console.warn('[vendor-dashboard] initLang', e); }

    applyLanguageDirection();

    /* Traduit les libellés fixes du squelette (menu latéral, titre, skip link).
       Le contenu des onglets est rendu plus bas via tr(). */
    try { applyTranslations(); } catch (e) { console.warn('[vendor-dashboard] applyTranslations', e); }

    /* Titre de l onglet du navigateur. */
    try {
      const titleEl = document.querySelector('title');
      const titleKey = 'vendorDashboardPageTitle';
      const titleVal = tr(titleKey, null);
      if (titleEl && titleVal && titleVal !== titleKey) titleEl.textContent = titleVal;
    } catch (e) { /* non bloquant */ }

    /* Sélecteur de langue du tableau de bord vendeur.
       Le dashboard charge translations.js + translations-vendor.js et rend
       son contenu via tr(). Changer de langue recharge la page pour que
       TOUS les libellés (y compris ceux générés en JS) repartent dans la
       nouvelle langue, sans risque d'état incohérent. */
    const langSelect = document.getElementById('langSelect');
    if (langSelect) {
        langSelect.value = getCurrentLanguage();
        langSelect.addEventListener('change', () => {
            const next = langSelect.value;
            if (!next || !LANGUAGES.includes(next)) return;
            try { localStorage.setItem(CONFIG.STORAGE_KEYS.LANG, JSON.stringify(next)); } catch (_) { /* ignore */ }
            document.documentElement.lang = next;
            document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
            window.location.reload();
        });
    }

    if (!authBound) {
        try { initAuthListener(); } catch (e) { console.warn('[vendor-dashboard] initAuthListener déjà appelé', e); }
        authBound = true;
    }

    try { await authReadyPromise; } catch (e) { console.warn('[vendor-dashboard] authReadyPromise', e); }
    let waitedMs = 0;
    while (!isAuthReady() && waitedMs < 5000) {
        await new Promise(r => setTimeout(r, 100));
        waitedMs += 100;
    }

    const user = getCurrentUser();
    if (!user || !user.uid) {
        showToast(tr('vendor.error.authNotReady', "Session non initialisée. Redirection vers l'accueil..."), 3000);
        setTimeout(() => { window.location.href = '/'; }, 1500);
        return;
    }
    currentUserUid = user.uid;

    let loaded;
    try { loaded = await loadVendorData(user.uid); } catch (e) {
        console.error('[vendor-dashboard] Chargement vendeur échoué :', e);
        showToast(tr('vendor.error.loading', "Erreur de chargement des données."), 4000);
        return;
    }
    if (!loaded || !loaded.profile) {
        const reason = loaded?.reason || 'profile-missing';
        if (reason === 'not-vendor') {
            showToast(tr('vendor.error.notVendor', "Ce compte n'est pas un compte vendeur. Redirection..."), 4000);
        } else if (reason === 'profile-missing') {
            showToast(tr('vendor.error.profileMissing', "Profil vendeur introuvable. Contactez le support."), 5000);
        } else {
            showToast(tr('vendor.error.loading', "Erreur de chargement des données."), 4000);
        }
        setTimeout(() => { window.location.href = '/'; }, 2000);
        return;
    }

    currentVendor = loaded.profile;
    currentWallet = loaded.wallet;

    injectModals();
    attachModalListeners();
    setupNavigation();
    updateSidebarUI(currentVendor);
    renderBanners(buildBanners(currentVendor));
    attachBannerActions(createBannerHandlers());

    if (!isVendorApproved()) {
        renderVendorAccessStatus(currentVendor);
        return;
    }

    try { currentContractDoc = await loadCurrentContract(); } catch (_) { currentContractDoc = null; }
    document.querySelectorAll('.v-nav-link[data-tab]').forEach(link => { link.hidden = false; });
    updateSidebarUI(currentVendor);
    try { await refreshWarehouseState(); } catch (e) { console.warn('[vendor-dashboard] workflow entrepôt :', e); }
    setActiveTab('overview');
    await renderTab('overview');
});

console.log('[vendor-dashboard] v10.0.0 chargé (Commandes + API Retraits)');
