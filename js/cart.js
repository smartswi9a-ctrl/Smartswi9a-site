// js/cart.js
// ============================================================
// PANIER ET COMMANDES - SMART SWI9A
// Version 3.0.0 — Transactions, Anti-surstock, Multi-user
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
// HELPER : Clé de stockage par utilisateur
// ============================================================
function getCartStorageKey() {
    const user = getCurrentUser();
    return user?.uid
        ? `${CONFIG.STORAGE_KEYS.CART}_${user.uid}`
        : CONFIG.STORAGE_KEYS.CART;
}

// ============================================================
// HELPER : Générer un ID unique (Delimiter "::")
// ============================================================
function generateItemId(productId, variant) {
    if (!variant) return String(productId);
    const size = encodeURIComponent(String(variant.size || ''));
    const color = encodeURIComponent(String(variant.color || ''));
    return `${productId}::${size}::${color}`;
}

// ============================================================
// CHARGER LE PANIER
// ============================================================
export function loadCart() {
    try {
        const data = safeGetItem(getCartStorageKey());
        cart = Array.isArray(data) ? data : [];
        
        cart = cart.filter(item =>
            item &&
            Number.isFinite(Number(item.productId)) &&
            Number.isFinite(Number(item.quantity)) &&
            Number(item.quantity) > 0
        ).map(item => {
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
    safeSetItem(getCartStorageKey(), cart);
    setCart(cart);
    updateCartBadge();
    saveAbandonedCart(cart);
    document.dispatchEvent(new CustomEvent('cart-updated'));
    scheduleFirestoreSave();
}

// ============================================================
// VIDER LE PANIER LOCAL
// ============================================================
function clearLocalCart() {
    cart = [];
    safeSetItem(getCartStorageKey(), cart);
    setCart(cart);
    updateCartBadge();
    safeRemoveItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
    document.dispatchEvent(new CustomEvent('cart-updated'));
}

// ============================================================
// FIRESTORE SYNC
// ============================================================
async function saveCartToFirestoreImmediate() {
    if (firestoreSaveTimeout) clearTimeout(firestoreSaveTimeout);
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
                id: selectedCity.id, name: selectedCity.name || '',
                nameAr: selectedCity.nameAr || selectedCity.name || '',
                nameFr: selectedCity.nameFr || '', nameEn: selectedCity.nameEn || '',
                price: Number(selectedCity.price) || 0, delay: selectedCity.delay || ''
            } : null,
            updatedAt: Timestamp.now()
        }, { merge: true });
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
        return null;
    }
}

function mergeCarts(localCart, firestoreCart) {
    const merged = [...localCart];
    const products = getProducts();

    firestoreCart.forEach(fi => {
        if (!fi || !fi.productId) return;
        const itemId = fi.id || generateItemId(fi.productId, fi.variant);
        let qty = Number(fi.quantity) || 0;
        if (qty < 1) return;

        // ✅ Cap au stock disponible
        const p = products.find(pp => Number(pp.id) === Number(fi.productId));
        if (p) {
            let maxStock = Number(p.stock) || 0;
            if (fi.variant) {
                const v = p.variants?.find(v => (v.size || '') === (fi.variant.size || '') && (v.color || '') === (fi.variant.color || ''));
                maxStock = v ? Number(v.stock) : 0;
            }
            qty = Math.min(qty, maxStock);
        }
        if (qty < 1) return;
        
        const existingIdx = merged.findIndex(li => li.id === itemId);
        if (existingIdx > -1) {
            merged[existingIdx].quantity = Math.max(merged[existingIdx].quantity, qty);
        } else {
            merged.push({ id: itemId, productId: Number(fi.productId), variant: fi.variant || null, quantity: qty });
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

        const firestoreData = await loadCartFromFirestore();
        if (firestoreData && Array.isArray(firestoreData.items) && firestoreData.items.length > 0) {
            const beforeCount = cart.length;
            cart = mergeCarts(cart, firestoreData.items);
            if (cart.length > beforeCount) showToast('🔄 Panier synchronisé avec votre compte');

            if (firestoreData.selectedCity) {
                try {
                    const { setSelectedCity } = await import("./store.js");
                    setSelectedCity(firestoreData.selectedCity);
                } catch (e) { }
            }
        }
        saveCart();
        updateCartBadge();
    } catch (e) {
        console.warn('⚠️ Erreur sync panier :', e);
    } finally {
        isSyncing = false;
    }
}

function scheduleFirestoreSave() {
    if (firestoreSaveTimeout) clearTimeout(firestoreSaveTimeout);
    firestoreSaveTimeout = setTimeout(() => { saveCartToFirestore(); firestoreSaveTimeout = null; }, 1000);
}

// ============================================================
// LISTENERS
// ============================================================
if (typeof document !== 'undefined') {
    document.addEventListener('auth-updated', async (e) => {
        const user = e.detail?.user;
        if (user && user.uid) {
            loadCart(); // Recharger le panier de cet utilisateur
            await syncCartOnLogin();
        } else {
            clearLocalCart(); // Vider si déconnexion
        }
    });
}

if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key !== getCartStorageKey()) return;
        try {
            const newCart = e.newValue ? JSON.parse(e.newValue) : [];
            cart = Array.isArray(newCart) ? newCart : [];
            setCart(cart);
            updateCartBadge();
            document.dispatchEvent(new CustomEvent('cart-updated'));
        } catch (err) { }
    });
}

// ============================================================
// BADGE
// ============================================================
export function updateCartBadge() {
    const badge = document.getElementById('cartBadge');
    const count = cart.reduce((sum, item) => sum + (item.quantity || 0), 0);
    if (badge) {
        if (count > 0) { badge.textContent = count; badge.classList.add('show'); }
        else { badge.classList.remove('show'); }
    }
}

// ============================================================
// AJOUTER AU PANIER
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

    if (!product) { showToast('⚠️ ' + t('productNotFound')); return; }

    const hasVariants = product.variants && product.variants.length > 0;
    if (hasVariants && !variant) {
        showToast('⚠️ Veuillez choisir votre taille et votre couleur');
        window.location.href = `/produit?slug=${encodeURIComponent(product.slug || '')}`;
        return;
    }

    // ✅ Valider la variante passée
    let validVariant = null;
    if (variant) {
        validVariant = product.variants.find(v => 
            (v.size || '') === (variant.size || '') && 
            (v.color || '') === (variant.color || '')
        );
        if (!validVariant) { showToast('❌ Variante introuvable'); return; }
    }

    const itemStock = validVariant ? Number(validVariant.stock) : (Number(product.stock) || 0);
    const itemPrice = validVariant ? Number(validVariant.price) : (Number(product.price) || 0);
    const itemId = generateItemId(pid, validVariant);

    const existing = cart.find(i => i.id === itemId);
    const currentQty = existing ? existing.quantity : 0;
    const newQty = currentQty + 1;

    if (itemStock === 0) { showToast('⚠️ ' + t('outOfStock')); return; }
    if (newQty > itemStock) { showToast('⚠️ ' + t('stockAvailable').replace('{n}', itemStock)); return; }

    if (existing) {
        existing.quantity = newQty;
    } else {
        cart.push({ 
            id: itemId,
            productId: pid, 
            variant: validVariant ? { size: validVariant.size || '', color: validVariant.color || '', price: itemPrice } : null,
            quantity: 1 
        });
    }

    saveCart();
    showToast('✅ ' + t('addedToCart'));
}

// ============================================================
// RETIRER / VIDER / QUANTITÉ
// ============================================================
export function removeFromCart(itemId) {
    cart = cart.filter(i => i.id !== itemId);
    saveCart();
}

export function clearCart() {
    cart = [];
    safeSetItem(getCartStorageKey(), cart);
    setCart(cart);
    updateCartBadge();
    safeRemoveItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
    document.dispatchEvent(new CustomEvent('cart-updated'));
    if (getCurrentUser()) saveCartToFirestoreImmediate();
}

export function updateCartQuantity(itemId, quantity) {
    const item = cart.find(i => i.id === itemId);
    if (!item) return;

    const products = getProducts();
    const product = products.find(p => Number(p.id) === item.productId);
    
    let maxStock = Infinity;
    if (item.variant) {
        const v = product?.variants?.find(v => (v.size || '') === (item.variant.size || '') && (v.color || '') === (item.variant.color || ''));
        maxStock = v ? Number(v.stock) : 0;
    } else {
        maxStock = product ? Number(product.stock) || Infinity : Infinity;
    }

    // ✅ Si stock 0, retirer l'article
    if (Number.isFinite(maxStock) && maxStock === 0) {
        cart = cart.filter(i => i.id !== itemId);
        saveCart();
        showToast('⚠️ Ce produit n\'est plus disponible, retiré du panier');
        return;
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
        if (item.variant) return sum; // Les variantes n'ont pas de oldPrice
        const p = products.find(pp => Number(pp.id) === item.productId);
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
    const couponDiscount = appliedCoupon ? calculateCouponDiscount(appliedCoupon, subtotal, deliveryFee) : 0;
    const totalDiscount = Math.min(discount + couponDiscount, subtotal);
    return Math.max(0, subtotal - totalDiscount + deliveryFee);
}

// ============================================================
// ✅ REVALIDATION DES PRIX (Empêche les prix obsolètes)
// ============================================================
export function revalidateCartPrices() {
    const products = getProducts();
    let changed = false;
    const changes = [];

    cart.forEach(item => {
        const p = products.find(pp => Number(pp.id) === item.productId);
        if (!p) return;

        if (item.variant) {
            const v = (p.variants || []).find(v => (v.size || '') === (item.variant.size || '') && (v.color || '') === (item.variant.color || ''));
            if (!v) {
                changes.push({ type: 'variant_removed', item, productName: p.nameFr });
                cart = cart.filter(i => i.id !== item.id);
                changed = true;
                return;
            }
            const newPrice = Number(v.price);
            if (newPrice !== Number(item.variant.price)) {
                changes.push({ type: 'price_changed', item, productName: p.nameFr, oldPrice: item.variant.price, newPrice });
                item.variant.price = newPrice;
                changed = true;
            }
        }
    });

    if (changed) {
        safeSetItem(getCartStorageKey(), cart);
        setCart(cart);
        const priceChanges = changes.filter(c => c.type === 'price_changed');
        if (priceChanges.length > 0) showToast(`⚠️ ${priceChanges.length} prix mis à jour dans votre panier`);
        if (changes.some(c => c.type === 'variant_removed')) showToast('⚠️ Des articles indisponibles ont été retirés.');
    }
    return changes;
}

// ============================================================
// ✅ CALCUL COUPON (Exporté pour panier.js)
// ============================================================
export function calculateCouponDiscount(coupon, subtotal, deliveryFee) {
    if (!coupon) return 0;
    const type = coupon.type;
    const value = Number(coupon.value) || 0;

    if (type === 'percentage') return Math.round((subtotal * Math.min(100, Math.max(0, value))) / 100);
    if (type === 'fixed') return Math.min(Math.max(0, value), subtotal);
    if (type === 'free_shipping') return Number(deliveryFee) || 0;
    return 0;
}

// ============================================================
// CHECKOUT (Ouvre la fenêtre AVANT les await)
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
        if (waWindow) waWindow.close();
        return;
    }

    const userConfirmed = await confirmAction(t('confirmOrderMsg'), {
        title: t('confirmOrderTitle'), confirmText: t('confirmOrderYes'), cancelText: t('confirmOrderNo'), variant: 'primary'
    });
    if (!userConfirmed) {
        showToast('⏸️ ' + t('orderCancelled'));
        if (waWindow) waWindow.close();
        return;
    }

    const result = await createOrder(cartItems, deliveryInfo, appliedCoupon);
    if (!result.success) {
        showToast('❌ ' + (result.error || t('orderError')));
        if (waWindow) waWindow.close();
        return;
    }

    const { orderId, totals, validatedItems } = result;
    const msg = buildWhatsAppMessage(validatedItems, deliveryInfo, orderId, totals);
    const url = `https://wa.me/${CONFIG.SHOP.WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;

    // ✅ Utiliser la fenêtre pré-ouverte pour éviter le blocage popup
    if (waWindow && !waWindow.closed) {
        waWindow.location.href = url;
    } else {
        window.location.href = url;
    }

    (async () => {
        try {
            const { sendOrderEmail } = await import('./orders.js');
            const orderForEmail = {
                id: orderId, userId: user.uid, userEmail: user.email || '',
                items: validatedItems, subtotal: totals.subtotal, discount: totals.discount,
                couponCode: totals.couponCode || null, couponDiscount: totals.couponDiscount || 0,
                deliveryFee: totals.deliveryFee, total: totals.total,
                deliveryAddress: { name: deliveryInfo.name, phone: deliveryInfo.phone, address: deliveryInfo.address, city: deliveryInfo.city, cityId: deliveryInfo.cityId, cityAr: deliveryInfo.cityAr, cityFr: deliveryInfo.cityFr, email: deliveryInfo.email || user.email || '' }
            };
            await sendOrderEmail(orderForEmail, 'pending', 'client');
            await sendOrderEmail(orderForEmail, 'pending', 'admin');
        } catch (e) { }
    })();

    if (appliedCoupon) {
        try { sessionStorage.removeItem('swi9a_applied_coupon'); } catch (e) { }
    }

    clearCart();
    showToast('✅ ' + t('orderSent'));
    document.dispatchEvent(new CustomEvent('close-cart'));
}

// ============================================================
// CRÉATION DE COMMANDE (Déduction Stock Immédiate)
// ============================================================
export async function createOrder(items, deliveryInfo, appliedCoupon = null) {
    const user = getCurrentUser();
    if (!user) return { success: false, error: 'NO_USER' };

    // Vérification oneUsePerUser DANS la transaction
    try {
        const result = await runTransaction(db, async (transaction) => {
            // 1. Vérifier les produits et déduire le stock
            const productRefs = items.map(item => doc(db, "products", String(item.productId)));
            const productSnaps = await Promise.all(productRefs.map(ref => transaction.get(ref)));

            let subtotal = 0;
            let discountableItems = 0;
            const validatedItems = [];

            productSnaps.forEach((snap, i) => {
                if (!snap.exists()) throw new Error(`Produit ${items[i].productId} introuvable`);
                const data = snap.data();
                const qty = Math.max(1, Math.floor(Number(items[i].quantity) || 1));
                
                let availableStock = 0;
                let unitPrice = Number(data.price) || 0;
                const itemVariant = items[i].variant;
                let updateData = { salesCount: (Number(data.salesCount) || 0) + qty };

                if (itemVariant) {
                    const vIdx = (data.variants || []).findIndex(v => (v.size || '') === (itemVariant.size || '') && (v.color || '') === (itemVariant.color || ''));
                    if (vIdx === -1) throw new Error(`La variante n'existe plus pour ${data.nameFr}`);
                    
                    const variants = [...(data.variants || [])];
                    availableStock = Number(variants[vIdx].stock) || 0;
                    unitPrice = Number(variants[vIdx].price) || unitPrice;

                    if (availableStock < qty) throw new Error(`Stock insuffisant pour ${data.nameFr} (${itemVariant.size}/${itemVariant.color})`);

                    variants[vIdx].stock = Math.max(0, availableStock - qty);
                    updateData.variants = variants;
                    updateData.stock = variants.reduce((s, v) => s + (Number(v.stock) || 0), 0);
                } else {
                    availableStock = Number(data.stock) || 0;
                    if (availableStock < qty) throw new Error(`Stock insuffisant pour ${data.nameFr}`);
                    updateData.stock = Math.max(0, availableStock - qty);
                }

                transaction.update(productRefs[i], updateData);

                subtotal += unitPrice * qty;
                discountableItems += qty;
                validatedItems.push({ id: items[i].id, productId: items[i].productId, variant: itemVariant || null, quantity: qty, price: unitPrice, name: data.nameFr || data.nameEn || 'Produit' });
            });

            // 2. Vérifier la ville
            let cityData = null;
            if (deliveryInfo.cityId) {
                const cityRef = doc(db, "cities", String(deliveryInfo.cityId));
                const citySnap = await transaction.get(cityRef);
                if (citySnap.exists()) cityData = citySnap.data();
            }

            // 3. Remise volume
            const discountRate = discountableItems >= CONFIG.SHOP.DISCOUNT_THRESHOLD ? CONFIG.SHOP.DISCOUNT_PERCENT / 100 : 0;
            const discount = Math.round(subtotal * discountRate);

            // 4. Coupon (avec ID déterministe anti-spam)
            const deliveryFee = cityData ? (Number(cityData.price) || 0) : 0;
            let couponData = null, couponDiscount = 0;

            if (appliedCoupon && appliedCoupon.id) {
                const couponRef = doc(db, "coupons", appliedCoupon.id);
                const couponSnap = await transaction.get(couponRef);

                if (!couponSnap.exists()) throw new Error('Code promo introuvable');
                const c = couponSnap.data();
                if (c.isActive !== true) throw new Error('Code promo inactif');
                if (c.expiresAt) {
                    const expDate = c.expiresAt.toDate ? c.expiresAt.toDate() : new Date(c.expiresAt);
                    if (expDate.getTime() < Date.now()) throw new Error('Code promo expiré');
                }
                const maxUses = Number(c.maxUses) || 0;
                if (maxUses > 0 && (Number(c.usedCount) || 0) >= maxUses) throw new Error('Code promo épuisé');
                if ((Number(c.minPurchase) || 0) > 0 && subtotal < Number(c.minPurchase)) throw new Error(`Minimum ${c.minPurchase} MAD requis`);

                if (c.oneUsePerUser === true) {
                    const couponUseId = `${appliedCoupon.id}_${user.uid}`;
                    const couponUseSnap = await transaction.get(doc(db, "coupon_uses", couponUseId));
                    if (couponUseSnap.exists()) throw new Error('Vous avez déjà utilisé ce code promo');
                }

                couponDiscount = calculateCouponDiscount(c, subtotal, deliveryFee);
                if (couponDiscount <= 0) throw new Error('Ce code ne produit aucune réduction');
                couponData = c;
            }

            // 5. Créer la commande (avec stockDeducted: true)
            const totalDiscount = Math.min(discount + couponDiscount, subtotal);
            const total = Math.max(0, subtotal - totalDiscount + deliveryFee);
            const orderRef = doc(collection(db, "orders"));
            const cancellableUntil = new Date(Date.now() + CONFIG.ORDERS.CANCELLABLE_HOURS * 3600 * 1000);

            const orderData = {
                userId: user.uid, userName: user.name || '', userEmail: user.email || '',
                items: validatedItems, status: ORDER_STATUS.PENDING, paymentStatus: 'unpaid',
                subtotal, discount, couponId: appliedCoupon?.id || null, couponCode: appliedCoupon?.code || null,
                couponDiscount, deliveryFee, total, stockDeducted: true, // ✅ Déduit immédiatement
                deliveryAddress: {
                    name: deliveryInfo.name.trim().slice(0, 100), phone: deliveryInfo.phone.trim().slice(0, 20),
                    address: deliveryInfo.address.trim().slice(0, 300), city: deliveryInfo.city.trim().slice(0, 100),
                    cityId: deliveryInfo.cityId || null, cityAr: deliveryInfo.cityAr || null, cityFr: deliveryInfo.cityFr || null,
                    email: deliveryInfo.email || user.email || ''
                },
                createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
                cancellableUntil: Timestamp.fromDate(cancellableUntil), cancelledAt: null
            };
            transaction.set(orderRef, orderData);

            // 6. Incrémenter coupon
            if (couponData) {
                transaction.update(doc(db, "coupons", appliedCoupon.id), { usedCount: increment(1) });
                transaction.set(doc(db, "coupon_uses", `${appliedCoupon.id}_${user.uid}`), {
                    couponId: appliedCoupon.id, code: couponData.code, userId: user.uid,
                    orderId: orderRef.id, discountApplied: couponDiscount, usedAt: Timestamp.now()
                });
            }

            // 7. Notification
            transaction.set(doc(collection(db, "notifications")), {
                userId: user.uid, type: 'order_created', title: t('notificationOrderCreated') || '📦 Commande reçue',
                message: (t('notificationOrderCreatedMsg') || 'Merci pour votre commande #{id} !').replace('{id}', orderRef.id.slice(0, 8).toUpperCase()),
                orderId: orderRef.id, read: false, createdAt: Timestamp.now()
            });

            return { orderId: orderRef.id, totals: { subtotal, discount, couponCode: appliedCoupon?.code || null, couponDiscount, deliveryFee, total }, validatedItems };
        });

        return { success: true, ...result };
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
        const variantText = item.variant ? ` (${[item.variant.size, item.variant.color].filter(Boolean).join(' - ')})` : '';
        return `  • ${item.name}${variantText} x${item.quantity} — ${(item.price * item.quantity)} MAD`;
    }).join('\n');

    let msg = `🛒 *${t('waNewOrder')}*\n\n`;
    if (orderId) msg += `📦 ${t('waOrder')} : *#${orderId.slice(0, 8).toUpperCase()}*\n\n`;
    msg += `👤 ${t('waName')} : ${deliveryInfo.name}\n📞 ${t('waPhone')} : ${deliveryInfo.phone}\n📍 ${t('waAddress')} : ${deliveryInfo.address}\n🏙️ ${t('waCity')} : ${deliveryInfo.city}\n`;
    if (deliveryInfo.email) msg += `✉️ ${t('waEmail')} : ${deliveryInfo.email}\n`;
    msg += `\n📋 *${t('waItems')} :*\n${productList}\n\n`;
    msg += `💰 ${t('waSubtotal')} : ${totals.subtotal} MAD\n`;
    if (totals.discount > 0) msg += `🔻 ${t('waDiscount')} (-${CONFIG.SHOP.DISCOUNT_PERCENT}%) : -${totals.discount} MAD\n`;
    if (totals.couponCode && totals.couponDiscount > 0) msg += `🎟️ Code ${totals.couponCode} : -${totals.couponDiscount} MAD\n`;
    msg += `🚚 ${t('waDelivery')} : ${totals.deliveryFee} MAD\n💵 *${t('waTotal')} : ${totals.total} MAD*\n\n${t('waThanks')} 🎉`;
    return msg;
}

// ============================================================
// CHARGER LES COMMANDES DU CLIENT
// ============================================================
export async function loadUserOrders() {
    const user = getCurrentUser();
    if (!user) return [];
    try {
        const q = query(collection(db, "orders"), where("userId", "==", user.uid));
        const snapshot = await getDocs(q);
        const orders = snapshot.docs.map(d => {
            const data = d.data();
            return {
                id: d.id, ...data, createdAt: toDate(data.createdAt), updatedAt: toDate(data.updatedAt),
                cancelledAt: data.cancelledAt ? toDate(data.cancelledAt) : null,
                cancellableUntil: data.cancellableUntil ? toDate(data.cancellableUntil) : null
            };
        });
        orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return orders;
    } catch (e) { return []; }
}

// ============================================================
// ANNULER UNE COMMANDE (Restaure Stock + Coupon)
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
            if (normalizeOrderStatus(order.status) !== ORDER_STATUS.PENDING) throw new Error('Cette commande ne peut plus être annulée');

            const cancellableUntilDate = toDate(order.cancellableUntil) || (order.createdAt?.toDate ? new Date(order.createdAt.toDate().getTime() + CONFIG.ORDERS.CANCELLABLE_HOURS * 3600000) : null);
            if (cancellableUntilDate && Date.now() > cancellableUntilDate.getTime()) throw new Error(t('orderCancelTooLate'));

            // ✅ Restaurer le stock (car déduit à la création)
            if (order.stockDeducted === true) {
                const productRefs = order.items.map(i => doc(db, "products", String(i.productId)));
                const productSnaps = await Promise.all(productRefs.map(r => transaction.get(r)));

                productSnaps.forEach((snap, i) => {
                    if (!snap.exists()) return;
                    const pData = snap.data();
                    const qty = Number(order.items[i].quantity) || 0;
                    const itemVariant = order.items[i].variant;
                    let updateData = { salesCount: Math.max(0, (Number(pData.salesCount) || 0) - qty) };

                    if (itemVariant) {
                        const variants = [...(pData.variants || [])];
                        const idx = variants.findIndex(v => (v.size || '') === (itemVariant.size || '') && (v.color || '') === (itemVariant.color || ''));
                        if (idx > -1) {
                            variants[idx].stock = (Number(variants[idx].stock) || 0) + qty;
                            updateData.variants = variants;
                            updateData.stock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
                        }
                    } else {
                        updateData.stock = (Number(pData.stock) || 0) + qty;
                    }
                    transaction.update(productRefs[i], updateData);
                });
            }

            // ✅ Restaurer le coupon
            if (order.couponId && !order.couponRestored) {
                transaction.update(doc(db, "coupons", order.couponId), { usedCount: increment(-1) });
                transaction.delete(doc(db, "coupon_uses", `${order.couponId}_${user.uid}`));
            }

            transaction.update(orderRef, {
                status: ORDER_STATUS.CANCELLED,
                cancelledAt: Timestamp.now(),
                updatedAt: Timestamp.now(),
                stockDeducted: false,
                couponRestored: true
            });

            transaction.set(doc(collection(db, "notifications")), {
                userId: user.uid, type: 'order_cancelled', title: t('notificationOrderCancelled'),
                message: t('notificationOrderCancelledMsg').replace('{id}', orderId.slice(0, 8).toUpperCase()),
                orderId: orderId, read: false, createdAt: Timestamp.now()
            });
        });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ============================================================
// PANIER ABANDONNÉ
// ============================================================
function saveAbandonedCart(items) {
    if (items.length > 0) safeSetItem(CONFIG.STORAGE_KEYS.ABANDONED_CART, { items, timestamp: Date.now() });
    else safeRemoveItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
}

export function checkAbandonedCart() {
    try {
        const data = safeGetItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
        if (!data || !data.items || data.items.length === 0) return null;
        if (Date.now() - (data.timestamp || 0) >= CONFIG.SESSION.ABANDONED_CART_DELAY) return data;
        return null;
    } catch (e) { return null; }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ cart.js chargé — v3.0.0 (Transactions, Anti-surstock, Multi-user)');