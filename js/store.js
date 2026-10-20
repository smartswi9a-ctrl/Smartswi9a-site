// js/store.js
// ============================================================
// STORE CENTRALISÉ - SMART SWI9A
// Version 1.2.0 — Fixes dette technique (dead code + appReady)
// CHANGEMENTS v1.2.0 :
// ✅ I3.1 — lang retiré du state (utils.currentLang = source unique)
// ✅ I3.2 — appReadyPromise : resolveAppReady() propre + compat
// ✅ I3.3 — perPage : CONFIG.PRODUCTS.PER_PAGE / CONFIG.BLOG.PER_PAGE
// ✅ M3.x — Dead code supprimé (subscribe, listeners, initStore, etc.)
// ⚠️ resetBlogFilters conservé (importé par blog.js — sera supprimé v2.0)
// ============================================================
// Dépend de : config.js
// Rôle      : état global (lecture seule via getters)
// ============================================================

import { CONFIG } from './config.js';

// ============================================================
// ÉTAT GLOBAL
// ============================================================
let state = {
    // --- Données ---
    products: [],
    cart: [],
    user: null,
    deliveryData: [],
    selectedCity: null,

    // --- Blog ---
    blogPosts: [],

    // --- Interface ---
    // ✅ I3.1 : `lang` retiré (source unique = utils.currentLang)
    // ✅ M3.x : `theme` retiré (mode clair unique, plus de toggle)

    // --- Filtres produits ---
    filters: {
        category: 'all',
        search: '',
        sort: 'default',
        inStock: false,
        promos: false,
        priceMin: 0,
        priceMax: 99999
    },

    // --- Filtres blog ---
    blogFilters: {
        category: 'all',
        search: ''
        // ✅ M3.x : `status` retiré (jamais utilisé dans blog.js — filtré côté Firestore)
    },

    // --- Pagination produits ---
    // ✅ I3.3 : utilise CONFIG.PRODUCTS.PER_PAGE
    pagination: {
        currentPage: 1,
        perPage: CONFIG.PRODUCTS.PER_PAGE,
        totalPages: 1
    },

    // --- Pagination blog ---
    // ✅ I3.3 : utilise CONFIG.BLOG.PER_PAGE
    blogPagination: {
        currentPage: 1,
        perPage: CONFIG.BLOG.PER_PAGE,
        totalPages: 1
    }
};

// ============================================================
// ✅ I3.2 — PROMESSE appReady (fix propre + compat)
// ------------------------------------------------------------
// Avant : window._appReadyResolve (pollution globale, pas de guard double-resolve)
// Après : resolveAppReady() exporté + window._appReadyResolve en compat (app.js)
// ============================================================
let _resolveAppReady = null;

export const appReadyPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
        console.warn('⚠️ appReadyPromise timeout (10s) — résolue par timeout');
        if (_resolveAppReady) {
            _resolveAppReady();
            _resolveAppReady = null;
            if (typeof window !== 'undefined') window._appReadyResolve = null;
        }
    }, 10000);

    _resolveAppReady = () => {
        clearTimeout(timeout);
        resolve();
    };

    // ✅ Compatibilité rétroactive avec app.js (qui utilise window._appReadyResolve)
    if (typeof window !== 'undefined') {
        window._appReadyResolve = () => {
            if (_resolveAppReady) {
                _resolveAppReady();
                _resolveAppReady = null;
                window._appReadyResolve = null;
            }
        };
    }
});

/**
 * Résout appReadyPromise (une seule fois).
 * Remplace `window._appReadyResolve()` en code nouveau.
 * Safe : idempotent, guard double-resolve.
 */
export function resolveAppReady() {
    if (_resolveAppReady) {
        _resolveAppReady();
        _resolveAppReady = null;
        if (typeof window !== 'undefined') window._appReadyResolve = null;
    }
}

// ============================================================
// PROMESSE PRODUITS CHARGÉS
// ------------------------------------------------------------
// Utilisée par panier.js et product-detail.js pour attendre le chargement
// ============================================================
let productsLoadedPromise = null;

export function getProductsLoadedPromise() {
    return productsLoadedPromise;
}

export function setProductsLoadedPromise(promise) {
    productsLoadedPromise = promise;
}

// ============================================================
// PROMESSE BLOG CHARGÉ
// ============================================================
let blogLoadedPromise = null;

export function getBlogLoadedPromise() {
    return blogLoadedPromise;
}

export function setBlogLoadedPromise(promise) {
    blogLoadedPromise = promise;
}

// ============================================================
// ✅ setState (INTERNE — non exporté)
// ------------------------------------------------------------
// Les mutations se font uniquement via les setters publics.
// Cela empêche la modification accidentelle de l'état global.
// ============================================================
function setState(newState) {
    state = { ...state, ...newState };
}

// ============================================================
// GET STATE (lecture globale en lecture seule)
// ============================================================
export function getState() {
    return state;
}

// ============================================================
// PRODUITS
// ============================================================
export function getProducts() {
    return state.products;
}

export function setProducts(products) {
    setState({ products });
}

// ============================================================
// PANIER
// ============================================================
export function getCart() {
    return state.cart;
}

export function setCart(cart) {
    setState({ cart });
}

// ============================================================
// UTILISATEUR
// ============================================================
export function getUser() {
    return state.user;
}

export function setUser(user) {
    setState({ user });
}

// ============================================================
// VILLES (LIVRAISON)
// ✅ M3.x : getDeliveryData retiré → utiliser getState().deliveryData
// ============================================================
export function setDeliveryData(data) {
    setState({ deliveryData: data });
}

// ============================================================
// VILLE SÉLECTIONNÉE
// ✅ M3.x : clearSelectedCity retiré → utiliser setSelectedCity(null)
// ============================================================
export function getSelectedCity() {
    return state.selectedCity;
}

export function setSelectedCity(city) {
    setState({ selectedCity: city });
}

// ============================================================
// FILTRES PRODUITS
// ============================================================
export function getFilters() {
    return state.filters;
}

export function setFilters(filters) {
    setState({
        filters: { ...state.filters, ...filters }
    });
}

export function resetFilters() {
    setState({
        filters: {
            category: 'all',
            search: '',
            sort: 'default',
            inStock: false,
            promos: false,
            priceMin: 0,
            priceMax: 99999
        }
    });
}

// ============================================================
// BLOG
// ============================================================
export function getBlogPosts() {
    return state.blogPosts;
}

export function setBlogPosts(posts) {
    setState({ blogPosts: posts });
}

export function getBlogFilters() {
    return state.blogFilters;
}

export function setBlogFilters(filters) {
    setState({
        blogFilters: { ...state.blogFilters, ...filters }
    });
}

/**
 * ⚠️ Note : resetBlogFilters est conservé pour compatibilité
 * (importé par blog.js, mais non appelé actuellement).
 * Sera supprimé dans blog.js v2.0.
 */
export function resetBlogFilters() {
    setState({
        blogFilters: {
            category: 'all',
            search: ''
        }
    });
}

export function getBlogPagination() {
    return state.blogPagination;
}

export function setBlogPagination(pagination) {
    setState({
        blogPagination: { ...state.blogPagination, ...pagination }
    });
}

// ============================================================
// PAGINATION PRODUITS
// ============================================================
export function getPagination() {
    return state.pagination;
}

export function setPagination(pagination) {
    setState({
        pagination: { ...state.pagination, ...pagination }
    });
}

// ============================================================
// LOG
// ============================================================
console.log('✅ store.js chargé — v1.2.0 (fixes dette + appReady propre)');