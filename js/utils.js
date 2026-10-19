// js/utils.js
// ============================================================
// UTILITAIRES - SMART SWI9A
// Version 1.3.1 — FIX: event lang-changed dispatch (BUG #1)
// ============================================================
// Dépend de : config.js
// Fournit  : helpers (t, escapeHTML, dates, retry, cities...)
// ============================================================

import {
    CONFIG,
    LANGUAGES,
    DEFAULT_LANGUAGE,
    CURRENCY_SUFFIX,
    ORDER_STATUS,
    ORDER_LEGACY_STATUS,
    REVIEW_STATUS,
    normalizeOrderStatus,
    getReturnedQuantities
} from './config.js';

// ============================================================
// LANGUE (état interne)
// ============================================================
let currentLang = DEFAULT_LANGUAGE;

export function t(key) {
    const translations = window.translations || {};
    return translations[currentLang]?.[key]
        || translations[DEFAULT_LANGUAGE]?.[key]
        || key;
}

export function setLang(lang) {
    if (!LANGUAGES.includes(lang)) lang = DEFAULT_LANGUAGE;
    const previousLang = currentLang;
    currentLang = lang;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    safeSetItem(CONFIG.STORAGE_KEYS.LANG, lang);

    const select = document.getElementById('langSelect');
    if (select && select.value !== lang) select.value = lang;

    // ✅ FIX BUG #1 : notifier tous les modules abonnés (panier.js, events.js, etc.)
    if (previousLang !== lang) {
        document.dispatchEvent(new CustomEvent('lang-changed', {
            detail: { lang, previousLang }
        }));
    }
}

export function getLang() {
    return currentLang;
}

export function getCurrency() {
    return CURRENCY_SUFFIX[currentLang] || 'MAD';
}

// ============================================================
// SÉCURITÉ - Échappement HTML (anti-XSS)
// ============================================================
export function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, function(m) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return map[m];
    });
}

// ============================================================
// LOCALSTORAGE SÉCURISÉ
// ============================================================
export function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (e) {
        console.warn('⚠️ localStorage indisponible:', e);
        return false;
    }
}

export function safeGetItem(key, fallback = null) {
    try {
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : fallback;
    } catch (e) {
        console.warn('⚠️ Erreur lecture localStorage:', e);
        return fallback;
    }
}

export function safeRemoveItem(key) {
    try {
        localStorage.removeItem(key);
    } catch (e) {
        console.warn('⚠️ Erreur suppression localStorage:', e);
    }
}

// ============================================================
// PRODUITS - Accesseurs multilingues
// ============================================================
export function getProductName(p) {
    if (!p) return 'Produit';
    const key = `name${currentLang.charAt(0).toUpperCase() + currentLang.slice(1)}`;
    return p[key] || p.nameFr || p.nameEn || 'Produit';
}

export function getProductDesc(p) {
    if (!p) return '';
    const key = `desc${currentLang.charAt(0).toUpperCase() + currentLang.slice(1)}`;
    return p[key] || p.descFr || p.descEn || '';
}

export function getProductFeatures(p) {
    if (!p) return [];
    const key = `features${currentLang.charAt(0).toUpperCase() + currentLang.slice(1)}`;
    return p[key] || p.featuresFr || p.featuresEn || [];
}

export function getProductImageUrl(p) {
    if (!p || !p.img || p.img === '') {
        return getFallbackImage(getProductName(p));
    }
    return p.img.startsWith('/') || p.img.startsWith('http')
        ? p.img
        : '/' + p.img;
}

// ============================================================
// IMAGE FALLBACK (SVG inline si image manquante)
// ============================================================
export function getFallbackImage(name) {
    const safeName = escapeHTML((name || 'Produit').substring(0, 30));
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'%3E%3Crect fill='%23f8f6f2' width='400' height='400'/%3E%3Cpath fill='%23a57b2e' d='M200 50 L240 150 L340 150 L260 210 L290 310 L200 250 L110 310 L140 210 L60 150 L160 150 Z'/%3E%3Ctext x='200' y='360' text-anchor='middle' fill='%231a1a2e' font-family='sans-serif' font-size='14'%3E${safeName}%3C/text%3E%3C/svg%3E`;
}

// ============================================================
// HELPERS DE CALCUL (anti division par zéro)
// ============================================================
export function safePercent(value, total, decimals = 0) {
    const v = Number(value) || 0;
    const t = Number(total) || 0;
    if (t <= 0) return 0;
    const result = (v / t) * 100;
    return decimals > 0
        ? Number(result.toFixed(decimals))
        : Math.round(result);
}

export function getDiscountPercent(oldPrice, price) {
    const op = Number(oldPrice) || 0;
    const p = Number(price) || 0;
    if (op <= 0 || p >= op) return 0;
    return Math.round(((op - p) / op) * 100);
}

export function safeDivide(numerator, denominator, fallback = 0) {
    const n = Number(numerator) || 0;
    const d = Number(denominator) || 0;
    if (d === 0) return fallback;
    return n / d;
}

// ============================================================
// STORAGE HELPERS (centralisés)
// ============================================================
export function getStoragePathFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        const decoded = decodeURIComponent(url);
        const match = decoded.match(/\/o\/([^?]+)/);
        return match && match[1] ? match[1] : null;
    } catch (e) {
        console.warn('⚠️ getStoragePathFromUrl :', url, e);
        return null;
    }
}

export function isStorageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.includes('firebasestorage.googleapis.com');
}

// ============================================================
// FORMATAGE
// ============================================================
export function formatPrice(price) {
    if (price === null || price === undefined) return '--';
    return `${price} ${getCurrency()}`;
}

export function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
        const date = toDate(dateStr);
        if (!date) return '';
        const locale = currentLang === 'ar' ? 'ar-MA' : (currentLang === 'en' ? 'en-GB' : 'fr-FR');
        return date.toLocaleDateString(locale);
    } catch (e) {
        return '';
    }
}

export function formatDateTime(dateStr) {
    if (!dateStr) return '';
    try {
        const date = toDate(dateStr);
        if (!date) return '';
        const locale = currentLang === 'ar' ? 'ar-MA' : (currentLang === 'en' ? 'en-GB' : 'fr-FR');
        return date.toLocaleDateString(locale) + ' ' + date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return '';
    }
}

// ============================================================
// toDate() robuste — Convertit TOUS les formats possibles
// ============================================================
export function toDate(value) {
    if (!value) return null;

    // 1. Firestore Timestamp
    if (typeof value.toDate === 'function') {
        try { return value.toDate(); } catch (e) { /* continue */ }
    }

    // 2. Objet Date natif
    if (value instanceof Date) {
        return isNaN(value.getTime()) ? null : value;
    }

    // 3. Nombre (epoch)
    if (typeof value === 'number') {
        const ms = value < 1e11 ? value * 1000 : value;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d;
    }

    // 4. Objet Firestore-like (avec .seconds)
    if (typeof value === 'object' && typeof value.seconds === 'number') {
        const d = new Date(value.seconds * 1000);
        return isNaN(d.getTime()) ? null : d;
    }

    // 5. String
    if (typeof value === 'string') {
        const frMatch = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
        if (frMatch) {
            const [, d, m, y] = frMatch;
            const year = y.length === 2 ? (2000 + parseInt(y)) : parseInt(y);
            const date = new Date(year, parseInt(m) - 1, parseInt(d));
            return isNaN(date.getTime()) ? null : date;
        }
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }

    return null;
}

// ============================================================
// COMMANDES - Statuts (6 statuts + compat legacy)
// ============================================================
export function getOrderStatusEmoji(status) {
    const normalized = normalizeOrderStatus(status);
    const emojis = {
        [ORDER_STATUS.PENDING]:   '⏳',
        [ORDER_STATUS.CONFIRMED]: '✅',
        [ORDER_STATUS.SHIPPING]:  '🚚',
        [ORDER_STATUS.DELIVERED]: '📦',
        [ORDER_STATUS.RETURNED]:  '↩️',
        [ORDER_STATUS.CANCELLED]: '❌'
    };
    return emojis[normalized] || '❓';
}

export function getOrderStatusColor(status) {
    const normalized = normalizeOrderStatus(status);
    const colors = {
        [ORDER_STATUS.PENDING]:   '#e67e22',
        [ORDER_STATUS.CONFIRMED]: '#3498db',
        [ORDER_STATUS.SHIPPING]:  '#d35400',
        [ORDER_STATUS.DELIVERED]: '#2ecc71',
        [ORDER_STATUS.RETURNED]:  '#9b59b6',
        [ORDER_STATUS.CANCELLED]: '#b03a2e'
    };
    return colors[normalized] || '#5c5c5c';
}

export function getOrderStatusLabel(status) {
    const normalized = normalizeOrderStatus(status);
    const labels = {
        [ORDER_STATUS.PENDING]:   'orderStatusPending',
        [ORDER_STATUS.CONFIRMED]: 'orderStatusConfirmed',
        [ORDER_STATUS.SHIPPING]:  'orderStatusShipping',
        [ORDER_STATUS.DELIVERED]: 'orderStatusDelivered',
        [ORDER_STATUS.RETURNED]:  'orderStatusReturned',
        [ORDER_STATUS.CANCELLED]: 'orderStatusCancelled'
    };
    return t(labels[normalized] || 'orderStatusUnknown');
}

// ============================================================
// Timeline — étapes de progression d'une commande
// ============================================================
export function getOrderTimelineSteps(status) {
    const normalized = normalizeOrderStatus(status);

    const steps = [
        { id: 'pending',   label: 'timelinePending',   emoji: '⏳' },
        { id: 'confirmed', label: 'timelineConfirmed', emoji: '✅' },
        { id: 'shipping',  label: 'timelineShipping',  emoji: '🚚' },
        { id: 'delivered', label: 'timelineDelivered', emoji: '📦' }
    ];

    if (normalized === ORDER_STATUS.RETURNED) {
        steps.push({ id: 'returned', label: 'timelineReturned', emoji: '↩️' });
    }

    const statusIndex = {
        [ORDER_STATUS.PENDING]:   0,
        [ORDER_STATUS.CONFIRMED]: 1,
        [ORDER_STATUS.SHIPPING]:  2,
        [ORDER_STATUS.DELIVERED]: 3,
        [ORDER_STATUS.RETURNED]:  4
    };

    const currentIndex = statusIndex[normalized] ?? -1;

    return steps.map((step, idx) => ({
        ...step,
        done: idx <= currentIndex,
        current: idx === currentIndex,
        active: idx <= currentIndex
    }));
}

export function isOrderCancellable(order) {
    if (!order) return false;
    const status = normalizeOrderStatus(order.status);
    if (status !== ORDER_STATUS.PENDING) return false;
    const createdDate = toDate(order.createdAt);
    if (!createdDate) return false;
    const hoursElapsed = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60);
    return hoursElapsed < CONFIG.ORDERS.CANCELLABLE_HOURS;
}

export function getTimeRemainingForCancellation(order) {
    if (!order) return null;
    const status = normalizeOrderStatus(order.status);
    if (status !== ORDER_STATUS.PENDING) return null;
    const createdDate = toDate(order.createdAt);
    if (!createdDate) return null;
    const cancellableUntil = createdDate.getTime() + (CONFIG.ORDERS.CANCELLABLE_HOURS * 60 * 60 * 1000);
    const remaining = cancellableUntil - Date.now();
    if (remaining <= 0) return null;
    return remaining;
}

export function formatTimeRemaining(ms) {
    if (!ms || ms <= 0) return '';
    const totalMinutes = Math.floor(ms / (1000 * 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${minutes}min`;
    return `${minutes}min`;
}

// ============================================================
// HELPERS RETOUR
// ============================================================
export function getReturnSummary(order) {
    if (!order || !order.items) {
        return {
            totalOrdered: 0,
            totalReturned: 0,
            summary: '0/0',
            isFullReturn: false,
            hasPartialReturn: false,
            hasAnyReturn: false
        };
    }

    const returned = getReturnedQuantities(order);
    let totalOrdered = 0;
    let totalReturned = 0;

    order.items.forEach(item => {
        const pid = String(item.productId);
        const qty = Number(item.quantity) || 0;
        const ret = returned[pid] || 0;
        totalOrdered += qty;
        totalReturned += ret;
    });

    const isFullReturn = totalOrdered > 0 && totalReturned >= totalOrdered;
    const hasPartialReturn = totalReturned > 0 && totalReturned < totalOrdered;
    const hasAnyReturn = totalReturned > 0;

    return {
        totalOrdered,
        totalReturned,
        summary: `${totalReturned}/${totalOrdered}`,
        isFullReturn,
        hasPartialReturn,
        hasAnyReturn
    };
}

export function getReturnBadgeText(order) {
    const summary = getReturnSummary(order);
    if (!summary.hasAnyReturn) return '';

    if (summary.isFullReturn) {
        return `↩️ ${t('returnBadgeFull') || 'Retour total'}`;
    }
    return `↩️ ${t('returnBadgePartial') || 'Retour'} ${summary.summary}`;
}

// ============================================================
// AVIS - Statuts
// ============================================================
export function getReviewStatusEmoji(status) {
    const emojis = {
        [REVIEW_STATUS.PENDING]: '🟡',
        [REVIEW_STATUS.APPROVED]: '🟢',
        [REVIEW_STATUS.REJECTED]: '🔴'
    };
    return emojis[status] || '⚪';
}

export function getReviewStatusLabel(status) {
    const labels = {
        [REVIEW_STATUS.PENDING]: 'reviewStatusPending',
        [REVIEW_STATUS.APPROVED]: 'reviewStatusApproved',
        [REVIEW_STATUS.REJECTED]: 'reviewStatusRejected'
    };
    return t(labels[status] || 'reviewStatusUnknown');
}

export function renderStars(rating) {
    const num = Math.floor(Number(rating) || 0);
    const full = '★'.repeat(Math.min(5, Math.max(0, num)));
    const empty = '☆'.repeat(Math.max(0, 5 - num));
    return full + empty;
}

// ============================================================
// RETRY RÉSEAU (résilience)
// ============================================================
export async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
    let attempt = 0;
    while (attempt < retries) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;
            throw new Error(`HTTP ${response.status}`);
        } catch (error) {
            attempt++;
            if (attempt === retries) throw error;
            console.warn(`⚠️ Tentative ${attempt}/${retries} pour ${url} échouée`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
}

export async function firestoreWithRetry(fn, retries = 3, delay = 1000) {
    let attempt = 0;
    while (attempt < retries) {
        try {
            return await fn();
        } catch (error) {
            attempt++;
            if (attempt === retries) throw error;
            console.warn(`⚠️ Tentative Firestore ${attempt}/${retries} échouée`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
}

// ============================================================
// DEVICE (responsive JS)
// ============================================================
export function isMobile() {
    return window.innerWidth <= CONFIG.BREAKPOINTS.MOBILE_MAX;
}

export function isTablet() {
    return window.innerWidth >= CONFIG.BREAKPOINTS.TABLET_MIN
        && window.innerWidth <= CONFIG.BREAKPOINTS.TABLET_MAX;
}

export function isDesktop() {
    return window.innerWidth >= CONFIG.BREAKPOINTS.DESKTOP_MIN;
}

export function getDevice() {
    if (isMobile()) return 'mobile';
    if (isTablet()) return 'tablet';
    return 'desktop';
}

// ============================================================
// DEBOUNCE / THROTTLE
// ============================================================
export function debounce(fn, delay = 300) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

export function throttle(fn, limit = 200) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            fn.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// ============================================================
// PARSING
// ============================================================
export function toInt(value, fallback = 0) {
    const n = parseInt(value, 10);
    return isNaN(n) ? fallback : n;
}

export function toFloat(value, fallback = 0) {
    const n = parseFloat(value);
    return isNaN(n) ? fallback : n;
}

export function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// ============================================================
// VALIDATION
// ============================================================
export function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function isValidPhone(phone) {
    if (!phone || typeof phone !== 'string') return false;
    const cleaned = phone.replace(/[\s\-\.\(\)]/g, '');
    return /^(\+212|0)[5-7]\d{8}$/.test(cleaned);
}

export function isValidPassword(password) {
    return password && password.length >= 6;
}

// ============================================================
// INIT LANGUE (au chargement) — avec détection navigateur
// ============================================================
export function initLang() {
    const saved = safeGetItem(CONFIG.STORAGE_KEYS.LANG);
    const urlParams = new URLSearchParams(window.location.search);
    const urlLang = urlParams.get('lang');
    const browserLang = (navigator.language || '').split('-')[0].toLowerCase();

    let lang = DEFAULT_LANGUAGE;
    if (urlLang && LANGUAGES.includes(urlLang)) {
        lang = urlLang;
    } else if (saved && LANGUAGES.includes(saved)) {
        lang = saved;
    } else if (browserLang && LANGUAGES.includes(browserLang)) {
        lang = browserLang;
    }
    setLang(lang);
    return lang;
}

// ============================================================
// LOAD CITIES depuis Firestore (avec fallback JSON)
// ============================================================
export async function loadCities(force = false) {
    const CACHE_KEY = CONFIG.STORAGE_KEYS.CITIES_CACHE;
    const CACHE_VERSION = 3;
    const { setDeliveryData } = await import('./store.js');

    if (!force) {
        const cached = safeGetItem(CACHE_KEY);
        if (cached &&
            cached.version === CACHE_VERSION &&
            cached.timestamp &&
            (Date.now() - cached.timestamp < 86400000)) {
            setDeliveryData(cached.data);
            console.log(`✅ ${cached.data.length} villes depuis le cache`);
            return cached.data;
        }
    }

    try {
        const { collection, getDocs } = await import("firebase/firestore");
        const { db } = await import("./firebase.js");

        const snap = await getDocs(collection(db, "cities"));

        if (!snap.empty) {
            const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            data.sort((a, b) => Number(a.id) - Number(b.id));

            setDeliveryData(data);
            safeSetItem(CACHE_KEY, {
                data,
                timestamp: Date.now(),
                version: CACHE_VERSION
            });
            console.log(`✅ ${data.length} villes chargées depuis Firestore`);
            return data;
        }

        console.warn('⚠️ Collection "cities" vide dans Firestore, fallback JSON');
    } catch (e) {
        console.error('❌ Erreur Firestore cities :', e);
    }

    try {
        console.log('⏳ Fallback : chargement depuis villes.json...');
        const res = await fetchWithRetry('/villes.json');
        const data = await res.json();
        if (!Array.isArray(data)) {
            throw new Error('villes.json mal formaté');
        }

        setDeliveryData(data);
        safeSetItem(CACHE_KEY, {
            data,
            timestamp: Date.now(),
            version: CACHE_VERSION
        });
        console.warn(`⚠️ ${data.length} villes chargées depuis JSON (fallback)`);
        return data;
    } catch (e) {
        console.error('❌ Erreur fallback JSON :', e);
        setDeliveryData([]);
        return [];
    }
}

// ============================================================
// SLUGIFY (utilisé par admin pour générer les slugs)
// ============================================================
export function slugify(text) {
    return String(text)
        .toLowerCase()
        .trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}

// ============================================================
// HELPERS VILLES — Nom multilingue
// ============================================================
const CITY_LOWERCASE_WORDS = new Set([
    'de', 'du', 'des', 'la', 'le', 'les', 'et', 'sur',
    'el', 'ben', 'bni', 'oulad', 'sidi', 'ain', 'bir', 'dar',
    'souk', 'kasba', 'jorf', 'bou', 'aïn'
]);

function smartTitleCase(str) {
    if (!str) return '';
    return String(str)
        .toLowerCase()
        .split(/\s+/)
        .map((word, idx) => {
            if (!word) return '';
            if (idx > 0 && CITY_LOWERCASE_WORDS.has(word)) return word;
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(' ');
}

// Corrections manuelles des orthographes officielles françaises
const CITY_FR_OVERRIDES = {
    'fes': 'Fès',
    'meknes': 'Meknès',
    'tetouan': 'Tétouan',
    'sale': 'Salé',
    'laayoune': 'Laâyoune',
    'ain harouda': 'Aïn Harouda',
    'beni mellal': 'Béni Mellal',
    'khenifra': 'Khénifra',
    'sidi kacem': 'Sidi Kacem',
    'sidi slimane': 'Sidi Slimane',
    'souk el arbaa': 'Souk El Arbaa',
    'el ksiba': 'El Ksiba',
    'el hajeb': 'El Hajeb',
    'al hoceima': 'Al Hoceïma',
    'errachidia': 'Errachidia',
    'ouarzazate': 'Ouarzazate',
    'tinghir': 'Tinghir',
    'zagora': 'Zagora',
    'guelmim': 'Guelmim',
    'tan-tan': 'Tan-Tan',
    'el kelaa des sraghna': 'El Kelâa des Sraghna',
    'kasba tadla': 'Kasba Tadla',
    'fquih ben salah': 'Fquih Ben Salah',
    'oulad frej': 'Oulad Frej',
    'souk sebt oulad nemma': 'Souk Sebt Oulad Nemma',
    'jorf el melha': 'Jorf El Melha',
    'ksar el kebir': 'Ksar El Kébir',
    'el jorf': 'El Jorf',
    'mdiq': "M'diq",
    'fnideq': 'Fnideq',
    'chefchaouen': 'Chefchaouen',
    'ouazzane': 'Ouezzane',
    'safi': 'Safi'
};

export function getCityName(city) {
    if (!city) return '';
    const lang = getLang();

    if (lang === 'ar') {
        return city.nameAr || city.name || city.key || '';
    }

    if (lang === 'fr') {
        if (city.nameFr) return city.nameFr;
        const key = String(city.key || '').toLowerCase().trim();
        if (CITY_FR_OVERRIDES[key]) return CITY_FR_OVERRIDES[key];
        if (key) return smartTitleCase(key);
        return city.name || '';
    }

    if (lang === 'en') {
        if (city.nameEn) return city.nameEn;
        const key = String(city.key || '').toLowerCase().trim();
        if (key) return smartTitleCase(key);
        return city.name || '';
    }

    return city.name || '';
}

export function getCityNameAll(city) {
    if (!city) return [];
    return [
        city.nameFr,
        city.nameEn,
        city.nameAr || city.name,
        city.key,
        smartTitleCase(city.key || '')
    ].filter(Boolean).map(s => String(s).toLowerCase());
}

// ============================================================
// Helpers Blog
// ============================================================
export function estimateReadTime(text) {
    if (!text) return 1;
    const wordCount = String(text).trim().split(/\s+/).length;
    return Math.max(1, Math.ceil(wordCount / 200));
}

export function truncate(text, maxLength = 150) {
    if (!text) return '';
    const str = String(text).trim();
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength).trim() + '…';
}

// ============================================================
// Helpers Signup Method
// ============================================================
export function getSignupMethodLabel(method) {
    const labels = {
        'otp': 'signupMethodOtp',
        'google': 'signupMethodGoogle',
        'facebook': 'signupMethodFacebook'
    };
    return t(labels[method] || 'signupMethodOtp');
}

export function getSignupMethodEmoji(method) {
    const emojis = {
        'otp': '🔐',
        'google': '🔵',
        'facebook': '📘'
    };
    return emojis[method] || '🔐';
}

// ============================================================
// Détection Type de Page
// ============================================================
export function getCurrentPage() {
    const path = window.location.pathname;
    if (path === '/' || path.endsWith('index.html')) return 'home';
    if (path.endsWith('produit.html')) return 'product';
    if (path.endsWith('blog.html')) return 'blog';
    if (path.endsWith('villesmaroc.html')) return 'villes';
    if (path.endsWith('admin.html')) return 'admin';
    return 'unknown';
}

// ============================================================
// Format Email / Phone (nettoyage)
// ============================================================
export function cleanEmail(email) {
    if (!email) return '';
    return String(email).trim().toLowerCase();
}

export function cleanPhone(phone) {
    if (!phone) return '';
    return String(phone).replace(/[^\d+]/g, '');
}

// ============================================================
// LOG
// ============================================================
console.log('✅ utils.js chargé — v1.3.1 (FIX: event lang-changed)');