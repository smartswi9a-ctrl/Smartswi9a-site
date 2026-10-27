/* ============================================================ js/app.js INITIALISATION PRINCIPALE - SMART SWI9A Version 9.0.0 - Lot 25/30 : P2-20 + dette Lot 19 (cross-page cat) CHANGEMENTS v9.0.0 : - P2-20 (P2) : init() enveloppé dans try/finally. La fonction window._appReadyResolve() est TOUJOURS appelée, même si init() throw (Firebase HS, JSON invalide, etc.). Avant : les consommateurs de appReadyPromise attendaient 10s (timeout de store.js) au lieu de continuer. - Dette Lot 19 (P1) : initCategoriesMenuFromUrl() est maintenant appelée après le rendu de la home. Le fix /?cat=xxx#produits devient fonctionnel cross-page. NOTE : double render rare (uniquement si ?cat présent). Négligeable en pratique (chemin de navigation rare). - P2-20-bis : startup avec .catch() explicite. Les rejets de init() sont loggés au lieu de devenir "unhandled rejection" silencieux. - Logs préfixés [app] (retrait des emojis 🚀🎨✅❌⚠️ℹ️). - JSDoc sur init() et window._app. - Bump version 2.2.4 -> 9.0.0. ARCHITECTURE : app.js est le SEUL point d'entrée chargé sur toutes les pages (via <script type="module" src="/js/app.js">). Il : 1. Détecte la page courante (home / product / cart). 2. Initialise la langue, l'UI partagée, l'auth, le panier. 3. Charge les données (produits + villes en parallèle). 4. Rend la page selon le contexte (renderProducts / renderProductDetail / panier.js fait le reste). 5. Branche les modules secondaires (bannières, notifications, cookie consent, abandon cart). 6. Résout appReadyPromise (pour panier.js et autres). GUARD AUTH : window._authListenerInitialized empêche le double init d'auth si app.js est importé 2× (double include, HMR). ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import { t, initLang, loadCities } from "./utils.js";
import { getProducts, setProducts, setProductsLoadedPromise } from "./store.js";
import {
  loadAllProducts,
  renderProducts,
  renderCategoryFilters,
  renderSortOptions,
} from "./products.js";
import { loadCart } from "./cart.js";
import { initAuthListener, restoreSession, getCurrentUser } from "./auth.js";
import {
  injectSharedUI,
  loadTheme,
  initCitySearch,
  initCookieConsent,
  updateAccountButton,
  showAbandonedCartNotification,
  updateCartTotalsUI,
} from "./ui.js";
import { initBanners } from "./banner.js";
import { attachEvents, applyTranslations } from "./events.js";
import { loadNotifications } from "./notifications.js";
import { initCategoriesMenuFromUrl } from "./categories-menu.js";

/* ============================================================ GUARD GLOBAL : éviter les doubles initialisations auth ============================================================ Si app.js est inclus 2× (double balise, HMR), le 2ème init ne réattache pas le listener auth. Empêche le cumul. ============================================================ */
if (
  typeof window !== "undefined" &&
  typeof window._authListenerInitialized === "undefined"
) {
  window._authListenerInitialized = false;
}

/* ============================================================ INITIALISATION ============================================================ */

/** * Point d'entrée principal. Orchestre : * 1. Langue + traductions * 2. UI partagée (modale compte, panier flottant) * 3. Détection page (home / product / cart) * 4. Spinner (home uniquement) * 5. Événements + thème * 6. Chargement panier * 7. Auth (restore + listener) * 8. Chargement données (produits + villes en parallèle) * 9. Rendu home / product * 10. Modules secondaires (bannières, citySearch, cookie, notifications) * 11. Branchement dette Lot 19 (initCategoriesMenuFromUrl) * 12. Résolution appReadyPromise (TOUJOURS, via finally) * * P2-20 : le try/finally garantit que _appReadyResolve() est * appelée même si une étape throw. * * @returns {Promise<void>} */
async function init() {
  try {
    console.log("[app] Initialisation de Smart Swi9a...");

    /* ============================================================ 1. Langue & Traductions ============================================================ */
    initLang();
    applyTranslations();

    /* ============================================================ 2. UI Partagée (modale compte, cart flottant, etc.) ============================================================ */
    try {
      injectSharedUI();
    } catch (e) {
      console.error("[app] injectSharedUI failed:", e);
    }

    /* ============================================================ 3. Détection page ============================================================ */
    const path = window.location.pathname;
    const isHome = path === "/" || path.endsWith("index.html") || path === "";
    const isProduct =
      path.endsWith("produit.html") ||
      path === "/produit" ||
      path.endsWith("/produit") ||
      document.querySelector("main[data-product-page]") !== null;
    const isCartPage =
      path.endsWith("panier.html") ||
      path === "/panier" ||
      path.endsWith("/panier");

    /* ============================================================ 4. Spinner (home uniquement) ============================================================ */
    const spinner = document.getElementById("loadingSpinner");
    if (spinner && isHome) spinner.classList.add("active");

    /* ============================================================ 5. Événements & Thème ============================================================ */
    attachEvents();
    loadTheme();

    /* ============================================================ 6. Panier ============================================================ */
    try {
      loadCart();
    } catch (e) {
      console.warn("[app] loadCart failed:", e);
    }

    /* ============================================================ 7. Auth (restore + listener) ============================================================ */
    try {
      restoreSession();
      if (!window._authListenerInitialized) {
        window._authListenerInitialized = true;
        initAuthListener();
      }
    } catch (e) {
      console.warn("[app] initAuth failed:", e);
    }

    /* ============================================================ 8. Chargement données (produits + villes en parallèle) ============================================================ */
    console.log("[app] Chargement des données (produits + villes)...");

    const productsPromise = loadAllProducts();
    setProductsLoadedPromise(productsPromise);

    try {
      await loadCities();
      console.log("[app] Villes chargées");
    } catch (e) {
      console.warn("[app] loadCities failed:", e);
    }

    try {
      await productsPromise;
      console.log(`[app] ${getProducts().length} produits chargés`);
    } catch (e) {
      console.error("[app] Erreur chargement produits :", e);
      setProducts([]);
    }

    /* ============================================================ 9. Rendu home ============================================================ */
    if (isHome) {
      console.log("[app] Rendu de la page d'accueil...");
      try {
        renderCategoryFilters();
        renderSortOptions();
        await renderProducts();
        initBanners();
        console.log("[app] Rendu accueil terminé");
      } catch (e) {
        console.error("[app] Erreur rendu home :", e);
      }

      const searchInput = document.getElementById("productSearch");
      if (searchInput)
        searchInput.placeholder =
          t("searchProductsPlaceholder") || "Rechercher un produit...";

      const sortSelect = document.getElementById("sortSelect");
      if (sortSelect) sortSelect.value = "default";

      /* ============================================================ DETTE LOT 19 : cross-page category ============================================================ Lit ?cat=xxx de l'URL (ou sessionStorage fallback) et applique le filtre. Fix navigation /blog -> /?cat=xxx. Note : si ?cat présent, re-render filtered (~50-100ms). Négligeable en pratique. ============================================================ */
      try {
        await initCategoriesMenuFromUrl();
      } catch (e) {
        console.warn("[app] initCategoriesMenuFromUrl failed:", e);
      }
    }

    /* ============================================================ 10. Rendu produit ============================================================ */
    if (isProduct) {
      try {
        const { renderProductDetail } = await import("./product-detail.js");
        await renderProductDetail();
        console.log("[app] Page produit rendue");
      } catch (e) {
        console.error("[app] Erreur rendu page produit :", e);
      }
    }

    /* ============================================================ 11. Spinner OFF ============================================================ */
    if (spinner && isHome) spinner.classList.remove("active");

    /* ============================================================ 12. Modules secondaires (non bloquants) ============================================================ */
    try {
      initCitySearch();
    } catch (e) {
      /* no-op */
    }
    try {
      initCookieConsent();
    } catch (e) {
      /* no-op */
    }
    try {
      updateAccountButton();
    } catch (e) {
      /* no-op */
    }
    try {
      updateCartTotalsUI();
    } catch (e) {
      /* no-op */
    }

    /* ============================================================ 13. Notifications (si connecté) ============================================================ */
    try {
      if (getCurrentUser()) await loadNotifications();
    } catch (e) {
      /* no-op */
    }

    /* ============================================================ 14. Panier abandonné (désactivé sur /panier) ============================================================ */
    if (!isCartPage) {
      setTimeout(() => {
        try {
          showAbandonedCartNotification();
        } catch (e) {
          /* no-op */
        }
      }, 2000);
    }

    console.log("[app] Initialisation terminée.");
  } finally {
    /* ============================================================ P2-20 : TOUJOURS résoudre appReadyPromise ============================================================ Même si init() throw (Firebase HS, JSON invalide, etc.), on libère les consommateurs (panier.js, etc.) qui await appReadyPromise. Avant, ils attendaient le timeout de 10s de store.js. ============================================================ */
    if (typeof window !== "undefined" && window._appReadyResolve) {
      try {
        window._appReadyResolve();
      } catch (e) {
        console.warn("[app] _appReadyResolve failed:", e);
      }
      window._appReadyResolve = null;
    }
  }
}

/* ============================================================ EXPOSITION GLOBALE (debug / appels manuels) ============================================================ Utilisé principalement pour le debug en console : - window._app.init() : relancer init (rare) - window._app.getProducts() : inspecter le state - window._app.updateUI() : forcer un refresh UI - window._app.renderProducts() : forcer un render grille NON UTILISÉ par le code de production. Peut être retiré en Lot 50 si aucun usage identifié. ============================================================ */
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
};

/* ============================================================ DÉMARRAGE ============================================================ P2-20-bis : .catch() explicite sur init() pour éviter les "unhandled promise rejection" silencieuses en production. ============================================================ */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    init().catch((err) => console.error("[app] init failed:", err));
  });
} else {
  init().catch((err) => console.error("[app] init failed:", err));
}

/* ============================================================ LOG ============================================================ */
console.log("[app] v9.0.0 chargé (Lot 25 : P2-20 + cross-page cat)");