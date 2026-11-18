/* ============================================================
   tests/cart-limits.test.cjs
   GARDE-FOU PLAFONDS DE QUANTITE
   ------------------------------------------------------------
   Regle commerciale demandee le 2026-11-18 :
     - panier GROUPE (Koulchi dialk) : 4 exemplaires par produit ;
     - panier CLASSIQUE             : 10 exemplaires par produit.

   Ces plafonds doivent etre appliques dans cart.js (ajout ET
   modification de quantite), dans panier.js (boutons + / saisie) et
   etre visibles cote textes. Ce test lit les SOURCES : il attrape une
   regression la ou un test unitaire classique ne pourrait pas tourner
   (les modules panier dependent du DOM).

   Historique : la limite Koulchi existait mais n etait jamais atteinte
   (addToCart excluait la ligne du meme produit) -> un client a pu
   ajouter 8 exemplaires. Test C6 de koulchi.test.mjs couvre ce cas.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const lire = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const CART = lire("js/cart.js");
const KOULCHI = lire("js/koulchi.js");
const PANIER = lire("js/panier.js");
const TRAD = lire("translations.js");

let verifications = 0;
let echecs = 0;

function ok(nom, detail) {
  verifications++;
  console.log("PASS: " + nom + (detail ? " -> " + detail : ""));
}

function ko(nom, detail) {
  verifications++;
  echecs++;
  console.error("ECHEC: " + nom + (detail ? " -> " + detail : ""));
}

function verifie(nom, condition, detail) {
  condition ? ok(nom, detail) : ko(nom, detail);
}

/* --------------------------------------------- constantes */

verifie(
  "CART_MAX_PER_PRODUCT = 10 (panier classique)",
  /export const CART_MAX_PER_PRODUCT = 10;/.test(CART)
);

verifie(
  "KOULCHI_MAX_PER_PRODUCT = 4",
  /export const KOULCHI_MAX_PER_PRODUCT = 4;/.test(KOULCHI)
);

verifie(
  "KOULCHI_MAX_ITEMS = 10 (total groupe)",
  /export const KOULCHI_MAX_ITEMS = 10;/.test(KOULCHI)
);

/* --------------------------------------------- application dans cart.js */

verifie(
  "addToCart applique un plafond selon la zone",
  /const plafond =\s*\n?\s*mode === "koulchi" \? KOULCHI_MAX_PER_PRODUCT : CART_MAX_PER_PRODUCT;/.test(
    CART
  ),
  "plafond 4 (groupe) / 10 (classique)"
);

verifie(
  "updateCartQuantity applique le plafond",
  /item\.mode === "koulchi" \? KOULCHI_MAX_PER_PRODUCT : CART_MAX_PER_PRODUCT;/.test(
    CART
  )
);

verifie(
  "updateCartQuantity verifie le total groupe (10)",
  /autres \+ newQty > KOULCHI_MAX_ITEMS/.test(CART)
);

verifie(
  "loadCart recale le panier classique a 10",
  /quantity: Math\.min\(\s*\n?\s*Math\.floor\(Number\(item\.quantity\) \|\| 0\),\s*\n?\s*CART_MAX_PER_PRODUCT/.test(
    CART
  )
);

/* --------------------------------------------- application dans panier.js */

verifie(
  "panier.js expose quantiteAutorisee(item, cible)",
  /function quantiteAutorisee\(item, cible\)/.test(PANIER)
);

verifie(
  "le bouton + passe par quantiteAutorisee",
  /if \(!quantiteAutorisee\(item, item\.quantity \+ 1\)\) return;/.test(PANIER)
);

verifie(
  "la saisie directe passe par quantiteAutorisee",
  /if \(!quantiteAutorisee\(item, val\)\) \{/.test(PANIER)
);

verifie(
  "champ quantite borne par le plafond de la zone",
  /Math\.min\(isKoulchi \? KOULCHI_MAX_PER_PRODUCT : CART_MAX_PER_PRODUCT, maxStock \|\| 999\)/.test(
    PANIER
  )
);

verifie(
  "bouton + desactive au plafond classique",
  /!isKoulchi && quantity >= CART_MAX_PER_PRODUCT/.test(PANIER)
);

/* --------------------------------------------- textes */

verifie(
  "message cartMaxQty en fr / ar / en",
  (TRAD.match(/cartMaxQty:/g) || []).length === 3,
  "3 occurrences attendues"
);

verifie(
  "le message Koulchi parle bien de 4 exemplaires",
  /koulchiMaxPerProduct: "Maximum 4 exemplaires par produit"/.test(TRAD) &&
    /koulchiMaxPerProduct: "الحد الأقصى 4 قطع لكل منتج"/.test(TRAD) &&
    /koulchiMaxPerProduct: "Maximum 4 units per product"/.test(TRAD)
);

/* --------------------------------------------- resume */

console.log("\n" + verifications + " verification(s), " + echecs + " echec(s)");
process.exit(echecs === 0 ? 0 : 1);
