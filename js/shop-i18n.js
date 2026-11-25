/* ============================================================
   js/shop-i18n.js — libellés vitrine modernes FR / EN / AR
   ------------------------------------------------------------
   Dictionnaire autonome pour les nouveaux composants (filtres,
   badges produits, simulateur Koulchi, blog). Il complète
   translations.js sans modifier les clés historiques.
   ============================================================ */

import { getLang } from "./utils.js";

export const SHOP_I18N = {
  fr: {
    badgeSmart: "✨ Sélection Smartswika · Garantie 15j",
    badgeVendor: "🏪 Vendeur vérifié · Garantie 7j",
    badgeVendorSep: " · ",
    badgeKoulchi: "Éligible Koulchi dialk",
    badgeOptions: "Options",
    pdpBadgeSmart: "✨ Sélection Smartswika · Garantie 15 jours",
    pdpBadgeVendor: "🏪 Vendeur vérifié · Garantie 7 jours",
    pdpBadgeVendorSep: " · ",
    pdpVendorCta: "Voir la boutique",
    pdpCodTitle: "Paiement à la livraison",
    pdpCodDesc: "Vous payez en espèces uniquement à la réception de votre colis.",
    pdpLivoTitle: "Livraison Livo 24-72h",
    pdpLivoDesc: "Expédition suivie dans 404 villes du Maroc.",
    pdpSupportTitle: "Support 7/7",
    pdpSupportDesc: "Une question ? Notre équipe vous répond sur WhatsApp.",
    pdpReassuranceAria: "Garanties Smartswika",
    pdpGalleryAria: "Galerie photos du produit",
    quickAll: "Tous",
    quickNew: "Nouveautés",
    quickPromos: "Promos du moment",
    quickFlash: "Ventes Flash",
    quickSmart: "Sélection Smartswika",
    quickVendors: "Boutiques Vendeurs",
    quickStock: "En stock",
    quickAria: "Filtrer les produits",
    shopAddToCart: "Ajouter au panier",
    shopAdded: "Ajouté ✓",
    shopWhatsApp: "Commander WhatsApp",
    shopOutOfStock: "Rupture de stock",
    shopChooseOptions: "Choisir",
    catalogPreparingTitle: "Nouveautés en cours de préparation dans notre entrepôt",
    catalogPreparingDesc: "Notre prochaine sélection arrive très bientôt. Revenez dans quelques heures.",
    catalogFilterEmpty: "Aucun produit ne correspond à ce filtre.",
    catalogReset: "Réinitialiser les filtres",
    statCities: "Villes livrées",
    statDelivery: "Livraison",
    statWarranty: "Garantie",
    statSupport: "Support",
    koulchiExperienceTitle: "Simulez votre pack Koulchi dialk",
    koulchiExperienceSub: "Ajoutez des articles et voyez la remise grimper en direct.",
    koulchiTier1: "Palier 1",
    koulchiTier1Desc: "3 articles = −5 %",
    koulchiTier2: "Palier 2",
    koulchiTier2Desc: "6 articles = −10 %",
    koulchiTier3: "Palier 3",
    koulchiTier3Desc: "9 articles = −15 %",
    koulchiItems: "articles",
    koulchiAvgBasket: "Panier moyen par article",
    koulchiSubtotal: "Sous-total",
    koulchiSavings: "Vous économisez",
    koulchiTotal: "Total estimé",
    koulchiNextTier: "Plus que {n} article(s) pour atteindre −{p} %",
    koulchiMaxTier: "Palier maximal atteint : −{p} %",
    koulchiSimNote: "Simulation indicative : le calcul final se fait dans le panier.",
    koulchiSimCta: "Voir les offres groupées",
    koulchiFlashExcluded: "Les Ventes Flash sont exclues du cumul Koulchi dialk.",
    koulchiSimQtyAria: "Nombre d'articles dans le pack",
    koulchiSimAvgAria: "Panier moyen par article en MAD",
    koulchiSimPlus: "Ajouter un article",
    koulchiSimMinus: "Retirer un article",
    blogPreviewTag: "Journal tech",
    blogPreviewTitle: "Le journal Smartswika",
    blogPreviewSub: "Conseils, tendances et guides pour mieux choisir vos gadgets au Maroc.",
    blogPreviewCta: "Voir tous les articles",
    blogPreviewEmpty: "Nos premiers articles arrivent bientôt dans le journal.",
    blogFeatured: "À la une",
    blogThemesAria: "Filtrer les articles par thématique",
    blogThemeAll: "Tous",
    blogThemeSmartHome: "Smart Home",
    blogThemeWatchesAudio: "Montres & Audio",
    blogThemeAutoSecurity: "Auto & Sécurité",
    blogThemeGuides: "Guides d'achat Maroc",
    blogReadingProgress: "Progression de lecture",
    blogReadTime: "{min} min de lecture",
    blogReadArticle: "Lire l'article",
    blogHeroBadge: "Article à la une",
    whatsappPrefill: "Bonjour Smartswika, je souhaite commander : {product} — {url}",
    shopAriaAdd: "Ajouter {product} au panier",
    shopAriaWhatsApp: "Commander {product} via WhatsApp",
  },
  en: {
    badgeSmart: "✨ Smartswika Selection · 15-day warranty",
    badgeVendor: "🏪 Verified seller · 7-day warranty",
    badgeVendorSep: " · ",
    badgeKoulchi: "Koulchi dialk eligible",
    badgeOptions: "Options",
    pdpBadgeSmart: "✨ Smartswika Selection · 15-day warranty",
    pdpBadgeVendor: "🏪 Verified seller · 7-day warranty",
    pdpBadgeVendorSep: " · ",
    pdpVendorCta: "View shop",
    pdpCodTitle: "Cash on delivery",
    pdpCodDesc: "You pay in cash only when you receive your parcel.",
    pdpLivoTitle: "Livo delivery 24-72h",
    pdpLivoDesc: "Tracked shipping to 404 cities in Morocco.",
    pdpSupportTitle: "Support 7/7",
    pdpSupportDesc: "A question? Our team answers you on WhatsApp.",
    pdpReassuranceAria: "Smartswika guarantees",
    pdpGalleryAria: "Product photo gallery",
    quickAll: "All",
    quickNew: "New arrivals",
    quickPromos: "Current deals",
    quickFlash: "Flash sales",
    quickSmart: "Smartswika Selection",
    quickVendors: "Seller shops",
    quickStock: "In stock",
    quickAria: "Filter products",
    shopAddToCart: "Add to cart",
    shopAdded: "Added ✓",
    shopWhatsApp: "Order on WhatsApp",
    shopOutOfStock: "Out of stock",
    shopChooseOptions: "Choose",
    catalogPreparingTitle: "New arrivals are being prepared in our warehouse",
    catalogPreparingDesc: "Our next selection is coming very soon. Check back in a few hours.",
    catalogFilterEmpty: "No product matches this filter.",
    catalogReset: "Reset filters",
    statCities: "Cities delivered",
    statDelivery: "Delivery",
    statWarranty: "Warranty",
    statSupport: "Support",
    koulchiExperienceTitle: "Simulate your Koulchi dialk pack",
    koulchiExperienceSub: "Add items and watch the discount grow live.",
    koulchiTier1: "Tier 1",
    koulchiTier1Desc: "3 items = −5%",
    koulchiTier2: "Tier 2",
    koulchiTier2Desc: "6 items = −10%",
    koulchiTier3: "Tier 3",
    koulchiTier3Desc: "9 items = −15%",
    koulchiItems: "items",
    koulchiAvgBasket: "Average price per item",
    koulchiSubtotal: "Subtotal",
    koulchiSavings: "You save",
    koulchiTotal: "Estimated total",
    koulchiNextTier: "{n} more item(s) to reach −{p}%",
    koulchiMaxTier: "Maximum tier reached: −{p}%",
    koulchiSimNote: "Indicative simulation: the final calculation happens in the cart.",
    koulchiSimCta: "View bundle deals",
    koulchiFlashExcluded: "Flash sales are excluded from the Koulchi dialk bundle.",
    koulchiSimQtyAria: "Number of items in the pack",
    koulchiSimAvgAria: "Average price per item in MAD",
    koulchiSimPlus: "Add one item",
    koulchiSimMinus: "Remove one item",
    blogPreviewTag: "Tech journal",
    blogPreviewTitle: "The Smartswika journal",
    blogPreviewSub: "Tips, trends and buying guides to choose your gadgets in Morocco.",
    blogPreviewCta: "View all articles",
    blogPreviewEmpty: "Our first articles are coming soon to the journal.",
    blogFeatured: "Featured",
    blogThemesAria: "Filter articles by theme",
    blogThemeAll: "All",
    blogThemeSmartHome: "Smart Home",
    blogThemeWatchesAudio: "Watches & Audio",
    blogThemeAutoSecurity: "Auto & Security",
    blogThemeGuides: "Morocco buying guides",
    blogReadingProgress: "Reading progress",
    blogReadTime: "{min} min read",
    blogReadArticle: "Read article",
    blogHeroBadge: "Featured article",
    whatsappPrefill: "Hello Smartswika, I would like to order: {product} — {url}",
    shopAriaAdd: "Add {product} to cart",
    shopAriaWhatsApp: "Order {product} on WhatsApp",
  },
  ar: {
    badgeSmart: "✨ اختيار سمارت سويقة · ضمان 15 يومًا",
    badgeVendor: "🏪 بائع موثّق · ضمان 7 أيام",
    badgeVendorSep: " · ",
    badgeKoulchi: "مؤهل لكولشي ديالك",
    badgeOptions: "خيارات",
    pdpBadgeSmart: "✨ اختيار سمارت سويقة · ضمان 15 يومًا",
    pdpBadgeVendor: "🏪 بائع موثّق · ضمان 7 أيام",
    pdpBadgeVendorSep: " · ",
    pdpVendorCta: "زيارة المتجر",
    pdpCodTitle: "الدفع عند الاستلام",
    pdpCodDesc: "تدفع نقدًا فقط عند استلام طلبك.",
    pdpLivoTitle: "توصيل ليفو خلال 24-72 ساعة",
    pdpLivoDesc: "شحن متتبع إلى 404 مدينة في المغرب.",
    pdpSupportTitle: "دعم 7/7",
    pdpSupportDesc: "لديك سؤال؟ فريقنا يجيبك عبر واتساب.",
    pdpReassuranceAria: "ضمانات سمارت سويقة",
    pdpGalleryAria: "معرض صور المنتج",
    quickAll: "الكل",
    quickNew: "وصل حديثًا",
    quickPromos: "عروض اللحظة",
    quickFlash: "تخفيضات سريعة",
    quickSmart: "اختيار سمارت سويقة",
    quickVendors: "متاجر البائعين",
    quickStock: "متوفر",
    quickAria: "تصفية المنتجات",
    shopAddToCart: "أضف إلى السلة",
    shopAdded: "تمت الإضافة ✓",
    shopWhatsApp: "اطلب عبر واتساب",
    shopOutOfStock: "نفد المخزون",
    shopChooseOptions: "اختر",
    catalogPreparingTitle: "الوافدون الجدد قيد التحضير في مستودعنا",
    catalogPreparingDesc: "اختيارتنا القادمة قريبًا جدًا. عد بعد بضع ساعات.",
    catalogFilterEmpty: "لا يوجد منتج يطابق هذا الفلتر.",
    catalogReset: "إعادة ضبط الفلاتر",
    statCities: "مدينة مغطاة",
    statDelivery: "التوصيل",
    statWarranty: "الضمان",
    statSupport: "الدعم",
    koulchiExperienceTitle: "حاكي حزمة كولشي ديالك",
    koulchiExperienceSub: "أضف منتجات وشاهد الخصم يرتفع مباشرة.",
    koulchiTier1: "المستوى 1",
    koulchiTier1Desc: "3 منتجات = −5%",
    koulchiTier2: "المستوى 2",
    koulchiTier2Desc: "6 منتجات = −10%",
    koulchiTier3: "المستوى 3",
    koulchiTier3Desc: "9 منتجات = −15%",
    koulchiItems: "منتجات",
    koulchiAvgBasket: "متوسط سعر المنتج",
    koulchiSubtotal: "المجموع الفرعي",
    koulchiSavings: "توفر",
    koulchiTotal: "الإجمالي التقديري",
    koulchiNextTier: "بقي {n} منتجًا للوصول إلى −{p}%",
    koulchiMaxTier: "تم بلوغ أعلى مستوى: −{p}%",
    koulchiSimNote: "محاكاة إرشادية: الحساب النهائي يتم في السلة.",
    koulchiSimCta: "شاهد العروض الجماعية",
    koulchiFlashExcluded: "التخفيضات السريعة غير قابلة للجمع مع كولشي ديالك.",
    koulchiSimQtyAria: "عدد منتجات الحزمة",
    koulchiSimAvgAria: "متوسط سعر المنتج بالدرهم",
    koulchiSimPlus: "أضف منتجًا",
    koulchiSimMinus: "احذف منتجًا",
    blogPreviewTag: "مجلة التقنية",
    blogPreviewTitle: "مجلة سمارت سويقة",
    blogPreviewSub: "نصائح واتجاهات وأدلة شراء لاختيار أجهزتك في المغرب.",
    blogPreviewCta: "كل المقالات",
    blogPreviewEmpty: "أول مقالاتنا ستصل قريبًا إلى المجلة.",
    blogFeatured: "مميز",
    blogThemesAria: "تصفية المقالات حسب الموضوع",
    blogThemeAll: "الكل",
    blogThemeSmartHome: "المنزل الذكي",
    blogThemeWatchesAudio: "الساعات والصوت",
    blogThemeAutoSecurity: "السيارة والأمان",
    blogThemeGuides: "أدلة الشراء بالمغرب",
    blogReadingProgress: "تقدم القراءة",
    blogReadTime: "{min} د قراءة",
    blogReadArticle: "اقرأ المقال",
    blogHeroBadge: "مقال مميز",
    whatsappPrefill: "مرحبًا سمارت سويقة، أرغب في طلب: {product} — {url}",
    shopAriaAdd: "أضف {product} إلى السلة",
    shopAriaWhatsApp: "اطلب {product} عبر واتساب",
  },
};

function interpolateShop(text, params) {
  if (!params || !text) return text;
  let out = String(text);
  for (const key of Object.keys(params)) {
    out = out.split("{" + key + "}").join(String(params[key]));
  }
  return out;
}

/**
 * Traduit une clé vitrine dans la langue courante.
 * @param {string} key
 * @param {object} [params]
 * @returns {string}
 */
export function shopT(key, params) {
  const lang = getLang();
  const dict = SHOP_I18N[lang] || SHOP_I18N.fr;
  const value = dict[key] !== undefined ? dict[key] : SHOP_I18N.fr[key];
  return interpolateShop(value !== undefined ? value : key, params);
}

/**
 * Applique les libellés aux éléments [data-shop-i18n] de la page.
 * @param {ParentNode} [root]
 */
export function applyShopTranslations(root = document) {
  root.querySelectorAll("[data-shop-i18n]").forEach((el) => {
    const key = el.getAttribute("data-shop-i18n");
    if (!key) return;
    el.textContent = shopT(key);
  });
  root.querySelectorAll("[data-shop-i18n-aria]").forEach((el) => {
    const key = el.getAttribute("data-shop-i18n-aria");
    if (!key) return;
    el.setAttribute("aria-label", shopT(key));
  });
  root.querySelectorAll("[data-shop-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-shop-i18n-placeholder");
    if (!key) return;
    el.setAttribute("placeholder", shopT(key));
  });
}

if (typeof window !== "undefined") {
  window.__shopT = shopT;
}
