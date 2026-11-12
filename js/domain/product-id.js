/**
 * Normalisation d'un identifiant produit.
 *
 * Source unique de verite : cette logique etait dupliquee a l'identique
 * dans neuf modules (boutique, cart, panier, product-detail, products,
 * reviews, testimonials, ui, whatsapp). Toute divergence entre ces copies
 * provoquait des incoherences de panier silencieuses.
 *
 * @param {*} id
 * @returns {number|string|null} number si l'id est un entier canonique,
 *   la chaine d'origine sinon, null si absent.
 */
export function normalizeProductId(id) {
    if (id == null || id === "") return null;
    const n = Number(id);
    return Number.isFinite(n) && String(n) === String(id) ? n : String(id);
}
