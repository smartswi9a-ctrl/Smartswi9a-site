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
    onlineFilter: "🟢 En ligne",
    onlineNow: "🟢 {n} en ligne maintenant",
    presenceOnline: "🟢 Connecté",
    presenceOffline: "🔴 Déconnecté",
    presenceLastSeen: "Dernière activité : {t}",
    presenceNever: "Jamais connecté",
    suspendTitle: "Suspendre le vendeur",
    suspendType: "Type de suspension",
    suspendTemporary: "Temporaire",
    suspendPermanent: "Définitive",
    suspendUntil: "Jusqu'au",
    suspendCause: "Cause de la suspension",
    suspendCausePlaceholder: "Expliquez la cause : elle sera envoyée au vendeur (push + email).",
    suspendConfirm: "Suspendre",
    suspendCauseRequired: "La cause de la suspension est obligatoire.",
    unsuspendTitle: "Annuler la suspension",
    unsuspendMessage: "Réactiver ce vendeur et son catalogue ? Une notification lui sera envoyée.",
    unsuspendConfirm: "Réactiver",
    suspendedCauseLabel: "Cause :",
    suspendedUntilLabel: "Jusqu'au :",
    navAbandoned: "Paniers abandonnés",
    abandonedTitle: "🛒 Paniers abandonnés",
    abandonedSubtitle: "Relancez les paniers non finalisés par WhatsApp ou push gratuit. Paiement à la livraison 24-72h.",
    abandonedRefresh: "Actualiser",
    abandonedRefreshed: "Liste actualisée",
    abandonedKpiAbandoned: "Paniers abandonnés (7j)",
    abandonedKpiAmount: "Montant potentiel",
    abandonedKpiRecovered: "Paniers récupérés",
    abandonedKpiRate: "Taux de récupération",
    abandonedFilterAll: "Tous",
    abandonedFilterPhone: "Avec téléphone (WhatsApp)",
    abandonedFilterPush: "Relancés Push",
    abandonedFilterRecovered: "Récupérés",
    abandonedColClient: "Client / Téléphone",
    abandonedColCity: "Ville",
    abandonedColItems: "Articles",
    abandonedColTotal: "Total MAD",
    abandonedColAge: "Temps écoulé",
    abandonedColStatus: "Statut",
    abandonedColActions: "Actions",
    abandonedWhatsApp: "Relancer WhatsApp",
    abandonedDelete: "Supprimer",
    abandonedConfirmDelete: "Supprimer définitivement ce panier abandonné ?",
    abandonedDeleted: "Panier supprimé",
    abandonedWhatsAppSent: "WhatsApp ouvert — statut mis à jour",
    abandonedEmpty: "Aucun panier dans ce filtre.",
    abandonedStatusActive: "Actif",
    abandonedStatusAbandoned: "Abandonné",
    abandonedStatusPush: "Relancé Push",
    abandonedStatusWhatsapp: "Relancé WhatsApp",
    abandonedStatusRecovered: "Récupéré",
    abandonedNoPhone: "Téléphone manquant",
    abandonedGuest: "Visiteur",
    abandonedArticles: "article(s)",
    abandonedItemsMore: "+{n} autre(s)",
    abandonedBadgeHint: "Paniers abandonnés à relancer",
    abandonedError: "Action impossible. Réessayez.",
    navAds: "Suivi Pubs TikTok & Meta",
    groupMarketing: "Marketing / Ventes",
    adsTitle: "📊 Suivi Pubs TikTok & Meta",
    adsSubtitle: "Attribution first-party 7 jours, pixels TikTok/Meta, ROAS réel (CA livré) et bénéfice net après coût produit + frais Livo.",
    adsConfigTitle: "⚙️ Connexion API, Pixels & Flux Catalogue",
    adsMetaPixel: "Meta Pixel ID (Facebook / Instagram)",
    adsTiktokPixel: "TikTok Pixel ID",
    adsSpendMeta: "Meta (MAD)",
    adsSpendTiktok: "TikTok (MAD)",
    adsSpendOther: "Autres (MAD)",
    adsSpendPeriod: "Dépenses publicitaires — période",
    adsSave: "Enregistrer",
    adsSaved: "Configuration enregistrée",
    adsSaveError: "Enregistrement impossible. Réessayez.",
    adsPixelHint: "Les IDs pixels sont publiés dans config/ads_public (jamais les budgets). Laissez vide pour désactiver un pixel.",
    adsPeriod7: "7 jours",
    adsPeriod30: "30 jours",
    adsPeriodMonth: "Ce mois",
    adsPeriodAll: "Tout",
    adsKpiOrders: "Commandes attribuées (créées / livrées)",
    adsKpiDelivery: "Taux de livraison COD",
    adsKpiRevenue: "CA LIVRÉ (MAD)",
    adsKpiNet: "Bénéfice NET LIVRÉ (MAD)",
    adsKpiRoas: "ROAS Réel",
    adsKpiRoasHint: "CA livré / dépenses pubs",
    adsChartTitle: "CA commandé vs CA livré par canal (MAD)",
    adsChartHint: "Le COD marocain crée un écart : seul le CA livré doit guider les décisions.",
    adsChartCreated: "CA commandé",
    adsChartDelivered: "CA livré",
    adsTableTitle: "Performance par source & campagne",
    adsColChannel: "Canal",
    adsColCampaign: "Campagne (utm_campaign)",
    adsColViews: "Vues produit",
    adsColAddCart: "Ajouts panier",
    adsColOrders: "Cmd créées",
    adsColDelivered: "Cmd livrées",
    adsColDeliveryRate: "Taux livraison COD",
    adsColRevenue: "CA livré (MAD)",
    adsColNet: "Bénéfice net (MAD)",
    adsColSpend: "Dépenses (MAD)",
    adsColRoas: "ROAS réel",
    adsUtmButton: "📋 Copier générateur de lien UTM",
    adsUtmTitle: "Générateur de lien UTM",
    adsUtmChannel: "Canal",
    adsUtmCampaign: "Nom de campagne",
    adsUtmCampaignPlaceholder: "ex. promo-noel-2026",
    adsUtmCopy: "📋 Copier le lien",
    adsUtmCopied: "Lien copié",
    adsUtmCopyError: "Copie impossible : sélectionnez le lien manuellement.",
    adsAllCampaigns: "Toutes campagnes",
    adsNoData: "Aucune donnée sur cette période.",
    adsLoading: "Chargement...",
    adsTableHint: "Vues et ajouts panier sont comptés par canal (compteurs agrégés anonymes). Les dépenses d'un canal sont réparties au prorata du CA livré entre ses campagnes.",
    adsChannelTiktok: "TikTok",
    adsChannelMeta: "Meta",
    adsChannelDirect: "Organique / Direct",
    adsChannelOther: "Autres",
    adsChannelTotal: "Total canal",
    adsRefresh: "Actualiser",
    adsConfigPeriodHint: "Les budgets enregistrés correspondent à la période sélectionnée.",
    adsNoPixel: "Aucun pixel configuré : les événements restent comptés dans Firestore.",
    adsMetaLabel: "Meta / Facebook / Instagram",
    adsTiktokLabel: "TikTok Ads",
    adsChannelBoth: "Duo Meta + TikTok",
    adsBadgeWinning: "Produit Gagnant",
    adsBadgeHighMargin: "Haute Marge",
    adsBadgeStrong: "Fort Potentiel",
    adsSuggestionsTitle: "💡 Campagnes Suggérées par l'IA — Sélection Smartswika",
    adsSuggestionsSubtitle: "Produits officiels Smartswika uniquement (hors vendeurs tiers), scoring marge nette + intérêt visiteur + taux COD réel.",
    adsSuggestionsEmptyTitle: "Aucun produit officiel Smartswika prêt",
    adsSuggestionsEmptyDesc: "Ajoutez ou approuvez un produit Smartswika en stock (sans vendeur tiers) pour générer des recommandations de campagnes.",
    adsSuggestionsGoProducts: "Ouvrir le catalogue produits",
    adsMetricMargin: "Marge nette",
    adsMetricViews: "Vues",
    adsMetricCod: "Taux COD",
    adsSuggestionChannel: "Canal recommandé",
    adsSuggestionBudget: "Budget quotidien (MAD)",
    adsSuggestionPaused: "Lancer en pause (recommandé)",
    adsSuggestionCopy: "Texte publicitaire (éditable)",
    adsLaunchNow: "Lancer la campagne maintenant",
    adsLaunching: "Lancement en cours...",
    adsPreparedMode: "Mode préparation : accroche et lien copiés, Ads Manager ouvert.",
    adsLaunched: "Campagne créée et enregistrée.",
    adsLaunchedPartial: "Campagne partiellement créée : vérifiez les erreurs.",
    adsLaunchError: "Lancement impossible.",
    adsCampaignsTitle: "📡 Mes Campagnes Actives & Pilotage",
    adsCampaignsSubtitle: "Campagnes créées depuis Smartswika, synchronisées Meta / TikTok, avec alerte rentabilité COD.",
    adsCampaignsEmptyTitle: "Aucune campagne lancée",
    adsCampaignsEmptyDesc: "Lancez une campagne suggérée ou connectez vos APIs pour voir le pilotage ici.",
    adsStatusActive: "ACTIVE",
    adsStatusPaused: "PAUSED",
    adsCampaignBudget: "Budget/jour",
    adsPause: "Mettre en pause",
    adsActivate: "Activer",
    adsCampaignOrders: "Commandes",
    adsCampaignDelivered: "Livrées",
    adsCampaignCod: "Taux COD",
    adsCampaignExternal: "ID externe",
    adsCodAlert: "Alerte rentabilité COD : envisager de mettre en pause.",
    adsFeedCopied: "URL du flux copiée",
    adsTesting: "Test en cours...",
    adsNotConfigured: "API non configurée",
    adsConnectionError: "Connexion impossible.",
    adsPixelsSection: "Pixels & vérification de domaine",
    adsApiSection: "Connexion APIs Meta / TikTok",
    adsMetaDomainVerification: "Meta Domain Verification",
    adsMetaAdAccountId: "Meta Ad Account ID",
    adsMetaPageId: "Meta Page ID",
    adsMetaAccessToken: "Meta Access Token (masqué)",
    adsTiktokAdvertiserId: "TikTok Advertiser ID",
    adsTiktokAccessToken: "TikTok Access Token (masqué)",
    adsTestMeta: "Tester connexion Meta",
    adsTestTiktok: "Tester connexion TikTok",
    adsFeedTitle: "📡 Flux Catalogue Produits XML",
    adsFeedCopy: "Copier l'URL du flux",
    adsSecretsHint: "Les tokens API sont stockés dans config/ads_secrets (admin uniquement, jamais publics). Laisser vide conserve le token existant.",
    adsCarouselDefaultName: "Carrousel Smartswika - Top Sélection",
    adsCarouselCount: "{count} / 20 produits sélectionnés",
    adsCarouselGuideTitle: "Carrousel Multi-Produits verrouillé",
    adsCarouselGuideDesc: "Ajoutez au moins 3 produits officiels Smartswika en stock pour débloquer le Carrousel Multi-Produits.",
    adsCarouselCopyLabel: "Accroche",
    adsCarouselTitle: "Campagne Carrousel Multi-Produits (3 à 20 produits)",
    adsCarouselSubtitle: "Sélectionnez 3 à 20 produits officiels Smartswika, prévisualisez le carrousel et lancez Meta/TikTok en un clic.",
    adsCarouselAutoTop10: "Auto-sélectionner le Top 10 Smartswika",
    adsCarouselClear: "Réinitialiser",
    adsCarouselMinRequired: "Minimum 3 produits requis",
    adsCarouselSelectProducts: "Produits du carrousel",
    adsCarouselCampaignName: "Nom de la campagne",
    adsCarouselBudget: "Budget quotidien (MAD)",
    adsCarouselChannel: "Canal",
    adsCarouselPaused: "Lancer en pause (recommandé pour vérification visuelle)",
    adsCarouselPreview: "Aperçu horizontal du carrousel",
    adsCarouselMetaHint: "Meta affiche jusqu'à 10 cartes ; les 20 produits restent enregistrés dans la campagne.",
    adsCarouselLaunch: "Lancer la campagne carrousel",
    adsCarouselPreviewEmpty: "Sélectionnez des produits pour prévisualiser le carrousel.",
    adsCarouselMinError: "Sélectionnez au moins 3 produits.",
    adsCarouselMaxError: "Maximum 20 produits.",
    adsCarouselLaunching: "Lancement du carrousel...",
    adsCarouselPrepared: "Mode préparation : accroche et URLs copiées, Ads Manager ouvert.",
    adsCarouselLaunched: "Campagne carrousel créée et enregistrée.",
    adsCarouselError: "Lancement du carrousel impossible.",
    adsCarouselTypeBadge: "Carrousel",
    adsCarouselProductsShort: "produits",
    adsBudgetMode: "Mode budget",
    adsBudgetDaily: "Budget quotidien",
    adsBudgetTotalMode: "Budget total + durée",
    adsBudgetDailyAmount: "Budget quotidien (MAD/jour)",
    adsBudgetTotalAmount: "Budget total",
    adsBudgetCurrency: "Devise",
    adsBudgetDuration: "Durée (jours)",
    adsBudgetRate: "Taux 1 USD = ? MAD",
    adsBudgetDailySummary: "{daily} {symbol}/jour ({dailyMad} MAD/jour) · Budget quotidien",
    adsBudgetSummary: "Calcul : {total} {symbol} ({totalMad} MAD) sur {days} jours = {daily} {symbol}/jour ({dailyMad} MAD/jour)",
    adsBudgetStop: "· Arrêt automatique à la fin du {days}e jour",
    adsEditorButton: "Prévisualiser & Modifier avant lancement",
    adsEditorTitle: "Prévisualisation & modification",
    adsEditorSubtitle: "Éditez les textes, photos et vidéos puis vérifiez le rendu Facebook, Instagram et TikTok.",
    adsEditorClose: "Fermer",
    adsEditorTexts: "Textes de la publicité",
    adsEditorCampaignName: "Nom de la campagne",
    adsEditorChannel: "Canal",
    adsEditorMainCopy: "Texte principal",
    adsEditorQuickCash: "Paiement à la livraison",
    adsEditorQuickDelivery: "Livraison 24-72h",
    adsEditorQuickWarranty: "Garantie 15 jours",
    adsEditorHeadline: "Titre d'accroche (Headline)",
    adsEditorDescription: "Sous-titre / description courte",
    adsEditorCta: "Bouton d'appel à l'action",
    adsEditorCtaOrder: "Commander maintenant",
    adsEditorCtaOffer: "Profiter de l'offre",
    adsEditorCtaShop: "Shop Now",
    adsEditorCtaArabic: "اطلب الآن",
    adsEditorClearText: "Effacer le texte",
    adsEditorResetAi: "Réinitialiser le texte IA",
    adsEditorMedia: "Photos & vidéos",
    adsEditorAddPhoto: "Ajouter une photo",
    adsEditorAddVideo: "Ajouter une vidéo",
    adsEditorImageUrl: "URL image ou vidéo",
    adsEditorAddUrl: "Ajouter l'URL",
    adsEditorBudget: "Diffusion & budget",
    adsEditorPaused: "Lancer en pause (recommandé)",
    adsEditorSaveDraft: "Enregistrer en brouillon",
    adsEditorSaveChanges: "Enregistrer les modifications",
    adsEditorConfirmLaunch: "Confirmer & lancer la campagne",
    adsEditorSaveError: "Enregistrement impossible.",
    adsEditorSaved: "Modifications enregistrées.",
    adsEditorSaving: "Enregistrement...",
    adsEditorDraftSaved: "Brouillon enregistré.",
    adsEditorLaunching: "Lancement en cours...",
    adsEditorLaunched: "Campagne lancée.",
    adsEditorLaunchError: "Lancement impossible.",
    adsEditorNoMedia: "Aucun média. Ajoutez une photo ou une vidéo.",
    adsEditorVideo: "Vidéo",
    adsEditorImage: "Photo",
    adsEditorPrimary: "Principale",
    adsEditorReplace: "Remplacer",
    adsStatusDraft: "DRAFT",
    adsEditorCarouselCards: "Cartes du carrousel",
    adsEditorCardTitle: "Titre de la carte",
    adsEditorCardPrice: "Prix affiché (MAD)",
    adsEditorCardText: "Texte de la carte",
    adsEditorSetPrimary: "Définir comme principal",
    adsEditorRemoveCard: "Supprimer la carte",
    adsEditorNoCards: "Aucune carte dans le carrousel.",
    adsEditorSponsored: "Sponsorisé",
    adsEditorUploading: "Upload en cours...",
    adsEditorUploadDone: "Média ajouté.",
    adsEditorUploadError: "Upload impossible.",
    adsEditorImageTooLarge: "Image trop lourde (maximum 10 Mo).",
    adsEditorVideoTooLarge: "Vidéo trop lourde (maximum 100 Mo).",
    adsEditorUrlError: "URL invalide : utilisez une URL HTTPS.",
    adsEditorDefaultDescription: "Paiement à la livraison 24-72h partout au Maroc + Garantie 15 jours",
    adsEditorDefaultHeadline: "Commandez maintenant",
    adsEditorDefaultCampaignName: "Nouvelle campagne Smartswika",
    adsEditorCarouselHeadline: "Découvrez notre sélection Smartswika",
    adsCampaignVideoBadge: "Vidéo",
    adsCampaignTypeProduct: "Produit",
    adsCampaignDaysLeft: "Jours restants",
    adsCampaignPreview: "Aperçu",
    adsCampaignEdit: "Modifier",
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
    onlineFilter: "🟢 Online",
    onlineNow: "🟢 {n} online now",
    presenceOnline: "🟢 Online",
    presenceOffline: "🔴 Offline",
    presenceLastSeen: "Last seen: {t}",
    presenceNever: "Never seen",
    suspendTitle: "Suspend this vendor",
    suspendType: "Suspension type",
    suspendTemporary: "Temporary",
    suspendPermanent: "Permanent",
    suspendUntil: "Until",
    suspendCause: "Suspension cause",
    suspendCausePlaceholder: "Explain the cause: it will be sent to the vendor (push + email).",
    suspendConfirm: "Suspend",
    suspendCauseRequired: "The suspension cause is required.",
    unsuspendTitle: "Cancel the suspension",
    unsuspendMessage: "Reactivate this vendor and their catalogue? A notification will be sent.",
    unsuspendConfirm: "Reactivate",
    suspendedCauseLabel: "Cause:",
    suspendedUntilLabel: "Until:",
    navAbandoned: "Abandoned carts",
    abandonedTitle: "🛒 Abandoned carts",
    abandonedSubtitle: "Recover unfinished carts with WhatsApp or a free push. Cash on Delivery 24-72h.",
    abandonedRefresh: "Refresh",
    abandonedRefreshed: "List refreshed",
    abandonedKpiAbandoned: "Abandoned carts (7d)",
    abandonedKpiAmount: "Potential amount",
    abandonedKpiRecovered: "Recovered carts",
    abandonedKpiRate: "Recovery rate",
    abandonedFilterAll: "All",
    abandonedFilterPhone: "With phone (WhatsApp)",
    abandonedFilterPush: "Pushed reminders",
    abandonedFilterRecovered: "Recovered",
    abandonedColClient: "Customer / Phone",
    abandonedColCity: "City",
    abandonedColItems: "Items",
    abandonedColTotal: "Total MAD",
    abandonedColAge: "Elapsed time",
    abandonedColStatus: "Status",
    abandonedColActions: "Actions",
    abandonedWhatsApp: "WhatsApp reminder",
    abandonedDelete: "Delete",
    abandonedConfirmDelete: "Permanently delete this abandoned cart?",
    abandonedDeleted: "Cart deleted",
    abandonedWhatsAppSent: "WhatsApp opened — status updated",
    abandonedEmpty: "No cart matches this filter.",
    abandonedStatusActive: "Active",
    abandonedStatusAbandoned: "Abandoned",
    abandonedStatusPush: "Push reminder",
    abandonedStatusWhatsapp: "WhatsApp reminder",
    abandonedStatusRecovered: "Recovered",
    abandonedNoPhone: "Missing phone",
    abandonedGuest: "Visitor",
    abandonedArticles: "item(s)",
    abandonedItemsMore: "+{n} more",
    abandonedBadgeHint: "Abandoned carts to recover",
    abandonedError: "Action failed. Please retry.",
    navAds: "TikTok & Meta Ads Tracking",
    groupMarketing: "Marketing / Sales",
    adsTitle: "📊 TikTok & Meta Ads Tracking",
    adsSubtitle: "7-day first-party attribution, TikTok/Meta pixels, real ROAS (delivered revenue) and net profit after product cost + Livo fees.",
    adsConfigTitle: "⚙️ API, Pixels & Catalog Feed",
    adsMetaPixel: "Meta Pixel ID (Facebook / Instagram)",
    adsTiktokPixel: "TikTok Pixel ID",
    adsSpendMeta: "Meta (MAD)",
    adsSpendTiktok: "TikTok (MAD)",
    adsSpendOther: "Other (MAD)",
    adsSpendPeriod: "Ad spend — period",
    adsSave: "Save",
    adsSaved: "Configuration saved",
    adsSaveError: "Unable to save. Please retry.",
    adsPixelHint: "Pixel IDs are published in config/ads_public (never the budgets). Leave empty to disable a pixel.",
    adsPeriod7: "7 days",
    adsPeriod30: "30 days",
    adsPeriodMonth: "This month",
    adsPeriodAll: "All time",
    adsKpiOrders: "Attributed orders (created / delivered)",
    adsKpiDelivery: "COD delivery rate",
    adsKpiRevenue: "DELIVERED revenue (MAD)",
    adsKpiNet: "DELIVERED NET profit (MAD)",
    adsKpiRoas: "Real ROAS",
    adsKpiRoasHint: "Delivered revenue / ad spend",
    adsChartTitle: "Ordered vs delivered revenue by channel (MAD)",
    adsChartHint: "Moroccan COD creates a gap: only delivered revenue should drive decisions.",
    adsChartCreated: "Ordered revenue",
    adsChartDelivered: "Delivered revenue",
    adsTableTitle: "Performance by source & campaign",
    adsColChannel: "Channel",
    adsColCampaign: "Campaign (utm_campaign)",
    adsColViews: "Product views",
    adsColAddCart: "Add to cart",
    adsColOrders: "Orders created",
    adsColDelivered: "Orders delivered",
    adsColDeliveryRate: "COD delivery rate",
    adsColRevenue: "Delivered revenue (MAD)",
    adsColNet: "Net profit (MAD)",
    adsColSpend: "Spend (MAD)",
    adsColRoas: "Real ROAS",
    adsUtmButton: "📋 Copy UTM link generator",
    adsUtmTitle: "UTM link generator",
    adsUtmChannel: "Channel",
    adsUtmCampaign: "Campaign name",
    adsUtmCampaignPlaceholder: "e.g. christmas-promo-2026",
    adsUtmCopy: "📋 Copy link",
    adsUtmCopied: "Link copied",
    adsUtmCopyError: "Copy failed: select the link manually.",
    adsAllCampaigns: "All campaigns",
    adsNoData: "No data for this period.",
    adsLoading: "Loading...",
    adsTableHint: "Views and add-to-cart are counted per channel (anonymous aggregate counters). A channel's spend is allocated across its campaigns in proportion to delivered revenue.",
    adsChannelTiktok: "TikTok",
    adsChannelMeta: "Meta",
    adsChannelDirect: "Organic / Direct",
    adsChannelOther: "Other",
    adsChannelTotal: "Channel total",
    adsRefresh: "Refresh",
    adsConfigPeriodHint: "Saved budgets correspond to the selected period.",
    adsNoPixel: "No pixel configured: events are still counted in Firestore.",
    adsMetaLabel: "Meta / Facebook / Instagram",
    adsTiktokLabel: "TikTok Ads",
    adsChannelBoth: "Meta + TikTok duo",
    adsBadgeWinning: "Winning product",
    adsBadgeHighMargin: "High margin",
    adsBadgeStrong: "Strong potential",
    adsSuggestionsTitle: "💡 AI Suggested Campaigns — Smartswika Selection",
    adsSuggestionsSubtitle: "Official Smartswika products only (no third-party vendors), scored on net margin + visitor interest + real COD delivery.",
    adsSuggestionsEmptyTitle: "No official Smartswika product ready",
    adsSuggestionsEmptyDesc: "Add or approve an in-stock Smartswika product (no third-party vendor) to generate campaign recommendations.",
    adsSuggestionsGoProducts: "Open product catalog",
    adsMetricMargin: "Net margin",
    adsMetricViews: "Views",
    adsMetricCod: "COD rate",
    adsSuggestionChannel: "Recommended channel",
    adsSuggestionBudget: "Daily budget (MAD)",
    adsSuggestionPaused: "Launch paused (recommended)",
    adsSuggestionCopy: "Ad copy (editable)",
    adsLaunchNow: "Launch campaign now",
    adsLaunching: "Launching...",
    adsPreparedMode: "Preparation mode: ad copy and link copied, Ads Manager opened.",
    adsLaunched: "Campaign created and saved.",
    adsLaunchedPartial: "Campaign partially created: check errors.",
    adsLaunchError: "Unable to launch.",
    adsCampaignsTitle: "📡 My Active Campaigns & Controls",
    adsCampaignsSubtitle: "Campaigns created from Smartswika, synced with Meta / TikTok, with COD profitability alerts.",
    adsCampaignsEmptyTitle: "No campaign launched yet",
    adsCampaignsEmptyDesc: "Launch a suggested campaign or connect your APIs to see controls here.",
    adsStatusActive: "ACTIVE",
    adsStatusPaused: "PAUSED",
    adsCampaignBudget: "Daily budget",
    adsPause: "Pause",
    adsActivate: "Activate",
    adsCampaignOrders: "Orders",
    adsCampaignDelivered: "Delivered",
    adsCampaignCod: "COD rate",
    adsCampaignExternal: "External ID",
    adsCodAlert: "COD profitability alert: consider pausing.",
    adsFeedCopied: "Feed URL copied",
    adsTesting: "Testing...",
    adsNotConfigured: "API not configured",
    adsConnectionError: "Connection failed.",
    adsPixelsSection: "Pixels & domain verification",
    adsApiSection: "Meta / TikTok API connection",
    adsMetaDomainVerification: "Meta Domain Verification",
    adsMetaAdAccountId: "Meta Ad Account ID",
    adsMetaPageId: "Meta Page ID",
    adsMetaAccessToken: "Meta Access Token (masked)",
    adsTiktokAdvertiserId: "TikTok Advertiser ID",
    adsTiktokAccessToken: "TikTok Access Token (masked)",
    adsTestMeta: "Test Meta connection",
    adsTestTiktok: "Test TikTok connection",
    adsFeedTitle: "📡 XML Product Catalog Feed",
    adsFeedCopy: "Copy feed URL",
    adsSecretsHint: "API tokens are stored in config/ads_secrets (admin only, never public). Leave blank to keep the existing token.",
    adsCarouselDefaultName: "Smartswika Carousel - Top Selection",
    adsCarouselCount: "{count} / 20 products selected",
    adsCarouselGuideTitle: "Multi-Product Carousel locked",
    adsCarouselGuideDesc: "Add at least 3 official Smartswika products in stock to unlock the Multi-Product Carousel.",
    adsCarouselCopyLabel: "Primary copy",
    adsCarouselTitle: "Multi-Product Carousel Campaign (3 to 20 products)",
    adsCarouselSubtitle: "Select 3 to 20 official Smartswika products, preview the carousel and launch Meta/TikTok in one click.",
    adsCarouselAutoTop10: "Auto-select the Smartswika Top 10",
    adsCarouselClear: "Reset",
    adsCarouselMinRequired: "Minimum 3 products required",
    adsCarouselSelectProducts: "Carousel products",
    adsCarouselCampaignName: "Campaign name",
    adsCarouselBudget: "Daily budget (MAD)",
    adsCarouselChannel: "Channel",
    adsCarouselPaused: "Launch paused (recommended for visual check)",
    adsCarouselPreview: "Horizontal carousel preview",
    adsCarouselMetaHint: "Meta displays up to 10 cards; all 20 products remain saved in the campaign.",
    adsCarouselLaunch: "Launch carousel campaign",
    adsCarouselPreviewEmpty: "Select products to preview the carousel.",
    adsCarouselMinError: "Select at least 3 products.",
    adsCarouselMaxError: "Maximum 20 products.",
    adsCarouselLaunching: "Launching carousel...",
    adsCarouselPrepared: "Preparation mode: copy and URLs copied, Ads Manager opened.",
    adsCarouselLaunched: "Carousel campaign created and saved.",
    adsCarouselError: "Unable to launch carousel.",
    adsCarouselTypeBadge: "Carousel",
    adsCarouselProductsShort: "products",
    adsBudgetMode: "Budget mode",
    adsBudgetDaily: "Daily budget",
    adsBudgetTotalMode: "Total budget + duration",
    adsBudgetDailyAmount: "Daily budget (MAD/day)",
    adsBudgetTotalAmount: "Total budget",
    adsBudgetCurrency: "Currency",
    adsBudgetDuration: "Duration (days)",
    adsBudgetRate: "Rate 1 USD = ? MAD",
    adsBudgetDailySummary: "{daily} {symbol}/day ({dailyMad} MAD/day) · Daily budget",
    adsBudgetSummary: "Calculation: {total} {symbol} ({totalMad} MAD) over {days} days = {daily} {symbol}/day ({dailyMad} MAD/day)",
    adsBudgetStop: "· Auto-pause at the end of day {days}",
    adsEditorButton: "Preview & edit before launch",
    adsEditorTitle: "Preview & edit",
    adsEditorSubtitle: "Edit texts, photos and videos then check the Facebook, Instagram and TikTok rendering.",
    adsEditorClose: "Close",
    adsEditorTexts: "Ad texts",
    adsEditorCampaignName: "Campaign name",
    adsEditorChannel: "Channel",
    adsEditorMainCopy: "Primary text",
    adsEditorQuickCash: "Cash on delivery",
    adsEditorQuickDelivery: "24-72h delivery",
    adsEditorQuickWarranty: "15-day warranty",
    adsEditorHeadline: "Headline",
    adsEditorDescription: "Subtitle / short description",
    adsEditorCta: "Call-to-action button",
    adsEditorCtaOrder: "Order now",
    adsEditorCtaOffer: "Get the offer",
    adsEditorCtaShop: "Shop Now",
    adsEditorCtaArabic: "اطلب الآن",
    adsEditorClearText: "Clear text",
    adsEditorResetAi: "Reset AI text",
    adsEditorMedia: "Photos & videos",
    adsEditorAddPhoto: "Add a photo",
    adsEditorAddVideo: "Add a video",
    adsEditorImageUrl: "Image or video URL",
    adsEditorAddUrl: "Add URL",
    adsEditorBudget: "Delivery & budget",
    adsEditorPaused: "Launch paused (recommended)",
    adsEditorSaveDraft: "Save as draft",
    adsEditorSaveChanges: "Save changes",
    adsEditorConfirmLaunch: "Confirm & launch campaign",
    adsEditorSaveError: "Unable to save.",
    adsEditorSaved: "Changes saved.",
    adsEditorSaving: "Saving...",
    adsEditorDraftSaved: "Draft saved.",
    adsEditorLaunching: "Launching...",
    adsEditorLaunched: "Campaign launched.",
    adsEditorLaunchError: "Unable to launch.",
    adsEditorNoMedia: "No media. Add a photo or a video.",
    adsEditorVideo: "Video",
    adsEditorImage: "Photo",
    adsEditorPrimary: "Primary",
    adsEditorReplace: "Replace",
    adsStatusDraft: "DRAFT",
    adsEditorCarouselCards: "Carousel cards",
    adsEditorCardTitle: "Card title",
    adsEditorCardPrice: "Displayed price (MAD)",
    adsEditorCardText: "Card text",
    adsEditorSetPrimary: "Set as primary",
    adsEditorRemoveCard: "Remove card",
    adsEditorNoCards: "No card in the carousel.",
    adsEditorSponsored: "Sponsored",
    adsEditorUploading: "Uploading...",
    adsEditorUploadDone: "Media added.",
    adsEditorUploadError: "Upload failed.",
    adsEditorImageTooLarge: "Image too large (maximum 10 MB).",
    adsEditorVideoTooLarge: "Video too large (maximum 100 MB).",
    adsEditorUrlError: "Invalid URL: use an HTTPS URL.",
    adsEditorDefaultDescription: "Cash on Delivery 24-72h across Morocco + 15-day warranty",
    adsEditorDefaultHeadline: "Order now",
    adsEditorDefaultCampaignName: "New Smartswika campaign",
    adsEditorCarouselHeadline: "Discover our Smartswika selection",
    adsCampaignVideoBadge: "Video",
    adsCampaignTypeProduct: "Product",
    adsCampaignDaysLeft: "Days left",
    adsCampaignPreview: "Preview",
    adsCampaignEdit: "Edit",
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
    onlineFilter: "🟢 متصل الآن",
    onlineNow: "🟢 {n} متصل الآن",
    presenceOnline: "🟢 متصل الآن",
    presenceOffline: "🔴 غير متصل",
    presenceLastSeen: "آخر نشاط: {t}",
    presenceNever: "لم يتصل بعد",
    suspendTitle: "تعليق حساب البائع",
    suspendType: "نوع التعليق",
    suspendTemporary: "مؤقت",
    suspendPermanent: "نهائي",
    suspendUntil: "حتى",
    suspendCause: "سبب التعليق",
    suspendCausePlaceholder: "اشرح السبب: سيُرسل إلى البائع (إشعار + بريد إلكتروني).",
    suspendConfirm: "تعليق",
    suspendCauseRequired: "سبب التعليق إلزامي.",
    unsuspendTitle: "إلغاء التعليق",
    unsuspendMessage: "إعادة تفعيل هذا البائع ومتجره؟ سيُرسل إليه إشعار.",
    unsuspendConfirm: "إعادة التفعيل",
    suspendedCauseLabel: "السبب:",
    suspendedUntilLabel: "حتى:",
    navAbandoned: "السلات المهجورة",
    abandonedTitle: "🛒 السلات المهجورة",
    abandonedSubtitle: "استرجع السلات غير المكتملة عبر واتساب أو إشعار مجاني. الدفع عند الاستلام خلال 24-72 ساعة.",
    abandonedRefresh: "تحديث",
    abandonedRefreshed: "تم تحديث القائمة",
    abandonedKpiAbandoned: "السلات المهجورة (7 أيام)",
    abandonedKpiAmount: "المبلغ المحتمل",
    abandonedKpiRecovered: "السلات المستعادة",
    abandonedKpiRate: "نسبة الاستعادة",
    abandonedFilterAll: "الكل",
    abandonedFilterPhone: "مع رقم الهاتف (واتساب)",
    abandonedFilterPush: "أُرسل إشعار",
    abandonedFilterRecovered: "مستعادة",
    abandonedColClient: "العميل / الهاتف",
    abandonedColCity: "المدينة",
    abandonedColItems: "المنتجات",
    abandonedColTotal: "المجموع (درهم)",
    abandonedColAge: "الوقت المنقضي",
    abandonedColStatus: "الحالة",
    abandonedColActions: "الإجراءات",
    abandonedWhatsApp: "تذكير واتساب",
    abandonedDelete: "حذف",
    abandonedConfirmDelete: "حذف هذه السلة المهجورة نهائيًا؟",
    abandonedDeleted: "تم حذف السلة",
    abandonedWhatsAppSent: "تم فتح واتساب — تم تحديث الحالة",
    abandonedEmpty: "لا توجد سلة في هذا الفلتر.",
    abandonedStatusActive: "نشطة",
    abandonedStatusAbandoned: "مهجورة",
    abandonedStatusPush: "أُرسل إشعار",
    abandonedStatusWhatsapp: "تذكير واتساب",
    abandonedStatusRecovered: "مستعادة",
    abandonedNoPhone: "رقم الهاتف غير متوفر",
    abandonedGuest: "زائر",
    abandonedArticles: "منتج",
    abandonedItemsMore: "+{n} أخرى",
    abandonedBadgeHint: "سلات مهجورة للتذكير",
    abandonedError: "تعذر تنفيذ الإجراء. أعد المحاولة.",
    navAds: "متابعة إعلانات تيك توك وميتا",
    groupMarketing: "التسويق / المبيعات",
    adsTitle: "📊 متابعة إعلانات تيك توك وميتا",
    adsSubtitle: "إحالة أولية لمدة 7 أيام، بيكسلات تيك توك/ميتا، عائد إعلاني حقيقي (الإيرادات المسلّمة) وربح صافي بعد تكلفة المنتج ومصاريف ليفو.",
    adsConfigTitle: "⚙️ ربط API والبيكسلات وFlux الكتالوج",
    adsMetaPixel: "معرّف بكسل ميتا (فيسبوك / إنستغرام)",
    adsTiktokPixel: "معرّف بكسل تيك توك",
    adsSpendMeta: "ميتا (درهم)",
    adsSpendTiktok: "تيك توك (درهم)",
    adsSpendOther: "أخرى (درهم)",
    adsSpendPeriod: "مصاريف الإعلانات — الفترة",
    adsSave: "حفظ",
    adsSaved: "تم حفظ الإعداد",
    adsSaveError: "تعذر الحفظ. أعد المحاولة.",
    adsPixelHint: "تُنشر معرّفات البيكسل في config/ads_public (وليس الميزانيات). اتركه فارغًا لتعطيل البيكسل.",
    adsPeriod7: "7 أيام",
    adsPeriod30: "30 يومًا",
    adsPeriodMonth: "هذا الشهر",
    adsPeriodAll: "الكل",
    adsKpiOrders: "الطلبات المنسوبة (منشأة / مسلّمة)",
    adsKpiDelivery: "نسبة التسليم عند الاستلام",
    adsKpiRevenue: "الإيرادات المسلّمة (درهم)",
    adsKpiNet: "الربح الصافي المسلّم (درهم)",
    adsKpiRoas: "العائد الإعلاني الحقيقي",
    adsKpiRoasHint: "الإيرادات المسلّمة / مصاريف الإعلانات",
    adsChartTitle: "الإيرادات المطلوبة مقابل المسلّمة حسب القناة (درهم)",
    adsChartHint: "الدفع عند الاستلام في المغرب يخلق فرقًا: الإيرادات المسلّمة وحدها يجب أن توجّه القرارات.",
    adsChartCreated: "الإيرادات المطلوبة",
    adsChartDelivered: "الإيرادات المسلّمة",
    adsTableTitle: "الأداء حسب المصدر والحملة",
    adsColChannel: "القناة",
    adsColCampaign: "الحملة (utm_campaign)",
    adsColViews: "مشاهدات المنتج",
    adsColAddCart: "إضافات السلة",
    adsColOrders: "طلبات منشأة",
    adsColDelivered: "طلبات مسلّمة",
    adsColDeliveryRate: "نسبة التسليم عند الاستلام",
    adsColRevenue: "الإيرادات المسلّمة (درهم)",
    adsColNet: "الربح الصافي (درهم)",
    adsColSpend: "المصاريف (درهم)",
    adsColRoas: "العائد الحقيقي",
    adsUtmButton: "📋 نسخ مولّد رابط UTM",
    adsUtmTitle: "مولّد رابط UTM",
    adsUtmChannel: "القناة",
    adsUtmCampaign: "اسم الحملة",
    adsUtmCampaignPlaceholder: "مثال: promo-noel-2026",
    adsUtmCopy: "📋 نسخ الرابط",
    adsUtmCopied: "تم نسخ الرابط",
    adsUtmCopyError: "تعذر النسخ: حدّد الرابط يدويًا.",
    adsAllCampaigns: "كل الحملات",
    adsNoData: "لا توجد بيانات في هذه الفترة.",
    adsLoading: "جارٍ التحميل...",
    adsTableHint: "تُحتسب المشاهدات وإضافات السلة حسب القناة (عدادات مجمّعة مجهولة). تُوزّع مصاريف القناة على حملاتها بنسبة الإيرادات المسلّمة.",
    adsChannelTiktok: "تيك توك",
    adsChannelMeta: "ميتا",
    adsChannelDirect: "عضوي / مباشر",
    adsChannelOther: "أخرى",
    adsChannelTotal: "إجمالي القناة",
    adsRefresh: "تحديث",
    adsConfigPeriodHint: "الميزانيات المحفوظة تخص الفترة المحددة.",
    adsNoPixel: "لا يوجد بكسل مُعدّ: تبقى الأحداث محتسبة في Firestore.",
    adsMetaLabel: "ميتا / فيسبوك / إنستغرام",
    adsTiktokLabel: "إعلانات تيك توك",
    adsChannelBoth: "ثنائي ميتا + تيك توك",
    adsBadgeWinning: "منتج رابح",
    adsBadgeHighMargin: "هامش مرتفع",
    adsBadgeStrong: "إمكانات قوية",
    adsSuggestionsTitle: "💡 حملات مقترحة بالذكاء الاصطناعي — اختيار سمارت سويقة",
    adsSuggestionsSubtitle: "منتجات سمارت سويقة الرسمية فقط (بدون بائعين خارجيين)، حسب الهامش الصافي واهتمام الزوار ونسبة التسليم عند الاستلام.",
    adsSuggestionsEmptyTitle: "لا يوجد منتج رسمي جاهز",
    adsSuggestionsEmptyDesc: "أضف أو وافق على منتج سمارت سويقة متوفر في المخزون (بدون بائع خارجي) لتوليد توصيات الحملات.",
    adsSuggestionsGoProducts: "فتح كتالوج المنتجات",
    adsMetricMargin: "الهامش الصافي",
    adsMetricViews: "المشاهدات",
    adsMetricCod: "نسبة الاستلام",
    adsSuggestionChannel: "القناة الموصى بها",
    adsSuggestionBudget: "الميزانية اليومية (درهم)",
    adsSuggestionPaused: "الإطلاق موقوف (موصى به)",
    adsSuggestionCopy: "النص الإعلاني (قابل للتعديل)",
    adsLaunchNow: "إطلاق الحملة الآن",
    adsLaunching: "جارٍ الإطلاق...",
    adsPreparedMode: "وضع التحضير: تم نسخ النص والرابط وفتح Ads Manager.",
    adsLaunched: "تم إنشاء الحملة وحفظها.",
    adsLaunchedPartial: "تم إنشاء الحملة جزئيًا: تحقق من الأخطاء.",
    adsLaunchError: "تعذر الإطلاق.",
    adsCampaignsTitle: "📡 حملاتي النشطة والتحكم",
    adsCampaignsSubtitle: "حملات أُنشئت من سمارت سويقة، متزامنة مع ميتا / تيك توك، مع تنبيه ربحية الدفع عند الاستلام.",
    adsCampaignsEmptyTitle: "لا توجد حملة مُطلقة",
    adsCampaignsEmptyDesc: "أطلق حملة مقترحة أو اربط واجهات API لعرض التحكم هنا.",
    adsStatusActive: "ACTIVE",
    adsStatusPaused: "PAUSED",
    adsCampaignBudget: "الميزانية/اليوم",
    adsPause: "إيقاف مؤقت",
    adsActivate: "تفعيل",
    adsCampaignOrders: "الطلبات",
    adsCampaignDelivered: "المسلّمة",
    adsCampaignCod: "نسبة الاستلام",
    adsCampaignExternal: "المعرّف الخارجي",
    adsCodAlert: "تنبيه ربحية الدفع عند الاستلام: يُنصح بالإيقاف المؤقت.",
    adsFeedCopied: "تم نسخ رابط Flux",
    adsTesting: "جارٍ الاختبار...",
    adsNotConfigured: "API غير مُعدّة",
    adsConnectionError: "تعذر الاتصال.",
    adsPixelsSection: "البيكسلات والتحقق من النطاق",
    adsApiSection: "ربط APIs ميتا / تيك توك",
    adsMetaDomainVerification: "التحقق من نطاق ميتا",
    adsMetaAdAccountId: "معرّف حساب إعلانات ميتا",
    adsMetaPageId: "معرّف صفحة ميتا",
    adsMetaAccessToken: "رمز وصول ميتا (مخفي)",
    adsTiktokAdvertiserId: "معرّف معلن تيك توك",
    adsTiktokAccessToken: "رمز وصول تيك توك (مخفي)",
    adsTestMeta: "اختبار اتصال ميتا",
    adsTestTiktok: "اختبار اتصال تيك توك",
    adsFeedTitle: "📡 Flux كتالوج المنتجات XML",
    adsFeedCopy: "نسخ رابط Flux",
    adsSecretsHint: "رموز API تُخزّن في config/ads_secrets (للمشرف فقط، غير عامة). اتركه فارغًا للحفاظ على الرمز الحالي.",
    adsCarouselDefaultName: "كاروسيل سمارت سويقة - أفضل اختيار",
    adsCarouselCount: "{count} / 20 منتجًا محددًا",
    adsCarouselGuideTitle: "كاروسيل متعدد المنتجات مقفل",
    adsCarouselGuideDesc: "أضف 3 منتجات رسمية على الأقل من سمارت سويقة متوفرة في المخزون لفتح كاروسيل متعدد المنتجات.",
    adsCarouselCopyLabel: "النص الرئيسي",
    adsCarouselTitle: "حملة كاروسيل متعددة المنتجات (3 إلى 20 منتجًا)",
    adsCarouselSubtitle: "اختر من 3 إلى 20 منتجًا رسميًا من سمارت سويقة، عاين الكاروسيل وأطلق ميتا/تيك توك بنقرة واحدة.",
    adsCarouselAutoTop10: "اختيار أفضل 10 منتجات تلقائيًا",
    adsCarouselClear: "إعادة تعيين",
    adsCarouselMinRequired: "مطلوب 3 منتجات على الأقل",
    adsCarouselSelectProducts: "منتجات الكاروسيل",
    adsCarouselCampaignName: "اسم الحملة",
    adsCarouselBudget: "الميزانية اليومية (درهم)",
    adsCarouselChannel: "القناة",
    adsCarouselPaused: "الإطلاق موقوف (موصى به للمعاينة البصرية)",
    adsCarouselPreview: "معاينة أفقية للكاروسيل",
    adsCarouselMetaHint: "تعرض ميتا حتى 10 بطاقات؛ تبقى كل المنتجات العشرين محفوظة في الحملة.",
    adsCarouselLaunch: "إطلاق حملة الكاروسيل",
    adsCarouselPreviewEmpty: "اختر منتجات لمعاينة الكاروسيل.",
    adsCarouselMinError: "اختر 3 منتجات على الأقل.",
    adsCarouselMaxError: "الحد الأقصى 20 منتجًا.",
    adsCarouselLaunching: "جارٍ إطلاق الكاروسيل...",
    adsCarouselPrepared: "وضع التحضير: تم نسخ النص والروابط وفتح Ads Manager.",
    adsCarouselLaunched: "تم إنشاء حملة الكاروسيل وحفظها.",
    adsCarouselError: "تعذر إطلاق الكاروسيل.",
    adsCarouselTypeBadge: "كاروسيل",
    adsCarouselProductsShort: "منتجات",
    adsBudgetMode: "وضع الميزانية",
    adsBudgetDaily: "ميزانية يومية",
    adsBudgetTotalMode: "ميزانية إجمالية + المدة",
    adsBudgetDailyAmount: "الميزانية اليومية (درهم/يوم)",
    adsBudgetTotalAmount: "الميزانية الإجمالية",
    adsBudgetCurrency: "العملة",
    adsBudgetDuration: "المدة (أيام)",
    adsBudgetRate: "سعر الصرف 1 دولار = ؟ درهم",
    adsBudgetDailySummary: "{daily} {symbol}/يوم ({dailyMad} درهم/يوم) · ميزانية يومية",
    adsBudgetSummary: "الحساب: {total} {symbol} ({totalMad} درهم) على {days} أيام = {daily} {symbol}/يوم ({dailyMad} درهم/يوم)",
    adsBudgetStop: "· إيقاف تلقائي في نهاية اليوم {days}",
    adsEditorButton: "معاينة وتعديل قبل الإطلاق",
    adsEditorTitle: "المعاينة والتعديل",
    adsEditorSubtitle: "عدّل النصوص والصور والفيديوهات ثم تحقق من عرض فيسبوك وإنستغرام وتيك توك.",
    adsEditorClose: "إغلاق",
    adsEditorTexts: "نصوص الإعلان",
    adsEditorCampaignName: "اسم الحملة",
    adsEditorChannel: "القناة",
    adsEditorMainCopy: "النص الرئيسي",
    adsEditorQuickCash: "الدفع عند الاستلام",
    adsEditorQuickDelivery: "التوصيل 24-72 ساعة",
    adsEditorQuickWarranty: "ضمان 15 يومًا",
    adsEditorHeadline: "العنوان الرئيسي",
    adsEditorDescription: "العنوان الفرعي / وصف قصير",
    adsEditorCta: "زر الإجراء",
    adsEditorCtaOrder: "اطلب الآن",
    adsEditorCtaOffer: "استفد من العرض",
    adsEditorCtaShop: "Shop Now",
    adsEditorCtaArabic: "اطلب الآن",
    adsEditorClearText: "مسح النص",
    adsEditorResetAi: "إعادة نص الذكاء الاصطناعي",
    adsEditorMedia: "الصور والفيديوهات",
    adsEditorAddPhoto: "إضافة صورة",
    adsEditorAddVideo: "إضافة فيديو",
    adsEditorImageUrl: "رابط الصورة أو الفيديو",
    adsEditorAddUrl: "إضافة الرابط",
    adsEditorBudget: "البث والميزانية",
    adsEditorPaused: "الإطلاق موقوف (موصى به)",
    adsEditorSaveDraft: "حفظ كمسودة",
    adsEditorSaveChanges: "حفظ التعديلات",
    adsEditorConfirmLaunch: "تأكيد وإطلاق الحملة",
    adsEditorSaveError: "تعذر الحفظ.",
    adsEditorSaved: "تم حفظ التعديلات.",
    adsEditorSaving: "جارٍ الحفظ...",
    adsEditorDraftSaved: "تم حفظ المسودة.",
    adsEditorLaunching: "جارٍ الإطلاق...",
    adsEditorLaunched: "تم إطلاق الحملة.",
    adsEditorLaunchError: "تعذر الإطلاق.",
    adsEditorNoMedia: "لا وسائط. أضف صورة أو فيديو.",
    adsEditorVideo: "فيديو",
    adsEditorImage: "صورة",
    adsEditorPrimary: "رئيسية",
    adsEditorReplace: "استبدال",
    adsStatusDraft: "DRAFT",
    adsEditorCarouselCards: "بطاقات الكاروسيل",
    adsEditorCardTitle: "عنوان البطاقة",
    adsEditorCardPrice: "السعر المعروض (درهم)",
    adsEditorCardText: "نص البطاقة",
    adsEditorSetPrimary: "تعيين كرئيسية",
    adsEditorRemoveCard: "حذف البطاقة",
    adsEditorNoCards: "لا توجد بطاقة في الكاروسيل.",
    adsEditorSponsored: "مُموّل",
    adsEditorUploading: "جارٍ الرفع...",
    adsEditorUploadDone: "تمت إضافة الوسائط.",
    adsEditorUploadError: "فشل الرفع.",
    adsEditorImageTooLarge: "الصورة كبيرة جدًا (الحد الأقصى 10 ميغابايت).",
    adsEditorVideoTooLarge: "الفيديو كبير جدًا (الحد الأقصى 100 ميغابايت).",
    adsEditorUrlError: "رابط غير صالح: استخدم رابط HTTPS.",
    adsEditorDefaultDescription: "الدفع عند الاستلام خلال 24-72 ساعة في كل المغرب + ضمان 15 يومًا",
    adsEditorDefaultHeadline: "اطلب الآن",
    adsEditorDefaultCampaignName: "حملة سمارت سويقة جديدة",
    adsEditorCarouselHeadline: "اكتشف اختيارنا من سمارت سويقة",
    adsCampaignVideoBadge: "فيديو",
    adsCampaignTypeProduct: "منتج",
    adsCampaignDaysLeft: "الأيام المتبقية",
    adsCampaignPreview: "معاينة",
    adsCampaignEdit: "تعديل",
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

/* Quatrieme lot : modales de confirmation et toasts courants. */
Object.assign(PHRASES, {
  "Supprimer définitivement ce produit ?": {
    en: "Permanently delete this product?",
    ar: "حذف هذا المنتج نهائيًا؟",
  },
  "Supprimer définitivement cet article ?": {
    en: "Permanently delete this article?",
    ar: "حذف هذا المقال نهائيًا؟",
  },
  "Supprimer définitivement ce code promo ?": {
    en: "Permanently delete this promo code?",
    ar: "حذف كود الخصم هذا نهائيًا؟",
  },
  "Confirmer le dépôt à l’agence ? Le montant sera débité du portefeuille du vendeur.": {
    en: "Confirm the agency drop-off? The amount will be debited from the vendor wallet.",
    ar: "تأكيد الإيداع في الوكالة؟ سيتم خصم المبلغ من محفظة البائع.",
  },
  "Marquer comme envoyé": { en: "Mark as sent", ar: "تعليم كمرسل" },
  "Oui, envoyé": { en: "Yes, sent", ar: "نعم، أُرسل" },
  "Confirmer que le vendeur a bien retiré cet argent à l’agence ?": {
    en: "Confirm the vendor collected this money at the agency?",
    ar: "تأكيد أن البائع سحب هذا المبلغ من الوكالة؟",
  },
  "Marquer comme retiré": { en: "Mark as collected", ar: "تعليم كمستلم" },
  "Oui, retiré": { en: "Yes, collected", ar: "نعم، تم السحب" },
  "Erreur": { en: "Error", ar: "خطأ" },
  "Client supprimé": { en: "Customer deleted", ar: "تم حذف العميل" },
  "Rôle mis à jour": { en: "Role updated", ar: "تم تحديث الدور" },
  "Produit introuvable": { en: "Product not found", ar: "المنتج غير موجود" },
  "Article introuvable": { en: "Article not found", ar: "المقال غير موجود" },
  "Code promo supprimé": { en: "Promo code deleted", ar: "تم حذف كود الخصم" },
  "Vendeur": { en: "Vendor", ar: "بائع" },
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
    /* Jamais de cle brute (ex. adsSuggestionsTitle) dans le DOM :
       si une traduction manque, on conserve le libelle existant. */
    if (!value || value === key) return;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.placeholder = value;
    else el.textContent = value;
  });
  root.querySelectorAll("[data-admin-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-admin-i18n-placeholder");
    const value = adminT(key);
    if (value && value !== key) el.setAttribute("placeholder", value);
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
  "#adminStats .stat-value, #accKPIs .stat-value, #tab-traffic .stat-value, #financesResults .stat-value, #abandonedKpis .stat-value, #adsKpis .stat-value";

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
