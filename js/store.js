// js/store.js
// ============================================================
// STORE CENTRALISÉ - SMART SWI9A
// Version 8.0.0 — Marketplace Compatible
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
    },

    // --- Pagination produits ---
    pagination: {
        currentPage: 1,
        perPage: CONFIG.PRODUCTS.PER_PAGE,
        totalPages: 1
    },

    // --- Pagination blog ---
    blogPagination: {
        currentPage: 1,
        perPage: CONFIG.BLOG.PER_PAGE,
        totalPages: 1
    }
};

// ============================================================
// PROMESSE appReady
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

export function resolveAppReady() {
    if (_resolveAppReady) {
        _resolveAppReady();
        _resolveAppReady = null;
        if (typeof window !== 'undefined') window._appReadyResolve = null;
    }
}

// ============================================================
// PROMESSE PRODUITS CHARGÉS
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
// setState (INTERNE)
// ============================================================
function setState(newState) {
    state = { ...state, ...newState };
}

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
// VILLES
// ============================================================
export function setDeliveryData(data) {
    setState({ deliveryData: data });
}

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
console.log('✅ store.js chargé — v8.0.0 (Marketplace Compatible)');