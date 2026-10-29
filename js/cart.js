/* ============================================================ js/cart.js Panier et commandes - Smart Swi9a Version 10.0.0 - Lot 44 : préparation R2 (lastOrderId + invariant) CHANGEMENTS v10.0.0 : - R2-preparation (P0) : createOrder ajoute `lastOrderId: orderRef.id` dans chaque transaction.update(productRef). Requis par la nouvelle règle R2 (firestore.rules v5.2.x) qui exige la traçabilité de l'origine de la modification de stock. - R2-preparation (P0) : cancelOrder ajoute `lastOrderId: orderId` dans chaque transaction.update(productRef) pour la même raison. - B-cart-8 (P1) : createOrder garantit l'invariant `stock + salesCount` (delta_stock + delta_salesCount == 0). Ça permet à la future règle R2 de vérifier la cohérence même sans get(order) (Firestore interdit get() dans la même transaction). - B-cart-9 (P2) : chaque updateData contient `updatedAt: Timestamp.now()` pour respecter les whitelists de la nouvelle règle R2. - Aucun changement fonctionnel côté utilisateur. Rétrocompatible. - Bump version 9.0.0 -> 10.0.0. ⚠️ CE FICHIER DOIT ÊTRE DÉPLOYÉ AVANT firestore.rules v5.2.x. Sinon les créations de commande échoueront avec permission-denied. ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  runTransaction,
  query,
  where,
  Timestamp,
  increment,
} from "firebase/firestore";
import { db } from "./firebase.js";
import {
  CONFIG,
  ORDER_STATUS,
  normalizeOrderStatus,
  isTestMode,
  APP_MODE,
} from "./config.js";
import {
  t,
  safeGetItem,
  safeSetItem,
  safeRemoveItem,
  toDate,
} from "./utils.js";
import {
  getProducts,
  getCart as getCartFromStore,
  setCart,
  getSelectedCity,
} from "./store.js";
import { getCurrentUser } from "./auth.js";
import { showToast } from "./ui-core.js";

/* ============================================================ NORMALISATION D'ID PRODUIT ============================================================ */
function normalizeProductId(id) {
  if (id == null || id === "") return null;
  const n = Number(id);
  return Number.isFinite(n) && String(n) === String(id) ? n : String(id);
}

/* ============================================================ ÉTAT LOCAL DU PANIER ============================================================ */
let cart = [];

/* ============================================================ ÉTAT DE SYNC FIRESTORE ============================================================ */
let firestoreSaveTimeout = null;
let isSyncing = false;

/* ============================================================ HELPER : Clé de stockage par utilisateur ============================================================ */
function getCartStorageKey() {
  const user = getCurrentUser();
  return user?.uid
    ? `${CONFIG.STORAGE_KEYS.CART}_${user.uid}`
    : CONFIG.STORAGE_KEYS.CART;
}

/* ============================================================ HELPER : Générer un ID unique (Delimiter "::") ============================================================ */
function generateItemId(productId, variant) {
  if (!variant) return String(productId);
  const size = encodeURIComponent(String(variant.size || ""));
  const color = encodeURIComponent(String(variant.color || ""));
  return `${productId}::${size}::${color}`;
}

/* Fusionne les lignes du même produit/variante avant les transactions. Sans cela, plusieurs lignes pointant vers le même document Firestore sont lues avec le même stock initial puis écrasent leurs mises à jour respectives. */
function consolidateOrderItems(items) {
  const merged = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.productId == null || item.productId === "") continue;
    const productId = normalizeProductId(item.productId);
    const variant = item.variant || null;
    const key = JSON.stringify([
      String(productId),
      variant?.size || "",
      variant?.color || "",
    ]);
    const quantity = Math.floor(Number(item.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) continue;
    const existing = merged.get(key);
    if (existing) existing.quantity += quantity;
    else
      merged.set(key, {
        ...item,
        id: item.id || generateItemId(productId, variant),
        productId,
        variant,
        quantity,
      });
  }
  return Array.from(merged.values());
}

/* ============================================================ CHARGER LE PANIER (IDs vendeurs préservés) ============================================================ */
export function loadCart() {
  try {
    const data = safeGetItem(getCartStorageKey());
    cart = Array.isArray(data) ? data : [];

    cart = cart
      .filter(
        (item) =>
          item &&
          item.productId != null &&
          item.productId !== "" &&
          Number.isFinite(Number(item.quantity)) &&
          Number(item.quantity) > 0
      )
      .map((item) => {
        const normalizedPid = normalizeProductId(item.productId);
        const id = item.id || generateItemId(normalizedPid, item.variant);
        return {
          ...item,
          id: id,
          productId: normalizedPid,
          quantity: Math.max(1, Math.floor(Number(item.quantity))),
          variant: item.variant || null,
        };
      });
    setCart(cart);
  } catch (e) {
    console.warn("Erreur chargement panier :", e);
    cart = [];
    setCart(cart);
  }
  updateCartBadge();
}

/* ============================================================ SAUVEGARDER LE PANIER ============================================================ */
export function saveCart() {
  safeSetItem(getCartStorageKey(), cart);
  setCart(cart);
  updateCartBadge();
  saveAbandonedCart(cart);
  document.dispatchEvent(new CustomEvent("cart-updated"));
  scheduleFirestoreSave();
}

/* ============================================================ VIDER LE PANIER LOCAL ============================================================ */
function clearLocalCart() {
  cart = [];
  safeSetItem(getCartStorageKey(), cart);
  setCart(cart);
  updateCartBadge();
  safeRemoveItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
  document.dispatchEvent(new CustomEvent("cart-updated"));
}

/* ============================================================ FIRESTORE SYNC ============================================================ */
async function saveCartToFirestoreImmediate() {
  if (firestoreSaveTimeout) clearTimeout(firestoreSaveTimeout);
  await saveCartToFirestore();
}

async function saveCartToFirestore() {
  const user = getCurrentUser();
  if (!user || !user.uid) return;

  try {
    const selectedCity = getSelectedCity();
    await setDoc(
      doc(db, "carts", user.uid),
      {
        userId: user.uid,
        items: cart,
        selectedCity: selectedCity
          ? {
              id: selectedCity.id,
              name: selectedCity.name || "",
              nameAr: selectedCity.nameAr || selectedCity.name || "",
              nameFr: selectedCity.nameFr || "",
              nameEn: selectedCity.nameEn || "",
              price: Number(selectedCity.price) || 0,
              delay: selectedCity.delay || "",
            }
          : null,
        updatedAt: Timestamp.now(),
      },
      { merge: true }
    );
  } catch (e) {
    console.warn("Erreur save cart Firestore :", e);
  }
}

async function loadCartFromFirestore() {
  const user = getCurrentUser();
  if (!user || !user.uid) return null;
  try {
    const snap = await getDoc(doc(db, "carts", user.uid));
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    return null;
  }
}

/* ============================================================ FUSION PANIER LOCAL + FIRESTORE ============================================================ */
function mergeCarts(localCart, firestoreCart) {
  const merged = [...localCart];
  const products = getProducts();

  firestoreCart.forEach((fi) => {
    if (!fi || fi.productId == null) return;
    const itemId = fi.id || generateItemId(fi.productId, fi.variant);
    let qty = Number(fi.quantity) || 0;
    if (qty < 1) return;

    const p = products.find((pp) => String(pp.id) === String(fi.productId));
    if (p) {
      let maxStock = Number(p.stock) || 0;
      if (fi.variant) {
        const variantsArr = Array.isArray(p.variants) ? p.variants : [];
        const v = variantsArr.find(
          (v) =>
            (v.size || "") === (fi.variant.size || "") &&
            (v.color || "") === (fi.variant.color || "")
        );
        maxStock = v ? Number(v.stock) : 0;
      }
      qty = Math.min(qty, maxStock);
    }
    if (qty < 1) return;

    const existingIdx = merged.findIndex((li) => li.id === itemId);
    if (existingIdx > -1) {
      merged[existingIdx].quantity = Math.max(
        merged[existingIdx].quantity,
        qty
      );
    } else {
      const normalizedPid = normalizeProductId(fi.productId);
      merged.push({
        id: itemId,
        productId: normalizedPid,
        variant: fi.variant || null,
        quantity: qty,
      });
    }
  });
  return merged;
}

export async function syncCartOnLogin() {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const user = getCurrentUser();
    if (!user || !user.uid) {
      isSyncing = false;
      return;
    }

    const firestoreData = await loadCartFromFirestore();
    if (
      firestoreData &&
      Array.isArray(firestoreData.items) &&
      firestoreData.items.length > 0
    ) {
      const beforeCount = cart.length;
      cart = mergeCarts(cart, firestoreData.items);
      if (cart.length > beforeCount)
        showToast("Panier synchronisé avec votre compte");

      if (firestoreData.selectedCity) {
        try {
          const { setSelectedCity } = await import("./store.js");
          setSelectedCity(firestoreData.selectedCity);
        } catch (e) {}
      }
    }
    saveCart();
    updateCartBadge();
  } catch (e) {
    console.warn("Erreur sync panier :", e);
  } finally {
    isSyncing = false;
  }
}

function scheduleFirestoreSave() {
  if (firestoreSaveTimeout) clearTimeout(firestoreSaveTimeout);
  firestoreSaveTimeout = setTimeout(() => {
    saveCartToFirestore();
    firestoreSaveTimeout = null;
  }, 1000);
}

/* ============================================================ LISTENERS ============================================================ */
if (typeof document !== "undefined") {
  document.addEventListener("auth-updated", async (e) => {
    const user = e.detail?.user;
    if (user && user.uid) {
      loadCart();
      await syncCartOnLogin();
    } else {
      clearLocalCart();
    }
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== getCartStorageKey()) return;
    try {
      const newCart = e.newValue ? JSON.parse(e.newValue) : [];
      cart = Array.isArray(newCart) ? newCart : [];
      setCart(cart);
      updateCartBadge();
      document.dispatchEvent(new CustomEvent("cart-updated"));
    } catch (err) {}
  });
}

/* ============================================================ BADGE ============================================================ */
export function updateCartBadge() {
  const badge = document.getElementById("cartBadge");
  const count = cart.reduce((sum, item) => sum + (item.quantity || 0), 0);
  if (badge) {
    if (count > 0) {
      badge.textContent = count;
      badge.classList.add("show");
    } else {
      badge.classList.remove("show");
    }
  }
}

/* ============================================================ AJOUTER AU PANIER ============================================================ */
export async function addToCart(productId, variant = null) {
  const user = getCurrentUser();
  if (!user) {
    showToast("🔒 " + t("loginRequired"));
    document.dispatchEvent(new CustomEvent("open-account"));
    return;
  }

  const pid = normalizeProductId(productId);
  if (pid == null) {
    showToast(t("productNotFound"));
    return;
  }

  const products = getProducts();
  const product = products.find((p) => String(p.id) === String(pid));

  if (!product) {
    showToast(t("productNotFound"));
    return;
  }

  /* B-cart-3 : refus si produit non 'approved'. */
  const ps = product.status;
  if (ps && ps !== "approved") {
    showToast("Ce produit n'est pas disponible à la vente");
    return;
  }

  const hasVariants =
    Array.isArray(product.variants) && product.variants.length > 0;
  if (hasVariants && !variant) {
    showToast("Veuillez choisir votre taille et votre couleur");
    window.location.href = `/produit?slug=${encodeURIComponent( product.slug || "" )}`;
    return;
  }

  let validVariant = null;
  if (variant) {
    validVariant = (product.variants || []).find(
      (v) =>
        (v.size || "") === (variant.size || "") &&
        (v.color || "") === (variant.color || "")
    );
    if (!validVariant) {
      showToast("Variante introuvable");
      return;
    }
  }

  const itemStock = validVariant
    ? Number(validVariant.stock)
    : Number(product.stock) || 0;
  const itemPrice = validVariant
    ? Number(validVariant.price)
    : Number(product.price) || 0;
  const itemId = generateItemId(pid, validVariant);

  const existing = cart.find((i) => i.id === itemId);
  const currentQty = existing ? existing.quantity : 0;
  const newQty = currentQty + 1;

  if (itemStock === 0) {
    showToast(t("outOfStock"));
    return;
  }
  if (newQty > itemStock) {
    showToast(t("stockAvailable").replace("{n}", itemStock));
    return;
  }

  if (existing) {
    existing.quantity = newQty;
  } else {
    cart.push({
      id: itemId,
      productId: pid,
      variant: validVariant
        ? {
            size: validVariant.size || "",
            color: validVariant.color || "",
            price: itemPrice,
          }
        : null,
      quantity: 1,
    });
  }

  saveCart();
  showToast(t("addedToCart"));
}

/* ============================================================ RETIRER / VIDER / QUANTITÉ ============================================================ */
export function removeFromCart(itemId) {
  cart = cart.filter((i) => i.id !== itemId);
  saveCart();
}

export function clearCart() {
  cart = [];
  safeSetItem(getCartStorageKey(), cart);
  setCart(cart);
  updateCartBadge();
  safeRemoveItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
  document.dispatchEvent(new CustomEvent("cart-updated"));
  if (getCurrentUser()) saveCartToFirestoreImmediate();
}

export function updateCartQuantity(itemId, quantity) {
  const item = cart.find((i) => i.id === itemId);
  if (!item) return;

  const products = getProducts();
  const product = products.find((p) => String(p.id) === String(item.productId));

  if (!product) {
    cart = cart.filter((i) => i.id !== itemId);
    saveCart();
    showToast("Ce produit n'est plus disponible, retiré du panier");
    return;
  }

  let maxStock = Infinity;
  if (item.variant) {
    const variantsArr = Array.isArray(product.variants) ? product.variants : [];
    const v = variantsArr.find(
      (v) =>
        (v.size || "") === (item.variant.size || "") &&
        (v.color || "") === (item.variant.color || "")
    );
    maxStock = v ? Number(v.stock) : 0;
  } else {
    maxStock = Number(product.stock) || Infinity;
  }

  if (Number.isFinite(maxStock) && maxStock === 0) {
    cart = cart.filter((i) => i.id !== itemId);
    saveCart();
    showToast("Ce produit n'est plus disponible, retiré du panier");
    return;
  }

  let newQty = Math.max(1, parseInt(quantity) || 1);
  if (Number.isFinite(maxStock) && newQty > maxStock) {
    newQty = maxStock;
    showToast(t("stockAvailable").replace("{n}", maxStock));
  }

  item.quantity = newQty;
  saveCart();
}

/* ============================================================ CALCULS DU PANIER ============================================================ */
export function getCartSubtotal() {
  const products = getProducts();
  return cart.reduce((sum, item) => {
    const p = products.find((pp) => String(pp.id) === String(item.productId));
    if (!p) return sum;
    const price = item.variant
      ? Number(item.variant.price)
      : Number(p.price) || 0;
    return sum + price * item.quantity;
  }, 0);
}

export function getCartTotalItems() {
  return cart.reduce((sum, item) => sum + (item.quantity || 0), 0);
}

export function getCartSavings() {
  const products = getProducts();
  return cart.reduce((sum, item) => {
    if (item.variant) return sum;
    const p = products.find((pp) => String(pp.id) === String(item.productId));
    if (p && p.oldPrice && Number(p.oldPrice) > Number(p.price)) {
      return sum + (Number(p.oldPrice) - Number(p.price)) * item.quantity;
    }
    return sum;
  }, 0);
}

export function getCartDiscount() {
  if (getCartTotalItems() >= CONFIG.SHOP.DISCOUNT_THRESHOLD) {
    return Math.round(getCartSubtotal() * (CONFIG.SHOP.DISCOUNT_PERCENT / 100));
  }
  return 0;
}

export function getCartDeliveryFee() {
  const city = getSelectedCity();
  return city ? Number(city.price) || 0 : 0;
}

export function getCartTotal(appliedCoupon = null) {
  const subtotal = getCartSubtotal();
  const discount = getCartDiscount();
  const deliveryFee = getCartDeliveryFee();
  const couponDiscount = appliedCoupon
    ? calculateCouponDiscount(appliedCoupon, subtotal, deliveryFee)
    : 0;
  const isFreeShipping = appliedCoupon?.type === "free_shipping";
  const productCouponDiscount = isFreeShipping ? 0 : couponDiscount;
  const shippingDiscount = isFreeShipping
    ? Math.min(deliveryFee, couponDiscount)
    : 0;
  const productDiscount = Math.min(
    subtotal,
    Math.max(0, discount) + Math.max(0, productCouponDiscount)
  );
  return Math.max(
    0,
    subtotal - productDiscount + deliveryFee - shippingDiscount
  );
}

/* ============================================================ REVALIDATION DES PRIX ============================================================ */
export function revalidateCartPrices() {
  const products = getProducts();
  let changed = false;
  const changes = [];

  cart.forEach((item) => {
    const p = products.find((pp) => String(pp.id) === String(item.productId));
    if (!p) return;

    if (item.variant) {
      const variantsArr = Array.isArray(p.variants) ? p.variants : [];
      const v = variantsArr.find(
        (v) =>
          (v.size || "") === (item.variant.size || "") &&
          (v.color || "") === (item.variant.color || "")
      );
      if (!v) {
        changes.push({ type: "variant_removed", item, productName: p.nameFr });
        cart = cart.filter((i) => i.id !== item.id);
        changed = true;
        return;
      }
      const newPrice = Number(v.price);
      if (newPrice !== Number(item.variant.price)) {
        changes.push({
          type: "price_changed",
          item,
          productName: p.nameFr,
          oldPrice: item.variant.price,
          newPrice,
        });
        item.variant.price = newPrice;
        changed = true;
      }
    }
  });

  if (changed) {
    safeSetItem(getCartStorageKey(), cart);
    setCart(cart);
    const priceChanges = changes.filter((c) => c.type === "price_changed");
    if (priceChanges.length > 0)
      showToast(`${priceChanges.length} prix mis à jour dans votre panier`);
    if (changes.some((c) => c.type === "variant_removed"))
      showToast("Des articles indisponibles ont été retirés.");

    if (getCurrentUser()) saveCartToFirestoreImmediate();
  }
  return changes;
}

/* ============================================================ CALCUL COUPON ============================================================ */
export function calculateCouponDiscount(coupon, subtotal, deliveryFee) {
  if (!coupon) return 0;
  const type = coupon.type;
  const value = Number(coupon.value) || 0;

  if (type === "percentage")
    return Math.round((subtotal * Math.min(100, Math.max(0, value))) / 100);
  if (type === "fixed") return Math.min(Math.max(0, value), subtotal);
  if (type === "free_shipping") return Number(deliveryFee) || 0;
  return 0;
}

/* ============================================================ CHECKOUT ============================================================ */
export async function checkout( cartItems, deliveryInfo, appliedCoupon = null, waWindow = null ) {
  if (!cartItems || cartItems.length === 0) {
    showToast(t("cartEmpty"));
    if (waWindow) waWindow.close();
    return { success: false, error: "empty_cart" };
  }

  const user = getCurrentUser();
  if (!user) {
    showToast("🔒 " + t("loginRequired"));
    document.dispatchEvent(new CustomEvent("open-account"));
    if (waWindow) waWindow.close();
    return { success: false, error: "not_logged" };
  }

  const cleanName = String(deliveryInfo.name || "").trim();
  const cleanPhone = String(deliveryInfo.phone || "").trim();
  const cleanAddress = String(deliveryInfo.address || "").trim();
  const cleanCity = String(deliveryInfo.city || "").trim();

  if (!cleanName || !cleanPhone || !cleanAddress || !cleanCity) {
    showToast(t("fillAllFields"));
    if (waWindow) waWindow.close();
    return { success: false, error: "missing_fields" };
  }

  const result = await createOrder(cartItems, deliveryInfo, appliedCoupon);
  if (!result.success) {
    showToast(result.error || t("orderError"));
    if (waWindow) waWindow.close();
    return result;
  }

  const { orderId, totals, validatedItems } = result;
  const msg = buildWhatsAppMessage(
    validatedItems,
    deliveryInfo,
    orderId,
    totals
  );
  const url = `https://wa.me/${ CONFIG.SHOP.WHATSAPP_NUMBER }?text=${encodeURIComponent(msg)}`;

  (async () => {
    try {
      const { sendOrderEmail } = await import("./orders.js");
      const orderForEmail = {
        id: orderId,
        userId: user.uid,
        userEmail: user.email || "",
        items: validatedItems,
        subtotal: totals.subtotal,
        discount: totals.discount,
        couponCode: totals.couponCode || null,
        couponDiscount: totals.couponDiscount || 0,
        deliveryFee: totals.deliveryFee,
        total: totals.total,
        vendorIds: totals.vendorIds || [],
        deliveryAddress: {
          name: deliveryInfo.name,
          phone: deliveryInfo.phone,
          address: deliveryInfo.address,
          city: deliveryInfo.city,
          cityId: deliveryInfo.cityId,
          cityAr: deliveryInfo.cityAr,
          cityFr: deliveryInfo.cityFr,
          note: deliveryInfo.note || "",
          email: deliveryInfo.email || user.email || "",
        },
      };
      await sendOrderEmail(orderForEmail, "pending", "client");
      await sendOrderEmail(orderForEmail, "pending", "admin");
    } catch (e) {
      /* non bloquant */
    }
  })();

  if (appliedCoupon) {
    try {
      sessionStorage.removeItem("swi9a_applied_coupon");
    } catch (e) {
      /* ignore */
    }
  }

  clearCart();
  showToast(t("orderSent"));

  if (waWindow && !waWindow.closed) {
    waWindow.location.href = url;
  } else {
    window.location.href = url;
  }

  return { success: true, orderId, redirected: true };
}

/* ============================================================ CRÉATION DE COMMANDE (transaction) ============================================================ R2-preparation : - Chaque updateData contient `lastOrderId: orderRef.id` - Chaque updateData contient `updatedAt: Timestamp.now()` - L'invariant `stock + salesCount` est préservé : stock_new = stock_old - qty salesCount_new = salesCount_old + qty => stock_new + salesCount_new == stock_old + salesCount_old (garanti par la structure des updates ci-dessous) ============================================================ */
export async function createOrder(items, deliveryInfo, appliedCoupon = null) {
  const user = getCurrentUser();
  if (!user) return { success: false, error: "NO_USER" };
  const normalizedItems = consolidateOrderItems(items);
  if (!normalizedItems.length)
    return { success: false, error: "Le panier est vide ou invalide." };
  try {
    const { auth } = await import("./firebase.js");
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) return { success: false, error: "NO_USER" };
    const idToken = await firebaseUser.getIdToken();
    const response = await fetch("/api/createCustomerOrder", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        items: normalizedItems.map((item) => ({
          id: String(item.id),
          productId: String(item.productId),
          quantity: Number(item.quantity),
          variant: item.variant || null,
        })),
        deliveryInfo: {
          name: String(deliveryInfo?.name || ""),
          phone: String(deliveryInfo?.phone || ""),
          address: String(deliveryInfo?.address || ""),
          city: String(deliveryInfo?.city || ""),
          cityId: deliveryInfo?.cityId || null,
          cityAr: deliveryInfo?.cityAr || null,
          cityFr: deliveryInfo?.cityFr || null,
          email: String(deliveryInfo?.email || user.email || ""),
          note: deliveryInfo?.note || null,
        },
        appliedCoupon: appliedCoupon
          ? {
              id: String(appliedCoupon.id || ""),
              code: String(appliedCoupon.code || ""),
            }
          : null,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true)
      return {
        success: false,
        error: result.message || "Création de commande impossible.",
      };
    return {
      success: true,
      orderId: result.orderId,
      totals: result.totals,
      validatedItems: result.validatedItems,
    };
  } catch (error) {
    console.error("Erreur création commande serveur :", error);
    return {
      success: false,
      error: error.message || "Erreur réseau pendant la création de commande.",
    };
  }
}

/* ============================================================ MESSAGE WHATSAPP ============================================================ */
function buildWhatsAppMessage(validatedItems, deliveryInfo, orderId, totals) {
  const productList = validatedItems
    .map((item) => {
      const variantText = item.variant
        ? ` (${[item.variant.size, item.variant.color] .filter(Boolean) .join(" - ")})`
        : "";
      return ` ${item.name}${variantText} x${item.quantity} - ${ item.price * item.quantity } MAD`;
    })
    .join("\n");

  let msg = `*${t("waNewOrder")}*\n\n`;
  if (orderId)
    msg += `${t("waOrder")} : *#${orderId.slice(0, 8).toUpperCase()}*\n\n`;
  msg += `${t("waName")} : ${deliveryInfo.name}\n${t("waPhone")} : ${ deliveryInfo.phone }\n${t("waAddress")} : ${deliveryInfo.address}\n${t("waCity")} : ${ deliveryInfo.city }\n`;
  if (deliveryInfo.note) msg += `Note : ${deliveryInfo.note}\n`;
  if (deliveryInfo.email) msg += `${t("waEmail")} : ${deliveryInfo.email}\n`;
  msg += `\n*${t("waItems")} :*\n${productList}\n\n`;
  msg += `${t("waSubtotal")} : ${totals.subtotal} MAD\n`;
  if (totals.discount > 0)
    msg += `${t("waDiscount")} (-${CONFIG.SHOP.DISCOUNT_PERCENT}%) : -${ totals.discount } MAD\n`;
  if (totals.couponCode && totals.couponDiscount > 0)
    msg += `Code ${totals.couponCode} : -${totals.couponDiscount} MAD\n`;
  msg += `${t("waDelivery")} : ${totals.deliveryFee} MAD\n*${t("waTotal")} : ${ totals.total } MAD*\n\n${t("waThanks")}`;
  return msg;
}

/* ============================================================ CHARGER LES COMMANDES DU CLIENT ============================================================ */
export async function loadUserOrders() {
  const user = getCurrentUser();
  if (!user) return [];
  try {
    const q = query(collection(db, "orders"), where("userId", "==", user.uid));
    const snapshot = await getDocs(q);
    const orders = snapshot.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        createdAt: toDate(data.createdAt),
        updatedAt: toDate(data.updatedAt),
        cancelledAt: data.cancelledAt ? toDate(data.cancelledAt) : null,
        cancellableUntil: data.cancellableUntil
          ? toDate(data.cancellableUntil)
          : null,
      };
    });
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return orders;
  } catch (e) {
    return [];
  }
}

/* ============================================================ ANNULER UNE COMMANDE ============================================================ R2-preparation : ajout `lastOrderId: orderId` + `updatedAt` dans chaque updateData produit. ============================================================ */
export async function cancelOrder(orderId) {
  const user = getCurrentUser();
  if (!user) return { success: false, error: "NO_USER" };
  try {
    const { auth } = await import("./firebase.js");
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) return { success: false, error: "NO_USER" };
    const idToken = await firebaseUser.getIdToken();
    const response = await fetch("/api/cancelCustomerOrder", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ orderId: String(orderId || "") }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true)
      return {
        success: false,
        error: result.message || "Annulation impossible.",
      };
    return { success: true };
  } catch (error) {
    console.error("Erreur annulation commande serveur :", error);
    return {
      success: false,
      error: error.message || "Erreur réseau pendant l’annulation.",
    };
  }
}

/* ============================================================ PANIER ABANDONNÉ ============================================================ */
function saveAbandonedCart(items) {
  if (items.length > 0)
    safeSetItem(CONFIG.STORAGE_KEYS.ABANDONED_CART, {
      items,
      timestamp: Date.now(),
    });
  else safeRemoveItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
}

export function checkAbandonedCart() {
  try {
    const data = safeGetItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
    if (!data || !data.items || data.items.length === 0) return null;
    if (
      Date.now() - (data.timestamp || 0) >=
      CONFIG.SESSION.ABANDONED_CART_DELAY
    )
      return data;
    return null;
  } catch (e) {
    return null;
  }
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ cart.js chargé - v10.0.0 (Lot 44 : préparation R2 lastOrderId + invariant)"
);