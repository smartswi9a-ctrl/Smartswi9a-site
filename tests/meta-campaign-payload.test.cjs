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
  const centsBody = extractAsyncFunction(functionsSource, "metaBudgetToCents");
  check("meta : createMetaCampaign extraite", Boolean(body));
  check("meta : metaBudgetToCents extraite", Boolean(centsBody));

  const calls = [];
  const deleted = [];
  const factory = new Function(
    "metaGraphRequest",
    "metaAdsManagerUrl",
    "deleteMetaCampaign",
    "metaAccountCurrency",
    "USD_MAD_DEFAULT_RATE",
    centsBody + "\n" + body + "\nreturn createMetaCampaign;"
  );
  const createMetaCampaign = factory(
    async (apiPath, method, payload) => {
      calls.push({ apiPath: apiPath, method: method, payload: payload });
      return { id: String(calls.length) };
    },
    () => "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=x",
    async (accountId, token, campaignId) => {
      deleted.push(String(campaignId));
      return true;
    },
    async () => "MAD",
    10
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
  /* --- 7. Aperçu mono-produit TikTok / Facebook / Instagram --- */
  check(
    "admin.html : TikTok media carre plein (344x344, max-height none)",
    /\.ads-preview-tiktok-media\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1[^}]*height:\s*auto[^}]*max-height:\s*none[^}]*background:\s*#ffffff/i.test(
      adminHtml
    ) && /\.ads-preview-tiktok-media img[^}]*object-fit:\s*contain/.test(adminHtml)
  );
  check(
    "admin.html : bloc sombre TikTok (degrade + padding 14/20)",
    /\.ads-preview-tiktok-info\s*\{[^}]*linear-gradient\(180deg,\s*rgba\(15,\s*23,\s*42,\s*0\.92\)\s*0%,\s*#090d16 100%\)[^}]*padding:\s*14px 14px 20px 14px/.test(
      adminHtml
    )
  );
  check(
    "admin.html : CTA TikTok marges 8px / 6px",
    /\.ads-preview-tiktok-info \.ads-preview-cta\s*\{[^}]*margin-top:\s*8px[^}]*margin-bottom:\s*6px/.test(adminHtml)
  );
  check(
    "admin.html : bandeau Facebook #f0f2f5 padding 12/14/16",
    /\.ads-preview-link\s*\{[^}]*padding:\s*12px 14px 16px[^}]*background:\s*#f0f2f5/.test(adminHtml)
  );
  check(
    "admin.html : titre FB limite a 2 lignes + prix or",
    /\.ads-preview-title[^}]*-webkit-line-clamp:\s*2/.test(adminHtml) &&
      /\.ads-preview-price\s*\{[^}]*color:\s*#B4833E/i.test(adminHtml)
  );
  check(
    "admin.html : Instagram bandeau action + padding-bottom 18px",
    /\.ads-preview-ig-actions\s*\{[^}]*background:\s*#f0f2f5/.test(adminHtml) &&
      /\.ads-preview-body--ig\s*\{[^}]*padding-bottom:\s*18px/.test(adminHtml)
  );
  check(
    "admin.html : media carre 1:1 FB/IG (ads-preview-media--square)",
    /\.ads-preview-media--square\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1[^}]*background:\s*#ffffff/.test(adminHtml)
  );
  check(
    "admin.html : colonne droite scrollable avec padding-bottom 24px",
    (function () {
      const block = (adminHtml.match(/\.ads-editor-preview\s*\{[^}]*\}/) || [""])[0];
      return /overflow-y:\s*auto/.test(block) && /padding:[^;]*24px/.test(block);
    })()
  );
  check(
    "admin-ads : TikTok @smartswi9a dans le bloc sombre (plus d overlay)",
    adminAds.includes('class="ads-preview-tiktok-info"') &&
      adminAds.includes('class="ads-preview-badge"') &&
      !adminAds.includes("ads-preview-tiktok-overlay") &&
      !adminHtml.includes("ads-preview-tiktok-overlay")
  );
  check(
    "admin-ads : RTL auto (editorIsArabic) + prix mono-produit",
    adminAds.includes("function editorIsArabic(") &&
      adminAds.includes('dir="rtl"') &&
      adminAds.includes("function editorPriceLabel(")
  );
  check(
    "admin.html : mockup telephone non compresse (flex 0 0 auto)",
    /\.ads-phone\s*\{[^}]*flex:\s*0 0 auto/.test(adminHtml) &&
      /\.ads-phone\s*\{[^}]*min-height:\s*540px/.test(adminHtml)
  );
  check(
    "admin-ads : FB domaine SMARTSWIKA.MA + bandeau IG",
    adminAds.includes("SMARTSWIKA.MA") && adminAds.includes("ads-preview-ig-actions")
  );

  /* --- 8. Encheres automatiques, budget total + duree, nettoyage --- */
  check(
    "meta adset : bid_strategy LOWEST_COST_WITHOUT_CAP",
    Boolean(adset.payload) && adset.payload.bid_strategy === "LOWEST_COST_WITHOUT_CAP",
    String(adset.payload && adset.payload.bid_strategy)
  );
  check(
    "meta adset : targeting_automation.advantage_audience = 1",
    Boolean(adset.payload) &&
      Boolean(adset.payload.targeting) &&
      Boolean(adset.payload.targeting.targeting_automation) &&
      adset.payload.targeting.targeting_automation.advantage_audience === 1,
    JSON.stringify(adset.payload && adset.payload.targeting && adset.payload.targeting.targeting_automation)
  );
  check(
    "meta adset : age_max absent ou >= 65 avec advantage_audience",
    Boolean(adset.payload) &&
      Boolean(adset.payload.targeting) &&
      (adset.payload.targeting.age_max === undefined || adset.payload.targeting.age_max >= 65),
    String(adset.payload && adset.payload.targeting && adset.payload.targeting.age_max)
  );
  check(
    "meta adset : age_min 21 + geo MA conserves",
    Boolean(adset.payload) &&
      Boolean(adset.payload.targeting) &&
      adset.payload.targeting.age_min === 21 &&
      Boolean(adset.payload.targeting.geo_locations) &&
      Array.isArray(adset.payload.targeting.geo_locations.countries) &&
      adset.payload.targeting.geo_locations.countries[0] === "MA"
  );
  check(
    "meta adset : aucun bid_amount / bid_constraints vide",
    Boolean(adset.payload) &&
      !Object.prototype.hasOwnProperty.call(adset.payload, "bid_amount") &&
      !Object.prototype.hasOwnProperty.call(adset.payload, "bid_constraints")
  );

  /* Budget total + duree (10 $ / 4 jours) -> lifetime_budget + end_time */
  calls.length = 0;
  await createMetaCampaign({
    accountId: "act_77",
    token: "tok",
    campaignName: "Smartswika - 10$ sur 4 jours",
    dailyBudgetMad: 25,
    totalBudgetMad: 100,
    durationDays: 4,
    startPaused: true,
  });
  const lifetimeAdset = calls[1] || {};
  const endTime = lifetimeAdset.payload && lifetimeAdset.payload.end_time;
  check(
    "meta lifetime : lifetime_budget 10000",
    Boolean(lifetimeAdset.payload) && lifetimeAdset.payload.lifetime_budget === 10000,
    String(lifetimeAdset.payload && lifetimeAdset.payload.lifetime_budget)
  );
  check(
    "meta lifetime : pas de daily_budget",
    Boolean(lifetimeAdset.payload) && lifetimeAdset.payload.daily_budget === undefined
  );
  check(
    "meta lifetime : end_time futur (ISO)",
    Boolean(endTime) && new Date(endTime).getTime() > Date.now() + 3 * 86400000,
    String(endTime)
  );

  /* Echec de l ad set -> DELETE de la campagne orpheline */
  const failingFactory = new Function(
    "metaGraphRequest",
    "metaAdsManagerUrl",
    "deleteMetaCampaign",
    "metaAccountCurrency",
    "USD_MAD_DEFAULT_RATE",
    centsBody + "\n" + body + "\nreturn createMetaCampaign;"
  );
  const deletedIds = [];
  const failing = failingFactory(
    async (apiPath) => {
      if (apiPath.indexOf("/adsets") >= 0) throw new Error("Meta API: bid cap without bid_amount");
      return { id: "999" };
    },
    () => "url",
    async (accountId, token, campaignId) => {
      deletedIds.push(String(campaignId));
      return true;
    },
    async () => "MAD",
    10
  );
  let thrown = null;
  try {
    await failing({
      accountId: "act_9",
      token: "tok",
      campaignName: "Campagne test",
      dailyBudgetMad: 20,
      startPaused: true,
    });
  } catch (error) {
    thrown = error;
  }
  check("meta : erreur adset propagee", Boolean(thrown) && /bid cap/.test(String(thrown.message)));
  check(
    "meta : campagne orpheline supprimee (DELETE)",
    deletedIds.length === 1 && deletedIds[0] === "999",
    deletedIds.join(",")
  );

  /* --- 9. Compte Meta en USD : 10 $ sur 4 jours -> lifetime_budget 1000 --- */
  const usdFactory = new Function(
    "metaGraphRequest",
    "metaAdsManagerUrl",
    "deleteMetaCampaign",
    "metaAccountCurrency",
    "USD_MAD_DEFAULT_RATE",
    centsBody + "\n" + body + "\nreturn createMetaCampaign;"
  );
  const usdCalls = [];
  const createUsdCampaign = usdFactory(
    async (apiPath, method, payload) => {
      usdCalls.push({ apiPath: apiPath, payload: payload });
      return { id: String(usdCalls.length) };
    },
    () => "url",
    async () => true,
    async () => "USD",
    10
  );
  await createUsdCampaign({
    accountId: "act_1714694896973404",
    token: "tok",
    campaignName: "Smartswika - 10$ sur 4 jours",
    dailyBudgetMad: 25,
    totalBudgetMad: 100,
    totalBudgetUsd: 10,
    usdMadRate: 10,
    durationDays: 4,
    startPaused: true,
  });
  const usdAdset = usdCalls[1] || {};
  check(
    "meta USD : lifetime_budget === 1000 (10,00 $)",
    Boolean(usdAdset.payload) && usdAdset.payload.lifetime_budget === 1000,
    String(usdAdset.payload && usdAdset.payload.lifetime_budget)
  );
  check(
    "meta USD : jamais 10000 (erreur MAD->USD historique)",
    Boolean(usdAdset.payload) && usdAdset.payload.lifetime_budget !== 10000
  );

  /* Budget journalier en USD : 50 MAD -> 5 $ -> 500 centimes */
  usdCalls.length = 0;
  await createUsdCampaign({
    accountId: "act_1714694896973404",
    token: "tok",
    campaignName: "Smartswika - 5$/jour",
    dailyBudgetMad: 50,
    durationDays: 0,
    startPaused: true,
  });
  const usdDaily = usdCalls[1] || {};
  check(
    "meta USD : daily_budget === 500 depuis 50 MAD",
    Boolean(usdDaily.payload) && usdDaily.payload.daily_budget === 500,
    String(usdDaily.payload && usdDaily.payload.daily_budget)
  );

  /* Compte en MAD : 100 MAD restent 10000 centimes */
  calls.length = 0;
  await createMetaCampaign({
    accountId: "act_mad",
    token: "tok",
    campaignName: "Smartswika - 100 MAD / 4 jours",
    dailyBudgetMad: 25,
    totalBudgetMad: 100,
    durationDays: 4,
    startPaused: true,
  });
  const madAdset = calls[1] || {};
  check(
    "meta MAD : lifetime_budget === 10000",
    Boolean(madAdset.payload) && madAdset.payload.lifetime_budget === 10000,
    String(madAdset.payload && madAdset.payload.lifetime_budget)
  );

  /* --- 10. Suppression synchronisee des DRAFT / PAUSED --- */
  const coreBody = extractAsyncFunction(functionsSource, "deleteAdCampaignEverywhereCore");
  const metaRemoteBody = extractAsyncFunction(functionsSource, "deleteMetaCampaignRemote");
  check(
    "delete : helpers extraits",
    Boolean(coreBody) && Boolean(metaRemoteBody)
  );
  const buildDeleteCore = (deps) => {
    const core = new Function(
      "deleteMeta",
      "deleteTiktok",
      "removeDocument",
      coreBody + "\nreturn deleteAdCampaignEverywhereCore;"
    )(deps.deleteMeta, deps.deleteTiktok, deps.removeDocument);
    /* Les dependances sont aussi injectees dans les options : le corps extrait
       resout d abord options.deleteMeta (les identifiants module n existent pas
       dans le bac a sable du test). */
    return (input) =>
      core({
        ...input,
        deleteMeta: deps.deleteMeta,
        deleteTiktok: deps.deleteTiktok,
        removeDocument: deps.removeDocument,
      });
  };

  const deletedDocs = [];
  const metaCalls = [];
  const coreDelete = buildDeleteCore({
    deleteMeta: async (input) => {
      metaCalls.push(input);
      return { deleted: true, skipped: false, alreadyGone: false };
    },
    deleteTiktok: async () => ({ deleted: true, skipped: false, alreadyGone: false }),
    removeDocument: async (id) => {
      deletedDocs.push(id);
    },
  });
  const draftResult = await coreDelete({
    docId: "doc-draft",
    campaign: { status: "DRAFT", platform: "meta", externalCampaignId: "1200" },
    metaToken: "tok",
  });
  check(
    "delete : Meta DELETE /{campaignId} appele",
    metaCalls.length === 1 &&
      metaCalls[0].campaignId === "1200" &&
      metaCalls[0].token === "tok",
    JSON.stringify(metaCalls[0] || {})
  );
  check(
    "delete : document Firestore supprime",
    deletedDocs.length === 1 && deletedDocs[0] === "doc-draft",
    deletedDocs.join(",")
  );
  check(
    "delete : resultat ok + remoteDeleted",
    draftResult.ok === true && draftResult.remoteDeleted === true
  );

  const tikCalls = [];
  const coreTiktok = buildDeleteCore({
    deleteMeta: async () => ({ deleted: false, skipped: true }),
    deleteTiktok: async (input) => {
      tikCalls.push(input);
      return { deleted: true, skipped: false, alreadyGone: false };
    },
    removeDocument: async (id) => {
      deletedDocs.push(id);
    },
  });
  await coreTiktok({
    docId: "doc-paused",
    campaign: { status: "PAUSED", platform: "tiktok", externalCampaignId: "1799" },
    tiktokAdvertiserId: "adv-1",
    tiktokToken: "ttok",
  });
  check(
    "delete : TikTok DELETE/archive appele",
    tikCalls.length === 1 &&
      tikCalls[0].campaignId === "1799" &&
      tikCalls[0].advertiserId === "adv-1" &&
      deletedDocs.includes("doc-paused"),
    JSON.stringify(tikCalls[0] || {})
  );

  /* Campagne deja supprimee cote Meta : code 100 / subcode 33 -> tolere */
  const realMetaRemote = new Function(
    "metaGraphRequest",
    "META_ALREADY_GONE_PATTERN",
    metaRemoteBody + "\nreturn deleteMetaCampaignRemote;"
  )(async () => {
    const error = new Error(
      "Unsupported get request. Object with ID '1200' does not exist, cannot be loaded"
    );
    error.metaError = { code: 100, subcode: 33 };
    throw error;
  }, /does not exist|Unsupported get request|was deleted|Object with ID/i);
  const goneResult = await realMetaRemote({ campaignId: "1200", token: "tok" });
  check(
    "delete : Meta deja supprime tolere (code 100 / subcode 33)",
    goneResult.alreadyGone === true && goneResult.deleted === false,
    JSON.stringify(goneResult)
  );
  const docCountBefore = deletedDocs.length;
  const coreGone = buildDeleteCore({
    deleteMeta: (input) => realMetaRemote(input),
    deleteTiktok: async () => ({ deleted: true }),
    removeDocument: async (id) => {
      deletedDocs.push(id);
    },
  });
  const goneDocResult = await coreGone({
    docId: "doc-gone",
    campaign: { status: "PAUSED", platform: "meta", externalCampaignId: "1200" },
    metaToken: "tok",
  });
  check(
    "delete : Firestore supprime meme si Meta a deja l objet",
    goneDocResult.ok === true &&
      goneDocResult.alreadyGone === true &&
      deletedDocs.length === docCountBefore + 1
  );

  /* Campagne ACTIVE : suppression refusee, rien n est touche */
  const callsBeforeActive = metaCalls.length + deletedDocs.length;
  let activeError = null;
  try {
    await coreDelete({
      docId: "doc-active",
      campaign: { status: "ACTIVE", platform: "meta", externalCampaignId: "1300" },
      metaToken: "tok",
    });
  } catch (error) {
    activeError = error;
  }
  check(
    "delete : campagne ACTIVE bloquee (failed-precondition)",
    Boolean(activeError) && activeError.status === "failed-precondition",
    String(activeError && activeError.message)
  );
  check(
    "delete : aucun appel distant ni suppression Firestore si ACTIVE",
    metaCalls.length + deletedDocs.length === callsBeforeActive
  );

  /* --- 11. Auto-pause des campagnes quand le stock passe a 0 --- */
  const pauseCoreBody = extractAsyncFunction(functionsSource, "pauseCampaignsOnStockZeroCore");
  const pauseExternalBody = extractAsyncFunction(functionsSource, "pauseExternalCampaign");
  check(
    "stock : helpers extraits",
    Boolean(pauseCoreBody) && Boolean(pauseExternalBody)
  );
  const buildPauseCore = (deps) => {
    const core = new Function(
      "pauseRemote",
      "markPaused",
      "notify",
      "stockOf",
      pauseCoreBody + "\nreturn pauseCampaignsOnStockZeroCore;"
    )(deps.pauseRemote, deps.markPaused, deps.notify, deps.stockOf);
    return (input) =>
      core({
        ...input,
        pauseRemote: deps.pauseRemote,
        markPaused: deps.markPaused,
        notify: deps.notify,
        stockOf: deps.stockOf,
      });
  };

  const remoteIds = [];
  const pausePatches = [];
  const monoCampaign = {
    id: "camp-mono",
    status: "ACTIVE",
    platform: "meta",
    externalCampaignId: "1200",
    productId: "p1",
  };
  const coreMono = buildPauseCore({
    pauseRemote: async (campaign) => {
      remoteIds.push(campaign.id);
      return true;
    },
    markPaused: async (campaign, patch) => {
      pausePatches.push({ id: campaign.id, patch: patch });
    },
    notify: async () => 1,
    stockOf: async () => 0,
  });
  const monoResult = await coreMono({
    productId: "p1",
    prevStock: 1,
    nextStock: 0,
    campaigns: [monoCampaign],
  });
  check(
    "stock : 1 -> 0 met la campagne mono-produit en pause",
    monoResult.paused.includes("camp-mono") && remoteIds.includes("camp-mono"),
    JSON.stringify(monoResult)
  );
  check(
    "stock : Firestore status PAUSED + autoPausedReason stock_zero",
    pausePatches.length === 1 &&
      pausePatches[0].patch.status === "PAUSED" &&
      pausePatches[0].patch.autoPausedReason === "stock_zero",
    JSON.stringify(pausePatches[0] || {})
  );

  remoteIds.length = 0;
  pausePatches.length = 0;
  const noTransition = await coreMono({
    productId: "p1",
    prevStock: 5,
    nextStock: 4,
    campaigns: [monoCampaign],
  });
  check(
    "stock : 5 -> 4 ne declenche aucun appel et laisse ACTIVE",
    noTransition.transition === false &&
      remoteIds.length === 0 &&
      pausePatches.length === 0
  );

  const carouselCampaign = {
    id: "camp-carousel",
    status: "ACTIVE",
    type: "carousel",
    platform: "meta",
    externalCampaignId: "1300",
    productIds: ["p1", "p2", "p3"],
  };
  const stockMap = new Map([
    ["p1", 0],
    ["p2", 5],
    ["p3", 2],
  ]);
  remoteIds.length = 0;
  pausePatches.length = 0;
  const coreCarousel = buildPauseCore({
    pauseRemote: async (campaign) => {
      remoteIds.push(campaign.id);
      return true;
    },
    markPaused: async (campaign, patch) => {
      pausePatches.push({ id: campaign.id, patch: patch });
    },
    notify: async () => 1,
    stockOf: async (id) => (stockMap.has(id) ? stockMap.get(id) : 0),
  });
  const partial = await coreCarousel({
    productId: "p1",
    prevStock: 1,
    nextStock: 0,
    campaigns: [carouselCampaign],
  });
  check(
    "stock : carrousel avec produits encore en stock reste ACTIVE",
    partial.skipped.includes("camp-carousel") &&
      partial.paused.length === 0 &&
      pausePatches.length === 0
  );

  stockMap.set("p2", 0);
  stockMap.set("p3", 0);
  const allZero = await coreCarousel({
    productId: "p1",
    prevStock: 1,
    nextStock: 0,
    campaigns: [carouselCampaign],
  });
  check(
    "stock : carrousel mis en pause si tous les produits sont a 0",
    allZero.paused.includes("camp-carousel") &&
      pausePatches.length === 1 &&
      pausePatches[0].patch.autoPausedReason === "stock_zero"
  );

  /* Payloads reels de pause distante (pauseExternalCampaign) */
  const metaPauses = [];
  const buildPauseRemote = (metaRequest, tiktokRequest) =>
    new Function(
      "metaGraphRequest",
      "tiktokRequest",
      pauseExternalBody + "\nreturn pauseExternalCampaign;"
    )(metaRequest, tiktokRequest);
  const pauseMetaRemote = buildPauseRemote(async (path, method, payload) => {
    metaPauses.push({ path: path, method: method, payload: payload });
    return {};
  }, async () => ({}));
  await pauseMetaRemote(
    { platform: "meta", externalCampaignId: "1200" },
    { metaAccessToken: "tok" }
  );
  check(
    "stock : pause Meta -> POST /1200 { status: PAUSED }",
    metaPauses.length === 1 &&
      metaPauses[0].path === "1200" &&
      metaPauses[0].method === "POST" &&
      metaPauses[0].payload.status === "PAUSED",
    JSON.stringify(metaPauses[0] || {})
  );

  const tiktokPauses = [];
  const pauseTiktokRemote = buildPauseRemote(async () => ({}), async (path, method, payload) => {
    tiktokPauses.push({ path: path, method: method, payload: payload });
    return {};
  });
  await pauseTiktokRemote(
    { platform: "tiktok", externalCampaignId: "1799" },
    { tiktokAccessToken: "ttok", tiktokAdvertiserId: "adv-1" }
  );
  check(
    "stock : pause TikTok -> operation_status DISABLE",
    tiktokPauses.length === 1 &&
      tiktokPauses[0].path === "/campaign/status/update/" &&
      tiktokPauses[0].payload.operation_status === "DISABLE" &&
      tiktokPauses[0].payload.campaign_ids[0] === "1799",
    JSON.stringify(tiktokPauses[0] || {})
  );

  /* --- 12. Moteur creatif COD v31 : A/B/C + image/video + zero fausse preuve --- */
  const adminAdsCreative = read("js/admin-ads.js");
  const planBody = extractAsyncFunction(functionsSource, "planMetaAds");
  const variantsBody = extractAsyncFunction(functionsSource, "normalizeAdVariants");
  check(
    "creative : planMetaAds + normalizeAdVariants extraits",
    Boolean(planBody) && Boolean(variantsBody)
  );
  const buildPlan = new Function(
    "normalizeAdCopy",
    variantsBody + "\n" + planBody + "\nreturn planMetaAds;"
  )((value) => {
    if (value && typeof value === "object") {
      return {
        fr: String(value.fr || ""),
        en: String(value.en || ""),
        ar: String(value.ar || ""),
      };
    }
    return { fr: String(value || ""), en: String(value || ""), ar: String(value || "") };
  });

  const mixedPlan = buildPlan({
    mixImageVideo: true,
    hasImage: true,
    hasVideo: true,
    message: "Texte principal",
  });
  check(
    "creative : image + video -> 2 annonces dans le meme ad set",
    mixedPlan.length === 2 &&
      mixedPlan[0].format === "image" &&
      mixedPlan[1].format === "video" &&
      mixedPlan[0].key === "image" &&
      mixedPlan[1].key === "video",
    JSON.stringify(mixedPlan.map((ad) => ad.key + ":" + ad.format))
  );

  const variantPlan = buildPlan({
    hasImage: true,
    hasVideo: true,
    message: "Texte principal",
    variants: [
      { key: "A", label: "Variante A", copies: { fr: "Copy A" } },
      { key: "B", label: "Variante B", copies: { fr: "Copy B" } },
      { key: "C", label: "Variante C", copies: { fr: "Copy C" } },
    ],
  });
  check(
    "creative : A/B/C -> 3 annonces dans le meme ad set",
    variantPlan.length === 3 &&
      variantPlan[0].key === "variant-a" &&
      variantPlan[2].key === "variant-c" &&
      variantPlan[1].message === "Copy B",
    JSON.stringify(variantPlan.map((ad) => ad.key))
  );

  const extractConst = (source, name) => {
    const start = source.indexOf("const " + name + " = {");
    if (start < 0) return "const " + name + " = {};";
    let depth = 0;
    for (let i = source.indexOf("{", start); i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) return source.slice(start, i + 1) + ";";
      }
    }
    return "const " + name + " = {};";
  };
  const forbiddenMatch = adminAdsCreative.match(/const FORBIDDEN_PROOF_PATTERN =\s*([\s\S]*?);\s*\n/);
  const prelude = [
    "const fmtNumber = (n) => String(n);",
    extractConst(adminAdsCreative, "COD_GUARANTEES"),
    extractConst(adminAdsCreative, "COD_CTA_TEXT"),
    "const FORBIDDEN_PROOF_PATTERN = " + (forbiddenMatch ? forbiddenMatch[1].trim() : "/(?!)/") + ";",
  ].join("\n");
  const creativeFns = new Function(
    prelude +
      "\n" +
      [
        "firstSentence",
        "realSocialProof",
        "containsForbiddenClaims",
        "buildConversionCopy",
        "buildAbVariants",
        "creativeStrategy",
        "creativeChecklist",
      ]
        .map((name) => extractAsyncFunction(adminAdsCreative, name) || "")
        .join("\n") +
      "\nreturn { buildConversionCopy, buildAbVariants, containsForbiddenClaims, creativeStrategy, creativeChecklist, realSocialProof };"
  )();

  const honestCopy = creativeFns.buildConversionCopy({
    name: "SinoTrack ST-901M",
    nameEn: "SinoTrack ST-901M",
    nameAr: "سينو تراك",
    price: 470,
    description: "Traceur GPS temps reel.",
  });
  check(
    "creative : garanties COD reelles presentes (FR)",
    honestCopy.fr.includes("Paiement à la livraison") &&
      honestCopy.fr.includes("404 villes") &&
      honestCopy.fr.includes("Garantie 15 jours")
  );
  check(
    "creative : 3 blocs (accroche / reassurance / CTA)",
    honestCopy.fr.split("\n").length === 3 && honestCopy.fr.includes("Commandez maintenant")
  );
  check(
    "creative : aucun faux chiffre ni fausse preuve quand rating absent",
    !honestCopy.fr.includes("⭐") &&
      !honestCopy.en.includes("⭐") &&
      !creativeFns.containsForbiddenClaims(honestCopy.fr) &&
      !creativeFns.containsForbiddenClaims(honestCopy.en)
  );

  const withReviews = creativeFns.buildConversionCopy({
    name: "SinoTrack ST-901M",
    price: 470,
    rating: 4.6,
    reviewsCount: 12,
  });
  check(
    "creative : vraie note uniquement si reviewCount >= 3",
    withReviews.fr.includes("⭐ 4,6/5 (12 avis vérifiés)") &&
      !creativeFns.containsForbiddenClaims(withReviews.fr)
  );
  check(
    "creative : note ignoree si moins de 3 avis",
    !creativeFns
      .buildConversionCopy({ name: "X", rating: 4.8, reviewsCount: 2 })
      .fr.includes("⭐")
  );
  check(
    "creative : '3000 clients satisfaits' detecte comme interdit",
    creativeFns.containsForbiddenClaims("Rejoint par 3000 clients satisfaits au Maroc")
  );

  const abVariants = creativeFns.buildAbVariants({ name: "SinoTrack ST-901M", price: 470 });
  check(
    "creative : 3 variantes A/B/C generees",
    abVariants.length === 3 &&
      abVariants[0].key === "A" &&
      abVariants[2].key === "C" &&
      abVariants.every((variant) => variant.copies.fr.includes("Paiement à la livraison"))
  );
  check(
    "creative : variantes sans fausse preuve sociale",
    abVariants.every(
      (variant) =>
        !variant.copies.fr.includes("⭐") &&
        !creativeFns.containsForbiddenClaims(variant.copies.fr) &&
        !creativeFns.containsForbiddenClaims(variant.copies.ar)
    )
  );

  const focus = creativeFns.creativeStrategy({ budgetUsd: 10, stock: 40 });
  const scaling = creativeFns.creativeStrategy({ budgetUsd: 60, stock: 20 });
  check(
    "creative : mode Focus si budget < 25 $",
    focus.focusMode === true && focus.abRecommended === false && /Mode Focus/.test(focus.advice)
  );
  check(
    "creative : mode Scaling si budget >= 25 $ et stock >= 10",
    scaling.focusMode === false && scaling.abRecommended === true && /Scaling/.test(scaling.advice)
  );

  const checklist = creativeFns.creativeChecklist({
    stock: 12,
    destinationUrl: "https://www.smartswika.ma/produit.html?id=1",
    copy: honestCopy.fr,
    hasMedia: true,
    metaPixelId: "2021976911744667",
    tiktokPixelId: "DC44DJ3C77U9PR64VE10",
  });
  const checklistZero = creativeFns.creativeChecklist({
    stock: 0,
    destinationUrl: "",
    copy: "3000 clients satisfaits",
    hasMedia: false,
    metaPixelId: "",
    tiktokPixelId: "",
  });
  check(
    "creative : checklist 4 voyants verts quand tout est valide",
    checklist.length === 4 && checklist.every((item) => item.ok === true),
    JSON.stringify(checklist.map((item) => item.key + ":" + item.ok))
  );
  check(
    "creative : checklist bloque stock 0 et promesse interdite",
    checklistZero.every((item) => item.ok === false) &&
      /Stock épuisé/.test(checklistZero[0].label)
  );

  console.log(verifications + " verification(s), " + echecs + " echec(s).");
  if (echecs) process.exitCode = 1;
}

main().catch((error) => {
  console.error("ECHEC: exception -> " + String((error && error.message) || error));
  process.exitCode = 1;
});
