/* ============================================================
   js/cart-intent.js
   Intention d'achat en attente de connexion.
   ------------------------------------------------------------
   DECISION PRODUIT (2026-11-19) : l'ajout au panier exige un compte
   client — il n'y a pas de panier invite. Pour ne pas perdre la
   conversion, on memorise le produit clique lorsqu'un visiteur non
   connecte tente de l'ajouter, puis on l'ajoute automatiquement
   des que la connexion (ou l'inscription) aboutit.

   Module pur (aucune dependance navigateur) pour rester testable.
   ============================================================ */

/** Duree de validite d'une intention : 30 minutes. */
export const CART_INTENT_TTL_MS = 30 * 60 * 1000;

/**
 * Serialise une intention d'achat.
 * @param {string} productId
 * @param {string|null} variant
 * @param {string|null} mode  "koulchi" ou null
 * @param {number} now        horodatage (ms)
 * @returns {string} JSON pret a stocker
 */
export function buildCartIntent(productId, variant, mode, now) {
  return JSON.stringify({
    productId: String(productId),
    variant: variant || null,
    mode: mode === "koulchi" ? "koulchi" : null,
    at: Number(now) || 0,
  });
}

/**
 * Relit une intention stockee. Retourne null si absente, illisible,
 * sans produit ou expiree.
 * @param {string|null} raw
 * @param {number} now
 * @param {number} [ttl]
 * @returns {{productId:string, variant:string|null, mode:string|null}|null}
 */
export function readCartIntent(raw, now, ttl = CART_INTENT_TTL_MS) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!parsed.productId) return null;

  const age = Number(now) - Number(parsed.at || 0);
  if (!Number.isFinite(age) || age < 0 || age > ttl) return null;

  return {
    productId: String(parsed.productId),
    variant: parsed.variant || null,
    mode: parsed.mode === "koulchi" ? "koulchi" : null,
  };
}
