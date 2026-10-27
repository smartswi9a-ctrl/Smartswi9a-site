/* ============================================================ js/categories-menu.js MENU VISUEL DES CATÉGORIES - SMART SWI9A Version 9.0.0 - Lot 19/30 : fix navigation + accessibilité CHANGEMENTS v9.0.0 : - B-CAT-1 (P1 CRITIQUE) : navigation cassée corrigée. AVANT : window.location.href = '/#produits?cat=' + catId -> le ?cat= était DANS le fragment (#), jamais parsé. APRÈS : window.location.href = '/?cat=' + catId + '#produits' -> query string AVANT le hash, correctement lisible. + Sur la page d'accueil : pas de navigation, juste setCategory() + scrollIntoView smooth. + Auto-init au chargement du module : lit ?cat de l'URL (ou sessionStorage en fallback) et applique après chargement des produits. ⚠️ L'auto-init ne fonctionne QUE si le module est importé au chargement de la page. À brancher eager dans app.js au Lot 25. En attendant : navigation intra-accueil OK, cross-page à valider au Lot 25. - B-CAT-2 (P2) : listener keydown ESC pour fermer. - B-CAT-3 (P2) : focus trap via trapFocus() de ui-core.js. - B-CAT-4 (P2) : guard _openInProgress sur openCategoriesMenu. - B-CAT-5 (P2) : reset activeParentId sur closeCategoriesMenu (revient à la 1ère catégorie à chaque ouverture). - B-CAT-6 (P3) : onerror image - guard nextElementSibling. - B-CAT-7 (P3) : viewAllCategoryBtn converti en <a href>. - JSDoc sur openCategoriesMenu et closeCategoriesMenu. - Bump version 1.2.1 -> 9.0.0. ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import { CATEGORY_GROUPS } from "./config.js";
import { t } from "./utils.js";
import { setCategory } from "./products.js";
import { trapFocus, releaseFocusTrap } from "./ui-core.js";

/* ============================================================ ÉTAT MODULE ============================================================ */
let activeParentId = null;

/* B-CAT-4 : guard contre les open rapides (double-clic). */
let _openInProgress = false;

/* B-CAT-2 : référence du handler ESC pour cleanup. */
let _escHandler = null;

/* Clé sessionStorage pour le fallback de catégorie cross-page. */
const PENDING_CATEGORY_KEY = "swi9a_pending_category";

/* ============================================================ HELPERS NAVIGATION (B-CAT-1) ============================================================ */

/** * Applique une catégorie et gère la navigation cross-page. * * - Sur la page d'accueil (/, /index.html) : appel direct à * setCategory() + scroll smooth vers #produits. Aucune * navigation, l'état est déjà en place. * - Sur une autre page : navigue vers /?cat=xxx#produits * (query AVANT hash, correctement parsé par app.js). * Stocke aussi en sessionStorage en fallback. * * @param {string} catId - 'all', 'smartphones', etc. * @returns {void} */
function applyCategoryAndNavigate(catId) {
  if (!catId) return;

  /* Détection page d'accueil. */
  const path = window.location.pathname;
  const isHome = path === "/" || path === "" || path.endsWith("/index.html");

  closeCategoriesMenu();

  /* Applique immédiatement (met à jour le state + render). */
  try {
    setCategory(catId);
  } catch (e) {
    console.warn("[categories-menu] setCategory échoué :", e);
  }

  if (isHome) {
    /* Déjà sur place : scroll smooth vers les produits. */
    setTimeout(() => {
      const produitsEl = document.getElementById("produits");
      if (produitsEl)
        produitsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  } else {
    /* Navigation cross-page. Fallback sessionStorage au cas où app.js ne branche pas encore l'auto-init ?cat (Lot 25). */
    try {
      sessionStorage.setItem(PENDING_CATEGORY_KEY, catId);
    } catch (e) {
      /* quota/private mode - non bloquant */
    }

    window.location.href = `/?cat=${encodeURIComponent(catId)}#produits`;
  }
}

/* ============================================================ AUTO-INIT DEPUIS L'URL (B-CAT-1) ============================================================ ⚠️ Ne fonctionne que si ce module est importé AU CHARGEMENT. Actuellement, il n'est importé que dynamiquement (au clic sur le bouton "Catégories"). Donc l'auto-init ne s'exécute pas au chargement initial. Pour rendre ?cat=xxx#produits fonctionnel dès le chargement, app.js (Lot 25) doit importer ce module eagerly et appeler initCategoriesMenuFromUrl() en début d'init. ============================================================ */

/** * Lit ?cat=xxx de l'URL (ou sessionStorage en fallback) et applique * la catégorie après chargement des produits. * * À appeler par app.js au démarrage (Lot 25) pour que la navigation * cross-page fonctionne dès le chargement. * * @returns {Promise<void>} */
export async function initCategoriesMenuFromUrl() {
  let catParam = null;

  /* 1. Query string ?cat=xxx */
  try {
    const params = new URLSearchParams(window.location.search);
    catParam = params.get("cat");
  } catch (e) {
    /* ignore */
  }

  /* 2. Fallback sessionStorage (posé par applyCategoryAndNavigate). */
  if (!catParam) {
    try {
      catParam = sessionStorage.getItem(PENDING_CATEGORY_KEY);
      if (catParam) sessionStorage.removeItem(PENDING_CATEGORY_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  if (!catParam) return;

  /* Attendre le chargement des produits avant d'appliquer. */
  try {
    const { getProductsLoadedPromise } = await import("./store.js");
    const promise = getProductsLoadedPromise();
    if (promise) {
      await promise;
    }
  } catch (e) {
    console.warn(
      "[categories-menu] getProductsLoadedPromise indisponible :",
      e
    );
  }

  try {
    setCategory(catParam);
    setTimeout(() => {
      const produitsEl = document.getElementById("produits");
      if (produitsEl)
        produitsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
  } catch (e) {
    console.warn("[categories-menu] Application catégorie URL échouée :", e);
  }
}

/* ============================================================ OUVERTURE / FERMETURE ============================================================ */

/** * Ouvre le menu visuel des catégories. * Idempotent : appelée plusieurs fois d'affilée, ne crée qu'une * modale et n'anime qu'une seule fois. * @returns {void} */
export function openCategoriesMenu() {
  /* B-CAT-4 : guard double-open. */
  if (_openInProgress) return;

  let modal = document.getElementById("categoriesMenuModal");

  /* Création si absente. */
  if (!modal) {
    _openInProgress = true;
    modal = document.createElement("div");
    modal.id = "categoriesMenuModal";
    modal.className = "categories-menu-overlay";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = ` <div class="categories-menu-container"> <div class="categories-menu-header"> <h2>${t("navCategories") || "Toutes les catégories"}</h2> <button id="closeCategoriesMenuBtn" class="modal-close" aria-label="${ t("close") || "Fermer" }">✕</button> </div> <div class="categories-menu-body"> <div class="categories-menu-sidebar" id="categoriesSidebar"></div> <div class="categories-menu-content" id="categoriesContent"></div> </div> </div> `;
    document.body.appendChild(modal);

    document
      .getElementById("closeCategoriesMenuBtn")
      .addEventListener("click", closeCategoriesMenu);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeCategoriesMenu();
    });
  }

  /* Animation d'ouverture. */
  setTimeout(() => {
    modal.classList.add("open");
    _openInProgress = false;
  }, 10);

  document.body.style.overflow = "hidden";

  /* B-CAT-5 : reset à la 1ère catégorie si aucune active. */
  if (!activeParentId && CATEGORY_GROUPS.length > 0) {
    activeParentId = CATEGORY_GROUPS[0].id;
  }

  renderCategoriesSidebar();
  renderCategoriesContent(activeParentId);

  /* B-CAT-2 : ESC pour fermer. */
  if (_escHandler) document.removeEventListener("keydown", _escHandler);
  _escHandler = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCategoriesMenu();
    }
  };
  document.addEventListener("keydown", _escHandler);

  /* B-CAT-3 : focus trap sur la modale. */
  const container = modal.querySelector(".categories-menu-container");
  if (container) trapFocus(container);
}

/** * Ferme le menu visuel des catégories. * Idempotent : no-op si déjà fermé. * @returns {void} */
export function closeCategoriesMenu() {
  const modal = document.getElementById("categoriesMenuModal");
  if (modal) {
    modal.classList.remove("open");
  }
  document.body.style.overflow = "";

  /* B-CAT-5 : reset activeParentId pour revenir à la 1ère catégorie à la prochaine ouverture. */
  activeParentId = null;

  /* B-CAT-2 : cleanup ESC. */
  if (_escHandler) {
    document.removeEventListener("keydown", _escHandler);
    _escHandler = null;
  }

  /* B-CAT-3 : cleanup focus trap. */
  releaseFocusTrap();
}

/* ============================================================ RENDU SIDEBAR (Parents) ============================================================ */
function renderCategoriesSidebar() {
  const sidebar = document.getElementById("categoriesSidebar");
  if (!sidebar) return;

  let html = "";
  CATEGORY_GROUPS.forEach((group) => {
    const isActive = group.id === activeParentId;
    html += ` <button class="category-sidebar-btn ${ isActive ? "active" : "" }" data-parent-id="${group.id}" type="button"> <span style="font-size:1.2rem;margin-bottom:2px;">${ group.emoji }</span> <span style="font-size:0.75rem;font-weight:700;">${t( group.label )}</span> </button> `;
  });
  sidebar.innerHTML = html;

  sidebar.querySelectorAll(".category-sidebar-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeParentId = btn.dataset.parentId;
      renderCategoriesSidebar();
      renderCategoriesContent(activeParentId);
    });
  });
}

/* ============================================================ RENDU CONTENU (Enfants) ============================================================ */
function renderCategoriesContent(parentId) {
  const content = document.getElementById("categoriesContent");
  if (!content) return;

  const parentGroup = CATEGORY_GROUPS.find((g) => g.id === parentId);
  if (!parentGroup) return;

  let html = `<h3 class="categories-content-title">${parentGroup.emoji} ${t( parentGroup.label )}</h3>`;
  html += `<div class="categories-grid">`;

  parentGroup.children.forEach((child) => {
    const imgPath = `/assets/${child.id}.webp`;
    html += ` <div class="category-grid-card" data-category-id="${ child.id }" role="button" tabindex="0"> <div class="category-grid-img-wrapper"> <img src="${imgPath}" alt="${t(child.label)}" loading="lazy" onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='flex';"> <div class="category-grid-fallback" style="display:none;">${ child.emoji }</div> </div> <span class="category-grid-label">${t(child.label)}</span> </div> `;
  });

  html += `</div>`;

  /* B-CAT-7 : bouton "Voir tout" converti en <a> pour accessibilité et support nouvel onglet. */
  html += ` <div style="margin-top: 1.5rem; text-align: center;"> <a class="btn-primary" id="viewAllCategoryBtn" data-category-id="${parentId}" style="display:inline-flex; padding: 0.6rem 1.5rem; font-size: 0.85rem; text-decoration:none;" href="/?cat=${encodeURIComponent( parentId )}#produits"> Voir tout ${t(parentGroup.label)} </a> </div> `;

  content.innerHTML = html;

  /* Clic sur une carte catégorie. */
  content.querySelectorAll(".category-grid-card").forEach((card) => {
    const activate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      applyCategoryAndNavigate(card.dataset.categoryId);
    };
    card.addEventListener("click", activate);
    /* Accessibilité : Entrée/Espace sur les card[role=button]. */
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") activate(e);
    });
  });

  /* B-CAT-7 : le bouton "Voir tout" est un <a>. On intercepte le clic pour garder la même logique (scroll smooth intra-page, ou navigation cross-page). */
  const viewAllBtn = document.getElementById("viewAllCategoryBtn");
  if (viewAllBtn) {
    viewAllBtn.addEventListener("click", (e) => {
      e.preventDefault();
      applyCategoryAndNavigate(viewAllBtn.dataset.categoryId);
    });
  }
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ categories-menu.js chargé - v9.0.0 (Lot 19 : navigation + accessibilité + guards)"
);