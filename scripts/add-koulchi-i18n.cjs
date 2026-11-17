/* ============================================================
   scripts/add-koulchi-i18n.cjs
   Ajoute les cles du panier a deux zones (K2) dans translations.js
   et remplace la promesse publique « 5 % des 3 articles », qui est
   supprimee du site.

   CONTRAINTES RESPECTEES
     - execution idempotente : relancer ne duplique rien ;
     - ecriture UTF-8 SANS BOM (translations.js n a pas de BOM) ;
     - validation finale : chaque cle doit exister 3 fois (fr/ar/en) ;
     - aucun commentaire de ligne dans translations.js.

   USAGE : node scripts/add-koulchi-i18n.cjs
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "translations.js");
const LANGS = ["fr", "ar", "en"];

/* La banniere ne doit plus promettre une remise qui n existe plus.
   Le texte Koulchi definitif sera pose avec K3/K6, quand la zone sera
   reellement facturee par le serveur. */
const PROMO = {
  fr: "Livraison 24-72h partout au Maroc",
  ar: "توصيل خلال 24-72 ساعة في كل المغرب",
  en: "Delivery in 24-72h across Morocco",
};

const KEYS = {
  fr: [
    ["koulchiZoneTitle", "Koulchi dialk"],
    ["koulchiZoneSubtitle", "Achetez ensemble, payez moins cher."],
    ["koulchiZoneEmpty", "Ajoutez 3 articles pour activer les prix de groupe."],
    ["koulchiClassicZone", "Panier classique"],
    ["koulchiMissing", "Ajoutez {n} article(s) pour activer Koulchi (−{p} %)."],
    ["koulchiNextTier", "Ajoutez {n} article(s) pour passer à −{p} %."],
    ["koulchiGain", "Vous gagnez +{g} DH."],
    [
      "koulchiNotActiveYet",
      "En attendant les 3 articles, ces lignes sont facturées au prix normal.",
    ],
    ["koulchiMaxReached", "Palier maximum atteint : −10 % sur la zone Koulchi."],
    ["koulchiDiscountLabel", "Remise Koulchi (−{p} %)"],
    ["koulchiSavingsLabel", "Économie prix Koulchi"],
    ["koulchiZoneTotal", "Total Koulchi"],
    ["koulchiMoveTo", "Passer en Koulchi"],
    ["koulchiMoveBack", "Remettre en classique"],
    ["koulchiMaxPerProduct", "Maximum 3 exemplaires par produit"],
    ["koulchiMaxItems", "Maximum 10 articles dans le panier Koulchi"],
    [
      "koulchiVariantExcluded",
      "Les produits avec taille/couleur ne sont pas éligibles à Koulchi.",
    ],
    ["koulchiNotEligible", "Ce produit n'a pas de prix Koulchi."],
    ["koulchiSummaryDetail", "dont Koulchi ({n} art., −{p} %)"],
  ],
  ar: [
    ["koulchiZoneTitle", "كولشي ديالك"],
    ["koulchiZoneSubtitle", "اشتروا معاً ووفروا أكثر."],
    ["koulchiZoneEmpty", "أضف 3 منتجات لتفعيل أسعار المجموعة."],
    ["koulchiClassicZone", "السلة العادية"],
    ["koulchiMissing", "أضف {n} منتج(ات) لتفعيل كولشي (−{p}%)."],
    ["koulchiNextTier", "أضف {n} منتج(ات) للوصول إلى −{p}%."],
    ["koulchiGain", "تربح +{g} درهم."],
    [
      "koulchiNotActiveYet",
      "في انتظار بلوغ 3 منتجات، تُحتسب هذه المنتجات بالسعر العادي.",
    ],
    ["koulchiMaxReached", "تم الوصول إلى أعلى نسبة: −10% على سلة كولشي."],
    ["koulchiDiscountLabel", "خصم كولشي (−{p}%)"],
    ["koulchiSavingsLabel", "وفر سعر كولشي"],
    ["koulchiZoneTotal", "مجموع كولشي"],
    ["koulchiMoveTo", "أضف إلى كولشي"],
    ["koulchiMoveBack", "إرجاع إلى السلة العادية"],
    ["koulchiMaxPerProduct", "الحد الأقصى 3 قطع لكل منتج"],
    ["koulchiMaxItems", "الحد الأقصى 10 منتجات في سلة كولشي"],
    ["koulchiVariantExcluded", "المنتجات ذات المقاس/اللون غير مؤهلة لكولشي."],
    ["koulchiNotEligible", "هذا المنتج ليس له سعر كولشي."],
    ["koulchiSummaryDetail", "منها كولشي ({n} قطعة، −{p}%)"],
  ],
  en: [
    ["koulchiZoneTitle", "Koulchi dialk"],
    ["koulchiZoneSubtitle", "Buy together, pay less."],
    ["koulchiZoneEmpty", "Add 3 items to unlock group prices."],
    ["koulchiClassicZone", "Standard cart"],
    ["koulchiMissing", "Add {n} item(s) to activate Koulchi (−{p}%)."],
    ["koulchiNextTier", "Add {n} item(s) to reach −{p}%."],
    ["koulchiGain", "You gain +{g} DH."],
    [
      "koulchiNotActiveYet",
      "Until 3 items are reached, these lines are charged at the normal price.",
    ],
    ["koulchiMaxReached", "Maximum tier reached: −10% on the Koulchi zone."],
    ["koulchiDiscountLabel", "Koulchi discount (−{p}%)"],
    ["koulchiSavingsLabel", "Koulchi price savings"],
    ["koulchiZoneTotal", "Koulchi total"],
    ["koulchiMoveTo", "Move to Koulchi"],
    ["koulchiMoveBack", "Move back to standard"],
    ["koulchiMaxPerProduct", "Maximum 3 units per product"],
    ["koulchiMaxItems", "Maximum 10 items in the Koulchi cart"],
    [
      "koulchiVariantExcluded",
      "Products with size/color are not eligible for Koulchi.",
    ],
    ["koulchiNotEligible", "This product has no Koulchi price."],
    ["koulchiSummaryDetail", "of which Koulchi ({n} items, −{p}%)"],
  ],
};

function fail(message) {
  console.error("ECHEC: " + message);
  process.exit(1);
}

const raw = fs.readFileSync(FILE, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);

if (!raw.includes("koulchiZoneTitle:")) {
  const anchors = [];
  lines.forEach((line, index) => {
    if (/^\s{6}cartTitle:\s*"/.test(line)) anchors.push(index);
  });
  if (anchors.length !== 3) {
    fail("3 ancres cartTitle attendues, trouvees: " + anchors.length);
  }
  for (let i = LANGS.length - 1; i >= 0; i--) {
    const block = KEYS[LANGS[i]].map(
      function (entry) {
        return '      ' + entry[0] + ': "' + entry[1] + '",';
      }
    );
    lines.splice(anchors[i] + 1, 0, ...block);
  }
  console.log("Cles Koulchi ajoutees dans fr/ar/en.");
} else {
  console.log("Cles Koulchi deja presentes, insertion ignoree.");
}

let text = lines.join(eol);
let promoIndex = 0;
text = text.replace(/promoBannerText:\s*"[^"]*"/g, function () {
  const lang = LANGS[promoIndex];
  promoIndex += 1;
  if (!lang) return 'promoBannerText: ""';
  return 'promoBannerText: "' + PROMO[lang] + '"';
});
if (promoIndex !== 3) {
  fail("3 promoBannerText attendus, trouves: " + promoIndex);
}

fs.writeFileSync(FILE, text, "utf8");

const check = fs.readFileSync(FILE, "utf8");
const bytes = fs.readFileSync(FILE);
if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
  fail("BOM detecte apres ecriture");
}
for (const entry of KEYS.fr) {
  const key = entry[0];
  const count = check.split(key + ":").length - 1;
  if (count !== 3) fail(key + " present " + count + " fois (3 attendu)");
}
console.log("Validation OK : " + KEYS.fr.length + " cles x 3 langues.");
console.log("Banniere remplacee dans les 3 langues.");