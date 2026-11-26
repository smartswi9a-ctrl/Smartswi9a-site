/* ============================================================
   tests/ads-automation.test.cjs
   GARDE-FOU — AUTOMATISATION PUBLICITAIRE META & TIKTOK
   ------------------------------------------------------------
   Vérifie sans navigateur :
     1. Flux catalogue XML + rewrite hosting/Cloudflare ;
     2. scoring COD produits officiels Smartswika ;
     3. lien promo UTM dashboard vendeur ;
     4. Cloud Functions sécurisées Meta/TikTok + secrets ;
     5. UI admin 4 blocs + parité trilingue ;
     6. règles Firestore, CSP <= 2048 et cache-busting v9.
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

const functionsJs = read("functions/index.js");
const firebaseJson = JSON.parse(read("firebase.json"));
const redirects = read("_redirects");
const rules = read("firestore.rules");
const adminHtml = read("admin.html");
const adminAds = read("js/admin-ads.js");
const adminUi = read("js/admin-ui.js");
const adsAttribution = read("js/ads-attribution.js");
const productDetail = read("js/product-detail.js");
const vendorUi = read("js/vendor-ui.js");
const vendorDashboard = read("js/vendor-dashboard.js");
const vendorHtml = read("vendor/dashboard.html");
const sw = read("firebase-messaging-sw.js");
const headers = read("_headers");
const pkg = JSON.parse(read("package.json"));

/* --------------------------------------------- 1. flux catalogue */

check("feed : fonction productCatalogFeed", functionsJs.includes("exports.productCatalogFeed"));
check(
  "feed : produits approuves + stock > 0",
  functionsJs.includes("where('status', '==', 'approved')") &&
    functionsJs.includes("stock > 0")
);
check(
  "feed : filtre officiel Smartswika",
  functionsJs.includes("isOfficialSmartswikaProduct") &&
    functionsJs.includes("OFFICIAL_PRODUCT_VENDOR_IDS")
);
for (const tag of [
  "g:id",
  "g:title",
  "g:description",
  "g:link",
  "g:image_link",
  "g:availability>in stock",
  "g:price",
  "g:brand>Smartswika",
  "g:condition>new",
]) {
  check("feed : balise " + tag, functionsJs.includes(tag));
}
check("feed : RSS 2.0 + namespace Google", functionsJs.includes("<rss version=\"2.0\"") && functionsJs.includes("xmlns:g="));
check("feed : cache 15 minutes", functionsJs.includes("public, max-age=900"));
check(
  "feed : rewrite Firebase /feed/products.xml",
  JSON.stringify(firebaseJson.hosting.rewrites).includes("/feed/products.xml") &&
    JSON.stringify(firebaseJson.hosting.rewrites).includes("productCatalogFeed")
);
check(
  "feed : redirection Cloudflare _redirects 302",
  redirects.includes("/feed/products.xml") &&
    redirects.includes("productCatalogFeed") &&
    redirects.includes("productCatalogFeed 302")
);

/* --------------------------------------------- 2. verification domaine */

const indexHtml = read("index.html");
check(
  "index.html : balise Meta Domain Verification statique",
  indexHtml.includes(
    '<meta name="facebook-domain-verification" content="i3b08s06nqz1o92nawa1kfrum7qiaq" />'
  )
);
check(
  "ads : injection meta facebook-domain-verification",
  adsAttribution.includes("facebook-domain-verification") &&
    adsAttribution.includes("metaDomainVerification")
);
check("produit : support ?id= pour liens feed/vendeur", productDetail.includes("params.get(\"id\")"));

/* --------------------------------------------- 3. moteur scoring */

check("scoring : filtre produits officiels", adminAds.includes("isOfficialProduct") && adminAds.includes("officialProducts"));
check("scoring : marge nette - Livo", adminAds.includes("price - purchase - livoFee"));
check("scoring : product_views", adminAds.includes("product_views") && adminAds.includes("viewCount"));
check("scoring : taux COD commandes", adminAds.includes("productOrderStats") && adminAds.includes("deliveryRate"));
check("scoring : score /100", adminAds.includes("marginScore + interestScore + codScore"));
check(
  "scoring : badges gagnant / marge / potentiel",
  adminAds.includes("adsBadgeWinning") &&
    adminAds.includes("adsBadgeHighMargin") &&
    adminAds.includes("adsBadgeStrong")
);
check("scoring : Top 5", adminAds.includes(".slice(0, 5)"));
check("scoring : budget quotidien suggere", adminAds.includes("suggestedDailyBudget"));
check("scoring : copie FR/EN/AR", adminAds.includes("buildAdCopy") && adminAds.includes("Paiement à la livraison"));
check(
  "scoring : UTM auto_{productId}",
  adminAds.includes("utm_campaign=auto_") && adminAds.includes("utm_medium=paid_social")
);
check(
  "scoring : etat guide carrousel si moins de 3 produits",
  adminAds.includes("adsCarouselGuideTitle") &&
    adminAds.includes("adsCarouselGuideDesc") &&
    adminAds.includes("scoredProducts.length < CAROUSEL_MIN_PRODUCTS")
);

/* --------------------------------------------- 4. vendeur */

check(
  "vendeur : bouton Copier lien pub",
  vendorDashboard.includes("data-promo-product") && vendorDashboard.includes("copyAdLink")
);
check(
  "vendeur : URL promo vendor_{vendorId}",
  vendorDashboard.includes("utm_source=vendor_") &&
    vendorDashboard.includes("utm_medium=social") &&
    vendorDashboard.includes("utm_campaign=vendor_promo")
);
check(
  "vendeur : notification FR/EN/AR",
  ["copyAdLink", "adLinkCopied", "adLinkCopyFailed"].every((key) =>
    (vendorUi.match(new RegExp(key + ":", "g")) || []).length >= 3
  )
);
check(
  "vendeur : versions cache-busting",
  vendorHtml.includes("/js/vendor-ui.js?v=2") &&
    vendorHtml.includes("/js/vendor-dashboard.js?v=20261126-ads")
);

/* --------------------------------------------- 5. Cloud Functions API */

check("api : import onCall + HttpsError", functionsJs.includes("onCall") && functionsJs.includes("HttpsError"));
check("api : launchSuggestedAdCampaign", functionsJs.includes("exports.launchSuggestedAdCampaign"));
check("api : toggleAdCampaignStatus", functionsJs.includes("exports.toggleAdCampaignStatus"));
check("api : testAdPlatformConnection", functionsJs.includes("exports.testAdPlatformConnection"));
check("api : admin obligatoire", functionsJs.includes("requireAdminCallable"));
check("api : produit officiel verifie serveur", functionsJs.includes("Only official Smartswika products"));
check("api : Meta Graph v21.0", functionsJs.includes("META_GRAPH_VERSION = 'v21.0'") && functionsJs.includes("graph.facebook.com"));
check("api : TikTok Business v1.3", functionsJs.includes("business-api.tiktok.com/open_api/v1.3"));
check("api : ciblage Maroc MA", functionsJs.includes("countries: ['MA']") && functionsJs.includes("TIKTOK_LOCATION_MA = '2252422'"));
check("api : campagne + adset Meta", functionsJs.includes("/campaigns") && functionsJs.includes("/adsets"));
check("api : campagne + adgroup TikTok", functionsJs.includes("/campaign/create/") && functionsJs.includes("/adgroup/create/"));
check("api : pause/activation", functionsJs.includes("/campaign/status/update/") && functionsJs.includes("PAUSED"));
check("api : mode preparation sans tokens", functionsJs.includes("tokens_not_configured") && functionsJs.includes("mode: campaigns.length"));
check("api : ad_campaigns ecrit par Function", functionsJs.includes("AD_CAMPAIGNS_COLLECTION") && functionsJs.includes("createdBy: adminUid"));
check("api : secrets jamais publics", functionsJs.includes("ADS_SECRETS_DOC") && rules.includes("match /config/ads_secrets"));
check("api : URL destination bornee", functionsJs.includes("ADS_ALLOWED_HOSTS") && functionsJs.includes("sanitizeUrl"));
check(
  "carrousel : callable launchMultiProductCarouselCampaign",
  functionsJs.includes("exports.launchMultiProductCarouselCampaign")
);
check(
  "carrousel : validation tableau 3 a 20 produits",
  functionsJs.includes("Array.isArray(data.productIds)") &&
    functionsJs.includes("CAROUSEL_MIN_PRODUCTS = 3") &&
    functionsJs.includes("CAROUSEL_MAX_PRODUCTS = 20") &&
    functionsJs.includes("productIds.length < CAROUSEL_MIN_PRODUCTS") &&
    functionsJs.includes("productIds.length > CAROUSEL_MAX_PRODUCTS")
);
check(
  "carrousel : refus produit vendeur tiers / non approuve",
  functionsJs.includes("Only official Smartswika products can be used in a carousel") &&
    functionsJs.includes("Product must be approved and in stock")
);
check(
  "carrousel : creation Meta campaign + adset + creative + ad",
  functionsJs.includes("createMetaCarouselCampaign") &&
    functionsJs.includes("child_attachments") &&
    functionsJs.includes("object_story_spec") &&
    functionsJs.includes("/adcreatives") &&
    functionsJs.includes("act_' + account + '/ads")
);
check(
  "carrousel : maximum 10 cartes Meta",
  functionsJs.includes("META_CAROUSEL_MAX_CARDS = 10") &&
    functionsJs.includes("slice(0, META_CAROUSEL_MAX_CARDS)")
);
check(
  "carrousel : TikTok Maroc + mode prepare URLs",
  functionsJs.includes("TIKTOK_LOCATION_MA") &&
    functionsJs.includes("productUrls") &&
    functionsJs.includes("utm_campaign=carousel_")
);
check(
  "carrousel : Firestore type carousel + 20 produits",
  functionsJs.includes("type: 'carousel'") &&
    functionsJs.includes("productIds,") &&
    functionsJs.includes("productCount: productIds.length") &&
    functionsJs.includes("utmCampaign: 'carousel_' + campaignSlug")
);

/* --------------------------------------------- 6. admin UI */

check(
  "admin : importmap firebase/functions",
  adminHtml.includes('"firebase/functions"') && adminHtml.includes("firebase-functions.js")
);
for (const id of [
  "adsSuggestions",
  "adsCampaigns",
  "adsMetaDomainVerification",
  "adsMetaAdAccountId",
  "adsMetaPageId",
  "adsMetaAccessToken",
  "adsTiktokAdvertiserId",
  "adsTiktokAccessToken",
  "adsTestMeta",
  "adsTestTiktok",
  "adsFeedCopy",
  "adsFeedStatus",
]) {
  check("admin : champ " + id, adminHtml.includes(`id="${id}"`));
}
check(
  "admin : 4 blocs (KPI, suggestions, campagnes, config)",
  adminHtml.includes('id="adsKpis"') &&
    adminHtml.includes("adsSuggestionsTitle") &&
    adminHtml.includes("adsCampaignsTitle") &&
    adminHtml.includes("adsConfigDetails")
);
check("admin : flux URL", adminHtml.includes("https://www.smartswika.ma/feed/products.xml"));
check(
  "carrousel admin : builder 3 a 20 + top 10",
  adminAds.includes("renderCarouselBuilder") &&
    adminAds.includes("CAROUSEL_MIN_PRODUCTS = 3") &&
    adminAds.includes("CAROUSEL_MAX_PRODUCTS = 20") &&
    adminAds.includes("CAROUSEL_TOP_COUNT = 10") &&
    adminAds.includes("data-carousel-top10")
);
check(
  "carrousel admin : compteur, apercu horizontal, copies FR/EN/AR",
  adminAds.includes("data-carousel-counter") &&
    adminAds.includes("data-carousel-preview") &&
    adminAds.includes('["fr", "en", "ar"].map(copyField)') &&
    adminAds.includes("carouselCampaignUrl") &&
    adminAds.includes("utm_campaign=carousel_") &&
    adminAds.includes("utm_content=")
);
check(
  "carrousel admin : lancement callable",
  adminAds.includes('launchMultiProductCarouselCampaign') &&
    adminAds.includes("launchCarouselCampaign")
);
check(
  "carrousel admin : cartes dans Mes Campagnes",
  adminAds.includes('campaign.type === "carousel"') &&
    adminAds.includes("adsCarouselTypeBadge") &&
    adminAds.includes("adsCarouselProductsShort")
);
check("admin : appels callables", adminAds.includes("launchSuggestedAdCampaign") && adminAds.includes("toggleAdCampaignStatus") && adminAds.includes("testAdPlatformConnection"));
check("admin : alerte COD", adminAds.includes("adsCodAlert") && adminAds.includes("total > 10 && rate < 45"));
check("admin : secrets masques", adminHtml.includes('type="password" id="adsMetaAccessToken"') && adminHtml.includes('type="password" id="adsTiktokAccessToken"'));
function adminDictKeys(lang) {
  const marker = "\n  " + lang + ": {";
  const start = adminUi.indexOf(marker);
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = adminUi.indexOf("{", start); i < adminUi.length; i++) {
    if (adminUi[i] === "{") depth++;
    else if (adminUi[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  return [...adminUi.slice(start, end).matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
}

const adminFr = adminDictKeys("fr");
const adminEn = adminDictKeys("en");
const adminAr = adminDictKeys("ar");
const usedAdsKeys = [
  ...new Set(
    [
      ...adminHtml.matchAll(/data-admin-i18n(?:-placeholder)?="(ads[A-Za-z0-9]+)"/g),
      ...adminAds.matchAll(/(?:adminT|adsT)\(['"](ads[A-Za-z0-9]+)['"]\)/g),
    ].map((match) => match[1])
  ),
].sort();
check(
  "admin : parite stricte FR / EN / AR",
  adminFr.length === adminEn.length && adminFr.length === adminAr.length,
  `fr=${adminFr.length} en=${adminEn.length} ar=${adminAr.length}`
);
check(
  "admin : toutes les cles ads* utilisees existent en FR / EN / AR",
  usedAdsKeys.every(
    (key) =>
      adminFr.includes(key) && adminEn.includes(key) && adminAr.includes(key)
  ),
  usedAdsKeys.length + " cles"
);
check(
  "admin : aucune cle ads* brute visible dans le HTML",
  !/>\s*ads[A-Z][A-Za-z0-9]+\s*</.test(adminHtml)
);
const carouselI18nKeys = usedAdsKeys.filter((key) =>
  key.startsWith("adsCarousel")
);
check(
  "carrousel : parite i18n FR / EN / AR",
  carouselI18nKeys.length >= 20 &&
    carouselI18nKeys.every(
      (key) =>
        adminFr.includes(key) && adminEn.includes(key) && adminAr.includes(key)
    ),
  carouselI18nKeys.length + " cles"
);
check(
  "admin : i18n suggestions/campagnes en 3 langues",
  ["adsSuggestionsTitle:", "adsCampaignsTitle:", "adsLaunchNow:", "adsCodAlert:"].every(
    (key) => (adminUi.match(new RegExp(key, "g")) || []).length === 3
  )
);
check("admin : cache-busting v6 / ads2026c4", adminHtml.includes("/js/admin-ui.js?v=6") && adminHtml.includes("/js/admin.js?v=ads2026c4"));
check("admin : module ads v4", read("js/admin.js").includes("admin-ads.js?v=4"));

/* --------------------------------------------- 7. regles Firestore */

check("rules : config/ads_secrets admin only", rules.includes("match /config/ads_secrets") && rules.includes("validAdsSecrets()"));
check("rules : ad_campaigns lecture admin seule", rules.includes("match /ad_campaigns/{campaignId}") && rules.includes("allow create, update, delete: if false;"));
check(
  "rules : metaDomainVerification public",
  rules.includes("metaDomainVerification") && rules.includes("validAdsPublic()")
);

/* --------------------------------------------- 8. CSP / versions */

const cspLine = headers.split(/\r?\n/).find((line) => line.includes("Content-Security-Policy:")) || "";
check("CSP : ligne _headers <= 2048", cspLine.length > 0 && cspLine.length <= 2048, `${cspLine.length} caracteres`);
check(
  "CSP : domaines TikTok/Meta",
  ["analytics.tiktok.com", "*.tiktok.com", "*.tiktokw.us", "*.byteoversea.com", "connect.facebook.net", "*.facebook.com"].every(
    (domain) => cspLine.includes(domain)
  )
);
check("cache : SW v12", sw.includes("'sw-2026-11-26-v12'"));
check(
  "cache : ads-attribution v3 sur les 7 pages",
  ["index.html", "koulchi.html", "produit.html", "panier.html", "boutique.html", "blog.html", "villesmaroc.html"].every(
    (page) => read(page).includes("/js/ads-attribution.js?v=3")
  )
);
check("cache : cart import ads v3", read("js/cart.js").includes("./ads-attribution.js?v=3"));
check(
  "package.json : suite ads-automation branchee",
  String(pkg.scripts && pkg.scripts.test).includes("tests/ads-automation.test.cjs")
);

console.log(`\n${verifications - echecs}/${verifications} verifications reussies.`);
if (echecs > 0) {
  console.error(`${echecs} echec(s).`);
  process.exit(1);
}

