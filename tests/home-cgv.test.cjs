/* ============================================================
   tests/home-cgv.test.cjs
   GARDE-FOU : resume CGV de l accueil (offres + garanties).
   ------------------------------------------------------------
   Verifie que l accueil distingue bien :
     - produits Smartswika : garantie 15 jours ;
     - produits vendeurs  : garantie 7 jours ;
     - offres Koulchi 5 / 10 / 15 % ;
     - livraison Livo, paiement a la livraison.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
let verifications = 0;
let echecs = 0;

function check(nom, condition) {
  verifications++;
  if (condition) console.log("PASS: " + nom);
  else {
    echecs++;
    console.error("ECHEC: " + nom);
  }
}

const index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const tr = fs.readFileSync(path.join(ROOT, "translations.js"), "utf8");

check("accueil : bloc CGV branche sur homeTermsHtml", index.includes('data-key="homeTermsHtml"'));
check("accueil : garantie Smartswika 15 jours", index.includes("Garantie totale 15 jours"));
check("accueil : garantie vendeurs 7 jours", index.includes("Garantie totale 7 jours"));
check("accueil : paliers Koulchi 5 / 10 / 15", index.includes("−5 %") && index.includes("−10 %") && index.includes("−15 %"));
check("accueil : livraison Livo + paiement a la livraison", index.includes("Livraison Livo") && index.includes("paiement à la livraison"));
check("traductions : homeTermsHtml present en 3 langues", (tr.match(/homeTermsHtml/g) || []).length === 3);

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Resume CGV accueil : verifie.");
