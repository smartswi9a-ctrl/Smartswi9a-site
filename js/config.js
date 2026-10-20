// js/config.js
// ============================================================
// CONFIGURATION CENTRALISÉE - SMART SWI9A
// Version 3.2.0 — Helpers catégories (cohérence client/admin)
// CHANGEMENTS v3.2.0 :
// ✅ NEW — getCategoryById(), getParentCategory(), getCategoryPath(),
//          getCategoryDisplayName() (helpers centralisés)
// ✅ NEW — buildCategoryIndex() : Map id → catégorie (cache)
// ✅ Repris v3.1.0 — tCat(), LEGACY_CATEGORY_MAP, productMatchesCategory, etc.
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
        appId: "1:933677210664:web:1ee39f36dfa0806656e91d"
    },

    // --- Versioning schéma ---
    VERSION: {
        CITIES_SCHEMA: 3
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
            { id: 'all',        label: 'Tous',         emoji: '📚' },
            { id: 'conseils',   label: 'Conseils',     emoji: '💡' },
            { id: 'tendances',  label: 'Tendances',    emoji: '🔥' },
            { id: 'tests',      label: 'Tests & Avis', emoji: '🧪' },
            { id: 'tutoriels',  label: 'Tutoriels',    emoji: '📖' },
            { id: 'smart-home', label: 'Smart Home',   emoji: '🏠' },
            { id: 'gadgets',    label: 'Gadgets',      emoji: '📱' },
            { id: 'actualites', label: 'Actualités',   emoji: '📰' },
            { id: 'general',    label: 'Général',      emoji: '📝' }
        ]
    },

    // --- Session ---
    SESSION: {
        IDLE_TIMEOUT: 30 * 60 * 1000,
        ABANDONED_CART_DELAY: 30 * 60 * 1000
    },

    // ============================================================
    // STATUTS DE COMMANDE (6 statuts)
    // ============================================================
    ORDERS: {
        CANCELLABLE_HOURS: 4,
        STATUS: {
            PENDING:    'pending',
            CONFIRMED:  'confirmed',
            SHIPPING:   'shipping',
            DELIVERED:  'delivered',
            RETURNED:   'returned',
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
        RETURNABLE_FROM: ['confirmed', 'shipping', 'delivered'],
        EMAIL_ON_STATUS: {
            pending:   { client: true,  admin: true  },
            confirmed: { client: true,  admin: false },
            shipping:  { client: true,  admin: false },
            delivered: { client: true,  admin: true  },
            returned:  { client: true,  admin: true  },
            cancelled: { client: true,  admin: false }
        }
    },

    // --- Avis ---
    REVIEWS: {
        MAX_PHOTOS: 5,
        MAX_FEATURED: 3,
        STATUS: {
            PENDING: 'pending',
            APPROVED: 'approved',
            REJECTED: 'rejected'
        }
    },

    // ============================================================
    // TYPES DE NOTIFICATIONS
    // ============================================================
    NOTIFICATIONS: {
        TYPES: {
            ORDER_CREATED:   'order_created',
            ORDER_CONFIRMED: 'order_confirmed',
            ORDER_SHIPPING:  'order_shipping',
            ORDER_DELIVERED: 'order_delivered',
            ORDER_RETURNED:  'order_returned',
            ORDER_CANCELLED: 'order_cancelled',
            REVIEW_APPROVED: 'review_approved',
            REVIEW_REQUEST:  'review_request'
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

export function normalizeOrderStatus(status) {
    if (!status) return ORDER_STATUS.PENDING;
    return STATUS_MIGRATION_MAP[status] || status;
}

// ============================================================
// LEGACY_CATEGORY_MAP + normalizeCategory()
// ============================================================
export const LEGACY_CATEGORY_MAP = {
    'smartphone':     'smartphones',
    'computer':       'computers',
    'accessories':    'tech-accessories',
    'gaming':         'games',
    'lighting':       'tech-accessories',
    'pet':            'pets',
    'beauty':         'skincare',
    'chargers':       'tech-accessories',
    'tablet':         'tablets',
    'camera':         'cameras',
    'watch':          'wearables',
    'tv':             'electronics'
};

export function normalizeCategory(catId) {
    if (!catId) return 'all';
    return LEGACY_CATEGORY_MAP[catId] || catId;
}

// ============================================================
// productMatchesCategory() (helper réutilisable)
// ============================================================
export function productMatchesCategory(product, categoryId) {
    if (!categoryId || categoryId === 'all') return true;
    if (!product || !product.category) return false;

    const productCat = product.category;
    const normalized = normalizeCategory(productCat);

    if (productCat === categoryId) return true;
    if (normalized === categoryId) return true;

    const parent = CATEGORY_GROUPS.find(g => g.id === categoryId);
    if (parent) {
        return parent.children.some(c =>
            c.id === productCat || c.id === normalized
        );
    }

    return false;
}

// ============================================================
// HELPERS RETOUR
// ============================================================
export function canReturnOrder(order) {
    if (!order) return false;
    const status = normalizeOrderStatus(order.status);
    return CONFIG.ORDERS.RETURNABLE_FROM.includes(status);
}

export function getReturnedQuantities(order) {
    const result = {};
    if (!order || !order.returns || !Array.isArray(order.returns)) return result;

    order.returns.forEach(r => {
        if (!r.items || !Array.isArray(r.items)) return;
        r.items.forEach(item => {
            if (!item.productId) return;
            const pid = String(item.productId);
            const delta = Number(item.delta) || 0;
            result[pid] = (result[pid] || 0) + delta;
        });
    });

    return result;
}

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
// ARBORESCENCE DES CATÉGORIES ET SOUS-CATÉGORIES
// ============================================================
export const CATEGORY_GROUPS = [
    {
        id: 'electronics',
        label: 'filterElectronics',
        emoji: '📱',
        children: [
            { id: 'smartphones',      label: 'filterSmartphones',      emoji: '📱' },
            { id: 'tablets',          label: 'filterTablets',          emoji: '📟' },
            { id: 'audio',            label: 'filterAudio',            emoji: '🎧' },
            { id: 'wearables',        label: 'filterWearables',        emoji: '⌚' },
            { id: 'cameras',          label: 'filterCameras',          emoji: '📷' },
            { id: 'computers',        label: 'filterComputers',        emoji: '💻' },
            { id: 'tech-accessories', label: 'filterTechAccessories',  emoji: '🔌' }
        ]
    },
    {
        id: 'home',
        label: 'filterHome',
        emoji: '🏠',
        children: [
            { id: 'appliances',  label: 'filterAppliances',  emoji: '🔌' },
            { id: 'kitchen',     label: 'filterKitchen',     emoji: '🍳' },
            { id: 'decoration',  label: 'filterDecoration',  emoji: '🖼️' },
            { id: 'storage',     label: 'filterStorage',     emoji: '📦' },
            { id: 'furniture',   label: 'filterFurniture',   emoji: '🪑' },
            { id: 'smart-home',  label: 'filterSmartHome',   emoji: '🏠' }
        ]
    },
    {
        id: 'fashion',
        label: 'filterFashion',
        emoji: '👗',
        children: [
            { id: 'women-clothing', label: 'filterWomenClothing', emoji: '👗' },
            { id: 'men-clothing',   label: 'filterMenClothing',   emoji: '👔' },
            { id: 'shoes',          label: 'filterShoes',         emoji: '👟' },
            { id: 'bags',           label: 'filterBags',          emoji: '👜' },
            { id: 'jewelry',        label: 'filterJewelry',       emoji: '💍' }
        ]
    },
    {
        id: 'beauty',
        label: 'filterBeauty',
        emoji: '💄',
        children: [
            { id: 'skincare',       label: 'filterSkincare',       emoji: '🧴' },
            { id: 'bodycare',       label: 'filterBodycare',       emoji: '🧼' },
            { id: 'haircare',       label: 'filterHaircare',       emoji: '💇' },
            { id: 'makeup',         label: 'filterMakeup',         emoji: '💄' },
            { id: 'beauty-devices', label: 'filterBeautyDevices',  emoji: '✨' },
            { id: 'fragrances',     label: 'filterFragrances',     emoji: '🌸' }
        ]
    },
    {
        id: 'baby-kids',
        label: 'filterBabyKids',
        emoji: '🧸',
        children: [
            { id: 'baby-gear',     label: 'filterBabyGear',     emoji: '🍼' },
            { id: 'baby-clothing', label: 'filterBabyClothing', emoji: '👶' },
            { id: 'toys',          label: 'filterToys',         emoji: '🧸' },
            { id: 'baby-care',     label: 'filterBabyCare',     emoji: '🧴' }
        ]
    },
    {
        id: 'auto-moto',
        label: 'filterAutoMoto',
        emoji: '🚗',
        children: [
            { id: 'auto',            label: 'filterAuto',            emoji: '🚗' },
            { id: 'moto',            label: 'filterMoto',            emoji: '🏍️' },
            { id: 'car-care',        label: 'filterCarCare',         emoji: '🧽' },
            { id: 'car-electronics', label: 'filterCarElectronics',  emoji: '📻' }
        ]
    },
    {
        id: 'sports',
        label: 'filterSports',
        emoji: '⚽',
        children: [
            { id: 'fitness', label: 'filterFitness', emoji: '🏋️' },
            { id: 'outdoor', label: 'filterOutdoor', emoji: '⛺' },
            { id: 'bikes',   label: 'filterBikes',   emoji: '🚲' },
            { id: 'games',   label: 'filterGames',   emoji: '🎲' }
        ]
    },
    {
        id: 'pets',
        label: 'filterPets',
        emoji: '🐾',
        children: [
            { id: 'pet-food',        label: 'filterPetFood',        emoji: '🦴' },
            { id: 'pet-toys',        label: 'filterPetToys',        emoji: '🎾' },
            { id: 'pet-accessories', label: 'filterPetAccessories', emoji: '🐕' }
        ]
    },
    {
        id: 'tools',
        label: 'filterTools',
        emoji: '🔧',
        children: [
            { id: 'hand-tools',  label: 'filterHandTools',  emoji: '🔨' },
            { id: 'power-tools', label: 'filterPowerTools', emoji: '🔌' },
            { id: 'garden',      label: 'filterGarden',     emoji: '🌱' },
            { id: 'security',    label: 'filterSecurity',   emoji: '🔒' }
        ]
    },
    {
        id: 'office',
        label: 'filterOffice',
        emoji: '📄',
        children: [
            { id: 'stationery',           label: 'filterStationery',          emoji: '✏️' },
            { id: 'office-organization',  label: 'filterOfficeOrganization',  emoji: '📁' },
            { id: 'printing',             label: 'filterPrinting',            emoji: '🖨️' }
        ]
    },
    {
        id: 'misc',
        label: 'filterMisc',
        emoji: '🎁',
        children: [
            { id: 'gadgets',    label: 'filterGadgets',    emoji: '🔮' },
            { id: 'party',      label: 'filterParty',      emoji: '🎉' },
            { id: 'promotions', label: 'filterPromotions', emoji: '🔥' }
        ]
    }
];

// ============================================================
// ✅ v3.2.0 — INDEX DES CATÉGORIES (cache pour helpers)
// ------------------------------------------------------------
// Map id → { id, label, emoji, isParent, parentId }
// Inclut : 'all', 'favorites', les parents ET les enfants.
// Construit une seule fois (lazy init), puis mis en cache.
// ============================================================
let _categoryIndexCache = null;

function buildCategoryIndex() {
    if (_categoryIndexCache) return _categoryIndexCache;

    const index = new Map();

    index.set('all', {
        id: 'all',
        label: 'filterAll',
        emoji: '🛍️',
        isParent: false,
        parentId: null
    });
    index.set('favorites', {
        id: 'favorites',
        label: 'filterFavorites',
        emoji: '❤️',
        isParent: false,
        parentId: null
    });

    CATEGORY_GROUPS.forEach(group => {
        index.set(group.id, {
            id: group.id,
            label: group.label,
            emoji: group.emoji,
            isParent: true,
            parentId: null
        });
        group.children.forEach(child => {
            index.set(child.id, {
                id: child.id,
                label: child.label,
                emoji: child.emoji,
                isParent: false,
                parentId: group.id
            });
        });
    });

    _categoryIndexCache = index;
    return index;
}

/**
 * Retourne l'objet catégorie complet (parent OU enfant).
 * Fallback : gère les IDs legacy via normalizeCategory().
 * @param {string} catId
 * @returns {Object|null}
 */
export function getCategoryById(catId) {
    if (!catId) return null;
    const index = buildCategoryIndex();

    const direct = index.get(catId);
    if (direct) return direct;

    const normalized = normalizeCategory(catId);
    return index.get(normalized) || null;
}

/**
 * Retourne le parent d'une sous-catégorie (ou la catégorie elle-même si parent).
 * @param {string} catId
 * @returns {Object|null}
 */
export function getParentCategory(catId) {
    if (!catId) return null;
    const cat = getCategoryById(catId);
    if (!cat) return null;
    if (cat.isParent) return cat;
    if (cat.parentId) return getCategoryById(cat.parentId);
    return null;
}

/**
 * Retourne le chemin complet [parent, enfant] (ou [parent] si parent).
 * @param {string} catId
 * @returns {Array<Object>}
 */
export function getCategoryPath(catId) {
    if (!catId) return [];
    const cat = getCategoryById(catId);
    if (!cat) return [];
    if (cat.isParent) return [cat];
    const parent = cat.parentId ? getCategoryById(cat.parentId) : null;
    return parent ? [parent, cat] : [cat];
}

/**
 * Retourne le nom traduit d'une catégorie (via tCat).
 * Fallback : id brut si introuvable.
 * @param {string} catId
 * @returns {string}
 */
export function getCategoryDisplayName(catId) {
    const cat = getCategoryById(catId);
    if (!cat) return String(catId || '');
    return tCat(cat);
}

// ============================================================
// Helper i18n pour les catégories
// ============================================================
import { t } from './utils.js';

/**
 * Traduit une catégorie (label) selon la langue courante.
 * Fallback sur le label brut si la clé i18n n'existe pas.
 */
export function tCat(category) {
    if (!category) return '';
    const label = typeof category === 'string' ? category : category.label;
    if (!label) return '';
    const translated = t(label);
    return translated === label ? (category.label || label) : translated;
}

// ============================================================
// LISTE APLATIE (compatibilité + filtres)
// ============================================================
const flattenCategories = () => {
    const flat = [
        { id: 'all',       label: 'filterAll',       emoji: '🛍️' },
        { id: 'favorites', label: 'filterFavorites', emoji: '❤️' }
    ];
    CATEGORY_GROUPS.forEach(group => {
        flat.push({
            id: group.id,
            label: group.label,
            emoji: group.emoji,
            isParent: true
        });
        group.children.forEach(child => {
            flat.push({
                id: child.id,
                label: child.label,
                emoji: child.emoji,
                parentId: group.id
            });
        });
    });
    return flat;
};

export const CATEGORIES = flattenCategories();

// ============================================================
// Validation au boot (dev uniquement)
// ============================================================
(function validateCategoryGroups() {
    const isDev = typeof window !== 'undefined' && (
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.search.includes('debug=1')
    );
    if (!isDev) return;

    const seenIds = new Set();
    let errors = 0;

    CATEGORY_GROUPS.forEach(group => {
        if (seenIds.has(group.id)) {
            console.error(`❌ [config] Catégorie parente dupliquée : ${group.id}`);
            errors++;
        }
        seenIds.add(group.id);

        if (!group.label) {
            console.error(`❌ [config] Catégorie ${group.id} sans label`);
            errors++;
        }

        group.children.forEach(child => {
            if (seenIds.has(child.id)) {
                console.error(`❌ [config] Catégorie enfant dupliquée : ${child.id}`);
                errors++;
            }
            seenIds.add(child.id);

            if (!child.label) {
                console.error(`❌ [config] Catégorie ${child.id} sans label`);
                errors++;
            }
        });
    });

    if (errors === 0) {
        console.log(`✅ [config] ${seenIds.size} catégories validées`);
    }
})();

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
console.log('✅ config.js chargé — v3.2.0 (helpers catégories)');