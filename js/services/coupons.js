// js/services/coupons.js
// ============================================================
// SERVICE COUPONS - SMART SWI9A
// Version 1.1.0 — getDoc déterministe (fix C20.5)
// ============================================================
// CHANGEMENTS v1.1.0 :
// ✅ C20.5 — getDoc ID déterministe (au lieu de query list)
// ✅ Bonus — Vérif couponData.code === normalizedCode
// ✅ Bonus — Fallback legacy query (compat anciens codes)
// ============================================================
// Dépend de : config, utils, firebase
// Exporte   : calculateCouponDiscount(), validateCoupon()
// ============================================================

import {
    collection, query, where, getDocs, doc, getDoc
} from "firebase/firestore";
import { db } from "../firebase.js";
import { t, toDate } from "../utils.js";

// ============================================================
// CALCUL (PURE — aucune I/O)
// ============================================================
/**
 * Calcule la réduction d'un coupon sur un panier.
 *
 * @param {Object} coupon - { type, value }
 *   - type : 'percentage' | 'fixed' | 'free_shipping'
 *   - value : nombre (ignoré pour free_shipping)
 * @param {number} subtotal - Sous-total du panier
 * @param {number} deliveryFee - Frais de livraison actuels
 * @returns {number} Montant de la réduction (≥ 0)
 */
export function calculateCouponDiscount(coupon, subtotal, deliveryFee) {
    if (!coupon) return 0;

    const type = coupon.type;
    const value = Number(coupon.value) || 0;
    const sub = Math.max(0, Number(subtotal) || 0);
    const delivery = Math.max(0, Number(deliveryFee) || 0);

    if (type === 'percentage') {
        const pct = Math.min(100, Math.max(0, value));
        return Math.round((sub * pct) / 100);
    }

    if (type === 'fixed') {
        return Math.min(Math.max(0, value), sub);
    }

    if (type === 'free_shipping') {
        return delivery;
    }

    return 0;
}

// ============================================================
// ✅ C20.5 : Génération de l'ID déterministe (cohérent avec admin.js)
// ------------------------------------------------------------
// admin.js utilise : code.replace(/[^A-Z0-9]/g, '_')
// On fait pareil → mêmes IDs garantis
// ============================================================
function getDeterministicCouponId(code) {
    return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

// ============================================================
// ✅ C20.5 : RÉCUPÉRATION DU COUPON (getDoc déterministe)
// ------------------------------------------------------------
// Avantage : pas besoin de `list` public dans firestore.rules
// Fallback  : si le doc déterministe n'existe pas (ancien coupon
//             créé avec addDoc), on utilise un query limité.
// ============================================================
async function fetchCouponByCode(code) {
    const normalizedCode = String(code || '').trim().toUpperCase();
    const deterministicId = getDeterministicCouponId(normalizedCode);

    // 1. Tentative principale : getDoc par ID déterministe
    try {
        const ref = doc(db, "coupons", deterministicId);
        const snap = await getDoc(ref);

        if (snap.exists()) {
            const data = snap.data();
            // ✅ Double sécurité : le code doit matcher exactement
            if (String(data.code || '').toUpperCase() === normalizedCode) {
                return { id: snap.id, data };
            }
            // Si l'ID existe mais le code diffère → collision improbable
            console.warn('⚠️ Coupon ID collision :', deterministicId);
        }
    } catch (e) {
        // Permission-denied possible si rules strictes → fallback
        console.warn('⚠️ getDoc coupon échoué, fallback query :', e?.code);
    }

    // 2. Fallback : query limit(1) sur le code
    //    ⚠️ Nécessite `list` autorisé dans firestore.rules
    //    (voir firestore.rules v2.0.0 : list si isActive == true)
    try {
        const q = query(
            collection(db, "coupons"),
            where("code", "==", normalizedCode)
        );
        const snap = await getDocs(q);

        if (!snap.empty) {
            const first = snap.docs[0];
            return { id: first.id, data: first.data() };
        }
    } catch (e) {
        console.warn('⚠️ Fallback query coupon échoué :', e?.code);
    }

    return null;
}

// ============================================================
// VALIDATION ASYNCHRONE (avec I/O Firestore)
// ============================================================
/**
 * Valide un code promo par rapport à un panier donné.
 *
 * @param {string} code - Le code à valider
 * @param {number} subtotal - Sous-total du panier
 * @param {number} deliveryFee - Frais de livraison
 * @param {string|null} userId - UID du client (pour oneUsePerUser)
 * @returns {Promise<{valid: boolean, coupon: Object|null, error: string|null, discountAmount: number}>}
 */
export async function validateCoupon(code, subtotal, deliveryFee, userId = null) {
    const normalizedCode = String(code || '').trim().toUpperCase();

    if (!normalizedCode || normalizedCode.length < 3) {
        return {
            valid: false, coupon: null,
            error: t('couponCodeTooShort') || 'Code trop court',
            discountAmount: 0
        };
    }

    try {
        // 1. Récupération (getDoc déterministe + fallback)
        const couponEntry = await fetchCouponByCode(normalizedCode);

        if (!couponEntry) {
            return { valid: false, coupon: null, error: 'Code promo introuvable', discountAmount: 0 };
        }

        const { id: couponId, data: couponData } = couponEntry;

        // 2. Actif ?
        if (couponData.isActive !== true) {
            return { valid: false, coupon: null, error: 'Ce code promo n\'est pas actif', discountAmount: 0 };
        }

        // 3. Expiré ?
        const expiresAt = couponData.expiresAt ? toDate(couponData.expiresAt) : null;
        if (expiresAt && expiresAt.getTime() < Date.now()) {
            return { valid: false, coupon: null, error: 'Ce code promo a expiré', discountAmount: 0 };
        }

        // 4. Épuisé ?
        const maxUses = Number(couponData.maxUses) || 0;
        const usedCount = Number(couponData.usedCount) || 0;
        if (maxUses > 0 && usedCount >= maxUses) {
            return { valid: false, coupon: null, error: 'Ce code promo a atteint sa limite', discountAmount: 0 };
        }

        // 5. Montant minimum ?
        const minPurchase = Number(couponData.minPurchase) || 0;
        if (subtotal < minPurchase) {
            return {
                valid: false, coupon: null,
                error: `Montant minimum requis : ${minPurchase} MAD`,
                discountAmount: 0
            };
        }

        // 6. oneUsePerUser ?
        if (couponData.oneUsePerUser === true) {
            if (!userId) {
                return {
                    valid: false, coupon: null,
                    error: 'Connectez-vous pour utiliser ce code',
                    discountAmount: 0
                };
            }
            // Vérif dans coupon_uses (ID déterministe ${couponId}_${userId})
            try {
                const useRef = doc(db, "coupon_uses", `${couponId}_${userId}`);
                const useSnap = await getDoc(useRef);
                if (useSnap.exists()) {
                    return { valid: false, coupon: null, error: 'Vous avez déjà utilisé ce code', discountAmount: 0 };
                }
            } catch (e) {
                // Fallback query (si ID pas encore déterministe)
                try {
                    const usesQ = query(
                        collection(db, "coupon_uses"),
                        where("couponId", "==", couponId),
                        where("userId", "==", userId)
                    );
                    const usesSnap = await getDocs(usesQ);
                    if (!usesSnap.empty) {
                        return { valid: false, coupon: null, error: 'Vous avez déjà utilisé ce code', discountAmount: 0 };
                    }
                } catch (e2) {
                    console.warn('⚠️ Vérif coupon_uses échouée :', e2?.code);
                }
            }
        }

        // 7. Calculer la réduction
        const discountAmount = calculateCouponDiscount(
            { type: couponData.type, value: Number(couponData.value) || 0 },
            subtotal,
            deliveryFee
        );

        if (discountAmount <= 0) {
            return { valid: false, coupon: null, error: 'Ce code ne produit aucune réduction', discountAmount: 0 };
        }

        // 8. OK
        return {
            valid: true,
            coupon: {
                id: couponId,
                code: couponData.code,
                type: couponData.type,
                value: Number(couponData.value) || 0,
                minPurchase,
                discountAmount,
                oneUsePerUser: couponData.oneUsePerUser === true
            },
            error: null,
            discountAmount
        };

    } catch (e) {
        console.error('❌ validateCoupon :', e);
        return { valid: false, coupon: null, error: e?.message || 'Erreur de validation', discountAmount: 0 };
    }
}

console.log('✅ services/coupons.js chargé — v1.1.0 (getDoc déterministe)');