/* ============================================================
   js/translations-livo.js
   Traductions spécifiques Livo + clés manquantes - Smart Swi9a
   Version 1.0.0 - Lot 47 : fixes i18n + clés product-detail

   Rôle : complète window.translations.fr / .ar / .en avec :
     - La correction de vendor.stock.empty.desc (Speedaf -> Livo)
       dans les 3 langues. La clé originale est dans
       translations.js (base) et n'est PAS modifiée (règle :
       ne jamais réécrire translations.js).
     - Les clés manquantes utilisées par product-detail.js :
       productDimensionsTitle, productWeight, productLength,
       productWidth, productHeight.
     - Les clés manquantes du guide des tailles : sizeGuideTitle,
       sizeGuideHint, sizeGuideSize, sizeGuideUS, sizeGuideBust,
       sizeGuideWaist, sizeGuideLength, sizeGuideHowTitle,
       sizeGuideBustHelp, sizeGuideWaistHelp, sizeGuideLengthHelp.
     - Les clés manquantes des avis : reviewsShowAll, reviewsShowLess.

   Chargé APRÈS /translations.js sur :
     - /produit.html (product-detail keys)
     - /vendor/dashboard.html (vendor.stock.empty.desc)
     - (toute autre page nécessitant ces clés)

   IMPORTANT : ce fichier ne contient AUCUN commentaire de ligne
   (//). Tous les commentaires sont en bloc pour résister à un
   aplatissement éventuel.

   Couverture : 19 clés x 3 langues = 57 entrées.

   Dépendance : window.translations doit exister (chargé depuis
   /translations.js). Si absent, on l'initialise vide.
   ============================================================ */

(function () {
    "use strict";

    if (!window.translations) {
        window.translations = { fr: {}, ar: {}, en: {} };
    }
    if (!window.translations.fr) window.translations.fr = {};
    if (!window.translations.ar) window.translations.ar = {};
    if (!window.translations.en) window.translations.en = {};

    /* ============================================================
       FRANÇAIS (fr)
       ============================================================ */
    Object.assign(window.translations.fr, {
        "vendor.stock.empty.desc": "L'envoi de stock à notre entrepôt partenaire Livo sera disponible prochainement. Contactez le support pour plus d'informations.",
        "productDimensionsTitle": "Dimensions & Poids",
        "productWeight": "Poids",
        "productLength": "Longueur",
        "productWidth": "Largeur",
        "productHeight": "Hauteur",
        "sizeGuideTitle": "Guide des tailles",
        "sizeGuideHint": "Ce guide est basé sur des mesures standard. Si vous êtes entre deux tailles, nous vous conseillons de choisir la taille supérieure.",
        "sizeGuideSize": "Taille",
        "sizeGuideUS": "US",
        "sizeGuideBust": "Buste (cm)",
        "sizeGuideWaist": "Taille (cm)",
        "sizeGuideLength": "Longueur (cm)",
        "sizeGuideHowTitle": "Comment prendre vos mesures ?",
        "sizeGuideBustHelp": "Mesurez horizontalement autour de la partie la plus forte de la poitrine.",
        "sizeGuideWaistHelp": "Mesurez autour de la partie la plus fine de votre taille.",
        "sizeGuideLengthHelp": "Du point le plus haut de l'épaule jusqu'au bas du vêtement.",
        "reviewsShowAll": "Afficher tous les commentaires",
        "reviewsShowLess": "Voir moins d'avis"
    });

    /* ============================================================
       ARABE (ar)
       ============================================================ */
    Object.assign(window.translations.ar, {
        "vendor.stock.empty.desc": "سيكون إرسال المخزون إلى مستودع شريكنا Livo متاحًا قريبًا. اتصل بالدعم لمزيد من المعلومات.",
        "productDimensionsTitle": "الأبعاد والوزن",
        "productWeight": "الوزن",
        "productLength": "الطول",
        "productWidth": "العرض",
        "productHeight": "الارتفاع",
        "sizeGuideTitle": "دليل المقاسات",
        "sizeGuideHint": "هذا الدليل مبني على قياسات معيارية. إذا كنت بين مقاسين، ننصحك باختيار المقاس الأكبر.",
        "sizeGuideSize": "المقاس",
        "sizeGuideUS": "أمريكي",
        "sizeGuideBust": "الصدر (سم)",
        "sizeGuideWaist": "الخصر (سم)",
        "sizeGuideLength": "الطول (سم)",
        "sizeGuideHowTitle": "كيف تأخذ قياساتك؟",
        "sizeGuideBustHelp": "قِس أفقيًا حول أوسع جزء من الصدر.",
        "sizeGuideWaistHelp": "قِس حول أضيق جزء من خصرك.",
        "sizeGuideLengthHelp": "من أعلى نقطة في الكتف حتى أسفل الملابس.",
        "reviewsShowAll": "عرض جميع التعليقات",
        "reviewsShowLess": "عرض عدد أقل من التقييمات"
    });

    /* ============================================================
       ANGLAIS (en)
       ============================================================ */
    Object.assign(window.translations.en, {
        "vendor.stock.empty.desc": "Sending stock to our Livo partner warehouse will be available soon. Contact support for more information.",
        "productDimensionsTitle": "Dimensions & Weight",
        "productWeight": "Weight",
        "productLength": "Length",
        "productWidth": "Width",
        "productHeight": "Height",
        "sizeGuideTitle": "Size Guide",
        "sizeGuideHint": "This guide is based on standard measurements. If you are between two sizes, we recommend choosing the larger size.",
        "sizeGuideSize": "Size",
        "sizeGuideUS": "US",
        "sizeGuideBust": "Bust (cm)",
        "sizeGuideWaist": "Waist (cm)",
        "sizeGuideLength": "Length (cm)",
        "sizeGuideHowTitle": "How to take your measurements?",
        "sizeGuideBustHelp": "Measure horizontally around the fullest part of the bust.",
        "sizeGuideWaistHelp": "Measure around the narrowest part of your waist.",
        "sizeGuideLengthHelp": "From the highest point of the shoulder to the bottom of the garment.",
        "reviewsShowAll": "Show all reviews",
        "reviewsShowLess": "Show fewer reviews"
    });

    console.log("✅ translations-livo.js chargé — v1.0.0 (19 clés × 3 langues)");
})();