/* ============================================================ js/translations-vendor.js Traductions marketplace vendeur - Smartswika Version 1.0.0 - T11 Rôle : complète window.translations.fr / .ar / .en avec les clés propres au dashboard vendeur, à l'admin marketplace et au contrat versionné. Chargé APRÈS /translations.js sur : - /vendor/dashboard.html - /inscription-vendeur.html - /admin.html IMPORTANT : ce fichier ne contient AUCUN commentaire de ligne (//). Tous les commentaires sont en bloc pour résister à un éventuel aplatissement du fichier (ALERTE 1). Couverture (34 clés x 3 langues = 102 entrées) : - payout.paid / pending / rejected / cancelled - product.status.approved / pending / rejected / suspended - vendor.contract.version / statusUpToDate / statusOutdated / statusMissing / signedOn / language / view / print / download / verify / verifyOk / verifyFail / verifyRunning / sectionTitle / hash / loadFailed / notFound / signNow / readOnlyHint - vendor.banner.resignRequired / resignNow / contractTransitionFailed / finalize / finalizeSuccess / finalizeFail - vendor.signup.transitionFailed Dépendance : window.translations doit exister (chargé depuis /translations.js). Si absent, on l'initialise vide pour ne pas casser le reste. ============================================================ */

(function () {
  "use strict";

  if (!window.translations) {
    window.translations = { fr: {}, ar: {}, en: {} };
  }
  if (!window.translations.fr) window.translations.fr = {};
  if (!window.translations.ar) window.translations.ar = {};
  if (!window.translations.en) window.translations.en = {};

  /* ============================================================ FRANÇAIS (fr) ============================================================ */
  Object.assign(window.translations.fr, {
    "vendor.nav.koulchi": "Koulchi dialk",
    "vendor.nav.guide": "Guide vendeur",
    /* --- Payout statuses (badges admin + dashboard vendeur) --- */
    "payout.paid": "Payé",
    "payout.pending": "En attente",
    "payout.rejected": "Rejeté",
    "payout.cancelled": "Annulé",
    "payout.sent": "Envoyé",
    "payout.completed": "Terminé",
    "vendor.stock.pickupTitle": "Ramassage de stock Livo",
    "vendor.stock.approvedCount": "produit(s) validé(s) prêt(s) à être expédié(s)",
    "vendor.stock.requestPickup": "Demander un ramassage",
    "vendor.error.authNotReady": "Session non initialisée. Redirection vers l'accueil...",
    "vendor.error.notVendor": "Ce compte n'est pas un compte vendeur. Redirection...",
    "vendor.error.profileMissing": "Profil vendeur introuvable. Contactez le support.",

    /* --- Product statuses (badges dashboard vendeur) --- */
    "product.status.approved": "Approuvé",
    "product.status.pending": "En validation",
    "product.status.rejected": "Rejeté",
    "product.status.suspended": "Suspendu",

    /* --- Section « Mon contrat » du dashboard vendeur --- */
    "vendor.contract.version": "Version",
    "vendor.contract.statusUpToDate": "✅ Contrat à jour",
    "vendor.contract.statusOutdated":
      "⚠️ Contrat obsolète — re-signature requise",
    "vendor.contract.statusMissing": "❌ Aucun contrat signé",
    "vendor.contract.signedOn": "Signé le {date}",
    "vendor.contract.language": "Langue",
    "vendor.contract.view": "Voir",
    "vendor.contract.print": "Imprimer",
    "vendor.contract.download": "Télécharger (.txt)",
    "vendor.contract.verify": "Vérifier l'intégrité",
    "vendor.contract.verifyOk": "✅ Intégrité vérifiée",
    "vendor.contract.verifyFail": "❌ Intégrité non vérifiable : {reason}",
    "vendor.contract.verifyRunning": "⏳ Vérification...",
    "vendor.contract.sectionTitle": "Mon contrat",
    "vendor.contract.hash": "Hash SHA-256",
    "vendor.contract.loadFailed": "Impossible de charger le contrat.",
    "vendor.contract.notFound": "Aucun contrat signé à afficher.",
    "vendor.contract.signNow": "Signer le contrat",
    "vendor.contract.readOnlyHint": "Lecture seule — version signée",

    /* --- Bannière re-signature + reprise de transition --- */
    "vendor.banner.resignRequired":
      "⚠️ Une nouvelle version du contrat ({version}) est disponible. Signez-la avant le {date} pour éviter le blocage de la publication et des retraits.",
    "vendor.banner.resignNow": "Signer maintenant",
    "vendor.banner.contractTransitionFailed":
      "⚠️ Contrat signé mais la synchronisation du profil a échoué. Finalisez pour débloquer votre compte.",
    "vendor.banner.finalize": "Finaliser",
    "vendor.banner.finalizeSuccess": "✅ Profil synchronisé",
    "vendor.banner.finalizeFail":
      "❌ Synchronisation échouée. Contactez le support.",

    /* --- Inscription vendeur : transition utilisateur --- */
    "vendor.signup.transitionFailed":
      "⚠️ Compte créé et contrat signé, mais la synchronisation du profil a échoué. Finalisez depuis le dashboard.",
  });

  /* ============================================================ ARABE (ar) ============================================================ */
  Object.assign(window.translations.ar, {
    "vendor.nav.koulchi": "كولشي ديالك",
    "vendor.nav.guide": "دليل البائع",
    /* --- Payout statuses --- */
    "payout.paid": "مدفوع",
    "payout.pending": "قيد الانتظار",
    "payout.rejected": "مرفوض",
    "payout.cancelled": "ملغى",
    "payout.sent": "تم الإرسال",
    "payout.completed": "مكتمل",
    "vendor.stock.pickupTitle": "استلام المخزون عبر ليفو",
    "vendor.stock.approvedCount": "منتج/منتجات معتمدة جاهزة للإرسال",
    "vendor.stock.requestPickup": "طلب استلام",
    "vendor.error.authNotReady": "الجلسة غير مهيأة. إعادة التوجيه إلى الصفحة الرئيسية...",
    "vendor.error.notVendor": "هذا الحساب ليس حساب بائع. إعادة التوجيه...",
    "vendor.error.profileMissing": "ملف البائع غير موجود. اتصل بالدعم.",

    /* --- Product statuses --- */
    "product.status.approved": "مقبول",
    "product.status.pending": "قيد التحقق",
    "product.status.rejected": "مرفوض",
    "product.status.suspended": "معلّق",

    /* --- Section « Mon contrat » --- */
    "vendor.contract.version": "الإصدار",
    "vendor.contract.statusUpToDate": "✅ العقد محدّث",
    "vendor.contract.statusOutdated": "⚠️ عقد قديم — إعادة التوقيع مطلوبة",
    "vendor.contract.statusMissing": "❌ لا يوجد عقد موقّع",
    "vendor.contract.signedOn": "موقّع في {date}",
    "vendor.contract.language": "اللغة",
    "vendor.contract.view": "عرض",
    "vendor.contract.print": "طباعة",
    "vendor.contract.download": "تنزيل (.txt)",
    "vendor.contract.verify": "التحقق من السلامة",
    "vendor.contract.verifyOk": "✅ تم التحقق من السلامة",
    "vendor.contract.verifyFail": "❌ تعذّر التحقق: {reason}",
    "vendor.contract.verifyRunning": "⏳ جارٍ التحقق...",
    "vendor.contract.sectionTitle": "عقدي",
    "vendor.contract.hash": "بصمة SHA-256",
    "vendor.contract.loadFailed": "تعذّر تحميل العقد.",
    "vendor.contract.notFound": "لا يوجد عقد موقّع للعرض.",
    "vendor.contract.signNow": "توقيع العقد",
    "vendor.contract.readOnlyHint": "قراءة فقط — النسخة الموقّعة",

    /* --- Bannière re-signature + reprise de transition --- */
    "vendor.banner.resignRequired":
      "⚠️ نسخة جديدة من العقد ({version}) متاحة. وقّعها قبل {date} لتجنّب حظر النشر والسحب.",
    "vendor.banner.resignNow": "التوقيع الآن",
    "vendor.banner.contractTransitionFailed":
      "⚠️ تم توقيع العقد لكن مزامنة الملف الشخصي فشلت. أكمل لفتح حسابك.",
    "vendor.banner.finalize": "إنهاء",
    "vendor.banner.finalizeSuccess": "✅ تمت مزامنة الملف الشخصي",
    "vendor.banner.finalizeFail": "❌ فشلت المزامنة. اتصل بالدعم.",

    /* --- Inscription vendeur : transition utilisateur --- */
    "vendor.signup.transitionFailed":
      "⚠️ تم إنشاء الحساب وتوقيع العقد، لكن مزامنة الملف الشخصي فشلت. أكمل من لوحة التحكم.",
  });

  /* ============================================================ ANGLAIS (en) ============================================================ */
  Object.assign(window.translations.en, {
    "vendor.nav.koulchi": "Koulchi dialk",
    "vendor.nav.guide": "Vendor guide",
    /* --- Payout statuses --- */
    "payout.paid": "Paid",
    "payout.pending": "Pending",
    "payout.rejected": "Rejected",
    "payout.cancelled": "Cancelled",
    "payout.sent": "Sent",
    "payout.completed": "Completed",
    "vendor.stock.pickupTitle": "Livo stock pickup",
    "vendor.stock.approvedCount": "approved product(s) ready to ship",
    "vendor.stock.requestPickup": "Request a pickup",
    "vendor.error.authNotReady": "Session not ready. Redirecting to the home page...",
    "vendor.error.notVendor": "This account is not a vendor account. Redirecting...",
    "vendor.error.profileMissing": "Vendor profile missing. Contact support.",

    /* --- Product statuses --- */
    "product.status.approved": "Approved",
    "product.status.pending": "Under review",
    "product.status.rejected": "Rejected",
    "product.status.suspended": "Suspended",

    /* --- Section « My contract » --- */
    "vendor.contract.version": "Version",
    "vendor.contract.statusUpToDate": "✅ Contract up to date",
    "vendor.contract.statusOutdated":
      "⚠️ Outdated contract — re-signature required",
    "vendor.contract.statusMissing": "❌ No contract signed",
    "vendor.contract.signedOn": "Signed on {date}",
    "vendor.contract.language": "Language",
    "vendor.contract.view": "View",
    "vendor.contract.print": "Print",
    "vendor.contract.download": "Download (.txt)",
    "vendor.contract.verify": "Verify integrity",
    "vendor.contract.verifyOk": "✅ Integrity verified",
    "vendor.contract.verifyFail": "❌ Cannot verify: {reason}",
    "vendor.contract.verifyRunning": "⏳ Verifying...",
    "vendor.contract.sectionTitle": "My contract",
    "vendor.contract.hash": "SHA-256 hash",
    "vendor.contract.loadFailed": "Cannot load contract.",
    "vendor.contract.notFound": "No signed contract to display.",
    "vendor.contract.signNow": "Sign contract",
    "vendor.contract.readOnlyHint": "Read-only — signed version",

    /* --- Re-signature banner + transition retry --- */
    "vendor.banner.resignRequired":
      "⚠️ A new contract version ({version}) is available. Sign it before {date} to avoid blocking publishing and withdrawals.",
    "vendor.banner.resignNow": "Sign now",
    "vendor.banner.contractTransitionFailed":
      "⚠️ Contract signed but profile sync failed. Complete it to unlock your account.",
    "vendor.banner.finalize": "Finalize",
    "vendor.banner.finalizeSuccess": "✅ Profile synchronized",
    "vendor.banner.finalizeFail": "❌ Sync failed. Contact support.",

    /* --- Vendor signup : user transition --- */
    "vendor.signup.transitionFailed":
      "⚠️ Account created and contract signed, but profile sync failed. Complete from the dashboard.",
  });
  /* --- ENGLISH : stock / pickup --- */
  Object.assign(window.translations.en, {
    "vendor.pickup.notConfiguredTitle": "Logistics mode not configured",
    "vendor.pickup.notConfiguredBody": "Contact the administration to enable Smart Swika warehouse mode.",
    "vendor.pickup.status.pending": "⏳ Pending admin approval",
    "vendor.pickup.status.approved": "✅ Approved — stock received",
    "vendor.pickup.status.rejected": "❌ Rejected",
    "vendor.pickup.printLabels": "🖨️ Print labels ({count})",
    "vendor.pickup.desiredDate": "Requested date: {date}",
    "vendor.pickup.empty": "No request yet.",
    "vendor.pickup.title": "📦 Pickup to the Smart Swika warehouse",
    "vendor.pickup.intro": "Declare the products and quantities you will hand over to Smart Swika. One line = one variant (size / color), with its own SKU. After admin approval the stock is received at the warehouse; you can then create the product sheet.",
    "vendor.pickup.introStrong": "No product can be added before this approval.",
    "vendor.pickup.myRequests": "My requests",
    "vendor.pickup.newRequest": "New pickup request",
    "vendor.pickup.addProduct": "＋ Add a product",
    "vendor.pickup.dateLabel": "Preferred pickup date (DD/MM/YYYY) *",
    "vendor.pickup.commentLabel": "Comment (optional)",
    "vendor.pickup.commentPlaceholder": "Address, time, access...",
    "vendor.pickup.submit": "Send the request to Smart Swika",
    "vendor.pickup.sending": "Sending...",
    "vendor.pickup.namePlaceholder": "Product name",
    "vendor.pickup.qtyPlaceholder": "Qty",
    "vendor.pickup.sizePlaceholder": "Size",
    "vendor.pickup.colorPlaceholder": "Color",
    "vendor.pickup.removeRow": "Remove",
    "vendor.pickup.errNoItem": "Add at least one product.",
    "vendor.pickup.errQty": "Enter a valid quantity for each product.",
    "vendor.pickup.errDate": "Invalid date: DD/MM/YYYY format, not in the past.",
    "vendor.pickup.errGeneric": "Error: {message}",
    "vendor.pickup.sent": "Pickup request sent. Pending admin approval.",
    "vendor.pickup.labelsNotApproved": "Labels are available only after admin approval.",
    "vendor.pickup.labelsEmpty": "No unit received: no label to print.",
    "vendor.pickup.labelFooter": "Smart Swika — warehouse",
    "vendor.pickup.productFallback": "Product"
  });


  /* --- ARABE : stock / ramassage --- */
  Object.assign(window.translations.ar, {
    "vendor.pickup.notConfiguredTitle": "وضع اللوجستيك غير مُهيّأ",
    "vendor.pickup.notConfiguredBody": "اتصل بالإدارة لتفعيل وضع مخزن Smart Swika.",
    "vendor.pickup.status.pending": "⏳ في انتظار مصادقة الإدارة",
    "vendor.pickup.status.approved": "✅ مقبول — تم استلام المخزون",
    "vendor.pickup.status.rejected": "❌ مرفوض",
    "vendor.pickup.printLabels": "🖨️ طباعة الملصقات ({count})",
    "vendor.pickup.desiredDate": "التاريخ المطلوب: {date}",
    "vendor.pickup.empty": "لا يوجد أي طلب حالياً.",
    "vendor.pickup.title": "📦 جمع الشحنة إلى مخزن Smart Swika",
    "vendor.pickup.intro": "صرّح بالمنتجات والكميات التي ستُسلّم إلى Smart Swika. كل سطر = متغيّر واحد (المقاس / اللون) برمز SKU خاص به. بعد مصادقة الإدارة يُستلم المخزون في المخزن، وبعدها يمكنك إنشاء بطاقة المنتج.",
    "vendor.pickup.introStrong": "لا يمكن إضافة أي منتج قبل هذه الموافقة.",
    "vendor.pickup.myRequests": "طلباتي",
    "vendor.pickup.newRequest": "طلب جمع جديد",
    "vendor.pickup.addProduct": "＋ إضافة منتج",
    "vendor.pickup.dateLabel": "تاريخ الجمع المطلوب (JJ/MM/AAAA) *",
    "vendor.pickup.commentLabel": "ملاحظة (اختياري)",
    "vendor.pickup.commentPlaceholder": "العنوان، التوقيت، الوصول...",
    "vendor.pickup.submit": "إرسال الطلب إلى Smart Swika",
    "vendor.pickup.sending": "جارٍ الإرسال...",
    "vendor.pickup.namePlaceholder": "اسم المنتج",
    "vendor.pickup.qtyPlaceholder": "الكمية",
    "vendor.pickup.sizePlaceholder": "المقاس",
    "vendor.pickup.colorPlaceholder": "اللون",
    "vendor.pickup.removeRow": "حذف",
    "vendor.pickup.errNoItem": "أضف منتجاً واحداً على الأقل.",
    "vendor.pickup.errQty": "أدخل كمية صحيحة لكل منتج.",
    "vendor.pickup.errDate": "تاريخ غير صالح: الصيغة JJ/MM/AAAA، ويجب ألا يكون في الماضي.",
    "vendor.pickup.errGeneric": "خطأ: {message}",
    "vendor.pickup.sent": "تم إرسال طلب الجمع. في انتظار مصادقة الإدارة.",
    "vendor.pickup.labelsNotApproved": "الملصقات متاحة فقط بعد مصادقة الإدارة.",
    "vendor.pickup.labelsEmpty": "لم تُستلم أي وحدة: لا يوجد ملصق للطباعة.",
    "vendor.pickup.labelFooter": "Smart Swika — المخزن",
    "vendor.pickup.productFallback": "منتج"
  });


  /* ============================================================
     STOCK / RAMASSAGE (onglet « Stock Fulfillment »)
     Correctif audit 2026-11-20 : la section était rendue par
     js/vendor-dashboard.js (renderStock) avec du français codé en
     dur — donc en français même quand le vendeur choisissait AR/EN.
     Toutes les chaînes passent désormais par tr()/trParams().
     ============================================================ */
  Object.assign(window.translations.fr, {
    "vendor.pickup.notConfiguredTitle": "Mode logistique non configuré",
    "vendor.pickup.notConfiguredBody": "Contactez l'administration pour activer le mode entrepôt Smart Swika.",
    "vendor.pickup.status.pending": "⏳ En attente de validation admin",
    "vendor.pickup.status.approved": "✅ Approuvée — stock réceptionné",
    "vendor.pickup.status.rejected": "❌ Refusée",
    "vendor.pickup.printLabels": "🖨️ Imprimer les étiquettes ({count})",
    "vendor.pickup.desiredDate": "Date souhaitée : {date}",
    "vendor.pickup.empty": "Aucune demande pour le moment.",
    "vendor.pickup.title": "📦 Ramassage vers l'entrepôt Smart Swika",
    "vendor.pickup.intro": "Déclarez les produits et quantités à remettre à Smart Swika. Une ligne = une variante (taille / couleur), avec son propre SKU. Après validation par l'administration, le stock est réceptionné à l'entrepôt ; vous pourrez alors créer la fiche produit.",
    "vendor.pickup.introStrong": "Aucun produit ne peut être ajouté avant cette approbation.",
    "vendor.pickup.myRequests": "Mes demandes",
    "vendor.pickup.newRequest": "Nouvelle demande de ramassage",
    "vendor.pickup.addProduct": "＋ Ajouter un produit",
    "vendor.pickup.dateLabel": "Date de ramassage souhaitée (JJ/MM/AAAA) *",
    "vendor.pickup.commentLabel": "Commentaire (optionnel)",
    "vendor.pickup.commentPlaceholder": "Adresse, horaire, accès...",
    "vendor.pickup.submit": "Envoyer la demande à Smart Swika",
    "vendor.pickup.sending": "Envoi...",
    "vendor.pickup.namePlaceholder": "Nom du produit",
    "vendor.pickup.qtyPlaceholder": "Qté",
    "vendor.pickup.sizePlaceholder": "Taille",
    "vendor.pickup.colorPlaceholder": "Couleur",
    "vendor.pickup.removeRow": "Retirer",
    "vendor.pickup.errNoItem": "Ajoutez au moins un produit.",
    "vendor.pickup.errQty": "Indiquez une quantité valide pour chaque produit.",
    "vendor.pickup.errDate": "Date invalide : format JJ/MM/AAAA, date non passée.",
    "vendor.pickup.errGeneric": "Erreur : {message}",
    "vendor.pickup.sent": "Demande de ramassage envoyée. En attente de validation admin.",
    "vendor.pickup.labelsNotApproved": "Étiquettes disponibles uniquement après approbation admin.",
    "vendor.pickup.labelsEmpty": "Aucune unité reçue : pas d'étiquette à imprimer.",
    "vendor.pickup.labelFooter": "Smart Swika — entrepôt",
    "vendor.pickup.productFallback": "Produit"
  });



  console.log(
    "✅ translations-vendor.js chargé — v1.0.0 (34 clés × 3 langues)"
  );
})();