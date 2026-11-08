/* ============================================================ js/navbar.js NAVBAR AUTONOME - SMARTSWIKA Version 9.0.0 - Lot 23/30 : fix isAnyModalOpen + ALERTE 1 CHANGEMENTS v9.0.0 : - B-NAV-1 (P2) : isAnyModalOpen() couvre maintenant TOUTES les modales du projet (accountModal, notificationsPanel, sizeGuideModal, orderDetailsModal, returnModal, categoryModal, pickupModal, productModal, withdrawModal, contractModal, v-modal, blog-article-modal). Empêche le scroll fantôme quand une modale non couverte est ouverte + burger ouvert + resize. - B-NAV-2 (P3) : tous les commentaires // en début de ligne utile convertis en blocs (ALERTE 1). - B-NAV-3 (P3) : emojis des logs remplacés par préfixe [navbar]. - B-NAV-4 (P3) : JSDoc sur les fonctions internes. - Bump version 2.0.0 -> 9.0.0. NOTE IMPORTANTE : Ce fichier est un IIFE NON-MODULE. Il est chargé via <script src="/js/navbar.js"></script> dans 10 pages HTML (index, 404, admin, blog, boutique, panier, produit, inscription-vendeur, villesmaroc, reset-password). NE PAS ajouter d'export ES ni de type="module" côté HTML. RAPPEL COMPORTEMENTAL : Ce script fonctionne INDÉPENDAMMENT de app.js / events.js. Si ces modules échouent au chargement, le burger reste fonctionnel. C'est intentionnel (résilience). ============================================================ */

(function () {
  "use strict";

  /* ============================================================ GUARD ANTI DOUBLE-INCLUDE ============================================================ Si le script est chargé 2× (double balise, HMR), on skip. Empêche le cumul de listeners sur document/window. ============================================================ */
  if (window._navbarInitialized) {
    console.log("[navbar] Déjà initialisé - skip");
    return;
  }
  window._navbarInitialized = true;

  console.log("[navbar] Chargement...");

  /* ============================================================ HELPERS ============================================================ */

  /** * Détecte si AU MOINS une modale est ouverte dans la page. * Utilisé pour ne PAS écraser l'overflow du body quand le * burger se ferme alors qu'une autre modale est toujours * ouverte (sinon scroll fantôme derrière la modale). * * B-NAV-1 : couvre toutes les modales du projet. Ajouter * ici tout nouveau sélecteur `.open` si on crée une nouvelle * modale dans un futur lot. * * @returns {boolean} */
  function isAnyModalOpen() {
    var SELECTORS = [
      ".modal-overlay.open" /* modal-overlay générique (admin, pickup, contract, etc.) */,
      ".blog-article-modal.open" /* blog.js (Lot 17) */,
      "#cartOverlay.open" /* legacy sidebar panier */,
      "#cartSidebar.open" /* legacy sidebar panier */,
      "#accountModal.open" /* ui.js (Lot 21) */,
      "#notificationsPanel.open" /* notifications.js (Lot 11) */,
      "#sizeGuideModal.open" /* product-detail.js (Lot 20) */,
      "#orderDetailsModal.open" /* orders.js (Lot 12) */,
      "#returnModal.open" /* orders.js (Lot 12) */,
      "#categoriesMenuModal.open" /* categories-menu.js (Lot 19) */,
      ".v-modal.open" /* vendor-dashboard.js (Lot 29) */,
      "#vWithdrawModal.open" /* vendor-dashboard.js */,
      "#vProductModal.open" /* vendor-dashboard.js */,
      "#vContractModal.open" /* vendor-dashboard.js */,
    ];
    return document.querySelector(SELECTORS.join(", ")) !== null;
  }

  function getBurger() {
    return document.getElementById("burgerBtn");
  }

  function getMobileMenu() {
    return document.getElementById("mobileMenu");
  }

  /* ============================================================ OUVERTURE / FERMETURE ============================================================ */

  /** * Ouvre le menu mobile. No-op si déjà ouvert ou si les * éléments sont absents (page sans navbar). * Sauvegarde l'overflow actuel du body avant de le passer à * "hidden" (sauf si déjà "hidden", auquel cas c'est qu'une * autre modale l'a déjà posé). * @returns {void} */
  function openMenu() {
    var burger = getBurger();
    var mobile = getMobileMenu();
    if (!burger || !mobile) return;
    if (mobile.classList.contains("open")) return;

    mobile.classList.add("open");
    burger.classList.add("open");
    burger.setAttribute("aria-expanded", "true");

    if (document.body.style.overflow !== "hidden") {
      mobile._previousOverflow = document.body.style.overflow || "";
    }
    document.body.style.overflow = "hidden";
  }

  /** * Ferme le menu mobile. No-op si déjà fermé. * Restaure l'overflow UNIQUEMENT si aucune autre modale n'est * ouverte (sinon on libère le scroll alors qu'une modale est * toujours affichée). * @returns {void} */
  function closeMenu() {
    var burger = getBurger();
    var mobile = getMobileMenu();
    if (!burger || !mobile) return;
    if (!mobile.classList.contains("open")) return;

    mobile.classList.remove("open");
    burger.classList.remove("open");
    burger.setAttribute("aria-expanded", "false");

    if (!isAnyModalOpen()) {
      document.body.style.overflow = mobile._previousOverflow || "";
    }
    mobile._previousOverflow = undefined;
  }

  /** * Toggle le menu mobile. * @returns {void} */
  function toggleMenu() {
    var mobile = getMobileMenu();
    if (!mobile) return;
    if (mobile.classList.contains("open")) closeMenu();
    else openMenu();
  }

  /* ============================================================ LISTENER 1 : CLIC SUR LE BURGER (phase capture) ============================================================ Capture phase = s'exécute AVANT events.js. Empêche le double toggle (le handler 'menu:toggle' d'events.js ne s'applique pas au burger). ============================================================ */
  document.addEventListener(
    "click",
    function (e) {
      var burger = getBurger();
      if (!burger) return;

      if (burger === e.target || burger.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        toggleMenu();
        return;
      }
    },
    true
  );

  /* ============================================================ LISTENER 2 : FERMETURE AUTO (clic extérieur OU lien du menu) ============================================================ */
  document.addEventListener(
    "click",
    function (e) {
      var mobile = getMobileMenu();
      if (!mobile || !mobile.classList.contains("open")) return;

      /* Clic sur un lien du menu → fermer (avant navigation). */
      var link = e.target.closest("a");
      if (link && mobile.contains(link)) {
        closeMenu();
        return;
      }

      /* Clic en dehors → fermer. */
      var burger = getBurger();
      if (burger && burger.contains(e.target)) return;
      if (mobile.contains(e.target)) return;

      closeMenu();
    },
    false
  );

  /* ============================================================ LISTENER 3 : TOUCHE ESCAPE ============================================================ */
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeMenu();
  });

  /* ============================================================ LISTENER 4 : RESIZE (retour desktop, auto-close) ============================================================ Guard via window._navbarInitialized (déjà en haut) empêche l'accumulation de listeners resize. ============================================================ */
  window.addEventListener("resize", function () {
    if (window.innerWidth > 900) closeMenu();
  });

  console.log("[navbar] Prêt (4 listeners, v9.0.0)");
})();