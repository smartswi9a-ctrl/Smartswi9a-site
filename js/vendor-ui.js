/* ============================================================
   js/vendor-ui.js — ESPACE VENDEUR MODERNE (2026-11-25)
   ------------------------------------------------------------
   Trilingue FR/EN/AR + RTL, layout desktop/tablette/mobile,
   compteurs KPI animes, reglages Chart.js, cloche de notifications
   in-app et traduction des rendus dynamiques.
   Aucun ID existant n'est modifie.
   ============================================================ */

const VENDOR_LANGS = ["fr", "en", "ar"];
const VENDOR_LANG_KEY = "swi9a_lang";
const VENDOR_SIDEBAR_KEY = "swi9a_vendor_sidebar_collapsed";

let currentVendorLang = "fr";
let translating = false;
let mutationTimer = null;

const VENDOR_I18N = {
  fr: {
    skipToContent: "Aller au contenu principal",
    groupPilotage: "Pilotage",
    groupCatalog: "Catalogue",
    groupLogistics: "Logistique & Ventes",
    groupFinance: "Finance",
    groupShop: "Boutique",
    navOverview: "Vue d'ensemble",
    navProducts: "Mes Produits & Stock Entrepôt",
    navFlash: "Ventes Flash",
    navKoulchi: "Koulchi dialk",
    navStock: "Demandes de Ramassage Entrepôt",
    navOrders: "Mes Commandes",
    navWallet: "Mes Revenus & Retraits Wafacash",
    navGuide: "Paramètres Boutique & Contrat",
    supportHint: "Support 7/7 · WhatsApp",
    logout: "Déconnexion",
    menuOpen: "Ouvrir le menu",
    menuClose: "Fermer le menu",
    sidebarToggleLabel: "Réduire ou afficher la navigation",
    settingsShopTitle: "Boutique & contrat",
    settingsShopName: "Nom de la boutique",
    settingsStatus: "Statut du compte",
    settingsShipping: "Mode logistique",
    settingsContract: "Contrat vendeur",
    statusActive: "Actif",
    statusAwaitingWarehouse: "En attente entrepôt",
    wfTitle: "Débloquez la publication de vos produits",
    wfIntro: "Le stock vendeur est stocké à l'entrepôt Smart Swika. Suivez ces 3 étapes pour activer l'ajout de produits.",
    wfStep1Title: "Créer une demande de ramassage",
    wfStep1Desc: "Déclarez vos produits et quantités à remettre à l'entrepôt.",
    wfStep2Title: "Réception et contrôle à l'entrepôt",
    wfStep2Desc: "L'équipe Smart Swika vérifie et réceptionne physiquement la marchandise.",
    wfStep3Title: "Déblocage automatique",
    wfStep3Desc: "L'ajout de produits est débloqué dès que la réception est confirmée.",
    wfCtaPickup: "Créer ma demande de ramassage",
    wfWaiting: "En attente de réception",
    wfReceived: "Réception validée",
    kpiNet: "Revenus Nets Vendeur",
    kpiNetSub: "Après commission 7 % · MAD",
    kpiGross: "Chiffre d'affaires Brut",
    kpiGrossSub: "Ventes livrées · MAD",
    kpiOrders: "Commandes Livrées vs En cours",
    kpiOrdersSub: "Livrées / en cours",
    kpiStock: "Stock à l'entrepôt Smart Swika",
    kpiStockSub: "Unités disponibles",
    chartSalesTitle: "Évolution des ventes et revenus nets (MAD)",
    chartOrdersTitle: "Répartition de mes commandes par statut",
    chartTopTitle: "Top produits les plus vendus",
    chartTotalOrders: "commandes",
    chartTotalUnits: "unités",
    grossSeries: "CA brut",
    netSeries: "Revenus nets",
    statusPreparing: "En préparation",
    statusShipping: "En livraison Livo",
    statusDelivered: "Livrées",
    statusReturned: "Retournées",
    period7: "7j",
    period30: "30j",
    period90: "90j",
    noData: "Aucune donnée sur la période",
    lockedTitle: "Publication verrouillée",
    lockedDesc: "Votre marchandise doit d'abord être reçue et contrôlée à l'entrepôt Smart Swika avant de pouvoir publier un produit.",
    lockedCta: "Voir mes demandes de ramassage",
    newProduct: "Nouveau produit",
    edit: "Éditer",
    delete: "Supprimer",
    loading: "Chargement...",
    error: "Erreur",
    notifTitle: "Notifications",
    notifEmpty: "Aucune notification pour le moment.",
    notifOrders: "commandes en attente",
    notifPickup: "demandes de ramassage à suivre",
    notifProducts: "produits à valider ou stock faible",
    confirmDeleteProduct: "Supprimer définitivement ce produit ?",
    confirmDeleteTitle: "Supprimer",
    cancel: "Annuler",
    qtyLabel: "Quantité",
    netRevenueLabel: "Revenus nets",
    stockLabel: "Stock",
    copyAdLink: "📣 Copier lien pub",
    adLinkCopied: "Lien publicitaire copié",
    adLinkCopyFailed: "Copie impossible. Réessayez.",
  },
  en: {
    skipToContent: "Skip to main content",
    groupPilotage: "Overview",
    groupCatalog: "Catalog",
    groupLogistics: "Logistics & Sales",
    groupFinance: "Finance",
    groupShop: "Shop",
    navOverview: "Dashboard",
    navProducts: "My Products & Warehouse Stock",
    navFlash: "Flash Sales",
    navKoulchi: "Koulchi dialk",
    navStock: "Warehouse Pickup Requests",
    navOrders: "My Orders",
    navWallet: "My Earnings & Wafacash Payouts",
    navGuide: "Shop Settings & Contract",
    supportHint: "Support 7/7 · WhatsApp",
    logout: "Sign out",
    menuOpen: "Open menu",
    menuClose: "Close menu",
    sidebarToggleLabel: "Collapse or expand navigation",
    settingsShopTitle: "Shop & contract",
    settingsShopName: "Shop name",
    settingsStatus: "Account status",
    settingsShipping: "Shipping mode",
    settingsContract: "Vendor contract",
    statusActive: "Active",
    statusAwaitingWarehouse: "Awaiting warehouse",
    wfTitle: "Unlock product publishing",
    wfIntro: "Vendor stock is stored at the Smart Swika warehouse. Follow these 3 steps to enable product creation.",
    wfStep1Title: "Create a pickup request",
    wfStep1Desc: "Declare the products and quantities you will hand over to the warehouse.",
    wfStep2Title: "Warehouse receipt and inspection",
    wfStep2Desc: "The Smart Swika team checks and physically receives the goods.",
    wfStep3Title: "Automatic unlock",
    wfStep3Desc: "Product creation is unlocked as soon as the receipt is confirmed.",
    wfCtaPickup: "Create my pickup request",
    wfWaiting: "Awaiting receipt",
    wfReceived: "Receipt confirmed",
    kpiNet: "Vendor net revenue",
    kpiNetSub: "After 7% commission · MAD",
    kpiGross: "Gross revenue",
    kpiGrossSub: "Delivered sales · MAD",
    kpiOrders: "Delivered vs in-progress orders",
    kpiOrdersSub: "Delivered / in progress",
    kpiStock: "Smart Swika warehouse stock",
    kpiStockSub: "Available units",
    chartSalesTitle: "Sales and net revenue trend (MAD)",
    chartOrdersTitle: "My orders by status",
    chartTopTitle: "Top selling products",
    chartTotalOrders: "orders",
    chartTotalUnits: "units",
    grossSeries: "Gross revenue",
    netSeries: "Net revenue",
    statusPreparing: "Preparing",
    statusShipping: "In Livo delivery",
    statusDelivered: "Delivered",
    statusReturned: "Returned",
    period7: "7d",
    period30: "30d",
    period90: "90d",
    noData: "No data for this period",
    lockedTitle: "Publishing locked",
    lockedDesc: "Your goods must first be received and inspected at the Smart Swika warehouse before you can publish a product.",
    lockedCta: "View my pickup requests",
    newProduct: "New product",
    edit: "Edit",
    delete: "Delete",
    loading: "Loading...",
    error: "Error",
    notifTitle: "Notifications",
    notifEmpty: "No notification for now.",
    notifOrders: "pending orders",
    notifPickup: "pickup requests to follow",
    notifProducts: "products to approve or low stock",
    confirmDeleteProduct: "Permanently delete this product?",
    confirmDeleteTitle: "Delete",
    cancel: "Cancel",
    qtyLabel: "Quantity",
    netRevenueLabel: "Net revenue",
    stockLabel: "Stock",
    copyAdLink: "📣 Copy ad link",
    adLinkCopied: "Advertising link copied",
    adLinkCopyFailed: "Copy failed. Please retry.",
  },
  ar: {
    skipToContent: "انتقل إلى المحتوى",
    groupPilotage: "نظرة عامة",
    groupCatalog: "الكتالوج",
    groupLogistics: "اللوجستيك والمبيعات",
    groupFinance: "المالية",
    groupShop: "المتجر",
    navOverview: "لوحة التحكم",
    navProducts: "منتجاتي ومخزون المستودع",
    navFlash: "التخفيضات السريعة",
    navKoulchi: "كولشي ديالك",
    navStock: "طلبات جمع المستودع",
    navOrders: "طلباتي",
    navWallet: "أرباحي وسحوبات وفاكاش",
    navGuide: "إعدادات المتجر والعقد",
    supportHint: "الدعم 7/7 · واتساب",
    logout: "تسجيل الخروج",
    menuOpen: "افتح القائمة",
    menuClose: "أغلق القائمة",
    sidebarToggleLabel: "طي أو توسيع التنقل",
    settingsShopTitle: "المتجر والعقد",
    settingsShopName: "اسم المتجر",
    settingsStatus: "حالة الحساب",
    settingsShipping: "وضع اللوجستيك",
    settingsContract: "عقد البائع",
    statusActive: "نشط",
    statusAwaitingWarehouse: "بانتظار المستودع",
    wfTitle: "فعّل نشر منتجاتك",
    wfIntro: "يُخزَّن مخزون البائع في مستودع سمارت سويقة. اتبع هذه الخطوات الثلاث لتفعيل إضافة المنتجات.",
    wfStep1Title: "إنشاء طلب جمع",
    wfStep1Desc: "صرّح بالمنتجات والكميات التي ستسلّمها إلى المستودع.",
    wfStep2Title: "الاستلام والمراقبة في المستودع",
    wfStep2Desc: "يتحقق فريق سمارت سويقة ويستلم البضاعة فعليًا.",
    wfStep3Title: "التفعيل التلقائي",
    wfStep3Desc: "يُفعَّل إضافة المنتجات بمجرد تأكيد الاستلام.",
    wfCtaPickup: "إنشاء طلب الجمع",
    wfWaiting: "في انتظار الاستلام",
    wfReceived: "تم تأكيد الاستلام",
    kpiNet: "صافي أرباح البائع",
    kpiNetSub: "بعد عمولة 7% · درهم",
    kpiGross: "رقم المعاملات الإجمالي",
    kpiGrossSub: "المبيعات المسلّمة · درهم",
    kpiOrders: "الطلبات المسلّمة مقابل الجارية",
    kpiOrdersSub: "مسلّمة / جارية",
    kpiStock: "المخزون في مستودع سمارت سويقة",
    kpiStockSub: "وحدات متاحة",
    chartSalesTitle: "تطور المبيعات وصافي الأرباح (درهم)",
    chartOrdersTitle: "توزيع طلباتي حسب الحالة",
    chartTopTitle: "أكثر المنتجات مبيعًا",
    chartTotalOrders: "طلبات",
    chartTotalUnits: "وحدات",
    grossSeries: "الإيرادات الإجمالية",
    netSeries: "صافي الأرباح",
    statusPreparing: "قيد التحضير",
    statusShipping: "قيد التوصيل عبر ليفو",
    statusDelivered: "تم التسليم",
    statusReturned: "مرتجعة",
    period7: "7أ",
    period30: "30أ",
    period90: "90أ",
    noData: "لا توجد بيانات لهذه الفترة",
    lockedTitle: "النشر مقفل",
    lockedDesc: "يجب أولاً استلام بضاعتك وفحصها في مستودع سمارت سويقة قبل نشر أي منتج.",
    lockedCta: "عرض طلبات الجمع",
    newProduct: "منتج جديد",
    edit: "تعديل",
    delete: "حذف",
    loading: "جارٍ التحميل...",
    error: "خطأ",
    notifTitle: "الإشعارات",
    notifEmpty: "لا توجد إشعارات حاليًا.",
    notifOrders: "طلبات في الانتظار",
    notifPickup: "طلبات جمع للمتابعة",
    notifProducts: "منتجات للموافقة أو مخزون منخفض",
    confirmDeleteProduct: "حذف هذا المنتج نهائيًا؟",
    confirmDeleteTitle: "حذف",
    cancel: "إلغاء",
    qtyLabel: "الكمية",
    netRevenueLabel: "صافي الأرباح",
    stockLabel: "المخزون",
    copyAdLink: "📣 نسخ رابط الإعلان",
    adLinkCopied: "تم نسخ رابط الإعلان",
    adLinkCopyFailed: "تعذر النسخ. أعد المحاولة.",
  },
};

/* ============================================================
   PHRASES DYNAMIQUES (rendues par vendor-dashboard.js)
   ============================================================ */
const VENDOR_PHRASES = {
  "Nouveau produit": { en: "New product", ar: "منتج جديد" },
  "Éditer": { en: "Edit", ar: "تعديل" },
  "Supprimer": { en: "Delete", ar: "حذف" },
  "Charger plus": { en: "Load more", ar: "تحميل المزيد" },
  "Mettre à jour": { en: "Update", ar: "تحديث" },
  "Envoyer pour validation": { en: "Submit for approval", ar: "إرسال للموافقة" },
  "Éditer le produit": { en: "Edit product", ar: "تعديل المنتج" },
  "Brut :": { en: "Gross:", ar: "الإجمالي:" },
  "Com.": { en: "Fee", ar: "العمولة" },
  "Net :": { en: "Net:", ar: "الصافي:" },
  "Stock :": { en: "Stock:", ar: "المخزون:" },
  "Aucun mouvement de portefeuille pour le moment.": {
    en: "No wallet movement for now.",
    ar: "لا توجد حركات في المحفظة حاليًا.",
  },
  "Dette à régulariser :": { en: "Debt to settle:", ar: "دين يجب تسويته:" },
  "Solde virtuel (après demandes en cours) :": {
    en: "Virtual balance (after pending requests):",
    ar: "الرصيد الافتراضي (بعد الطلبات الجارية):",
  },
  "Numéro de transfert :": { en: "Transfer number:", ar: "رقم التحويل:" },
  "Motif :": { en: "Reason:", ar: "السبب:" },
  "En attente de déblocage": { en: "Pending release", ar: "في انتظار التحرير" },
  "Confirmé": { en: "Confirmed", ar: "مؤكد" },
  "Aucune demande de retrait pour le moment.": {
    en: "No withdrawal request for now.",
    ar: "لا يوجد طلب سحب حاليًا.",
  },
  "Aucune demande pour le moment.": {
    en: "No request for now.",
    ar: "لا يوجد طلب حاليًا.",
  },
  "Aucune unité reçue : pas d'étiquette à imprimer.": {
    en: "No received unit: no label to print.",
    ar: "لا توجد وحدة مستلمة: لا توجد ملصقات للطباعة.",
  },
  "Stock mis à jour.": { en: "Stock updated.", ar: "تم تحديث المخزون." },
  "Produit envoyé pour validation admin.": {
    en: "Product submitted for admin approval.",
    ar: "تم إرسال المنتج لموافقة الإدارة.",
  },
  "Le formulaire produit sera débloqué dès que Smart Swika confirme la réception de vos marchandises à l’entrepôt.": {
    en: "The product form will unlock as soon as Smart Swika confirms receipt of your goods at the warehouse.",
    ar: "سيتم تفعيل نموذج المنتج بمجرد أن تؤكد سمارت سويقة استلام بضاعتك في المستودع.",
  },
  "Aucun ramassage approuvé disponible": {
    en: "No approved pickup available",
    ar: "لا يوجد جمع موافق عليه",
  },
  "La commission est celle indiquée dans votre contrat (taux affiché sur le dashboard).": {
    en: "The commission is the one stated in your contract (rate shown on the dashboard).",
    ar: "العمولة هي المذكورة في عقدك (النسبة المعروضة في لوحة التحكم).",
  },
};

/* ============================================================
   HELPERS
   ============================================================ */
function normalizeVendorLang(lang) {
  return VENDOR_LANGS.includes(lang) ? lang : "fr";
}

export function vendorT(key, fallback) {
  const lang = currentVendorLang;
  /* Nos libelles vendeur priment sur les cles globales du site
     (ex. navProducts existe aussi dans translations.js). */
  if (VENDOR_I18N[lang] && VENDOR_I18N[lang][key] !== undefined) {
    return VENDOR_I18N[lang][key];
  }
  const central = window.translations && window.translations[lang];
  if (central && central[key] !== undefined && central[key] !== null) return central[key];
  return VENDOR_I18N.fr[key] || fallback || key;
}

export function getVendorLang() {
  return currentVendorLang;
}

export function vendorFormatMAD(value) {
  const locale = currentVendorLang === "ar" ? "ar-MA" : currentVendorLang === "en" ? "en-GB" : "fr-FR";
  const num = Number(value) || 0;
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(num) + " MAD";
  } catch (e) {
    return num + " MAD";
  }
}

export async function copyVendorText(value) {
  const text = String(value || "");
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      /* repli ci-dessous */
    }
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "readonly");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

function readVendorLang() {
  try {
    const urlLang = new URLSearchParams(window.location.search).get("lang");
    if (VENDOR_LANGS.includes(urlLang)) return urlLang;
  } catch (e) { /* ignore */ }
  try {
    const raw = localStorage.getItem(VENDOR_LANG_KEY);
    if (raw) {
      let parsed = raw;
      try { parsed = JSON.parse(raw); } catch (e) { /* raw string */ }
      if (VENDOR_LANGS.includes(parsed)) return parsed;
    }
  } catch (e) { /* ignore */ }
  const select = document.getElementById("langSelect");
  if (select && VENDOR_LANGS.includes(select.value)) return select.value;
  const htmlLang = (document.documentElement.lang || "").toLowerCase();
  if (VENDOR_LANGS.includes(htmlLang)) return htmlLang;
  const nav = (navigator.language || "fr").split("-")[0].toLowerCase();
  return VENDOR_LANGS.includes(nav) ? nav : "fr";
}

/* ============================================================
   TRADUCTION DOM
   ============================================================ */
function translateVendorTextNode(node) {
  const current = node.nodeValue || "";
  if (currentVendorLang === "fr") {
    if (node.__vendorFrSource) {
      node.nodeValue = node.__vendorFrSource;
      delete node.__vendorFrSource;
    }
    return;
  }
  const source = node.__vendorFrSource || current;
  const trimmed = source.trim();
  const entry = VENDOR_PHRASES[trimmed];
  if (!entry) return;
  const translated = entry[currentVendorLang];
  if (!translated) return;
  node.__vendorFrSource = source;
  const next = source.replace(trimmed, translated);
  if (next !== current) node.nodeValue = next;
}

export function translateVendorDom(root = document.body) {
  if (!root || translating) return;
  translating = true;
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        return (node.nodeValue || "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(translateVendorTextNode);
    root.querySelectorAll("input[placeholder], textarea[placeholder]").forEach((el) => {
      const current = el.getAttribute("placeholder") || "";
      if (currentVendorLang === "fr") {
        if (el.dataset.vendorFrPlaceholder) {
          el.setAttribute("placeholder", el.dataset.vendorFrPlaceholder);
          delete el.dataset.vendorFrPlaceholder;
        }
        return;
      }
      const source = el.dataset.vendorFrPlaceholder || current;
      const trimmed = source.trim();
      const entry = VENDOR_PHRASES[trimmed];
      if (!entry || !entry[currentVendorLang]) return;
      el.dataset.vendorFrPlaceholder = source;
      el.setAttribute("placeholder", source.replace(trimmed, entry[currentVendorLang]));
    });
  } finally {
    translating = false;
  }
}

export function applyVendorStaticTranslations(root = document) {
  root.querySelectorAll("[data-vendor-i18n]").forEach((el) => {
    const key = el.getAttribute("data-vendor-i18n");
    if (!key) return;
    const value = vendorT(key);
    if (value && value !== key) el.textContent = value;
  });

  /* En mode replie (72px), les libelles sont masques : on conserve
     un nom accessible et une infobulle explicite sur chaque onglet. */
  root.querySelectorAll(".v-nav-link[data-tab]").forEach((btn) => {
    const label = btn.querySelector(".v-nav-label");
    const text = (label && label.textContent ? label.textContent : "").trim();
    if (text) {
      btn.setAttribute("aria-label", text);
      btn.setAttribute("title", text);
    }
  });
}

export function applyVendorLang(lang, { persist = true, notify = true } = {}) {
  currentVendorLang = normalizeVendorLang(lang);
  document.documentElement.lang = currentVendorLang;
  document.documentElement.dir = currentVendorLang === "ar" ? "rtl" : "ltr";

  if (persist) {
    try { localStorage.setItem(VENDOR_LANG_KEY, JSON.stringify(currentVendorLang)); } catch (e) { /* ignore */ }
  }
  const select = document.getElementById("langSelect");
  if (select && select.value !== currentVendorLang) select.value = currentVendorLang;

  applyVendorStaticTranslations(document);
  translateVendorDom(document.body);

  if (notify) {
    document.dispatchEvent(
      new CustomEvent("vendor-lang-changed", { detail: { lang: currentVendorLang } })
    );
  }
}

/* ============================================================
   LAYOUT (desktop / tablette / mobile)
   ============================================================ */
const vMqMobile = window.matchMedia("(max-width: 767px)");
const vMqTablet = window.matchMedia("(min-width: 768px) and (max-width: 1023px)");

/**
 * Le tiroir mobile s'ouvre sous la Topbar sticky : on mesure sa hauteur
 * pour positionner la sidebar et laisser le bouton menu accessible.
 */
function syncVendorTopbarOffset() {
  const topbar = document.querySelector(".v-topbar");
  const height = topbar ? Math.ceil(topbar.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty(
    "--v-topbar-offset",
    `${Math.max(64, height + 20)}px`
  );
}

function initVendorLayout() {
  const layout = document.getElementById("vLayout");
  if (!layout) return;
  const toggle = document.getElementById("vSidebarToggle");
  const sidebar = document.getElementById("vSidebar");
  const overlay = document.getElementById("vOverlay");
  const mobileToggle = document.getElementById("vMobileToggle");
  const topbar = document.querySelector(".v-topbar");

  const setDrawerOpen = (open) => {
    sidebar?.classList.toggle("open", open);
    overlay?.classList.toggle("open", open);
    document.body.classList.toggle("v-drawer-open", open);
    if (mobileToggle) {
      mobileToggle.setAttribute("aria-expanded", open ? "true" : "false");
      mobileToggle.setAttribute("aria-label", vendorT(open ? "menuClose" : "menuOpen"));
    }
    if (open) syncVendorTopbarOffset();
  };

  const closeDrawer = () => setDrawerOpen(false);

  const applyDefault = () => {
    layout.classList.remove("v-collapsed", "v-expanded");
    setDrawerOpen(false);
    if (!vMqMobile.matches && !vMqTablet.matches) {
      try {
        if (localStorage.getItem(VENDOR_SIDEBAR_KEY) === "1") layout.classList.add("v-collapsed");
      } catch (e) { /* ignore */ }
    }
    if (toggle) {
      toggle.setAttribute("aria-expanded", layout.classList.contains("v-collapsed") ? "false" : "true");
    }
    syncVendorTopbarOffset();
  };

  const toggleFn = () => {
    if (vMqMobile.matches) {
      closeDrawer();
      return;
    }
    if (vMqTablet.matches) {
      const expanded = layout.classList.toggle("v-expanded");
      mobileToggle?.setAttribute("aria-expanded", expanded ? "true" : "false");
      return;
    }
    const collapsed = layout.classList.toggle("v-collapsed");
    toggle?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    try { localStorage.setItem(VENDOR_SIDEBAR_KEY, collapsed ? "1" : "0"); } catch (e) { /* ignore */ }
  };

  if (toggle) {
    toggle.setAttribute("aria-label", vendorT("sidebarToggleLabel"));
    toggle.setAttribute("aria-expanded", layout.classList.contains("v-collapsed") ? "false" : "true");
    toggle.addEventListener("click", toggleFn);
  }

  /* Menu principal : tiroir mobile ET depliage de la rail tablette.
     Le handler est attache des le shell, avant l'authentification. */
  mobileToggle?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (vMqMobile.matches) {
      setDrawerOpen(!sidebar?.classList.contains("open"));
      return;
    }
    if (vMqTablet.matches) {
      const expanded = layout.classList.toggle("v-expanded");
      mobileToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
  });
  mobileToggle?.setAttribute("aria-label", vendorT("menuOpen"));

  /* Sur mobile, un clic sur un onglet referme le tiroir. */
  document.getElementById("vNav")?.addEventListener("click", (event) => {
    if (!vMqMobile.matches) return;
    if (event.target.closest(".v-nav-link")) closeDrawer();
  });

  overlay?.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });

  const onViewportChange = () => {
    applyDefault();
    syncVendorTopbarOffset();
  };
  if (vMqMobile.addEventListener) {
    vMqMobile.addEventListener("change", onViewportChange);
    vMqTablet.addEventListener("change", onViewportChange);
  } else {
    vMqMobile.addListener(onViewportChange);
    vMqTablet.addListener(onViewportChange);
  }
  window.addEventListener("resize", syncVendorTopbarOffset, { passive: true });
  window.addEventListener("orientationchange", syncVendorTopbarOffset, { passive: true });
  document.addEventListener("vendor-lang-changed", syncVendorTopbarOffset);
  document.addEventListener("lang-changed", syncVendorTopbarOffset);
  if (topbar && "ResizeObserver" in window) {
    try { new ResizeObserver(syncVendorTopbarOffset).observe(topbar); } catch (e) { /* ignore */ }
  }

  applyDefault();
}

/* ============================================================
   COMPTEURS KPI ANIMES (count-up 600ms)
   ============================================================ */
function parseVendorCount(text) {
  const rawText = String(text || "");
  const match = rawText.match(/-?\d[\d\s.,]*/);
  if (!match) return null;
  const raw = match[0].trim();
  const normalized = raw.replace(/\s/g, "").replace(/,/g, ".");
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const decimals = (normalized.split(".")[1] || "").length;
  return {
    value,
    decimals,
    prefix: rawText.slice(0, match.index),
    suffix: rawText.slice(match.index + raw.length),
  };
}

function animateVendorKpi(el) {
  if (!el || el.__vendorAnimating) return;
  const text = (el.textContent || "").trim();
  if (!text || text === "—" || text === "-") return;
  const parsed = parseVendorCount(text);
  if (!parsed) return;
  const key = parsed.value + "|" + parsed.decimals + "|" + parsed.prefix + "|" + parsed.suffix;
  if (el.__vendorCountKey === key) return;
  el.__vendorCountKey = key;
  el.__vendorAnimating = true;

  const duration = 600;
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  const format = (value) => {
    const rounded = parsed.decimals ? Number(value.toFixed(parsed.decimals)) : Math.round(value);
    const str = parsed.decimals ? rounded.toFixed(parsed.decimals) : String(rounded);
    return parsed.prefix + str + parsed.suffix;
  };
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(parsed.value * eased);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      el.textContent = format(parsed.value);
      el.__vendorAnimating = false;
    }
  };
  requestAnimationFrame(step);
}

function animateVendorKpis() {
  document.querySelectorAll("#vTabContent .v-kpi-value").forEach(animateVendorKpi);
}

/* ============================================================
   CHART.JS — REGLAGES GLOBAUX
   ============================================================ */
function initVendorChartDefaults() {
  const Chart = window.Chart;
  if (!Chart) return;
  if (Chart.defaults.font) {
    Chart.defaults.font.family = "'Inter', 'Cairo', system-ui, sans-serif";
    Chart.defaults.font.size = 12;
  }
  Chart.defaults.animation = Object.assign({}, Chart.defaults.animation, { duration: 800 });
  Chart.defaults.responsive = true;
  Chart.defaults.maintainAspectRatio = false;
  if (Chart.defaults.plugins && Chart.defaults.plugins.legend) {
    Chart.defaults.plugins.legend.labels = Object.assign(
      {},
      Chart.defaults.plugins.legend.labels,
      { usePointStyle: true, boxWidth: 8 }
    );
  }
  if (Chart.defaults.plugins && Chart.defaults.plugins.tooltip) {
    Chart.defaults.plugins.tooltip.backgroundColor = "rgba(26, 26, 46, 0.94)";
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
  }
}

/* ============================================================
   NOTIFICATIONS IN-APP
   ============================================================ */
function escapeVendorHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

function readBadgeCount(id) {
  const el = document.getElementById(id);
  if (!el || el.hidden) return 0;
  const value = parseInt(String(el.textContent || "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(value) ? value : 0;
}

function refreshVendorNotifications() {
  const panel = document.getElementById("vNotifPanel");
  const badge = document.getElementById("vNotifBadge");
  if (!panel) return;

  const items = [];
  document.querySelectorAll("#vBanners .v-banner").forEach((banner) => {
    const text = (banner.textContent || "").trim();
    if (text) items.push({ label: text, tab: null });
  });

  const orders = readBadgeCount("navOrdersBadge");
  const pickups = readBadgeCount("navStockBadge");
  const products = readBadgeCount("navProductsBadge");
  if (orders > 0) items.push({ label: `${orders} ${vendorT("notifOrders")}`, tab: "orders" });
  if (pickups > 0) items.push({ label: `${pickups} ${vendorT("notifPickup")}`, tab: "stock" });
  if (products > 0) items.push({ label: `${products} ${vendorT("notifProducts")}`, tab: "products" });

  if (badge) {
    badge.textContent = String(items.length);
    badge.hidden = items.length === 0;
  }

  const rows = items.length
    ? items.map((item) => {
        const goto = item.tab ? ` data-vendor-goto="${item.tab}"` : "";
        return `<button type="button" class="v-notif-item"${goto}>${escapeVendorHtml(item.label)}</button>`;
      }).join("")
    : `<div class="v-notif-empty">${escapeVendorHtml(vendorT("notifEmpty"))}</div>`;

  panel.innerHTML = `<div class="v-notif-title">${escapeVendorHtml(vendorT("notifTitle"))}</div>${rows}`;
}

function initVendorNotifications() {
  const bell = document.getElementById("vNotifBell");
  const panel = document.getElementById("vNotifPanel");
  if (!bell || !panel) return;

  const close = () => {
    panel.hidden = true;
    bell.setAttribute("aria-expanded", "false");
  };

  bell.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    bell.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) refreshVendorNotifications();
  });

  panel.addEventListener("click", (event) => {
    const target = event.target.closest("[data-vendor-goto]");
    if (!target) return;
    const tab = target.getAttribute("data-vendor-goto");
    const nav = document.querySelector(`.v-nav-link[data-tab="${tab}"]`);
    if (nav) nav.click();
    close();
  });

  document.addEventListener("click", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && event.target !== bell) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  refreshVendorNotifications();
}

/* ============================================================
   OBSERVATEUR DOM (KPI + traduction + notifications)
   ============================================================ */
function initVendorObservers() {
  const observer = new MutationObserver(() => {
    if (translating) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      animateVendorKpis();
      if (currentVendorLang !== "fr") translateVendorDom(document.body);
      refreshVendorNotifications();
    }, 120);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  animateVendorKpis();
  refreshVendorNotifications();
}

/* ============================================================
   INITIALISATION
   ============================================================ */
function initVendorUi() {
  applyVendorLang(readVendorLang(), { persist: false, notify: false });
  initVendorChartDefaults();
  initVendorLayout();
  initVendorNotifications();
  initVendorObservers();

  /* vendor-dashboard appelle applyTranslations() (data-i18n) apres nous :
     on reapplique nos libelles modernes pour conserver la charte vendeur. */
  setTimeout(() => applyVendorStaticTranslations(document), 0);
  setTimeout(() => applyVendorStaticTranslations(document), 300);

  window.__vendorT = vendorT;
  window.__vendorGetLang = getVendorLang;
  window.__vendorFormatMAD = vendorFormatMAD;
  window.__vendorCopyText = copyVendorText;
  window.__vendorI18n = {
    t: vendorT,
    apply: applyVendorLang,
    translate: () => translateVendorDom(document.body),
    refreshNotifications: refreshVendorNotifications,
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initVendorUi);
} else {
  initVendorUi();
}
