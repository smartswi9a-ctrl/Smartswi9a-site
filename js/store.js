/* ============================================================
   js/store.js
   STORE CENTRALISÉ - SMART SWI9A
   Version 9.0.0 - Lot 3/30 : consolidation (JSDoc, cohérence API)

   CHANGEMENTS v9.0.0 :
     - Ajout : getDeliveryData() pour symétrie avec setDeliveryData().
     - Ajout : JSDoc sur tous les exports publics.
     - Documentation : resolveAppReady() marqué comme alternative à
       window._appReadyResolve.
     - Documentation : getState() déconseillé pour les usages ciblés
       (préférer les getters spécifiques).
     - Aucune régression : signatures et comportements inchangés.

   NOTE : state n'est PAS réactif (pas de Proxy). Les composants UI
   doivent s'abonner aux CustomEvents (cart-updated, auth-updated,
   lang-changed, etc.) et relire le state au moment du rendu.

   ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne
   utile. Tout est en bloc.
   ============================================================ */

import { CONFIG } from './config.js';

/* ============================================================
   ÉTAT GLOBAL
   ============================================================
   Structure volontairement plate : tous les domaines (produits,
   panier, utilisateur, villes, blog, filtres, pagination) vivent
   dans le même objet. setState() remplace le state par un nouvel
   objet fusionné (shallow merge) - voir plus bas.
   ============================================================ */
let state = {
    /* Données métier */
    products: [],
    cart: [],
    user: null,
    deliveryData: [],
    selectedCity: null,

    /* Blog */
    blogPosts: [],

    /* Filtres produits */
    filters: {
        category: 'all',
        search: '',
        sort: 'default',
        inStock: false,
        promos: false,
        priceMin: 0,
        priceMax: 99999
    },

    /* Filtres blog */
    blogFilters: {
        category: 'all',
        search: ''
    },

    /* Pagination produits */
    pagination: {
        currentPage: 1,
        perPage: CONFIG.PRODUCTS.PER_PAGE,
        totalPages: 1
    },

    /* Pagination blog */
    blogPagination: {
        currentPage: 1,
        perPage: CONFIG.BLOG.PER_PAGE,
        totalPages: 1
    }
};

/* ============================================================
   PROMESSE appReady
   ============================================================
   Résolue quand app.js termine l'init (ou après 10s de timeout).
   Consommateurs : panier.js, éventuellement pages secondaires.

   Deux API disponibles :
     - appReadyPromise : Promise exportée, à await.
     - resolveAppReady() / window._appReadyResolve() : résolution
       manuelle depuis app.js. window._appReadyResolve est la voie
       utilisée actuellement par app.js.
   ============================================================ */
let _resolveAppReady = null;

export const appReadyPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
        console.warn('appReadyPromise timeout (10s) - résolue par timeout');
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

/**
 * Résout appReadyPromise manuellement.
 * Alternative à window._appReadyResolve() - les deux font exactement
 * la même chose. Idempotent : appeler deux fois ne casse rien.
 * Ne fait rien si la promesse est déjà résolue.
 */
export function resolveAppReady() {
    if (_resolveAppReady) {
        _resolveAppReady();
        _resolveAppReady = null;
        if (typeof window !== 'undefined') window._appReadyResolve = null;
    }
}

/* ============================================================
   PROMESSE PRODUITS CHARGÉS
   ============================================================
   Utilisée par index.html et testimonials.js pour attendre que
   les produits soient chargés avant de rendre les témoignages.
   ============================================================ */
let productsLoadedPromise = null;

/**
 * Retourne la promesse du chargement des produits en cours
 * (ou déjà résolue), ou null si aucun chargement n'a été lancé.
 * @returns {Promise<Array>|null}
 */
export function getProductsLoadedPromise() {
    return productsLoadedPromise;
}

/**
 * Enregistre la promesse de chargement des produits.
 * Appelé par app.js au démarrage.
 * @param {Promise<Array>} promise
 */
export function setProductsLoadedPromise(promise) {
    productsLoadedPromise = promise;
}

/* ============================================================
   PROMESSE BLOG CHARGÉ
   ============================================================
   Utilisée par blog.html pour attendre le chargement des articles.
   ============================================================ */
let blogLoadedPromise = null;

/**
 * Retourne la promesse du chargement des articles de blog.
 * @returns {Promise<Array>|null}
 */
export function getBlogLoadedPromise() {
    return blogLoadedPromise;
}

/**
 * Enregistre la promesse de chargement des articles de blog.
 * Appelé par blog.js via initBlogPage().
 * @param {Promise<Array>} promise
 */
export function setBlogLoadedPromise(promise) {
    blogLoadedPromise = promise;
}

/* ============================================================
   setState (INTERNE)
   ============================================================
   Fusionne newState dans state. Retourne un nouvel objet pour
   éviter les mutations partagées accidentelles.
   ============================================================ */
function setState(newState) {
    state = { ...state, ...newState };
}

/**
 * Retourne le state complet (référence directe).
 * @deprecated Préférer les getters spécifiques (getProducts, getCart,
 *             getDeliveryData, etc.). getState() n'est conservé que
 *             pour les rares cas où l'on doit accéder à plusieurs
 *             domaines simultanément.
 * @returns {Object}
 */
export function getState() {
    return state;
}

/* ============================================================
   PRODUITS
   ============================================================ */
/**
 * Retourne la liste des produits actuellement chargés.
 * @returns {Array}
 */
export function getProducts() {
    return state.products;
}

/**
 * Remplace la liste des produits.
 * @param {Array} products
 */
export function setProducts(products) {
    setState({ products });
}

/* ============================================================
   PANIER
   ============================================================ */
/**
 * Retourne le contenu du panier.
 * @returns {Array}
 */
export function getCart() {
    return state.cart;
}

/**
 * Remplace le contenu du panier.
 * @param {Array} cart
 */
export function setCart(cart) {
    setState({ cart });
}

/* ============================================================
   UTILISATEUR
   ============================================================ */
/**
 * Retourne l'utilisateur connecté, ou null.
 * @returns {Object|null}
 */
export function getUser() {
    return state.user;
}

/**
 * Définit l'utilisateur connecté (ou null pour déconnexion).
 * @param {Object|null} user
 */
export function setUser(user) {
    setState({ user });
}

/* ============================================================
   VILLES
   ============================================================ */
/**
 * Remplace la liste des villes de livraison.
 * @param {Array} data
 */
export function setDeliveryData(data) {
    setState({ deliveryData: data });
}

/**
 * Retourne la liste des villes de livraison.
 * Ajouté v9.0.0 pour symétrie avec setDeliveryData().
 * @returns {Array}
 */
export function getDeliveryData() {
    return state.deliveryData;
}

/**
 * Retourne la ville sélectionnée pour le calcul de livraison.
 * @returns {Object|null}
 */
export function getSelectedCity() {
    return state.selectedCity;
}

/**
 * Définit la ville sélectionnée pour le calcul de livraison.
 * @param {Object|null} city
 */
export function setSelectedCity(city) {
    setState({ selectedCity: city });
}

/* ============================================================
   FILTRES PRODUITS
   ============================================================ */
/**
 * Retourne les filtres produits actifs.
 * @returns {Object}
 */
export function getFilters() {
    return state.filters;
}

/**
 * Fusionne les filtres partiels dans les filtres actifs.
 * Les clés non fournies sont conservées.
 * @param {Object} filters
 */
export function setFilters(filters) {
    setState({
        filters: { ...state.filters, ...filters }
    });
}

/**
 * Réinitialise tous les filtres produits aux valeurs par défaut.
 */
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

/* ============================================================
   BLOG
   ============================================================ */
/**
 * Retourne la liste des articles de blog chargés.
 * @returns {Array}
 */
export function getBlogPosts() {
    return state.blogPosts;
}

/**
 * Remplace la liste des articles de blog.
 * @param {Array} posts
 */
export function setBlogPosts(posts) {
    setState({ blogPosts: posts });
}

/**
 * Retourne les filtres blog actifs.
 * @returns {Object}
 */
export function getBlogFilters() {
    return state.blogFilters;
}

/**
 * Fusionne les filtres blog partiels.
 * @param {Object} filters
 */
export function setBlogFilters(filters) {
    setState({
        blogFilters: { ...state.blogFilters, ...filters }
    });
}

/**
 * Réinitialise les filtres blog.
 */
export function resetBlogFilters() {
    setState({
        blogFilters: {
            category: 'all',
            search: ''
        }
    });
}

/**
 * Retourne la pagination blog active.
 * @returns {Object}
 */
export function getBlogPagination() {
    return state.blogPagination;
}

/**
 * Fusionne la pagination blog partielle.
 * @param {Object} pagination
 */
export function setBlogPagination(pagination) {
    setState({
        blogPagination: { ...state.blogPagination, ...pagination }
    });
}

/* ============================================================
   PAGINATION PRODUITS
   ============================================================ */
/**
 * Retourne la pagination produits active.
 * @returns {Object}
 */
export function getPagination() {
    return state.pagination;
}

/**
 * Fusionne la pagination produits partielle.
 * @param {Object} pagination
 */
export function setPagination(pagination) {
    setState({
        pagination: { ...state.pagination, ...pagination }
    });
}

/* ============================================================
   LOG
   ============================================================ */
console.log('✅ store.js chargé - v9.0.0 (Lot 3 : consolidation + getDeliveryData)');