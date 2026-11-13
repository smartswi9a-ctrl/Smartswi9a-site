/* ============================================================ js/panier.js PAGE PANIER DÉDIÉE - SMARTSWIKA Version 9.0.0 - Lot 24/30 : validation phone + debounce ville CHANGEMENTS v9.0.0 : - B-PAN-1 (P2) : handleCheckoutFromPage utilise isValidMoroccanPhone() de utils v9.0.0 (06/07 + 10 chiffres). Avant : validation laxiste qui acceptait 123456789. - B-PAN-2 (P2) : initCitySearchOnPage utilise debounce(utils) à 250ms. citySearchDebounceTimer (dead code) retiré. - B-PAN-3 (P3) : trim consistent sur tous les champs du checkout. - B-PAN-4 (P3) : logs préfixés [panier]. - B-PAN-5 (P3) : import renderStars retiré (inutilisé). - JSDoc sur initCartPage, revalidateCoupon, handleCheckoutFromPage. - Bump version 2.3.0 -> 9.0.0. NOTE : Ce module est la page /panier. Il utilise : - checkout() de cart.js (Lot 10) pour créer la commande - appliedCoupon persisté en sessionStorage - la ville sélectionnée via store.setSelectedCity Le coupon est revalidé à chaque cart-updated, et retiré automatiquement si les conditions ne sont plus remplies (minPurchase, type, etc.). ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import { CONFIG, getCategoryById } from "./config.js";
import {
  t,
  escapeHTML,
  getProductName,
  getProductImageUrl,
  getFallbackImage,
  getDiscountPercent,
  getCityName,
  toDate,
  isValidEmail,
  isValidMoroccanPhone,
  debounce,
} from "./utils.js";
import {
  getCart,
  getProducts,
  getState,
  setSelectedCity,
  getSelectedCity,
} from "./store.js";
import {
  getCartSubtotal,
  getCartTotalItems,
  getCartSavings,
  getCartDiscount,
  getCartDeliveryFee,
  updateCartQuantity,
  removeFromCart,
  clearCart,
  checkout,
  updateCartBadge,
  calculateCouponDiscount,
} from "./cart.js";
import { getCurrentUser } from "./auth.js";
import { showToast, confirmAction } from "./ui-core.js";
import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase.js";
import { normalizeProductId } from "./domain/product-id.js";

/* ============================================================ NORMALISATION D'ID PRODUIT ============================================================ - "42" (chaîne numérique) -> 42 (Number) - "abc123" (auto-ID Firestore vendeur) -> "abc123" (String) - null/undefined/"" -> null ============================================================ */

/* ============================================================ ÉTAT LOCAL ============================================================ */
let cartPageInitialized = false;
let appliedCoupon = null;

const COUPON_STORAGE_KEY = "swi9a_applied_coupon";

/* ============================================================ COUPON - PERSISTANCE ============================================================ */
function loadAppliedCoupon() {
  try {
    const saved = sessionStorage.getItem(COUPON_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.code && parsed.type) {
        appliedCoupon = parsed;
        console.log("[panier] Coupon restauré :", parsed.code);
      } else {
        appliedCoupon = null;
      }
    }
  } catch (e) {
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
    /* quota/private mode - non bloquant */
  }
}

/* ============================================================ INITIALISATION ============================================================ */

/** * Point d'entrée : attend le chargement produits/villes, puis * rend la page panier et attache les listeners (cart-updated, * lang-changed, auth-updated). * * Guard cartPageInitialized : appelée 1 seule fois. * * @returns {Promise<void>} */
async function initCartPage() {
  if (cartPageInitialized) return;
  cartPageInitialized = true;

  console.log("[panier] Initialisation page panier...");
  loadAppliedCoupon();

  try {
    const { appReadyPromise } = await import("./store.js");
    await Promise.race([
      appReadyPromise,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch (e) {
    /* timeout - on continue quand même */
  }

  try {
    const { getProductsLoadedPromise } = await import("./store.js");
    const p = getProductsLoadedPromise();
    if (p) await p;
  } catch (e) {
    /* ignore */
  }

  renderCartPage();

  document.addEventListener("cart-updated", async () => {
    await revalidateCoupon();
    renderCartPage({ skipSuggestions: true });
  });

  document.addEventListener("lang-changed", () => renderCartPage());
  document.addEventListener("auth-updated", () => renderCartPage());
}

/* ============================================================ REVALIDATION COUPON ============================================================ */

/** * Revalide le coupon appliqué : retire si : * - panier vide (subtotal <= 0) * - minPurchase non atteint * - réduction devenue nulle * * @param {boolean} [silent=false] - Si true, pas de toast. * @returns {Promise<boolean>} true si le coupon a été retiré. */
async function revalidateCoupon(silent = false) {
  if (!appliedCoupon) return false;
  const subtotal = getCartSubtotal();

  if (subtotal <= 0) {
    appliedCoupon = null;
    saveAppliedCoupon();
    if (!silent) showToast("Code promo retiré : panier vide");
    return true;
  }

  const minPurchase = Number(appliedCoupon.minPurchase) || 0;
  if (subtotal < minPurchase) {
    const oldCode = appliedCoupon.code;
    appliedCoupon = null;
    saveAppliedCoupon();
    if (!silent)
      showToast(
        `Code ${oldCode} retiré : minimum ${minPurchase} MAD non atteint`
      );
    return true;
  }

  const deliveryFee = getCartDeliveryFee();
  const newDiscount = calculateCouponDiscount(
    appliedCoupon,
    subtotal,
    deliveryFee
  );

  if (newDiscount <= 0) {
    appliedCoupon = null;
    saveAppliedCoupon();
    if (!silent)
      showToast("Code promo retiré : plus aucune réduction applicable");
    return true;
  }

  appliedCoupon.discountAmount = newDiscount;
  saveAppliedCoupon();
  return false;
}

/* ============================================================ RENDU PRINCIPAL ============================================================ */
function renderCartPage(options = {}) {
  const { skipSuggestions = false } = options;
  const container = document.getElementById("cartPageContent");
  const loading = document.getElementById("cartPageLoading");
  if (!container) return;

  let cart = getCart();
  const products = getProducts();

  /* Nettoyage des produits supprimés (compatible Number + String). */
  const invalidItems = [];
  cart = cart.filter((item) => {
    const target = String(item.productId);
    const p = products.find((pp) => String(pp.id) === target);
    if (!p) {
      invalidItems.push(item);
      return false;
    }
    if (item.variant) {
      const variantsArr = Array.isArray(p.variants) ? p.variants : [];
      const v = variantsArr.find(
        (v) =>
          (v.size || "") === (item.variant.size || "") &&
          (v.color || "") === (item.variant.color || "")
      );
      if (!v) {
        invalidItems.push(item);
        return false;
      }
    }
    return true;
  });

  if (invalidItems.length > 0) {
    invalidItems.forEach((inv) => removeFromCart(inv.id));
    showToast(
      `${invalidItems.length} article(s) retiré(s) (produit indisponible)`
    );
    cart = getCart();
  }

  if (!cart || cart.length === 0) {
    container.innerHTML = renderEmptyCart();
    loading.style.display = "none";
    container.style.display = "block";
    if (!skipSuggestions) renderSuggestions();
    return;
  }

  container.innerHTML = renderFullCart(cart, products);
  loading.style.display = "none";
  container.style.display = "block";

  attachFullCartEvents();
  if (!skipSuggestions) renderSuggestions();
  updateCartBadge();
}

function renderEmptyCart() {
  return ` <div class="cart-page-empty"> <div class="cart-page-empty-icon">🛒</div> <h2 class="cart-page-empty-title">${ t("cartEmpty") || "Votre panier est vide" }</h2> <p class="cart-page-empty-text">${ t("cartEmptyText") || "Vous n'avez encore rien ajouté." }</p> <a href="/#produits" class="btn-primary cart-page-empty-btn">${ t("cartDiscoverProducts") || "Découvrir nos produits" }</a> </div> `;
}

function renderFullCart(cart, products) {
  const totalItems = getCartTotalItems();
  const user = getCurrentUser();

  const itemsHtml = cart
    .map((item) => {
      const target = String(item.productId);
      const product = products.find((p) => String(p.id) === target);
      if (!product) return "";
      return renderCartItem(product, item.quantity, item);
    })
    .join("");

  return ` <div class="cart-page-header"> <h1 class="cart-page-title">${t( "cartTitle" )} <span class="cart-page-count">(${totalItems})</span></h1> </div> <div class="cart-page-grid"> <div class="cart-page-items"> <div class="cart-page-items-header"> <span>${t("cartItems")}</span> <button class="cart-page-clear-btn" data-action="cart:clear">${t( "cartClear" )}</button> </div> ${itemsHtml} <a href="/#produits" class="cart-page-continue-link">← ${t( "cartContinueShopping" )}</a> </div> <div class="cart-page-summary-column"> ${renderForm(user)} ${renderSummary()} <button class="cart-page-checkout-btn" id="cartPageCheckout" style="margin-top: 1.5rem;">${t( "cartCheckout" )}</button> </div> </div> `;
}

function renderCartItem(product, quantity, item) {
  const pid = normalizeProductId(product.id);
  if (pid == null) return "";

  const name = escapeHTML(getProductName(product));
  const img = getProductImageUrl(product);
  const fallback = getFallbackImage(name);
  const price = item.variant
    ? Number(item.variant.price)
    : Number(product.price);
  const oldPrice = Number(product.oldPrice) || 0;

  let maxStock = Number(product.stock) || 999;
  if (item.variant) {
    const variantsArr = Array.isArray(product.variants) ? product.variants : [];
    const v = variantsArr.find(
      (v) =>
        (v.size || "") === (item.variant.size || "") &&
        (v.color || "") === (item.variant.color || "")
    );
    maxStock = v ? Number(v.stock) : 0;
  }

  const isPromo = oldPrice > price && oldPrice > 0;
  const lineTotal = price * quantity;
  const productUrl = `/produit?slug=${encodeURIComponent(product.slug || "")}`;

  let stockHtml =
    maxStock === 0
      ? `<span class="cart-item-stock out">${t("productOutOfStock")}</span>`
      : maxStock <= 3
      ? `<span class="cart-item-stock low">${t( "cartStockLow" )} (${maxStock})</span>`
      : `<span class="cart-item-stock ok">${t("productInStock")}</span>`;

  const variantText = item.variant
    ? `<div style="font-size:0.75rem;color:var(--gold);font-weight:600;margin-bottom:0.2rem;">Taille: ${escapeHTML( item.variant.size || "—" )} | Couleur: ${escapeHTML(item.variant.color || "—")}</div>`
    : "";

  const catObj = getCategoryById(product.category);
  const categoryLabel = catObj
    ? `${catObj.emoji} ${t(catObj.label)}`
    : escapeHTML(product.category || "");

  const safeDataId = escapeHTML(String(pid));

  return ` <div class="cart-page-item" data-product-id="${safeDataId}"> <a href="${productUrl}" class="cart-page-item-img-link"><img src="${img}" alt="${name}" width="96" height="96" class="cart-page-item-img" onerror="this.onerror=null;this.src='${fallback}'"></a> <div class="cart-page-item-info"> <a href="${productUrl}" class="cart-page-item-name">${name}</a> ${variantText} <div class="cart-page-item-meta"> <span class="cart-item-category">${categoryLabel}</span> ${stockHtml} </div> <div class="cart-page-item-bottom"> <div class="cart-page-item-price"> ${ isPromo ? `<span class="cart-item-old-price">${oldPrice} MAD</span>` : "" } <span class="cart-item-current-price">${price} MAD</span> </div> <div class="cart-page-item-actions"> <button class="cart-page-qty-btn" data-action="cart:decrease" data-id="${safeDataId}">−</button> <input type="number" class="cart-page-qty-input" data-id="${safeDataId}" value="${quantity}" min="1" max="${ maxStock || 999 }"> <button class="cart-page-qty-btn" data-action="cart:increase" data-id="${safeDataId}">+</button> </div> <div class="cart-page-item-linetotal">${lineTotal} MAD</div> <button class="cart-page-remove-btn" data-action="cart:remove" data-id="${safeDataId}">✕</button> </div> </div> </div> `;
}

/* ============================================================ COUPON & RÉCAPITULATIF ============================================================ */
function renderCouponBlock() {
  if (appliedCoupon) {
    const discountAmount = Number(appliedCoupon.discountAmount) || 0;
    return ` <div class="cart-page-coupon-applied"> <div class="cart-page-coupon-applied-info"> <span class="cart-page-coupon-applied-code">${escapeHTML( appliedCoupon.code )}</span> <span class="cart-page-coupon-applied-label">${ appliedCoupon.type === "percentage" ? `-${appliedCoupon.value}%` : appliedCoupon.type === "free_shipping" ? "Livraison offerte" : `-${appliedCoupon.value} MAD` }</span> <span class="cart-page-coupon-applied-value">-${discountAmount} MAD</span> </div> <button class="cart-page-coupon-remove-btn" id="removeCouponBtn">✕</button> </div> `;
  }
  return ` <div class="cart-page-coupon-box"> <div class="cart-page-coupon-title">Code promo</div> <div class="cart-page-coupon-input-row"> <input type="text" class="cart-page-coupon-input" id="couponCodeInput" placeholder="Ex: PROMO10"> <button class="cart-page-coupon-apply-btn" id="applyCouponBtn">Appliquer</button> </div> <div class="cart-page-coupon-msg" id="couponCodeMsg"></div> </div> `;
}

function renderSummary() {
  const subtotal = getCartSubtotal();
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

  return ` <div class="cart-page-summary"> <h3 class="cart-page-summary-title">${t("cartSummary")}</h3> ${renderCouponBlock()} <div class="cart-page-summary-row"><span>${t( "cartSubtotalLabel" )}</span><span>${subtotal} MAD</span></div> ${ savings > 0 ? `<div class="cart-page-summary-row savings"><span>${t( "savingsLabel" )}</span><span>−${savings} MAD</span></div>` : "" } ${ volumeDiscount > 0 ? `<div class="cart-page-summary-row discount"><span>${t( "discountLabel" )}</span><span>−${volumeDiscount} MAD</span></div>` : "" } ${ couponDiscount > 0 ? `<div class="cart-page-summary-row discount"><span>${appliedCoupon.code}</span><span>−${couponDiscount} MAD</span></div>` : "" } <div class="cart-page-summary-row"> <span>${t("cartDeliveryLabel")}</span> <span class="cart-delivery-value ${ selectedCity ? "" : "pending" }"> ${selectedCity ? `${deliveryFee} MAD` : t("cartSelectCity")} </span> </div> <div class="cart-page-summary-divider"></div> <div class="cart-page-summary-total"><span>${t( "cartTotalLabel" )}</span><span class="cart-page-total-value">${total} MAD</span></div> </div> `;
}

function refreshSummaryTotals() {
  const deliveryEl = document.querySelector(".cart-delivery-value");
  const totalEl = document.querySelector(".cart-page-total-value");
  const selectedCity = getSelectedCity();

  if (deliveryEl) {
    if (selectedCity) {
      deliveryEl.textContent = `${getCartDeliveryFee()} MAD`;
      deliveryEl.classList.remove("pending");
    } else {
      deliveryEl.textContent = t("cartSelectCity") || "Sélectionnez une ville";
      deliveryEl.classList.add("pending");
    }
  }

  if (totalEl) {
    const subtotal = getCartSubtotal();
    const volumeDiscount = getCartDiscount();
    const deliveryFee = getCartDeliveryFee();
    const couponDiscount = appliedCoupon
      ? calculateCouponDiscount(appliedCoupon, subtotal, deliveryFee)
      : 0;
    const totalDiscount = Math.min(volumeDiscount + couponDiscount, subtotal);
    totalEl.textContent = `${Math.max( 0, subtotal - totalDiscount + deliveryFee )} MAD`;
  }

  const couponRow = document.querySelector(
    ".cart-page-summary-row.discount:last-of-type"
  );
  if (couponRow && appliedCoupon) {
    const valEl = couponRow.querySelector("span:last-child");
    const subtotal = getCartSubtotal();
    const deliveryFee = getCartDeliveryFee();
    if (valEl)
      valEl.textContent = `−${calculateCouponDiscount( appliedCoupon, subtotal, deliveryFee )} MAD`;
  }
}

/* ============================================================ FORMULAIRE CLIENT ============================================================ */
function renderForm(user) {
  const selectedCity = getSelectedCity();
  const cityValue = selectedCity ? getCityName(selectedCity) : "";

  return ` <div class="cart-page-form"> <h3 class="cart-page-form-title">${t("cartCheckoutInfo")}</h3> <div class="cart-page-field"> <label>${t("accountNamePlaceholder")} *</label> <input type="text" id="cartName" value="${escapeHTML( user?.name || "" )}" autocomplete="name"> </div> <div class="cart-page-field"> <label>${t("accountPhonePlaceholder")} *</label> <input type="tel" id="cartPhone" value="${escapeHTML( user?.phone || "" )}" autocomplete="tel" inputmode="tel" placeholder="06XXXXXXXX ou 07XXXXXXXX"> </div> <div class="cart-page-field"> <label>${t("cartAddressPlaceholder")} *</label> <textarea id="cartAddress" rows="2" autocomplete="street-address"></textarea> </div> <div class="cart-page-field"> <label>${t("accountEmailPlaceholder")}</label> <input type="email" id="cartEmail" value="${escapeHTML( user?.email || "" )}" autocomplete="email"> </div> <div class="cart-page-field city-search-wrapper"> <label>${t("city")} *</label> <input type="text" id="cityFilterInput" placeholder="${t( "searchCity" )}" value="${escapeHTML(cityValue)}" autocomplete="off"> <div class="city-suggestions" id="citySuggestions"></div> </div> <div class="cart-page-field"> <label>Note de livraison (${ t("optional") || "optionnel" })</label> <textarea id="cartDeliveryNote" rows="2" placeholder="Ex: Sonner deux fois, 3ème étage, laisser chez le gardien..." maxlength="300"></textarea> </div> 
    <div class="legal-consent" id="cartLegalConsent" data-legal-consent="acheteur">
        <input type="checkbox" id="acceptCguAcheteur" name="acceptCguAcheteur" required>
        <label for="acceptCguAcheteur">
            J'accepte les <a href="/cgu-acheteur.html" target="_blank" rel="noopener noreferrer">CGU Acheteur</a>
            et je reconnais avoir pris connaissance des conditions de commande, de livraison et de retour.
        </label>
    </div>
 <div class="cart-page-trust"> <div>${t("trust1")}</div> <div>${t("trust2")}</div> <div>${t("trust3")}</div> <div>${t("trust4")}</div> </div> </div> `;
}

/* ============================================================ SUGGESTIONS ============================================================ */
function renderSuggestions() {
  const container = document.getElementById("cartSuggestionsRoot");
  if (!container) return;

  const products = getProducts();
  const cartIds = new Set(getCart().map((i) => String(i.productId)));
  const available = products.filter(
    (p) => !cartIds.has(String(p.id)) && (Number(p.stock) || 0) > 0
  );
  const random = available.sort(() => 0.5 - Math.random()).slice(0, 4);

  if (random.length === 0) {
    container.innerHTML = "";
    return;
  }

  let html = `<section class="cart-page-suggestions"><h3 class="cart-page-suggestions-title">${t( "cartSimilarProducts" )}</h3><div class="cart-page-suggestions-grid">`;
  random.forEach((p) => {
    const name = escapeHTML(getProductName(p));
    const pid = normalizeProductId(p.id);
    html += ` <div class="cart-suggestion-card" data-slug="${escapeHTML( p.slug || "" )}"> <div class="cart-suggestion-img"><img src="${getProductImageUrl( p )}" alt="${name}" width="64" height="64" loading="lazy"></div> <div class="cart-suggestion-body"> <div class="cart-suggestion-name">${name}</div> <div class="cart-suggestion-price"><span class="cart-suggestion-current">${ p.price } MAD</span></div> <button class="cart-suggestion-btn" data-action="cart:add-suggestion" data-id="${escapeHTML( String(pid) )}">${t("addToCart")}</button> </div> </div> `;
  });
  html += `</div></section>`;
  container.innerHTML = html;

  container
    .querySelectorAll('[data-action="cart:add-suggestion"]')
    .forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.innerHTML = "OK";
        await import("./cart.js").then((m) => m.addToCart(id));
        btn.closest(".cart-suggestion-card").remove();
      });
    });
  container.querySelectorAll(".cart-suggestion-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (card.dataset.slug)
        window.location.href = `/produit?slug=${encodeURIComponent( card.dataset.slug )}`;
    });
  });
}

/* ============================================================ COUPON - APPLIQUER ============================================================ */
async function applyCouponCode() {
  const input = document.getElementById("couponCodeInput");
  const applyBtn = document.getElementById("applyCouponBtn");
  const msgEl = document.getElementById("couponCodeMsg");
  if (!input || !applyBtn) return;

  const code = (input.value || "").trim().toUpperCase();
  const showMsg = (text, type = "error") => {
    if (msgEl) {
      msgEl.textContent = text;
      msgEl.className = "cart-page-coupon-msg " + type;
    }
  };

  if (!code) {
    showMsg("Saisissez un code");
    return;
  }
  if (code.length < 3) {
    showMsg("Code trop court");
    return;
  }

  applyBtn.disabled = true;
  applyBtn.textContent = "...";
  showMsg("");

  try {
    const deterministicId = code.replace(/[^A-Z0-9]/g, "_");
    const snap = await getDoc(doc(db, "coupons", deterministicId));

    if (!snap.exists()) {
      showMsg("Code introuvable");
      return;
    }
    const couponData = snap.data();

    if (couponData.isActive !== true) {
      showMsg("Ce code n'est pas actif");
      return;
    }

    const expiresAt = couponData.expiresAt
      ? toDate(couponData.expiresAt)
      : null;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      showMsg("Ce code a expiré");
      return;
    }

    const maxUses = Number(couponData.maxUses) || 0;
    if (maxUses > 0 && (Number(couponData.usedCount) || 0) >= maxUses) {
      showMsg("Ce code a atteint sa limite");
      return;
    }

    const subtotal = getCartSubtotal();
    const minPurchase = Number(couponData.minPurchase) || 0;
    if (subtotal < minPurchase) {
      showMsg(`Minimum ${minPurchase} MAD requis`);
      return;
    }

    if (couponData.oneUsePerUser === true) {
      const user = getCurrentUser();
      if (user && user.uid) {
        const useSnap = await getDoc(
          doc(db, "coupon_uses", `${snap.id}_${user.uid}`)
        );
        if (useSnap.exists()) {
          showMsg("Vous avez déjà utilisé ce code");
          return;
        }
      }
    }

    const discountAmount = calculateCouponDiscount(
      couponData,
      subtotal,
      getCartDeliveryFee()
    );
    if (discountAmount <= 0) {
      showMsg("Aucune réduction applicable");
      return;
    }

    appliedCoupon = {
      id: snap.id,
      code: couponData.code,
      type: couponData.type,
      value: Number(couponData.value) || 0,
      minPurchase,
      discountAmount,
      oneUsePerUser: couponData.oneUsePerUser === true,
    };
    saveAppliedCoupon();
    showToast("Code promo appliqué !");
    renderCartPage({ skipSuggestions: true });
  } catch (e) {
    showMsg("Erreur de validation");
  } finally {
    applyBtn.disabled = false;
    applyBtn.textContent = "Appliquer";
  }
}

/* ============================================================ ÉVÉNEMENTS DU PANIER ============================================================ */
function attachFullCartEvents() {
  const container = document.getElementById("cartPageContent");
  if (!container) return;

  container.querySelectorAll('[data-action="cart:clear"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (
        await confirmAction(t("confirmClearCartMsg"), { variant: "danger" })
      ) {
        clearCart();
        renderCartPage();
      }
    });
  });

  container.querySelectorAll('[data-action="cart:increase"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const item = getCart().find((i) => String(i.productId) === String(id));
      if (item) updateCartQuantity(item.id, item.quantity + 1);
    });
  });

  container.querySelectorAll('[data-action="cart:decrease"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const item = getCart().find((i) => String(i.productId) === String(id));
      if (item && item.quantity > 1)
        updateCartQuantity(item.id, item.quantity - 1);
    });
  });

  container.querySelectorAll(".cart-page-qty-input").forEach((input) => {
    input.addEventListener("change", () => {
      let val = parseInt(input.value) || 1;
      if (val < 1) val = 1;
      const id = input.dataset.id;
      const item = getCart().find((i) => String(i.productId) === String(id));
      if (item) updateCartQuantity(item.id, val);
    });
  });

  container.querySelectorAll('[data-action="cart:remove"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const item = getCart().find((i) => String(i.productId) === String(id));
      if (item) {
        removeFromCart(item.id);
        showToast("Article retiré");
      }
    });
  });

  initCitySearchOnPage();
  document
    .getElementById("applyCouponBtn")
    ?.addEventListener("click", applyCouponCode);
  document.getElementById("removeCouponBtn")?.addEventListener("click", () => {
    appliedCoupon = null;
    saveAppliedCoupon();
    renderCartPage({ skipSuggestions: true });
  });

  document
    .getElementById("cartPageCheckout")
    ?.addEventListener("click", handleCheckoutFromPage);
}

/* ============================================================ RECHERCHE VILLE ============================================================ B-PAN-2 : debounce 250ms sur l'input. Évite de filtrer 240 villes à chaque keypress. Le debounce est annulé quand l'utilisateur sélectionne une suggestion. ============================================================ */
function initCitySearchOnPage() {
  const input = document.getElementById("cityFilterInput");
  const suggestions = document.getElementById("citySuggestions");
  if (!input || !suggestions || input._initialized) return;
  input._initialized = true;

  /* Debounce via utils.debounce (annulable via .cancel()). */
  const debouncedSearch = debounce(() => {
    const q = input.value.trim().toLowerCase();
    const currentSelected = getSelectedCity();

    /* Si la valeur actuelle = nom de la ville déjà sélectionnée, ne rien faire (évite un clear du state). */
    if (
      currentSelected &&
      q === getCityName(currentSelected).toLowerCase().trim()
    )
      return;

    /* Si l'utilisateur tape, on désélectionne la ville courante. */
    delete input.dataset.cityId;
    setSelectedCity(null);
    refreshSummaryTotals();
    suggestions.innerHTML = "";

    const deliveryData = getState().deliveryData || [];

    /* Match exact → sélection automatique. */
    if (q.length >= 2) {
      const exactMatch = deliveryData.find((c) => {
        const vars = [c.nameFr, c.nameEn, c.nameAr || c.name, c.key]
          .filter(Boolean)
          .map((s) => String(s).toLowerCase().trim());
        return vars.some((v) => v === q);
      });
      if (exactMatch) {
        input.dataset.cityId = exactMatch.id;
        setSelectedCity(exactMatch);
        suggestions.classList.remove("active");
        refreshSummaryTotals();
        return;
      }
    }

    if (!q) {
      suggestions.classList.remove("active");
      return;
    }

    const matches = deliveryData
      .filter((c) => {
        const vars = [c.nameFr, c.nameEn, c.nameAr || c.name, c.key]
          .filter(Boolean)
          .map((s) => String(s).toLowerCase());
        return vars.some((v) => v.includes(q));
      })
      .slice(0, 20);

    if (matches.length === 0) {
      suggestions.classList.remove("active");
      return;
    }

    suggestions.classList.add("active");
    matches.forEach((city) => {
      const div = document.createElement("div");
      div.className = "city-suggestion-item";
      div.innerHTML = `<strong>${escapeHTML( getCityName(city) )}</strong> <span style="color:var(--gold);font-size:0.75rem;">${ city.price } MAD</span>`;
      div.addEventListener("click", () => {
        /* Annule tout debounce en attente avant de sélectionner. */
        debouncedSearch.cancel();
        input.value = getCityName(city);
        input.dataset.cityId = city.id;
        setSelectedCity(city);
        suggestions.classList.remove("active");
        refreshSummaryTotals();
      });
      suggestions.appendChild(div);
    });
  }, 250);

  input.addEventListener("input", debouncedSearch);

  document.addEventListener("click", (e) => {
    if (!suggestions.contains(e.target) && e.target !== input) {
      suggestions.classList.remove("active");
    }
  });
}

/* ============================================================ CHECKOUT ============================================================ */

/** * Valide les champs du formulaire, ouvre une fenêtre WhatsApp * immédiatement (pour préserver le geste utilisateur sur mobile), * puis délègue à checkout() de cart.js (Lot 10). * * B-PAN-1 : validation téléphone via isValidMoroccanPhone() * (06/07 + 10 chiffres). Avant, 9 chiffres quelconques * passaient. * B-PAN-3 : trim consistent sur tous les champs. * * @returns {Promise<void>} */
async function handleCheckoutFromPage() {
  const user = getCurrentUser();
  if (!user) {
    showToast(t("loginRequired"));
    document.dispatchEvent(new CustomEvent("open-account"));
    return;
  }

  /* B-PAN-3 : trim consistent. */
  const name = (document.getElementById("cartName")?.value || "").trim();
  const phone = (document.getElementById("cartPhone")?.value || "").trim();
  const address = (document.getElementById("cartAddress")?.value || "").trim();
  const email = (document.getElementById("cartEmail")?.value || "").trim();
  const deliveryNote = (
    document.getElementById("cartDeliveryNote")?.value || ""
  ).trim();
  const cityInput = document.getElementById("cityFilterInput");
  const selectedCity = getSelectedCity();
  const cityId = selectedCity?.id || cityInput?.dataset?.cityId;

  /* B-PAN-1 : validations strictes. */
  if (name.length < 2) {
    showToast("Nom invalide (min 2 caractères)");
    return;
  }

  if (!isValidMoroccanPhone(phone)) {
    showToast(
      "Numéro de téléphone marocain invalide (06XXXXXXXX ou 07XXXXXXXX)"
    );
    return;
  }

  if (address.length < 5) {
    showToast("Adresse trop courte (min 5 caractères)");
    return;
  }

  const finalEmail = email || user?.email || "";
  if (finalEmail && !isValidEmail(finalEmail)) {
    showToast("Format d'email invalide");
    return;
  }

  if (!cityId) {
    showToast(t("selectCityRequired"));
    return;
  }

  /* CART_CONSENT_REQUIRED : acceptation obligatoire des CGU Acheteur. */
  const consentEl = document.getElementById("acceptCguAcheteur");
  if (!consentEl || !consentEl.checked) {
    const box = document.getElementById("cartLegalConsent");
    if (box) {
      box.classList.add("legal-consent--invalid");
      setTimeout(() => box.classList.remove("legal-consent--invalid"), 1200);
      box.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (consentEl) consentEl.focus({ preventScroll: true });
    showToast(
      "Vous devez accepter les CGU Acheteur pour passer commande."
    );
    return;
  }

  const checkoutBtn = document.getElementById("cartPageCheckout");
  if (checkoutBtn) {
    checkoutBtn.disabled = true;
    checkoutBtn.textContent = "...";
  }

  /* Ouverture immédiate d'un onglet (préserve le geste utilisateur). */
  let waWindow = null;
  try {
    waWindow = window.open("", "_blank");
    if (waWindow) {
      waWindow.document.write(` <!DOCTYPE html> <html> <head> <title>Validation de la commande...</title> <meta name="viewport" content="width=device-width, initial-scale=1.0"> <style> body { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f8f6f2; font-family: system-ui, -apple-system, sans-serif; text-align: center; color: #1a1a2e; } h1 { color: #a57b2e; font-family: 'Georgia', serif; letter-spacing: 2px; margin-bottom: 10px; } .spinner { border: 4px solid #e0e0e0; border-top: 4px solid #a57b2e; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; } @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } } .msg { font-size: 15px; margin-top: 15px; font-weight: 600; } .submsg { font-size: 12px; color: #666; margin-top: 5px; } </style> </head> <body> <h1>SMARTSWIKA</h1> <div class="spinner"></div> <div class="msg">Validation de votre commande...</div> <div class="submsg">Ne fermez pas cette fenêtre.</div> </body> </html> `);
      waWindow.document.close();
    }
  } catch (e) {
    console.warn("[panier] Popup bloquée par le navigateur", e);
  }

  try {
    await revalidateCoupon();
    const result = await checkout(
      getCart(),
      {
        name,
        phone,
        address,
        email: finalEmail,
        note: deliveryNote,
        city: selectedCity
          ? getCityName(selectedCity)
          : cityInput?.value.trim() || "",
        cityId,
        cityAr: selectedCity?.nameAr || selectedCity?.name || "",
        cityFr: selectedCity?.nameFr || "",
      },
      appliedCoupon,
      waWindow
    );

    if (!result.success || !result.redirected) {
      if (waWindow && !waWindow.closed) waWindow.close();
      if (checkoutBtn && checkoutBtn.isConnected) {
        checkoutBtn.disabled = false;
        checkoutBtn.textContent = t("cartCheckout");
      }
    }
  } catch (e) {
    if (waWindow && !waWindow.closed) waWindow.close();
    showToast(e.message || "Erreur");
    if (checkoutBtn && checkoutBtn.isConnected) {
      checkoutBtn.disabled = false;
      checkoutBtn.textContent = t("cartCheckout");
    }
  }
}

/* ============================================================ DÉMARRAGE ============================================================ */
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", initCartPage);
else initCartPage();

console.log(
  "[panier] v9.0.0 chargé (Lot 24 : validation phone + debounce ville)"
);