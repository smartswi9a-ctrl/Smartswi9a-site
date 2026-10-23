// js/vendor-attribution.js
// ============================================================
// ATTRIBUTION VENDEUR - SMART SWI9A
// Version 1.0.0 — Qui vend quoi ? (avec cache)
// ============================================================

import { doc, getDoc, collection, getDocs, query, where } from "firebase/firestore";
import { db } from "./firebase.js";
import { getProductOwner, ROLES } from "./config.js";

const _vendorCache = new Map();
let _allVendorsPreloaded = false;

export async function preloadVendorNames() {
    if (_allVendorsPreloaded) return;
    try {
        const q = query(collection(db, "users"), where("role", "==", ROLES.VENDOR));
        const snap = await getDocs(q);
        snap.forEach(d => {
            const data = d.data();
            _vendorCache.set(d.id, {
                shopName: data.vendorInfo?.shopName || data.name || 'Boutique',
                status: data.vendorInfo?.status || 'pending'
            });
        });
        _allVendorsPreloaded = true;
    } catch (e) {
        console.warn('⚠️ [vendor-attribution] Préchargement échoué:', e);
    }
}

export function getProductVendorLabelSync(product) {
    if (!product) return { name: 'Smart Swi9a', type: 'smart' };

    if (product.vendorName && product.vendorId && product.vendorId !== 'smartswi9a') {
        return { name: product.vendorName, type: 'vendor', status: 'approved' };
    }

    const owner = getProductOwner(product);

    if (!owner || owner === 'smartswi9a') {
        return { name: 'Smart Swi9a', type: 'smart' };
    }

    const cached = _vendorCache.get(owner);
    return {
        name: cached?.shopName || 'Boutique',
        type: 'vendor',
        status: cached?.status || 'unknown'
    };
}

export async function getProductVendorLabel(product) {
    const syncResult = getProductVendorLabelSync(product);
    if (syncResult.type === 'smart' || syncResult.name !== 'Boutique') return syncResult;

    const owner = getProductOwner(product);
    if (!owner) return syncResult;

    try {
        const snap = await getDoc(doc(db, "users", owner));
        if (snap.exists()) {
            const data = snap.data();
            const shopName = data.vendorInfo?.shopName || data.name || 'Boutique';
            _vendorCache.set(owner, { shopName, status: data.vendorInfo?.status || 'pending' });
            return { name: shopName, type: 'vendor', status: data.vendorInfo?.status };
        }
    } catch (e) {}

    return syncResult;
}

export function resetVendorCache() {
    _vendorCache.clear();
    _allVendorsPreloaded = false;
}