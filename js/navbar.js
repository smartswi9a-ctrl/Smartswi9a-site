// js/navbar.js
// ============================================================
// NAVBAR AUTONOME - SMART SWI9A
// Version 2.0.0 — Fix overflow conflict, guards, cleanup
// ============================================================
// CHANGEMENTS v2.0.0 :
// ✅ I18.1 — body.overflow : check isAnyModalOpen() avant restore
// ✅ I18.2 — Resize listener avec guard (pas d'accumulation)
// ✅ M18.1 — window globals retirés (inutilisés)
// ✅ M18.2 — Guard _navbarInitialized (anti double include)
// ✅ M18.3 — touchstart dead code retiré
// ============================================================
// ⚠️ NON-MODULE : à charger avec <script src="/js/navbar.js"></script>
//    (sans type="module") juste après la navbar HTML.
//
// Fonctionne même si app.js/events.js échouent.
// ============================================================

(function() {
    'use strict';

    // ============================================================
    // ✅ M18.2 : Guard anti double-include
    // ------------------------------------------------------------
    // Si le script est chargé 2× (ex: HMR, ou balise dupliquée),
    // les listeners s'accumuleraient. Ce guard l'empêche.
    // ============================================================
    if (window._navbarInitialized) {
        console.log('ℹ️ navbar.js : déjà initialisé — skip');
        return;
    }
    window._navbarInitialized = true;

    console.log('🔧 navbar.js : chargement (v2.0.0)...');

    // ============================================================
    // HELPERS
    // ============================================================

    /**
     * ✅ I18.1 : détecter si une autre modale est ouverte
     * (account, cart, notifications, blog, confirm, admin...)
     * Utilisé pour ne PAS écraser l'overflow quand le burger menu
     * se ferme alors qu'une autre modale est toujours ouverte.
     */
    function isAnyModalOpen() {
        return document.querySelector(
            '.modal-overlay.open, ' +
            '.blog-article-modal.open, ' +
            '#cartOverlay.open, ' +
            '#cartSidebar.open'
        ) !== null;
    }

    function getBurger() {
        return document.getElementById('burgerBtn');
    }

    function getMobileMenu() {
        return document.getElementById('mobileMenu');
    }

    // ============================================================
    // OPEN / CLOSE
    // ============================================================
    function openMenu() {
        var burger = getBurger();
        var mobile = getMobileMenu();
        if (!burger || !mobile) return;
        if (mobile.classList.contains('open')) return;

        mobile.classList.add('open');
        burger.classList.add('open');
        burger.setAttribute('aria-expanded', 'true');

        // ✅ I18.1 : sauvegarder l'overflow UNIQUEMENT si on est
        // le premier à le bloquer (pour ne pas écraser une modale
        // qui aurait déjà mis 'hidden')
        if (document.body.style.overflow !== 'hidden') {
            mobile._previousOverflow = document.body.style.overflow || '';
        }
        document.body.style.overflow = 'hidden';

        console.log('✅ Menu ouvert');
    }

    function closeMenu() {
        var burger = getBurger();
        var mobile = getMobileMenu();
        if (!burger || !mobile) return;
        if (!mobile.classList.contains('open')) return;

        mobile.classList.remove('open');
        burger.classList.remove('open');
        burger.setAttribute('aria-expanded', 'false');

        // ✅ I18.1 : ne PAS écraser l'overflow d'une autre modale ouverte
        // (ex: user a ouvert le compte, puis a fermé le burger → on ne
        // doit pas libérer le scroll car le compte est toujours ouvert)
        if (!isAnyModalOpen()) {
            document.body.style.overflow = mobile._previousOverflow || '';
        }
        mobile._previousOverflow = undefined;

        console.log('✅ Menu fermé');
    }

    function toggleMenu() {
        var mobile = getMobileMenu();
        if (!mobile) return;
        if (mobile.classList.contains('open')) closeMenu();
        else openMenu();
    }

    // ============================================================
    // LISTENER 1 : clic sur le burger (délégation capture)
    // ------------------------------------------------------------
    // Capture phase = s'exécute AVANT events.js → évite le double
    // toggle (le handler 'menu:toggle' d'events.js est ignoré).
    // ============================================================
    document.addEventListener('click', function(e) {
        var burger = getBurger();
        if (!burger) return;

        if (burger === e.target || burger.contains(e.target)) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            toggleMenu();
            return;
        }
    }, true); // ← capture phase

    // ============================================================
    // LISTENER 2 : fermeture auto (clic extérieur, lien)
    // ============================================================
    document.addEventListener('click', function(e) {
        var mobile = getMobileMenu();
        if (!mobile || !mobile.classList.contains('open')) return;

        // Clic sur un lien du menu → fermer (avant navigation)
        var link = e.target.closest('a');
        if (link && mobile.contains(link)) {
            closeMenu();
            return;
        }

        // Clic en dehors → fermer
        var burger = getBurger();
        if (burger && burger.contains(e.target)) return;
        if (mobile.contains(e.target)) return;

        closeMenu();
    }, false);

    // ============================================================
    // LISTENER 3 : touche Escape
    // ============================================================
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeMenu();
    });

    // ============================================================
    // ✅ I18.2 : LISTENER 4 : retour desktop (auto-close)
    // ------------------------------------------------------------
    // Guard via _navbarInitialized (déjà en haut du fichier) → pas
    // d'accumulation de listeners resize.
    // ============================================================
    window.addEventListener('resize', function() {
        if (window.innerWidth > 900) closeMenu();
    });

    // ============================================================
    // ✅ M18.1 : window globals supprimés
    // ------------------------------------------------------------
    // Anciennement : window._navbarClose, window._navbarToggle
    // Aucun fichier du projet ne les utilisait (grep = 0 résultat).
    // Supprimés pour éviter la pollution globale.
    // ============================================================

    // ============================================================
    // ✅ M18.3 : touchstart dead code retiré
    // ------------------------------------------------------------
    // L'ancien listener faisait juste un console.log sans logique
    // utile. Le click handler fonctionne déjà sur mobile (les
    // navigateurs émulent click après touchstart).
    // ============================================================

    console.log('✅ navbar.js : prêt (4 listeners, v2.0.0)');
})();