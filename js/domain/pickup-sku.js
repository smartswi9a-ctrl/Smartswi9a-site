/* ============================================================
   js/domain/pickup-sku.js
   SKU deterministe par ligne de ramassage (aucune dependance).
   Format : SWK-<6 caracteres de la demande>-<numero de ligne 2 chiffres>
   ============================================================ */

/**
 * SKU stable d une ligne de ramassage.
 * @param {string} requestId identifiant Firestore de la demande
 * @param {number} index index de ligne (0 base)
 * @returns {string}
 */
export function pickupSku(requestId, index) {
    const clean = String(requestId || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const suffix = clean.slice(-6).padStart(6, '0');
    const line = String((Number(index) || 0) + 1).padStart(2, '0');
    return `SWK-${suffix}-${line}`;
}

/**
 * Quantite recue valide : entier entre 0 et la quantite declaree.
 * @param {*} value
 * @param {number} declared
 * @returns {number}
 */
export function normalizeReceivedQuantity(value, declared) {
    const max = Math.max(0, Number(declared) || 0);
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return max;
    return Math.min(n, max);
}
