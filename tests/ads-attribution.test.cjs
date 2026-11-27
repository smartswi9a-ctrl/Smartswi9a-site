/* ============================================================
   tests/ads-attribution.test.cjs
   GARDE-FOU — SUIVI PERFORMANCE PUBLICITAIRE TikTok & Meta
   (module 2026-11-26)
   ------------------------------------------------------------
   Vérifie sans navigateur :
     1. logique pure d'attribution (source, 7 jours, last-touch
        non-direct, click id type, URL UTM) ;
     2. capture first-party et passerelle fbq / ttq / Firestore ;
     3. intégration vitrine (7 pages) et page produit ;
     4. rattachement `attribution` sur orders + flush checkout ;
     5. règles Firestore (orders, ad_events_daily, config/ads) ;
     6. onglet admin, KPI, tableau et cache-busting v7.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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

const moduleSrc = read("js/ads-attribution.js");
const rules = read("firestore.rules");
const cart = read("js/cart.js");
const productDetail = read("js/product-detail.js");
const adminSrc = read("js/admin-ads.js");
const adminUi = read("js/admin-ui.js");
const adminHtml = read("admin.html");
const adminJs = read("js/admin.js");
const sw = read("firebase-messaging-sw.js");
const pkg = JSON.parse(read("package.json"));
const firebaseJson = JSON.parse(read("firebase.json"));
const firebaseCsp = (() => {
  const block = (firebaseJson.hosting.headers || []).find((entry) =>
    (entry.headers || []).some((header) => header.key === "Content-Security-Policy")
  );
  const header = block && block.headers.find((item) => item.key === "Content-Security-Policy");
  return header ? header.value : "";
})();
const cloudflareCsp = (read("_headers").match(/Content-Security-Policy:\s*([^\r\n]+)/) || [])[1] || "";

function cspDirective(csp, name) {
  const found = String(csp || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(name + " "));
  return found || "";
}

/* --------------------------------------------- 1. surface module */

check("module : clé localStorage swi9a_attribution", moduleSrc.includes('"swi9a_attribution"'));
check("module : TTL strict 7 jours", moduleSrc.includes("7 * 24 * 60 * 60 * 1000"));
check("module : click ids fbclid / ttclid", moduleSrc.includes('"fbclid"') && moduleSrc.includes('"ttclid"'));
check(
  "module : sources normalisées",
  ["tiktok", "meta", "google", "whatsapp", "direct", "other"].every((s) =>
    moduleSrc.includes(`"${s}"`)
  )
);
check("module : pixels Meta", moduleSrc.includes("connect.facebook.net") && moduleSrc.includes("fbq"));
check("module : pixel TikTok", moduleSrc.includes("analytics.tiktok.com") && moduleSrc.includes("ttq"));
check(
  "module : compteurs ad_events_daily",
  moduleSrc.includes('"ad_events_daily"') && moduleSrc.includes("increment")
);
check(
  "module : 4 événements standardisés",
  ["ViewContent", "AddToCart", "InitiateCheckout", "Purchase"].every((name) =>
    moduleSrc.includes(name)
  )
);
check("module : aucune donnée personnelle (pas de téléphone/email)", !/ip\s*:|user_email/i.test(moduleSrc));

const pages = ["index.html", "koulchi.html", "produit.html", "panier.html", "boutique.html", "blog.html", "villesmaroc.html"];
const missingPages = pages.filter((page) => !read(page).includes("/js/ads-attribution.js?v=3"));
check("vitrine : module présent sur les 7 pages", missingPages.length === 0, missingPages.join(",") || "7 pages");
check(
  "produit : événement smartswika:product-viewed",
  productDetail.includes("smartswika:product-viewed") && productDetail.includes("announceProductView(product)")
);

/* --------------------------------------------- 2. rattachement commande */

check("cart : objet attribution borné", cart.includes("attachOrderAttribution") && cart.includes('updateDoc(doc(db, "orders"'));
check("cart : Timestamp.fromMillis pour landedAt", cart.includes("Timestamp.fromMillis"));
check("cart : flush avant navigation WhatsApp", cart.includes("SmartswikaAds?.flush?.(1200)"));

/* --------------------------------------------- 3. règles Firestore */

check("rules : validation attribution", rules.includes("function validAttribution(attr)"));
check("rules : attribution réservée au propriétaire", rules.includes("hasOnly(['attribution'])"));
check("rules : fenêtre 30 minutes", rules.includes("duration.value(30, 'm')"));
check("rules : compteurs ad_events_daily", rules.includes("match /ad_events_daily/{eventId}"));
check("rules : source énumérée", rules.includes("d.source in ['tiktok', 'meta', 'google', 'whatsapp', 'direct', 'other']"));
check("rules : config/ads admin", rules.includes("match /config/ads {") && rules.includes("validAdsConfig()"));
check("rules : config/ads_public lecture publique", rules.includes("match /config/ads_public {") && rules.includes("allow read: if true;"));

/* --------------------------------------------- 3 bis. CSP pixels */

const TIKTOK_CSP_DOMAINS = [
  "https://analytics.tiktok.com",
  "https://*.tiktok.com",
  "https://*.tiktokw.us",
  "https://*.byteoversea.com",
];
const META_CSP_DOMAINS = ["https://*.facebook.com"];
const META_CONNECT_DOMAINS = ["https://www.facebook.com", "https://*.facebook.com"];
/* connect.facebook.net ne charge que le script : inutile en connect/img/frame.
   Cloudflare ignore silencieusement une ligne `_headers` > 2048 caractères.
   *.facebook.com couvre www.facebook.com : le doublon est retire des directives
   non-connect pour conserver une marge sous la limite Cloudflare. */
const CSP_REQUIRED = {
  "script-src": [...TIKTOK_CSP_DOMAINS, "https://connect.facebook.net", ...META_CSP_DOMAINS],
  "connect-src": [...TIKTOK_CSP_DOMAINS, ...META_CONNECT_DOMAINS],
  "img-src": [...TIKTOK_CSP_DOMAINS, ...META_CSP_DOMAINS],
  "frame-src": [...TIKTOK_CSP_DOMAINS, ...META_CSP_DOMAINS],
};
const CSP_DIRECTIVES = Object.keys(CSP_REQUIRED);

for (const [label, csp] of [
  ["firebase.json", firebaseCsp],
  ["_headers (Cloudflare)", cloudflareCsp],
]) {
  for (const directive of CSP_DIRECTIVES) {
    const value = cspDirective(csp, directive);
    const missing = CSP_REQUIRED[directive].filter((domain) => !value.includes(domain));
    check(
      `CSP ${label} : ${directive} autorise TikTok + Meta`,
      missing.length === 0,
      missing.join(",") || `${CSP_REQUIRED[directive].length} domaines`
    );
  }
}

const cloudflareCspLine = read("_headers")
  .split(/\r?\n/)
  .find((line) => line.includes("Content-Security-Policy:")) || "";
check(
  "_headers : ligne CSP <= 2048 caractères (limite Cloudflare)",
  cloudflareCspLine.length > 0 && cloudflareCspLine.length <= 2048,
  `${cloudflareCspLine.length} caractères`
);

check(
  "CSP : les directives script/connect/img/frame sont présentes",
  CSP_DIRECTIVES.every((directive) =>
    cspDirective(firebaseCsp, directive) && cspDirective(cloudflareCsp, directive)
  )
);

check(
  "pixels : fbq init + PageView après lecture config/ads_public",
  moduleSrc.indexOf('fbq("init"') > -1 &&
    moduleSrc.indexOf('fbq("track", "PageView")') > moduleSrc.indexOf('fbq("init"') &&
    moduleSrc.includes("PUBLIC_ADS_CONFIG") &&
    moduleSrc.includes("data.metaPixelId")
);
check(
  "pixels : ttq.load + ttq.page après lecture config/ads_public",
  moduleSrc.indexOf("window.ttq.load(String(pixelId))") > -1 &&
    moduleSrc.indexOf("window.ttq.page()") > moduleSrc.indexOf("window.ttq.load(String(pixelId))") &&
    moduleSrc.includes("data.tiktokPixelId")
);

/* --------------------------------------------- 4. onglet admin */

check("admin : onglet data-tab=ads", adminHtml.includes('data-tab="ads"'));
check("admin : groupe Marketing / Ventes", adminHtml.includes('data-admin-i18n="groupMarketing"'));
check("admin : panneau tab-ads", adminHtml.includes('id="tab-ads"'));
check("admin : 4 cartes KPI", ["adsKpiOrders", "adsKpiRevenue", "adsKpiNet", "adsKpiRoas"].every((id) => adminHtml.includes(`id="${id}"`)));
check("admin : canvas Chart.js", adminHtml.includes('id="adsChannelChart"'));
check("admin : tableau + cartes", adminHtml.includes('id="adsTableBody"') && adminHtml.includes('id="adsCards"'));
check("admin : générateur UTM", adminHtml.includes('id="adsUtmToggle"') && adminHtml.includes('id="adsUtmCopy"'));
check("admin : chargement dynamique du module", adminJs.includes("admin-ads.js?v=5") && adminJs.includes("initAdsTab"));
check("admin-ui : libellés pub en 3 langues", adminUi.includes("adsColRoas:") && adminUi.includes("adsKpiRoas:"));
check("admin module : ROI net = CA livré - COGS - Livo", adminSrc.includes("revenue - cogs - shipping"));
check("admin module : ROAS réel", adminSrc.includes("roas: spendTotal > 0 ? revenue / spendTotal : null"));
check("admin module : miroir public sans budgets", adminSrc.includes('doc(db, "config", "ads_public")'));
check("admin module : URL UTM paid_social", adminSrc.includes("utm_medium=${medium}") && adminSrc.includes("paid_social"));
check("admin module : cartes mobile", adminSrc.includes("ads-card"));

/* --------------------------------------------- 5. cache / tests */

check("service worker : version sw-2026-11-26-v13", sw.includes("'sw-2026-11-26-v13'"));
check(
  "package.json : suite ads-attribution branchée",
  String(pkg.scripts && pkg.scripts.test).includes("tests/ads-attribution.test.cjs")
);
check(
  "admin : cache-busting admin-ui v7 + admin gallery2026a",
  adminHtml.includes("/js/admin-ui.js?v=7") && adminHtml.includes("/js/admin.js?v=gallery2026a")
);

/* --------------------------------------------- 6. logique pure */

async function main() {
  const mod = await import(pathToFileURL(path.join(ROOT, "js", "ads-attribution.js")).href);
  const now = Date.parse("2026-11-26T12:00:00Z");

  check("pure : normalizeSource tiktok", mod.normalizeSource("tiktok", "") === "tiktok");
  check("pure : normalizeSource instagram -> meta", mod.normalizeSource("instagram", "") === "meta");
  check("pure : normalizeSource Facebook_Ads -> meta", mod.normalizeSource("Facebook_Ads", "") === "meta");
  check("pure : referrer tiktok", mod.normalizeSource("", "https://www.tiktok.com/@shop") === "tiktok");
  check("pure : referrer instagram -> meta", mod.normalizeSource("", "https://instagram.com/p/1") === "meta");
  check("pure : referrer google", mod.normalizeSource("", "https://www.google.com/search") === "google");
  check("pure : referrer whatsapp", mod.normalizeSource("", "https://wa.me/2126") === "whatsapp");
  check("pure : referrer inconnu -> other", mod.normalizeSource("", "https://news.example.com/a") === "other");
  check("pure : sans paramètre -> direct", mod.normalizeSource("", "") === "direct");
  check(
    "pure : navigation interne -> direct",
    mod.normalizeSource("", "https://smartswika.ma/produit?slug=x", "smartswika.ma") === "direct"
  );

  const tt = mod.parseAttribution(
    "?utm_source=tiktok&utm_medium=paid_social&utm_campaign=noel-2026&utm_content=video-a&ttclid=ABC",
    "",
    now
  );
  check("pure : ttclid -> tiktok", tt.source === "tiktok" && tt.clickIdType === "ttclid");
  check("pure : campagne / contenu conservés", tt.campaign === "noel-2026" && tt.content === "video-a");
  check("pure : landedAt horodaté", tt.landedAt === now);

  const fb = mod.parseAttribution("?fbclid=XYZ&utm_campaign=promo", "", now);
  check("pure : fbclid -> meta", fb.source === "meta" && fb.clickIdType === "fbclid");
  check("pure : medium par défaut paid_social", fb.medium === "paid_social");

  const direct = mod.parseAttribution("", "", now);
  check("pure : direct par défaut", direct.source === "direct" && direct.medium === "none");

  check("pure : TTL 6 jours valide", mod.isAttributionExpired({ landedAt: now - 6 * 86400000 }, now) === false);
  check("pure : TTL 8 jours expiré", mod.isAttributionExpired({ landedAt: now - 8 * 86400000 }, now) === true);

  const active = { source: "tiktok", campaign: "noel", landedAt: now - 2 * 86400000 };
  check(
    "pure : last-touch non-direct conservé sur visite directe",
    mod.mergeAttribution(active, direct, now) === active
  );
  const metaIncoming = { source: "meta", campaign: "black-friday", landedAt: now };
  check(
    "pure : nouvelle campagne remplace l'ancienne",
    mod.mergeAttribution(active, metaIncoming, now) === metaIncoming
  );
  const expired = { source: "tiktok", campaign: "vieux", landedAt: now - 8 * 86400000 };
  check(
    "pure : campagne expirée remplacée même par direct",
    mod.mergeAttribution(expired, direct, now) === direct
  );

  const orderAttr = mod.buildOrderAttribution(active, now);
  check(
    "pure : objet commande borné",
    orderAttr.source === "tiktok" &&
      orderAttr.campaign === "noel" &&
      orderAttr.clickIdType === null &&
      orderAttr.landedAt === active.landedAt
  );
  const fallback = mod.buildOrderAttribution(null, now);
  check(
    "pure : défaut direct sans campagne",
    fallback.source === "direct" && fallback.campaign === "" && fallback.clickIdType === null
  );

  check("pure : eventDocId", mod.eventDocId("2026-11-26", "meta") === "2026-11-26_meta");
  check("pure : eventDocId source invalide -> direct", mod.eventDocId("2026-11-26", "spam") === "2026-11-26_direct");
  check("pure : dayKey", mod.dayKey(new Date(2026, 10, 26)) === "2026-11-26");

  const url = mod.buildUtmUrl("tiktok", "Promo Noël 2026");
  check(
    "pure : URL UTM TikTok",
    url === "https://www.smartswika.ma/?utm_source=tiktok&utm_medium=paid_social&utm_campaign=promo-noel-2026",
    url
  );
  check(
    "pure : URL UTM Meta",
    mod.buildUtmUrl("meta", "Black Friday").includes("utm_source=meta&utm_medium=paid_social")
  );
  check(
    "pure : URL UTM campagne vide -> campagne",
    mod.buildUtmUrl("tiktok", "").endsWith("utm_campaign=campagne")
  );

  console.log(`\n${verifications - echecs}/${verifications} vérifications réussies.`);
  if (echecs > 0) {
    console.error(`${echecs} échec(s).`);
    process.exit(1);
  }

}

main().catch((error) => {
  console.error("ECHEC: import du module ads-attribution ->", error && error.message);
  process.exit(1);
});


