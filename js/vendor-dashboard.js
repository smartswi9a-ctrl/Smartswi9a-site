// js/vendor-dashboard.js
// ============================================================
// LOGIQUE DU DASHBOARD VENDEUR
// Version 1.1.0 — Correctifs E7, E8, E12, E13, E14 :
//   - attente d'authReadyPromise + relecture du rôle depuis Firestore
//   - bannières d'état (welcome/verifyEmail/contractFailed, pending/rejected/suspended)
//   - statuts complets (approved/pending/rejected/suspended) + blocage
//   - onglet "products" implémenté (lecture Firestore products.vendorId)
//   - bouton "Demander un retrait" logique (bloqué si non approuvé)
//   - formatage MAD via Intl.NumberFormat + escapeHTML
//   - null-guards, i18n (fallback fr), ARIA à jour
// ============================================================

import {
    doc, getDoc, collection, query, where, getDocs, limit
} from "firebase/firestore";
import { db } from "./firebase.js";
import {
    getCurrentUser,
    logoutUser,
    getUserProfile,
    initAuthListener,
    authReadyPromise,
    resendVerificationEmail
} from "./auth.js";
import {
    CONFIG,
    ROLES,
    VENDOR_STATUS,
    CONTRACT_STATUS,
    LANGUAGES,
    DEFAULT_LANGUAGE
} from "./config.js";
import { showToast } from "./ui-core.js";

// ============================================================
// ÉTAT MODULE
// ============================================================
let currentVendor = null;   // profile users/{uid} complet
let currentWallet = null;   // wallets/{uid} ou null
let currentUserUid = null;
let authBound = false;

// ============================================================
// HELPERS
// ============================================================
const madFormatter = new Intl.NumberFormat('fr-MA', {
    style: 'currency',
    currency: 'MAD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

function formatMAD(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return madFormatter.format(0);
    return madFormatter.format(n);
}

function escapeHTML(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeImageUrl(url) {
    if (typeof url !== 'string') return '';
    if (/^https?:\/\//i.test(url)) return escapeHTML(url);
    return '';
}

function getCurrentLanguage() {
    const htmlLang = (document.documentElement.lang || '').toLowerCase();
    if (LANGUAGES.includes(htmlLang)) return htmlLang;
    try {
        const stored = localStorage.getItem(CONFIG.STORAGE_KEYS.LANG);
        if (stored && LANGUAGES.includes(stored)) return stored;
    } catch (_) { /* ignore */ }
    return DEFAULT_LANGUAGE;
}

function tr(key, fallback) {
    const lang = getCurrentLanguage();
    const dict = (window.translations && window.translations[lang]) || {};
    const frDict = (window.translations && window.translations[DEFAULT_LANGUAGE]) || {};
    return dict[key] || frDict[key] || fallback || key;
}

function applyLanguageDirection() {
    const lang = getCurrentLanguage();
    if (document.documentElement.lang !== lang) document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

// ============================================================
// BANNIÈRES
// ============================================================
function renderBanners(banners) {
    const container = document.getElementById('vBanners');
    if (!container) return;
    if (!banners || !banners.length) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = banners.map(b => {
        const type = ['info', 'warning', 'danger', 'success'].includes(b.type) ? b.type : 'info';
        const action = b.actionId
            ? `<button type="button" class="v-btn v-btn-secondary" data-banner-action="${escapeHTML(b.actionId)}">${escapeHTML(b.actionLabel || 'OK')}</button>`
            : '';
        return `<div class="v-banner v-banner--${type}"><span>${escapeHTML(b.text)}</span>${action}</div>`;
    }).join('');
}

function attachBannerActions(handlers) {
    const container = document.getElementById('vBanners');
    if (!container) return;
    container.querySelectorAll('[data-banner-action]').forEach(btn => {
        const id = btn.getAttribute('data-banner-action');
        const handler = handlers[id];
        if (typeof handler === 'function') {
            btn.addEventListener('click', handler);
        }
    });
}

function buildBanners(profile) {
    const banners = [];
    const params = new URLSearchParams(location.search);
    const user = getCurrentUser();
    const emailVerified = (user && user.emailVerified === true);

    const vendorInfo = profile.vendorInfo || {};
    const status = vendorInfo.status || VENDOR_STATUS.PENDING;
    const contractStatus = vendorInfo.contractStatus || CONTRACT_STATUS.PENDING;

    // --- Params URL (une seule fois — on les retire après lecture) ---
    if (params.get('welcome') === '1') {
        banners.push({
            type: 'success',
            text: tr('vendor.banner.welcome', "🎉 Bienvenue sur votre espace vendeur ! Votre compte est en cours d'examen.")
        });
    }
    if (params.get('verifyEmail') === '1' && !emailVerified) {
        banners.push({
            type: 'warning',
            text: tr('vendor.banner.verifyEmail', "📧 Vérifiez votre adresse e-mail : un lien vous a été envoyé. Cliquez sur « Renvoyer » si besoin."),
            actionId: 'resendVerify',
            actionLabel: tr('vendor.banner.resend', 'Renvoyer')
        });
    }
    if (params.get('contractFailed') === '1' && contractStatus !== CONTRACT_STATUS.ACCEPTED) {
        banners.push({
            type: 'danger',
            text: tr('vendor.banner.contractFailed', "⚠️ La signature de votre contrat a échoué. Reconnectez-vous ou contactez le support pour la finaliser.")
        });
    }
    // Nettoyer les params (évite de rejouer au reload)
    if (params.has('welcome') || params.has('verifyEmail') || params.has('contractFailed')) {
        params.delete('welcome');
        params.delete('verifyEmail');
        params.delete('contractFailed');
        const newUrl = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
        history.replaceState({}, '', newUrl);
    }

    // --- Statut vendeur ---
    if (status === VENDOR_STATUS.PENDING) {
        banners.push({
            type: 'warning',
            text: tr('vendor.banner.pending', "⏳ Votre compte est en attente d'approbation par l'administration. Certaines fonctionnalités sont limitées.")
        });
    } else if (status === VENDOR_STATUS.REJECTED) {
        banners.push({
            type: 'danger',
            text: tr('vendor.banner.rejected', "❌ Votre inscription a été refusée. Contactez le support pour plus d'informations.")
        });
    } else if (status === VENDOR_STATUS.SUSPENDED) {
        banners.push({
            type: 'danger',
            text: tr('vendor.banner.suspended', "🚫 Votre compte est suspendu. Vous ne pouvez plus vendre. Contactez le support.")
        });
    }

    // --- Wallet manquant ---
    if (!currentWallet) {
        banners.push({
            type: 'warning',
            text: tr('vendor.banner.walletMissing', "⚠️ Votre portefeuille vendeur n'est pas encore initialisé. Contactez le support.")
        });
    }

    // --- Email non vérifié (indépendant du param) ---
    if (!emailVerified && !params.get('verifyEmail')) {
        banners.push({
            type: 'warning',
            text: tr('vendor.banner.emailNotVerified', "📧 Votre e-mail n'est pas vérifié. Cliquez sur « Renvoyer » pour recevoir un nouveau lien."),
            actionId: 'resendVerify',
            actionLabel: tr('vendor.banner.resend', 'Renvoyer')
        });
    }

    return banners;
}

// ============================================================
// ÉTAT DÉRIVÉ
// ============================================================
function getVendorStatus() {
    return (currentVendor && currentVendor.vendorInfo && currentVendor.vendorInfo.status) || VENDOR_STATUS.PENDING;
}

function getContractStatus() {
    return (currentVendor && currentVendor.vendorInfo && currentVendor.vendorInfo.contractStatus) || CONTRACT_STATUS.PENDING;
}

function isVendorApproved() {
    return getVendorStatus() === VENDOR_STATUS.APPROVED
        && getContractStatus() === CONTRACT_STATUS.ACCEPTED;
}

function canRequestWithdrawal() {
    if (!isVendorApproved()) return false;
    if (!currentWallet) return false;
    const available = Number(currentWallet.availableBalance) || 0;
    return available >= CONFIG.VENDOR.MIN_WITHDRAWAL;
}

// ============================================================
// SIDEBAR / STATUT
// ============================================================
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
        [VENDOR_STATUS.APPROVED]:  { text: '✅ ' + tr('vendor.shop.status.approved',  'Approuvé'),  cls: 'approved' },
        [VENDOR_STATUS.PENDING]:   { text: '⏳ ' + tr('vendor.shop.status.pending',   'En attente'), cls: 'pending' },
        [VENDOR_STATUS.REJECTED]:  { text: '❌ ' + tr('vendor.shop.status.rejected',  'Rejeté'),     cls: 'rejected' },
        [VENDOR_STATUS.SUSPENDED]: { text: '🚫 ' + tr('vendor.shop.status.suspended', 'Suspendu'),   cls: 'suspended' }
    };
    const entry = mapping[status] || mapping[VENDOR_STATUS.PENDING];
    statusEl.textContent = entry.text;
    statusEl.className = `v-shop-status ${entry.cls}`;
    statusEl.removeAttribute('data-i18n');
}

// ============================================================
// CHARGEMENT DES DONNÉES VENDEUR
// ============================================================
async function loadVendorData(uid) {
    // Profil (source de vérité = Firestore, PAS le cache)
    let profile = null;
    try {
        const vendorDoc = await getDoc(doc(db, "users", uid));
        profile = vendorDoc.exists() ? vendorDoc.data() : null;
    } catch (e) {
        console.error('❌ Lecture users/{uid} impossible :', e);
        throw e;
    }

    if (!profile) {
        return { profile: null, wallet: null, reason: 'profile-missing' };
    }
    if (profile.role !== ROLES.VENDOR) {
        return { profile: null, wallet: null, reason: 'not-vendor' };
    }

    // Wallet (peut être absent — état récupérable, pas bloquant)
    let wallet = null;
    try {
        const walletDoc = await getDoc(doc(db, "wallets", uid));
        wallet = walletDoc.exists() ? walletDoc.data() : null;
    } catch (e) {
        console.warn('⚠️ Lecture wallets/{uid} impossible :', e);
        wallet = null;
    }

    return { profile, wallet, reason: null };
}

// ============================================================
// DONNÉES ONGLETS
// ============================================================
async function loadVendorProducts(uid) {
    // Schéma attendu : collection "products", champ "vendorId" == uid
    // (cf. E10 : isVendorProduct + getProductVendorLabelSync).
    try {
        const q = query(
            collection(db, "products"),
            where("vendorId", "==", uid),
            limit(50)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.warn('⚠️ Lecture products impossible :', e);
        return [];
    }
}

// ============================================================
// RENDU DES ONGLETS
// ============================================================
function renderEmptyState(icon, title, desc, actionHtml = '') {
    return `
        <div class="v-empty">
            <div class="v-empty-icon" aria-hidden="true">${icon}</div>
            <h3 class="v-empty-title">${escapeHTML(title)}</h3>
            <p class="v-empty-desc">${escapeHTML(desc)}</p>
            ${actionHtml}
        </div>
    `;
}

async function renderOverview(container) {
    const available = formatMAD(currentWallet && currentWallet.availableBalance);
    const pending = formatMAD(currentWallet && currentWallet.pendingBalance);
    const totalEarnings = formatMAD(currentWallet && currentWallet.totalEarnings);
    const totalWithdrawn = formatMAD(currentWallet && currentWallet.totalWithdrawn);

    container.innerHTML = `
        <div class="v-kpi-grid">
            <div class="v-kpi-card primary">
                <div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">💰</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.available', 'Solde disponible'))}</span></div>
                <p class="v-kpi-value">${available}</p>
            </div>
            <div class="v-kpi-card">
                <div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">⏳</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.pending', 'En attente'))}</span></div>
                <p class="v-kpi-value">${pending}</p>
            </div>
            <div class="v-kpi-card">
                <div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">📈</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.totalEarnings', 'Gains cumulés'))}</span></div>
                <p class="v-kpi-value">${totalEarnings}</p>
            </div>
            <div class="v-kpi-card">
                <div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">🏦</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.totalWithdrawn', 'Total retiré'))}</span></div>
                <p class="v-kpi-value">${totalWithdrawn}</p>
            </div>
        </div>
        <div class="v-card">
            <h3 class="v-card-title">👋 ${escapeHTML(tr('vendor.overview.welcomeTitle', 'Bienvenue sur votre espace'))}</h3>
            <p style="color:var(--text-muted); font-size:0.9rem;">
                ${escapeHTML(tr('vendor.overview.welcomeDesc', 'Utilisez le menu pour gérer vos produits, commandes, wallet et stock.'))}
            </p>
        </div>
    `;
}

async function renderProducts(container) {
    if (!isVendorApproved()) {
        container.innerHTML = renderEmptyState(
            '📦',
            tr('vendor.products.locked.title', 'Publication verrouillée'),
            tr('vendor.products.locked.desc', "Votre compte doit être approuvé et votre contrat signé pour publier des produits.")
        );
        return;
    }

    container.innerHTML = `<div style="text-align:center; padding:2rem;"><div class="spinner" style="margin:0 auto;"></div></div>`;
    const products = await loadVendorProducts(currentUserUid);

    if (!products.length) {
        container.innerHTML = renderEmptyState(
            '📦',
            tr('vendor.products.empty.title', 'Aucun produit'),
            tr('vendor.products.empty.desc', 'Publiez votre premier produit pour commencer à vendre.')
        );
        return;
    }

    const cards = products.map(p => {
        const image = safeImageUrl(p.imageUrl || p.image || p.photo);
        const name = escapeHTML(p.name || '—');
        const price = formatMAD(p.price);
        const status = escapeHTML(p.status || 'pending');
        return `
            <div class="v-card v-product-card">
                ${image ? `<img src="${image}" alt="${name}" loading="lazy" style="width:80px;height:80px;object-fit:cover;border-radius:8px;">` : `<div style="width:80px;height:80px;background:#eee;border-radius:8px;"></div>`}
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name}</div>
                    <div style="color:var(--text-muted); font-size:0.9rem;">${price}</div>
                    <div style="font-size:0.8rem;">${escapeHTML(tr('vendor.products.status.' + status, status))}</div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = `<div class="v-product-list" style="display:flex; flex-direction:column; gap:12px;">${cards}</div>`;
}

async function renderOrders(container) {
    // TODO (schéma Firestore à confirmer) : lire les commandes du vendeur.
    // Champ attendu par E10/E13 : au minimum vendorId sur les items ou une
    // sous-collection par vendeur. Tant que la structure n'est pas validée,
    // on affiche un état vide explicite pour ne pas casser la page.
    container.innerHTML = renderEmptyState(
        '📋',
        tr('vendor.orders.empty.title', 'Aucune commande pour le moment'),
        tr('vendor.orders.empty.desc', 'Vos commandes apparaîtront ici dès que vos produits seront vendus.')
    );
}

async function renderWallet(container) {
    const available = formatMAD(currentWallet && currentWallet.availableBalance);
    const pending = formatMAD(currentWallet && currentWallet.pendingBalance);
    const minWithdrawal = formatMAD(CONFIG.VENDOR.MIN_WITHDRAWAL);
    const canWithdraw = canRequestWithdrawal();
    const disabledAttr = canWithdraw ? '' : 'disabled';
    const reason = !isVendorApproved()
        ? tr('vendor.wallet.withdrawLockedNotApproved', "Compte non approuvé : retrait verrouillé.")
        : (currentWallet && Number(currentWallet.availableBalance) < CONFIG.VENDOR.MIN_WITHDRAWAL)
            ? tr('vendor.wallet.withdrawLockedMin', "Solde insuffisant (minimum : {min}).").replace('{min}', minWithdrawal)
            : '';

    container.innerHTML = `
        <div class="v-wallet-hero">
            <div class="v-wallet-label">${escapeHTML(tr('vendor.wallet.available', 'Solde disponible'))}</div>
            <div class="v-wallet-amount">${available}</div>
            <div style="margin-top:0.5rem; color:var(--text-muted); font-size:0.9rem;">
                ${escapeHTML(tr('vendor.wallet.pending', 'En attente'))} : ${pending}
            </div>
            <button type="button" id="btnRequestWithdrawal" class="v-btn v-btn-secondary" style="margin-top:1rem;" ${disabledAttr}>
                💸 ${escapeHTML(tr('vendor.wallet.requestWithdrawal', 'Demander un retrait'))}
            </button>
            ${reason ? `<div style="margin-top:0.5rem; color:var(--text-muted); font-size:0.85rem;">${escapeHTML(reason)}</div>` : ''}
        </div>
        <div class="v-card">
            <h3 class="v-card-title">${escapeHTML(tr('vendor.wallet.infoTitle', 'Informations'))}</h3>
            <p style="color:var(--text-muted); font-size:0.9rem;">
                ${escapeHTML(tr('vendor.wallet.infoDesc', 'Retrait minimum : 200 MAD. Traitement sous 3 jours ouvrés.'))}
            </p>
        </div>
    `;

    const btn = document.getElementById('btnRequestWithdrawal');
    if (btn && canWithdraw) {
        btn.addEventListener('click', () => {
            // TODO (étape dédiée) : ouvrir la modale de retrait avec le schéma
            // Firestore `withdrawal_requests`. En attendant :
            showToast(tr('vendor.wallet.comingSoon', "Fonctionnalité de retrait bientôt disponible. Contactez le support pour un retrait manuel."));
        });
    }
}

async function renderStock(container) {
    // TODO (schéma Firestore à confirmer) : lire les lots fulfillment du vendeur.
    // La collection n'est pas encore connue (`fulfillment_batches` ?).
    container.innerHTML = renderEmptyState(
        '📥',
        tr('vendor.stock.empty.title', 'Aucun stock Fulfillment'),
        tr('vendor.stock.empty.desc', 'Envoyez vos produits chez Speedaf pour que nous gérions la livraison.')
    );
}

async function renderTab(tabName) {
    const container = document.getElementById('vTabContent');
    if (!container) return;
    try {
        if (tabName === 'overview') return await renderOverview(container);
        if (tabName === 'products') return await renderProducts(container);
        if (tabName === 'orders')   return await renderOrders(container);
        if (tabName === 'wallet')   return await renderWallet(container);
        if (tabName === 'stock')    return await renderStock(container);
    } catch (e) {
        console.error('❌ renderTab ' + tabName + ' :', e);
        container.innerHTML = renderEmptyState('⚠️', tr('vendor.error.tab', 'Erreur de chargement'), tr('vendor.error.tabDesc', 'Veuillez réessayer.'));
    }
}

// ============================================================
// NAVIGATION
// ============================================================
const TAB_I18N_KEYS = {
    overview: 'vendor.page.overview',
    products: 'vendor.nav.products',
    orders:   'vendor.nav.orders',
    wallet:   'vendor.nav.wallet',
    stock:    'vendor.nav.stock'
};

const TAB_FALLBACK_TITLES = {
    overview: "Vue d'ensemble",
    products: 'Mes produits',
    orders:   'Commandes',
    wallet:   'Mon Wallet',
    stock:    'Stock Fulfillment'
};

function setActiveTab(tabName) {
    const links = document.querySelectorAll('.v-nav-link[data-tab]');
    links.forEach(l => {
        const isActive = l.dataset.tab === tabName;
        l.classList.toggle('active', isActive);
        if (l.hasAttribute('role')) l.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    const titleEl = document.getElementById('vPageTitle');
    if (titleEl) {
        const key = TAB_I18N_KEYS[tabName];
        titleEl.textContent = tr(key, TAB_FALLBACK_TITLES[tabName] || tabName);
    }
}

function setupNavigation() {
    const links = document.querySelectorAll('.v-nav-link[data-tab]');
    links.forEach(link => {
        link.addEventListener('click', async (e) => {
            e.preventDefault();
            const tab = link.dataset.tab;
            if (!tab) return;
            setActiveTab(tab);
            await renderTab(tab);
            // Ferme la sidebar sur mobile après sélection
            if (window.matchMedia('(max-width: 1024px)').matches) closeMobileSidebar();
        });
    });

    // Déconnexion
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try { await logoutUser(); } catch (e) { console.warn(e); }
            window.location.href = '/';
        });
    }

    // Toggle mobile
    const sidebar = document.getElementById('vSidebar');
    const overlay = document.getElementById('vOverlay');
    const toggle  = document.getElementById('vMobileToggle');

    if (toggle && sidebar && overlay) {
        toggle.addEventListener('click', () => {
            const open = !sidebar.classList.contains('open');
            if (open) {
                sidebar.classList.add('open');
                overlay.classList.add('open');
                toggle.setAttribute('aria-expanded', 'true');
            } else {
                closeMobileSidebar();
            }
        });
        overlay.addEventListener('click', () => closeMobileSidebar());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeMobileSidebar();
        });
    }

    function closeMobileSidebar() {
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }
}

// ============================================================
// INITIALISATION
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    applyLanguageDirection();

    // S'assurer que le listener est branché (idempotent côté auth.js).
    if (!authBound) {
        try { initAuthListener(); } catch (e) { console.warn('initAuthListener déjà appelé ailleurs', e); }
        authBound = true;
    }

    try {
        // Attendre la restauration de la session Firebase (E7).
        await authReadyPromise;
    } catch (e) {
        console.warn('authReadyPromise en erreur', e);
    }

    const user = getCurrentUser();
    if (!user || !user.uid) {
        console.log('⛔ Non connecté — redirection vers /');
        window.location.href = '/';
        return;
    }

    currentUserUid = user.uid;

    // Relecture du profil depuis Firestore (source de vérité, E8).
    let loaded;
    try {
        loaded = await loadVendorData(user.uid);
    } catch (e) {
        console.error('❌ Chargement vendeur échoué :', e);
        showToast(tr('vendor.error.loading', "Erreur de chargement des données."));
        return;
    }

    if (!loaded || !loaded.profile) {
        console.warn('⛔ Profil vendeur introuvable ou non vendeur — redirection.');
        window.location.href = '/';
        return;
    }

    currentVendor = loaded.profile;
    currentWallet = loaded.wallet;

    // Sidebar
    updateSidebarUI(currentVendor);

    // Navigation d'abord (pour ne jamais rester sans menu si le rendu plante)
    setupNavigation();

    // Bannières d'état
    const banners = buildBanners(currentVendor);
    renderBanners(banners);
    attachBannerActions({
        resendVerify: async () => {
            const ok = await resendVerificationEmail();
            if (ok) {
                showToast(tr('vendor.banner.emailResent', '📧 Email renvoyé'));
            }
        }
    });

    // Rendu de l'onglet par défaut
    setActiveTab('overview');
    await renderTab('overview');
});