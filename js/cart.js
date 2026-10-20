// js/cart.js
// ============================================================
// PANIER ET COMMANDES - SMART SWI9A
// Version 3.0.0 — Refonte complète (financier + sécurité + isolation)
// ============================================================
// CHANGEMENTS v3.0.0 :
// ✅ C5.1 — revalidateCartPrices() : prix Firestore prioritaire
// ✅ C5.2 — checkout(…, waWindow) : WhatsApp anti-popup-block
// ✅ C5.3 — localStorage isolé par uid (fin contamination)
// ✅ C5.4 — oneUsePerUser via ID déterministe DANS transaction
// ✅ C5.5 — stockDeducted: true dès la création (fin surstock)
// ✅ I5.1 — Variante supprimée → item retiré + toast
// ✅ I5.2 — IDs variantes avec "::" (fin collision M_L)
// ✅ I5.3 — (logique de restauration coupon dans orders.js)
// ✅ I5.4 — getCartSavings skip variants
// ✅ I5.5 — getCartTotal(appliedCoupon) accepte le coupon
// ✅ I5.6 — calculateCouponDiscount via services/coupons.js
// ✅ M5.1 — clearLocalCart() documenté
// ✅ M5.2 — mergeCarts() plafonné au stock
// ✅ M5.3 — Messages stock avec label variante
// ✅ M5.4 — (fix WhatsApp dans whatsapp.js)
// ✅ M5.5 — addToCart valide le variant
// ✅ M5.6 — loadUserOrders orderBy + fallback
// ✅ M5.7 — (TTL Firestore à documenter côté rules)
// ✅ M5.8 — Toast au sync login
// ✅ M5.9 — % promo via CONFIG.SHOP.DISCOUNT_PERCENT
// ============================================================
// Dépend de : config, utils, store, firebase, auth, ui-core, services/coupons
// ============================================================

import {
    collection, doc, getDoc, getDocs, setDoc, runTransaction,
    query, where, orderBy, Timestamp, increment
} from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG, ORDER_STATUS, normalizeOrderStatus } from "./config.js";
import {
    t, safeGetItem, safeSetItem, safeRemoveItem,
    toDate, getLang
} from "./utils.js";
import {
    getProducts, getCart, setCart, getSelectedCity
} from "./store.js";
import { getCurrentUser } from "./auth.js";
import { showToast, confirmAction } from "./ui-core.js";
import { calculateCouponDiscount } from "./services/coupons.js";

// ============================================================
// ÉTAT LOCAL DU PANIER
// ============================================================
let cart = [];

// ============================================================
// ÉTAT DE SYNC FIRESTORE
// ============================================================
let firestoreSaveTimeout = null;
let isSyncing = false;

// ============================================================
// ✅ C5.3 — Clé localStorage isolée par utilisateur
// ------------------------------------------------------------
// Anonyme      → CONFIG.STORAGE_KEYS.CART           ("swi9a_cart")
// Connecté UID → "swi9a_cart_{uid}"
//
// Empêche la contamination sur appareil partagé (Fatima ≠ Ahmed).
// ============================================================
function getCartStorageKey() {
    const user = getCurrentUser();
    return user?.uid
        ? `${CONFIG.STORAGE_KEYS.CART}_${user.uid}`
        : CONFIG.STORAGE_KEYS.CART;
}

/**
 * Charge le panier depuis localStorage.
 * Migration one-shot : si la clé user-specific n'existe pas mais que
 * l'ancienne clé globale existe, on migre (user avait déjà un panier
 * avant la mise à jour v3.0.0).
 */
function readCartFromStorage() {
    const userKey = getCartStorageKey();
    const globalKey = CONFIG.STORAGE_KEYS.CART;

    // 1. Essai direct (clé courante)
    let data = safeGetItem(userKey);

    // 2. Migration one-shot : la clé user-specific n'existe pas mais
    //    l'ancienne clé globale contient un panier → on migre
    if (data === null && userKey !== globalKey) {
        const legacy = safeGetItem(globalKey);
        if (legacy && Array.isArray(legacy) && legacy.length > 0) {
            data = legacy;
            safeSetItem(userKey, legacy);
            safeRemoveItem(globalKey);
            console.log('🔄 Panier migré vers clé user-specific');
        }
    }

    return data;
}

function writeCartToStorage(cartData) {
    safeSetItem(getCartStorageKey(), cartData);
}

// ============================================================
// ✅ I5.2 — Génération d'ID unique (délimiteur "::" anti-collision)
// ------------------------------------------------------------
// Avant : "123_M_L_" pouvait matcher ({size:'M_L', color:''} == {size:'M', color:'_L'})
// Après : "123::M_L::" et "123::M::_L" sont distincts
// ============================================================
function generateItemId(productId, variant) {
    if (!variant) return String(productId);
    const size = encodeURIComponent(String(variant.size || ''));
    const color = encodeURIComponent(String(variant.color || ''));
    return `${productId}::${size}::${color}`;
}

/**
 * Reconstruit un ID depuis un item potentiellement ancien (fallback _ → ::).
 * Utilisé lors du chargement pour compat.
 */
function normalizeItemId(item) {
    if (!item) return '';
    if (item.id && String(item.id).includes('::')) return String(item.id);
    // Fallback : régénérer
    return generateItemId(item.productId, item.variant);
}

// ============================================================
// CHARGER LE PANIER
// ============================================================
export function loadCart() {
    try {
        const data = readCartFromStorage();
        cart = Array.isArray(data) ? data : [];

        cart = cart.filter(item =>
            item &&
            Number.isFinite(Number(item.productId)) &&
            Number.isFinite(Number(item.quantity)) &&
            Number(item.quantity) > 0
        ).map(item => ({
            ...item,
            id: normalizeItemId(item),
            productId: Number(item.productId),
            quantity: Math.max(1, Math.floor(Number(item.quantity))),
            variant: item.variant || null
        }));

        setCart(cart);
    } catch (e) {
        console.warn('⚠️ Erreur chargement panier :', e);
        cart = [];
        setCart(cart);
    }
    updateCartBadge();
}

// ============================================================
// SAUVEGARDER LE PANIER
// ============================================================
export function saveCart() {
    writeCartToStorage(cart);
    setCart(cart);
    updateCartBadge();
    saveAbandonedCart(cart);
    document.dispatchEvent(new CustomEvent('cart-updated'));
    scheduleFirestoreSave();
}

// ============================================================
// ✅ M5.1 — VIDER LE PANIER LOCAL
// ------------------------------------------------------------
// Ne touche PAS Firestore (le doc carts/{uid} sera mis à jour via
// scheduleFirestoreSave après clearCart côté public).
// Utilisé au logout pour isoler le prochain user (C5.3).
// ============================================================
function clearLocalCart() {
    cart = [];
    safeRemoveItem(getCartStorageKey());
    // ⚠️ Sécurité : on supprime aussi la clé globale au cas où
    // (évite qu'un ancien item traîne après un logout)
    safeRemoveItem(CONFIG.STORAGE_KEYS.CART);
    setCart(cart);
    updateCartBadge();
    safeRemoveItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
    document.dispatchEvent(new CustomEvent('cart-updated'));
    console.log('🧹 Panier local vidé (isolation C5.3)');
}

// ============================================================
// ✅ C5.1 — REVALIDATION DES PRIX (appelée au boot par app.js)
// ------------------------------------------------------------
// Compare les prix stockés dans le panier avec les prix Firestore.
// Met à jour silencieusement + notifie l'utilisateur.
// Retourne un rapport des changements pour debug/tests.
// ============================================================
export function revalidateCartPrices() {
    const products = getProducts();
    if (!Array.isArray(products) || products.length === 0) {
        return { changed: 0, removed: 0, changes: [] };
    }

    let changed = false;
    const changes = [];
    const toRemove = [];

    cart.forEach(item => {
        const product = products.find(pp => Number(pp.id) === item.productId);

        // Produit supprimé du catalogue
        if (!product) {
            toRemove.push(item.id);
            changes.push({ type: 'product_removed', item, productName: `#${item.productId}` });
            return;
        }

        // Cas 1 : variant
        if (item.variant) {
            const v = (product.variants || []).find(v =>
                (v.size || '') === (item.variant.size || '') &&
                (v.color || '') === (item.variant.color || '')
            );

            if (!v) {
                toRemove.push(item.id);
                changes.push({
                    type: 'variant_removed',
                    item,
                    productName: product.nameFr || `#${product.id}`
                });
                return;
            }

            const newPrice = Number(v.price) || 0;
            const oldPrice = Number(item.variant.price) || 0;
            if (newPrice !== oldPrice) {
                item.variant.price = newPrice;
                changed = true;
                changes.push({
                    type: 'price_changed',
                    item,
                    productName: product.nameFr || `#${product.id}`,
                    oldPrice,
                    newPrice
                });
            }
            return;
        }

        // Cas 2 : produit sans variant
        const newPrice = Number(product.price) || 0;
        const oldPrice = Number(item.price) || 0;
        // On stocke le prix dans l'item aussi pour compat
        if (item.price !== undefined && newPrice !== oldPrice) {
            item.price = newPrice;
            changed = true;
            changes.push({
                type: 'price_changed',
                item,
                productName: product.nameFr || `#${product.id}`,
                oldPrice,
                newPrice
            });
        }
    });

    // Retirer les items invalides
    if (toRemove.length > 0) {
        cart = cart.filter(i => !toRemove.includes(i.id));
        changed = true;
    }

    if (changed) {
        saveCart();
        const priceChanges = changes.filter(c => c.type === 'price_changed');
        const removedItems = changes.filter(c => c.type === 'product_removed' || c.type === 'variant_removed');

        if (priceChanges.length > 0) {
            showToast(`⚠️ ${priceChanges.length} prix mis à jour dans votre panier`);
        }
        if (removedItems.length > 0) {
            showToast(`⚠️ ${removedItems.length} article(s) indisponible(s) retiré(s)`);
        }
    }

    return {
        changed: changed ? 1 : 0,
        removed: toRemove.length,
        changes
    };
}

// ============================================================
// FIRESTORE SYNC
// ============================================================
async function saveCartToFirestoreImmediate() {
    if (firestoreSaveTimeout) {
        clearTimeout(firestoreSaveTimeout);
        firestoreSaveTimeout = null;
    }
    await saveCartToFirestore();
}

async function saveCartToFirestore() {
    const user = getCurrentUser();
    if (!user || !user.uid) return;

    try {
        const selectedCity = getSelectedCity();

        await setDoc(doc(db, "carts", user.uid), {
            userId: user.uid,
            items: cart,
            selectedCity: selectedCity ? {
                id: selectedCity.id,
                name: selectedCity.name || '',
                nameAr: selectedCity.nameAr || selectedCity.name || '',
                nameFr: selectedCity.nameFr || '',
                nameEn: selectedCity.nameEn || '',
                price: Number(selectedCity.price) || 0,
                delay: selectedCity.delay || ''
            } : null,
            updatedAt: Timestamp.now()
        }, { merge: true });

        console.log(`✅ Panier sauvegardé sur Firestore (${cart.length} articles)`);
    } catch (e) {
        console.warn('⚠️ Erreur save cart Firestore :', e);
    }
}

async function loadCartFromFirestore() {
    const user = getCurrentUser();
    if (!user || !user.uid) return null;
    try {
        const snap = await getDoc(doc(db, "carts", user.uid));
        return snap.exists() ? snap.data() : null;
    } catch (e) {
        console.warn('⚠️ Erreur load cart Firestore :', e);
        return null;
    }
}

// ✅ M5.2 — Fusion plafonnée au stock réel
function mergeCarts(localCart, firestoreCart) {
    const products = getProducts();
    const merged = [...localCart];

    firestoreCart.forEach(fi => {
        if (!fi || !fi.productId) return;

        const itemId = normalizeItemId(fi);
        const qty = Number(fi.quantity) || 0;
        if (qty < 1) return;

        // Plafonner au stock réel
        const product = products.find(p => Number(p.id) === Number(fi.productId));
        let maxStock = Infinity;
        if (product) {
            if (fi.variant) {
                const v = (product.variants || []).find(v =>
                    (v.size || '') === (fi.variant.size || '') &&
                    (v.color || '') === (fi.variant.color || '')
                );
                maxStock = v ? Number(v.stock) : 0;
            } else {
                maxStock = Number(product.stock) || 0;
            }
        }
        const finalQty = Math.min(qty, maxStock);
        if (finalQty < 1) return; // stock épuisé → skip

        const existingIdx = merged.findIndex(li => li.id === itemId);
        if (existingIdx > -1) {
            const target = Math.min(
                Math.max(merged[existingIdx].quantity, finalQty),
                maxStock
            );
            merged[existingIdx].quantity = target;
        } else {
            merged.push({
                id: itemId,
                productId: Number(fi.productId),
                variant: fi.variant || null,
                quantity: finalQty
            });
        }
    });

    return merged;
}

// ✅ M5.8 — Toast explicite au sync
export async function syncCartOnLogin() {
    if (isSyncing) return;
    isSyncing = true;
    try {
        const user = getCurrentUser();
        if (!user || !user.uid) { isSyncing = false; return; }

        console.log('🔄 Sync panier Firestore pour', user.uid);

        // Charger le panier user-specific depuis localStorage
        const userData = readCartFromStorage();
        const localCart = Array.isArray(userData) ? userData : [];
        cart = localCart;

        const firestoreData = await loadCartFromFirestore();

        if (firestoreData && Array.isArray(firestoreData.items) && firestoreData.items.length > 0) {
            const beforeCount = cart.length;
            cart = mergeCarts(cart, firestoreData.items);

            if (beforeCount === 0 && cart.length > 0) {
                showToast(`✅ Panier restauré (${cart.length} article${cart.length > 1 ? 's' : ''})`);
            } else if (beforeCount > 0 && cart.length !== beforeCount) {
                showToast(`🔄 Panier synchronisé (${cart.length} articles)`);
            }

            if (firestoreData.selectedCity) {
                try {
                    const { setSelectedCity } = await import("./store.js");
                    setSelectedCity(firestoreData.selectedCity);
                } catch (e) {
                    console.warn('⚠️ Erreur restauration ville :', e);
                }
            }
        }

        saveCart();
        const sidebar = document.getElementById('cartSidebar');
        if (sidebar && sidebar.classList.contains('open')) {
            const { renderCartContent } = await import("./ui.js");
            renderCartContent();
        }
        updateCartBadge();
    } catch (e) {
        console.warn('⚠️ Erreur sync panier :', e);
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

// ============================================================
// LISTENER "auth-updated"
// ============================================================
if (typeof document !== 'undefined') {
    document.addEventListener('auth-updated', async (e) => {
        const user = e.detail?.user;

        if (user && user.uid) {
            console.log('👤 Client connecté — sync panier Firestore');
            await syncCartOnLogin();
        } else {
            console.log('👤 Client déconnecté — vidage du panier local (isolation)');
            clearLocalCart();
        }
    });
}

// ============================================================
// SYNCHRONISATION MULTI-ONGLETS
// ============================================================
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        const userKey = getCartStorageKey();
        // Accepter la clé globale ET la clé user-specific
        if (e.key !== userKey && e.key !== CONFIG.STORAGE_KEYS.CART) return;
        try {
            const newCart = e.newValue ? JSON.parse(e.newValue) : [];
            cart = Array.isArray(newCart) ? newCart : [];
            setCart(cart);
            updateCartBadge();
            document.dispatchEvent(new CustomEvent('cart-updated'));
            const sidebar = document.getElementById('cartSidebar');
            if (sidebar && sidebar.classList.contains('open')) {
                import("./ui.js").then(m => m.renderCartContent());
            }
        } catch (err) {
            console.warn('⚠️ Erreur sync panier inter-onglets :', err);
        }
    });
}

// ============================================================
// BADGE DU PANIER
// ============================================================
export function updateCartBadge() {
    const badge = document.getElementById('cartBadge');
    const count = cart.reduce((sum, item) => sum + (item.quantity || 0), 0);
    if (badge) {
        if (count > 0) {
            badge.textContent = count;
            badge.classList.add('show');
        } else {
            badge.classList.remove('show');
        }
    }
}

// ============================================================
// ✅ M5.5 — AJOUTER AU PANIER (valide le variant)
// ============================================================
export async function addToCart(productId, variant = null) {
    const user = getCurrentUser();
    if (!user) {
        showToast('🔒 ' + t('loginRequired'));
        document.dispatchEvent(new CustomEvent('open-account'));
        return;
    }

    const pid = Number(productId);
    const products = getProducts();
    const product = products.find(p => Number(p.id) === pid);

    if (!product) {
        showToast('⚠️ ' + t('productNotFound'));
        return;
    }

    // Produit avec variantes : exiger un variant valide
    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
    if (hasVariants) {
        if (!variant) {
            showToast('⚠️ Veuillez choisir votre taille et votre couleur');
            window.location.href = `/produit?slug=${encodeURIComponent(product.slug || '')}`;
            return;
        }

        // ✅ M5.5 : le variant doit exister dans product.variants
        const match = product.variants.find(v =>
            (v.size || '') === (variant.size || '') &&
            (v.color || '') === (variant.color || '')
        );
        if (!match) {
            showToast('⚠️ Variante introuvable, veuillez re-sélectionner');
            return;
        }
        if (Number(match.stock) <= 0) {
            showToast('⚠️ ' + t('outOfStock') + ' : ' + formatVariantLabel(match));
            return;
        }
    }

    // Déterminer le stock et le prix
    const itemStock = variant ? Number(variant.stock) : (Number(product.stock) || 0);
    const itemPrice = variant ? Number(variant.price) : (Number(product.price) || 0);
    const itemId = generateItemId(pid, variant);

    const existing = cart.find(i => i.id === itemId);
    const currentQty = existing ? existing.quantity : 0;
    const newQty = currentQty + 1;

    if (itemStock === 0) {
        showToast('⚠️ ' + t('outOfStock'));
        return;
    }
    if (newQty > itemStock) {
        // ✅ M5.3 : message avec label variante
        const label = variant ? ` (${formatVariantLabel(variant)})` : '';
        showToast(`⚠️ ${t('stockAvailable').replace('{n}', itemStock)}${label}`);
        return;
    }

    if (existing) {
        existing.quantity = newQty;
    } else {
        cart.push({
            id: itemId,
            productId: pid,
            variant: variant ? {
                size: variant.size || '',
                color: variant.color || '',
                price: itemPrice
            } : null,
            quantity: 1
        });
    }

    saveCart();
    showToast('✅ ' + t('addedToCart'));
}

// ============================================================
// HELPERS VARIANT LABEL
// ============================================================
function formatVariantLabel(variant) {
    if (!variant) return '';
    const parts = [variant.size, variant.color].filter(Boolean);
    return parts.join(' - ');
}

// ============================================================
// RETIRER DU PANIER
// ============================================================
export function removeFromCart(itemId) {
    cart = cart.filter(i => i.id !== itemId);
    saveCart();
}

// ============================================================
// VIDER LE PANIER
// ============================================================
export function clearCart() {
    cart = [];
    safeRemoveItem(getCartStorageKey());
    setCart(cart);
    updateCartBadge();
    safeRemoveItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
    document.dispatchEvent(new CustomEvent('cart-updated'));

    if (getCurrentUser()) {
        saveCartToFirestoreImmediate();
    }
}

// ============================================================
// MODIFIER LA QUANTITÉ
// ============================================================
export function updateCartQuantity(itemId, quantity) {
    const item = cart.find(i => i.id === itemId);
    if (!item) return;

    const products = getProducts();
    const product = products.find(p => Number(p.id) === item.productId);

    let maxStock = Infinity;
    if (item.variant) {
        const v = product?.variants?.find(v =>
            (v.size || '') === (item.variant.size || '') &&
            (v.color || '') === (item.variant.color || '')
        );
        maxStock = v ? Number(v.stock) : 0;
    } else {
        maxStock = product ? Number(product.stock) || Infinity : Infinity;
    }

    // ✅ I5.1 — Variante supprimée / stock 0 → retirer du panier
    if (Number.isFinite(maxStock) && maxStock === 0) {
        cart = cart.filter(i => i.id !== itemId);
        saveCart();
        showToast('⚠️ Produit indisponible, retiré du panier');
        return;
    }

    let newQty = Math.max(1, parseInt(quantity) || 1);
    if (Number.isFinite(maxStock) && newQty > maxStock) {
        newQty = maxStock;
        const label = item.variant
            ? ` (${formatVariantLabel(item.variant)})`
            : '';
        showToast(`⚠️ ${t('stockAvailable').replace('{n}', maxStock)}${label}`);
    }

    item.quantity = newQty;
    saveCart();
}

// ============================================================
// CALCULS DU PANIER
// ============================================================
export function getCartSubtotal() {
    const products = getProducts();
    return cart.reduce((sum, item) => {
        const p = products.find(pp => Number(pp.id) === item.productId);
        if (!p) return sum;
        const price = item.variant
            ? Number(item.variant.price)
            : (Number(p.price) || 0);
        return sum + price * item.quantity;
    }, 0);
}

export function getCartTotalItems() {
    return cart.reduce((sum, item) => sum + (item.quantity || 0), 0);
}

// ✅ I5.4 — Skip les variants (pas de oldPrice par variant)
export function getCartSavings() {
    const products = getProducts();
    return cart.reduce((sum, item) => {
        if (item.variant) return sum; // ✅ pas de "savings" fiable pour variants
        const p = products.find(pp => Number(pp.id) === item.productId);
        if (p && p.oldPrice && Number(p.oldPrice) > Number(p.price)) {
            return sum + (Number(p.oldPrice) - Number(p.price)) * item.quantity;
        }
        return sum;
    }, 0);
}

export function getCartDiscount() {
    const totalItems = getCartTotalItems();
    if (totalItems >= CONFIG.SHOP.DISCOUNT_THRESHOLD) {
        return Math.round(getCartSubtotal() * (CONFIG.SHOP.DISCOUNT_PERCENT / 100));
    }
    return 0;
}

export function getCartDeliveryFee() {
    const city = getSelectedCity();
    if (!city) return 0;
    return Number(city.price) || 0;
}

// ✅ I5.5 — Accepte le coupon pour un total correct
export function getCartTotal(appliedCoupon = null) {
    const subtotal = getCartSubtotal();
    const discount = getCartDiscount();
    const deliveryFee = getCartDeliveryFee();
    const couponDiscount = appliedCoupon
        ? calculateCouponDiscount(appliedCoupon, subtotal, deliveryFee)
        : 0;
    const totalDiscount = Math.min(discount + couponDiscount, subtotal);
    return Math.max(0, subtotal - totalDiscount + deliveryFee);
}

// ============================================================
// ✅ C5.2 — CHECKOUT (anti-popup-block via waWindow)
// ------------------------------------------------------------
// Le caller (panier.js) doit ouvrir une fenêtre vide AVANT les awaits :
//   const waWindow = window.open('', '_blank');
//   await checkout(..., waWindow);
// Si le checkout échoue, fermer waWindow pour éviter un onglet blanc.
// ============================================================
export async function checkout(cartItems, deliveryInfo, appliedCoupon = null, waWindow = null) {
    if (!cartItems || cartItems.length === 0) {
        showToast('⚠️ ' + t('cartEmpty'));
        return;
    }

    const user = getCurrentUser();
    if (!user) {
        showToast('🔒 ' + t('loginRequired'));
        document.dispatchEvent(new CustomEvent('open-account'));
        return;
    }

    const cleanName = String(deliveryInfo.name || '').trim();
    const cleanPhone = String(deliveryInfo.phone || '').trim();
    const cleanAddress = String(deliveryInfo.address || '').trim();
    const cleanCity = String(deliveryInfo.city || '').trim();

    if (!cleanName || !cleanPhone || !cleanAddress || !cleanCity) {
        showToast('⚠️ ' + t('fillAllFields'));
        return;
    }

    const userConfirmed = await confirmAction(
        t('confirmOrderMsg'),
        {
            title: t('confirmOrderTitle'),
            confirmText: t('confirmOrderYes'),
            cancelText: t('confirmOrderNo'),
            variant: 'primary'
        }
    );
    if (!userConfirmed) {
        showToast('⏸️ ' + t('orderCancelled'));
        return;
    }

    const result = await createOrder(cartItems, deliveryInfo, appliedCoupon);
    if (!result.success) {
        showToast('❌ ' + (result.error || t('orderError')));
        return;
    }

    const { orderId, totals, validatedItems } = result;

    const msg = buildWhatsAppMessage(validatedItems, deliveryInfo, orderId, totals);
    const url = `https://wa.me/${CONFIG.SHOP.WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;

    // ✅ C5.2 — Utiliser la fenêtre pré-ouverte, fallback même onglet
    if (waWindow && !waWindow.closed) {
        try {
            waWindow.location.href = url;
        } catch (e) {
            console.warn('⚠️ Impossible de rediriger waWindow :', e);
            window.location.href = url;
        }
    } else {
        // Fallback : même onglet (moins bon UX mais jamais bloqué)
        window.location.href = url;
    }

    // Emails en parallèle (fire-and-forget)
    (async () => {
        try {
            const { sendOrderEmail } = await import('./orders.js');

            const orderForEmail = {
                id: orderId,
                userId: user.uid,
                userEmail: user.email || '',
                items: validatedItems,
                subtotal: totals.subtotal,
                discount: totals.discount,
                couponCode: totals.couponCode || null,
                couponDiscount: totals.couponDiscount || 0,
                deliveryFee: totals.deliveryFee,
                total: totals.total,
                deliveryAddress: {
                    name: deliveryInfo.name,
                    phone: deliveryInfo.phone,
                    address: deliveryInfo.address,
                    city: deliveryInfo.city,
                    cityId: deliveryInfo.cityId,
                    cityAr: deliveryInfo.cityAr,
                    cityFr: deliveryInfo.cityFr,
                    email: deliveryInfo.email || user.email || ''
                },
                userLang: getLang() // ✅ I6.2 : stocker la langue pour éviter N+1
            };

            await sendOrderEmail(orderForEmail, 'pending', 'client');
            await sendOrderEmail(orderForEmail, 'pending', 'admin');
        } catch (e) {
            console.warn('⚠️ Erreur envoi emails commande :', e);
        }
    })();

    if (appliedCoupon) {
        try {
            sessionStorage.removeItem('swi9a_applied_coupon');
        } catch (e) { /* ignore */ }
    }

    clearCart();
    showToast('✅ ' + t('orderSent'));
    document.dispatchEvent(new CustomEvent('close-cart'));
}

// ============================================================
// ✅ C5.4 + C5.5 + I5.6 — CRÉATION DE COMMANDE
// ------------------------------------------------------------
// C5.4 : oneUsePerUser via ID déterministe DANS la transaction
// C5.5 : stock déduit DANS la transaction (stockDeducted: true)
// I5.6 : calculateCouponDiscount via services/coupons.js
// ============================================================
export async function createOrder(items, deliveryInfo, appliedCoupon = null) {
    const user = getCurrentUser();
    if (!user) return { success: false, error: 'NO_USER' };

    try {
        const result = await runTransaction(db, async (transaction) => {

            // ============================================
            // 1. Vérifier les produits
            // ============================================
            const productRefs = items.map(item => doc(db, "products", String(item.productId)));
            const productSnaps = await Promise.all(productRefs.map(ref => transaction.get(ref)));

            // ============================================
            // 2. Vérifier la ville
            // ============================================
            let cityData = null;
            if (deliveryInfo.cityId) {
                const cityRef = doc(db, "cities", String(deliveryInfo.cityId));
                const citySnap = await transaction.get(cityRef);
                if (citySnap.exists()) {
                    cityData = citySnap.data();
                } else {
                    console.warn('⚠️ Ville introuvable dans Firestore :', deliveryInfo.cityId);
                }
            }

            // ============================================
            // 3. Valider stocks + construire validatedItems
            // ============================================
            let subtotal = 0;
            let discountableItems = 0;
            const validatedItems = [];
            const stockUpdates = []; // { ref, variantIdx?, newStock, delta }

            productSnaps.forEach((snap, i) => {
                if (!snap.exists()) {
                    throw new Error(`Produit ${items[i].productId} introuvable`);
                }
                const data = snap.data();
                const qty = Math.max(1, Math.floor(Number(items[i].quantity) || 1));
                const itemVariant = items[i].variant;

                let availableStock = 0;
                let unitPrice = Number(data.price) || 0;
                let variantIdx = -1;

                if (itemVariant) {
                    const variants = data.variants || [];
                    variantIdx = variants.findIndex(v =>
                        (v.size || '') === (itemVariant.size || '') &&
                        (v.color || '') === (itemVariant.color || '')
                    );
                    if (variantIdx === -1) {
                        const label = formatVariantLabel(itemVariant);
                        throw new Error(`Variante supprimée : ${data.nameFr || 'produit'} (${label})`);
                    }
                    availableStock = Number(variants[variantIdx].stock) || 0;
                    unitPrice = Number(variants[variantIdx].price) || unitPrice;
                } else {
                    availableStock = Number(data.stock) || 0;
                }

                if (availableStock < qty) {
                    const label = itemVariant ? ` (${formatVariantLabel(itemVariant)})` : '';
                    throw new Error(`Stock insuffisant : ${data.nameFr || 'produit'}${label} (dispo: ${availableStock})`);
                }

                subtotal += unitPrice * qty;
                discountableItems += qty;

                validatedItems.push({
                    id: items[i].id,
                    productId: items[i].productId,
                    variant: itemVariant || null,
                    quantity: qty,
                    price: unitPrice,
                    name: data.nameFr || data.nameEn || 'Produit'
                });

                stockUpdates.push({
                    ref: productRefs[i],
                    variantIdx,
                    qty,
                    currentVariants: data.variants || null,
                    currentStock: Number(data.stock) || 0,
                    currentSalesCount: Number(data.salesCount) || 0
                });
            });

            // ============================================
            // 4. Remise volume
            // ============================================
            const discountRate = discountableItems >= CONFIG.SHOP.DISCOUNT_THRESHOLD
                ? CONFIG.SHOP.DISCOUNT_PERCENT / 100
                : 0;
            const discount = Math.round(subtotal * discountRate);

            // ============================================
            // 5. Coupon (C5.4 — vérif DANS la transaction)
            // ============================================
            const deliveryFee = cityData ? (Number(cityData.price) || 0) : 0;
            let couponData = null;
            let couponRef = null;
            let couponUseRef = null;
            let couponDiscount = 0;

            if (appliedCoupon && appliedCoupon.id) {
                couponRef = doc(db, "coupons", appliedCoupon.id);
                const couponSnap = await transaction.get(couponRef);

                if (!couponSnap.exists()) throw new Error('Code promo introuvable');
                const c = couponSnap.data();
                if (c.isActive !== true) throw new Error('Code promo inactif');

                if (c.expiresAt) {
                    const expDate = c.expiresAt.toDate ? c.expiresAt.toDate() : new Date(c.expiresAt);
                    if (expDate.getTime() < Date.now()) throw new Error('Code promo expiré');
                }

                const maxUses = Number(c.maxUses) || 0;
                const usedCount = Number(c.usedCount) || 0;
                if (maxUses > 0 && usedCount >= maxUses) throw new Error('Code promo épuisé');

                const minPurchase = Number(c.minPurchase) || 0;
                if (minPurchase > 0 && subtotal < minPurchase) {
                    throw new Error(`Montant minimum ${minPurchase} MAD requis`);
                }

                // ✅ C5.4 : ID déterministe + vérification DANS la transaction
                if (c.oneUsePerUser === true) {
                    const couponUseId = `${appliedCoupon.id}_${user.uid}`;
                    couponUseRef = doc(db, "coupon_uses", couponUseId);
                    const useSnap = await transaction.get(couponUseRef);
                    if (useSnap.exists()) {
                        throw new Error('Vous avez déjà utilisé ce code promo');
                    }
                } else {
                    // Pas de contrainte oneUsePerUser → ID unique aléatoire
                    couponUseRef = doc(collection(db, "coupon_uses"));
                }

                couponDiscount = calculateCouponDiscount(c, subtotal, deliveryFee);
                if (couponDiscount <= 0) throw new Error('Ce code ne produit aucune réduction');
                couponData = c;
            }

            // ============================================
            // 6. Total final
            // ============================================
            const totalDiscount = Math.min(discount + couponDiscount, subtotal);
            const total = Math.max(0, subtotal - totalDiscount + deliveryFee);

            // ============================================
            // 7. Créer la commande
            // ============================================
            const orderRef = doc(collection(db, "orders"));
            const notifRef = doc(collection(db, "notifications"));
            const now = Timestamp.now();
            const cancellableUntil = new Date(
                now.toDate().getTime() + CONFIG.ORDERS.CANCELLABLE_HOURS * 60 * 60 * 1000
            );

            const orderData = {
                userId: user.uid,
                userName: user.name || '',
                userEmail: user.email || '',
                userLang: getLang(), // ✅ I6.2 : stocker langue client
                items: validatedItems,
                status: ORDER_STATUS.PENDING,
                paymentStatus: 'unpaid',
                subtotal,
                discount,
                couponId: appliedCoupon?.id || null,
                couponCode: appliedCoupon?.code || null,
                couponDiscount: couponDiscount,
                deliveryFee,
                total,
                // ✅ C5.5 : stock déduit dès la création (fin surstock)
                stockDeducted: true,
                stockDeductedAt: now,
                deliveryAddress: {
                    name: String(deliveryInfo.name || '').trim().slice(0, 100),
                    phone: String(deliveryInfo.phone || '').trim().slice(0, 20),
                    address: String(deliveryInfo.address || '').trim().slice(0, 300),
                    city: String(deliveryInfo.city || '').trim().slice(0, 100),
                    cityId: deliveryInfo.cityId || null,
                    cityAr: String(deliveryInfo.cityAr || '').trim().slice(0, 100) || null,
                    cityFr: String(deliveryInfo.cityFr || '').trim().slice(0, 100) || null,
                    email: String(deliveryInfo.email || '').trim().slice(0, 100) || user.email || ''
                },
                createdAt: now,
                updatedAt: now,
                cancellableUntil: Timestamp.fromDate(cancellableUntil),
                cancelledAt: null,
                returns: []
            };

            transaction.set(orderRef, orderData);

            // ============================================
            // 8. ✅ C5.5 : Déduire le stock DANS la transaction
            // ============================================
            stockUpdates.forEach(su => {
                if (su.variantIdx > -1 && Array.isArray(su.currentVariants)) {
                    const variants = [...su.currentVariants];
                    const v = variants[su.variantIdx];
                    variants[su.variantIdx] = {
                        ...v,
                        stock: Math.max(0, Number(v.stock) - su.qty)
                    };
                    const newGlobalStock = variants.reduce((sum, x) => sum + (Number(x.stock) || 0), 0);
                    transaction.update(su.ref, {
                        variants,
                        stock: newGlobalStock,
                        salesCount: su.currentSalesCount + su.qty,
                        updatedAt: now
                    });
                } else {
                    transaction.update(su.ref, {
                        stock: Math.max(0, su.currentStock - su.qty),
                        salesCount: su.currentSalesCount + su.qty,
                        updatedAt: now
                    });
                }
            });

            // ============================================
            // 9. Incrément coupon + enregistrer coupon_use
            // ============================================
            if (couponData && couponRef && couponUseRef) {
                transaction.update(couponRef, { usedCount: increment(1) });
                transaction.set(couponUseRef, {
                    couponId: appliedCoupon.id,
                    code: couponData.code,
                    userId: user.uid,
                    orderId: orderRef.id,
                    discountApplied: couponDiscount,
                    usedAt: now
                });
            }

            // ============================================
            // 10. Notification in-app
            // ============================================
            transaction.set(notifRef, {
                userId: user.uid,
                type: 'order_created',
                title: t('notificationOrderCreated') || '📦 Commande reçue',
                message: (t('notificationOrderCreatedMsg') || 'Merci pour votre commande #{id} !')
                    .replace('{id}', orderRef.id.slice(0, 8).toUpperCase()),
                orderId: orderRef.id,
                read: false,
                createdAt: now
            });

            return {
                orderId: orderRef.id,
                totals: {
                    subtotal,
                    discount,
                    couponCode: appliedCoupon?.code || null,
                    couponDiscount,
                    deliveryFee,
                    total
                },
                validatedItems
            };
        });

        console.log('✅ Commande créée :', result.orderId, result.totals);
        return {
            success: true,
            orderId: result.orderId,
            totals: result.totals,
            validatedItems: result.validatedItems
        };

    } catch (error) {
        console.error('❌ Erreur création commande :', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// MESSAGE WHATSAPP
// ============================================================
function buildWhatsAppMessage(validatedItems, deliveryInfo, orderId, totals) {
    const productList = validatedItems.map(item => {
        const lineTotal = (item.price || 0) * (item.quantity || 0);
        const variantText = item.variant
            ? ` (${[item.variant.size, item.variant.color].filter(Boolean).join(' - ')})`
            : '';
        return `  • ${item.name}${variantText} x${item.quantity} — ${lineTotal} MAD`;
    }).join('\n');

    let msg = `🛒 *${t('waNewOrder')}*\n\n`;
    if (orderId) msg += `📦 ${t('waOrder')} : *#${orderId.slice(0, 8).toUpperCase()}*\n\n`;
    msg += `👤 ${t('waName')} : ${deliveryInfo.name}\n`;
    msg += `📞 ${t('waPhone')} : ${deliveryInfo.phone}\n`;
    msg += `📍 ${t('waAddress')} : ${deliveryInfo.address}\n`;
    msg += `🏙️ ${t('waCity')} : ${deliveryInfo.city}\n`;
    if (deliveryInfo.email) msg += `✉️ ${t('waEmail')} : ${deliveryInfo.email}\n`;
    msg += `\n📋 *${t('waItems')} :*\n${productList}\n\n`;
    msg += `💰 ${t('waSubtotal')} : ${totals.subtotal} MAD\n`;
    if (totals.discount > 0) {
        msg += `🔻 ${t('waDiscount')} (-${CONFIG.SHOP.DISCOUNT_PERCENT}%) : -${totals.discount} MAD\n`;
    }
    if (totals.couponCode && totals.couponDiscount > 0) {
        msg += `🎟️ Code ${totals.couponCode} : -${totals.couponDiscount} MAD\n`;
    }
    msg += `🚚 ${t('waDelivery')} : ${totals.deliveryFee} MAD\n`;
    msg += `💵 *${t('waTotal')} : ${totals.total} MAD*\n`;

    if (deliveryInfo.cityAr && deliveryInfo.cityAr !== deliveryInfo.city) {
        msg += `\n📍 _${deliveryInfo.cityAr}_`;
    }

    msg += `\n\n${t('waThanks')} 🎉`;
    return msg;
}

// ============================================================
// ✅ M5.6 — CHARGER LES COMMANDES (orderBy + fallback)
// ============================================================
export async function loadUserOrders() {
    const user = getCurrentUser();
    if (!user) return [];

    const baseQuery = (withOrderBy) => {
        const constraints = [where("userId", "==", user.uid)];
        if (withOrderBy) constraints.push(orderBy("createdAt", "desc"));
        return query(collection(db, "orders"), ...constraints);
    };

    let snapshot;
    try {
        // 1. Essai avec orderBy (nécessite un index composite userId+createdAt)
        snapshot = await getDocs(baseQuery(true));
    } catch (e) {
        // 2. Fallback sans orderBy (si index absent)
        if (e?.code === 'failed-precondition' || /index/i.test(e?.message || '')) {
            console.warn('⚠️ Index manquant, fallback sans orderBy');
            try {
                snapshot = await getDocs(baseQuery(false));
            } catch (e2) {
                console.error('❌ Erreur chargement commandes (fallback) :', e2);
                return [];
            }
        } else {
            console.error('❌ Erreur chargement commandes :', e);
            return [];
        }
    }

    const orders = snapshot.docs.map(d => {
        const data = d.data();
        return {
            id: d.id,
            ...data,
            createdAt: toDate(data.createdAt),
            updatedAt: toDate(data.updatedAt),
            cancelledAt: data.cancelledAt ? toDate(data.cancelledAt) : null,
            cancellableUntil: data.cancellableUntil ? toDate(data.cancellableUntil) : null
        };
    });

    // Tri côté client (fallback ou déjà trié)
    orders.sort((a, b) => {
        const da = a.createdAt?.getTime?.() || 0;
        const dbb = b.createdAt?.getTime?.() || 0;
        return dbb - da;
    });

    return orders;
}

// ============================================================
// ANNULER UNE COMMANDE (côté CLIENT)
// ------------------------------------------------------------
// Note : le stock est restauré côté orders.js (via updateOrderStatus)
// Ici on ne fait que le statut + la notification.
// ============================================================
export async function cancelOrder(orderId) {
    const user = getCurrentUser();
    if (!user) return { success: false, error: 'NO_USER' };

    try {
        await runTransaction(db, async (transaction) => {
            const orderRef = doc(db, "orders", orderId);
            const orderSnap = await transaction.get(orderRef);
            if (!orderSnap.exists()) throw new Error('Commande introuvable');

            const order = orderSnap.data();
            if (order.userId !== user.uid) throw new Error('Non autorisé');

            const currentStatus = normalizeOrderStatus(order.status);
            if (currentStatus !== ORDER_STATUS.PENDING) {
                throw new Error('Cette commande ne peut plus être annulée');
            }

            const cancellableUntilDate = toDate(order.cancellableUntil)
                || (order.createdAt?.toDate
                    ? new Date(order.createdAt.toDate().getTime() + CONFIG.ORDERS.CANCELLABLE_HOURS * 3600 * 1000)
                    : null);

            if (cancellableUntilDate && Date.now() > cancellableUntilDate.getTime()) {
                throw new Error(t('orderCancelTooLate'));
            }

            transaction.update(orderRef, {
                status: ORDER_STATUS.CANCELLED,
                cancelledAt: Timestamp.now(),
                updatedAt: Timestamp.now()
            });

            const notifRef = doc(collection(db, "notifications"));
            transaction.set(notifRef, {
                userId: user.uid,
                type: 'order_cancelled',
                title: t('notificationOrderCancelled'),
                message: t('notificationOrderCancelledMsg').replace('{id}', orderId.slice(0, 8).toUpperCase()),
                orderId: orderId,
                read: false,
                createdAt: Timestamp.now()
            });
        });

        return { success: true };
    } catch (error) {
        console.error('❌ Erreur annulation :', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// PANIER ABANDONNÉ — SAUVEGARDE
// ============================================================
function saveAbandonedCart(items) {
    if (items.length > 0) {
        safeSetItem(CONFIG.STORAGE_KEYS.ABANDONED_CART, {
            items,
            timestamp: Date.now()
        });
    } else {
        safeRemoveItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
    }
}

// ============================================================
// PANIER ABANDONNÉ — LECTURE
// ============================================================
export function checkAbandonedCart() {
    try {
        const data = safeGetItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
        if (!data || !data.items || data.items.length === 0) {
            return null;
        }

        const elapsed = Date.now() - (data.timestamp || 0);
        const delay = CONFIG.SESSION.ABANDONED_CART_DELAY;

        if (elapsed >= delay) {
            return data;
        }
        return null;
    } catch (e) {
        return null;
    }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ cart.js chargé — v3.0.0 (financier + isolation + transaction)');