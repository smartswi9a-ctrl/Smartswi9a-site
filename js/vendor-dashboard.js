/* ============================================================
   js/vendor-dashboard.js
   Logique du dashboard vendeur - Smart Swi9a
   Version 10.0.0 - Gestion commandes + API Retraits
   ============================================================ */

import {
    doc, getDoc, collection, query, where, getDocs, limit,
    addDoc, serverTimestamp, updateDoc, deleteDoc,
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
    calculateVendorCommission
} from "./config.js";
import { showToast, confirmAction } from "./ui-core.js";
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
    const map = {
        'pending': tr('orderStatusPending', 'En attente'),
        'confirmed': tr('orderStatusConfirmed', 'Confirmée'),
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
function isVendorApproved() { return getVendorStatus() === VENDOR_STATUS.APPROVED && getContractStatus() === CONTRACT_STATUS.ACCEPTED; }

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
        [VENDOR_STATUS.APPROVED]:  { text: tr('vendor.shop.status.approved',  'Approuvé'),  cls: 'approved' },
        [VENDOR_STATUS.PENDING]:   { text: tr('vendor.shop.status.pending',   'En attente'), cls: 'pending' },
        [VENDOR_STATUS.REJECTED]:  { text: tr('vendor.shop.status.rejected',  'Rejeté'),     cls: 'rejected' },
        [VENDOR_STATUS.SUSPENDED]: { text: tr('vendor.shop.status.suspended', 'Suspendu'),   cls: 'suspended' }
    };
    const entry = mapping[status] || mapping[VENDOR_STATUS.PENDING];
    statusEl.textContent = entry.text;
    statusEl.className = `v-shop-status ${entry.cls}`;
    statusEl.removeAttribute('data-i18n');
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
    if (vendorStatus !== VENDOR_STATUS.APPROVED || contractStatus !== CONTRACT_STATUS.ACCEPTED) {
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
                    <label class="v-label">Montant à retirer (MAD) *</label>
                    <input type="number" id="vWithdrawAmount" class="v-input" min="${CONFIG.VENDOR.MIN_WITHDRAWAL}" step="1" placeholder="${CONFIG.VENDOR.MIN_WITHDRAWAL}">
                </div>
                <div class="v-field">
                    <label class="v-label">Méthode de réception *</label>
                    <select id="vWithdrawMethod" class="v-input"><option value="Wafacash">Wafacash</option><option value="Cash Plus">Cash Plus</option><option value="Virement bancaire">Virement bancaire</option></select>
                </div>
                <div class="v-field">
                    <label class="v-label">Téléphone / RIB de réception *</label>
                    <input type="text" id="vWithdrawAccount" class="v-input" placeholder="06XXXXXXXX ou RIB complet">
                    <span class="v-hint" id="vWithdrawHint">06XXXXXXXX pour Wafacash/Cash Plus, 24 chiffres pour RIB.</span>
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
                <div class="v-field"><label class="v-label">Nom du produit (Français) *</label><input type="text" id="vProdNameFr" class="v-input" placeholder="Ex: Montre connectée"></div>
                <div class="v-field"><label class="v-label">Nom du produit (Arabe)</label><input type="text" id="vProdNameAr" class="v-input" placeholder="ساعة ذكية"></div>
                <div class="v-field"><label class="v-label">Nom du produit (Anglais)</label><input type="text" id="vProdNameEn" class="v-input" placeholder="Smartwatch"></div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.8rem;">
                    <div class="v-field"><label class="v-label">Prix de vente (MAD) *</label><input type="number" id="vProdPrice" class="v-input" min="1" step="0.5"></div>
                    <div class="v-field"><label class="v-label">Stock initial *</label><input type="number" id="vProdStock" class="v-input" min="0" value="1"></div>
                </div>
                <div class="v-field"><label class="v-label">Description (Français)</label><textarea id="vProdDescFr" class="v-input" rows="3" placeholder="Décrivez votre produit..."></textarea></div>
                <div class="v-field">
                    <label class="v-label">Image du produit (max 2 Mo) *</label>
                    <input type="file" id="vProdImageFile" accept="image/jpeg,image/png,image/webp" class="v-input">
                    <div id="vProdImagePreview" style="margin-top:0.5rem;"></div>
                </div>
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
    document.getElementById('vWithdrawAccount').value = '';
    document.getElementById('vWithdrawAccount').placeholder = '06XXXXXXXX ou RIB complet';
    document.getElementById('vWithdrawError').textContent = '';
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('vWithdrawAmount')?.focus(), 100);
}

function closeWithdrawModal() {
    const modal = document.getElementById('vWithdrawModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
}

function handleWithdrawMethodChange() {
    const method = document.getElementById('vWithdrawMethod')?.value;
    const input = document.getElementById('vWithdrawAccount');
    const hint = document.getElementById('vWithdrawHint');
    if (!input || !hint) return;
    if (method === 'Virement bancaire') {
        input.placeholder = 'Ex: 007780000012345678901234';
        hint.textContent = 'RIB marocain (24 chiffres).';
    } else {
        input.placeholder = '06XXXXXXXX';
        hint.textContent = 'Numéro de téléphone marocain (06XXXXXXXX ou 07XXXXXXXX).';
    }
}

async function submitWithdrawal() {
    const amountEl = document.getElementById('vWithdrawAmount');
    const methodEl = document.getElementById('vWithdrawMethod');
    const accountEl = document.getElementById('vWithdrawAccount');
    const errEl = document.getElementById('vWithdrawError');
    const btn = document.getElementById('vWithdrawSubmitBtn');

    const amount = parseFloat(amountEl.value);
    const method = methodEl.value;
    const account = (accountEl.value || '').trim();
    const virtualAvailable = getVirtualAvailableBalance();

    errEl.textContent = '';

    if (getPendingWithdrawalTotal() > 0) { errEl.textContent = 'Vous avez déjà une demande en cours de traitement.'; return; }
    if (!Number.isFinite(amount) || amount < CONFIG.VENDOR.MIN_WITHDRAWAL) { errEl.textContent = `Minimum : ${CONFIG.VENDOR.MIN_WITHDRAWAL} MAD.`; return; }
    if (amount > virtualAvailable) { errEl.textContent = `Solde insuffisant (${formatMAD(virtualAvailable)} disponibles).`; return; }
    if (method === 'Virement bancaire') {
        if (!/^\d{24}$/.test(account)) { errEl.textContent = 'RIB invalide (24 chiffres attendus).'; return; }
    } else {
        if (!/^(?:\+212|0)[67]\d{8}$/.test(account)) { errEl.textContent = 'Numéro de téléphone invalide (06XXXXXXXX ou 07XXXXXXXX).'; return; }
    }

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
                account,
                vendorName: currentVendor.vendorInfo?.shopName || currentVendor.name || 'Vendeur'
            })
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) {
            throw new Error(result.message || "Erreur lors de la demande de retrait.");
        }

        showToast('Demande de retrait envoyée ! Traitement sous 3 jours ouvrés.');
        closeWithdrawModal();
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

function openProductModal(product = null) {
    const modal = document.getElementById('vProductModal');
    if (!modal) return;
    currentProductIdEditing = product ? product.id : null;

    const titleEl = document.getElementById('vProductModalTitle');
    const submitBtn = document.getElementById('vProdSubmitBtn');
    if (titleEl) titleEl.textContent = product ? 'Éditer le produit' : 'Nouveau produit';
    if (submitBtn) submitBtn.textContent = product ? 'Mettre à jour' : 'Envoyer pour validation';

    document.getElementById('vProdId').value = product ? product.id : '';
    document.getElementById('vProdNameFr').value = product ? (product.nameFr || '') : '';
    document.getElementById('vProdNameAr').value = product ? (product.nameAr || '') : '';
    document.getElementById('vProdNameEn').value = product ? (product.nameEn || '') : '';
    document.getElementById('vProdPrice').value = product ? (product.price || '') : '';
    document.getElementById('vProdStock').value = product ? (product.stock ?? '1') : '1';
    document.getElementById('vProdDescFr').value = product ? (product.descFr || '') : '';
    document.getElementById('vProdImageFile').value = '';

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
    const stock = parseInt(document.getElementById('vProdStock').value, 10);
    const descFr = (document.getElementById('vProdDescFr').value || '').trim();
    const file = document.getElementById('vProdImageFile').files[0];
    const errEl = document.getElementById('vProdError');
    const btn = document.getElementById('vProdSubmitBtn');

    errEl.textContent = '';

    if (!nameFr || nameFr.length < 2) { errEl.textContent = 'Nom (FR) requis (min 2 caractères).'; return; }
    if (!Number.isFinite(price) || price <= 0) { errEl.textContent = 'Prix invalide.'; return; }
    if (!Number.isFinite(stock) || stock < 0) { errEl.textContent = 'Stock invalide.'; return; }
    if (!currentProductIdEditing && !file) { errEl.textContent = 'Image requise.'; return; }
    if (file && file.size > 2 * 1024 * 1024) { errEl.textContent = 'Image trop lourde (max 2 Mo).'; return; }

    btn.disabled = true;
    btn.textContent = 'Upload...';

    let newImagePath = null;
    let newImageUrl = null;
    let oldImagePath = null;

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
            const storageRef = ref(storage, newImagePath);
            await uploadBytes(storageRef, file);
            newImageUrl = await getDownloadURL(storageRef);
        }

        btn.textContent = 'Enregistrement...';
        const vendorName = (currentVendor?.vendorInfo?.shopName || currentVendor?.name || 'Vendeur').slice(0, 60);

        if (currentProductIdEditing) {
            const snap = await getDoc(doc(db, "products", currentProductIdEditing));
            const oldData = snap.exists() ? snap.data() : {};
            const isStockOnly = (
                oldData.nameFr === nameFr && oldData.price === price &&
                oldData.descFr === descFr && (!file || newImageUrl === oldData.img)
            );

            if (isStockOnly) {
                await updateDoc(doc(db, "products", currentProductIdEditing), { stock, updatedAt: serverTimestamp() });
                showToast('Stock mis à jour.');
            } else {
                await updateDoc(doc(db, "products", currentProductIdEditing), {
                    nameFr, nameAr: nameAr || nameFr, nameEn: nameEn || nameFr,
                    price, basePrice: price, descFr, img: newImageUrl, stock,
                    vendorName, status: PRODUCT_STATUS.PENDING_ADMIN_APPROVAL, updatedAt: serverTimestamp()
                });
                showToast('Produit mis à jour et renvoyé pour validation.');
            }
        } else {
            const ts = Date.now();
            const slug = generateSlug(nameFr) + '-' + ts.toString(36).slice(-4);
            const productData = {
                nameFr, nameAr: nameAr || nameFr, nameEn: nameEn || nameFr, slug,
                sku: `VND-${String(ts).slice(-6)}`, category: 'all', basePrice: price, price,
                oldPrice: 0, purchasePrice: 0, stock,
                isNew: false, hasSizeGuide: false, dimensions: { weight: 0, length: 0, width: 0, height: 0 },
                variants: [], descFr: descFr || '', descAr: '', descEn: '', featuresFr: [], featuresAr: [], featuresEn: [],
                img: newImageUrl, gallery: [], vendorId: currentUserUid, vendorName,
                status: PRODUCT_STATUS.PENDING_ADMIN_APPROVAL, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
            };
            await addDoc(collection(db, "products"), productData);
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
        errEl.textContent = 'Erreur : ' + (e.message || 'inconnue');
        if (newImagePath) {
            try { await deleteObject(ref(storage, newImagePath)); } catch (_) { /* ignore */ }
        }
        btn.disabled = false;
        btn.textContent = currentProductIdEditing ? 'Mettre à jour' : 'Envoyer pour validation';
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
    const available = formatMAD(currentWallet?.availableBalance);
    const pending = formatMAD(currentWallet?.pendingBalance);
    const totalEarnings = formatMAD(currentWallet?.totalEarnings);
    const totalWithdrawn = formatMAD(currentWallet?.totalWithdrawn);
    const contractSectionHtml = await renderContractSection();

    container.innerHTML = `
        <div class="v-kpi-grid">
            <div class="v-kpi-card primary"><div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">💰</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.available', 'Solde disponible'))}</span></div><p class="v-kpi-value">${available}</p></div>
            <div class="v-kpi-card"><div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">⏳</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.pending', 'En attente'))}</span></div><p class="v-kpi-value">${pending}</p></div>
            <div class="v-kpi-card"><div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">📈</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.totalEarnings', 'Gains cumulés'))}</span></div><p class="v-kpi-value">${totalEarnings}</p></div>
            <div class="v-kpi-card"><div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">🏦</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.totalWithdrawn', 'Total retiré'))}</span></div><p class="v-kpi-value">${totalWithdrawn}</p></div>
        </div>
        <div class="v-card"><h3 class="v-card-title">${escapeHTML(tr('vendor.overview.welcomeTitle', 'Bienvenue sur votre espace'))}</h3><p style="color:var(--text-muted); font-size:0.9rem;">${escapeHTML(tr('vendor.overview.welcomeDesc', 'Utilisez le menu pour gérer vos produits, commandes, wallet et stock.'))}</p></div>
        ${contractSectionHtml}
    `;

    document.getElementById('vSignContractBtn')?.addEventListener('click', () => openContractModal(true));
    document.getElementById('vViewContractBtn')?.addEventListener('click', handleViewContract);
    document.getElementById('vPrintContractBtn')?.addEventListener('click', handlePrintContract);
    document.getElementById('vDownloadContractBtn')?.addEventListener('click', handleDownloadContract);
    document.getElementById('vVerifyContractBtn')?.addEventListener('click', handleVerifyContract);
    document.getElementById('vResignContractBtn')?.addEventListener('click', () => openContractModal(true));
}

async function renderProducts(container) {
    if (!isVendorApproved()) {
        container.innerHTML = renderEmptyState('📦', tr('vendor.products.locked.title', 'Publication verrouillée'), tr('vendor.products.locked.desc', "Votre compte doit être approuvé et votre contrat signé pour publier des produits."));
        return;
    }

    if (!cachedProducts.length) await loadVendorProducts();
    const newBtnHtml = `<div style="display:flex;justify-content:flex-end;margin-bottom:1rem;"><button type="button" id="vNewProductBtn" class="v-btn v-btn-primary">Nouveau produit</button></div>`;

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
                <div class="v-product-info"><div class="v-product-name">${name}</div><div class="v-product-meta">${price} · Stock : ${stock}</div><div style="margin-top:0.3rem;">${statusBadge}</div>${rejectionHtml}</div>
                <div class="v-product-actions">
                    <button type="button" class="v-btn v-btn-secondary" data-edit-product="${escapeHTML(p.id)}" style="padding:0.4rem 0.8rem;font-size:0.8rem;" title="Éditer">Éditer</button>
                    <button type="button" class="v-btn v-btn-secondary" data-delete-product="${escapeHTML(p.id)}" style="padding:0.4rem 0.8rem;font-size:0.8rem;" title="Supprimer">Supprimer</button>
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
}

async function renderOrders(container) {
    if (!ordersLoading && ordersLastDoc === null) {
        container.innerHTML = `<div style="text-align:center;padding:2rem;"><div class="spinner" style="margin:0 auto;"></div></div>`;
        cachedOrders = [];
    }

    if (cachedOrders.length === 0) {
        try {
            const q = query(collection(db, "orders"), where("vendorIds", "array-contains", currentUserUid), orderBy("createdAt", "desc"), limit(10));
            const snap = await getDocs(q);
            cachedOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            ordersLastDoc = snap.docs[snap.docs.length - 1] || null;
            ordersHasMore = snap.docs.length === 10;
        } catch (e) {
            console.warn('[vendor-dashboard] Lecture orders échouée :', e);
            cachedOrders = [];
        }
    }

    if (!cachedOrders.length) {
        container.innerHTML = renderEmptyState('📋', tr('vendor.orders.empty.title', 'Aucune commande pour le moment'), tr('vendor.orders.empty.desc', 'Vos commandes apparaîtront ici dès que vos produits seront vendus.'));
        return;
    }

    const rows = cachedOrders.map(o => {
        const shortId = (o.id || '').slice(0, 8).toUpperCase();
        const status = o.status || 'pending';
        const date = o.createdAt?.toDate?.()?.toLocaleDateString?.('fr-FR') || '—';
        const myItems = (o.items || []).filter(it => String(it.vendorId) === String(currentUserUid));
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
        const isMultiVendorOrder = Array.isArray(o.vendorIds) && o.vendorIds.length > 1;
        if (isMultiVendorOrder) {
            actionHtml = `<span style="font-size:0.75rem;color:var(--text-muted);">Suivi de cette commande géré par l’administration (commande multi-vendeurs).</span>`;
        } else if (status === 'pending') {
            actionHtml = `<button class="v-btn v-btn-primary" data-action="advance-order" data-id="${o.id}" data-next="confirmed" style="padding:0.3rem 0.6rem;font-size:0.75rem;">Confirmer</button>`;
        } else if (status === 'confirmed') {
            actionHtml = `<button class="v-btn v-btn-primary" data-action="advance-order" data-id="${o.id}" data-next="shipping" style="padding:0.3rem 0.6rem;font-size:0.75rem;">Expédier</button>`;
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

    container.querySelectorAll('[data-action="advance-order"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.id;
            const nextStatus = btn.dataset.next;
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
            const q = query(collection(db, "orders"), where("vendorIds", "array-contains", currentUserUid), orderBy("createdAt", "desc"), startAfter(ordersLastDoc), limit(10));
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

async function renderStock(container) {
    container.innerHTML = renderEmptyState('📥', tr('vendor.stock.empty.title', 'Aucun stock Fulfillment'), tr('vendor.stock.empty.desc', "L'envoi de stock à notre entrepôt partenaire sera disponible prochainement. Contactez le support pour plus d'informations."));
}

async function renderWallet(container) {
    if (!cachedWithdrawals.length) await loadWithdrawals();
    await loadWalletTransactions();
    const available = formatMAD(currentWallet?.availableBalance);
    const pending = formatMAD(currentWallet?.pendingBalance);
    const minWithdrawal = formatMAD(CONFIG.VENDOR.MIN_WITHDRAWAL);
    const virtualAvailable = formatMAD(getVirtualAvailableBalance());
    const hasPendingRequest = getPendingWithdrawalTotal() > 0;
    const canWithdraw = canRequestWithdrawal() && !hasPendingRequest;
    const disabledAttr = canWithdraw ? '' : 'disabled';

    let reason = '';
    if (!isVendorApproved()) reason = tr('vendor.wallet.withdrawLockedNotApproved', "Compte non approuvé : retrait verrouillé.");
    else if (hasPendingRequest) reason = "Demande de retrait en cours de traitement.";
    else if (getVirtualAvailableBalance() < CONFIG.VENDOR.MIN_WITHDRAWAL) reason = tr('vendor.wallet.withdrawLockedMin', "Solde insuffisant (minimum : {min}).").replace('{min}', minWithdrawal);

    const withdrawalRows = cachedWithdrawals.length ? cachedWithdrawals.map(w => {
        const st = w.status || 'pending';
        const statusBadge = st === 'paid' ? `<span style="background:var(--success-bg);color:var(--success);padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">${escapeHTML(tr('payout.paid', 'Payé'))}</span>`
            : st === 'rejected' ? `<span style="background:var(--danger-bg);color:var(--danger);padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">${escapeHTML(tr('payout.rejected', 'Rejeté'))}</span>`
            : st === 'cancelled' ? `<span style="background:var(--bg-surface);color:var(--text-muted);padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">${escapeHTML(tr('payout.cancelled', 'Annulé'))}</span>`
            : `<span style="background:var(--warning-bg);color:var(--warning);padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">${escapeHTML(tr('payout.pending', 'En attente'))}</span>`;
        const date = w.requestedAt?.toDate?.()?.toLocaleDateString?.('fr-FR') || '—';
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.7rem 0;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:0.5rem;"><div><strong>${formatMAD(w.amount)}</strong> · ${escapeHTML(w.method || '—')} · ${date}</div><div>${statusBadge}</div></div>`;
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
        if (Number(tx.pendingOffset) > 0) details.push(`prélevé sur attente : ${formatMAD(tx.pendingOffset)}`);
        if (Number(tx.availableOffset) > 0) details.push(`prélevé sur disponible : ${formatMAD(tx.availableOffset)}`);
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
            <div style="margin-top:0.5rem; color:var(--text-muted); font-size:0.9rem;">${escapeHTML(tr('vendor.wallet.pending', 'En attente'))} : ${pending}${hasPendingRequest ? `<br><small>Solde virtuel (après demandes en cours) : ${virtualAvailable}</small>` : ''}</div>
            <button type="button" id="btnRequestWithdrawal" class="v-btn v-btn-primary" style="margin-top:1rem;" ${disabledAttr}>${escapeHTML(tr('vendor.wallet.requestWithdrawal', 'Demander un retrait'))}</button>
            ${reason ? `<div style="margin-top:0.5rem; color:var(--text-muted); font-size:0.85rem;">${escapeHTML(reason)}</div>` : ''}
        </div>
        <div class="v-card" style="margin-top:1.5rem;"><h3 class="v-card-title">${escapeHTML(tr('vendor.wallet.historyTitle', 'Historique des retraits'))}</h3>${withdrawalRows}</div>
        <div class="v-card" style="margin-top:1.5rem;"><h3 class="v-card-title">Historique des mouvements du portefeuille</h3>${transactionRows}</div>`;

    const btn = document.getElementById('btnRequestWithdrawal');
    if (btn && canWithdraw) btn.addEventListener('click', openWithdrawModal);
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
const TAB_I18N_KEYS = { overview: 'vendor.page.overview', products: 'vendor.nav.products', orders: 'vendor.nav.orders', wallet: 'vendor.nav.wallet', stock: 'vendor.nav.stock' };
const TAB_FALLBACK_TITLES = { overview: "Vue d'ensemble", products: 'Mes produits', orders: 'Commandes', wallet: 'Mon Wallet', stock: 'Stock Fulfillment' };

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
    const sidebar = document.getElementById('vSidebar');
    const overlay = document.getElementById('vOverlay');
    const toggle  = document.getElementById('vMobileToggle');
    if (toggle && sidebar && overlay) {
        toggle.addEventListener('click', () => {
            const open = !sidebar.classList.contains('open');
            if (open) { sidebar.classList.add('open'); overlay.classList.add('open'); toggle.setAttribute('aria-expanded', 'true'); }
            else closeMobileSidebar();
        });
        overlay.addEventListener('click', () => closeMobileSidebar());
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMobileSidebar(); });
    }
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
    document.getElementById('vProdImageFile')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        const preview = document.getElementById('vProdImagePreview');
        if (!preview) return;
        if (file && file.size <= 2 * 1024 * 1024) {
            const reader = new FileReader();
            reader.onload = (ev) => { preview.innerHTML = `<img src="${ev.target.result}" alt="" style="width:80px;height:80px;object-fit:cover;border-radius:8px;">`; };
            reader.readAsDataURL(file);
        } else if (file) {
            preview.innerHTML = '<div style="color:var(--danger);font-size:0.8rem;">Image trop lourde (max 2 Mo).</div>';
            e.target.value = '';
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
            note: 'Veuillez contacter le support Smart Swi9a pour obtenir plus d’informations.'
        };
    } else if (status === VENDOR_STATUS.SUSPENDED) {
        state = {
            icon: '🔒', label: 'COMPTE SUSPENDU', heading: 'Votre compte vendeur est suspendu',
            text: 'L’accès aux fonctionnalités vendeur est temporairement désactivé.',
            note: 'Veuillez contacter le support Smart Swi9a pour obtenir de l’aide.'
        };
    } else if (contractStatus !== CONTRACT_STATUS.ACCEPTED) {
        state = {
            icon: '📝', label: 'CONTRAT À SIGNER', heading: 'Finalisez votre inscription vendeur',
            text: 'Pour terminer votre inscription, veuillez lire et accepter le contrat de partenariat.',
            note: status === VENDOR_STATUS.APPROVED
                ? 'Votre espace sera accessible après acceptation du contrat.'
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

    const showSignButton = contractStatus !== CONTRACT_STATUS.ACCEPTED
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
    applyLanguageDirection();
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
    setActiveTab('overview');
    await renderTab('overview');
});

console.log('[vendor-dashboard] v10.0.0 chargé (Commandes + API Retraits)');