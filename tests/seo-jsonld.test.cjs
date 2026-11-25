/* ============================================================
   tests/seo-jsonld.test.cjs
   GARDE-FOU SEO & RICH SNIPPETS (Schema.org / JSON-LD)
   ------------------------------------------------------------
   Verifie :
     1. la syntaxe JSON-LD des pages principales (accueil + villes) ;
     2. la presence des types attendus (OnlineStore, WebSite,
        FAQPage, BreadcrumbList, Service/DeliveryChargeSpecification) ;
     3. l'absence d'AggregateRating vide et la regle Google
        (au moins 1 avis note > 0) via le builder produit ;
     4. les Offer produit (MAD, dispo, etat neuf, livraison MA 24-72h,
        politique de retour 15 j Smartswika / 7 j vendeur) ;
     5. canonical / hreflang fr-en-ar-x-default / meta description
        <= 155 / Open Graph / un seul H1 sur les pages publiques ;
     6. sitemap.xml sans .html, sans page noindex, sans ?preview_event= ;
     7. robots.txt bloque bien ?preview_event= et /admin.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SITE = "https://smartswika.ma";

let verifications = 0;
let echecs = 0;

function check(nom, condition, detail) {
  verifications++;
  if (condition) {
    console.log("PASS: " + nom + (detail ? " -> " + detail : ""));
  } else {
    echecs++;
    console.error("ECHEC: " + nom + (detail ? " -> " + detail : ""));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function extractJsonLd(html) {
  const blocks = [];
  const re = /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const raw = match[1].trim();
    let data = null;
    let error = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      error = e.message;
    }
    const idMatch = match[0].match(/\bid="([^"]+)"/i);
    blocks.push({ raw, data, error, id: idMatch ? idMatch[1] : null });
  }
  return blocks;
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
  } else if (value && typeof value === "object") {
    visit(value);
    Object.keys(value).forEach((key) => walk(value[key], visit));
  }
}

/* --------------------------------------------- 1. accueil */

const indexHtml = read("index.html");
const indexBlocks = extractJsonLd(indexHtml);

check(
  "accueil : blocs JSON-LD presents",
  indexBlocks.length >= 3,
  indexBlocks.length + " bloc(s)"
);

indexBlocks.forEach((block, i) => {
  check(
    "accueil : JSON-LD #" + (i + 1) + " parsable",
    block.error === null && block.data !== null,
    block.error || "ok"
  );
});

const indexByType = {};
indexBlocks.forEach((block) => {
  if (block.data && block.data["@type"]) {
    const type = String(block.data["@type"]);
    indexByType[type] = (indexByType[type] || 0) + 1;
  }
});

check("accueil : un seul OnlineStore", indexByType.OnlineStore === 1);
check("accueil : un seul WebSite", indexByType.WebSite === 1);
check("accueil : un seul FAQPage", indexByType.FAQPage === 1);
check("accueil : plus d Organization en doublon", !indexByType.Organization);

const onlineStore = indexBlocks.find(
  (b) => b.data && b.data["@type"] === "OnlineStore"
) || { data: {} };
const store = onlineStore.data || {};
check("OnlineStore : nom Smartswika", store.name === "Smartswika");
check("OnlineStore : url officielle", store.url === SITE + "/");
check("OnlineStore : logo present", !!(store.logo && store.logo.url));
check("OnlineStore : telephone +212656613303", store.telephone === "+212656613303");
check("OnlineStore : devise MAD", store.currenciesAccepted === "MAD");
check("OnlineStore : areaServed MA", store.areaServed === "MA");
check(
  "OnlineStore : paiement a la livraison",
  /cash on delivery|livraison/i.test(String(store.paymentAccepted || "")),
  store.paymentAccepted
);

const webSite = indexBlocks.find(
  (b) => b.data && b.data["@type"] === "WebSite"
) || { data: {} };
const ws = webSite.data || {};
check(
  "WebSite : SearchAction present",
  !!(ws.potentialAction && ws.potentialAction["@type"] === "SearchAction")
);
check(
  "WebSite : urlTemplate de recherche",
  !!(ws.potentialAction && ws.potentialAction.target && /search=/.test(
    String(ws.potentialAction.target.urlTemplate)
  ))
);

const faq = indexBlocks.find((b) => b.data && b.data["@type"] === "FAQPage") || {
  data: {},
};
const faqItems = Array.isArray(faq.data.mainEntity) ? faq.data.mainEntity : [];
check("FAQPage : au moins 3 questions", faqItems.length >= 3, faqItems.length + " Q");
check(
  "FAQPage : chaque question a une reponse non vide",
  faqItems.every(
    (item) =>
      item &&
      item["@type"] === "Question" &&
      typeof item.name === "string" &&
      item.name.trim().length > 0 &&
      item.acceptedAnswer &&
      item.acceptedAnswer["@type"] === "Answer" &&
      typeof item.acceptedAnswer.text === "string" &&
      item.acceptedAnswer.text.trim().length > 0
  )
);
check(
  "FAQPage : livraison 24-72h mentionnee",
  /24\s*(a|-|à)?\s*72|24-72/i.test(JSON.stringify(faqItems))
);
check(
  "FAQPage : garanties 15 j et 7 j mentionnees",
  /15\s*jours/i.test(JSON.stringify(faqItems)) &&
    /7\s*jours/i.test(JSON.stringify(faqItems))
);

/* --------------------------------------------- 2. villes */

const villesHtml = read("villesmaroc.html");
const villesBlocks = extractJsonLd(villesHtml);

check(
  "villes : blocs JSON-LD presents",
  villesBlocks.length >= 2,
  villesBlocks.length + " bloc(s)"
);

villesBlocks.forEach((block, i) => {
  check(
    "villes : JSON-LD #" + (i + 1) + " parsable",
    block.error === null && block.data !== null,
    block.error || "ok"
  );
});

const villesBreadcrumb = villesBlocks.find(
  (b) => b.data && b.data["@type"] === "BreadcrumbList"
);
check("villes : BreadcrumbList present", !!villesBreadcrumb);
check(
  "villes : fil d Ariane a 2 niveaux",
  !!villesBreadcrumb &&
    Array.isArray(villesBreadcrumb.data.itemListElement) &&
    villesBreadcrumb.data.itemListElement.length === 2
);

const villesService = villesBlocks.find(
  (b) => b.data && b.data["@type"] === "Service"
);
check("villes : Service de livraison present", !!villesService);
const svc = villesService ? villesService.data : {};
const priceSpec = svc.offers && svc.offers.priceSpecification;
check(
  "villes : DeliveryChargeSpecification present",
  !!priceSpec && priceSpec["@type"] === "DeliveryChargeSpecification"
);
check(
  "villes : devise MAD sur les frais",
  !!priceSpec && priceSpec.priceCurrency === "MAD"
);
check(
  "villes : frais min/max numeriques",
  !!priceSpec &&
    Number(priceSpec.minPrice) > 0 &&
    Number(priceSpec.maxPrice) >= Number(priceSpec.minPrice),
  priceSpec ? priceSpec.minPrice + "-" + priceSpec.maxPrice : "absent"
);
check(
  "villes : areaServed Maroc + villes",
  Array.isArray(svc.areaServed) &&
    svc.areaServed.some((a) => a && a["@type"] === "Country" && a.name === "MA") &&
    svc.areaServed.filter((a) => a && a["@type"] === "City").length >= 10,
  Array.isArray(svc.areaServed) ? svc.areaServed.length + " zones" : "absent"
);
check(
  "villes : paiement a la livraison",
  /cash on delivery|livraison/i.test(String(svc.paymentAccepted || "")),
  svc.paymentAccepted
);
check(
  "villes : 404 villes documentees",
  /404\s*villes/i.test(JSON.stringify(svc))
);

/* --------------------------------------------- 3. pages publiques */

const PUBLIC_PAGES = [
  "index.html",
  "koulchi.html",
  "blog.html",
  "villesmaroc.html",
  "produit.html",
  "cgu-acheteur.html",
  "cgu-vendeur.html",
  "contrat-vendeur.html",
  "politique-confidentialite.html",
];

const HREFLANG_EXPECTED = ["fr", "en", "ar", "x-default"];

for (const page of PUBLIC_PAGES) {
  const html = read(page);
  const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  const desc = descMatch ? descMatch[1] : "";
  const canonical = /<link\s+rel="canonical"\s+href="https?:\/\/[^"]+"/i.test(html);
  const hreflangs = [...html.matchAll(/hreflang="([^"]+)"/gi)].map((m) => m[1]);
  const ogTitle = /property="og:title"/.test(html);
  const ogDesc = /property="og:description"/.test(html);
  const ogImage = /property="og:image"/.test(html);
  const h1Count = (html.match(/<h1[\s>]/gi) || []).length;

  check(page + " : canonical present", canonical);
  check(
    page + " : hreflang fr/en/ar/x-default",
    HREFLANG_EXPECTED.every((lang) => hreflangs.includes(lang)),
    hreflangs.join(",") || "aucun"
  );
  check(
    page + " : meta description non vide et <= 155",
    desc.trim().length > 50 && desc.length <= 155,
    desc.length + " caracteres"
  );
  check(
    page + " : Open Graph title/description/image",
    ogTitle && ogDesc && ogImage,
    [ogTitle, ogDesc, ogImage].join("/")
  );
  check(page + " : un seul H1", h1Count === 1, h1Count + " H1");
}

/* --------------------------------------------- 4. sitemap + robots */

const sitemap = read("sitemap.xml");
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

check("sitemap : au moins 5 URLs", locs.length >= 5, locs.length + " URL(s)");
check(
  "sitemap : aucune URL avec .html",
  locs.every((loc) => !/\.html$/i.test(loc))
);
check(
  "sitemap : aucun parametre preview_event",
  !/preview_event/i.test(sitemap)
);
check(
  "sitemap : aucune page noindex",
  locs.every((loc) => {
    const rel = loc.replace(SITE, "");
    const file = rel === "/" ? "index.html" : rel.replace(/^\//, "") + ".html";
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) return false;
    const html = fs.readFileSync(abs, "utf8");
    const robots = html.match(/<meta\s+name="robots"\s+content="([^"]+)"/i);
    return !robots || !/noindex/i.test(robots[1]);
  })
);
check(
  "sitemap : /villes (404) et /inscription-vendeur (noindex) absents",
  !locs.includes(SITE + "/villes") &&
    !locs.some((loc) => loc.startsWith(SITE + "/inscription-vendeur"))
);

const robotsTxt = read("robots.txt");
check("robots.txt : /admin bloque", /^Disallow:\s*\/admin\s*$/m.test(robotsTxt));
check(
  "robots.txt : ?preview_event= bloque",
  /^Disallow:\s*\/\*\?preview_event=\s*$/m.test(robotsTxt)
);
check(
  "robots.txt : sitemap declare",
  /^Sitemap:\s*https:\/\/smartswika\.ma\/sitemap\.xml\s*$/m.test(robotsTxt)
);
check(
  "robots.txt : JS/CSS crawlables (rendu complet)",
  /^Allow:\s*\/js\/\s*$/m.test(robotsTxt) && /^Allow:\s*\/css\/\s*$/m.test(robotsTxt)
);

/* --------------------------------------------- 5. builders produit (ESM) */

function finish() {
  console.log("\n" + verifications + " verification(s), " + echecs + " echec(s)");
  process.exit(echecs === 0 ? 0 : 1);
}

(async () => {
  let seo;
  try {
    seo = await import("../js/structured-data.js");
  } catch (e) {
    check("builders : module importable", false, e.message);
    finish();
    return;
  }
  check("builders : module importable", true);

  const base = {
    name: "Montre connectee Test",
    description: "Description de test.",
    image: "https://smartswika.ma/assets/og-image.jpg",
    sku: "SWK-TEST-01",
    brand: "Smartswika",
    category: "Montres connectees",
    price: 199,
    stock: 5,
    shippingCost: 20,
    url: "https://smartswika.ma/produit?slug=test",
  };

  const p0 = seo.buildProductSchema({ ...base, ratingAvg: 0, ratingCount: 0 });
  check(
    "produit : sans avis -> pas d AggregateRating",
    !!p0 && p0.aggregateRating === undefined
  );
  const p1 = seo.buildProductSchema({ ...base, ratingAvg: 0, ratingCount: 3 });
  check(
    "produit : note 0 -> pas d AggregateRating",
    !!p1 && p1.aggregateRating === undefined
  );
  const p2 = seo.buildProductSchema({ ...base, ratingAvg: 4.5, ratingCount: 2 });
  check(
    "produit : avis valides -> AggregateRating",
    !!p2 &&
      !!p2.aggregateRating &&
      p2.aggregateRating.reviewCount === 2 &&
      p2.aggregateRating.ratingValue === 4.5
  );
  check(
    "produit : note hors 1-5 refusee",
    seo.hasValidAggregateRating({ ratingAvg: 6, ratingCount: 2 }) === false
  );

  const offer = p2 && p2.offers;
  check("produit : Offer presente", !!offer);
  check("produit : devise MAD", !!offer && offer.priceCurrency === "MAD");
  check("produit : prix numerique", !!offer && Number(offer.price) === 199);
  check(
    "produit : etat NewCondition",
    !!offer && offer.itemCondition === "https://schema.org/NewCondition"
  );
  check(
    "produit : InStock",
    !!offer && offer.availability === "https://schema.org/InStock"
  );
  check(
    "produit : livraison Maroc",
    !!offer &&
      !!offer.shippingDetails &&
      !!offer.shippingDetails.shippingDestination &&
      offer.shippingDetails.shippingDestination.addressCountry === "MA"
  );
  check(
    "produit : transit 1-3 jours (24-72h)",
    !!offer &&
      !!offer.shippingDetails &&
      !!offer.shippingDetails.deliveryTime &&
      !!offer.shippingDetails.deliveryTime.transitTime &&
      Number(offer.shippingDetails.deliveryTime.transitTime.maxValue) === 3
  );
  check(
    "produit : retour 15 j Smartswika",
    !!offer &&
      !!offer.hasMerchantReturnPolicy &&
      offer.hasMerchantReturnPolicy.merchantReturnDays === 15
  );
  const pVendor = seo.buildProductSchema({
    ...base,
    isVendor: true,
    ratingAvg: 4,
    ratingCount: 1,
  });
  check(
    "produit : retour 7 j vendeur",
    !!pVendor &&
      pVendor.offers.hasMerchantReturnPolicy.merchantReturnDays === 7
  );
  const pOut = seo.buildProductSchema({
    ...base,
    stock: 0,
    ratingAvg: 0,
    ratingCount: 0,
  });
  check(
    "produit : OutOfStock",
    !!pOut && pOut.offers.availability === "https://schema.org/OutOfStock"
  );

  const crumb = seo.buildProductBreadcrumb({
    ...base,
    homeName: "Accueil",
    categoryName: "Montres connectees",
    productName: base.name,
  });
  check("breadcrumb produit : 3 niveaux", !!crumb && crumb.itemListElement.length === 3);
  check(
    "breadcrumb produit : Accueil > Categorie > Produit",
    !!crumb &&
      crumb.itemListElement[0].name === "Accueil" &&
      crumb.itemListElement[1].name === "Montres connectees" &&
      crumb.itemListElement[2].name === base.name
  );

  const cityService = seo.buildCityDeliveryService("fr", [
    { nameFr: "Casablanca", price: 20 },
    { nameFr: "Oujda", price: 45 },
  ]);
  check(
    "service villes : min/max calcules",
    !!cityService &&
      cityService.offers.priceSpecification.minPrice === 20 &&
      cityService.offers.priceSpecification.maxPrice === 45
  );
  check(
    "service villes : areaServed villes",
    !!cityService &&
      cityService.areaServed.filter((a) => a["@type"] === "City").length === 2
  );

  for (const lang of ["fr", "en", "ar"]) {
    const home = seo.buildOnlineStoreSchema(lang);
    const site = seo.buildWebSiteSchema(lang);
    const faqSchema = seo.buildFaqSchema(lang);
    check(
      "langue " + lang + " : schemas serialisables",
      !!JSON.parse(JSON.stringify(home)) &&
        !!JSON.parse(JSON.stringify(site)) &&
        !!JSON.parse(JSON.stringify(faqSchema))
    );
    check(
      "langue " + lang + " : FAQ localisee",
      faqSchema.mainEntity.length >= 3 &&
        faqSchema.mainEntity.every((q) => q.acceptedAnswer.text.length > 20)
    );
  }

  const allRatings = [];
  [p0, p1, p2, pVendor, pOut].forEach((schema) => {
    if (!schema) return;
    walk(schema, (node) => {
      if (node["@type"] === "AggregateRating") allRatings.push(node);
    });
  });
  check(
    "builder : aggregateRating jamais vide",
    allRatings.every(
      (rating) =>
        Number(rating.ratingValue) > 0 && Number(rating.reviewCount) >= 1
    ),
    allRatings.length + " note(s)"
  );

  finish();
})().catch((e) => {
  check(
    "builders : execution sans exception",
    false,
    e && e.stack ? e.stack : String(e)
  );
  finish();
});
