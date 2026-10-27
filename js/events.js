/* ============================================================ js/events.js DÉLÉGATION D'ÉVÉNEMENTS GLOBALE - SMART SWI9A Version 9.0.0 - Lot 22/30 : nettoyage emojis + JSDoc CHANGEMENTS v9.0.0 : - P3-1 : toast 'filterReset' ne préfixe plus par 🔄. - P3-2 : toast 'logout' ne préfixe plus par 👋. - P3-3 : logs internes avec emojis (ℹ️, ⚠️) remplacés par préfixe '[events]' pour cohérence avec les autres modules. - JSDoc sur attachEvents et applyTranslations. - Guard _eventsAttached conservé (idempotence). - Signature publique inchangée. - Bump version 8.1.0 -> 9.0.0. HANDLERS DATA-ACTION (17) : cart:open, cart:close, cart:clear products:filter, products:sort, products:search, products:filter-stock, products:filter-promos, products:filter-reset account:open, account:close logout auth:google, auth:facebook notifications:open scroll:top blog:search lang:change FALLBACK DÉLÉGATION (5) : .pagination-btn → goToPage() .btn-add-to-cart → addToCart() .favorite-btn → toggleFavorite() .btn-secondary[data-product-id] → orderViaWhatsApp() .product-card → openProductPage() (ou fallback ID) .blog-card → openBlogArticle() DEBOUNCE : products:search et blog:search sont debouncés à 300ms. blog.js (v9.0.0) a retiré son debounce interne (Lot 17) : total = 300ms simple, pas 600ms. ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import { t, setLang, getLang } from "./utils.js";
import { showToast } from "./ui-core.js";

/* ============================================================ GUARD GLOBAL (anti double-attach) ============================================================ Si attachEvents() est appelé 2× (double include, HMR), le 2ème appel est silencieusement ignoré. Empêche le cumul de listeners sur document. ============================================================ */
let _eventsAttached = false;

/* ============================================================ HANDLERS ============================================================ Chaque handler est une fonction async qui importe dynamiquement le module requis. Ce pattern évite les cycles d'imports entre events.js et les modules métier (ui, cart, products, blog, etc.). ============================================================ */
const eventHandlers = {
  "cart:open": async () => {
    const { openCart } = await import("./ui.js");
    openCart();
  },

  "cart:close": async () => {
    const { closeCart } = await import("./ui.js");
    closeCart();
  },

  "cart:clear": async (e) => {
    const btn = e.target.closest('[data-action="cart:clear"]');
    if (btn && btn._initialized) return;
    const { clearCart } = await import("./cart.js");
    clearCart();
  },

  "products:filter": async (e) => {
    const btn = e.target.closest("[data-category]");
    if (!btn) return;
    const category = btn.dataset.category;
    if (!category) return;

    const { setCategory } = await import("./products.js");
    await setCategory(category);
  },

  "products:sort": async (e) => {
    const sort = e.target.value;
    if (!sort) return;
    const { setSort } = await import("./products.js");
    setSort(sort);
  },

  "products:search": async (e) => {
    const query = e.target.value;
    const { setSearch } = await import("./products.js");
    setSearch(query);
  },

  "products:filter-stock": async (e) => {
    const { setInStock } = await import("./products.js");
    setInStock(e.target.checked);
  },

  "products:filter-promos": async (e) => {
    const { setPromos } = await import("./products.js");
    setPromos(e.target.checked);
  },

  "products:filter-reset": async () => {
    const checkStock = document.getElementById("filterInStock");
    const checkPromos = document.getElementById("filterPromos");
    if (checkStock) checkStock.checked = false;
    if (checkPromos) checkPromos.checked = false;

    const searchInput = document.getElementById("productSearch");
    if (searchInput) searchInput.value = "";

    const sortSelect = document.getElementById("sortSelect");
    if (sortSelect) sortSelect.value = "default";

    const { clearAllFilters } = await import("./products.js");
    clearAllFilters();

    showToast(t("filterReset") || "Filtres réinitialisés");
  },

  "account:open": async () => {
    const { openAccountModal } = await import("./ui.js");
    await openAccountModal();
  },

  "account:close": async () => {
    const { closeAccountModal } = await import("./ui.js");
    closeAccountModal();
  },

  logout: async () => {
    const { logoutUser } = await import("./auth.js");
    const { closeAccountModal, updateAccountButton } = await import("./ui.js");
    await logoutUser();
    closeAccountModal();
    showToast(t("logout"));
    updateAccountButton();
  },

  "auth:google": async () => {
    const { loginWithGoogle } = await import("./auth.js");
    await loginWithGoogle();
  },

  "auth:facebook": async () => {
    const { loginWithFacebook } = await import("./auth.js");
    await loginWithFacebook();
  },

  "notifications:open": async () => {
    const { openNotificationsPanel } = await import("./notifications.js");
    await openNotificationsPanel();
  },

  "scroll:top": () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  },

  "blog:search": async (e) => {
    const query = e.target.value;
    const { searchBlog } = await import("./blog.js");
    searchBlog(query);
  },

  "lang:change": async (e) => {
    const lang = e.target.value;
    if (!lang) return;

    setLang(lang);
    applyTranslations();

    const path = window.location.pathname;

    const isHome =
      path === "/" ||
      path.endsWith("index.html") ||
      path === "" ||
      document.getElementById("produits") !== null;

    const isBlog =
      path.endsWith("blog.html") ||
      path === "/blog" ||
      path.endsWith("/blog") ||
      document.getElementById("blogGrid") !== null;

    const isProduct =
      path.endsWith("produit.html") ||
      path === "/produit" ||
      path.endsWith("/produit") ||
      document.querySelector("main[data-product-page]") !== null;

    const isVilles =
      path.endsWith("villesmaroc.html") ||
      path === "/villes" ||
      path.endsWith("/villes") ||
      document.getElementById("villesTbody") !== null;

    const isCartPage =
      path.endsWith("panier.html") ||
      path === "/panier" ||
      path.endsWith("/panier") ||
      document.getElementById("cartPageContent") !== null;

    if (isHome) {
      const grid = document.getElementById("productsGrid");
      if (grid) {
        grid.innerHTML = ` <div style="grid-column:1/-1;text-align:center;padding:3rem 1rem;"> <div class="spinner" style="margin:0 auto;"></div> </div> `;
      }

      Promise.all([
        import("./products.js").then((m) => {
          m.renderCategoryFilters();
          m.renderSortOptions();
          return m.renderProducts();
        }),
        import("./banner.js")
          .then((m) => m.refreshBanners())
          .catch(() => {}),
        import("./testimonials.js")
          .then((m) => m.initDynamicTestimonials())
          .catch(() => {}),
      ]).catch((err) => console.warn("[events] Re-render home failed:", err));
    }

    if (isBlog) {
      import("./blog.js")
        .then((m) => m.renderBlogList?.())
        .catch((err) => console.warn("[events] Re-render blog failed:", err));
    }

    if (isProduct) {
      try {
        const { getProducts } = await import("./store.js");
        const { getProductName } = await import("./utils.js");
        const params = new URLSearchParams(window.location.search);
        const slug = params.get("slug");
        if (slug) {
          const product = getProducts().find((p) => p.slug === slug);
          if (product) {
            document.title = `${getProductName(product)} | Smart Swi9a`;
          }
        }
      } catch (err) {
        console.warn("[events] Sync title update failed:", err);
      }

      import("./product-detail.js")
        .then((m) => m.renderProductDetail?.())
        .catch((err) =>
          console.warn("[events] Re-render product failed:", err)
        );
    }

    if (isVilles) {
      console.log("[events] Page villes : refresh géré en interne");
    }

    if (isCartPage) {
      console.log(
        "[events] Page panier : refresh géré par panier.js (event lang-changed)"
      );
    }
  },
};

/* ============================================================ FERMER LE MENU MOBILE ============================================================ */
function closeMobileMenu() {
  const burger = document.getElementById("burgerBtn");
  const mobile = document.getElementById("mobileMenu");
  if (burger && mobile && mobile.classList.contains("open")) {
    burger.classList.remove("open");
    mobile.classList.remove("open");
    burger.setAttribute("aria-expanded", "false");
  }
}

/* ============================================================ APPLIQUER LES TRADUCTIONS ============================================================ */

/** * Applique les traductions à tous les éléments marqués : * - data-key : textContent (ou innerHTML si la clé finit par "Html", * ou placeholder si input/textarea) * - data-aria-key : attribut aria-label * - .logo-text / .footer-logo : logo (traduit) * - <title> : clé selon la page * - <meta property="og:locale"> : locale selon la langue * - <html lang="xxx" dir="ltr|rtl"> : attributs globaux * * Utilisée au démarrage (app.js) et au changement de langue (events.js). * Importée aussi par 404.html et reset-password.html. * * @returns {void} */
export function applyTranslations() {
  document.querySelectorAll("[data-key]").forEach((el) => {
    const key = el.getAttribute("data-key");
    if (!key) return;
    const value = t(key);
    if (!value || value === key) return;

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.placeholder !== undefined) el.placeholder = value;
    } else if (key.endsWith("Html") || key === "heroTitleHtml") {
      el.innerHTML = value;
    } else {
      el.textContent = value;
    }
  });

  document.querySelectorAll("[data-aria-key]").forEach((el) => {
    const key = el.getAttribute("data-aria-key");
    if (!key) return;
    const value = t(key);
    if (value && value !== key) el.setAttribute("aria-label", value);
  });

  const logoVal = t("logoText");
  if (logoVal && logoVal !== "logoText") {
    document.querySelectorAll(".logo-text").forEach((el) => {
      el.textContent = logoVal;
    });
    document.querySelectorAll(".footer-logo").forEach((el) => {
      el.textContent = logoVal;
    });
  }

  const titleEl = document.querySelector("title");
  if (titleEl) {
    const path = window.location.pathname;
    let titleKey = null;
    if (path === "/" || path.endsWith("index.html")) titleKey = "pageTitle";
    else if (
      path.endsWith("blog.html") ||
      path === "/blog" ||
      path.endsWith("/blog")
    )
      titleKey = "blogPageTitle";
    else if (
      path.endsWith("villesmaroc.html") ||
      path === "/villes" ||
      path.endsWith("/villes")
    )
      titleKey = "villesPageTitle";
    else if (
      path.endsWith("panier.html") ||
      path === "/panier" ||
      path.endsWith("/panier")
    )
      titleKey = "cartPageTitle";
    else if (path.endsWith("404.html")) titleKey = "pageNotFoundTitle";
    else if (path.endsWith("reset-password.html"))
      titleKey = "resetPasswordTitle";

    if (titleKey) {
      const tVal = t(titleKey);
      if (tVal && tVal !== titleKey) titleEl.textContent = tVal;
    }
  }

  const localeMap = { fr: "fr_FR", ar: "ar_MA", en: "en_US" };
  const ogLocale = document.querySelector('meta[property="og:locale"]');
  if (ogLocale)
    ogLocale.setAttribute("content", localeMap[getLang()] || "fr_FR");

  document.documentElement.lang = getLang();
  document.documentElement.dir = getLang() === "ar" ? "rtl" : "ltr";
}

/* ============================================================ DEBOUNCE SÉPARÉ (par action) ============================================================ products:search et blog:search sont debouncés à 300ms. searchTimers garde une référence par action pour pouvoir annuler proprement. ============================================================ */
const searchTimers = {
  "products:search": null,
  "blog:search": null,
};

/* ============================================================ ATTACHER LES ÉVÉNEMENTS ============================================================ */

/** * Attache tous les listeners délégués sur document. * * Idempotent : si appelé 2× (double include, HMR), le 2ème appel * est ignoré grâce au guard _eventsAttached. * * Listeners attachés : * 1. click extérieur → ferme le menu mobile (si ouvert) * 2. click délégation → data-action (17 handlers) + fallbacks * (pagination, add-to-cart, favoris, whatsapp, product-card, * blog-card) * 3. keydown ESC → ferme le menu mobile * 4. change (select, checkbox) → data-action * 5. input (debounce 300ms sur search) → data-action * 6. scroll → afficher/masquer back-to-top * 7. cart-updated → re-render contenu panier si sidebar ouverte * * @returns {void} */
export function attachEvents() {
  if (_eventsAttached) {
    console.log("[events] Événements déjà attachés - skip");
    return;
  }
  _eventsAttached = true;

  /* ============================================ LISTENER 1 : FERMETURE MENU MOBILE AU CLIC EXTÉRIEUR ============================================ */
  document.addEventListener("click", (e) => {
    const mobileMenu = document.getElementById("mobileMenu");
    const burgerBtn = document.getElementById("burgerBtn");

    if (!mobileMenu || !mobileMenu.classList.contains("open")) return;
    if (burgerBtn && burgerBtn.contains(e.target)) return;
    if (mobileMenu.contains(e.target)) return;

    closeMobileMenu();
  });

  /* ============================================ LISTENER 2 : DÉLÉGATION PRINCIPALE (clicks) ============================================ */
  document.addEventListener("click", (e) => {
    const actionEl = e.target.closest("[data-action]");
    if (actionEl) {
      if (actionEl.id === "burgerBtn") return;

      const action = actionEl.dataset.action;
      const handler = eventHandlers[action];
      if (handler) {
        handler(e);
        return;
      }
    }

    /* ============ FALLBACK DÉLÉGATIONS ============ */

    /* Pagination produits (IDs toujours numériques → parseInt OK) */
    const pageBtn = e.target.closest(".pagination-btn:not(.disabled)");
    if (pageBtn && pageBtn.dataset.page) {
      const page = parseInt(pageBtn.dataset.page);
      if (!isNaN(page)) {
        import("./products.js").then((m) => m.goToPage(page));
        return;
      }
    }

    /* Bouton "Ajouter au panier" (produits sans variantes) */
    const addBtn = e.target.closest(".btn-add-to-cart, .btn-product-add");
    if (addBtn && !addBtn.closest("[data-action]")) {
      e.preventDefault();
      const rawId = addBtn.dataset.id || addBtn.dataset.productId;
      if (rawId != null && rawId !== "") {
        import("./cart.js").then((m) => m.addToCart(rawId));
        return;
      }
    }

    /* Bouton favoris */
    const favBtn = e.target.closest(".favorite-btn");
    if (favBtn && !favBtn.closest("[data-action]")) {
      e.stopPropagation();
      const rawId = favBtn.dataset.id;
      if (rawId != null && rawId !== "") {
        import("./products.js").then((m) => m.toggleFavorite(rawId));
        return;
      }
    }

    /* Bouton "Commander via WhatsApp" (page produit) */
    const waBtn = e.target.closest(".btn-secondary[data-product-id]");
    if (waBtn && !waBtn.closest("[data-action]")) {
      e.preventDefault();
      const rawId = waBtn.dataset.productId;
      if (rawId != null && rawId !== "") {
        import("./whatsapp.js").then((m) => m.orderViaWhatsApp(rawId));
        return;
      }
    }

    /* Carte produit (navigation) */
    const card = e.target.closest(".product-card");
    if (card && !e.target.closest("button") && !e.target.closest("a")) {
      const slug = card.dataset.slug;
      const rawId = card.dataset.id;
      if (slug) {
        import("./products.js").then((m) => m.openProductPage(slug));
        return;
      } else if (rawId != null && rawId !== "") {
        import("./products.js").then((m) => {
          const p = m.getProductById(rawId);
          if (p && p.slug) m.openProductPage(p.slug);
        });
        return;
      }
    }

    /* Carte blog (ouverture modal) — postId est déjà une string Firestore */
    const blogCard = e.target.closest(".blog-card");
    if (blogCard && !e.target.closest("button, a")) {
      const postId = blogCard.dataset.id;
      if (postId) {
        import("./blog.js").then((m) => m.openBlogArticle(postId));
        return;
      }
    }
  });

  /* ============================================ LISTENER 3 : ESC → fermer menu mobile ============================================ */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMobileMenu();
    }
  });

  /* ============================================ LISTENER 4 : CHANGE (select, checkbox) ============================================ */
  document.addEventListener("change", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (eventHandlers[action]) {
      eventHandlers[action](e);
    }
  });

  /* ============================================ LISTENER 5 : INPUT (debounce séparé par action) ============================================ */
  document.addEventListener("input", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;

    if (action in searchTimers) {
      if (searchTimers[action]) clearTimeout(searchTimers[action]);
      searchTimers[action] = setTimeout(() => {
        if (eventHandlers[action]) eventHandlers[action](e);
        searchTimers[action] = null;
      }, 300);
    } else if (eventHandlers[action]) {
      eventHandlers[action](e);
    }
  });

  /* ============================================ LISTENER 6 : BACK TO TOP ============================================ */
  const backToTop = document.getElementById("backToTopBtn");
  if (backToTop && !backToTop._initialized) {
    window.addEventListener(
      "scroll",
      () => {
        if (window.scrollY > 400) backToTop.classList.add("visible");
        else backToTop.classList.remove("visible");
      },
      { passive: true }
    );
    backToTop.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    backToTop._initialized = true;
  }

  /* ============================================ LISTENER 7 : PANIER MIS À JOUR (sidebar legacy) ============================================ */
  document.addEventListener("cart-updated", () => {
    const sidebar = document.getElementById("cartSidebar");
    if (sidebar && sidebar.classList.contains("open")) {
      import("./ui.js").then((m) => m.renderCartContent());
    }
  });

  console.log(
    "✅ events.js chargé - v9.0.0 (Lot 22 : nettoyage emojis + JSDoc)"
  );
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ events.js chargé - v9.0.0 (Lot 22 : handlers 17 + 6 fallbacks)"
);