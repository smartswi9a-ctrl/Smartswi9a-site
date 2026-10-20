// js/cart.js
// ============================================================
// PANIER ET COMMANDES - SMART SWI9A
// Version 2.0.0 — Gestion des Variantes (Tailles / Couleurs)
// ============================================================
// Dépend de : config, utils, store, firebase, auth, ui-core
// ============================================================

import {
    collection, doc, getDoc, getDocs, setDoc, runTransaction,
    query, where, Timestamp, increment
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
// HELPER : Générer un ID unique pour un article (produit + variante)
// ============================================================
function generateItemId(productId, variant) {
    if (!variant) return String(productId);
    const size = variant.size ? String(variant.size).trim() : '';
    const color = variant.color ? String(variant.color).trim() : '';
    return `${productId}_${size}_${color}`;
}

// ============================================================
// CHARGER LE PANIER
// ============================================================
export function loadCart() {
    try {
        const data = safeGetItem(CONFIG.STORAGE_KEYS.CART);
        cart = Array.isArray(data) ? data : [];
        
        // Normalisation et compatibilité avec les anciens paniers
        cart = cart.filter(item =>
            item &&
            Number.isFinite(Number(item.productId)) &&
            Number.isFinite(Number(item.quantity)) &&
            Number(item.quantity) > 0
        ).map(item => {
            // Si l'item n'a pas d'ID unique (ancien panier), on le génère
            const id = item.id || generateItemId(item.productId, item.variant);
            return {
                ...item,
                id: id,
                productId: Number(item.productId),
                quantity: Math.max(1, Math.floor(Number(item.quantity))),
                variant: item.variant || null
            };
        });
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
    safeSetItem(CONFIG.STORAGE_KEYS.CART, cart);
    setCart(cart);
    updateCartBadge();
    saveAbandonedCart(cart);
    document.dispatchEvent(new CustomEvent('cart-updated'));
    scheduleFirestoreSave();
}

// ============================================================
// VIDER LE PANIER LOCAL (sans toucher Firestore)
// ============================================================
function clearLocalCart() {
    cart = [];
    safeSetItem(CONFIG.STORAGE_KEYS.CART, cart);
    setCart(cart);
    updateCartBadge();
    safeRemoveItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
    document.dispatchEvent(new CustomEvent('cart-updated'));
    console.log('🧹 Panier local vidé');
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

function mergeCarts(localCart, firestoreCart) {
    const merged = [...localCart];
    firestoreCart.forEach(fi => {
        if (!fi || !fi.productId) return;
        const itemId = fi.id || generateItemId(fi.productId, fi.variant);
        const qty = Number(fi.quantity) || 0;
        if (qty < 1) return;
        
        const existingIdx = merged.findIndex(li => li.id === itemId);
        if (existingIdx > -1) {
            merged[existingIdx].quantity = Math.max(merged[existingIdx].quantity, qty);
        } else {
            merged.push({ 
                id: itemId, 
                productId: Number(fi.productId), 
                variant: fi.variant || null,
                quantity: qty 
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
        if (!user || !user.uid) { isSyncing = false; return; }

        console.log('🔄 Sync panier Firestore pour', user.uid);
        const firestoreData = await loadCartFromFirestore();

        if (firestoreData && Array.isArray(firestoreData.items) && firestoreData.items.length > 0) {
            const beforeCount = cart.length;
            cart = mergeCarts(cart, firestoreData.items);
            console.log(`✅ Fusion panier : ${beforeCount} local + ${firestoreData.items.length} Firestore → ${cart.length} articles`);

            if (firestoreData.selectedCity) {
                try {
                    const { setSelectedCity } = await import("./store.js");
                    setSelectedCity(firestoreData.selectedCity);
                    console.log('✅ Ville restaurée');
                } catch (e) {
                    console.warn('⚠️ Erreur restauration ville :', e);
                }
            }
        } else {
            console.log('ℹ️ Aucun panier Firestore à fusionner');
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
            console.log('👤 Client déconnecté — vidage du panier local');
            clearLocalCart();
        }
    });
}

// ============================================================
// SYNCHRONISATION MULTI-ONGLETS
// ============================================================
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key !== CONFIG.STORAGE_KEYS.CART) return;
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
// AJOUTER AU PANIER (Gestion des variantes)
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

    // ✅ NOUVEAU : Redirection si le produit a des variantes mais qu'aucune n'est sélectionnée
    const hasVariants = product.variants && product.variants.length > 0;
    if (hasVariants && !variant) {
        showToast('⚠️ Veuillez choisir votre taille et votre couleur');
        window.location.href = `/produit?slug=${encodeURIComponent(product.slug || '')}`;
        return;
    }

    // Déterminer le stock et le prix selon la variante ou le produit de base
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
        showToast('⚠️ ' + t('stockAvailable').replace('{n}', itemStock));
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
// RETIRER DU PANIER
// ============================================================
export function removeFromCart(itemId) {
    cart = cart.filter(i => i.id !== itemId);
    saveCart();
}

// ============================================================
// VIDER LE PANIER (total)
// ============================================================
export function clearCart() {
    cart = [];
    safeSetItem(CONFIG.STORAGE_KEYS.CART, cart);
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

    let newQty = Math.max(1, parseInt(quantity) || 1);
    if (Number.isFinite(maxStock) && newQty > maxStock) {
        newQty = maxStock;
        showToast('⚠️ ' + t('stockAvailable').replace('{n}', maxStock));
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
        const price = item.variant ? Number(item.variant.price) : (Number(p.price) || 0);
        return sum + price * item.quantity;
    }, 0);
}

export function getCartTotalItems() {
    return cart.reduce((sum, item) => sum + (item.quantity || 0), 0);
}

export function getCartSavings() {
    const products = getProducts();
    return cart.reduce((sum, item) => {
        const p = products.find(pp => Number(pp.id) === item.productId);
        if (p && p.oldPrice && Number(p.oldPrice) > Number(p.price)) {
            // Le prix barré est basé sur le prix de base du produit
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

export function getCartTotal() {
    const subtotal = getCartSubtotal();
    const discount = getCartDiscount();
    const deliveryFee = getCartDeliveryFee();
    return subtotal - discount + deliveryFee;
}

// ============================================================
// ✅ HELPER — Calcul de la réduction coupon (réutilisable)
// ============================================================
function calculateCouponDiscount(couponData, subtotal, deliveryFee) {
    if (!couponData) return 0;
    const type = couponData.type;
    const value = Number(couponData.value) || 0;

    if (type === 'percentage') {
        const pct = Math.min(100, Math.max(0, value));
        return Math.round((subtotal * pct) / 100);
    }
    if (type === 'fixed') {
        return Math.min(Math.max(0, value), subtotal);
    }
    if (type === 'free_shipping') {
        return Number(deliveryFee) || 0;
    }
    return 0;
}

// ============================================================
// CHECKOUT
// ============================================================
export async function checkout(cartItems, deliveryInfo, appliedCoupon = null) {
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
    window.open(url, '_blank');

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
                }
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
            console.log('🧹 Coupon retiré du sessionStorage après commande');
        } catch (e) { /* ignore */ }
    }

    clearCart();

    showToast('✅ ' + t('orderSent'));
    document.dispatchEvent(new CustomEvent('close-cart'));
}

// ============================================================
// ✅ CRÉATION DE COMMANDE (avec variantes et coupon)
// ============================================================
export async function createOrder(items, deliveryInfo, appliedCoupon = null) {
    const user = getCurrentUser();
    if (!user) return { success: false, error: 'NO_USER' };

    // ✅ ÉTAPE 1 : Vérifier oneUsePerUser AVANT la transaction
    if (appliedCoupon && appliedCoupon.oneUsePerUser && appliedCoupon.id) {
        try {
            const usesQ = query(
                collection(db, "coupon_uses"),
                where("couponId", "==", appliedCoupon.id),
                where("userId", "==", user.uid)
            );
            const usesSnap = await getDocs(usesQ);
            if (!usesSnap.empty) {
                return { success: false, error: 'Vous avez déjà utilisé ce code promo' };
            }
        } catch (e) {
            console.warn('⚠️ Vérification coupon_uses échouée :', e);
        }
    }

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
            // 3. Calculer le sous-total + valider les stocks (Variantes)
            // ============================================
            let subtotal = 0;
            let discountableItems = 0;
            const validatedItems = [];

            productSnaps.forEach((snap, i) => {
                if (!snap.exists()) {
                    throw new Error(`Produit ${items[i].productId} introuvable`);
                }
                const data = snap.data();
                const qty = Math.max(1, Math.floor(Number(items[i].quantity) || 1));
                
                // Gestion du stock selon la variante
                let availableStock = 0;
                let unitPrice = Number(data.price) || 0;
                const itemVariant = items[i].variant;

                if (itemVariant) {
                    const v = (data.variants || []).find(v => 
                        (v.size || '') === (itemVariant.size || '') && 
                        (v.color || '') === (itemVariant.color || '')
                    );
                    if (!v) {
                        throw new Error(`La variante sélectionnée n'existe plus pour ${data.nameFr || 'ce produit'}`);
                    }
                    availableStock = Number(v.stock) || 0;
                    unitPrice = Number(v.price) || unitPrice;
                } else {
                    availableStock = Number(data.stock) || 0;
                }

                if (availableStock < qty) {
                    throw new Error(`Stock insuffisant pour ${data.nameFr || data.nameEn || 'le produit'}`);
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
            });

            // ============================================
            // 4. Calculer la remise volume
            // ============================================
            const discountRate = discountableItems >= CONFIG.SHOP.DISCOUNT_THRESHOLD
                ? CONFIG.SHOP.DISCOUNT_PERCENT / 100
                : 0;
            const discount = Math.round(subtotal * discountRate);

            // ============================================
            // 5. Vérifier et calculer le coupon
            // ============================================
            const deliveryFee = cityData ? (Number(cityData.price) || 0) : 0;
            let couponData = null;
            let couponRef = null;
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
                    throw new Error(`Montant minimum ${minPurchase} MAD requis pour ce code`);
                }

                couponDiscount = calculateCouponDiscount(c, subtotal, deliveryFee);
                if (couponDiscount <= 0) throw new Error('Ce code ne produit aucune réduction');
                couponData = c;
            }

            // ============================================
            // 6. Calculer le total final
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
                items: validatedItems, // Contient maintenant les variantes
                status: ORDER_STATUS.PENDING,
                paymentStatus: 'unpaid',
                subtotal,
                discount,
                couponId: appliedCoupon?.id || null,
                couponCode: appliedCoupon?.code || null,
                couponDiscount: couponDiscount,
                deliveryFee,
                total,
                stockDeducted: false,
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
                cancelledAt: null
            };

            transaction.set(orderRef, orderData);

            // ============================================
            // 8. Incrémenter usedCount + enregistrer coupon_uses
            // ============================================
            if (couponData && couponRef) {
                transaction.update(couponRef, { usedCount: increment(1) });
                const couponUseRef = doc(collection(db, "coupon_uses"));
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
            // 9. Notification in-app
            // ============================================
            transaction.set(notifRef, {
                userId: user.uid,
                type: 'order_created',
                title: t('notificationOrderCreated') || '📦 Commande reçue',
                message: (t('notificationOrderCreatedMsg') || 'Merci pour votre commande #{id} !').replace('{id}', orderRef.id.slice(0, 8).toUpperCase()),
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
// ✅ MESSAGE WHATSAPP (avec variantes)
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
// CHARGER LES COMMANDES DU CLIENT
// ============================================================
export async function loadUserOrders() {
    const user = getCurrentUser();
    if (!user) return [];

    try {
        const q = query(
            collection(db, "orders"),
            where("userId", "==", user.uid)
        );
        const snapshot = await getDocs(q);
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
        orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return orders;
    } catch (e) {
        console.error('❌ Erreur chargement commandes :', e);
        return [];
    }
}

// ============================================================
// ANNULER UNE COMMANDE (côté CLIENT)
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
console.log('✅ cart.js chargé — v2.0.0 (Gestion des variantes)');