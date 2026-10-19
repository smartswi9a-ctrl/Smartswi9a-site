// js/navbar.js
// ============================================================
// NAVBAR AUTONOME - SMART SWI9A
// Version 1.0.0 — Gestion burger menu SANS dépendance
// ============================================================
// ⚠️ NON-MODULE : à charger avec <script src="/js/navbar.js"></script>
//    (sans type="module") juste après la navbar HTML.
//
// Fonctionne même si app.js/events.js échouent.
// ============================================================

(function() {
    'use strict';

    console.log('🔧 navbar.js : chargement...');

    // ============================================================
    // TOGGLE MENU
    // ============================================================
    function toggleMenu() {
        var burger = document.getElementById('burgerBtn');
        var mobile = document.getElementById('mobileMenu');
        if (!burger || !mobile) return;

        var isOpen = mobile.classList.contains('open');
        console.log('🍔 Toggle burger — état actuel :', isOpen ? 'OUVERT' : 'FERMÉ');

        if (isOpen) {
            closeMenu();
        } else {
            openMenu();
        }
    }

    function openMenu() {
        var burger = document.getElementById('burgerBtn');
        var mobile = document.getElementById('mobileMenu');
        if (!burger || !mobile) return;

        mobile.classList.add('open');
        burger.classList.add('open');
        burger.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
        console.log('✅ Menu ouvert');
    }

    function closeMenu() {
        var burger = document.getElementById('burgerBtn');
        var mobile = document.getElementById('mobileMenu');
        if (!burger || !mobile) return;
        if (!mobile.classList.contains('open')) return;

        mobile.classList.remove('open');
        burger.classList.remove('open');
        burger.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
        console.log('✅ Menu fermé');
    }

    // Exposer globalement (pour debug)
    window._navbarClose = closeMenu;
    window._navbarToggle = toggleMenu;

    // ============================================================
    // LISTENER 1 : clic sur le burger (délégation capture)
    // ============================================================
    document.addEventListener('click', function(e) {
        var burger = document.getElementById('burgerBtn');
        if (!burger) return;

        // Le clic vient du burger ou d'un de ses enfants (span) ?
        if (burger === e.target || burger.contains(e.target)) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            toggleMenu();
            return;
        }
    }, true); // capture = true → passe AVANT tout autre handler

    // ============================================================
    // LISTENER 2 : fermeture auto (clic extérieur, lien, escape)
    // ============================================================
    document.addEventListener('click', function(e) {
        var mobile = document.getElementById('mobileMenu');
        if (!mobile || !mobile.classList.contains('open')) return;

        // Clic sur un lien du menu → fermer
        var link = e.target.closest('a');
        if (link && mobile.contains(link)) {
            closeMenu();
            return;
        }

        // Clic en dehors → fermer
        var burger = document.getElementById('burgerBtn');
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
    // LISTENER 4 : retour en mode desktop
    // ============================================================
    window.addEventListener('resize', function() {
        if (window.innerWidth > 900) closeMenu();
    });

    // ============================================================
    // LISTENER 5 : fallback sur touchstart (mobile)
    // ============================================================
    document.addEventListener('touchstart', function(e) {
        var burger = document.getElementById('burgerBtn');
        if (!burger) return;
        if (burger === e.target || burger.contains(e.target)) {
            // Ne pas preventDefault ici → laisse le click suivre
            // (sinon certains navigateurs bloquent la suite)
            console.log('👆 Touch sur burger détecté');
        }
    }, { passive: true, capture: true });

    console.log('✅ navbar.js : prêt (5 listeners attachés)');
})();