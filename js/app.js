// js/app.js
// ============================================================
// INITIALISATION PRINCIPALE - SMART SWI9A
// Version 2.2.4 — Fix chargement accueil (Anti-crash) + Ordre d'exécution
// ============================================================

import { t, initLang, loadCities } from "./utils.js";
import { getProducts, setProducts, setProductsLoadedPromise } from "./store.js";
import { loadAllProducts, renderProducts, renderCategoryFilters, renderSortOptions } from "./products.js";
import { loadCart } from "./cart.js";
import { initAuthListener, restoreSession, getCurrentUser } from "./auth.js";
import { 
    injectSharedUI, loadTheme, initCitySearch, initCookieConsent, 
    updateAccountButton, showAbandonedCartNotification, updateCartTotalsUI 
} from "./ui.js";
import { initBanners } from "./banner.js";
import { attachEvents, applyTranslations } from "./events.js";
import { loadNotifications } from "./notifications.js";

// ============================================================
// ✅ GARDE-FOU : Éviter les doubles initialisations
// ============================================================
if (typeof window !== 'undefined' && typeof window._authListenerInitialized === 'undefined') {
    window._authListenerInitialized = false;
}

// ============================================================
// INITIALISATION
// ============================================================
async function init() {
    console.log('🚀 Initialisation de Smart Swi9a...');

    // 1. Langue & Traductions
    initLang();
    applyTranslations();

    // 2. UI Partagée (Panier flottant, modale compte, etc.)
    try {
        injectSharedUI();
    } catch (e) {
        console.error('❌ Erreur injectSharedUI :', e);
    }

    // 3. Détection de la page
    const path = window.location.pathname;
    const isHome = path === '/' || path.endsWith('index.html') || path === '';
    const isProduct = path.endsWith('produit.html') || path === '/produit' || path.endsWith('/produit') || document.querySelector('main[data-product-page]') !== null;
    const isCartPage = path.endsWith('panier.html') || path === '/panier' || path.endsWith('/panier');

    // 4. Affichage du Spinner (uniquement sur l'accueil)
    const spinner = document.getElementById('loadingSpinner');
    if (spinner && isHome) spinner.classList.add('active');

    // 5. Événements & Thème
    attachEvents();
    loadTheme();

    // 6. Charger le panier
    try {
        loadCart();
    } catch (e) {
        console.warn('⚠️ Erreur chargement panier :', e);
    }

    // 7. Authentification
    try {
        restoreSession();
        if (!window._authListenerInitialized) {
            window._authListenerInitialized = true;
            initAuthListener();
        }
    } catch (e) {
        console.warn('⚠️ Erreur init auth :', e);
    }

    // 8. LANCEMENT DES DONNÉES (Produits + Villes en parallèle)
    console.log('⏳ Chargement des données (produits + villes)...');
    
    const productsPromise = loadAllProducts();
    setProductsLoadedPromise(productsPromise);

    try {
        await loadCities();
        console.log('✅ Villes chargées');
    } catch (e) {
        console.warn('⚠️ Erreur chargement villes :', e);
    }

    try {
        await productsPromise;
        console.log(`✅ ${getProducts().length} produits chargés`);
    } catch (e) {
        console.error('❌ Erreur chargement produits :', e);
        setProducts([]);
    }

    // 9. RENDU DE LA PAGE D'ACCUEIL
    if (isHome) {
        console.log('🎨 Rendu de la page d\'accueil...');
        try {
            renderCategoryFilters();
            renderSortOptions();
            await renderProducts();
            initBanners(); // Gère les bannières Nouveautés et Promos
            console.log('✅ Rendu accueil terminé');
        } catch (e) {
            console.error('❌ Erreur rendu home :', e);
        }

        const searchInput = document.getElementById('productSearch');
        if (searchInput) searchInput.placeholder = t('searchProductsPlaceholder') || 'Rechercher un produit...';

        const sortSelect = document.getElementById('sortSelect');
        if (sortSelect) sortSelect.value = 'default';
    }

    // 10. RENDU DE LA PAGE PRODUIT
    if (isProduct) {
        try {
            const { renderProductDetail } = await import("./product-detail.js");
            await renderProductDetail();
            console.log('✅ Page produit rendue');
        } catch (e) {
            console.error('❌ Erreur rendu page produit :', e);
        }
    }

    // 11. FIN DU CHARGEMENT
    if (spinner && isHome) spinner.classList.remove('active');

    // 12. Modules secondaires
    try { initCitySearch(); } catch (e) {}
    try { initCookieConsent(); } catch (e) {}
    try { updateAccountButton(); } catch (e) {}
    try { updateCartTotalsUI(); } catch (e) {}

    // 13. Notifications
    try {
        if (getCurrentUser()) await loadNotifications();
    } catch (e) {}

    // 14. Panier abandonné (désactivé sur la page panier)
    if (!isCartPage) {
        setTimeout(() => {
            try { showAbandonedCartNotification(); } catch (e) {}
        }, 2000);
    }

    console.log('✅ Initialisation terminée.');

    // 15. Résoudre appReadyPromise (pour les autres scripts)
    if (window._appReadyResolve) {
        window._appReadyResolve();
        window._appReadyResolve = null;
    }
}

// ============================================================
// EXPOSITION GLOBALE (Optionnel, pour debug ou appels manuels)
// ============================================================
window._app = {
    init,
    getProducts,
    updateUI: async () => {
        const { updateAccountButton, updateCartTotalsUI } = await import("./ui.js");
        updateAccountButton();
        updateCartTotalsUI();
    },
    renderProducts: async () => {
        const m = await import("./products.js");
        await m.renderProducts();
    }
};

// ============================================================
// DÉMARRAGE
// ============================================================
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// ============================================================
// LOG
// ============================================================
console.log('✅ app.js chargé — v2.2.4 (Robuste et sécurisé)');