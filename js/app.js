// js/app.js
// ============================================================
// INITIALISATION PRINCIPALE - SMART SWI9A
// Version 2.2.3 — FIX : garde-fou contre le double initAuthListener
// ============================================================
// Dépend de : tous les modules
// Point d'entrée UNIQUE : charge les produits, initialise les modules
// ============================================================

import { t, initLang, loadCities } from "./utils.js";
import {
    getProducts, setProducts, setProductsLoadedPromise
} from "./store.js";
import {
    loadAllProducts, renderProducts, renderCategoryFilters, renderSortOptions
} from "./products.js";
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
// ✅ FIX v2.2.3 : Garde-fou global contre le double initAuthListener
// ------------------------------------------------------------
// Empêche l'accumulation de listeners onAuthStateChanged si app.js
// est exécuté plusieurs fois (HMR, rechargement partiel, etc.).
// ============================================================
if (typeof window !== 'undefined' && typeof window._authListenerInitialized === 'undefined') {
    window._authListenerInitialized = false;
}

// ============================================================
// INITIALISATION
// ============================================================
async function init() {
    console.log('🚀 Initialisation de Smart Swi9a...');

    // 1. Initialiser la langue
    initLang();

    // 2. Appliquer les traductions HTML
    applyTranslations();

    // 3. Injecter l'UI partagée (panier + modal compte + cloche)
    try {
        injectSharedUI();
    } catch (e) {
        console.error('❌ Erreur injectSharedUI :', e);
    }

    // 4. Détecter la page actuelle
    const path = window.location.pathname;
    const isHome = path === '/' || path.endsWith('index.html') || path === '';
    const isProduct = path.endsWith('produit.html')
        || path === '/produit'
        || path.endsWith('/produit')
        || document.querySelector('main[data-product-page]') !== null;
    const isCartPage = path.endsWith('panier.html')
        || path === '/panier'
        || path.endsWith('/panier');

    // 5. Loading spinner (home uniquement)
    const spinner = document.getElementById('loadingSpinner');
    if (spinner && isHome) spinner.classList.add('active');

    // 6. Attacher les événements globaux (délégation)
    attachEvents();

    // 7. Charger le thème (stub — mode clair unique)
    loadTheme();

    // 8. Charger le panier depuis localStorage
    try {
        loadCart();
    } catch (e) {
        console.warn('⚠️ Erreur chargement panier :', e);
    }

    // 9. Restaurer la session + initialiser auth
    // ✅ FIX v2.2.3 : guard anti-double listener
    try {
        restoreSession();
        if (!window._authListenerInitialized) {
            window._authListenerInitialized = true;
            initAuthListener();
        } else {
            console.log('ℹ️ initAuthListener déjà appelé — ignoré (garde-fou v2.2.3)');
        }
    } catch (e) {
        console.warn('⚠️ Erreur init auth :', e);
    }

    // 10. Lancer les produits EN PREMIER et enregistrer la promesse
    const productsPromise = loadAllProducts();
    setProductsLoadedPromise(productsPromise);

    // 11. Charger les villes EN PARALLÈLE
    try {
        await loadCities();
        console.log('✅ Villes chargées');
    } catch (e) {
        console.warn('⚠️ Erreur chargement villes :', e);
    }

    // 12. Attendre les produits
    try {
        await productsPromise;
        console.log(`✅ ${getProducts().length} produits chargés`);
    } catch (e) {
        console.error('❌ Erreur chargement produits :', e);
        setProducts([]);
    }

    // 13. Rendu page HOME
    if (isHome) {
        try {
            renderCategoryFilters();
            renderSortOptions();
            await renderProducts();
            initBanners();
        } catch (e) {
            console.error('❌ Erreur rendu home :', e);
        }

        const searchInput = document.getElementById('productSearch');
        if (searchInput) {
            searchInput.placeholder = t('searchProductsPlaceholder') || 'Rechercher un produit...';
        }

        const sortSelect = document.getElementById('sortSelect');
        if (sortSelect) sortSelect.value = 'default';
    }

    // 14. Rendu page PRODUIT
    if (isProduct) {
        try {
            const { renderProductDetail } = await import("./product-detail.js");
            await renderProductDetail();
            console.log('✅ Page produit rendue');
        } catch (e) {
            console.error('❌ Erreur rendu page produit :', e);
        }
    }

    // 15. Retirer le spinner
    if (spinner && isHome) spinner.classList.remove('active');

    // 16. Modules secondaires
    try { initCitySearch(); } catch (e) { console.warn('⚠️ initCitySearch :', e); }
    try { initCookieConsent(); } catch (e) { console.warn('⚠️ initCookieConsent :', e); }
    try { updateAccountButton(); } catch (e) { console.warn('⚠️ updateAccountButton :', e); }
    try { updateCartTotalsUI(); } catch (e) { console.warn('⚠️ updateCartTotalsUI :', e); }

    // 17. Notifications
    try {
        const user = getCurrentUser();
        if (user) await loadNotifications();
    } catch (e) {
        console.warn('⚠️ Erreur notifications :', e);
    }

    // ============================================================
    // 18. ✅ FIX v2.2.2 : Notification panier abandonné
    // UNIQUEMENT si on n'est PAS sur la page panier
    // ============================================================
    if (!isCartPage) {
        setTimeout(() => {
            try {
                showAbandonedCartNotification();
            } catch (e) {
                console.warn('⚠️ Erreur abandoned cart :', e);
            }
        }, 2000);
    } else {
        console.log('ℹ️ Page panier : notification panier abandonné désactivée');
    }

    console.log('✅ Initialisation terminée.');

    // 19. Résoudre appReadyPromise
    if (window._appReadyResolve) {
        window._appReadyResolve();
        window._appReadyResolve = null;
    }
}

// ============================================================
// EXPOSITION GLOBALE
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
    },
    setCategory: async (cat) => {
        const m = await import("./products.js");
        m.setCategory(cat);
        m.renderCategoryFilters();
    },
    setSort: async (s) => {
        const m = await import("./products.js");
        m.setSort(s);
    },
    setSearch: async (q) => {
        const m = await import("./products.js");
        m.setSearch(q);
    },
    goToPage: async (p) => {
        const m = await import("./products.js");
        m.goToPage(p);
    },
    openProductPage: async (slug) => {
        const m = await import("./products.js");
        m.openProductPage(slug);
    },
    toggleFavorite: async (id) => {
        const m = await import("./products.js");
        await m.toggleFavorite(id);
    },
    openCart: async () => {
        const m = await import("./ui.js");
        m.openCart();
    },
    closeCart: async () => {
        const m = await import("./ui.js");
        m.closeCart();
    },
    addToCart: async (id) => {
        const m = await import("./cart.js");
        await m.addToCart(id);
    },
    clearCart: async () => {
        const m = await import("./cart.js");
        m.clearCart();
    },
    openAccountModal: async () => {
        const m = await import("./ui.js");
        await m.openAccountModal();
    },
    closeAccountModal: async () => {
        const m = await import("./ui.js");
        m.closeAccountModal();
    },
    logout: async () => {
        const m = await import("./auth.js");
        await m.logoutUser();
    },
    openNotifications: async () => {
        const m = await import("./notifications.js");
        await m.openNotificationsPanel();
    },
    orderViaWhatsApp: async (id) => {
        const m = await import("./whatsapp.js");
        m.orderViaWhatsApp(id);
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
console.log('✅ app.js chargé — v2.2.3 (garde-fou anti-double initAuthListener)');