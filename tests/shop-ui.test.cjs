/* ============================================================
   tests/shop-ui.test.cjs
   GARDE-FOU — vitrine moderne (accueil / Koulchi / blog)
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

const index = read("index.html");
const koulchi = read("koulchi.html");
const blog = read("blog.html");
const shopI18n = read("js/shop-i18n.js");
const shopUi = read("js/shop-ui.js");
const products = read("js/products.js");
const blogJs = read("js/blog.js");
const css = read("css/shop-modern.css");
const pageJs = read("js/koulchi-page.js");

/* --------------------------------------------- 1. dictionnaire */
function extractDictKeys(lang) {
  const marker = "\n  " + lang + ": {";
  const start = shopI18n.indexOf(marker);
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = shopI18n.indexOf("{", start); i < shopI18n.length; i++) {
    if (shopI18n[i] === "{") depth++;
    else if (shopI18n[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const block = shopI18n.slice(start, end);
  return [...block.matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
}

const frKeys = extractDictKeys("fr");
const enKeys = extractDictKeys("en");
const arKeys = extractDictKeys("ar");
check("shop-i18n : dictionnaire FR non vide", frKeys.length > 60, frKeys.length + " cles");
check(
  "shop-i18n : parite FR / EN / AR",
  frKeys.length === enKeys.length && frKeys.length === arKeys.length,
  `fr=${frKeys.length} en=${enKeys.length} ar=${arKeys.length}`
);
check("shop-i18n : cles FR presentes en EN", frKeys.every((k) => enKeys.includes(k)));
check("shop-i18n : cles FR presentes en AR", frKeys.every((k) => arKeys.includes(k)));

/* --------------------------------------------- 1bis. badge vendeur */
function extractValue(lang, key) {
  const marker = "\n  " + lang + ": {";
  const start = shopI18n.indexOf(marker);
  if (start < 0) return null;
  const end = shopI18n.indexOf("\n  },", start);
  const block = shopI18n.slice(start, end > start ? end : undefined);
  const match = block.match(new RegExp("^\\s{4}" + key + ":\\s*\"([^\"]*)\"", "m"));
  return match ? match[1] : null;
}

const vendorSep = {
  fr: extractValue("fr", "badgeVendorSep"),
  en: extractValue("en", "badgeVendorSep"),
  ar: extractValue("ar", "badgeVendorSep"),
};
check(
  "badgeVendor : separateur « · » en FR / EN / AR",
  ["fr", "en", "ar"].every((lang) => vendorSep[lang] === " · "),
  JSON.stringify(vendorSep)
);

const vendorBadge = {
  fr: extractValue("fr", "badgeVendor") || "",
  en: extractValue("en", "badgeVendor") || "",
  ar: extractValue("ar", "badgeVendor") || "",
};
check(
  "badgeVendor : garantie 7j en fin de libelle (FR / EN / AR)",
  vendorBadge.fr.endsWith("Garantie 7j") &&
    vendorBadge.en.endsWith("7-day warranty") &&
    vendorBadge.ar.endsWith("ضمان 7 أيام"),
  JSON.stringify(vendorBadge)
);
check(
  "badgeVendor : separateur insere avant le nom de la boutique",
  (products.match(/\$\{vendorSep\}/g) || []).length === 2 &&
    products.includes("shop-origin-sep") &&
    css.includes(".shop-origin-sep")
);

const usedKeys = [...new Set([
  ...[...index.matchAll(/data-shop-i18n="([A-Za-z0-9_]+)"/g)].map((m) => m[1]),
  ...[...index.matchAll(/data-shop-i18n-aria="([A-Za-z0-9_]+)"/g)].map((m) => m[1]),
])];
const missing = usedKeys.filter((key) => !frKeys.includes(key));
check("shop-i18n : cles data-shop-i18n resolues", missing.length === 0, missing.join(","));

/* --------------------------------------------- 2. HTML */
const criticalIds = [
  "shopStats",
  "shopQuickFilters",
  "koulchiExperience",
  "homeBlogGrid",
  "productsGrid",
  "blogThemes",
  "blogReadingProgress",
  "blogArticleModal",
];
for (const file of [["index.html", index], ["koulchi.html", koulchi], ["blog.html", blog]]) {
  const ids = [...file[1].matchAll(/(?<![\w-])id="([^"]+)"/g)].map((m) => m[1]);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  check(file[0] + " : aucun ID duplique", duplicates.length === 0, duplicates.join(","));
}
const indexIds = [...index.matchAll(/(?<![\w-])id="([^"]+)"/g)].map((m) => m[1]);
const indexContainers = ["shopStats", "shopQuickFilters", "koulchiVitrine", "homeBlogGrid", "productsGrid"];
check(
  "accueil : conteneurs modernes presents",
  indexContainers.every((id) => indexIds.includes(id))
);
check("accueil : vitrine Koulchi a gauche des Ventes Flash", index.includes('id="koulchiVitrine"') && index.includes('id="flashSection"'));
check("accueil : simulateur Koulchi retire", !index.includes("data-koulchi-simulator"));
check("koulchi : simulateur present", koulchi.includes("data-koulchi-simulator"));
check("blog : themes + progression presents", blog.includes('id="blogThemes"') && blog.includes('id="blogReadingProgress"'));
check("pages : CSS moderne charge", index.includes("shop-modern.css") && koulchi.includes("shop-modern.css") && blog.includes("shop-modern.css"));
check("accueil : script shop-ui charge", index.includes("/js/shop-ui.js"));
check("koulchi : script shop-ui charge", koulchi.includes("/js/shop-ui.js"));
check("blog : script shop-ui charge", blog.includes("/js/shop-ui.js"));

/* --------------------------------------------- 3. CSS / responsivite */
check("CSS : grille produits 4 colonnes", css.includes("grid-template-columns: repeat(4, minmax(0, 1fr))"));
check("CSS : tablette/mobile 2 colonnes", css.includes("@media (max-width: 1023px)") && css.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"));
check("CSS : blog 3 / 2 / 1 colonnes", css.includes(".shop-blog-grid") && css.includes("@media (max-width: 767px)"));
check("CSS : simulateur compact 3 lignes", css.includes(".koulchi-sim-row--head") && css.includes(".koulchi-sim-row--bar") && css.includes(".koulchi-sim-row--summary"));
/* Duo jumeau : la grille doit rester en 2 colonnes sur mobile (390 px),
   tablette (768 px) ET desktop (1366 px) — jamais d empilement, jamais de
   carte pleine largeur. Les deux cartes partagent la classe .duo-card. */
const duoCss = (() => {
  const start = css.indexOf(".promo-duo {");
  const end = css.indexOf("#promoDuo .duo-card");
  return start >= 0 && end > start ? css.slice(start, end) : "";
})();

check(
  "CSS : duo toujours en 2 colonnes cote a cote",
  /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(duoCss) &&
    !/grid-template-columns:\s*minmax\(0,\s*1fr\);/.test(duoCss),
  duoCss ? "bloc duo trouve" : "bloc duo introuvable"
);
check(
  "CSS : gaps duo 8 px mobile / 14 px tablette / 16 px desktop",
  /gap:\s*8px/.test(duoCss) &&
    /@media \(min-width: 768px\)[\s\S]{0,80}gap:\s*14px/.test(duoCss) &&
    /@media \(min-width: 1024px\)[\s\S]{0,80}gap:\s*16px/.test(duoCss)
);
check(
  "CSS : aucun etat pleine largeur (is-single neutralise en 2 colonnes)",
  /\.promo-duo\.is-single,[\s\S]{0,160}grid-template-columns:\s*repeat\(2,/.test(css)
);
check(
  "CSS : cartes jumelles — meme skin .duo-card (bordure, rayon, fond, hauteur)",
  css.includes("#promoDuo .duo-card") &&
    css.includes("justify-content: space-between") &&
    css.includes("height: 100%") &&
    css.includes("border-radius: 16px")
);
check(
  "CSS : miniatures 1:1 (2 mobile/tablette, 3 desktop)",
  css.includes("aspect-ratio: 1 / 1") &&
    css.includes("#promoDuo .duo-thumb:nth-child(3) { display: none; }") &&
    css.includes("#promoDuo .duo-thumb:nth-child(3) { display: block; }")
);
check(
  "CSS : titre duo court clamp(0.85rem, 2.5vw, 1.15rem)",
  css.includes("clamp(0.85rem, 2.5vw, 1.15rem)")
);
check(
  "accueil : carte Ventes Flash toujours affichee (plus de hidden)",
  !/<section class="section flash-hero"[^>]*\shidden/.test(index) &&
    index.includes('class="flash-hero-inner duo-card"')
);
check(
  "accueil : les deux cartes portent .duo-card",
  index.includes('class="flash-hero-inner duo-card"') &&
    pageJs.includes("koulchi-vitrine-card duo-card")
);
check(
  "ventes flash : etat vide harmonise sans masquer la section",
  read("js/flash-sales.js").includes("renderFlashPlaceholders") &&
    !read("js/flash-sales.js").includes("section.hidden = true")
);
check(
  "promo-duo : aucun passage en pleine largeur",
  !read("js/promo-duo.js").includes('toggle("is-single"') &&
    read("js/promo-duo.js").includes("classList.remove(\"is-single\")")
);
check("CSS : image produit ratio 1:1", css.includes("aspect-ratio: 1 / 1"));
check("CSS : zoom 1.05", css.includes("scale(1.05)"));
check("CSS : reveal + reduced motion", css.includes(".shop-reveal") && css.includes("prefers-reduced-motion: reduce"));
check("CSS : glassmorphism badges", css.includes("backdrop-filter: blur(10px)"));
check("CSS : zones tactiles 44px", css.includes("min-height: 44px"));
check("CSS : RTL", css.includes('[dir="rtl"]'));
check("espacements compacts preserves", index.includes("spacing.18d35167.css") && fs.existsSync(path.join(ROOT, "css/spacing.18d35167.css")));
/* --------------------------------------------- 3 bis. cache / i18n duo */
check("cache-busting : shop-modern.css?v=5", index.includes("/css/shop-modern.css?v=5"));
check(
  "cache-busting : koulchi-page.js?v=3 + promo-duo.js?v=4",
  index.includes("/js/koulchi-page.js?v=3") && index.includes("/js/promo-duo.js?v=4")
);
check(
  "cache-busting : SW_VERSION incremente",
  read("firebase-messaging-sw.js").includes("sw-2026-11-26-v13")
);
check(
  "duo : garde-fou cache (ancienne vente flash `hidden` neutralisee)",
  css.includes("#promoDuo #flashSection[hidden] { display: block; }") &&
    read("js/promo-duo.js").includes("if (flash && flash.hidden) flash.hidden = false;")
);
check(
  "duo : pastille compte a rebours masquee sans vente active",
  css.includes('#promoDuo #flashSection[data-flash-count="0"] .flash-duo-timer { display: none; }') &&
    index.includes('id="flashSection" aria-labelledby="flashTitle" data-flash-count="0"')
);

const translationsSrc = read("translations.js");
check(
  "i18n : cles duo flash presentes en FR / EN / AR",
  ["flashEmpty", "flashCta", "flashNonCumul"].every(
    (key) => (translationsSrc.match(new RegExp("\\b" + key + ":", "g")) || []).length === 3
  )
);



/* --------------------------------------------- 4. tri / produits */
check("produits : tri relevance conserve", products.includes("sortByRelevance(list, getRankingSnapshot())"));
check("produits : ventes flash conservees", products.includes("applyFlashSales"));
check("produits : filtres rapides ajoutes", products.includes('quick === "flash"') && products.includes('quick === "vendors"'));
check("produits : badge Smartswika", products.includes('shopT("badgeSmart")'));
check("produits : badge vendeur verifie", products.includes('shopT("badgeVendor")'));
check("produits : bouton WhatsApp", products.includes("shop-wa-btn") && products.includes("wa.me/212656613303"));
check("produits : etat vide elegant", products.includes("shop-catalog-empty") && products.includes("catalogPreparingTitle"));
check("produits : feedback Ajoute", read("js/events.js").includes('shopT("shopAdded")'));
check("module passif product_views intact", read("js/retargeting.js").includes("product_views"));
check("rotation 10:1 intacte", fs.existsSync(path.join(ROOT, "functions/rotation-core.js")) && read("functions/rotation-core.js").includes("10:1"));

/* --------------------------------------------- 5. Koulchi / blog */
check("simulateur : 3 paliers", shopUi.includes("data-sim-qty") && shopUi.includes("koulchiPercentFor"));
check(
  "vitrine : 3 paliers + CTA vers la page Koulchi",
  pageJs.includes("koulchi-vitrine-tier") &&
    pageJs.includes("koulchiVitrineCta") &&
    pageJs.includes('class="koulchi-vitrine-cta" href="/koulchi.html"')
);
check("vitrine : visuel d appel si catalogue vide", pageJs.includes("koulchi-vitrine-empty") && pageJs.includes("koulchiVitrineEmpty"));
check("simulateur : progression animee", css.includes(".koulchi-sim-progress") && css.includes("transition: width 350ms"));
check("simulateur : exclusion ventes flash", shopI18n.includes("koulchiFlashExcluded"));
check("blog : hero card", blogJs.includes("blog-hero-card") && css.includes(".blog-hero-card"));
check("blog : filtres thematiques", blogJs.includes("renderBlogThemes") && blogJs.includes("matchesBlogTheme"));
check("blog : temps de lecture", blogJs.includes("blogReadTime"));
check("blog : barre de progression", blogJs.includes("updateBlogReadingProgress") && css.includes(".blog-reading-progress"));
check("blog : deep-link article", blogJs.includes('get("article")'));
check("accueil : apercu blog", index.includes("homeBlogGrid") && shopUi.includes("initHomeBlogPreview"));
check("accueil : compteurs 404 / 24-72h / 15j / 7-7", index.includes('data-shop-count="404"') && index.includes('data-shop-count="24"') && index.includes('data-shop-count="15"') && index.includes('data-shop-count="7"'));
check("calendrier : dimensions 2179x722 intactes", read("js/events-calendar.js").includes("2179") && read("js/events-calendar.js").includes("722"));

/* --------------------------------------------- resultat */
console.log(`\n${verifications - echecs}/${verifications} verifications reussies.`);
if (echecs > 0) {
  console.error(`${echecs} echec(s).`);
  process.exit(1);
}
