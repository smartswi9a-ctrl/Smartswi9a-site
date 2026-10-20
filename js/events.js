// js/events.js
// ============================================================
// DÉLÉGATION D'ÉVÉNEMENTS GLOBALE - SMART SWI9A
// Version 2.0.0 — Nettoyage handlers morts + guards + UX
// ============================================================
// CHANGEMENTS v2.0.0 :
// ✅ C14.1 — (fix dans product-detail.js _listenerAttached)
// ✅ I14.1 — Guard _eventsAttached (anti-accumulation)
// ✅ I14.2 — 8 handlers morts supprimés
// ✅ I14.4 — Spinner visuel sur lang:change (home)
// ✅ I14.6 — Titre produit sync + re-render async
// ✅ I14.7 — Debounce séparé products:search / blog:search
// ✅ M14.1 — cart:clear guard _initialized (double dialog)
// ============================================================

import { t, setLang, getLang } from "./utils.js";
import { showToast } from "./ui-core.js";

// ============================================================
// ✅ I14.1 : GUARD GLOBAL
// ============================================================
let _eventsAttached = false;

// ============================================================
// HANDLERS (post-nettoyage v2.0.0)
// ------------------------------------------------------------
// ⚠️ SUPPRIMÉS (I14.2 — délégation couvre) :
//   - cart:add        → couvert par .btn-add-to-cart
//   - order:whatsapp  → couvert par .btn-secondary[data-product-id]
//   - favorite:toggle → couvert par .favorite-btn
//   - products:page   → couvert par .pagination-btn
//   - blog:filter     → blog.js gère data-blog-category directement
//   - blog:open       → couvert par .blog-card
//   - blog:close      → blog.js gère bouton close dans modal
//   - menu:toggle     → navbar.js gère en capture phase
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

    // ✅ M14.1 : guard _initialized pour éviter double dialog avec panier.js
    'cart:clear': async (e) => {
        const btn = e.target.closest('[data-action="cart:clear"]');
        // Si panier.js a déjà attaché son listener → on skip
        if (btn && btn._initialized) return;
        // Fallback (bouton hors page panier)
        const { clearCart } = await import("./cart.js");
        clearCart();
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

    'notifications:open': async () => {
        const { openNotificationsPanel } = await import("./notifications.js");
        await openNotificationsPanel();
    },

    'scroll:top': () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    'blog:search': async (e) => {
        const query = e.target.value;
        const { searchBlog } = await import("./blog.js");
        searchBlog(query);
    },

    // ============================================================
    // ✅ I14.4 + I14.6 : LANG CHANGE (spinner + titre produit sync)
    // ============================================================
    'lang:change': async (e) => {
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

        // ============================================
        // HOME : spinner + re-render async
        // ============================================
        if (isHome) {
            // ✅ I14.4 : feedback immédiat
            const grid = document.getElementById('productsGrid');
            if (grid) {
                grid.innerHTML = `
                    <div style="grid-column:1/-1;text-align:center;padding:3rem 1rem;">
                        <div class="spinner" style="margin:0 auto;"></div>
                    </div>
                `;
            }

            Promise.all([
                import("./products.js").then(m => {
                    m.renderCategoryFilters();
                    m.renderSortOptions();
                    return m.renderProducts();
                }),
                import("./banner.js").then(m => m.refreshBanners()).catch(() => {}),
                import("./testimonials.js").then(m => m.initDynamicTestimonials()).catch(() => {})
            ]).catch(err => console.warn('⚠️ Re-render home failed:', err));
        }

        // ============================================
        // BLOG
        // ============================================
        if (isBlog) {
            import("./blog.js").then(m => m.renderBlogList?.()).catch(err => console.warn('⚠️ Re-render blog failed:', err));
        }

        // ============================================
        // PRODUCT : titre sync + full re-render async
        // ============================================
        if (isProduct) {
            // ✅ I14.6 : titre mis à jour SYNCHRONE (fast)
            try {
                const { getProducts } = await import("./store.js");
                const { getProductName } = await import("./utils.js");
                const params = new URLSearchParams(window.location.search);
                const slug = params.get('slug');
                if (slug) {
                    const product = getProducts().find(p => p.slug === slug);
                    if (product) {
                        document.title = `${getProductName(product)} | Smart Swi9a`;
                    }
                }
            } catch (err) {
                console.warn('⚠️ Sync title update failed:', err);
            }

            // Full re-render async (galerie, variantes, avis, related)
            import("./product-detail.js")
                .then(m => m.renderProductDetail?.())
                .catch(err => console.warn('⚠️ Re-render product failed:', err));
        }

        // ============================================
        // VILLES : géré en interne par villesmaroc.html
        // ============================================
        if (isVilles) {
            console.log('ℹ️ Page villes : refresh géré en interne');
        }

        // ============================================
        // CART : géré par panier.js via event 'lang-changed'
        // ============================================
        if (isCartPage) {
            console.log('ℹ️ Page panier : refresh géré par panier.js (event lang-changed)');
        }
    }
};

// ============================================================
// ✅ FERMER LE MENU MOBILE (helper)
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
// ------------------------------------------------------------
// ⚠️ Note : le titre produit est géré dans 'lang:change' (I14.6)
// car il dépend du produit courant (slug dynamique).
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
            // ✅ M14.2 : clés se terminant par 'Html' → innerHTML
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

    // 4. <title> dynamique (pages avec titleKey statique)
    // ⚠️ Le produit est EXCLU (géré par lang:change I14.6)
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
        // ✅ I14.6 : /produit → PAS de titleKey, laissé à lang:change

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
// ✅ I14.7 : DEBOUNCE SÉPARÉ (par action)
// ------------------------------------------------------------
// Avant : un seul timer partagé → taper dans products pouvait
// annuler la recherche dans blog (et vice-versa)
// ============================================================
const searchTimers = {
    'products:search': null,
    'blog:search': null
};

// ============================================================
// ✅ I14.1 : ATTACHER LES ÉVÉNEMENTS (avec guard)
// ============================================================
export function attachEvents() {
    // ✅ I14.1 : guard anti-accumulation
    if (_eventsAttached) {
        console.log('ℹ️ events.js : événements déjà attachés — skip');
        return;
    }
    _eventsAttached = true;

    // ============================================
    // FERMETURE DU MENU MOBILE AU CLIC EXTÉRIEUR
    // (toggle géré par navbar.js en capture)
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
    // DÉLÉGATION PRINCIPALE (clicks)
    // ============================================
    document.addEventListener('click', (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (actionEl) {
            // Burger géré par navbar.js → ignorer
            if (actionEl.id === 'burgerBtn') return;

            const action = actionEl.dataset.action;
            const handler = eventHandlers[action];
            if (handler) {
                handler(e);
                return;
            }
        }

        // ============ FALLBACK DÉLÉGATIONS ============

        // Pagination produits
        const pageBtn = e.target.closest('.pagination-btn:not(.disabled)');
        if (pageBtn && pageBtn.dataset.page) {
            const page = parseInt(pageBtn.dataset.page);
            if (!isNaN(page)) {
                import("./products.js").then(m => m.goToPage(page));
                return;
            }
        }

        // Bouton "Ajouter au panier" (produits sans variantes)
        const addBtn = e.target.closest('.btn-add-to-cart, .btn-product-add');
        if (addBtn && !addBtn.closest('[data-action]')) {
            e.preventDefault();
            const id = parseInt(addBtn.dataset.id || addBtn.dataset.productId);
            if (!isNaN(id)) {
                import("./cart.js").then(m => m.addToCart(id));
                return;
            }
        }

        // Bouton favoris
        const favBtn = e.target.closest('.favorite-btn');
        if (favBtn && !favBtn.closest('[data-action]')) {
            e.stopPropagation();
            const id = parseInt(favBtn.dataset.id);
            if (!isNaN(id)) {
                import("./products.js").then(m => m.toggleFavorite(id));
                return;
            }
        }

        // Bouton "Commander via WhatsApp" (page produit)
        const waBtn = e.target.closest('.btn-secondary[data-product-id]');
        if (waBtn && !waBtn.closest('[data-action]')) {
            e.preventDefault();
            const id = parseInt(waBtn.dataset.productId);
            if (!isNaN(id)) {
                import("./whatsapp.js").then(m => m.orderViaWhatsApp(id));
                return;
            }
        }

        // Carte produit (navigation)
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

        // Carte blog (ouverture modal)
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
    // ESC → fermer menu mobile
    // ============================================
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeMobileMenu();
        }
    });

    // ============================================
    // CHANGE (select, checkbox)
    // ============================================
    document.addEventListener('change', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        if (eventHandlers[action]) {
            eventHandlers[action](e);
        }
    });

    // ============================================
    // ✅ I14.7 : INPUT (debounce séparé par action)
    // ============================================
    document.addEventListener('input', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;

        if (action in searchTimers) {
            // ✅ I14.7 : timer indépendant par action
            if (searchTimers[action]) clearTimeout(searchTimers[action]);
            searchTimers[action] = setTimeout(() => {
                if (eventHandlers[action]) eventHandlers[action](e);
                searchTimers[action] = null;
            }, 300);
        } else if (eventHandlers[action]) {
            eventHandlers[action](e);
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
        }, { passive: true });
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

    console.log('✅ events.js : événements attachés (v2.0.0)');
}

// ============================================================
// LOG
// ============================================================
console.log('✅ events.js chargé — v2.0.0 (handlers nettoyés + guards + spinner)');