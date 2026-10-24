/* ============================================================
   js/vendor-contract-text.js
   Textes du contrat vendeur Smart Swi9a — T9 (fichier v2.0.0)

   PRINCIPE (T9) :
   - Chaque version publiée du contrat possède un GABARIT FIGÉ
     dans CONTRACT_TEMPLATES. On n'édite JAMAIS un gabarit publié :
     pour modifier le contrat, on AJOUTE une nouvelle version.
   - Le texte produit est paramétré par un termsSnapshot (objet
     de valeurs figées : commission, délais, montants, version).
     Même snapshot + même version + même langue = même texte
     octet pour octet, indépendamment de CONFIG.VENDOR actuel.
   - buildTermsSnapshot() capture l'état de CONFIG.VENDOR au
     moment de la signature ; ce snapshot est stocké dans le
     document contracts/... et permet de re-vérifier plus tard
     (verifyContractIntegrity dans vendor-contract.js).
   - getContractText(lang, version, termsSnapshot) est PURE et
     DÉTERMINISTE.

   HISTORIQUE :
   - Version 1.1.0 : seul gabarit livré. Reproduit EXACTEMENT le
     texte actuel (interpolation CONFIG.VENDOR.CONTRACT_VERSION
     = '1.1.0'). Byte-pour-byte identique à l'ancien BUILDERS.
   - Version 1.0.0 : NON ARCHIVÉE (le texte a changé entre 1.0.0
     et 1.1.0 sans snapshot). Les contrats legacy contract_<uid>
     sans suffixe version n'ont ni termsSnapshot ni version :
     verifyContractIntegrity renverra reason:"snapshot manquant".
     L'admin les marquera legacyUnverifiable:true (voir admin.js,
     plus tard).

   GARDE-FOU : si CONFIG.VENDOR.CONTRACT_VERSION est incrémentée
   sans ajouter le gabarit correspondant dans CONTRACT_TEMPLATES,
   getContractText lèvera "version non supportée" : impossible de
   signer sans gabarit publié.

   DÉPENDANCES : ./config.js (CONFIG.VENDOR)
   EXPORTS : CONTRACT_LANGUAGES, CONTRACT_TEMPLATES,
             buildTermsSnapshot, getContractText,
             getSupportedContractVersions
   ============================================================ */

import { CONFIG } from "./config.js";

export const CONTRACT_LANGUAGES = ["fr", "ar", "en"];

/* ---------------- Helpers d'interpolation ---------------- */
function pct(rate) {
    return (Number(rate) * 100).toFixed(0);
}
function mad(amount) {
    return String(Number(amount) || 0);
}

/* ============================================================
   SNAPSHOT DES VALEURS FIGÉES
   Capture l'état de CONFIG.VENDOR au moment de la signature.
   Stocké dans contracts/... et réutilisé par getContractText
   pour reconstruire le texte signé.
   ============================================================ */
export function buildTermsSnapshot(config = CONFIG.VENDOR) {
    if (!config || typeof config !== "object") {
        throw new Error("buildTermsSnapshot : configuration VENDOR requise.");
    }
    const required = [
        "CONTRACT_VERSION", "COMMISSION_RATE", "COMMISSION_RATE_MIN",
        "COMMISSION_RATE_MAX", "DROPOFF_DEADLINE_HOURS_NEW",
        "DROPOFF_DEADLINE_HOURS_ESTABLISHED", "UNLOCK_DAYS_VENDOR",
        "UNLOCK_DAYS_SMART", "MIN_WITHDRAWAL", "RETURN_FEE_SPEEDAF"
    ];
    for (let i = 0; i < required.length; i++) {
        const k = required[i];
        if (config[k] === undefined || config[k] === null) {
            throw new Error("buildTermsSnapshot : CONFIG.VENDOR." + k + " manquant.");
        }
    }
    return {
        version: String(config.CONTRACT_VERSION),
        commissionRate: Number(config.COMMISSION_RATE),
        commissionRateMin: Number(config.COMMISSION_RATE_MIN),
        commissionRateMax: Number(config.COMMISSION_RATE_MAX),
        dropoffDeadlineHoursNew: Number(config.DROPOFF_DEADLINE_HOURS_NEW),
        dropoffDeadlineHoursEstablished: Number(config.DROPOFF_DEADLINE_HOURS_ESTABLISHED),
        unlockDaysVendor: Number(config.UNLOCK_DAYS_VENDOR),
        unlockDaysSmart: Number(config.UNLOCK_DAYS_SMART),
        minWithdrawal: Number(config.MIN_WITHDRAWAL),
        returnFeeSpeedaf: Number(config.RETURN_FEE_SPEEDAF)
    };
}

/* ============================================================
   GABARITS FIGÉS PAR VERSION
   Ne JAMAIS éditer un gabarit publié. Pour une nouvelle version :
   copier le gabarit précédent sous une nouvelle clé, adapter le
   texte, incrémenter CONFIG.VENDOR.CONTRACT_VERSION.
   ============================================================ */
export const CONTRACT_TEMPLATES = {
    "1.1.0": {
        fr: (t) => `CONTRAT DE PARTENARIAT VENDEUR — SMART SWI9A
Version ${t.version}

Article 1 — Objet
Le présent contrat encadre la mise en vente de produits par le Vendeur sur la plateforme Smart Swi9a (smartswi9a.top), marketplace marocaine d'appareils connectés et de produits pour la maison.

Article 2 — Inscription et vérification
Le Vendeur s'engage à fournir des informations exactes (nom de boutique, téléphone, ville, ICE ou CIN). Toute fausse déclaration entraîne la suspension immédiate du compte.

Article 3 — Commission
Smart Swi9a prélève une commission de ${pct(t.commissionRate)} % sur le montant hors livraison de chaque vente. Cette commission peut être ajustée entre ${pct(t.commissionRateMin)} % et ${pct(t.commissionRateMax)} % avec l'accord écrit du Vendeur.

Article 4 — Expédition
Le Vendeur choisit le dépôt en agence (drop-off) ou la logistique Smart Swi9a (fulfillment). Les délais de dépôt sont de ${t.dropoffDeadlineHoursNew} heures (nouveaux comptes) ou ${t.dropoffDeadlineHoursEstablished} heures (comptes matures). Tout retard peut entraîner une suspension.

Article 5 — Paiement
Les gains sont crédités sur le portefeuille vendeur et deviennent disponibles ${t.unlockDaysVendor} jours après livraison confirmée (${t.unlockDaysSmart} jours pour les produits Smart Swi9a). Le retrait minimum est de ${mad(t.minWithdrawal)} MAD.

Article 6 — Retours
En cas de retour, des frais de ${mad(t.returnFeeSpeedaf)} MAD sont prélevés par colis retourné. Les retours répétés peuvent entraîner une révision du statut du Vendeur.

Article 7 — Résiliation
Chaque partie peut résilier ce contrat à tout moment. Les commandes en cours restent soumises aux présentes conditions.

Article 8 — Loi applicable
Le présent contrat est régi par le droit marocain. Tout litige relève des tribunaux de Casablanca.

Article 9 — Signature électronique
La signature électronique vaut acceptation pleine et entière. L'IP, le user-agent, la date serveur et un hash SHA-256 du présent document sont enregistrés à titre de preuve.

En signant, le Vendeur reconnaît avoir lu et compris l'intégralité du présent contrat.`,

        ar: (t) => `عقد شراكة البائع — سمارت سويقة
الإصدار ${t.version}

المادة 1 — الموضوع
ينظم هذا العقد عرض البائع لمنتجاته للبيع على منصة سمارت سويقة (smartswi9a.top)، وهي سوق مغربية للأجهزة المتصلة ومنتجات المنزل.

المادة 2 — التسجيل والتحقق
يلتزم البائع بتقديم معلومات صحيحة (اسم المتجر، الهاتف، المدينة، ICE أو CIN). أي تصريح كاذب يؤدي إلى تعليق الحساب فوراً.

المادة 3 — العمولة
تقتطع سمارت سويقة عمولة قدرها ${pct(t.commissionRate)}% على مبلغ كل عملية بيع دون احتساب التوصيل. يمكن تعديل هذه العمولة بين ${pct(t.commissionRateMin)}% و${pct(t.commissionRateMax)}% بموافقة كتابية من البائع.

المادة 4 — الشحن
يختار البائع الإيداع في الوكالة (drop-off) أو لوجستيك سمارت سويقة (fulfillment). مهل الإيداع هي ${t.dropoffDeadlineHoursNew} ساعة (الحسابات الجديدة) أو ${t.dropoffDeadlineHoursEstablished} ساعة (الحسابات الناضجة). أي تأخير قد يؤدي إلى تعليق الحساب.

المادة 5 — الدفع
تُضاف الأرباح إلى محفظة البائع وتصبح متاحة بعد ${t.unlockDaysVendor} أيام من تأكيد التسليم (${t.unlockDaysSmart} يوماً لمنتجات سمارت سويقة). الحد الأدنى للسحب هو ${mad(t.minWithdrawal)} درهم.

المادة 6 — الإرجاع
في حالة الإرجاع، تُخصم رسوم قدرها ${mad(t.returnFeeSpeedaf)} درهماً لكل طرد مُرجع. الإرجاعات المتكررة قد تؤدي إلى مراجعة وضع البائع.

المادة 7 — الإنهاء
يمكن لأي طرف إنهاء هذا العقد في أي وقت. تبقى الطلبات الجارية خاضعة لهذه الشروط.

المادة 8 — القانون المطبق
يخضع هذا العقد للقانون المغربي. يختص القضاء في الدار البيضاء بأي نزاع.

المادة 9 — التوقيع الإلكتروني
التوقيع الإلكتروني يعتبر قبولاً تاماً وصريحاً. يتم تسجيل عنوان IP، ووكيل المستخدم، وتاريخ الخادم، وبصمة SHA-256 لهذا المستند كدليل.

بالتوقيع، يقر البائع بأنه قرأ وفهم كامل هذا العقد.`,

        en: (t) => `VENDOR PARTNERSHIP AGREEMENT — SMART SWI9A
Version ${t.version}

Article 1 — Purpose
This agreement governs the listing and sale of products by the Vendor on Smart Swi9a (smartswi9a.top), a Moroccan marketplace for connected devices and home products.

Article 2 — Registration and verification
The Vendor agrees to provide accurate information (shop name, phone, city, ICE or CIN). Any false statement results in immediate account suspension.

Article 3 — Commission
Smart Swi9a charges a ${pct(t.commissionRate)}% commission on the delivery-excluded amount of each sale. This commission may be adjusted between ${pct(t.commissionRateMin)}% and ${pct(t.commissionRateMax)}% with the Vendor's written consent.

Article 4 — Shipping
The Vendor chooses agency drop-off or Smart Swi9a fulfillment. Drop-off deadlines are ${t.dropoffDeadlineHoursNew} hours (new accounts) or ${t.dropoffDeadlineHoursEstablished} hours (mature accounts). Any delay may result in suspension.

Article 5 — Payment
Earnings are credited to the vendor wallet and become available ${t.unlockDaysVendor} days after confirmed delivery (${t.unlockDaysSmart} days for Smart Swi9a products). Minimum withdrawal is ${mad(t.minWithdrawal)} MAD.

Article 6 — Returns
In case of return, a ${mad(t.returnFeeSpeedaf)} MAD fee is charged per returned parcel. Repeated returns may lead to a review of the Vendor's status.

Article 7 — Termination
Either party may terminate this agreement at any time. Pending orders remain subject to these terms.

Article 8 — Governing law
This agreement is governed by Moroccan law. Any dispute falls under the jurisdiction of the courts of Casablanca.

Article 9 — Electronic signature
The electronic signature constitutes full acceptance. The IP, user-agent, server date, and a SHA-256 hash of this document are recorded as evidence.

By signing, the Vendor acknowledges having read and understood this entire agreement.`
    }
};

/* ============================================================
   API PUBLIQUE
   ============================================================ */

/**
 * Retourne le texte du contrat pour (langue, version, snapshot).
 * PURE et DÉTERMINISTE : mêmes arguments = même texte octet pour octet.
 *
 * @param {string} [lang='fr']          — 'fr' | 'ar' | 'en'
 * @param {string} [version]            — semver (défaut: CONFIG.VENDOR.CONTRACT_VERSION)
 * @param {object|null} [termsSnapshot] — snapshot figé (défaut: buildTermsSnapshot())
 * @returns {string} Texte prêt à afficher et à hasher.
 */
export function getContractText(
    lang = "fr",
    version = CONFIG.VENDOR.CONTRACT_VERSION,
    termsSnapshot = null
) {
    const templates = CONTRACT_TEMPLATES[version];
    if (!templates) {
        throw new Error("getContractText : version de contrat non supportée (" + version + ").");
    }
    const builder = templates[lang] || templates.fr;
    if (typeof builder !== "function") {
        throw new Error("getContractText : gabarit indisponible pour la langue " + lang + ".");
    }
    const snapshot = (termsSnapshot && typeof termsSnapshot === "object")
        ? termsSnapshot
        : buildTermsSnapshot();
    if (String(snapshot.version) !== String(version)) {
        throw new Error(
            "getContractText : incohérence version (gabarit " + version +
            " vs snapshot " + snapshot.version + ")."
        );
    }
    return builder(snapshot);
}

/**
 * Retourne les versions de contrat disponibles dans CONTRACT_TEMPLATES,
 * triées en semver croissant. Ex. actuellement : ['1.1.0'].
 */
export function getSupportedContractVersions() {
    const keys = Object.keys(CONTRACT_TEMPLATES);
    return keys.sort(function (a, b) {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
            if (pa[i] !== pb[i]) return pa[i] - pb[i];
        }
        return 0;
    });
}