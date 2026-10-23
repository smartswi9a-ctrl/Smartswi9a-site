// js/vendor-attribution.js
// ============================================================
// ATTRIBUTION VENDEUR - SMART SWI9A
// Version 1.1.0 — Correctifs E10 :
//   - lecture de vendorsPublic/{uid} (collection publique dédiée)
//     au lieu de users/… (qui fuit iceCin, phone, email, city)
//   - préchargement ciblé via preloadVendorsForProducts(products)
//   - preloadVendorNames() conservé mais marqué déprécié (limite 200)
//   - fallback sécurisé users/{uid} UNIQUEMENT pour son propre profil
//   - constantes au lieu de chaînes magiques ('Boutique', 'approved', …)
//   - catches non silencieux (sauf permission-denied attendu)
// ============================================================

import { doc, getDoc, collection, getDocs, query, limit } from "firebase/firestore";
import { db, auth } from "./firebase.js";
import { getProductOwner } from "./config.js";

// ============================================================
// ÉTAT
// ============================================================
const _vendorCache = new Map(); // uid → { shopName, status }
let _allVendorsPreloaded = false;

const GENERIC_SHOP_NAME = 'Boutique';
const SMART_NAME = 'Smart Swi9a';
const SMART_OWNER_ID = 'smartswi9a';

// ============================================================
// HELPERS INTERNES
// ============================================================
function _currentUid() {
    try { return auth?.currentUser?.uid || null; } catch (_) { return null; }
}

/**
 * Charge (best-effort) un vendeur dans le cache.
 * Priorité :
 *   1. vendorsPublic/{uid}   — collection publique non sensible.
 *   2. users/{uid}           — SEULEMENT si c'est notre propre profil
 *                              (permet de voir son nom de boutique avant
 *                               que l'admin n'écrive vendorsPublic).
 *                              Toute autre lecture users/… est bloquée
 *                              par les règles Firestore (permission-denied
 *                              attendu, non loggé).
 */
async function _fetchVendorIntoCache(uid) {
    if (!uid || uid === SMART_OWNER_ID) return;
    if (_vendorCache.has(uid)) return;

    // 1. vendorsPublic
    try {
        const snap = await getDoc(doc(db, "vendorsPublic", uid));
        if (snap.exists()) {
            const data = snap.data();
            _vendorCache.set(uid, {
                shopName: data.shopName || GENERIC_SHOP_NAME,
                status: data.status || 'pending'
            });
            return;
        }
    } catch (e) {
        if (e?.code !== 'permission-denied') {
            console.warn('⚠️ [vendor-attribution] vendorsPublic/' + uid + ' :', e?.code || e);
        }
    }

    // 2. Fallback users/{ownUid}
    if (_currentUid() === uid) {
        try {
            const snap = await getDoc(doc(db, "users", uid));
            if (snap.exists()) {
                const data = snap.data();
                if (data && data.vendorInfo && data.vendorInfo.shopName) {
                    _vendorCache.set(uid, {
                        shopName: data.vendorInfo.shopName,
                        status: data.vendorInfo.status || 'pending'
                    });
                }
            }
        } catch (e) {
            if (e?.code !== 'permission-denied') {
                console.warn('⚠️ [vendor-attribution] users/' + uid + ' (own) :', e?.code || e);
            }
        }
    }
}

// ============================================================
// PRÉCHARGEMENT
// ============================================================

/**
 * ⚠️ DÉPRÉCIÉ — préférez preloadVendorsForProducts(products).
 * Précharge jusqu'à 200 vendeurs depuis vendorsPublic (données publiques).
 * Conservé pour compatibilité ; les appelants existants continuent de
 * fonctionner sans modification.
 *
 * @returns {Promise<boolean>} true si le préchargement a réussi, false sinon.
 *   En cas d'échec, _allVendorsPreloaded reste false (retry possible).
 */
export async function preloadVendorNames() {
    if (_allVendorsPreloaded) return true;
    try {
        const q = query(collection(db, "vendorsPublic"), limit(200));
        const snap = await getDocs(q);
        snap.forEach(d => {
            const data = d.data();
            _vendorCache.set(d.id, {
                shopName: data.shopName || GENERIC_SHOP_NAME,
                status: data.status || 'pending'
            });
        });
        _allVendorsPreloaded = true;
        return true;
    } catch (e) {
        console.warn('⚠️ [vendor-attribution] Préchargement vendorsPublic échoué:', e?.code || e);
        // Flag volontairement non posé : un appel ultérieur pourra réessayer.
        return false;
    }
}

/**
 * Précharge UNIQUEMENT les vendeurs des produits passés en argument.
 * À appeler depuis products.js / boutique.js / product-detail.js / ui.js
 * après avoir chargé la liste de produits affichés.
 *
 * Seuls les produits sans `vendorName` déjà présent déclenchent une lecture.
 * Aucune donnée sensible n'est lue (vendorsPublic/{uid} uniquement).
 *
 * @param {Array<Object>} products
 * @returns {Promise<void>}
 */
export async function preloadVendorsForProducts(products) {
    if (!Array.isArray(products) || !products.length) return;

    const uids = new Set();
    for (const p of products) {
        if (!p) continue;
        if (p.vendorName) continue; // label déjà porté par le produit
        const owner = getProductOwner(p);
        if (!owner || owner === SMART_OWNER_ID) continue;
        if (_vendorCache.has(owner)) continue;
        uids.add(owner);
    }

    if (!uids.size) return;
    await Promise.all([...uids].map(uid => _fetchVendorIntoCache(uid)));
}

// ============================================================
// LABEL — VERSION SYNCHRONE (cache uniquement)
// ============================================================
/**
 * Version synchrone, à utiliser dans les boucles de rendu.
 * Ne fait AUCUN appel réseau. Résout dans l'ordre :
 *   1. `product.vendorName` (porté par le produit — cas idéal)
 *   2. `_vendorCache` (préchargé via preloadVendorsForProducts)
 *   3. Fallback générique (« Boutique » / statut `unknown`)
 *
 * ⚠️ Le statut `'approved'` renvoyé quand `product.vendorName` est présent
 *    est OPTIMISTE : la suspension d'un vendeur après approbation de son
 *    produit n'est détectée qu'en appelant `getProductVendorLabel` (async)
 *    ou en passant le vendeur à `isProductPubliclyVisible` (config.js).
 *
 * @param {Object|null} product
 * @returns {{ name: string, type: 'smart'|'vendor', status?: string }}
 */
export function getProductVendorLabelSync(product) {
    if (!product) return { name: SMART_NAME, type: 'smart' };

    if (product.vendorName && product.vendorId && product.vendorId !== SMART_OWNER_ID) {
        // Le produit porte déjà le nom : pas d'appel réseau nécessaire.
        // Statut optimiste — voir avertissement ci-dessus.
        const owner = product.vendorId;
        const cached = _vendorCache.get(owner);
        return {
            name: product.vendorName,
            type: 'vendor',
            status: cached?.status || 'approved'
        };
    }

    const owner = getProductOwner(product);
    if (!owner || owner === SMART_OWNER_ID) {
        return { name: SMART_NAME, type: 'smart' };
    }

    const cached = _vendorCache.get(owner);
    return {
        name: cached?.shopName || GENERIC_SHOP_NAME,
        type: 'vendor',
        status: cached?.status || 'unknown'
    };
}

// ============================================================
// LABEL — VERSION ASYNCHRONE (résolution à la demande)
// ============================================================
/**
 * Version asynchrone : tente de résoudre le nom du vendeur si le cache
 * ne le connaît pas encore. À utiliser lorsqu'on affiche UN SEUL produit
 * (page détail, order item) ou lorsqu'on veut le statut frais.
 *
 * @param {Object} product
 * @returns {Promise<{ name: string, type: 'smart'|'vendor', status?: string }>}
 */
export async function getProductVendorLabel(product) {
    const syncResult = getProductVendorLabelSync(product);

    // Produit Smart Swi9a : rien à chercher
    if (syncResult.type === 'smart') return syncResult;
    // Cache déjà rempli avec un vrai nom : pas d'appel réseau
    if (syncResult.name && syncResult.name !== GENERIC_SHOP_NAME) return syncResult;

    const owner = getProductOwner(product);
    if (!owner || owner === SMART_OWNER_ID) return syncResult;

    await _fetchVendorIntoCache(owner);
    return getProductVendorLabelSync(product);
}

// ============================================================
// RESET
// ============================================================
export function resetVendorCache() {
    _vendorCache.clear();
    _allVendorsPreloaded = false;
}