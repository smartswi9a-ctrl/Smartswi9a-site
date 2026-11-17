/* ============================================================
   js/koulchi.js
   KOULCHI DIALK — PANIER GROUPÉ
   ============================================================
   Facade commerciale inspiree d AliExpress (Bundle Deals / Choice).

   PRINCIPE
     Un produit peut porter DEUX prix :
       product.price         prix classique (achat seul)
       product.koulchiPrice  prix de groupe (uniquement dans Koulchi)

     Le prix de groupe est OBLIGATOIRE a la creation du produit et
     DOIT etre strictement inferieur au prix classique. Il est saisi
     par le vendeur ou l admin : ce n est pas une remise calculee.

   REGLES DU PANIER KOULCHI
     - minimum 3 articles pour valider le panier groupe
     - maximum 10 articles au total
     - maximum 3 exemplaires d un meme produit
     - remise par palier sur le TOTAL :
         3 a 5 articles  -> -2%
         6 a 8 articles  -> -5%
         9 a 10 articles -> -10%

   SECURITE
     Les fonctions de ce fichier sont PURES (aucun acces reseau ni DOM)
     pour etre testables en Node. Le serveur recalcule TOUJOURS le prix
     dans createCustomerOrder : le client ne peut pas forger un montant.

   FAIL-OPEN
     Un produit sans koulchiPrice valide n entre jamais dans Koulchi :
     il est traite au prix normal. Aucun prix ne devient 0 ou null.

   ALERTE 1 : aucun commentaire de ligne dans ce fichier.
   ============================================================ */

/* ---------------------------------------------
   Constantes (source unique de verite)
   --------------------------------------------- */

const KOULCHI_MIN_ITEMS = 3;
const KOULCHI_MAX_ITEMS = 10;
const KOULCHI_MAX_PER_PRODUCT = 3;

/**
 * Paliers de remise, du plus eleve au plus bas.
 * min = nombre d articles minimum pour declencher ce palier.
 */
const KOULCHI_TIERS = [
  { min: 9, percent: 10 },
  { min: 6, percent: 5 },
  { min: 3, percent: 2 },
];

/* ---------------------------------------------
   Validation du prix de groupe
   --------------------------------------------- */

/**
 * Un prix Koulchi est-il exploitable ?
 * @param {number} koulchiPrice
 * @param {number} normalPrice
 * @returns {boolean}
 */
function isValidKoulchiPrice(koulchiPrice, normalPrice) {
  const k = Number(koulchiPrice);
  const p = Number(normalPrice);
  if (!Number.isFinite(k) || !Number.isFinite(p)) return false;
  if (k <= 0 || p <= 0) return false;
  return k < p;
}

/**
 * Un produit est-il eligible a Koulchi ?
 * Tolere en lecture : un produit sans prix Koulchi est simplement exclu.
 * @param {object} product
 * @returns {boolean}
 */
function isKoulchiEligible(product) {
  if (!product) return false;
  return isValidKoulchiPrice(product.koulchiPrice, product.price);

/* ---------------------------------------------
   Paliers
   --------------------------------------------- */

/**
 * Pourcentage de remise pour un nombre d articles donne.
 * @param {number} itemCount
 * @returns {number} 0 si sous le minimum
 */
function getKoulchiPercent(itemCount) {
  const n = Math.floor(Number(itemCount) || 0);
  if (n < KOULCHI_MIN_ITEMS) return 0;
  for (const tier of KOULCHI_TIERS) {
    if (n >= tier.min) return tier.percent;
  }
  return 0;
}

/**
 * Prochain palier a atteindre (pour le message d incitation).
 * @param {number} itemCount
 * @returns {{percent:number, missing:number}|null} null si palier max atteint
 */
function getNextKoulchiTier(itemCount) {
  const n = Math.floor(Number(itemCount) || 0);
  const ascending = KOULCHI_TIERS.slice().sort((a, b) => a.min - b.min);
  for (const tier of ascending) {
    if (n < tier.min && tier.min <= KOULCHI_MAX_ITEMS) {
      return { percent: tier.percent, missing: tier.min - n };
    }
  }
  return null;
}

/* ---------------------------------------------
   Calcul du panier Koulchi
   --------------------------------------------- */

/**
 * Totalise et remise un ensemble de lignes Koulchi.
 *
 * ENTREE : lignes { productId, quantity, unitPrice }
 *          ou unitPrice = product.koulchiPrice (PAS le prix normal).
 *
 * IMPORTANT : la remise est calculee sur le TOTAL, avec UN SEUL arrondi.
 * La somme des lignes arrondies et le total arrondi divergeraient de
 * quelques centimes, ce qui creerait un ecart entre l ecran et la base.
 *
 * @param {Array} lines
 * @returns {object}
 */
function computeKoulchiTotals(lines) {
  const list = Array.isArray(lines) ? lines : [];

  let itemCount = 0;
  let subtotal = 0;

  for (const line of list) {
    if (!line) continue;
    const qty = Math.max(0, Math.floor(Number(line.quantity) || 0));
    const price = Math.max(0, Number(line.unitPrice) || 0);
    if (qty <= 0 || price <= 0) continue;
    itemCount += qty;
    subtotal += price * qty;
  }

  const percent = getKoulchiPercent(itemCount);
  const discount = percent > 0 ? Math.round((subtotal * percent) / 100) : 0;
  const total = Math.max(0, subtotal - discount);

  return {
    itemCount,
    subtotal,
    percent,
    discount,
    total,
    isValid: itemCount >= KOULCHI_MIN_ITEMS && itemCount <= KOULCHI_MAX_ITEMS,
    overLimit: itemCount > KOULCHI_MAX_ITEMS,
  };
}

}

/**
 * Filtre une liste de produits pour ne garder que les eligibles.
 * @param {Array} products
 * @returns {Array}
 */
function filterKoulchiProducts(products) {
  if (!Array.isArray(products)) return [];
  return products.filter(isKoulchiEligible);
}


/**
 * Repartit la remise sur chaque ligne, pour l AFFICHAGE uniquement.
 * Le total affiche doit toujours rester computeKoulchiTotals().total.
 * La derniere ligne absorbe l arrondi pour que la somme soit exacte.
 *
 * @param {Array} lines
 * @param {number} discountTotal remise calculee par computeKoulchiTotals
 * @returns {Array} lignes enrichies de lineDiscount et lineTotal
 */
function distributeKoulchiDiscount(lines, discountTotal) {
  const list = Array.isArray(lines) ? lines : [];
  const totalDiscount = Math.max(0, Math.round(Number(discountTotal) || 0));

  let sumLineTotals = 0;
  for (const line of list) {
    if (!line) continue;
    const qty = Math.max(0, Math.floor(Number(line.quantity) || 0));
    const price = Math.max(0, Number(line.unitPrice) || 0);
    sumLineTotals += price * qty;
  }

  if (totalDiscount === 0 || sumLineTotals === 0) {
    return list.map((line) => {
      const qty = Math.max(0, Math.floor(Number(line && line.quantity) || 0));
      const price = Math.max(0, Number(line && line.unitPrice) || 0);
      return { ...line, lineDiscount: 0, lineTotal: price * qty };
    });
  }

  const out = [];
  let distributed = 0;

  for (let i = 0; i < list.length; i++) {
    const line = list[i];
    const qty = Math.max(0, Math.floor(Number(line && line.quantity) || 0));
    const price = Math.max(0, Number(line && line.unitPrice) || 0);
    const lineTotal = price * qty;

    let lineDiscount;
    if (i === list.length - 1) {
      lineDiscount = totalDiscount - distributed;
    } else {
      lineDiscount = Math.round((lineTotal / sumLineTotals) * totalDiscount);
    }
    if (lineDiscount < 0) lineDiscount = 0;
    if (lineDiscount > lineTotal) lineDiscount = lineTotal;

    distributed += lineDiscount;
    out.push({ ...line, lineDiscount, lineTotal: lineTotal - lineDiscount });
  }

  return out;
}

/* ---------------------------------------------
   Garde-fous d ajout
   --------------------------------------------- */

/**
 * Peut-on ajouter qty exemplaires de ce produit au panier Koulchi ?
 * Retourne la raison du refus, pour afficher un message precis.
 *
 * @param {Array} lines lignes actuelles
 * @param {string} productId
 * @param {number} qty quantite a ajouter (defaut 1)
 * @returns {{ allowed:boolean, reason:string|null, maxAddable:number }}
 */
function canAddToKoulchi(lines, productId, qty = 1) {
  const list = Array.isArray(lines) ? lines : [];
  const pid = String(productId || "");
  const add = Math.max(1, Math.floor(Number(qty) || 1));
  if (!pid) return { allowed: false, reason: "invalid", maxAddable: 0 };

  let itemCount = 0;
  let sameProduct = 0;
  for (const line of list) {
    if (!line) continue;
    const q = Math.max(0, Math.floor(Number(line.quantity) || 0));
    itemCount += q;
    if (String(line.productId) === pid) sameProduct += q;
  }

  if (sameProduct + add > KOULCHI_MAX_PER_PRODUCT) {
    return {
      allowed: false,
      reason: "maxPerProduct",
      maxAddable: Math.max(0, KOULCHI_MAX_PER_PRODUCT - sameProduct),
    };
  }

  if (itemCount + add > KOULCHI_MAX_ITEMS) {
    return {
      allowed: false,
      reason: "maxItems",
      maxAddable: Math.max(0, KOULCHI_MAX_ITEMS - itemCount),
    };
  }

  return { allowed: true, reason: null, maxAddable: add };
}

/**
 * Etat complet du panier Koulchi pour l interface.
 * @param {Array} lines
 * @returns {object}
 */
function getKoulchiState(lines) {
  const totals = computeKoulchiTotals(lines);
  return {
    ...totals,
    nextTier: getNextKoulchiTier(totals.itemCount),
    missingForMin: Math.max(0, KOULCHI_MIN_ITEMS - totals.itemCount),
    remainingSlots: Math.max(0, KOULCHI_MAX_ITEMS - totals.itemCount),
  };
}

module.exports={getKoulchiPercent,KOULCHI_MIN_ITEMS};
