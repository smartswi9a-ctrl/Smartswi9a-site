/* ============================================================
   tests/secondary-ui.test.cjs
   GARDE-FOU — couche graphique secondaire (produit, client, villes)
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
let verifications = 0;
let echecs = 0;

function check(nom, condition, detail) {
  verifications++;
  if (condition) console.log("PASS: " + nom + (detail ? " -> " + detail : ""));
  else {
    echecs++;
    console.error("ECHEC: " + nom + (detail ? " -> " + detail : ""));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const css = read("css/secondary-modern.css");
const ui = read("js/secondary-ui.js");
const pdp = read("js/product-detail.js");
const i18n = read("js/shop-i18n.js");
const produit = read("produit.html");
const villes = read("villesmaroc.html");

/* --------------------------------------------- 1. livraison des assets */
check("secondary : feuille moderne presente", fs.existsSync(path.join(ROOT, "css/secondary-modern.css")));
check("secondary : micro-interactions presentes", fs.existsSync(path.join(ROOT, "js/secondary-ui.js")));
for (const page of ["produit.html", "villesmaroc.html", "index.html", "blog.html", "koulchi.html", "boutique.html", "panier.html", "admin.html"]) {
  check("secondary : CSS charge sur " + page, read(page).includes("/css/secondary-modern.css"));
}
check("secondary : JS charge sur produit", produit.includes("/js/secondary-ui.js"));
check("secondary : JS charge sur villes", villes.includes("/js/secondary-ui.js"));

/* --------------------------------------------- 2. fiche produit */
check("produit : conteneur reassurance", produit.includes('id="productReassurance"'));
check("produit : badge vendeur moderne", pdp.includes('shopT("pdpBadgeVendor")') && pdp.includes('shopT("pdpBadgeVendorSep")'));
check("produit : badge Smartswika moderne", pdp.includes('shopT("pdpBadgeSmart")'));
check("produit : reassurance COD / Livo / support", pdp.includes('shopT("pdpCodTitle")') && pdp.includes('shopT("pdpLivoTitle")') && pdp.includes('shopT("pdpSupportTitle")'));
check("produit : galerie ratio fixe (CLS 0)", /#mainMediaWrapper \{[^}]*aspect-ratio: 1 \/ 1/s.test(css));
check("produit : miniatures accessibles", pdp.includes('thumb.setAttribute("tabindex", "0")') && pdp.includes("aria-current"));
check("produit : variantes aria-pressed", pdp.includes('aria-pressed="false"') && pdp.includes('b.setAttribute("aria-pressed"'));
check("produit : bouton panier anime", pdp.includes("pulseAddButton") && css.includes(".product-actions .btn-primary.is-added"));
check("produit : offres Koulchi animees", css.includes(".koulchi-offer-tier") && css.includes("@keyframes sm-tier-in"));

/* --------------------------------------------- 3. dictionnaires FR / EN / AR */
function langBlock(lang) {
  const marker = "\n  " + lang + ": {";
  const start = i18n.indexOf(marker);
  if (start < 0) return "";
  const end = i18n.indexOf("\n  },", start);
  return i18n.slice(start, end > start ? end : undefined);
}
const expected = {
  fr: ["Sélection Smartswika · Garantie 15 jours", "Vendeur vérifié · Garantie 7 jours", "Paiement à la livraison", "Livraison Livo 24-72h"],
  en: ["Smartswika Selection · 15-day warranty", "Verified seller · 7-day warranty", "Cash on delivery", "Livo delivery 24-72h"],
  ar: ["ضمان 15 يومًا", "ضمان 7 أيام", "الدفع عند الاستلام", "توصيل ليفو"],
};
for (const lang of ["fr", "en", "ar"]) {
  const block = langBlock(lang);
  check(
    "i18n produit : libelles " + lang.toUpperCase(),
    expected[lang].every((needle) => block.includes(needle)),
    expected[lang].join(" | ")
  );
  check("i18n produit : separateur " + lang.toUpperCase(), /pdpBadgeVendorSep:\s*" · "/.test(block));
}

/* --------------------------------------------- 4. espace client / timeline */
check("client : modale compte modernisee", css.includes("#accountModal .modal"));
check("client : timeline Livo", css.includes(".order-timeline") && css.includes(".order-timeline-dot"));
check("client : timeline animee", css.includes("@keyframes sm-dot-pulse") && css.includes(".order-timeline-step.current"));
check("client : badges / cartes commandes", css.includes(".order-card-id") && css.includes(".order-card-actions"));
check("client : onglets tactiles 44px", /#accountContent \.tab-btn \{[^}]*min-height: 44px/s.test(css));

/* --------------------------------------------- 5. villes / JSON-LD */
check("villes : refonte cartes et tableau", css.includes(".villes-container .ville-stat-card") && css.includes(".villes-container .villes-table tbody tr:hover"));
check("villes : recherche reactive", css.includes(".villes-container .villes-search input:focus"));
check("villes : reveal sans toucher au JSON-LD", ui.includes("IntersectionObserver") && !ui.includes("ld+json"));
check("villes : JSON-LD Service conserve", villes.includes('id="ld-delivery-service"') && villes.includes('"@type": "Service"'));
check("villes : DeliveryChargeSpecification conserve", villes.includes("DeliveryChargeSpecification"));
check("villes : 404 villes conservees", villes.includes("404 villes"));
check("villes : breadcrumb JSON-LD conserve", villes.includes('id="ld-cities-breadcrumb"'));

/* --------------------------------------------- 6. tronc commun / a11y */
check("global : Or/Bronze #B4833E", css.includes("#B4833E"));
check("global : glassmorphism leger", css.includes("backdrop-filter: blur("));
check("global : RTL", css.includes('[dir="rtl"]'));
check("global : reduced motion", css.includes("prefers-reduced-motion: reduce"));
check("global : reveal partage", css.includes(".sm-reveal") && ui.includes(".sm-reveal"));
check("global : modales / toasts harmonises", css.includes(".modal-close") && css.includes(".toast"));
check("global : espacements compacts intacts", read("index.html").includes("spacing.18d35167.css"));
check("global : calendrier 11 evenements intact", read("js/events-calendar.js").includes("2179") && read("js/events-calendar.js").includes("722"));
check("global : regles Firestore intactes", fs.existsSync(path.join(ROOT, "firestore.rules")) && read("firestore.rules").includes("match /products"));

/* --------------------------------------------- resultat */
console.log(`\n${verifications - echecs}/${verifications} verifications reussies.`);
if (echecs > 0) {
  console.error(`${echecs} echec(s).`);
  process.exit(1);
}
