// js/config.js
// ============================================================
// CONFIGURATION CENTRALISÉE - SMART SWI9A
// Version 4.1.0 — Fix : Mapping legacy complet + suppression dépendance utils.js
// ============================================================

export const VIDEO_BASE_URL = "https://videos.smartswi9a.top/";

export const CONFIG = {
    FIREBASE: {
        apiKey: "AIzaSyBhULwDxPBRqjywsSD_0ny41Bmt968ofSA",
        authDomain: "smartswi9a-31063.firebaseapp.com",
        projectId: "smartswi9a-31063",
        storageBucket: "smartswi9a-31063.firebasestorage.app",
        messagingSenderId: "933677210664",
        appId: "1:933677210664:web:1ee39f36dfa0806656e91d"
    },
    VERSION: { CITIES_SCHEMA: 3 },
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
    STORAGE_KEYS: {
        CART: 'swi9a_cart', THEME: 'swi9a_theme', LANG: 'swi9a_lang',
        USER: 'swi9a_user', ABANDONED_CART: 'swi9a_abandoned_cart',
        CITIES_CACHE: 'swi9a_cities_cache', COOKIE_CONSENT: 'swi9a_cookie_consent',
        SELECTED_CITY: 'swi9a_selected_city'
    },
    PRODUCTS: { PER_PAGE: 8, DEFAULT_RATING: 4.8, MAX_REVIEW_PHOTOS: 5 },
    BLOG: { PER_PAGE: 6, MAX_TITLE_LENGTH: 120, MAX_EXCERPT_LENGTH: 250, MAX_CONTENT_LENGTH: 50000, CATEGORIES: [] },
    SESSION: { IDLE_TIMEOUT: 30 * 60 * 1000, ABANDONED_CART_DELAY: 30 * 60 * 1000 },
    ORDERS: {
        CANCELLABLE_HOURS: 4,
        STATUS: { PENDING: 'pending', CONFIRMED: 'confirmed', SHIPPING: 'shipping', DELIVERED: 'delivered', RETURNED: 'returned', CANCELLED: 'cancelled' },
        LEGACY_STATUS: { VALIDATED: 'validated', RECEIVED: 'received' },
        PAYMENT: { UNPAID: 'unpaid', PAID: 'paid' },
        RETURNABLE_FROM: ['confirmed', 'shipping', 'delivered'],
        EMAIL_ON_STATUS: {}
    },
    REVIEWS: { MAX_PHOTOS: 5, MAX_FEATURED: 3, STATUS: { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' } },
    NOTIFICATIONS: { TYPES: { ORDER_CREATED: 'order_created', ORDER_CONFIRMED: 'order_confirmed', ORDER_SHIPPING: 'order_shipping', ORDER_DELIVERED: 'order_delivered', ORDER_RETURNED: 'order_returned', ORDER_CANCELLED: 'order_cancelled', REVIEW_APPROVED: 'review_approved', REVIEW_REQUEST: 'review_request' } },
    SIGNUP_METHODS: { OTP: 'otp', GOOGLE: 'google', FACEBOOK: 'facebook' },
    BREAKPOINTS: { MOBILE_MAX: 480, TABLET_MIN: 481, TABLET_MAX: 1024, DESKTOP_MIN: 1025, LARGE_MIN: 1441 }
};

export const CURRENCY_SUFFIX = { fr: 'MAD', ar: 'درهم', en: 'MAD' };
export const ROLES = { USER: 'user', ADMIN: 'admin' };
export const ORDER_STATUS = CONFIG.ORDERS.STATUS;
export const ORDER_LEGACY_STATUS = CONFIG.ORDERS.LEGACY_STATUS;
export const PAYMENT_STATUS = CONFIG.ORDERS.PAYMENT;
export const REVIEW_STATUS = CONFIG.REVIEWS.STATUS;
export const NOTIFICATION_TYPES = CONFIG.NOTIFICATIONS.TYPES;
export const SIGNUP_METHODS = CONFIG.SIGNUP_METHODS;

export const STATUS_MIGRATION_MAP = { 'validated': 'confirmed', 'received': 'delivered' };
export function normalizeOrderStatus(status) {
    if (!status) return ORDER_STATUS.PENDING;
    return STATUS_MIGRATION_MAP[status] || status;
}

// ✅ FIX : Mapping complet des anciennes catégories vers les nouvelles (pour la migration admin)
export const LEGACY_CATEGORY_MAP = {
    'electronics': 'smartphones',
    'smartphone': 'smartphones',
    'tablet': 'computers',
    'watch': 'wearables',
    'accessory': 'tech-accessories',
    'home': 'smart-home',
    'fashion': 'fashion',
    'baby-kids': 'toys',
    'auto-moto': 'auto',
    'office': 'office',
    'misc': 'tools',
    'audio': 'audio',
    'beauty': 'beauty',
    'sport': 'sports',
    'game': 'games',
    'toy': 'toys',
    'pet': 'pets',
    'camera': 'cameras',
    'security': 'security',
    'tool': 'tools'
};

export function normalizeCategory(catId) {
    if (!catId) return 'all';
    return LEGACY_CATEGORY_MAP[catId] || catId;
}

export function productMatchesCategory(product, categoryId) {
    if (!categoryId || categoryId === 'all') return true;
    if (!product || !product.category) return false;
    const productCat = product.category;
    const normalized = normalizeCategory(productCat);
    if (productCat === categoryId) return true;
    if (normalized === categoryId) return true;
    const parent = CATEGORY_GROUPS.find(g => g.id === categoryId);
    if (parent) {
        return parent.children.some(c => c.id === productCat || c.id === normalized);
    }
    return false;
}

export function canReturnOrder(order) {
    if (!order) return false;
    return CONFIG.ORDERS.RETURNABLE_FROM.includes(normalizeOrderStatus(order.status));
}
export function getReturnedQuantities(order) {
    const result = {};
    if (!order || !order.returns || !Array.isArray(order.returns)) return result;
    order.returns.forEach(r => {
        if (!r.items || !Array.isArray(r.items)) return;
        r.items.forEach(item => {
            if (!item.productId) return;
            const pid = String(item.productId);
            result[pid] = (result[pid] || 0) + (Number(item.delta) || 0);
        });
    });
    return result;
}
export function isFullReturn(order) {
    if (!order || !order.items) return false;
    const returned = getReturnedQuantities(order);
    return order.items.every(item => (returned[String(item.productId)] || 0) >= (Number(item.quantity) || 0));
}

export const LANGUAGES = ['fr', 'ar', 'en'];
export const DEFAULT_LANGUAGE = 'fr';

// ============================================================
// ✅ NOUVELLES CATÉGORIES (23 PARENTS + ENFANTS)
// ============================================================
export const CATEGORY_GROUPS = [
    {
        id: 'smartphones', label: 'filterSmartphones', emoji: '📱',
        children: [
            { id: 'smartphones-android', label: 'filterAndroid', emoji: '🤖' },
            { id: 'smartphones-ios', label: 'filterIOS', emoji: '🍏' },
            { id: 'smartphones-accessories', label: 'filterPhoneAccessories', emoji: '🔌' }
        ]
    },
    {
        id: 'audio', label: 'filterAudio', emoji: '🎧',
        children: [
            { id: 'audio-headphones', label: 'filterHeadphones', emoji: '🎧' },
            { id: 'audio-earbuds', label: 'filterEarbuds', emoji: '🎵' },
            { id: 'audio-speakers', label: 'filterSpeakers', emoji: '🔊' }
        ]
    },
    {
        id: 'computers', label: 'filterComputers', emoji: '💻',
        children: [
            { id: 'computers-laptops', label: 'filterLaptops', emoji: '💻' },
            { id: 'computers-desktops', label: 'filterDesktops', emoji: '🖥️' },
            { id: 'computers-accessories', label: 'filterPcAccessories', emoji: '🖱️' }
        ]
    },
    {
        id: 'wearables', label: 'filterWearables', emoji: '⌚',
        children: [
            { id: 'wearables-smartwatches', label: 'filterSmartwatches', emoji: '⌚' },
            { id: 'wearables-fitness', label: 'filterFitness', emoji: '🏃' }
        ]
    },
    {
        id: 'tech-accessories', label: 'filterTechAccessories', emoji: '🔌',
        children: [
            { id: 'tech-chargers', label: 'filterChargers', emoji: '⚡' },
            { id: 'tech-cables', label: 'filterCables', emoji: '🔗' },
            { id: 'tech-powerbanks', label: 'filterPowerbanks', emoji: '🔋' }
        ]
    },
    {
        id: 'cameras', label: 'filterCameras', emoji: '📷',
        children: [
            { id: 'cameras-dslr', label: 'filterDslr', emoji: '📸' },
            { id: 'cameras-action', label: 'filterActionCameras', emoji: '🎥' },
            { id: 'cameras-drones', label: 'filterDrones', emoji: '🚁' }
        ]
    },
    {
        id: 'smart-home', label: 'filterSmartHome', emoji: '🏠',
        children: [
            { id: 'smart-home-lighting', label: 'filterSmartLighting', emoji: '💡' },
            { id: 'smart-home-security', label: 'filterSmartSecurity', emoji: '🔒' },
            { id: 'smart-home-speakers', label: 'filterSmartSpeakers', emoji: '🗣️' }
        ]
    },
    {
        id: 'kitchen', label: 'filterKitchen', emoji: '🍳',
        children: [
            { id: 'kitchen-appliances', label: 'filterKitchenAppliances', emoji: '🍳' },
            { id: 'kitchen-cookware', label: 'filterCookware', emoji: '🍲' },
            { id: 'kitchen-coffee', label: 'filterCoffeeMachines', emoji: '☕' }
        ]
    },
    {
        id: 'furniture', label: 'filterFurniture', emoji: '🪑',
        children: [
            { id: 'furniture-chairs', label: 'filterChairs', emoji: '🪑' },
            { id: 'furniture-tables', label: 'filterTables', emoji: '🪵' },
            { id: 'furniture-storage', label: 'filterStorage', emoji: '📦' }
        ]
    },
    {
        id: 'decoration', label: 'filterDecoration', emoji: '🖼️',
        children: [
            { id: 'decoration-lighting', label: 'filterLamps', emoji: '💡' },
            { id: 'decoration-plants', label: 'filterPlants', emoji: '🪴' },
            { id: 'decoration-art', label: 'filterArt', emoji: '🎨' }
        ]
    },
    {
        id: 'fashion', label: 'filterFashion', emoji: '👗',
        children: [
            { id: 'fashion-men', label: 'filterMen', emoji: '👔' },
            { id: 'fashion-women', label: 'filterWomen', emoji: '👗' },
            { id: 'fashion-shoes', label: 'filterShoes', emoji: '👟' },
            { id: 'fashion-bags', label: 'filterBags', emoji: '👜' }
        ]
    },
    {
        id: 'beauty', label: 'filterBeauty', emoji: '💄',
        children: [
            { id: 'beauty-makeup', label: 'filterMakeup', emoji: '💄' },
            { id: 'beauty-skincare', label: 'filterSkincare', emoji: '🧴' },
            { id: 'beauty-fragrances', label: 'filterFragrances', emoji: '🌸' }
        ]
    },
    {
        id: 'haircare', label: 'filterHaircare', emoji: '💇',
        children: [
            { id: 'haircare-dryers', label: 'filterHairDryers', emoji: '💨' },
            { id: 'haircare-stylers', label: 'filterHairStylers', emoji: '🔥' },
            { id: 'haircare-products', label: 'filterHairProducts', emoji: '🧴' }
        ]
    },
    {
        id: 'auto', label: 'filterAuto', emoji: '🚗',
        children: [
            { id: 'auto-interior', label: 'filterAutoInterior', emoji: '🪑' },
            { id: 'auto-exterior', label: 'filterAutoExterior', emoji: '🚙' },
            { id: 'auto-tools', label: 'filterAutoTools', emoji: '🔧' }
        ]
    },
    {
        id: 'car-electronics', label: 'filterCarElectronics', emoji: '📻',
        children: [
            { id: 'car-electronics-dashcams', label: 'filterDashcams', emoji: '📹' },
            { id: 'car-electronics-gps', label: 'filterGps', emoji: '🗺️' },
            { id: 'car-electronics-audio', label: 'filterCarAudio', emoji: '🔊' }
        ]
    },
    {
        id: 'tools', label: 'filterTools', emoji: '🔨',
        children: [
            { id: 'tools-hand', label: 'filterHandTools', emoji: '🔨' },
            { id: 'tools-boxes', label: 'filterToolBoxes', emoji: '🧰' },
            { id: 'tools-garden', label: 'filterGardenTools', emoji: '🌱' }
        ]
    },
    {
        id: 'power-tools', label: 'filterPowerTools', emoji: '🔌',
        children: [
            { id: 'power-tools-drills', label: 'filterDrills', emoji: '🪚' },
            { id: 'power-tools-saws', label: 'filterSaws', emoji: '🪚' },
            { id: 'power-tools-sanders', label: 'filterSanders', emoji: '⚙️' }
        ]
    },
    {
        id: 'security', label: 'filterSecurity', emoji: '🔒',
        children: [
            { id: 'security-cameras', label: 'filterSecurityCameras', emoji: '📹' },
            { id: 'security-locks', label: 'filterSmartLocks', emoji: '🔐' },
            { id: 'security-alarms', label: 'filterAlarms', emoji: '🚨' }
        ]
    },
    {
        id: 'sports', label: 'filterSports', emoji: '⚽',
        children: [
            { id: 'sports-fitness', label: 'filterFitnessGear', emoji: '🏋️' },
            { id: 'sports-football', label: 'filterFootball', emoji: '⚽' },
            { id: 'sports-outdoor', label: 'filterOutdoor', emoji: '⛺' }
        ]
    },
    {
        id: 'games', label: 'filterGames', emoji: '🎮',
        children: [
            { id: 'games-consoles', label: 'filterConsoles', emoji: '🎮' },
            { id: 'games-controllers', label: 'filterControllers', emoji: '🕹️' },
            { id: 'games-games', label: 'filterVideoGames', emoji: '💿' }
        ]
    },
    {
        id: 'toys', label: 'filterToys', emoji: '🧸',
        children: [
            { id: 'toys-rc', label: 'filterRcToys', emoji: '🚗' },
            { id: 'toys-educational', label: 'filterEducationalToys', emoji: '🧩' },
            { id: 'toys-dolls', label: 'filterDolls', emoji: '🪆' }
        ]
    },
    {
        id: 'pets', label: 'filterPets', emoji: '🐾',
        children: [
            { id: 'pets-food', label: 'filterPetFood', emoji: '🦴' },
            { id: 'pets-toys', label: 'filterPetToys', emoji: '🎾' },
            { id: 'pets-accessories', label: 'filterPetAccessories', emoji: '🐕' }
        ]
    },
    {
        id: 'office', label: 'filterOffice', emoji: '📄',
        children: [
            { id: 'office-stationery', label: 'filterStationery', emoji: '✏️' },
            { id: 'office-furniture', label: 'filterOfficeFurniture', emoji: '🪑' },
            { id: 'office-electronics', label: 'filterOfficeElectronics', emoji: '🖨️' }
        ]
    }
];

// ============================================================
// INDEX DES CATÉGORIES
// ============================================================
let _categoryIndexCache = null;
function buildCategoryIndex() {
    if (_categoryIndexCache) return _categoryIndexCache;
    const index = new Map();
    index.set('all', { id: 'all', label: 'filterAll', emoji: '🛍️', isParent: false, parentId: null });
    index.set('favorites', { id: 'favorites', label: 'filterFavorites', emoji: '❤️', isParent: false, parentId: null });
    CATEGORY_GROUPS.forEach(group => {
        index.set(group.id, { id: group.id, label: group.label, emoji: group.emoji, isParent: true, parentId: null });
        group.children.forEach(child => {
            index.set(child.id, { id: child.id, label: child.label, emoji: child.emoji, isParent: false, parentId: group.id });
        });
    });
    _categoryIndexCache = index;
    return index;
}

export function getCategoryById(catId) {
    if (!catId) return null;
    const index = buildCategoryIndex();
    return index.get(catId) || index.get(normalizeCategory(catId)) || null;
}
export function getParentCategory(catId) {
    const cat = getCategoryById(catId);
    if (!cat) return null;
    if (cat.isParent) return cat;
    return cat.parentId ? getCategoryById(cat.parentId) : null;
}
export function getCategoryPath(catId) {
    const cat = getCategoryById(catId);
    if (!cat) return [];
    if (cat.isParent) return [cat];
    const parent = cat.parentId ? getCategoryById(cat.parentId) : null;
    return parent ? [parent, cat] : [cat];
}

export const CATEGORIES = [{ id: 'all', label: 'filterAll', emoji: '🛍️' }, { id: 'favorites', label: 'filterFavorites', emoji: '❤️' }];
CATEGORY_GROUPS.forEach(group => {
    CATEGORIES.push({ id: group.id, label: group.label, emoji: group.emoji, isParent: true });
    group.children.forEach(child => {
        CATEGORIES.push({ id: child.id, label: child.label, emoji: child.emoji, parentId: group.id });
    });
});

export const SORT_OPTIONS = [
    { value: 'default', label: 'sortDefault' },
    { value: 'price-asc', label: 'sortPriceAsc' },
    { value: 'price-desc', label: 'sortPriceDesc' },
    { value: 'name-asc', label: 'sortNameAsc' },
    { value: 'name-desc', label: 'sortNameDesc' },
    { value: 'rating', label: 'sortRating' }
];

console.log('✅ config.js chargé — v4.1.0 (mapping legacy complet)');