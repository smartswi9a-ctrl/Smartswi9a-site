// js/config.js
// ============================================================
// CONFIGURATION CENTRALISÉE - SMART SWI9A
// Version 2.3.0 — Ajout de VIDEO_BASE_URL (Cloudflare R2)
// ============================================================
// Aucun import externe. Doit être chargé en premier.
// ============================================================

// ============================================================
// URL DE BASE POUR LES VIDÉOS (Cloudflare R2)
// ============================================================
export const VIDEO_BASE_URL = "https://videos.smartswi9a.top/";

export const CONFIG = {
    // --- Firebase ---
    FIREBASE: {
        apiKey: "AIzaSyBhULwDxPBRqjywsSD_0ny41Bmt968ofSA",
        authDomain: "smartswi9a-31063.firebaseapp.com",
        projectId: "smartswi9a-31063",
        storageBucket: "smartswi9a-31063.firebasestorage.app",
        messagingSenderId: "933677210664",
        appId: "1:933677210664:web:1ee39f36dfa0806656e91d",
        measurementId: "G-4Z470ZC04B"
    },

    // --- Boutique ---
    SHOP: {
        NAME: 'Smart Swi9a',
        WHATSAPP_NUMBER: '212656613303',
        EMAIL: 'smartswi9a@gmail.com',
        URL: 'https://smartswi9a.top',
        CURRENCY: 'MAD',
        DISCOUNT_THRESHOLD: 3,
        DISCOUNT_PERCENT: 5,
        FREE_DELIVERY_THRESHOLD: 0
    },

    // --- Stockage local ---
    STORAGE_KEYS: {
        CART: 'swi9a_cart',
        THEME: 'swi9a_theme',
        LANG: 'swi9a_lang',
        USER: 'swi9a_user',
        ABANDONED_CART: 'swi9a_abandoned_cart',
        CITIES_CACHE: 'swi9a_cities_cache',
        COOKIE_CONSENT: 'swi9a_cookie_consent',
        SELECTED_CITY: 'swi9a_selected_city'
    },

    // --- Produits ---
    PRODUCTS: {
        PER_PAGE: 6,
        DEFAULT_RATING: 4.8,
        MAX_REVIEW_PHOTOS: 5
    },

    // --- Blog ---
    BLOG: {
        PER_PAGE: 6,
        MAX_TITLE_LENGTH: 120,
        MAX_EXCERPT_LENGTH: 250,
        MAX_CONTENT_LENGTH: 50000,
        CATEGORIES: [
            { id: 'all',         label: 'Tous',           emoji: '📚' },
            { id: 'conseils',    label: 'Conseils',       emoji: '💡' },
            { id: 'tendances',   label: 'Tendances',      emoji: '🔥' },
            { id: 'tests',       label: 'Tests & Avis',   emoji: '🧪' },
            { id: 'tutoriels',   label: 'Tutoriels',      emoji: '📖' },
            { id: 'smart-home',  label: 'Smart Home',     emoji: '🏠' },
            { id: 'gadgets',     label: 'Gadgets',        emoji: '📱' },
            { id: 'actualites',  label: 'Actualités',     emoji: '📰' }
        ]
    },

    // --- Session ---
    SESSION: {
        IDLE_TIMEOUT: 30 * 60 * 1000,          // 30 min
        ABANDONED_CART_DELAY: 30 * 60 * 1000   // 30 min
    },

    // ============================================================
    // 6 STATUTS DE COMMANDE (v2.2.0)
    // ============================================================
    ORDERS: {
        CANCELLABLE_HOURS: 4,

        STATUS: {
            PENDING:    'pending',
            CONFIRMED:  'confirmed',
            SHIPPING:   'shipping',
            DELIVERED:  'delivered',
            RETURNED:   'returned',     // ✅ v2.2.0 — Retour partiel ou total
            CANCELLED:  'cancelled'
        },

        LEGACY_STATUS: {
            VALIDATED: 'validated',
            RECEIVED:  'received'
        },

        PAYMENT: {
            UNPAID: 'unpaid',
            PAID: 'paid'
        },

        // ✅ v2.2.0 : statuts depuis lesquels un retour est possible
        RETURNABLE_FROM: ['confirmed', 'shipping', 'delivered'],

        EMAIL_ON_STATUS: {
            pending:   { client: true,  admin: true  },
            confirmed: { client: true,  admin: false },
            shipping:  { client: true,  admin: false },
            delivered: { client: true,  admin: true  },
            returned:  { client: true,  admin: true  },   // ✅ v2.2.0
            cancelled: { client: true,  admin: false }
        }
    },

    // --- Avis ---
    REVIEWS: {
        MAX_PHOTOS: 5,
        STATUS: {
            PENDING: 'pending',
            APPROVED: 'approved',
            REJECTED: 'rejected'
        }
    },

    // ============================================================
    // TYPES DE NOTIFICATIONS (in-app)
    // ============================================================
    NOTIFICATIONS: {
        TYPES: {
            ORDER_CREATED:   'order_created',
            ORDER_CONFIRMED: 'order_confirmed',
            ORDER_SHIPPING:  'order_shipping',
            ORDER_DELIVERED: 'order_delivered',
            ORDER_RETURNED:  'order_returned',      // ✅ v2.2.0
            ORDER_CANCELLED: 'order_cancelled',
            REVIEW_APPROVED: 'review_approved'
        }
    },

    // ============================================================
    // MÉTHODES D'INSCRIPTION
    // ============================================================
    SIGNUP_METHODS: {
        OTP: 'otp',
        GOOGLE: 'google',
        FACEBOOK: 'facebook'
    },

    // --- Breakpoints ---
    BREAKPOINTS: {
        MOBILE_MAX: 480,
        TABLET_MIN: 481,
        TABLET_MAX: 1024,
        DESKTOP_MIN: 1025,
        LARGE_MIN: 1441
    }
};

// ============================================================
// DEVISE par langue
// ============================================================
export const CURRENCY_SUFFIX = {
    fr: 'MAD',
    ar: 'درهم',
    en: 'MAD'
};

// ============================================================
// RÔLES
// ============================================================
export const ROLES = {
    USER: 'user',
    ADMIN: 'admin'
};

// ============================================================
// RACCOURCIS STATUTS
// ============================================================
export const ORDER_STATUS = CONFIG.ORDERS.STATUS;
export const ORDER_LEGACY_STATUS = CONFIG.ORDERS.LEGACY_STATUS;
export const PAYMENT_STATUS = CONFIG.ORDERS.PAYMENT;
export const REVIEW_STATUS = CONFIG.REVIEWS.STATUS;
export const NOTIFICATION_TYPES = CONFIG.NOTIFICATIONS.TYPES;
export const SIGNUP_METHODS = CONFIG.SIGNUP_METHODS;

// ============================================================
// Mapping ancien → nouveau statut
// ============================================================
export const STATUS_MIGRATION_MAP = {
    'validated': 'confirmed',
    'received': 'delivered'
};

// Normalise un statut (accepte ancien et nouveau)
export function normalizeOrderStatus(status) {
    if (!status) return ORDER_STATUS.PENDING;
    return STATUS_MIGRATION_MAP[status] || status;
}

// ============================================================
// ✅ v2.2.0 : HELPERS RETOUR
// ============================================================
/**
 * Vérifie si une commande peut être retournée
 */
export function canReturnOrder(order) {
    if (!order) return false;
    const status = normalizeOrderStatus(order.status);
    return CONFIG.ORDERS.RETURNABLE_FROM.includes(status);
}

/**
 * Calcule les quantités déjà retournées par produit
 * @returns {Object} { productId: quantityReturned }
 */
export function getReturnedQuantities(order) {
    const result = {};
    if (!order || !order.returns || !Array.isArray(order.returns)) return result;

    order.returns.forEach(r => {
        if (!r.productId) return;
        const pid = String(r.productId);
        result[pid] = (result[pid] || 0) + (Number(r.quantityReturned) || 0);
    });

    return result;
}

/**
 * Vérifie si un retour est total (toutes les quantités retournées)
 */
export function isFullReturn(order) {
    if (!order || !order.items) return false;
    const returned = getReturnedQuantities(order);
    return order.items.every(item => {
        const pid = String(item.productId);
        const qtyOrdered = Number(item.quantity) || 0;
        const qtyReturned = returned[pid] || 0;
        return qtyReturned >= qtyOrdered;
    });
}

// ============================================================
// LANGUES
// ============================================================
export const LANGUAGES = ['fr', 'ar', 'en'];
export const DEFAULT_LANGUAGE = 'fr';

// ============================================================
// CATÉGORIES PRODUITS
// ============================================================
export const CATEGORIES = [
    { id: 'all',         label: 'filterAll',          emoji: '🛍️' },
    { id: 'smartphone',  label: 'filterSmartphone',   emoji: '📱' },
    { id: 'smart-home',  label: 'filterSmartHome',    emoji: '🏠' },
    { id: 'audio',       label: 'filterAudio',        emoji: '🎧' },
    { id: 'chargers',    label: 'filterChargers',     emoji: '🔌' },
    { id: 'wearables',   label: 'filterWearables',    emoji: '⌚' },
    { id: 'gaming',      label: 'filterGaming',       emoji: '🎮' },
    { id: 'computer',    label: 'filterComputer',     emoji: '💻' },
    { id: 'accessories', label: 'filterAccessories',  emoji: '🎒' },
    { id: 'tools',       label: 'filterTools',        emoji: '🔧' },
    { id: 'kitchen',     label: 'filterKitchen',      emoji: '🍳' },
    { id: 'beauty',      label: 'filterBeauty',       emoji: '💄' },
    { id: 'toys',        label: 'filterToys',         emoji: '🧸' },
    { id: 'sports',      label: 'filterSports',       emoji: '⚽' },
    { id: 'auto',        label: 'filterAuto',         emoji: '🚗' },
    { id: 'pet',         label: 'filterPet',          emoji: '🐾' },
    { id: 'lighting',    label: 'filterLighting',     emoji: '💡' },
    { id: 'favorites',   label: 'filterFavorites',    emoji: '❤️' }
];

// ============================================================
// OPTIONS DE TRI
// ============================================================
export const SORT_OPTIONS = [
    { value: 'default',    label: 'sortDefault' },
    { value: 'price-asc',  label: 'sortPriceAsc' },
    { value: 'price-desc', label: 'sortPriceDesc' },
    { value: 'name-asc',   label: 'sortNameAsc' },
    { value: 'name-desc',  label: 'sortNameDesc' },
    { value: 'rating',     label: 'sortRating' }
];

// ============================================================
// LOG
// ============================================================
console.log('✅ config.js chargé — v2.3.0 (VIDEO_BASE_URL + statut RETURNED + helpers retours)');