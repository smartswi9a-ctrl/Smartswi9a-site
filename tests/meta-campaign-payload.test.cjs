/* ============================================================
   tests/meta-campaign-payload.test.cjs
   GARDE-FOU — PAYLOAD META GRAPH (creation de campagne) + EDITEUR CARROUSEL
   ------------------------------------------------------------
   Execute reellement createMetaCampaign() extrait de functions/index.js
   avec un metaGraphRequest simule, puis verifie :
     1. is_adset_budget_sharing_enabled=false quand le budget est ABO ;
     2. absence de budget de campagne en ABO, budget correct sur l ad set ;
     3. mode CBO (campagne budgétée) sans le flag ABO et sans budget ad set ;
     4. statut PAUSED (mode "Lancer en pause") transmis aux deux objets ;
     5. js/admin-ads.js : carouselSelectedProducts() definie et utilisee.
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

/* Extrait une fonction (sync ou async) du source par appariement d accolades. */
function extractAsyncFunction(source, name) {
  let start = source.indexOf("async function " + name + "(");
  if (start < 0) start = source.indexOf("function " + name + "(");
  if (start < 0) return null;
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

async function main() {
  const functionsSource = read("functions/index.js");
  const body = extractAsyncFunction(functionsSource, "createMetaCampaign");
  check("meta : createMetaCampaign extraite", Boolean(body));

  const calls = [];
  const factory = new Function(
    "metaGraphRequest",
    "metaAdsManagerUrl",
    body + "\nreturn createMetaCampaign;"
  );
  const createMetaCampaign = factory(
    async (apiPath, method, payload) => {
      calls.push({ apiPath: apiPath, method: method, payload: payload });
      return { id: String(calls.length) };
    },
    () => "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=x"
  );

  /* --- 1. ABO : budget au niveau ad set (mono-produit SinoTrack ST-901M) --- */
  await createMetaCampaign({
    accountId: "act_123",
    token: "tok",
    campaignName: "Smartswika SinoTrack ST-901M",
    dailyBudgetMad: 80,
    startPaused: true,
  });
  const campaign = calls[0] || {};
  const adset = calls[1] || {};
  check("meta : POST act_123/campaigns", campaign.apiPath === "act_123/campaigns", campaign.apiPath);
  check(
    "meta : is_adset_budget_sharing_enabled=false",
    Boolean(campaign.payload) && campaign.payload.is_adset_budget_sharing_enabled === false,
    JSON.stringify(campaign.payload && campaign.payload.is_adset_budget_sharing_enabled)
  );
  check(
    "meta : aucun budget de campagne en ABO",
    Boolean(campaign.payload) &&
      campaign.payload.daily_budget === undefined &&
      campaign.payload.lifetime_budget === undefined
  );
  check(
    "meta : campagne PAUSED",
    Boolean(campaign.payload) && campaign.payload.status === "PAUSED",
    String(campaign.payload && campaign.payload.status)
  );
  check(
    "meta : special_ad_categories tableau",
    Boolean(campaign.payload) && Array.isArray(campaign.payload.special_ad_categories)
  );
  check(
    "meta : adset daily_budget 8000",
    Boolean(adset.payload) && adset.payload.daily_budget === 8000,
    String(adset.payload && adset.payload.daily_budget)
  );
  check(
    "meta : adset PAUSED",
    Boolean(adset.payload) && adset.payload.status === "PAUSED",
    String(adset.payload && adset.payload.status)
  );

  /* --- 2. CBO : budget au niveau campagne --- */
  calls.length = 0;
  await createMetaCampaign({
    accountId: "act_9",
    token: "tok",
    campaignName: "Carrousel Smartswika",
    dailyBudgetMad: 50,
    campaignDailyBudgetMad: 120,
    startPaused: false,
  });
  const cbo = calls[0] || {};
  const cboAdset = calls[1] || {};
  check(
    "meta CBO : daily_budget campagne 12000",
    Boolean(cbo.payload) && cbo.payload.daily_budget === 12000,
    String(cbo.payload && cbo.payload.daily_budget)
  );
  check(
    "meta CBO : pas de flag ABO",
    Boolean(cbo.payload) && cbo.payload.is_adset_budget_sharing_enabled === undefined
  );
  check(
    "meta CBO : adset sans budget",
    Boolean(cboAdset.payload) && cboAdset.payload.daily_budget === undefined
  );
  check(
    "meta CBO : statut ACTIVE",
    Boolean(cbo.payload) && cbo.payload.status === "ACTIVE",
    String(cbo.payload && cbo.payload.status)
  );

  /* --- 3. Editeur carrousel (front) --- */
  const adminAds = read("js/admin-ads.js");
  const defined = /function carouselSelectedProducts\s*\(/.test(adminAds);
  const used = /const products = carouselSelectedProducts\(\)/.test(adminAds);
  check("admin-ads : carouselSelectedProducts() definie", defined);
  check("admin-ads : editorInitialState() l appelle", used);
  check(
    "admin-ads : selection lue depuis carouselDraft.selected",
    /function carouselSelectedProducts\s*\(\)[\s\S]{0,400}ensureCarouselDraft\(\)/.test(adminAds)
  );
  check(
    "admin-ads : fallback top produits si selection vide",
    /products\.length >= CAROUSEL_MIN_PRODUCTS[\s\S]{0,120}topCarouselProducts\(\)/.test(adminAds)
  );

  /* --- 4. Execution reelle de carouselSelectedProducts() avec des stubs --- */
  const carouselBody = extractAsyncFunction(adminAds, "carouselSelectedProducts");
  const syncCarouselBody = carouselBody && carouselBody.replace(/^async\s+/, "");
  check("admin-ads : carouselSelectedProducts extraite", Boolean(syncCarouselBody));
  const draft = { selected: new Set(["1795814400001", "1795814400003"]) };
  const catalogue = [
    { id: "1795814400001", title: "Produit A", price: 100 },
    { id: "1795814400002", title: "Produit B", price: 200 },
    { id: "1795814400003", title: "Produit C", price: 300 },
  ];
  const runCarouselSelection = new Function(
    "ensureCarouselDraft",
    "averageLivoFee",
    "officialProducts",
    "buildSuggestion",
    syncCarouselBody + "\nreturn carouselSelectedProducts;"
  )(
    () => draft,
    () => 20,
    () => catalogue,
    (product, livoFee) => ({ product: product, livoFee: livoFee })
  );
  const picked = runCarouselSelection();
  check(
    "admin-ads : selection = produits coches, dans l ordre",
    picked.length === 2 &&
      picked[0].product.id === "1795814400001" &&
      picked[1].product.id === "1795814400003",
    picked.map((item) => item.product.id).join(",")
  );
  check(
    "admin-ads : produit non coche exclu",
    picked.every((item) => draft.selected.has(String(item.product.id)))
  );
  check(
    "admin-ads : selection vide -> tableau vide (fallback gere par l appelant)",
    (() => {
      draft.selected = new Set();
      return runCarouselSelection().length === 0;
    })()
  );

  /* --- 5. Apercus carres de la colonne gauche (modale creative) --- */
  const adminHtml = read("admin.html");
  const thumbBlocks = adminHtml.match(/\.ads-editor-thumb\s*\{[^}]*\}/g) || [];
  const thumbCss = thumbBlocks.find((block) => /aspect-ratio/.test(block)) || "";
  check(
    "admin.html : conteneur carre 140x140",
    /width:\s*140px/.test(thumbCss) && /height:\s*140px/.test(thumbCss) && /aspect-ratio:\s*1\s*\/\s*1/.test(thumbCss),
    thumbCss.replace(/\s+/g, " ").slice(0, 120)
  );
  check(
    "admin.html : fond blanc + bordure #e5e7eb + radius 10px + overflow hidden",
    /background:\s*#ffffff/i.test(thumbCss) &&
      /border:\s*1px solid #e5e7eb/i.test(thumbCss) &&
      /border-radius:\s*10px/.test(thumbCss) &&
      /overflow:\s*hidden/.test(thumbCss)
  );
  check(
    "admin.html : image 100% + object-fit contain",
    /\.ads-editor-thumb img[\s\S]{0,160}width:\s*100%[\s\S]{0,80}height:\s*100%[\s\S]{0,80}object-fit:\s*contain/.test(
      adminHtml
    )
  );
  check(
    "admin-ads : galerie + cartes carrousel enveloppees dans .ads-editor-thumb",
    adminAds.split('class="ads-editor-thumb"').length - 1 >= 2,
    String(adminAds.split('class="ads-editor-thumb"').length - 1) + " wrappers"
  );
  check(
    "admin.html : alias modale creative (.creative-media-thumb / .creative-card-preview)",
    /\.creative-media-thumb[\s\S]{0,200}object-fit:\s*contain/.test(adminHtml)
  );

  /* --- 6. Apercu telephone (colonne de droite) --- */
  check(
    "admin.html : apercu mono-produit carre (.ads-preview-image)",
    /\.ads-preview-image\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1[^}]*\}/.test(adminHtml) &&
      /\.ads-preview-image img[\s\S]{0,160}object-fit:\s*contain/.test(adminHtml)
  );
  check(
    "admin.html : cartes carrousel carrees dans l apercu (.ads-preview-card-media)",
    /\.ads-preview-card-media\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1[^}]*\}/.test(adminHtml) &&
      /\.ads-preview-card-media img[\s\S]{0,160}object-fit:\s*contain/.test(adminHtml)
  );
  check(
    "admin-ads : apercu droit enveloppe image mono-produit + cartes",
    adminAds.includes('class="ads-preview-image"') &&
      adminAds.split('class="ads-preview-card-media"').length - 1 >= 1
  );
  check(
    "admin.html : plus de hauteur fixe cover sur les cartes d apercu",
    !/\.ads-preview-card img,\s*\n\s*\.ads-preview-card video \{ width: 100%; height: 125px; object-fit: cover/.test(adminHtml)
  );

  console.log(verifications + " verification(s), " + echecs + " echec(s).");
  if (echecs) process.exitCode = 1;
}

main().catch((error) => {
  console.error("ECHEC: exception -> " + String((error && error.message) || error));
  process.exitCode = 1;
});
