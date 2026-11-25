/* ============================================================
   js/admin-ui.js — UI ADMIN MODERNE (i18n FR/EN/AR, layout, KPI)
   ------------------------------------------------------------
   Responsabilités :
     1. Support trilingue integral (dictionnaire autonome, localStorage,
        documentElement.lang + dir="rtl", textes statiques + dynamiques).
     2. Sidebar desktop (240px repliable 72px), tablette (72px extensible),
        mobile (drawer + backdrop + hamburger) — 180ms de transition.
     3. Compteurs KPI animes (count-up 600ms).
     4. Reglages Chart.js globaux (animation 800ms, responsive).
     5. Simulateur libre (fonctionne meme si le catalogue est vide).
   Aucun ID DOM existant n'est modifie.
   ============================================================ */

const ADMIN_LANGS = ["fr", "en", "ar"];
const ADMIN_LANG_KEY = "swi9a_admin_lang";
const SIDEBAR_KEY = "swi9a_admin_sidebar_collapsed";

let currentAdminLang = "fr";
let translating = false;
let mutationTimer = null;

/* ============================================================
   DICTIONNAIRE ADMIN (FR)
   ============================================================ */
const ADMIN_I18N = {
  fr: {
    pageTitle: "Administration | Smartswika",
    appTitle: "Administration Smartswika",
    logout: "Déconnexion",
    navTitle: "Navigation",
    groupPilotage: "Pilotage",
    groupCatalog: "Catalogue",
    groupLogistics: "Logistique & Ventes",
    groupCommunity: "Communauté",
    groupFinance: "Finance & Système",
    navDashboard: "Tableau de bord",
    navTraffic: "Trafic",
    navProducts: "Produits",
    navFlash: "Ventes Flash",
    navCoupons: "Codes Promo",
    navOrders: "Commandes",
    navPrep: "Préparation Commandes",
    navLivo: "Livraisons Livo",
    navDisputes: "Litiges / Retours",
    navVendors: "Vendeurs",
    navUsers: "Clients",
    navReviews: "Avis",
    navBlog: "Blog",
    navFinances: "Comptabilité",
    navWallets: "Retraits",
    navNotifications: "Campagnes & Notifications",
    navTools: "Outils",
    kpiProducts: "Produits",
    kpiProductsPending: "Produits à valider",
    kpiOrders: "Commandes",
    kpiClients: "Clients",
    kpiReviewsPending: "Avis en attente",
    kpiOrdersPending: "Commandes en attente",
    kpiRevenue: "Chiffre d'affaires",
    kpiCities: "Villes",
    kpiTrendCatalog: "Catalogue",
    kpiTrendValidate: "À valider",
    kpiTrendAllOrders: "Toutes commandes",
    kpiTrendCommunity: "Communauté",
    kpiTrendModerate: "À modérer",
    kpiTrendProcess: "À traiter",
    kpiTrendDelivered: "Commandes livrées",
    kpiTrendLivo: "Couverture Livo",
    chartRevenueTitle: "Chiffre d'affaires vs Bénéfice NET",
    chartOrdersTitle: "Répartition des commandes par statut",
    chartOrdersTotal: "commandes",
    trafficTitle: "Trafic du site",
    refresh: "Actualiser",
    resetTraffic: "Remettre à zéro",
    groupedPickup: "Demander un ramassage groupé",
    exportCsv: "Exporter CSV",
    vendorsTitle: "Gestion des Vendeurs",
    accOverview: "Vue d'ensemble",
    accPurchases: "Achats",
    accExpenses: "Dépenses",
    accTransactions: "Transactions",
    accReports: "Rapports",
    accSimulator: "Simulateur",
    simParams: "1. Paramètres",
    simAdSpend: "📢 Budget Pub (MAD)",
    simPackaging: "📦 Emballage (MAD)",
    simReturnShipping: "🔄 Frais retour (MAD)",
    simSafetyMargin: "🛡️ Marge sécurité (%)",
    simReturnRate: "📉 Taux retour (%)",
    simProductsTitle: "2. Produits à analyser",
    simTop5: "Top 5",
    simAll: "Tous",
    simProfitable: "Rentables",
    simNone: "Aucun",
    simRun: "Lancer l'analyse",
    simFreeTitle: "Simulation libre (sans produit)",
    simFreeHint: "Le catalogue peut être vide : renseignez simplement un prix de vente et un coût d'achat pour estimer votre marge.",
    simSalePrice: "Prix de vente (MAD)",
    simBuyPrice: "Coût d'achat (MAD)",
    simQty: "Quantité",
    simCalculate: "Calculer",
    simNoProducts: "Aucun produit publié dans le catalogue pour le moment.",
    simNoProductsHint: "La simulation libre reste disponible ci-dessous.",
    loading: "Chargement...",
    confirmDeleteClient: "Supprimer définitivement ce client ?",
    confirmDeleteTitle: "Supprimer le client",
    delete: "Supprimer",
    cancel: "Annuler",
    views: "Vues",
    uniqueVisitors: "Visiteurs uniques",
    revenueSeries: "CA (Livré)",
    netSeries: "Bénéfice NET",
    ordersTotal: "commandes",
    marginUnit: "Marge unitaire",
    marginPct: "Marge %",
    totalProfit: "Profit total",
    roi: "ROI",
    invalidValues: "Valeurs invalides : vérifiez le prix de vente et le coût d'achat.",
    statusPending: "En attente",
    statusConfirmed: "Confirmées",
    statusPreparing: "En préparation",
    statusPrepared: "Prêtes à expédier",
    statusPickupRequested: "Attente ramassage",
    statusPickedUp: "Récupérées",
    statusInTransit: "En cours de livraison",
    statusShipping: "En livraison",
    statusDelivered: "Livrées",
    statusReturned: "Retournées",
    statusCancelled: "Annulées",
    resetTrafficTitle: "🗑️ Remettre le trafic à zéro",
    resetTrafficMessage: "Cette action supprime définitivement toutes les statistiques de trafic : vues, visiteurs uniques et présence. Aucune restauration n'est possible.",
    deleteAll: "Tout supprimer",
    warehouseTitle: "Réception entrepôt",
    warehouseMessage: "Confirmer que la marchandise est physiquement arrivée à l’entrepôt Smart Swika ? Le vendeur pourra alors ajouter ses produits.",
    confirmReceipt: "Confirmer la réception",
    pickupTitle: "Demande de ramassage",
    pickupApproveMessage: "Confirmer que le stock a bien été reçu à l’entrepôt Smart Swika ?",
    pickupRejectMessage: "Refuser cette demande de ramassage ?",
    approve: "Approuver",
    reject: "Refuser",
  },
  en: {
    pageTitle: "Administration | Smartswika",
    appTitle: "Smartswika Admin",
    logout: "Sign out",
    navTitle: "Navigation",
    groupPilotage: "Overview",
    groupCatalog: "Catalog",
    groupLogistics: "Logistics & Sales",
    groupCommunity: "Community",
    groupFinance: "Finance & System",
    navDashboard: "Dashboard",
    navTraffic: "Traffic",
    navProducts: "Products",
    navFlash: "Flash Sales",
    navCoupons: "Promo Codes",
    navOrders: "Orders",
    navPrep: "Order Preparation",
    navLivo: "Livo Deliveries",
    navDisputes: "Disputes / Returns",
    navVendors: "Vendors",
    navUsers: "Customers",
    navReviews: "Reviews",
    navBlog: "Blog",
    navFinances: "Accounting",
    navWallets: "Payouts",
    navNotifications: "Campaigns & Notifications",
    navTools: "Tools",
    kpiProducts: "Products",
    kpiProductsPending: "Products to approve",
    kpiOrders: "Orders",
    kpiClients: "Customers",
    kpiReviewsPending: "Pending reviews",
    kpiOrdersPending: "Pending orders",
    kpiRevenue: "Revenue",
    kpiCities: "Cities",
    kpiTrendCatalog: "Catalog",
    kpiTrendValidate: "To approve",
    kpiTrendAllOrders: "All orders",
    kpiTrendCommunity: "Community",
    kpiTrendModerate: "To moderate",
    kpiTrendProcess: "To process",
    kpiTrendDelivered: "Delivered orders",
    kpiTrendLivo: "Livo coverage",
    chartRevenueTitle: "Revenue vs NET profit",
    chartOrdersTitle: "Orders by status",
    chartOrdersTotal: "orders",
    trafficTitle: "Site traffic",
    refresh: "Refresh",
    resetTraffic: "Reset",
    groupedPickup: "Request grouped pickup",
    exportCsv: "Export CSV",
    vendorsTitle: "Vendor management",
    accOverview: "Overview",
    accPurchases: "Purchases",
    accExpenses: "Expenses",
    accTransactions: "Transactions",
    accReports: "Reports",
    accSimulator: "Simulator",
    simParams: "1. Parameters",
    simAdSpend: "📢 Ad budget (MAD)",
    simPackaging: "📦 Packaging (MAD)",
    simReturnShipping: "🔄 Return shipping (MAD)",
    simSafetyMargin: "🛡️ Safety margin (%)",
    simReturnRate: "📉 Return rate (%)",
    simProductsTitle: "2. Products to analyse",
    simTop5: "Top 5",
    simAll: "All",
    simProfitable: "Profitable",
    simNone: "None",
    simRun: "Run analysis",
    simFreeTitle: "Free simulation (no product)",
    simFreeHint: "The catalog may be empty: just enter a sale price and a purchase cost to estimate your margin.",
    simSalePrice: "Sale price (MAD)",
    simBuyPrice: "Purchase cost (MAD)",
    simQty: "Quantity",
    simCalculate: "Calculate",
    simNoProducts: "No product published in the catalog yet.",
    simNoProductsHint: "The free simulation remains available below.",
    loading: "Loading...",
    confirmDeleteClient: "Permanently delete this customer?",
    confirmDeleteTitle: "Delete customer",
    delete: "Delete",
    cancel: "Cancel",
    views: "Views",
    uniqueVisitors: "Unique visitors",
    revenueSeries: "Revenue (Delivered)",
    netSeries: "NET profit",
    ordersTotal: "orders",
    marginUnit: "Unit margin",
    marginPct: "Margin %",
    totalProfit: "Total profit",
    roi: "ROI",
    invalidValues: "Invalid values: check the sale price and the purchase cost.",
    statusPending: "Pending",
    statusConfirmed: "Confirmed",
    statusPreparing: "Preparing",
    statusPrepared: "Ready to ship",
    statusPickupRequested: "Awaiting pickup",
    statusPickedUp: "Picked up",
    statusInTransit: "In transit",
    statusShipping: "Shipping",
    statusDelivered: "Delivered",
    statusReturned: "Returned",
    statusCancelled: "Cancelled",
    resetTrafficTitle: "🗑️ Reset traffic data",
    resetTrafficMessage: "This permanently deletes all traffic statistics: views, unique visitors and presence. It cannot be undone.",
    deleteAll: "Delete all",
    warehouseTitle: "Warehouse receipt",
    warehouseMessage: "Confirm that the goods physically arrived at the Smart Swika warehouse? The vendor will then be able to add products.",
    confirmReceipt: "Confirm receipt",
    pickupTitle: "Pickup request",
    pickupApproveMessage: "Confirm that the stock was received at the Smart Swika warehouse?",
    pickupRejectMessage: "Reject this pickup request?",
    approve: "Approve",
    reject: "Reject",
  },
  ar: {
    pageTitle: "الإدارة | سمارت سويقة",
    appTitle: "إدارة سمارت سويقة",
    logout: "تسجيل الخروج",
    navTitle: "التنقل",
    groupPilotage: "القيادة",
    groupCatalog: "الكتالوج",
    groupLogistics: "اللوجستيك والمبيعات",
    groupCommunity: "المجتمع",
    groupFinance: "المالية والنظام",
    navDashboard: "لوحة التحكم",
    navTraffic: "الزيارات",
    navProducts: "المنتجات",
    navFlash: "التخفيضات السريعة",
    navCoupons: "أكواد الخصم",
    navOrders: "الطلبات",
    navPrep: "تحضير الطلبات",
    navLivo: "توصيلات ليفو",
    navDisputes: "النزاعات / الإرجاع",
    navVendors: "البائعون",
    navUsers: "العملاء",
    navReviews: "التقييمات",
    navBlog: "المدونة",
    navFinances: "المحاسبة",
    navWallets: "السحوبات",
    navNotifications: "الحملات والإشعارات",
    navTools: "الأدوات",
    kpiProducts: "المنتجات",
    kpiProductsPending: "منتجات بانتظار الموافقة",
    kpiOrders: "الطلبات",
    kpiClients: "العملاء",
    kpiReviewsPending: "تقييمات معلقة",
    kpiOrdersPending: "طلبات معلقة",
    kpiRevenue: "الإيرادات",
    kpiCities: "المدن",
    kpiTrendCatalog: "الكتالوج",
    kpiTrendValidate: "للموافقة",
    kpiTrendAllOrders: "كل الطلبات",
    kpiTrendCommunity: "المجتمع",
    kpiTrendModerate: "للإشراف",
    kpiTrendProcess: "للمعالجة",
    kpiTrendDelivered: "طلبات مسلّمة",
    kpiTrendLivo: "تغطية ليفو",
    chartRevenueTitle: "الإيرادات مقابل الربح الصافي",
    chartOrdersTitle: "توزيع الطلبات حسب الحالة",
    chartOrdersTotal: "طلبات",
    trafficTitle: "زيارات الموقع",
    refresh: "تحديث",
    resetTraffic: "إعادة التصفير",
    groupedPickup: "طلب جمع مجمّع",
    exportCsv: "تصدير CSV",
    vendorsTitle: "إدارة البائعين",
    accOverview: "نظرة عامة",
    accPurchases: "المشتريات",
    accExpenses: "المصاريف",
    accTransactions: "المعاملات",
    accReports: "التقارير",
    accSimulator: "المحاكي",
    simParams: "1. المعطيات",
    simAdSpend: "📢 ميزانية الإعلان (درهم)",
    simPackaging: "📦 التغليف (درهم)",
    simReturnShipping: "🔄 مصاريف الإرجاع (درهم)",
    simSafetyMargin: "🛡️ هامش الأمان (%)",
    simReturnRate: "📉 نسبة الإرجاع (%)",
    simProductsTitle: "2. المنتجات للتحليل",
    simTop5: "أفضل 5",
    simAll: "الكل",
    simProfitable: "مربحة",
    simNone: "لا شيء",
    simRun: "تشغيل التحليل",
    simFreeTitle: "محاكاة حرة (بدون منتج)",
    simFreeHint: "قد يكون الكتالوج فارغًا: أدخل سعر البيع وتكلفة الشراء لتقدير هامشك.",
    simSalePrice: "سعر البيع (درهم)",
    simBuyPrice: "تكلفة الشراء (درهم)",
    simQty: "الكمية",
    simCalculate: "احسب",
    simNoProducts: "لا يوجد منتج منشور في الكتالوج حاليًا.",
    simNoProductsHint: "تبقى المحاكاة الحرة متاحة أدناه.",
    loading: "جارٍ التحميل...",
    confirmDeleteClient: "هل تريد حذف هذا العميل نهائيًا؟",
    confirmDeleteTitle: "حذف العميل",
    delete: "حذف",
    cancel: "إلغاء",
    views: "المشاهدات",
    uniqueVisitors: "زوار فريدون",
    revenueSeries: "الإيرادات (المسلّمة)",
    netSeries: "الربح الصافي",
    ordersTotal: "طلبات",
    marginUnit: "الهامش للوحدة",
    marginPct: "الهامش %",
    totalProfit: "الربح الإجمالي",
    roi: "العائد",
    invalidValues: "قيم غير صالحة: تحقق من سعر البيع وتكلفة الشراء.",
    statusPending: "في الانتظار",
    statusConfirmed: "مؤكدة",
    statusPreparing: "قيد التحضير",
    statusPrepared: "جاهزة للشحن",
    statusPickupRequested: "بانتظار الجمع",
    statusPickedUp: "تم استلامها",
    statusInTransit: "قيد التوصيل",
    statusShipping: "قيد التسليم",
    statusDelivered: "تم التسليم",
    statusReturned: "مرتجعة",
    statusCancelled: "ملغاة",
    resetTrafficTitle: "🗑️ إعادة تصفير بيانات الزيارات",
    resetTrafficMessage: "سيؤدي هذا الإجراء إلى حذف جميع إحصائيات الزيارات نهائيًا: المشاهدات والزوار الفريدون والحضور. لا يمكن التراجع.",
    deleteAll: "حذف الكل",
    warehouseTitle: "استلام المستودع",
    warehouseMessage: "تأكيد وصول البضاعة فعليًا إلى مستودع سمارت سويقة؟ سيتمكن البائع بعد ذلك من إضافة منتجاته.",
    confirmReceipt: "تأكيد الاستلام",
    pickupTitle: "طلب جمع",
    pickupApproveMessage: "تأكيد استلام المخزون في مستودع سمارت سويقة؟",
    pickupRejectMessage: "رفض طلب الجمع هذا؟",
    approve: "موافقة",
    reject: "رفض",
  },
};

/* ============================================================
   PHRASES DYNAMIQUES (rendues par admin.js, sans data-attribute)
   ============================================================ */
const PHRASES = {
  "Chargement...": { en: "Loading...", ar: "جارٍ التحميل..." },
  "Chargement…": { en: "Loading…", ar: "جارٍ التحميل…" },
  "Aucun client.": { en: "No customers.", ar: "لا يوجد عملاء." },
  "Aucun produit trouvé.": { en: "No product found.", ar: "لم يتم العثور على منتج." },
  "Aucune demande de ramassage en attente.": {
    en: "No pending pickup request.",
    ar: "لا يوجد طلب جمع قيد الانتظار.",
  },
  "Impossible de charger les demandes de ramassage.": {
    en: "Unable to load pickup requests.",
    ar: "تعذر تحميل طلبات الجمع.",
  },
  "Date :": { en: "Date:", ar: "التاريخ:" },
  "déclaré :": { en: "declared:", ar: "المعلن:" },
  "reçu :": { en: "received:", ar: "المستلم:" },
  "Approuver le ramassage": { en: "Approve pickup", ar: "الموافقة على الجمع" },
  "Refuser": { en: "Reject", ar: "رفض" },
  "Confirmer réception entrepôt": { en: "Confirm warehouse receipt", ar: "تأكيد استلام المستودع" },
  "Réception entrepôt confirmée": { en: "Warehouse receipt confirmed", ar: "تم تأكيد استلام المستودع" },
  "Produit": { en: "Product", ar: "المنتج" },
  "Prix Achat": { en: "Purchase price", ar: "سعر الشراء" },
  "Prix Vente": { en: "Sale price", ar: "سعر البيع" },
  "Marge Nette": { en: "Net margin", ar: "الهامش الصافي" },
  "CPA Max": { en: "Max CPA", ar: "أقصى تكلفة اكتساب" },
  "Stock": { en: "Stock", ar: "المخزون" },
  "Profit": { en: "Profit", ar: "الربح" },
  "ROI": { en: "ROI", ar: "العائد" },
  "Verdict": { en: "Verdict", ar: "الحكم" },
  "Tous": { en: "All", ar: "الكل" },
  "Tous les statuts": { en: "All statuses", ar: "كل الحالات" },
  "Chiffre d'affaires": { en: "Revenue", ar: "الإيرادات" },
  "Bénéfice NET": { en: "NET profit", ar: "الربح الصافي" },
  "Marge nette": { en: "Net margin", ar: "الهامش الصافي" },
  "Marge Brute": { en: "Gross margin", ar: "الهامش الإجمالي" },
  "COGS": { en: "COGS", ar: "تكلفة البضاعة" },
  "Frais livraison": { en: "Delivery fees", ar: "رسوم التوصيل" },
  "Publicité": { en: "Advertising", ar: "الإعلانات" },
  "Autres dépenses": { en: "Other expenses", ar: "مصاريف أخرى" },
  "Autres revenus": { en: "Other income", ar: "إيرادات أخرى" },
  "Livraison": { en: "Delivery", ar: "التوصيل" },
  "Pub": { en: "Ads", ar: "الإعلان" },
  "Autres dép.": { en: "Other exp.", ar: "مصاريف أخرى" },
  "Autres rev.": { en: "Other inc.", ar: "إيرادات أخرى" },
  "En attente": { en: "Pending", ar: "في الانتظار" },
  "Confirmées": { en: "Confirmed", ar: "مؤكدة" },
  "En préparation": { en: "Preparing", ar: "قيد التحضير" },
  "Prêtes à expédier": { en: "Ready to ship", ar: "جاهزة للشحن" },
  "Attente ramassage": { en: "Awaiting pickup", ar: "بانتظار الجمع" },
  "Récupérées": { en: "Picked up", ar: "تم استلامها" },
  "En cours de livraison": { en: "Out for delivery", ar: "قيد التوصيل" },
  "Livrées": { en: "Delivered", ar: "تم التسليم" },
  "Retournées": { en: "Returned", ar: "مرتجعة" },
  "Annulées": { en: "Cancelled", ar: "ملغاة" },
  "Supprimer": { en: "Delete", ar: "حذف" },
  "Annuler": { en: "Cancel", ar: "إلغاء" },
  "Rechercher...": { en: "Search...", ar: "بحث..." },
  "🔍 Rechercher...": { en: "🔍 Search...", ar: "🔍 بحث..." },
  "🔍 Rechercher par boutique, email ou téléphone...": {
    en: "🔍 Search by shop, email or phone...",
    ar: "🔍 ابحث بالمتجر أو البريد أو الهاتف...",
  },
};

/* Deuxieme lot : filtres, statuts et titres rendus dynamiquement. */
Object.assign(PHRASES, {
  "⏳ En attente": { en: "⏳ Pending", ar: "⏳ في الانتظار" },
  "✅ Confirmées": { en: "✅ Confirmed", ar: "✅ مؤكدة" },
  "🧩 En préparation": { en: "🧩 Preparing", ar: "🧩 قيد التحضير" },
  "📦 Prêtes à expédier": { en: "📦 Ready to ship", ar: "📦 جاهزة للشحن" },
  "🚚 Attente ramassage": { en: "🚚 Awaiting pickup", ar: "🚚 بانتظار الجمع" },
  "🤝 Récupérées": { en: "🤝 Picked up", ar: "🤝 تم استلامها" },
  "🛣️ En cours de livraison": { en: "🛣️ Out for delivery", ar: "🛣️ قيد التوصيل" },
  "🚚 En livraison (legacy)": { en: "🚚 Shipping (legacy)", ar: "🚚 قيد التسليم (قديم)" },
  "✔️ Livrées": { en: "✔️ Delivered", ar: "✔️ تم التسليم" },
  "↩️ Retournées": { en: "↩️ Returned", ar: "↩️ مرتجعة" },
  "❌ Annulées": { en: "❌ Cancelled", ar: "❌ ملغاة" },
  "✅ Approuvés": { en: "✅ Approved", ar: "✅ موافق عليهم" },
  "🚫 Suspendus": { en: "🚫 Suspended", ar: "🚫 موقوفون" },
  "❌ Rejetés": { en: "❌ Rejected", ar: "❌ مرفوضون" },
  "🧹 Suppression à reprendre": { en: "🧹 Deletion to resume", ar: "🧹 حذف يجب استئنافه" },
  "📜 Contrats obsolètes": { en: "📜 Outdated contracts", ar: "📜 عقود قديمة" },
  "📊 Tous": { en: "📊 All", ar: "📊 الكل" },
  "🔐 OTP": { en: "🔐 OTP", ar: "🔐 OTP" },
  "🔵 Google": { en: "🔵 Google", ar: "🔵 Google" },
  "📘 Facebook": { en: "📘 Facebook", ar: "📘 Facebook" },
  "⏳ À expédier": { en: "⏳ To ship", ar: "⏳ للشحن" },
  "🚚 En cours": { en: "🚚 In progress", ar: "🚚 قيد التنفيذ" },
  "📦 Livrés": { en: "📦 Delivered", ar: "📦 تم التسليم" },
  "↩️ Retournés": { en: "↩️ Returned", ar: "↩️ مرتجعة" },
  "✅ Payés": { en: "✅ Paid", ar: "✅ مدفوعة" },
  "Période": { en: "Period", ar: "الفترة" },
  "14 jours": { en: "14 days", ar: "14 يومًا" },
  "30 jours": { en: "30 days", ar: "30 يومًا" },
  "90 jours": { en: "90 days", ar: "90 يومًا" },
  "🟢 Visiteurs en ligne par page": { en: "🟢 Online visitors by page", ar: "🟢 الزوار المتصلون حسب الصفحة" },
  "📈 Évolution du trafic": { en: "📈 Traffic trend", ar: "📈 تطور الزيارات" },
  "📊 14 derniers jours": { en: "📊 Last 14 days", ar: "📊 آخر 14 يومًا" },
});

/* Troisieme lot : titres de sections, boutons et etats vides. */
Object.assign(PHRASES, {
  "💧 Bilan détaillé": { en: "💧 Detailed balance", ar: "💧 الميزان التفصيلي" },
  "📈 Évolution CA": { en: "📈 Revenue trend", ar: "📈 تطور الإيرادات" },
  "📜 Historique": { en: "📜 History", ar: "📜 السجل" },
  "📊 Totaux globaux": { en: "📊 Global totals", ar: "📊 الإجماليات" },
  "📦 Détail par produit": { en: "📦 Product details", ar: "📦 تفاصيل المنتج" },
  "📦 Demandes de ramassage en attente": { en: "📦 Pending pickup requests", ar: "📦 طلبات الجمع المعلقة" },
  "💸 Demandes de Virement": { en: "💸 Payout requests", ar: "💸 طلبات السحب" },
  "💸 Nouvelle transaction": { en: "💸 New transaction", ar: "💸 معاملة جديدة" },
  "📉 Enregistrer une dépense": { en: "📉 Record an expense", ar: "📉 تسجيل مصروف" },
  "📦 Enregistrer un achat": { en: "📦 Record a purchase", ar: "📦 تسجيل عملية شراء" },
  "📈 Générer un rapport": { en: "📈 Generate a report", ar: "📈 إنشاء تقرير" },
  "📊 Générer": { en: "📊 Generate", ar: "📊 إنشاء" },
  "📥 CSV": { en: "📥 CSV", ar: "📥 CSV" },
  "🖨️ Imprimer": { en: "🖨️ Print", ar: "🖨️ طباعة" },
  "👆 Cliquez sur \"Générer\"": { en: "👆 Click \"Generate\"", ar: "👆 انقر على \"إنشاء\"" },
  "🔄 Actualiser": { en: "🔄 Refresh", ar: "🔄 تحديث" },
  "💾 Enregistrer": { en: "💾 Save", ar: "💾 حفظ" },
  "➕ Ajouter un produit": { en: "➕ Add a product", ar: "➕ إضافة منتج" },
  "💾 Enregistrer le produit": { en: "💾 Save product", ar: "💾 حفظ المنتج" },
  "❌ Annuler la modification": { en: "❌ Cancel edit", ar: "❌ إلغاء التعديل" },
  "🔄 Générer les combinaisons": { en: "🔄 Generate combinations", ar: "🔄 إنشاء التوليفات" },
  "📥 Exporter CSV": { en: "📥 Export CSV", ar: "📥 تصدير CSV" },
  "📦 Ramassage": { en: "📦 Pickup", ar: "📦 الجمع" },
  "🔄 Synchroniser": { en: "🔄 Synchronize", ar: "🔄 مزامنة" },
  "🏙️ Synchroniser les villes": { en: "🏙️ Sync cities", ar: "🏙️ مزامنة المدن" },
  "MODE RÉEL": { en: "LIVE MODE", ar: "الوضع المباشر" },
  "Chargement des vendeurs...": { en: "Loading vendors...", ar: "جارٍ تحميل البائعين..." },
  "Aucun produit publié dans le catalogue pour le moment.": {
    en: "No product published in the catalog yet.",
    ar: "لا يوجد منتج منشور في الكتالوج حاليًا.",
  },
});

/* ============================================================
   HELPERS
   ============================================================ */
function normalizeAdminLang(lang) {
  return ADMIN_LANGS.includes(lang) ? lang : "fr";
}

export function adminT(key) {
  const dict = ADMIN_I18N[currentAdminLang] || ADMIN_I18N.fr;
  return dict[key] || ADMIN_I18N.fr[key] || key;
}

export function getAdminLang() {
  return currentAdminLang;
}

function readStoredLang() {
  try {
    const direct = localStorage.getItem(ADMIN_LANG_KEY);
    if (ADMIN_LANGS.includes(direct)) return direct;
    const site = localStorage.getItem("swi9a_lang");
    if (site) {
      let parsed = site;
      try { parsed = JSON.parse(site); } catch (e) { /* raw string */ }
      if (ADMIN_LANGS.includes(parsed)) return parsed;
    }
  } catch (e) { /* storage indisponible */ }
  const nav = (navigator.language || "fr").split("-")[0].toLowerCase();
  return ADMIN_LANGS.includes(nav) ? nav : "fr";
}

/* ============================================================
   TRADUCTION DOM (statique + dynamique)
   ============================================================ */
function translateTextNode(node) {
  const current = node.nodeValue || "";
  if (currentAdminLang === "fr") {
    if (node.__adminFrSource) {
      node.nodeValue = node.__adminFrSource;
      delete node.__adminFrSource;
    }
    return;
  }
  const source = node.__adminFrSource || current;
  const trimmed = source.trim();
  const entry = PHRASES[trimmed];
  if (!entry) return;
  const translated = entry[currentAdminLang];
  if (!translated) return;
  node.__adminFrSource = source;
  const next = source.replace(trimmed, translated);
  if (next !== current) node.nodeValue = next;
}

function translateAttributes(root) {
  root.querySelectorAll("input[placeholder], textarea[placeholder]").forEach((el) => {
    const current = el.getAttribute("placeholder") || "";
    if (currentAdminLang === "fr") {
      if (el.dataset.adminFrPlaceholder) {
        el.setAttribute("placeholder", el.dataset.adminFrPlaceholder);
        delete el.dataset.adminFrPlaceholder;
      }
      return;
    }
    const source = el.dataset.adminFrPlaceholder || current;
    const trimmed = source.trim();
    const entry = PHRASES[trimmed];
    if (!entry || !entry[currentAdminLang]) return;
    el.dataset.adminFrPlaceholder = source;
    el.setAttribute("placeholder", source.replace(trimmed, entry[currentAdminLang]));
  });
}

export function translateAdminDom(root = document.body) {
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
    nodes.forEach(translateTextNode);
    translateAttributes(root);
  } finally {
    translating = false;
  }
}

export function applyStaticTranslations(root = document) {
  root.querySelectorAll("[data-admin-i18n]").forEach((el) => {
    const key = el.getAttribute("data-admin-i18n");
    if (!key) return;
    const value = adminT(key);
    if (!value) return;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.placeholder = value;
    else el.textContent = value;
  });
  root.querySelectorAll("[data-admin-i18n-placeholder]").forEach((el) => {
    const value = adminT(el.getAttribute("data-admin-i18n-placeholder"));
    if (value) el.setAttribute("placeholder", value);
  });
}

/* ============================================================
   APPLICATION DE LA LANGUE
   ============================================================ */
export function applyAdminLang(lang, { persist = true, notify = true } = {}) {
  currentAdminLang = normalizeAdminLang(lang);
  document.documentElement.lang = currentAdminLang;
  document.documentElement.dir = currentAdminLang === "ar" ? "rtl" : "ltr";

  if (persist) {
    try {
      localStorage.setItem(ADMIN_LANG_KEY, currentAdminLang);
      localStorage.setItem("swi9a_lang", JSON.stringify(currentAdminLang));
    } catch (e) { /* ignore */ }
  }

  const select = document.getElementById("adminLangSelect");
  if (select && select.value !== currentAdminLang) select.value = currentAdminLang;

  document.title = adminT("pageTitle");
  applyStaticTranslations(document);
  translateAdminDom(document.body);

  if (notify) {
    document.dispatchEvent(
      new CustomEvent("admin-lang-changed", { detail: { lang: currentAdminLang } })
    );
  }
}

/* ============================================================
   NAVIGATION ADAPTATIVE (desktop / tablette / mobile)
   ============================================================ */
const mqMobile = window.matchMedia("(max-width: 767px)");
const mqTablet = window.matchMedia("(min-width: 768px) and (max-width: 1023px)");

function initAdminLayout() {
  const shell = document.getElementById("adminShell");
  if (!shell) return;
  const backdrop = document.getElementById("adminSidebarBackdrop");
  const menuToggle = document.getElementById("adminMenuToggle");
  const sidebarToggle = document.getElementById("adminSidebarToggle");

  const closeMobile = () => {
    shell.classList.remove("is-open");
    if (backdrop) backdrop.hidden = true;
    menuToggle?.setAttribute("aria-expanded", "false");
  };

  const openMobile = () => {
    shell.classList.add("is-open");
    if (backdrop) backdrop.hidden = false;
    menuToggle?.setAttribute("aria-expanded", "true");
  };

  const applyDefault = () => {
    shell.classList.remove("is-open", "is-expanded", "is-collapsed");
    if (backdrop) backdrop.hidden = true;
    menuToggle?.setAttribute("aria-expanded", "false");
    if (mqMobile.matches) return;
    if (mqTablet.matches) return; /* CSS : 72px par defaut, extensible */
    try {
      if (localStorage.getItem(SIDEBAR_KEY) === "1") shell.classList.add("is-collapsed");
    } catch (e) { /* ignore */ }
  };

  const toggle = () => {
    if (mqMobile.matches) {
      shell.classList.contains("is-open") ? closeMobile() : openMobile();
      return;
    }
    if (mqTablet.matches) {
      shell.classList.toggle("is-expanded");
      return;
    }
    const collapsed = shell.classList.toggle("is-collapsed");
    try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch (e) { /* ignore */ }
  };

  menuToggle?.addEventListener("click", toggle);
  sidebarToggle?.addEventListener("click", toggle);
  backdrop?.addEventListener("click", closeMobile);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMobile();
  });
  document.getElementById("adminTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (!button) return;
    closeMobile();
    document.querySelectorAll("#adminTabs button[data-tab]").forEach((btn) => {
      btn.setAttribute("aria-selected", btn === button ? "true" : "false");
    });
  });

  const onBreakpoint = () => applyDefault();
  if (mqMobile.addEventListener) {
    mqMobile.addEventListener("change", onBreakpoint);
    mqTablet.addEventListener("change", onBreakpoint);
  } else {
    mqMobile.addListener(onBreakpoint);
    mqTablet.addListener(onBreakpoint);
  }
  applyDefault();
}

/* ============================================================
   COMPTEURS KPI ANIMES (count-up 600ms)
   ============================================================ */
const STAT_SELECTOR =
  "#adminStats .stat-value, #accKPIs .stat-value, #tab-traffic .stat-value, #financesResults .stat-value";

function parseCount(text) {
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

function animateStat(el) {
  if (!el || el.__adminAnimating) return;
  const text = (el.textContent || "").trim();
  if (!text || text === "—" || text === "-") return;
  const parsed = parseCount(text);
  if (!parsed) return;
  const key = parsed.value + "|" + parsed.decimals + "|" + parsed.prefix + "|" + parsed.suffix;
  if (el.__adminCountKey === key) return;
  el.__adminCountKey = key;
  el.__adminAnimating = true;

  const duration = 600;
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  const format = (value) => {
    const rounded = parsed.decimals
      ? Number(value.toFixed(parsed.decimals))
      : Math.round(value);
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
      el.__adminAnimating = false;
    }
  };
  requestAnimationFrame(step);
}

function animateAllStats() {
  document.querySelectorAll(STAT_SELECTOR).forEach(animateStat);
  setTimeout(updateNavBadges, 650);
}

function updateNavBadges() {
  const pairs = [
    ["statProductsPending", "navBadgeProducts"],
    ["statOrdersPending", "navBadgeOrders"],
    ["statReviewsPending", "navBadgeReviews"],
  ];
  pairs.forEach(([statId, badgeId]) => {
    const stat = document.getElementById(statId);
    const badge = document.getElementById(badgeId);
    if (!stat || !badge) return;
    const value = parseInt(String(stat.textContent || "").replace(/[^\d]/g, ""), 10);
    if (Number.isFinite(value) && value > 0) {
      badge.textContent = value > 99 ? "99+" : String(value);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  });
}

/* ============================================================
   CHART.JS — REGLAGES GLOBAUX
   ============================================================ */
function initChartDefaults() {
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
   SIMULATEUR LIBRE (fonctionne sans catalogue)
   ============================================================ */
function formatMad(value) {
  const locale =
    currentAdminLang === "ar" ? "ar-MA" : currentAdminLang === "en" ? "en-GB" : "fr-FR";
  const num = Number(value) || 0;
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(num) + " MAD";
  } catch (e) {
    return num + " MAD";
  }
}

function initFreeSimulator() {
  const btn = document.getElementById("finFreeCalcBtn");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";

  const run = () => {
    const sale = Number(document.getElementById("finFreeSalePrice")?.value);
    const buy = Number(document.getElementById("finFreeBuyPrice")?.value);
    const qty = Math.max(1, Number(document.getElementById("finFreeQty")?.value) || 1);
    const out = document.getElementById("finFreeResults");
    if (!out) return;
    if (!Number.isFinite(sale) || !Number.isFinite(buy) || sale <= 0 || buy < 0) {
      out.innerHTML = `<p style="color:var(--danger);font-size:.85rem;margin:0;">${adminT("invalidValues")}</p>`;
      return;
    }
    const unit = sale - buy;
    const pct = (unit / sale) * 100;
    const total = unit * qty;
    const roi = buy > 0 ? (unit / buy) * 100 : 0;
    out.innerHTML = `
      <div class="admin-stat-card"><span class="stat-value">${formatMad(unit)}</span><span class="stat-label">${adminT("marginUnit")}</span></div>
      <div class="admin-stat-card"><span class="stat-value">${pct.toFixed(1)}%</span><span class="stat-label">${adminT("marginPct")}</span></div>
      <div class="admin-stat-card"><span class="stat-value">${formatMad(total)}</span><span class="stat-label">${adminT("totalProfit")}</span></div>
      <div class="admin-stat-card"><span class="stat-value">${roi.toFixed(1)}%</span><span class="stat-label">${adminT("roi")}</span></div>`;
  };

  btn.addEventListener("click", run);
  ["finFreeSalePrice", "finFreeBuyPrice", "finFreeQty"].forEach((id) => {
    document.getElementById(id)?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); run(); }
    });
  });
  run();
}

/* ============================================================
   OBSERVATEUR DOM (KPI + traduction des rendus dynamiques)
   ============================================================ */
function initAdminObservers() {
  const root = document.body;
  const observer = new MutationObserver(() => {
    if (translating) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      animateAllStats();
      if (currentAdminLang !== "fr") translateAdminDom(root);
    }, 120);
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  animateAllStats();
}

/* ============================================================
   INITIALISATION
   ============================================================ */
function initAdminUi() {
  applyAdminLang(readStoredLang(), { persist: false, notify: false });
  initChartDefaults();
  initAdminLayout();
  initFreeSimulator();
  initAdminObservers();

  const select = document.getElementById("adminLangSelect");
  select?.addEventListener("change", (event) => applyAdminLang(event.target.value));

  window.addEventListener("storage", (event) => {
    if (event.key === ADMIN_LANG_KEY && ADMIN_LANGS.includes(event.newValue)) {
      applyAdminLang(event.newValue, { persist: false });
    }
  });

  window.__adminT = adminT;
  window.__adminGetLang = getAdminLang;
  window.__adminFormatMAD = formatMad;
  window.__adminI18n = {
    t: adminT,
    getLang: getAdminLang,
    apply: applyAdminLang,
    translate: () =>
      translateAdminDom(document.getElementById("adminPanel") || document.body),
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAdminUi);
} else {
  initAdminUi();
}
