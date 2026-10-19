// js/store.js
// ============================================================
// STORE CENTRALISÉ - SMART SWI9A
// Version 1.1.0 — Ajout état blog
// ============================================================
// Dépend de : rien (fichier racine)
// Rôle      : état global + notifications aux abonnés
// ============================================================

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
    lang: 'fr',
    theme: 'light',

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
        search: '',
        status: 'published'
    },

    // --- Pagination produits ---
    pagination: {
        currentPage: 1,
        perPage: 6,
        totalPages: 1
    },

    // --- Pagination blog ---
    blogPagination: {
        currentPage: 1,
        perPage: 6,
        totalPages: 1
    }
};

// ============================================================
// ABONNÉS (listeners)
// ============================================================
const listeners = [];

// ============================================================
// PROMESSES GLOBALES
// ============================================================

export const appReadyPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
        console.warn('⚠️ appReadyPromise résolue par timeout (10s)');
        resolve();
    }, 10000);
    window._appReadyResolve = () => {
        clearTimeout(timeout);
        resolve();
    };
});

let productsLoadedPromise = null;

export function getProductsLoadedPromise() {
    return productsLoadedPromise;
}

export function setProductsLoadedPromise(promise) {
    productsLoadedPromise = promise;
}

export function resetProductsLoadedPromise() {
    productsLoadedPromise = null;
}

// --- Promesse blog chargé ---
let blogLoadedPromise = null;

export function getBlogLoadedPromise() {
    return blogLoadedPromise;
}

export function setBlogLoadedPromise(promise) {
    blogLoadedPromise = promise;
}

// ============================================================
// SUBSCRIBE
// ============================================================
export function subscribe(listener) {
    listeners.push(listener);
    return () => {
        const idx = listeners.indexOf(listener);
        if (idx > -1) listeners.splice(idx, 1);
    };
}

function notify() {
    listeners.forEach(listener => {
        try {
            listener(state);
        } catch (e) {
            console.error('❌ Erreur dans un listener du store :', e);
        }
    });
}

// ============================================================
// SET / GET STATE
// ============================================================
export function setState(newState) {
    state = { ...state, ...newState };
    notify();
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
// LANGUE
// ============================================================
export function getLangState() {
    return state.lang;
}

export function setLangState(lang) {
    setState({ lang });
}

// ============================================================
// THÈME (conservé pour compat, toujours 'light')
// ============================================================
export function getTheme() {
    return state.theme;
}

export function setTheme(theme) {
    setState({ theme });
}

// ============================================================
// VILLES (LIVRAISON)
// ============================================================
export function getDeliveryData() {
    return state.deliveryData;
}

export function setDeliveryData(data) {
    setState({ deliveryData: data });
}

// ============================================================
// VILLE SÉLECTIONNÉE
// ============================================================
export function getSelectedCity() {
    return state.selectedCity;
}

export function setSelectedCity(city) {
    setState({ selectedCity: city });
}

export function clearSelectedCity() {
    setState({ selectedCity: null });
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
            search: '',
            status: 'published'
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
// INIT STORE (réinitialisation complète)
// ============================================================
export function initStore() {
    state = {
        products: [],
        cart: [],
        user: null,
        deliveryData: [],
        selectedCity: null,
        blogPosts: [],
        lang: 'fr',
        theme: 'light',
        filters: {
            category: 'all',
            search: '',
            sort: 'default',
            inStock: false,
            promos: false,
            priceMin: 0,
            priceMax: 99999
        },
        blogFilters: {
            category: 'all',
            search: '',
            status: 'published'
        },
        pagination: {
            currentPage: 1,
            perPage: 6,
            totalPages: 1
        },
        blogPagination: {
            currentPage: 1,
            perPage: 6,
            totalPages: 1
        }
    };
    listeners.length = 0;
}

// ============================================================
// LOG
// ============================================================
console.log('✅ store.js chargé — avec blog');