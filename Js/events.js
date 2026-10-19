// js/events.js
// ============================================================
// DÉLÉGATION D'ÉVÉNEMENTS GLOBALE - SMART SWI9A
// Version 1.10.0 — Retrait du double handler burger (géré par navbar.js)
// ============================================================

import { t, setLang, getLang } from "./utils.js";
import { showToast } from "./ui-core.js";

// ============================================================
// HANDLERS DES ACTIONS
// ============================================================
const eventHandlers = {

    'cart:open': async () => {
        const { openCart } = await import("./ui.js");
        openCart();
    },
    'cart:close': async () => {
        const { closeCart } = await import("./ui.js");
        closeCart();
    },
    'cart:add': async (e) => {
        const actionEl = e.target.closest('[data-action]');
        const id = parseInt(actionEl?.dataset?.id || e.target.dataset.id);
        if (isNaN(id)) return;
        const { addToCart } = await import("./cart.js");
        await addToCart(id);
    },
    'cart:clear': async () => {
        const { clearCart } = await import("./cart.js");
        clearCart();
    },

    'order:whatsapp': async (e) => {
        const actionEl = e.target.closest('[data-action]');
        const id = parseInt(actionEl?.dataset?.id || e.target.dataset.id);
        if (isNaN(id)) return;
        const { orderViaWhatsApp } = await import("./whatsapp.js");
        orderViaWhatsApp(id);
    },

    'products:filter': async (e) => {
        const category = e.target.dataset.category;
        if (!category) return;
        const { setCategory, renderCategoryFilters } = await import("./products.js");
        setCategory(category);
        renderCategoryFilters();
    },
    'products:sort': async (e) => {
        const sort = e.target.value;
        if (!sort) return;
        const { setSort } = await import("./products.js");
        setSort(sort);
    },
    'products:search': async (e) => {
        const query = e.target.value;
        const { setSearch } = await import("./products.js");
        setSearch(query);
    },
    'products:filter-stock': async (e) => {
        const { setInStock } = await import("./products.js");
        setInStock(e.target.checked);
    },
    'products:filter-promos': async (e) => {
        const { setPromos } = await import("./products.js");
        setPromos(e.target.checked);
    },
    'products:filter-reset': async () => {
        const { clearAllFilters, renderCategoryFilters } = await import("./products.js");
        clearAllFilters();
        renderCategoryFilters();
        const checkStock = document.getElementById('filterInStock');
        const checkPromos = document.getElementById('filterPromos');
        if (checkStock) checkStock.checked = false;
        if (checkPromos) checkPromos.checked = false;
    },
    'products:page': async (e) => {
        const page = parseInt(e.target.dataset.page);
        if (isNaN(page)) return;
        const { goToPage } = await import("./products.js");
        goToPage(page);
    },

    'favorite:toggle': async (e) => {
        e.stopPropagation();
        const id = parseInt(e.target.dataset.id);
        if (isNaN(id)) return;
        const { toggleFavorite } = await import("./products.js");
        await toggleFavorite(id);
    },

    'account:open': async () => {
        const { openAccountModal } = await import("./ui.js");
        await openAccountModal();
    },
    'account:close': async () => {
        const { closeAccountModal } = await import("./ui.js");
        closeAccountModal();
    },
    'logout': async () => {
        const { logoutUser } = await import("./auth.js");
        const { closeAccountModal, updateAccountButton } = await import("./ui.js");
        await logoutUser();
        closeAccountModal();
        showToast('👋 ' + t('logout'));
        updateAccountButton();
    },

    'auth:google': async () => {
        const { loginWithGoogle } = await import("./auth.js");
        await loginWithGoogle();
    },
    'auth:facebook': async () => {
        const { loginWithFacebook } = await import("./auth.js");
        await loginWithFacebook();
    },

    'lang:change': (e) => {
        const lang = e.target.value;
        if (!lang) return;

        setLang(lang);
        applyTranslations();

        const path = window.location.pathname;

        const isHome = path === '/'
            || path.endsWith('index.html')
            || path === ''
            || document.getElementById('produits') !== null;

        const isBlog = path.endsWith('blog.html')
            || path === '/blog'
            || path.endsWith('/blog')
            || document.getElementById('blogGrid') !== null;

        const isProduct = path.endsWith('produit.html')
            || path === '/produit'
            || path.endsWith('/produit')
            || document.querySelector('main[data-product-page]') !== null;

        const isVilles = path.endsWith('villesmaroc.html')
            || path === '/villes'
            || path.endsWith('/villes')
            || document.getElementById('villesTbody') !== null;

        const isCartPage = path.endsWith('panier.html')
            || path === '/panier'
            || path.endsWith('/panier')
            || document.getElementById('cartPageContent') !== null;

        if (isHome) {
            import("./products.js").then(m => {
                m.renderCategoryFilters();
                m.renderProducts();
                m.renderSortOptions();
            });
            import("./banner.js").then(m => m.refreshBanners());
            import("./testimonials.js").then(m => m.initDynamicTestimonials());
        }

        if (isBlog) {
            import("./blog.js").then(m => m.renderBlogList?.());
        }

        if (isProduct) {
            import("./product-detail.js").then(m => m.renderProductDetail?.());
        }

        if (isVilles) {
            console.log('ℹ️ Page villes : refresh géré en interne');
        }

        if (isCartPage) {
            console.log('ℹ️ Page panier : refresh géré par panier.js');
        }
    },

    // ⚠️ Conservé pour la délégation, mais le clic burger est intercepté
    // par navbar.js (capture phase) AVANT d'arriver ici.
    'menu:toggle': () => {
        console.log('ℹ️ menu:toggle : géré par navbar.js — ignoré');
    },

    'notifications:open': async () => {
        const { openNotificationsPanel } = await import("./notifications.js");
        await openNotificationsPanel();
    },

    'scroll:top': () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    'blog:filter': async (e) => {
        const category = e.target.dataset.category;
        if (!category) return;
        const { filterBlogByCategory } = await import("./blog.js");
        filterBlogByCategory(category);
    },
    'blog:search': async (e) => {
        const query = e.target.value;
        const { searchBlog } = await import("./blog.js");
        searchBlog(query);
    },
    'blog:open': async (e) => {
        const actionEl = e.target.closest('[data-action]');
        const postId = actionEl?.dataset?.id;
        if (!postId) return;
        const { openBlogArticle } = await import("./blog.js");
        openBlogArticle(postId);
    },
    'blog:close': async () => {
        const { closeBlogArticle } = await import("./blog.js");
        closeBlogArticle();
    }
};

// ============================================================
// ✅ FERMER LE MENU MOBILE (helper — utilisé au clic extérieur)
// ============================================================
function closeMobileMenu() {
    const burger = document.getElementById('burgerBtn');
    const mobile = document.getElementById('mobileMenu');
    if (burger && mobile && mobile.classList.contains('open')) {
        burger.classList.remove('open');
        mobile.classList.remove('open');
        burger.setAttribute('aria-expanded', 'false');
    }
}

// ============================================================
// APPLIQUER LES TRADUCTIONS
// ============================================================
export function applyTranslations() {
    // 1. data-key → texte / placeholder / innerHTML
    document.querySelectorAll('[data-key]').forEach(el => {
        const key = el.getAttribute('data-key');
        if (!key) return;
        const value = t(key);
        if (!value || value === key) return;

        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            if (el.placeholder !== undefined) el.placeholder = value;
        } else if (key.endsWith('Html') || key === 'heroTitleHtml') {
            el.innerHTML = value;
        } else {
            el.textContent = value;
        }
    });

    // 2. data-aria-key → aria-label
    document.querySelectorAll('[data-aria-key]').forEach(el => {
        const key = el.getAttribute('data-aria-key');
        if (!key) return;
        const value = t(key);
        if (value && value !== key) el.setAttribute('aria-label', value);
    });

    // 3. LOGO (navbar + footer)
    const logoVal = t('logoText');
    if (logoVal && logoVal !== 'logoText') {
        document.querySelectorAll('.logo-text').forEach(el => {
            el.textContent = logoVal;
        });
        document.querySelectorAll('.footer-logo').forEach(el => {
            el.textContent = logoVal;
        });
    }

    // 4. <title> dynamique
    const titleEl = document.querySelector('title');
    if (titleEl) {
        const path = window.location.pathname;
        let titleKey = null;
        if (path === '/' || path.endsWith('index.html')) titleKey = 'pageTitle';
        else if (path.endsWith('blog.html') || path === '/blog' || path.endsWith('/blog')) titleKey = 'blogPageTitle';
        else if (path.endsWith('villesmaroc.html') || path === '/villes' || path.endsWith('/villes')) titleKey = 'villesPageTitle';
        else if (path.endsWith('panier.html') || path === '/panier' || path.endsWith('/panier')) titleKey = 'cartPageTitle';
        else if (path.endsWith('404.html')) titleKey = 'pageNotFoundTitle';
        else if (path.endsWith('reset-password.html')) titleKey = 'resetPasswordTitle';

        if (titleKey) {
            const tVal = t(titleKey);
            if (tVal && tVal !== titleKey) titleEl.textContent = tVal;
        }
    }

    // 5. og:locale
    const localeMap = { fr: 'fr_FR', ar: 'ar_MA', en: 'en_US' };
    const ogLocale = document.querySelector('meta[property="og:locale"]');
    if (ogLocale) ogLocale.setAttribute('content', localeMap[getLang()] || 'fr_FR');

    // 6. html lang + dir
    document.documentElement.lang = getLang();
    document.documentElement.dir = getLang() === 'ar' ? 'rtl' : 'ltr';
}

// ============================================================
// ATTACHER LES ÉVÉNEMENTS GLOBAUX
// ============================================================
export function attachEvents() {

    // ============================================
    // FERMETURE DU MENU MOBILE AU CLIC EXTÉRIEUR
    // (le toggle est géré par navbar.js en capture)
    // ============================================
    document.addEventListener('click', (e) => {
        const mobileMenu = document.getElementById('mobileMenu');
        const burgerBtn = document.getElementById('burgerBtn');

        if (!mobileMenu || !mobileMenu.classList.contains('open')) return;
        if (burgerBtn && burgerBtn.contains(e.target)) return;
        if (mobileMenu.contains(e.target)) return;

        closeMobileMenu();
    });

    // ============================================
    // DÉLÉGATION PRINCIPALE (autres actions)
    // ============================================
    document.addEventListener('click', (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (actionEl) {
            // Le burger est géré par navbar.js → ignorer ici
            if (actionEl.id === 'burgerBtn') return;

            const action = actionEl.dataset.action;
            const handler = eventHandlers[action];
            if (handler) {
                handler(e);
                return;
            }
        }

        const pageBtn = e.target.closest('.pagination-btn:not(.disabled)');
        if (pageBtn && pageBtn.dataset.page) {
            const page = parseInt(pageBtn.dataset.page);
            if (!isNaN(page)) {
                import("./products.js").then(m => m.goToPage(page));
                return;
            }
        }

        const addBtn = e.target.closest('.btn-add-to-cart, .btn-product-add');
        if (addBtn && !addBtn.closest('[data-action]')) {
            e.preventDefault();
            const id = parseInt(addBtn.dataset.id || addBtn.dataset.productId);
            if (!isNaN(id)) {
                import("./cart.js").then(m => m.addToCart(id));
                return;
            }
        }

        const favBtn = e.target.closest('.favorite-btn');
        if (favBtn && !favBtn.closest('[data-action]')) {
            e.stopPropagation();
            const id = parseInt(favBtn.dataset.id);
            if (!isNaN(id)) {
                import("./products.js").then(m => m.toggleFavorite(id));
                return;
            }
        }

        const waBtn = e.target.closest('.btn-secondary[data-product-id]');
        if (waBtn && !waBtn.closest('[data-action]')) {
            e.preventDefault();
            const id = parseInt(waBtn.dataset.productId);
            if (!isNaN(id)) {
                import("./whatsapp.js").then(m => m.orderViaWhatsApp(id));
                return;
            }
        }

        const card = e.target.closest('.product-card');
        if (card && !e.target.closest('button')) {
            const slug = card.dataset.slug;
            const id = parseInt(card.dataset.id);
            if (slug) {
                import("./products.js").then(m => m.openProductPage(slug));
                return;
            } else if (!isNaN(id)) {
                import("./products.js").then(m => {
                    const p = m.getProductById(id);
                    if (p && p.slug) m.openProductPage(p.slug);
                });
                return;
            }
        }

        const blogCard = e.target.closest('.blog-card');
        if (blogCard && !e.target.closest('button, a')) {
            const postId = blogCard.dataset.id;
            if (postId) {
                import("./blog.js").then(m => m.openBlogArticle(postId));
                return;
            }
        }
    });

    // ============================================
    // ESC → fermer menu
    // ============================================
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeMobileMenu();
        }
    });

    // ============================================
    // CHANGEMENTS (select, checkbox)
    // ============================================
    document.addEventListener('change', (e) => {
        const target = e.target.closest('[data-action]');
        if (target) {
            const action = target.dataset.action;
            if (eventHandlers[action]) {
                eventHandlers[action](e);
            }
        }
    });

    // ============================================
    // SAISIES (input) — debounce
    // ============================================
    let searchTimer = null;
    document.addEventListener('input', (e) => {
        const target = e.target.closest('[data-action]');
        if (target) {
            const action = target.dataset.action;
            if (action === 'products:search' || action === 'blog:search') {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    if (eventHandlers[action]) eventHandlers[action](e);
                }, 300);
            } else if (eventHandlers[action]) {
                eventHandlers[action](e);
            }
        }
    });

    // ============================================
    // BACK TO TOP
    // ============================================
    const backToTop = document.getElementById('backToTopBtn');
    if (backToTop && !backToTop._initialized) {
        window.addEventListener('scroll', () => {
            if (window.scrollY > 400) backToTop.classList.add('visible');
            else backToTop.classList.remove('visible');
        });
        backToTop.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        backToTop._initialized = true;
    }

    // ============================================
    // PANIER MIS À JOUR (sidebar legacy)
    // ============================================
    document.addEventListener('cart-updated', () => {
        const sidebar = document.getElementById('cartSidebar');
        if (sidebar && sidebar.classList.contains('open')) {
            import("./ui.js").then(m => m.renderCartContent());
        }
    });

    console.log('✅ events.js : événements attachés (v1.10.0)');
}

console.log('✅ events.js chargé — v1.10.0 (double handler burger retiré)');