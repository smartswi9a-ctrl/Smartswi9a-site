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
    /* --- Payout statuses (badges admin + dashboard vendeur) --- */
    "payout.paid": "Payé",
    "payout.pending": "En attente",
    "payout.rejected": "Rejeté",
    "payout.cancelled": "Annulé",

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
    /* --- Payout statuses --- */
    "payout.paid": "مدفوع",
    "payout.pending": "قيد الانتظار",
    "payout.rejected": "مرفوض",
    "payout.cancelled": "ملغى",

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
    /* --- Payout statuses --- */
    "payout.paid": "Paid",
    "payout.pending": "Pending",
    "payout.rejected": "Rejected",
    "payout.cancelled": "Cancelled",

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

  console.log(
    "✅ translations-vendor.js chargé — v1.0.0 (34 clés × 3 langues)"
  );
})();