/* ============================================================
   js/structured-data.js — BALISAGE STRUCTURÉ SCHEMA.ORG (JSON-LD)
   ------------------------------------------------------------
   Module PUR (aucun import, aucune dépendance Firebase) : les
   constructeurs retournent des objets sérialisables et sont donc
   testables hors navigateur (tests/seo-jsonld.test.cjs).

   Couverture :
     - Accueil   : OnlineStore + WebSite(SearchAction) + FAQPage
     - Villes    : BreadcrumbList + Service/DeliveryChargeSpecification
     - Produit   : Product + Offer(shipping/return) + AggregateRating
                   conditionnel + BreadcrumbList (Accueil > Catégorie > Produit)

   Règle Google Rich Results : AggregateRating n'est émis QUE si le
   produit possède au moins 1 avis approuvé (reviewCount >= 1) avec
   une note strictement positive (ratingValue > 0 et <= 5).

   Aucune donnée produit n'est inventée : si le catalogue Firestore
   est vide, aucun JSON-LD Product n'est injecté (la page produit
   reste en soft-404 noindex, voir product-detail.js).
   ============================================================ */

export const SITE_URL = "https://smartswika.ma";
export const STORE_NAME = "Smartswika";
export const STORE_ALT_NAME = "سمارت سويقة";
export const STORE_PHONE = "+212656613303";
export const STORE_EMAIL = "smartswi9a@gmail.com";
export const STORE_LOGO = SITE_URL + "/assets/logo.png";
export const STORE_IMAGE = SITE_URL + "/assets/og-image.jpg";
export const STORE_SAME_AS = [
  "https://www.facebook.com/share/1dWNTuva1K/",
  "https://instagram.com/smartswi9a",
  "https://tiktok.com/@smartswi9a",
  "https://wa.me/212656613303",
];

const SUPPORTED_LANGS = ["fr", "en", "ar"];

/** Normalise une langue vers fr / en / ar (défaut fr). */
export function normalizeLang(lang) {
  return SUPPORTED_LANGS.includes(lang) ? lang : "fr";
}

/* ============================================================
   TEXTES LOCALISÉS (internes au module : aucune clé i18n ajoutée)
   ============================================================ */

const HOME_I18N = {
  fr: {
    storeDescription:
      "Boutique tech marocaine en ligne : gadgets, montres connectées, écouteurs et maison connectée. Livraison 24-72h dans 404 villes du Maroc via Livo, paiement à la livraison en espèces.",
    paymentAccepted: "Cash on Delivery, Paiement à la livraison en espèces",
    faq: [
      {
        q: "Quel est le délai de livraison de Smartswika au Maroc ?",
        a: "Smartswika livre en 24 à 72 heures dans 404 villes du Maroc via notre partenaire Livo. Le délai exact dépend de votre ville et est affiché sur la page Villes de livraison.",
      },
      {
        q: "Peut-on payer à la livraison ?",
        a: "Oui. Le paiement se fait en espèces à la livraison (Cash on Delivery) partout au Maroc. Tous les prix sont affichés en dirham marocain (MAD), sans frais cachés.",
      },
      {
        q: "Quels sont les frais de livraison ?",
        a: "Les frais de livraison correspondent aux tarifs Livo exacts, sans marge ajoutée par Smartswika. Ils commencent à 20 DH et varient selon la ville (environ 20 à 45 DH).",
      },
      {
        q: "Quelle garantie sur les produits Smartswika ?",
        a: "Les produits vendus par Smartswika bénéficient d'une garantie totale de 15 jours : 3 jours pour signaler un problème et 12 jours d'essai.",
      },
      {
        q: "Quelle garantie sur les produits d'un vendeur partenaire ?",
        a: "Les produits vendus par un vendeur partenaire bénéficient d'une garantie totale de 7 jours : 3 jours pour signaler et 4 jours d'essai. Le retour est pris en charge par le vendeur en cas de défaut.",
      },
      {
        q: "Comment fonctionnent les retours et remboursements ?",
        a: "Un produit défectueux ou non conforme est retourné aux frais du vendeur (ou de Smartswika). En cas de changement d'avis, les frais de retour sont à votre charge. Le remboursement intervient après vérification, sous 48 à 72 heures ouvrées.",
      },
    ],
  },
  en: {
    storeDescription:
      "Moroccan online tech store: gadgets, smartwatches, wireless earbuds and smart home. Delivery within 24-72h to 404 Moroccan cities via Livo, cash on delivery.",
    paymentAccepted: "Cash on Delivery",
    faq: [
      {
        q: "How long does Smartswika delivery take in Morocco?",
        a: "Smartswika delivers within 24 to 72 hours to 404 cities across Morocco through our partner Livo. The exact lead time depends on your city and is shown on the Delivery Cities page.",
      },
      {
        q: "Can I pay on delivery?",
        a: "Yes. Payment is cash on delivery (Cash on Delivery) anywhere in Morocco. All prices are shown in Moroccan dirham (MAD) with no hidden fees.",
      },
      {
        q: "How much does delivery cost?",
        a: "Delivery fees are the exact Livo rates with no markup from Smartswika. They start at 20 MAD and vary by city (about 20 to 45 MAD).",
      },
      {
        q: "What warranty applies to Smartswika products?",
        a: "Products sold by Smartswika come with a total 15-day warranty: 3 days to report an issue and 12 days to test the product.",
      },
      {
        q: "What warranty applies to partner vendor products?",
        a: "Products sold by a partner vendor come with a total 7-day warranty: 3 days to report and 4 days to test. The vendor covers returns for defective items.",
      },
      {
        q: "How do returns and refunds work?",
        a: "A defective or non-compliant product is returned at the vendor's (or Smartswika's) expense. For a change of mind, return shipping is at your expense. Refunds are issued after inspection within 48 to 72 business hours.",
      },
    ],
  },
  ar: {
    storeDescription:
      "متجر تقني مغربي على الإنترنت: أدوات، ساعات ذكية، سماعات لاسلكية ومنزل ذكي. التوصيل خلال 24-72 ساعة إلى 404 مدينة مغربية عبر ليفو، والدفع نقدًا عند الاستلام.",
    paymentAccepted: "الدفع نقدًا عند الاستلام",
    faq: [
      {
        q: "كم تستغرق مدة التوصيل من سمارت سويقة في المغرب؟",
        a: "توصّل سمارت سويقة خلال 24 إلى 72 ساعة إلى 404 مدينة في المغرب عبر شريكنا ليفو. تعتمد المدة الدقيقة على مدينتك وتظهر في صفحة مدن التوصيل.",
      },
      {
        q: "هل يمكن الدفع عند الاستلام؟",
        a: "نعم. يتم الدفع نقدًا عند الاستلام في جميع أنحاء المغرب. جميع الأسعار بالدرهم المغربي (MAD) دون رسوم خفية.",
      },
      {
        q: "كم تبلغ رسوم التوصيل؟",
        a: "رسوم التوصيل هي أسعار ليفو الحقيقية دون أي هامش من سمارت سويقة. تبدأ من 20 درهمًا وتختلف حسب المدينة (حوالي 20 إلى 45 درهمًا).",
      },
      {
        q: "ما الضمان المطبق على منتجات سمارت سويقة؟",
        a: "تستفيد المنتجات التي تبيعها سمارت سويقة من ضمان إجمالي مدته 15 يومًا: 3 أيام للإبلاغ عن مشكلة و12 يومًا للتجربة.",
      },
      {
        q: "ما الضمان المطبق على منتجات البائع الشريك؟",
        a: "تستفيد المنتجات التي يبيعها بائع شريك من ضمان إجمالي مدته 7 أيام: 3 أيام للإبلاغ و4 أيام للتجربة. يتحمل البائع إرجاع المنتجات المعيبة.",
      },
      {
        q: "كيف تعمل الإرجاع والاسترداد؟",
        a: "يُعاد المنتج المعيب أو غير المطابق على حساب البائع (أو سمارت سويقة). في حالة تغيير الرأي، تكون تكاليف الإرجاع على حسابك. يتم الاسترداد بعد الفحص خلال 48 إلى 72 ساعة عمل.",
      },
    ],
  },
};

const CITIES_I18N = {
  fr: {
    home: "Accueil",
    cities: "Villes de livraison",
    serviceName: "Livraison Livo au Maroc (24-72h)",
    serviceType: "Livraison à domicile avec paiement à la livraison",
    serviceDescription:
      "Livraison en 24 à 72 heures dans 404 villes du Maroc avec paiement en espèces à la livraison, assurée par Livo pour Smartswika.",
    paymentAccepted: "Cash on Delivery, Paiement à la livraison en espèces",
    majorTitle: "Livraison rapide dans les grandes villes du Maroc",
    majorIntro:
      "Retrouvez ci-dessous les délais indicatifs et les frais Livo exacts, sans marge, pour les principales villes desservies. Le paiement se fait en espèces à la livraison.",
    feesTitle: "Frais de livraison Livo exacts, sans marge",
    feesIntro:
      "Chaque tarif affiché correspond au tarif réel facturé par Livo. Smartswika n'ajoute aucune marge. Le paiement est effectué en espèces à la livraison.",
    howTitle: "Comment fonctionne la livraison Livo ?",
    howSteps: [
      "Vous commandez sur Smartswika et choisissez votre ville.",
      "Smartswika prépare votre colis dans son entrepôt.",
      "Livo récupère le colis et le livre en 24 à 72 heures.",
      "Vous payez en espèces à la livraison, après réception du colis.",
    ],
    cityTemplate:
      "Livraison en {delay} à {city} — frais Livo exacts {price} DH, paiement en espèces à la livraison.",
  },
  en: {
    home: "Home",
    cities: "Delivery cities",
    serviceName: "Livo delivery in Morocco (24-72h)",
    serviceType: "Home delivery with cash on delivery",
    serviceDescription:
      "Delivery within 24 to 72 hours to 404 cities in Morocco with cash on delivery, operated by Livo for Smartswika.",
    paymentAccepted: "Cash on Delivery",
    majorTitle: "Fast delivery in major Moroccan cities",
    majorIntro:
      "Below are indicative lead times and exact Livo fees, with no markup, for the main cities we serve. Payment is cash on delivery.",
    feesTitle: "Exact Livo delivery fees, no markup",
    feesIntro:
      "Every price shown is the actual rate charged by Livo. Smartswika adds no markup. Payment is made in cash on delivery.",
    howTitle: "How does Livo delivery work?",
    howSteps: [
      "You order on Smartswika and choose your city.",
      "Smartswika prepares your parcel in its warehouse.",
      "Livo picks up the parcel and delivers it within 24 to 72 hours.",
      "You pay in cash on delivery, after receiving the parcel.",
    ],
    cityTemplate:
      "Delivery in {delay} to {city} — exact Livo fee {price} MAD, cash on delivery.",
  },
  ar: {
    home: "الرئيسية",
    cities: "مدن التوصيل",
    serviceName: "توصيل ليفو في المغرب (24-72 ساعة)",
    serviceType: "التوصيل إلى المنزل مع الدفع عند الاستلام",
    serviceDescription:
      "التوصيل خلال 24 إلى 72 ساعة إلى 404 مدينة في المغرب مع الدفع نقدًا عند الاستلام، تنفذه ليفو لصالح سمارت سويقة.",
    paymentAccepted: "الدفع نقدًا عند الاستلام",
    majorTitle: "توصيل سريع في المدن المغربية الكبرى",
    majorIntro:
      "فيما يلي المدد الإرشادية ورسوم ليفو الدقيقة دون أي هامش لأهم المدن المخدومة. يتم الدفع نقدًا عند الاستلام.",
    feesTitle: "رسوم التوصيل الدقيقة من ليفو دون هامش",
    feesIntro:
      "كل سعر معروض هو التعريفة الفعلية التي تفرضها ليفو. لا تضيف سمارت سويقة أي هامش. يتم الدفع نقدًا عند الاستلام.",
    howTitle: "كيف يعمل التوصيل عبر ليفو؟",
    howSteps: [
      "تطلب من سمارت سويقة وتختار مدينتك.",
      "تجهّز سمارت سويقة طلبك في مستودعها.",
      "تستلم ليفو الطلب وتوصله خلال 24 إلى 72 ساعة.",
      "تدفع نقدًا عند الاستلام بعد استلام الطلب.",
    ],
    cityTemplate:
      "التوصيل خلال {delay} إلى {city} — رسوم ليفو الدقيقة {price} درهم، والدفع نقدًا عند الاستلام.",
  },
};

/* 10 villes prioritaires (tarifs Livo exacts, sans marge).
   Source : villes.json (404 villes) — voir scripts/rebuild-villes-from-livo.cjs. */
export const MAJOR_CITIES = [
  { name: "Casablanca", price: 20, delay: "24h" },
  { name: "Rabat", price: 35, delay: "48h" },
  { name: "Marrakech", price: 35, delay: "48h" },
  { name: "Tanger", price: 35, delay: "48h" },
  { name: "Fès", price: 35, delay: "48h" },
  { name: "Agadir", price: 35, delay: "48h" },
  { name: "Meknès", price: 40, delay: "48h" },
  { name: "Kénitra", price: 40, delay: "48h" },
  { name: "Tétouan", price: 35, delay: "48h" },
  { name: "Oujda", price: 45, delay: "72h" },
];

/** Retourne le libellé localisé des textes Villes (pour le rendu HTML). */
export function getCitiesCopy(lang) {
  return CITIES_I18N[normalizeLang(lang)];
}

/* ============================================================
   CONSTRUCTEURS — ACCUEIL
   ============================================================ */

/** OnlineStore : fiche marchand (nom, logo, téléphone, devise, zone, paiement). */
export function buildOnlineStoreSchema(lang = "fr") {
  const copy = HOME_I18N[normalizeLang(lang)];
  return {
    "@context": "https://schema.org",
    "@type": "OnlineStore",
    "@id": SITE_URL + "/#store",
    name: STORE_NAME,
    alternateName: STORE_ALT_NAME,
    url: SITE_URL + "/",
    logo: {
      "@type": "ImageObject",
      "@id": SITE_URL + "/#logo",
      url: STORE_LOGO,
      width: 512,
      height: 512,
    },
    image: STORE_IMAGE,
    description: copy.storeDescription,
    telephone: STORE_PHONE,
    email: STORE_EMAIL,
    currenciesAccepted: "MAD",
    paymentAccepted: copy.paymentAccepted,
    areaServed: "MA",
    address: {
      "@type": "PostalAddress",
      addressCountry: "MA",
    },
    contactPoint: {
      "@type": "ContactPoint",
      telephone: STORE_PHONE,
      contactType: "customer service",
      areaServed: "MA",
      availableLanguage: ["Arabic", "French", "English"],
    },
    sameAs: STORE_SAME_AS.slice(),
  };
}

/** WebSite + SearchAction (sitelinks search box). */
export function buildWebSiteSchema(lang = "fr") {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": SITE_URL + "/#website",
    name: STORE_NAME,
    alternateName: STORE_ALT_NAME,
    url: SITE_URL + "/",
    inLanguage: ["fr", "ar", "en"],
    publisher: { "@id": SITE_URL + "/#store" },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: SITE_URL + "/?search={search_term_string}",
      },
      "query-input": "required name=search_term_string",
    },
  };
}

/** FAQPage : engagements et CGV (livraison, paiement, garanties, retours). */
export function buildFaqSchema(lang = "fr") {
  const copy = HOME_I18N[normalizeLang(lang)];
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": SITE_URL + "/#faq",
    inLanguage: normalizeLang(lang),
    mainEntity: copy.faq.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.a,
      },
    })),
  };
}

/* ============================================================
   CONSTRUCTEURS — VILLES
   ============================================================ */

/** Fil d'Ariane : Accueil > Villes de livraison. */
export function buildCitiesBreadcrumb(lang = "fr") {
  const copy = CITIES_I18N[normalizeLang(lang)];
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "@id": SITE_URL + "/villesmaroc#breadcrumb",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: copy.home,
        item: SITE_URL + "/",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: copy.cities,
        item: SITE_URL + "/villesmaroc",
      },
    ],
  };
}

/**
 * Service de livraison + DeliveryChargeSpecification (Livo 24-72h, COD).
 * @param {string} lang
 * @param {Array<Object>} cities
 */
export function buildCityDeliveryService(lang = "fr", cities = []) {
  const copy = CITIES_I18N[normalizeLang(lang)];
  const source = Array.isArray(cities) && cities.length ? cities : MAJOR_CITIES;
  const seen = new Set();
  const normalized = [];

  for (const city of source) {
    if (!city) continue;
    const name = String(
      city.name || city.nameFr || city.nameEn || city.key || ""
    ).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const price = Number(city.price);
    normalized.push({
      name,
      price: Number.isFinite(price) && price > 0 ? price : null,
    });
  }

  const prices = normalized
    .map((city) => city.price)
    .filter((price) => typeof price === "number");
  const minPrice = prices.length ? Math.min(...prices) : 20;
  const maxPrice = prices.length ? Math.max(...prices) : 45;

  const areaServed = [{ "@type": "Country", name: "MA" }].concat(
    normalized.map((city) => ({ "@type": "City", name: city.name }))
  );

  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": SITE_URL + "/villesmaroc#delivery-service",
    name: copy.serviceName,
    serviceType: copy.serviceType,
    description: copy.serviceDescription,
    inLanguage: normalizeLang(lang),
    provider: {
      "@type": "OnlineStore",
      "@id": SITE_URL + "/#store",
      name: STORE_NAME,
      url: SITE_URL + "/",
      telephone: STORE_PHONE,
    },
    areaServed,
    availableChannel: {
      "@type": "ServiceChannel",
      serviceUrl: SITE_URL + "/villesmaroc",
      servicePhone: STORE_PHONE,
      availableLanguage: ["fr", "ar", "en"],
    },
    offers: {
      "@type": "Offer",
      priceCurrency: "MAD",
      availability: "https://schema.org/InStock",
      priceSpecification: {
        "@type": "DeliveryChargeSpecification",
        priceCurrency: "MAD",
        minPrice,
        maxPrice,
        eligibleRegion: { "@type": "Country", name: "MA" },
        appliesToDeliveryMethod: "https://schema.org/ParcelService",
      },
    },
    paymentAccepted: copy.paymentAccepted,
    termsOfService: SITE_URL + "/cgu-acheteur",
  };
}

/* ============================================================
   CONSTRUCTEURS — PRODUIT
   ============================================================ */

/** Un AggregateRating n'est valide que s'il existe au moins 1 avis noté > 0. */
export function hasValidAggregateRating(product) {
  if (!product) return false;
  const count = Number(product.ratingCount) || 0;
  const avg = Number(product.ratingAvg) || 0;
  return count >= 1 && avg > 0 && avg <= 5;
}

/**
 * Product + Offer (prix MAD, dispo, état neuf, livraison Maroc, retour)
 * + AggregateRating conditionnel.
 * @param {Object} product
 * @param {Object} [options]
 * @returns {Object|null} null si le nom du produit est absent.
 */
export function buildProductSchema(product, options = {}) {
  if (!product) return null;
  const name = String(product.name || "").trim();
  if (!name) return null;

  const price = Number(product.price) || 0;
  const stock = Number(product.stock) || 0;
  const shipping = Number(product.shippingCost) || 0;
  const url = product.url || SITE_URL + "/";
  const isVendor = !!(product.isVendor || options.isVendor);
  const returnDays = isVendor ? 7 : 15;

  const rawImage = String(product.image || "").trim();
  const image = /^https?:\/\//i.test(rawImage) ? rawImage : STORE_IMAGE;

  const schema = {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": url + "#product",
    name,
    description: String(product.description || name),
    image: [image],
    url,
    brand: {
      "@type": "Brand",
      name: String(product.brand || STORE_NAME),
    },
  };

  if (product.sku) schema.sku = String(product.sku);
  if (product.category) schema.category = String(product.category);

  if (price > 0) {
    schema.offers = {
      "@type": "Offer",
      "@id": url + "#offer",
      url,
      price,
      priceCurrency: "MAD",
      availability:
        stock > 0
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
      seller: {
        "@type": "Organization",
        name: String(product.brand || STORE_NAME),
      },
      shippingDetails: {
        "@type": "OfferShippingDetails",
        shippingDestination: {
          "@type": "DefinedRegion",
          addressCountry: "MA",
        },
        shippingRate: {
          "@type": "MonetaryAmount",
          value: String(shipping),
          currency: "MAD",
        },
        deliveryTime: {
          "@type": "ShippingDeliveryTime",
          handlingTime: {
            "@type": "QuantitativeValue",
            minValue: 0,
            maxValue: 1,
            unitCode: "DAY",
          },
          transitTime: {
            "@type": "QuantitativeValue",
            minValue: 1,
            maxValue: 3,
            unitCode: "DAY",
          },
        },
      },
      hasMerchantReturnPolicy: {
        "@type": "MerchantReturnPolicy",
        applicableCountry: "MA",
        returnPolicyCategory:
          "https://schema.org/MerchantReturnFiniteReturnWindow",
        merchantReturnDays: returnDays,
        returnMethod: "https://schema.org/ReturnByMail",
        returnFees: "https://schema.org/ReturnShippingFees",
      },
    };
  }

  if (hasValidAggregateRating(product)) {
    schema.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Number(product.ratingAvg),
      reviewCount: Number(product.ratingCount),
      bestRating: 5,
      worstRating: 1,
    };
  }

  return schema;
}

/** Fil d'Ariane : Accueil > Catégorie > Produit. */
export function buildProductBreadcrumb(product) {
  if (!product) return null;
  const home = String(product.homeName || "Accueil");
  const category = String(
    product.categoryName || product.category || "Produits"
  );
  const name = String(product.productName || product.name || "Produit");
  const url = product.url || SITE_URL + "/produit";

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "@id": url + "#breadcrumb",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: home,
        item: SITE_URL + "/",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: category,
        item: SITE_URL + "/#produits",
      },
      {
        "@type": "ListItem",
        position: 3,
        name,
        item: url,
      },
    ],
  };
}

/* ============================================================
   APPLICATIONS DOM (upsert par ID : jamais de doublon)
   ============================================================ */

function getDocument() {
  return typeof document !== "undefined" ? document : null;
}

/**
 * Crée ou met à jour un <script type="application/ld+json"> par identifiant.
 * Les éventuels doublons portant le même data-ld-id sont supprimés.
 */
export function upsertJsonLd(id, data) {
  const doc = getDocument();
  if (!doc || !id || data == null) return null;

  let el = doc.getElementById(id);
  if (!el || el.tagName !== "SCRIPT") {
    doc
      .querySelectorAll(
        'script[type="application/ld+json"][data-ld-id="' + id + '"]'
      )
      .forEach((node) => node.remove());
    el = doc.createElement("script");
    el.type = "application/ld+json";
    el.id = id;
    el.setAttribute("data-ld-id", id);
    doc.head.appendChild(el);
  }
  el.textContent = JSON.stringify(data);
  return el;
}

/** Supprime un bloc JSON-LD (par id ou data-ld-id). */
export function removeJsonLd(id) {
  const doc = getDocument();
  if (!doc || !id) return;
  const byId = doc.getElementById(id);
  if (byId) byId.remove();
  doc
    .querySelectorAll(
      'script[type="application/ld+json"][data-ld-id="' + id + '"]'
    )
    .forEach((node) => node.remove());
}

/** Injecte / met à jour les schémas de l'accueil. */
export function applyHomeJsonLd(lang = "fr") {
  const key = normalizeLang(lang);
  upsertJsonLd("ld-onlinestore", buildOnlineStoreSchema(key));
  upsertJsonLd("ld-website", buildWebSiteSchema(key));
  upsertJsonLd("ld-faq", buildFaqSchema(key));
}

/** Injecte / met à jour les schémas de la page Villes (404 villes). */
export function applyCitiesJsonLd(lang = "fr", cities = []) {
  const key = normalizeLang(lang);
  if (Array.isArray(cities) && cities.length && typeof window !== "undefined") {
    window.__seoCities = cities;
  }
  const list =
    Array.isArray(cities) && cities.length
      ? cities
      : typeof window !== "undefined" && Array.isArray(window.__seoCities)
        ? window.__seoCities
        : [];

  upsertJsonLd("ld-cities-breadcrumb", buildCitiesBreadcrumb(key));
  upsertJsonLd("ld-delivery-service", buildCityDeliveryService(key, list));
}

/** Injecte / met à jour Product + BreadcrumbList d'une fiche réelle. */
export function applyProductJsonLd(product) {
  const schema = buildProductSchema(product);
  if (!schema) {
    clearProductJsonLd();
    return null;
  }
  upsertJsonLd("product-schema-ld", schema);
  const breadcrumb = buildProductBreadcrumb(product);
  if (breadcrumb) upsertJsonLd("breadcrumb-schema", breadcrumb);
  return schema;
}

/** Retire tout JSON-LD produit (soft-404 / produit introuvable). */
export function clearProductJsonLd() {
  removeJsonLd("product-schema-ld");
  removeJsonLd("breadcrumb-schema");
}

function isHomePath() {
  const path =
    typeof window !== "undefined" && window.location
      ? window.location.pathname || "/"
      : "/";
  return path === "/" || path === "" || path.endsWith("/index.html");
}

function isCitiesPath() {
  const path =
    typeof window !== "undefined" && window.location
      ? window.location.pathname || "/"
      : "/";
  return (
    path === "/villesmaroc" ||
    path.endsWith("/villesmaroc") ||
    path.endsWith("villesmaroc.html")
  );
}

/**
 * Initialise les schémas de page (accueil / villes) et les ré-applique
 * au changement de langue. La fiche produit est gérée séparément par
 * product-detail.js (données asynchrones).
 */
export function initStructuredData(lang = "fr") {
  const doc = getDocument();
  if (!doc) return;

  const render = (value) => {
    const key = normalizeLang(value);
    if (isHomePath()) applyHomeJsonLd(key);
    else if (isCitiesPath()) applyCitiesJsonLd(key);
  };

  render(lang);

  doc.addEventListener("lang-changed", (event) => {
    render(event && event.detail ? event.detail.lang : lang);
  });
}
