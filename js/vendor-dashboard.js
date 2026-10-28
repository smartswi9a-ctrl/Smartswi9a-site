/* ============================================================
   js/vendor-dashboard.js
   Logique du dashboard vendeur - Smart Swi9a
   Version 9.3.0 - écran dédié en attente d’approbation + accès sécurisé
   ============================================================ */

import {
    doc, getDoc, collection, query, where, getDocs, limit,
    addDoc, serverTimestamp, updateDoc, deleteDoc,
    orderBy, startAfter, Timestamp
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { db, storage } from "./firebase.js";
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
    style: 'currency', currency: 'MAD',
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
    if (/^https?:\/\//i.test(url) || url.startsWith('/')) {
        return escapeHTML(url);
    }
    return '';
}

function getCurrentLanguage() {
    const htmlLang = (document.documentElement.lang || '').toLowerCase();
    if (LANGUAGES.includes(htmlLang)) return htmlLang;

    try {
        const stored = localStorage.getItem(CONFIG.STORAGE_KEYS.LANG);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (typeof parsed === 'string' && LANGUAGES.includes(parsed)) {
                return parsed;
            }
        }
    } catch (_) {
        /* ignore */
    }

    return DEFAULT_LANGUAGE;
}

/* ============================================================
   I18N
   ============================================================ */
const MINIMAL_FALLBACKS = {
    "vendor.contract.loadFailed": {
        fr: "Impossible de charger le contrat.",
        ar: "تعذّر تحميل العقد.",
        en: "Cannot load contract."
    },
    "vendor.contract.verifyFail": {
        fr: "Intégrité non vérifiable : {reason}",
        ar: "تعذّر التحقق: {reason}",
        en: "Cannot verify: {reason}"
    },
    "vendor.contract.verifyRunning": {
        fr: "Vérification...",
        ar: "جارٍ التحقق...",
        en: "Verifying..."
    },
    "vendor.error.authNotReady": {
        fr: "Session non initialisée. Redirection vers l'accueil...",
        ar: "الجلسة غير مهيأة. إعادة التوجيه...",
        en: "Session not ready. Redirecting..."
    },
    "vendor.error.notVendor": {
        fr: "Ce compte n'est pas un compte vendeur. Redirection...",
        ar: "هذا الحساب ليس حساب بائع.",
        en: "This account is not a vendor account."
    },
    "vendor.error.profileMissing": {
        fr: "Profil vendeur introuvable. Contactez le support.",
        ar: "ملف البائع غير موجود.",
        en: "Vendor profile missing."
    },
    "vendor.error.loading": {
        fr: "Erreur de chargement des données.",
        ar: "خطأ في تحميل البيانات.",
        en: "Failed to load data."
    }
};

function tr(key, fallback) {
    const lang = getCurrentLanguage();
    const dict = (window.translations && window.translations[lang]) || {};
    const frDict = (window.translations && window.translations[DEFAULT_LANGUAGE]) || {};
    const fb = MINIMAL_FALLBACKS[key];

    return dict[key]
        || frDict[key]
        || (fb && (fb[lang] || fb[DEFAULT_LANGUAGE]))
        || fallback
        || key;
}

function trParams(key, params, fallback) {
    let value = tr(key, fallback);
    for (const p in params) {
        value = value.replace('{' + p + '}', params[p]);
    }
    return value;
}

function applyLanguageDirection() {
    const lang = getCurrentLanguage();
    if (document.documentElement.lang !== lang) {
        document.documentElement.lang = lang;
    }
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

function translateStatus(status) {
    const map = {
        pending: tr('orderStatusPending', 'En attente'),
        confirmed: tr('orderStatusConfirmed', 'Confirmée'),
        shipping: tr('orderStatusShipping', 'En livraison'),
        delivered: tr('orderStatusDelivered', 'Livrée'),
        returned: tr('orderStatusReturned', 'Retournée'),
        cancelled: tr('orderStatusCancelled', 'Annulée')
    };

    return map[status] || status;
}

function formatDate(ts) {
    if (!ts) return '—';

    try {
        if (typeof ts.toDate === 'function') {
            return ts.toDate().toLocaleDateString('fr-FR');
        }
        if (ts instanceof Date) {
            return ts.toLocaleDateString('fr-FR');
        }
    } catch (_) {
        /* ignore */
    }

    return '—';
}

/* ============================================================
   ÉTAT DÉRIVÉ
   ============================================================ */
function getVendorStatus() {
    return currentVendor?.vendorInfo?.status || VENDOR_STATUS.PENDING;
}

function getContractStatus() {
    return currentVendor?.vendorInfo?.contractStatus || CONTRACT_STATUS.PENDING;
}

function isVendorApproved() {
    return getVendorStatus() === VENDOR_STATUS.APPROVED
        && getContractStatus() === CONTRACT_STATUS.ACCEPTED;
}

function getPendingWithdrawalTotal() {
    return cachedWithdrawals
        .filter(w => w.status === 'pending')
        .reduce((sum, w) => sum + (Number(w.amount) || 0), 0);
}

function getVirtualAvailableBalance() {
    const available = Math.max(
        0,
        Number(currentWallet?.availableBalance) || 0
    );

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

        if (v && typeof v.toDate === 'function') {
            baseMs = v.toDate().getTime();
        } else if (v && typeof v.seconds === 'number') {
            baseMs = v.seconds * 1000;
        } else if (v instanceof Date) {
            baseMs = v.getTime();
        }
    } catch (_) {
        /* ignore */
    }

    if (!baseMs) {
        try {
            const v = vendorInfo.contractSignedAt;

            if (v && typeof v.toDate === 'function') {
                baseMs = v.toDate().getTime();
            } else if (v && typeof v.seconds === 'number') {
                baseMs = v.seconds * 1000;
            } else if (v instanceof Date) {
                baseMs = v.getTime();
            }
        } catch (_) {
            /* ignore */
        }
    }

    if (!baseMs && currentContractDoc?.data) {
        try {
            const v = currentContractDoc.data.acceptedAt;

            if (v && typeof v.toDate === 'function') {
                baseMs = v.toDate().getTime();
            } else if (v && typeof v.seconds === 'number') {
                baseMs = v.seconds * 1000;
            }
        } catch (_) {
            /* ignore */
        }
    }

    if (!baseMs) return null;

    return new Date(baseMs + graceDays * 24 * 3600 * 1000);
}