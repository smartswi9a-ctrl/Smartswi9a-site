// js/panier.js
// ============================================================
// PAGE PANIER DÉDIÉE - SMART SWI9A
// Version 2.0.0 — Refonte coupons + checkout + suggestions
// ============================================================
// CHANGEMENTS v2.0.0 :
// ✅ C9.1 — validateCoupon/calculateCouponDiscount via services/coupons
// ✅ C9.2 — revalidateCoupon(silent) avec toasts explicites
// ✅ I9.1 — handleCheckoutFromPage try/finally + bouton réactivé
// ✅ I9.2 — renderCartItem max = stock variante
// ✅ I9.3 — Nettoyage items invalides (produit/variante supprimés)
// ✅ I9.4 — trim() avant comparaison ville
// ✅ I9.5 — refreshSummaryTotals met à jour la ligne coupon
// ✅ C5.2 — waWindow pré-ouvert (anti popup-block)
// ✅ M9.1 — document.click délégué (pas accumulé)
// ✅ M9.2 — initCouponCode guard _initialized
// ✅ M9.3 — renderSuggestions guard cartCategories.size
// ✅ M9.4 — savings skip variants
// ✅ M9.7 — cart-updated debounce 200ms
// ✅ M9.8 — renderEmptyCart bouton retour
// ✅ M9.10 — applyCouponCode race guard
// ============================================================
// Dépend de : config, utils, store, auth, cart, ui-core, products,
//             firebase, services/coupons
// URL      : /panier (ou /panier.html)
// ============================================================

import { CONFIG } from "./config.js";
import {
    t, escapeHTML, getProductName, getProductImageUrl, getFallbackImage,
    getDiscountPercent, renderStars, getCityName, toDate
} from "./utils.js";
import {
    getCart, getProducts, getState, setSelectedCity, getSelectedCity
} from "./store.js";
import {
    getCartSubtotal, getCartTotalItems, getCartSavings, getCartDiscount,
    getCartDeliveryFee, updateCartQuantity, removeFromCart,
    clearCart, checkout, updateCartBadge
} from "./cart.js";
import { getCurrentUser } from "./auth.js";
import { showToast, confirmAction } from "./ui-core.js";
import { validateCoupon, calculateCouponDiscount } from "./services/coupons.js";

// ============================================================
// ÉTAT LOCAL
// ============================================================
let cartPageInitialized = false;
let appliedCoupon = null;

const COUPON_STORAGE_KEY = 'swi9a_applied_coupon';
const CITY_SEARCH_DEBOUNCE = 300;

// ✅ M9.1 : timer global pour la recherche ville
let citySearchDebounceTimer = null;

// ✅ M9.10 : guard race applyCouponCode
let couponValidationInProgress = false;

// ============================================================
// COUPON — PERSISTANCE
// ============================================================
function loadAppliedCoupon() {
    try {
        const saved = sessionStorage.getItem(COUPON_STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed && parsed.code && parsed.type) {
                appliedCoupon = parsed;
                console.log('✅ Coupon restauré :', parsed.code);
            } else {
                appliedCoupon = null;
            }
        }
    } catch (e) {
        console.warn('⚠️ Erreur restauration coupon :', e);
        appliedCoupon = null;
    }
}

function saveAppliedCoupon() {
    try {
        if (appliedCoupon) {
            sessionStorage.setItem(COUPON_STORAGE_KEY, JSON.stringify(appliedCoupon));
        } else {
            sessionStorage.removeItem(COUPON_STORAGE_KEY);
        }
    } catch (e) {
        console.warn('⚠️ Erreur sauvegarde coupon :', e);
    }
}

// ============================================================
// ✅ C9.2 — REVALIDATION COUPON (avec param silent)
// ============================================================
async function revalidateCoupon(silent = false) {
    if (!appliedCoupon) return false;

    const subtotal = getCartSubtotal();

    // Panier vide
    if (subtotal <= 0) {
        if (!silent) showToast('⚠️ Code retiré : panier vide');
        appliedCoupon = null;
        saveAppliedCoupon();
        return true;
    }

    // Montant minimum
    const minPurchase = Number(appliedCoupon.minPurchase) || 0;
    if (subtotal < minPurchase) {
        const oldCode = appliedCoupon.code;
        appliedCoupon = null;
        saveAppliedCoupon();
        if (!silent) showToast(`⚠️ Code ${oldCode} retiré : minimum ${minPurchase} MAD non atteint`);
        return true;
    }

    // Recalcul
    const deliveryFee = getCartDeliveryFee();
    const newDiscount = calculateCouponDiscount(appliedCoupon, subtotal, deliveryFee);

    if (newDiscount <= 0) {
        appliedCoupon = null;
        saveAppliedCoupon();
        if (!silent) showToast('⚠️ Code retiré : plus aucune réduction applicable');
        return true;
    }

    // Détecter changement de montant
    const oldAmount = Number(appliedCoupon.discountAmount) || 0;
    if (newDiscount !== oldAmount) {
        appliedCoupon.discountAmount = newDiscount;
        saveAppliedCoupon();
        return true;
    }

    return false;
}

// ============================================================
// INITIALISATION
// ============================================================
async function initCartPage() {
    if (cartPageInitialized) return;
    cartPageInitialized = true;

    console.log('🚀 Initialisation page panier...');

    loadAppliedCoupon();

    try {
        const { appReadyPromise } = await import("./store.js");
        await Promise.race([
            appReadyPromise,
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);
    } catch (e) {
        console.warn('⚠️ Attente appReady échouée :', e);
    }

    try {
        const { getProductsLoadedPromise } = await import("./store.js");
        const p = getProductsLoadedPromise();
        if (p) await p;
    } catch (e) {
        console.warn('⚠️ Attente produits échouée :', e);
    }

    renderCartPage();

    // ✅ M9.7 : debounce cart-updated (évite re-renders multiples)
    let cartUpdateTimer = null;
    document.addEventListener('cart-updated', async () => {
        if (cartUpdateTimer) clearTimeout(cartUpdateTimer);
        cartUpdateTimer = setTimeout(async () => {
            const changed = await revalidateCoupon(true); // silent
            renderCartPage({ skipSuggestions: true });
        }, 200);
    });

    document.addEventListener('lang-changed', () => {
        renderCartPage();
    });

    document.addEventListener('auth-updated', () => {
        renderCartPage();
    });

    console.log('✅ Page panier prête');
}

// ============================================================
// ✅ I9.3 — NETTOYAGE ITEMS INVALIDES
// ------------------------------------------------------------
// Retire du panier :
//  - produits supprimés du catalogue
//  - variantes supprimées
// Affiche un toast récapitulatif
// ============================================================
function cleanInvalidCartItems() {
    const cart = getCart();
    const products = getProducts();
    if (cart.length === 0 || products.length === 0) return { removed: 0 };

    const invalid = [];

    cart.forEach(item => {
        const product = products.find(p => Number(p.id) === item.productId);
        if (!product) {
            invalid.push({ item, reason: 'product_removed', name: `#${item.productId}` });
            return;
        }

        if (item.variant) {
            const v = (product.variants || []).find(v =>
                (v.size || '') === (item.variant.size || '') &&
                (v.color || '') === (item.variant.color || '')
            );
            if (!v) {
                invalid.push({
                    item,
                    reason: 'variant_removed',
                    name: getProductName(product),
                    variant: [item.variant.size, item.variant.color].filter(Boolean).join(' / ')
                });
            }
        }
    });

    if (invalid.length > 0) {
        invalid.forEach(inv => removeFromCart(inv.item.id));
        const names = invalid.map(inv => inv.name + (inv.variant ? ` (${inv.variant})` : '')).join(', ');
        showToast(`⚠️ ${invalid.length} article(s) indisponible(s) retiré(s) : ${names}`);
    }

    return { removed: invalid.length, details: invalid };
}

// ============================================================
// RENDU PRINCIPAL
// ============================================================
function renderCartPage(options = {}) {
    const { skipSuggestions = false } = options;

    const container = document.getElementById('cartPageContent');
    const loading = document.getElementById('cartPageLoading');
    if (!container) return;

    // ✅ I9.3 : nettoyage AVANT rendu
    cleanInvalidCartItems();

    const cart = getCart();

    if (!cart || cart.length === 0) {
        container.innerHTML = renderEmptyCart();
        if (loading) loading.style.display = 'none';
        container.style.display = 'block';
        if (!skipSuggestions) renderSuggestions();
        return;
    }

    container.innerHTML = renderFullCart(cart);
    if (loading) loading.style.display = 'none';
    container.style.display = 'block';

    attachFullCartEvents();
    if (!skipSuggestions) renderSuggestions();
    updateCartBadge();
}

// ============================================================
// PANIER VIDE
// ✅ M9.8 : bouton "Retour aux produits" bien visible
// ============================================================
function renderEmptyCart() {
    return `
        <div class="cart-page-empty">
            <div class="cart-page-empty-icon">🛒</div>
            <h2 class="cart-page-empty-title">${t('cartEmpty') || 'Votre panier est vide'}</h2>
            <p class="cart-page-empty-text">
                ${t('cartEmptyText') || 'Vous n\'avez encore rien ajouté à votre panier. Découvrez nos produits !'}
            </p>
            <a href="/#produits" class="btn-primary cart-page-empty-btn">
                🛍️ ${t('cartDiscoverProducts') || 'Découvrir nos produits'}
            </a>
            <div style="margin-top:1rem;">
                <a href="/" style="color:var(--gold);text-decoration:none;font-size:0.9rem;font-weight:600;">
                    ← ${t('productBreadcrumbHome') || 'Retour à l\'accueil'}
                </a>
            </div>
        </div>
    `;
}

// ============================================================
// PANIER PLEIN
// ============================================================
function renderFullCart(cart) {
    const products = getProducts();
    const totalItems = getCartTotalItems();
    const user = getCurrentUser();

    const itemsHtml = cart.map(item => {
        const product = products.find(p => Number(p.id) === item.productId);
        if (!product) return '';
        return renderCartItem(product, item.quantity, item);
    }).filter(Boolean).join('');

    const formHtml = renderForm(user);
    const summaryHtml = renderSummary();
    const checkoutBtnHtml = renderCheckoutButton();

    return `
        <div class="cart-page-header">
            <h1 class="cart-page-title">
                🛒 ${t('cartTitle')} <span class="cart-page-count">(${totalItems} ${totalItems > 1 ? (t('cartItemsPlural') || 'articles') : (t('cartItemSingular') || 'article')})</span>
            </h1>
        </div>

        <div class="cart-page-grid">
            <div class="cart-page-items">
                <div class="cart-page-items-header">
                    <span>${t('cartItems') || 'Vos articles'}</span>
                    <button class="cart-page-clear-btn" data-action="cart:clear">
                        🗑️ ${t('cartClear')}
                    </button>
                </div>
                ${itemsHtml}
                <a href="/#produits" class="cart-page-continue-link">
                    ← ${t('cartContinueShopping') || 'Continuer mes achats'}
                </a>
            </div>

            <div class="cart-page-summary-column">
                ${formHtml}
                ${summaryHtml}
                ${checkoutBtnHtml}
            </div>
        </div>
    `;
}

// ============================================================
// ✅ I9.2 — UNE CARTE PRODUIT (max=stock variante)
// ============================================================
function renderCartItem(product, quantity, item) {
    const pid = Number(product.id);
    const name = escapeHTML(getProductName(product));
    const img = getProductImageUrl(product);
    const fallback = getFallbackImage(name);

    // ✅ I9.2 : prix/stock selon variante
    const variant = item?.variant || null;
    let price = Number(product.price) || 0;
    let oldPrice = Number(product.oldPrice) || 0;
    let stock = Number(product.stock) || 0;
    let variantLabel = '';

    if (variant) {
        const v = (product.variants || []).find(v =>
            (v.size || '') === (variant.size || '') &&
            (v.color || '') === (variant.color || '')
        );
        if (v) {
            price = Number(v.price) || price;
            stock = Number(v.stock) || 0;
            // ✅ Pas de per-variant oldPrice → on n'affiche pas de barré
            oldPrice = 0;
        }
        variantLabel = [variant.size, variant.color].filter(Boolean).join(' / ');
    }

    const rating = Number(product.ratingAvg) || 0;
    const ratingCount = Number(product.ratingCount) || 0;
    const category = product.category || '';
    const isPromo = oldPrice > price && oldPrice > 0;
    const discountPercent = getDiscountPercent(oldPrice, price);
    const lineTotal = price * quantity;

    const productUrl = `/produit?slug=${encodeURIComponent(product.slug || '')}`;

    let stockHtml = '';
    if (stock === 0) {
        stockHtml = `<span class="cart-item-stock out">❌ ${t('productOutOfStock') || 'Rupture de stock'}</span>`;
    } else if (stock <= 3) {
        stockHtml = `<span class="cart-item-stock low">⚠️ ${t('cartStockLow') || 'Bientôt épuisé'} (${stock})</span>`;
    } else {
        stockHtml = `<span class="cart-item-stock ok">✅ ${t('productInStock') || 'En stock'}</span>`;
    }

    const starsHtml = rating > 0
        ? `<div class="cart-item-rating">${renderStars(rating)} <span>(${ratingCount})</span></div>`
        : '';

    // ✅ I9.2 : max = stock (variante ou global)
    const maxStock = Math.max(1, stock || 999);

    return `
        <div class="cart-page-item" data-product-id="${pid}" data-item-id="${escapeHTML(item?.id || '')}">
            <a href="${productUrl}" class="cart-page-item-img-link">
                <img src="${img}" alt="${name}" class="cart-page-item-img"
                     onerror="this.onerror=null; this.src='${fallback}'" loading="lazy">
            </a>

            <div class="cart-page-item-info">
                <a href="${productUrl}" class="cart-page-item-name">${name}</a>
                ${variantLabel ? `<div style="font-size:0.8rem;color:var(--gold);font-weight:600;">${escapeHTML(variantLabel)}</div>` : ''}

                <div class="cart-page-item-meta">
                    ${category ? `<span class="cart-item-category">📂 ${escapeHTML(category)}</span>` : ''}
                    ${stockHtml}
                </div>

                ${starsHtml}

                <div class="cart-page-item-bottom">
                    <div class="cart-page-item-price">
                        ${isPromo ? `
                            <span class="cart-item-old-price">${oldPrice} ${t('currency')}</span>
                            <span class="cart-item-discount">-${discountPercent}%</span>
                        ` : ''}
                        <span class="cart-item-current-price">${price} ${t('currency')}</span>
                    </div>

                    <div class="cart-page-item-actions">
                        <button class="cart-page-qty-btn" data-action="cart:decrease" data-id="${escapeHTML(item?.id || '')}" ${quantity <= 1 ? 'disabled' : ''}>−</button>
                        <input type="number" class="cart-page-qty-input" data-id="${escapeHTML(item?.id || '')}" value="${quantity}" min="1" max="${maxStock}" step="1">
                        <button class="cart-page-qty-btn" data-action="cart:increase" data-id="${escapeHTML(item?.id || '')}" ${quantity >= maxStock ? 'disabled' : ''}>+</button>
                    </div>

                    <div class="cart-page-item-linetotal">${lineTotal} ${t('currency')}</div>

                    <button class="cart-page-remove-btn" data-action="cart:remove" data-id="${escapeHTML(item?.id || '')}" aria-label="${t('removeItemAria')}">🗑️</button>
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// BLOC COUPON
// ============================================================
function renderCouponBlock() {
    if (appliedCoupon) {
        const code = escapeHTML(appliedCoupon.code || '');
        const discountAmount = Number(appliedCoupon.discountAmount) || 0;

        let labelText = '';
        if (appliedCoupon.type === 'percentage') {
            labelText = `-${appliedCoupon.value}% appliqué`;
        } else if (appliedCoupon.type === 'fixed') {
            labelText = `-${appliedCoupon.value} MAD appliqué`;
        } else if (appliedCoupon.type === 'free_shipping') {
            labelText = 'Livraison offerte';
        }

        return `
            <div class="cart-page-coupon-applied">
                <div class="cart-page-coupon-applied-info">
                    <span class="cart-page-coupon-applied-code">${code}</span>
                    <span class="cart-page-coupon-applied-label">${labelText}</span>
                    <span class="cart-page-coupon-applied-value">-${discountAmount} ${t('currency')}</span>
                </div>
                <button class="cart-page-coupon-remove-btn" id="removeCouponBtn" aria-label="Retirer le code promo">✕</button>
            </div>
        `;
    }

    return `
        <div class="cart-page-coupon-box">
            <div class="cart-page-coupon-title">🎟️ Code promo</div>
            <div class="cart-page-coupon-input-row">
                <input type="text" class="cart-page-coupon-input" id="couponCodeInput"
                       placeholder="Ex: PROMO10" maxlength="30" autocomplete="off">
                <button class="cart-page-coupon-apply-btn" id="applyCouponBtn">Appliquer</button>
            </div>
            <div class="cart-page-coupon-msg" id="couponCodeMsg"></div>
        </div>
    `;
}

// ============================================================
// RÉCAPITULATIF
// ============================================================
function renderSummary() {
    const subtotal = getCartSubtotal();
    const totalItems = getCartTotalItems();
    const savings = getCartSavings();
    const volumeDiscount = getCartDiscount();
    const deliveryFee = getCartDeliveryFee();
    const selectedCity = getSelectedCity();

    const couponDiscount = appliedCoupon
        ? calculateCouponDiscount(appliedCoupon, subtotal, deliveryFee)
        : 0;

    if (appliedCoupon && couponDiscount !== appliedCoupon.discountAmount) {
        appliedCoupon.discountAmount = couponDiscount;
        saveAppliedCoupon();
    }

    const totalDiscount = Math.min(volumeDiscount + couponDiscount, subtotal);
    const total = Math.max(0, subtotal - totalDiscount + deliveryFee);

    const threshold = CONFIG.SHOP.FREE_DELIVERY_THRESHOLD || 0;
    let freeDeliveryHtml = '';
    if (threshold > 0) {
        const percent = Math.min(100, (subtotal / threshold) * 100);
        const remaining = Math.max(0, threshold - subtotal);
        freeDeliveryHtml = `
            <div class="cart-page-free-delivery">
                ${remaining > 0
                    ? `🚚 ${t('cartFreeDeliveryProgress') || 'Plus que'} <strong>${remaining} ${t('currency')}</strong> ${t('cartFreeDeliveryReached') || 'pour la livraison gratuite'}`
                    : `🎉 ${t('cartFreeDeliveryUnlocked') || 'Livraison gratuite débloquée !'}`
                }
                <div class="cart-page-free-delivery-bar">
                    <div class="cart-page-free-delivery-fill" style="width:${percent}%"></div>
                </div>
            </div>
        `;
    }

    const thresholdDiscount = CONFIG.SHOP.DISCOUNT_THRESHOLD || 3;
    let promoHint = '';
    if (volumeDiscount > 0) {
        promoHint = `<div class="cart-page-promo-hint active">🎉 ${t('cartPromoApplied') || `-${CONFIG.SHOP.DISCOUNT_PERCENT}% appliqué sur votre commande !`}</div>`;
    } else if (totalItems > 0 && !appliedCoupon) {
        const remaining = thresholdDiscount - totalItems;
        if (remaining > 0) {
            promoHint = `<div class="cart-page-promo-hint">🎁 ${t('cartPromoUnlock') || 'Ajoutez'} <strong>${remaining}</strong> ${t('cartPromoUnlockItems') || `article${remaining > 1 ? 's' : ''} pour -${CONFIG.SHOP.DISCOUNT_PERCENT}%`}</div>`;
        }
    }

    return `
        <div class="cart-page-summary">
            <h3 class="cart-page-summary-title">📋 ${t('cartSummary') || 'Récapitulatif'}</h3>
            ${renderCouponBlock()}
            ${freeDeliveryHtml}
            ${promoHint}

            <div class="cart-page-summary-row">
                <span>${t('cartSubtotalLabel')}</span>
                <span>${subtotal} ${t('currency')}</span>
            </div>

            ${savings > 0 ? `
                <div class="cart-page-summary-row savings">
                    <span>${t('savingsLabel')}</span>
                    <span>−${savings} ${t('currency')}</span>
                </div>
            ` : ''}

            ${volumeDiscount > 0 ? `
                <div class="cart-page-summary-row discount">
                    <span>${t('discountLabel')} (-${CONFIG.SHOP.DISCOUNT_PERCENT}%)</span>
                    <span>−${volumeDiscount} ${t('currency')}</span>
                </div>
            ` : ''}

            ${couponDiscount > 0 ? `
                <div class="cart-page-summary-row discount" id="couponDiscountRow">
                    <span>🎟️ ${escapeHTML(appliedCoupon.code)} (-${appliedCoupon.type === 'percentage' ? appliedCoupon.value + '%' : appliedCoupon.type === 'free_shipping' ? 'Livraison' : appliedCoupon.value + ' MAD'})</span>
                    <span id="couponDiscountValue">−${couponDiscount} ${t('currency')}</span>
                </div>
            ` : ''}

            <div class="cart-page-summary-row">
                <span>${t('cartDeliveryLabel')}</span>
                <span class="cart-delivery-value ${selectedCity ? '' : 'pending'}">
                    ${selectedCity ? `${deliveryFee} ${t('currency')}` : (t('cartSelectCity') || 'Sélectionnez une ville')}
                </span>
            </div>

            <div class="cart-page-summary-divider"></div>

            <div class="cart-page-summary-total">
                <span>${t('cartTotalLabel')}</span>
                <span class="cart-page-total-value">${total} ${t('currency')}</span>
            </div>
        </div>
    `;
}

function renderCheckoutButton() {
    return `
        <button class="cart-page-checkout-btn" id="cartPageCheckout" style="margin-top: 1.5rem;">
            💬 ${t('cartCheckout')}
        </button>
    `;
}

// ============================================================
// ✅ I9.5 — Mise à jour en place (coupon inclus)
// ============================================================
function refreshSummaryTotals() {
    const deliveryEl = document.querySelector('.cart-delivery-value');
    const totalEl = document.querySelector('.cart-page-total-value');
    const selectedCity = getSelectedCity();

    if (deliveryEl) {
        if (selectedCity) {
            deliveryEl.textContent = `${getCartDeliveryFee()} ${t('currency')}`;
            deliveryEl.classList.remove('pending');
        } else {
            deliveryEl.textContent = t('cartSelectCity') || 'Sélectionnez une ville';
            deliveryEl.classList.add('pending');
        }
    }

    const subtotal = getCartSubtotal();
    const volumeDiscount = getCartDiscount();
    const deliveryFee = getCartDeliveryFee();
    const couponDiscount = appliedCoupon
        ? calculateCouponDiscount(appliedCoupon, subtotal, deliveryFee)
        : 0;

    // ✅ I9.5 : mise à jour ligne coupon
    if (appliedCoupon && couponDiscount > 0) {
        appliedCoupon.discountAmount = couponDiscount;
        saveAppliedCoupon();

        const couponRow = document.getElementById('couponDiscountRow');
        const couponValueEl = document.getElementById('couponDiscountValue');
        if (couponRow && couponValueEl) {
            couponValueEl.textContent = `−${couponDiscount} ${t('currency')}`;
        }
    }

    if (totalEl) {
        const totalDiscount = Math.min(volumeDiscount + couponDiscount, subtotal);
        const total = Math.max(0, subtotal - totalDiscount + deliveryFee);
        totalEl.textContent = `${total} ${t('currency')}`;
    }
}

// ============================================================
// FORMULAIRE CLIENT
// ============================================================
function renderForm(user) {
    const selectedCity = getSelectedCity();
    const cityValue = selectedCity ? getCityName(selectedCity) : '';

    return `
        <div class="cart-page-form">
            <h3 class="cart-page-form-title">📝 ${t('cartCheckoutInfo') || 'Vos informations'}</h3>

            <div class="cart-page-field">
                <label>👤 ${t('accountNamePlaceholder')} *</label>
                <input type="text" id="cartName" placeholder="${t('accountNamePlaceholder')}"
                       value="${escapeHTML(user?.name || '')}" autocomplete="name">
            </div>

            <div class="cart-page-field">
                <label>📞 ${t('accountPhonePlaceholder')} *</label>
                <input type="tel" id="cartPhone" placeholder="06xxxxxxxx"
                       value="${escapeHTML(user?.phone || '')}" autocomplete="tel">
            </div>

            <div class="cart-page-field">
                <label>📍 ${t('cartAddressPlaceholder')} *</label>
                <textarea id="cartAddress" rows="2" placeholder="${t('cartAddressPlaceholder')}" autocomplete="street-address"></textarea>
            </div>

            <div class="cart-page-field">
                <label>✉️ ${t('accountEmailPlaceholder')} (${t('optional') || 'optionnel'})</label>
                <input type="email" id="cartEmail" placeholder="${t('accountEmailPlaceholder')}"
                       value="${escapeHTML(user?.email || '')}" autocomplete="email">
            </div>

            <div class="cart-page-field city-search-wrapper">
                <label>🏙️ ${t('city')} *</label>
                <input type="text" id="cityFilterInput" placeholder="${t('searchCity')}"
                       value="${escapeHTML(cityValue)}" autocomplete="off">
                <div class="city-suggestions" id="citySuggestions"></div>
            </div>

            <div class="cart-page-trust">
                <div>✅ ${t('trust1')}</div>
                <div>✅ ${t('trust2')}</div>
                <div>✅ ${t('trust3')}</div>
                <div>✅ ${t('trust4')}</div>
            </div>
        </div>
    `;
}

// ============================================================
// PRODUITS SUGGÉRÉS
// ✅ M9.3 : guard cartCategories.size > 0
// ============================================================
function renderSuggestions() {
    const container = document.getElementById('cartSuggestionsRoot');
    if (!container) return;

    const products = getProducts();
    const cart = getCart();
    const cartIds = new Set(cart.map(i => Number(i.productId)));

    const available = products.filter(p => !cartIds.has(Number(p.id)) && (Number(p.stock) || 0) > 0);

    // ✅ M9.3 : guard categories empty
    const cartCategories = new Set();
    cart.forEach(item => {
        const p = products.find(pp => Number(pp.id) === Number(item.productId));
        if (p && p.category) cartCategories.add(p.category);
    });

    let similar = [];
    if (cartCategories.size > 0) {
        similar = available
            .filter(p => cartCategories.has(p.category))
            .sort(() => Math.random() - 0.5)
            .slice(0, 4);
    }

    const promos = available
        .filter(p => Number(p.oldPrice) > Number(p.price) && Number(p.oldPrice) > 0)
        .sort((a, b) => {
            const da = (Number(a.oldPrice) - Number(a.price)) / Number(a.oldPrice);
            const dbb = (Number(b.oldPrice) - Number(b.price)) / Number(b.oldPrice);
            return dbb - da;
        })
        .slice(0, 4);

    let html = '';

    if (similar.length > 0) {
        html += `
            <section class="cart-page-suggestions">
                <h3 class="cart-page-suggestions-title">⭐ ${t('cartSimilarProducts') || 'Vous aimerez aussi'}</h3>
                <div class="cart-page-suggestions-grid">
                    ${similar.map(p => renderSuggestionCard(p)).join('')}
                </div>
            </section>
        `;
    }

    if (promos.length > 0) {
        html += `
            <section class="cart-page-suggestions">
                <h3 class="cart-page-suggestions-title">🔥 ${t('promoTitle') || 'Promos du moment'}</h3>
                <div class="cart-page-suggestions-grid">
                    ${promos.map(p => renderSuggestionCard(p)).join('')}
                </div>
            </section>
        `;
    }

    container.innerHTML = html;

    container.querySelectorAll('.cart-suggestion-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('[data-action="cart:add-suggestion"]')) return;
            const slug = card.dataset.slug;
            if (slug) {
                window.location.href = `/produit?slug=${encodeURIComponent(slug)}`;
            }
        });
    });

    container.querySelectorAll('[data-action="cart:add-suggestion"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(btn.dataset.id);
            const card = btn.closest('.cart-suggestion-card');

            btn.disabled = true;
            const originalHtml = btn.innerHTML;
            btn.innerHTML = '✅ ' + (t('addedToCart') || 'Ajouté');

            try {
                const { addToCart } = await import("./cart.js");
                await addToCart(id);

                if (card) {
                    card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                    card.style.opacity = '0';
                    card.style.transform = 'scale(0.9)';
                    setTimeout(() => card.remove(), 320);
                }
            } catch (err) {
                console.error('Erreur ajout suggestion :', err);
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        });
    });
}

function renderSuggestionCard(product) {
    const pid = Number(product.id);
    const name = escapeHTML(getProductName(product));
    const img = getProductImageUrl(product);
    const fallback = getFallbackImage(name);
    const price = Number(product.price) || 0;
    const oldPrice = Number(product.oldPrice) || 0;
    const isPromo = oldPrice > price && oldPrice > 0;
    const discountPercent = getDiscountPercent(oldPrice, price);

    return `
        <div class="cart-suggestion-card" data-slug="${escapeHTML(product.slug || '')}">
            <div class="cart-suggestion-img">
                <img src="${img}" alt="${name}" onerror="this.onerror=null; this.src='${fallback}'" loading="lazy">
                ${isPromo ? `<span class="cart-suggestion-badge">-${discountPercent}%</span>` : ''}
            </div>
            <div class="cart-suggestion-body">
                <div class="cart-suggestion-name">${name}</div>
                <div class="cart-suggestion-price">
                    <span class="cart-suggestion-current">${price} ${t('currency')}</span>
                    ${isPromo ? `<span class="cart-suggestion-old">${oldPrice}</span>` : ''}
                </div>
                <button class="cart-suggestion-btn" data-action="cart:add-suggestion" data-id="${pid}">
                    🛒 ${t('addToCart')}
                </button>
            </div>
        </div>
    `;
}

// ============================================================
// ✅ M9.2 — COUPON LISTENERS (avec guard _initialized)
// ============================================================
function initCouponCode() {
    const input = document.getElementById('couponCodeInput');
    const applyBtn = document.getElementById('applyCouponBtn');
    const removeBtn = document.getElementById('removeCouponBtn');

    if (input && !input._initialized) {
        input._initialized = true;
        input.addEventListener('input', () => {
            const pos = input.selectionStart;
            input.value = input.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
            input.setSelectionRange(pos, pos);
        });
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyCouponCode();
            }
        });
    }

    if (applyBtn && !applyBtn._initialized) {
        applyBtn._initialized = true;
        applyBtn.addEventListener('click', applyCouponCode);
    }

    if (removeBtn && !removeBtn._initialized) {
        removeBtn._initialized = true;
        removeBtn.addEventListener('click', removeCoupon);
    }
}

// ============================================================
// ✅ C9.1 + M9.10 — APPLIQUER (via validateCoupon + race guard)
// ============================================================
async function applyCouponCode() {
    if (couponValidationInProgress) return;

    const input = document.getElementById('couponCodeInput');
    const applyBtn = document.getElementById('applyCouponBtn');
    const msgEl = document.getElementById('couponCodeMsg');
    if (!input || !applyBtn) return;

    const code = (input.value || '').trim().toUpperCase();
    const showMsg = (text, type = 'error') => {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.className = 'cart-page-coupon-msg ' + (type === 'success' ? 'success' : 'error');
    };

    if (!code) { showMsg('⚠️ Veuillez saisir un code promo'); return; }
    if (code.length < 3) { showMsg('⚠️ Le code doit faire au moins 3 caractères'); return; }

    couponValidationInProgress = true;
    applyBtn.disabled = true;
    const originalText = applyBtn.textContent;
    applyBtn.textContent = '⏳';
    showMsg('');

    try {
        const user = getCurrentUser();
        const subtotal = getCartSubtotal();
        const deliveryFee = getCartDeliveryFee();

        // ✅ C9.1 : utilise validateCoupon (service centralisé)
        const result = await validateCoupon(code, subtotal, deliveryFee, user?.uid || null);

        if (!result.valid) {
            showMsg('❌ ' + (result.error || 'Code invalide'));
            return;
        }

        appliedCoupon = result.coupon;
        saveAppliedCoupon();

        showToast('✅ Code promo appliqué : -' + result.discountAmount + ' ' + t('currency'));
        renderCartPage({ skipSuggestions: true });

    } catch (e) {
        console.error('❌ Erreur applyCouponCode :', e);
        showMsg('❌ ' + (e.message || 'Impossible de valider le code'));
    } finally {
        couponValidationInProgress = false;
        applyBtn.disabled = false;
        applyBtn.textContent = originalText;
    }
}

// ============================================================
// RETIRER LE COUPON
// ============================================================
function removeCoupon() {
    if (!appliedCoupon) return;
    const oldCode = appliedCoupon.code;
    appliedCoupon = null;
    saveAppliedCoupon();
    showToast('🗑️ Code ' + oldCode + ' retiré');
    renderCartPage({ skipSuggestions: true });
}

// ============================================================
// ÉVÉNEMENTS
// ============================================================
function attachFullCartEvents() {
    const container = document.getElementById('cartPageContent');
    if (!container) return;

    container.querySelectorAll('[data-action="cart:clear"]').forEach(btn => {
        if (btn._initialized) return;
        btn._initialized = true;
        btn.addEventListener('click', async () => {
            const confirmed = await confirmAction(t('confirmClearCartMsg'), {
                title: t('confirmClearCartTitle'),
                confirmText: t('confirmClearCartYes'),
                cancelText: t('confirmCancelOrderNo'),
                variant: 'danger'
            });
            if (confirmed) {
                clearCart();
                showToast('🗑️ ' + t('cartClear'));
                renderCartPage();
            }
        });
    });

    container.querySelectorAll('[data-action="cart:increase"]').forEach(btn => {
        if (btn._initialized) return;
        btn._initialized = true;
        btn.addEventListener('click', () => {
            const itemId = btn.dataset.id;
            const item = getCart().find(i => i.id === itemId);
            if (!item) return;
            updateCartQuantity(itemId, item.quantity + 1);
        });
    });

    container.querySelectorAll('[data-action="cart:decrease"]').forEach(btn => {
        if (btn._initialized) return;
        btn._initialized = true;
        btn.addEventListener('click', () => {
            const itemId = btn.dataset.id;
            const item = getCart().find(i => i.id === itemId);
            if (!item || item.quantity <= 1) return;
            updateCartQuantity(itemId, item.quantity - 1);
        });
    });

    container.querySelectorAll('.cart-page-qty-input').forEach(input => {
        if (input._initialized) return;
        input._initialized = true;

        let debounceTimer = null;
        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const itemId = input.dataset.id;
                let val = parseInt(input.value) || 1;
                if (val < 1) val = 1;
                updateCartQuantity(itemId, val);
            }, 400);
        });
        input.addEventListener('blur', () => {
            clearTimeout(debounceTimer);
            const itemId = input.dataset.id;
            let val = parseInt(input.value) || 1;
            if (val < 1) val = 1;
            updateCartQuantity(itemId, val);
        });
    });

    container.querySelectorAll('[data-action="cart:remove"]').forEach(btn => {
        if (btn._initialized) return;
        btn._initialized = true;
        btn.addEventListener('click', () => {
            const itemId = btn.dataset.id;
            removeFromCart(itemId);
            showToast('🗑️ ' + t('removeItemAria'));
        });
    });

    initCitySearchOnPage();
    initCouponCode();

    const checkoutBtn = document.getElementById('cartPageCheckout');
    if (checkoutBtn && !checkoutBtn._initialized) {
        checkoutBtn._initialized = true;
        checkoutBtn.addEventListener('click', handleCheckoutFromPage);
    }

    const backToTopBtn = document.getElementById('backToTopBtn');
    if (backToTopBtn && !backToTopBtn._initialized) {
        backToTopBtn._initialized = true;
        window.addEventListener('scroll', () => {
            if (window.scrollY > 400) backToTopBtn.classList.add('visible');
            else backToTopBtn.classList.remove('visible');
        });
        backToTopBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }
}

// ============================================================
// ✅ I9.4 — RECHERCHE VILLE (trim avant comparaison)
// ============================================================
function initCitySearchOnPage() {
    const input = document.getElementById('cityFilterInput');
    const suggestions = document.getElementById('citySuggestions');
    if (!input || !suggestions) return;
    if (input._initialized) return;
    input._initialized = true;

    if (citySearchDebounceTimer) {
        clearTimeout(citySearchDebounceTimer);
        citySearchDebounceTimer = null;
    }

    input.addEventListener('input', () => {
        // ✅ I9.4 : trim AVANT comparaison
        const raw = input.value;
        const q = raw.trim().toLowerCase();

        // Si texte == ville sélectionnée (avec ou sans espaces) → ne rien faire
        const currentSelected = getSelectedCity();
        if (currentSelected) {
            const selectedName = getCityName(currentSelected).toLowerCase().trim();
            if (q === selectedName) return;
        }

        suggestions.innerHTML = '';
        const deliveryData = getState().deliveryData || [];

        // Correspondance exacte
        if (q.length >= 2) {
            const exactMatch = deliveryData.find(c => {
                const variants = [c.nameFr, c.nameEn, c.nameAr || c.name, c.key]
                    .filter(Boolean).map(s => String(s).toLowerCase().trim());
                return variants.some(v => v === q);
            });
            if (exactMatch) {
                input.dataset.cityId = exactMatch.id;
                setSelectedCity(exactMatch);
                suggestions.classList.remove('active');
                refreshSummaryTotals();

                if (appliedCoupon) {
                    clearTimeout(citySearchDebounceTimer);
                    citySearchDebounceTimer = setTimeout(async () => {
                        const changed = await revalidateCoupon(true);
                        if (changed) renderCartPage({ skipSuggestions: true });
                        else refreshSummaryTotals();
                    }, CITY_SEARCH_DEBOUNCE);
                }
                return;
            }
        }

        // Pas de correspondance → désélectionner
        delete input.dataset.cityId;
        setSelectedCity(null);
        refreshSummaryTotals();

        if (appliedCoupon) {
            clearTimeout(citySearchDebounceTimer);
            citySearchDebounceTimer = setTimeout(async () => {
                const changed = await revalidateCoupon(true);
                if (changed) renderCartPage({ skipSuggestions: true });
                else refreshSummaryTotals();
            }, 500);
        }

        if (!q || deliveryData.length === 0) {
            suggestions.classList.remove('active');
            return;
        }

        const matches = deliveryData.filter(c => {
            const variants = [c.nameFr, c.nameEn, c.nameAr || c.name, c.key]
                .filter(Boolean).map(s => String(s).toLowerCase());
            return variants.some(v => v.includes(q));
        }).slice(0, 20);

        if (matches.length === 0) {
            suggestions.classList.remove('active');
            return;
        }

        suggestions.classList.add('active');
        matches.forEach(city => {
            const div = document.createElement('div');
            div.className = 'city-suggestion-item';
            div.innerHTML = `<strong>${escapeHTML(getCityName(city))}</strong> <span style="color:var(--gold);font-size:0.75rem;">${city.price} MAD · ${city.delay}</span>`;
            div.addEventListener('click', async () => {
                input.value = getCityName(city);
                input.dataset.cityId = city.id;
                setSelectedCity(city);
                suggestions.classList.remove('active');
                refreshSummaryTotals();

                if (appliedCoupon) {
                    clearTimeout(citySearchDebounceTimer);
                    citySearchDebounceTimer = setTimeout(async () => {
                        const changed = await revalidateCoupon(true);
                        if (changed) renderCartPage({ skipSuggestions: true });
                        else refreshSummaryTotals();
                    }, 200);
                }
            });
            suggestions.appendChild(div);
        });
    });

    // ✅ M9.1 : déléguer au document (pas accumulé)
    if (!window._cartPageCityClickDelegated) {
        window._cartPageCityClickDelegated = true;
        document.addEventListener('click', (e) => {
            const sugg = document.getElementById('citySuggestions');
            const inp = document.getElementById('cityFilterInput');
            if (!sugg || !inp) return;
            if (!sugg.contains(e.target) && e.target !== inp) {
                sugg.classList.remove('active');
            }
        });
    }
}

// ============================================================
// ✅ I9.1 + C5.2 — CHECKOUT (try/finally + waWindow)
// ============================================================
async function handleCheckoutFromPage() {
    const user = getCurrentUser();
    if (!user) {
        showToast('🔒 ' + t('loginRequired'));
        document.dispatchEvent(new CustomEvent('open-account'));
        return;
    }

    const name = document.getElementById('cartName')?.value.trim() || '';
    const phone = document.getElementById('cartPhone')?.value.trim() || '';
    const address = document.getElementById('cartAddress')?.value.trim() || '';
    const email = document.getElementById('cartEmail')?.value.trim() || '';
    const cityInput = document.getElementById('cityFilterInput');
    const selectedCity = getSelectedCity();
    const cityId = selectedCity?.id || cityInput?.dataset?.cityId;

    if (!name || !phone || !address) {
        showToast('⚠️ ' + t('fillAllFields'));
        return;
    }
    if (!cityId) {
        showToast('⚠️ ' + t('selectCityRequired'));
        return;
    }

    const cityName = selectedCity ? getCityName(selectedCity) : (cityInput?.value.trim() || '');

    await revalidateCoupon(false);

    const checkoutBtn = document.getElementById('cartPageCheckout');

    // ✅ C5.2 : ouvrir la fenêtre WhatsApp AVANT les awaits
    const waWindow = window.open('', '_blank');
    if (!waWindow) {
        showToast('⚠️ Veuillez autoriser les popups pour commander via WhatsApp');
    }

    if (checkoutBtn) {
        checkoutBtn.disabled = true;
        checkoutBtn.textContent = '⏳ ' + (t('loading') || 'Chargement...');
    }

    try {
        // ✅ C5.2 : passer waWindow
        await checkout(getCart(), {
            name, phone, address, email,
            city: cityName,
            cityId,
            cityAr: selectedCity?.nameAr || selectedCity?.name || '',
            cityFr: selectedCity?.nameFr || cityName
        }, appliedCoupon, waWindow);
    } catch (e) {
        console.error('❌ Erreur checkout :', e);
        showToast('❌ ' + (e.message || t('error')));
        // Fermer la fenêtre WhatsApp si erreur
        if (waWindow && !waWindow.closed) {
            try { waWindow.close(); } catch (err) {}
        }
    } finally {
        // ✅ I9.1 : réactiver le bouton si le panier est toujours rempli
        if (getCart().length > 0 && checkoutBtn && checkoutBtn.isConnected) {
            checkoutBtn.disabled = false;
            checkoutBtn.textContent = '💬 ' + t('cartCheckout');
        }
    }
}

// ============================================================
// DÉMARRAGE
// ============================================================
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCartPage);
} else {
    initCartPage();
}

// ============================================================
// LOG
// ============================================================
console.log('✅ panier.js chargé — v2.0.0 (coupons centralisés + variants + checkout)');