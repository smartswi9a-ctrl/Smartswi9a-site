// js/vendor-contract-text.js
// ============================================================
// TEXTES DU CONTRAT VENDEUR - SMART SWI9A
// Version 1.0.0 — Source unique de vérité pour tous les contrats
// Interpole les valeurs depuis CONFIG.VENDOR (N10)
// ============================================================

import { CONFIG } from "./config.js";

// ============================================================
// HELPERS D'INTERPOLATION
// ============================================================
function pct(rate) {
    // 0.07 → "7"
    return (Number(rate) * 100).toFixed(0);
}
function mad(amount) {
    return String(Number(amount) || 0);
}

// ============================================================
// TEXTES FIGÉS PAR LANGUE (avec interpolation CONFIG)
// ⚠️ À faire relire par un juriste avant production.
// Toute modification du texte impose d'incrémenter
// CONFIG.VENDOR.CONTRACT_VERSION dans config.js.
// ============================================================
const BUILDERS = {
    fr: () => `CONTRAT DE PARTENARIAT VENDEUR — SMART SWI9A
Version ${CONFIG.VENDOR.CONTRACT_VERSION}

Article 1 — Objet
Le présent contrat encadre la mise en vente de produits par le Vendeur sur la plateforme Smart Swi9a (smartswi9a.top), marketplace marocaine d'appareils connectés et de produits pour la maison.

Article 2 — Inscription et vérification
Le Vendeur s'engage à fournir des informations exactes (nom de boutique, téléphone, ville, ICE ou CIN). Toute fausse déclaration entraîne la suspension immédiate du compte.

Article 3 — Commission
Smart Swi9a prélève une commission de ${pct(CONFIG.VENDOR.COMMISSION_RATE)} % sur le montant hors livraison de chaque vente. Cette commission peut être ajustée entre ${pct(CONFIG.VENDOR.COMMISSION_RATE_MIN)} % et ${pct(CONFIG.VENDOR.COMMISSION_RATE_MAX)} % avec l'accord écrit du Vendeur.

Article 4 — Expédition
Le Vendeur choisit le dépôt en agence (drop-off) ou la logistique Smart Swi9a (fulfillment). Les délais de dépôt sont de ${CONFIG.VENDOR.DROPOFF_DEADLINE_HOURS_NEW} heures (nouveaux comptes) ou ${CONFIG.VENDOR.DROPOFF_DEADLINE_HOURS_ESTABLISHED} heures (comptes matures). Tout retard peut entraîner une suspension.

Article 5 — Paiement
Les gains sont crédités sur le portefeuille vendeur et deviennent disponibles ${CONFIG.VENDOR.UNLOCK_DAYS_VENDOR} jours après livraison confirmée (${CONFIG.VENDOR.UNLOCK_DAYS_SMART} jours pour les produits Smart Swi9a). Le retrait minimum est de ${mad(CONFIG.VENDOR.MIN_WITHDRAWAL)} MAD.

Article 6 — Retours
En cas de retour, des frais de ${mad(CONFIG.VENDOR.RETURN_FEE_SPEEDAF)} MAD sont prélevés par colis retourné. Les retours répétés peuvent entraîner une révision du statut du Vendeur.

Article 7 — Résiliation
Chaque partie peut résilier ce contrat à tout moment. Les commandes en cours restent soumises aux présentes conditions.

Article 8 — Loi applicable
Le présent contrat est régi par le droit marocain. Tout litige relève des tribunaux de Casablanca.

Article 9 — Signature électronique
La signature électronique vaut acceptation pleine et entière. L'IP, le user-agent, la date serveur et un hash SHA-256 du présent document sont enregistrés à titre de preuve.

En signant, le Vendeur reconnaît avoir lu et compris l'intégralité du présent contrat.`,

    ar: () => `عقد شراكة البائع — سمارت سويقة
الإصدار ${CONFIG.VENDOR.CONTRACT_VERSION}

المادة 1 — الموضوع
ينظم هذا العقد عرض البائع لمنتجاته للبيع على منصة سمارت سويقة (smartswi9a.top)، وهي سوق مغربية للأجهزة المتصلة ومنتجات المنزل.

المادة 2 — التسجيل والتحقق
يلتزم البائع بتقديم معلومات صحيحة (اسم المتجر، الهاتف، المدينة، ICE أو CIN). أي تصريح كاذب يؤدي إلى تعليق الحساب فوراً.

المادة 3 — العمولة
تقتطع سمارت سويقة عمولة قدرها ${pct(CONFIG.VENDOR.COMMISSION_RATE)}% على مبلغ كل عملية بيع دون احتساب التوصيل. يمكن تعديل هذه العمولة بين ${pct(CONFIG.VENDOR.COMMISSION_RATE_MIN)}% و${pct(CONFIG.VENDOR.COMMISSION_RATE_MAX)}% بموافقة كتابية من البائع.

المادة 4 — الشحن
يختار البائع الإيداع في الوكالة (drop-off) أو لوجستيك سمارت سويقة (fulfillment). مهل الإيداع هي ${CONFIG.VENDOR.DROPOFF_DEADLINE_HOURS_NEW} ساعة (الحسابات الجديدة) أو ${CONFIG.VENDOR.DROPOFF_DEADLINE_HOURS_ESTABLISHED} ساعة (الحسابات الناضجة). أي تأخير قد يؤدي إلى تعليق الحساب.

المادة 5 — الدفع
تُضاف الأرباح إلى محفظة البائع وتصبح متاحة بعد ${CONFIG.VENDOR.UNLOCK_DAYS_VENDOR} أيام من تأكيد التسليم (${CONFIG.VENDOR.UNLOCK_DAYS_SMART} يوماً لمنتجات سمارت سويقة). الحد الأدنى للسحب هو ${mad(CONFIG.VENDOR.MIN_WITHDRAWAL)} درهم.

المادة 6 — الإرجاع
في حالة الإرجاع، تُخصم رسوم قدرها ${mad(CONFIG.VENDOR.RETURN_FEE_SPEEDAF)} درهماً لكل طرد مُرجع. الإرجاعات المتكررة قد تؤدي إلى مراجعة وضع البائع.

المادة 7 — الإنهاء
يمكن لأي طرف إنهاء هذا العقد في أي وقت. تبقى الطلبات الجارية خاضعة لهذه الشروط.

المادة 8 — القانون المطبق
يخضع هذا العقد للقانون المغربي. يختص القضاء في الدار البيضاء بأي نزاع.

المادة 9 — التوقيع الإلكتروني
التوقيع الإلكتروني يعتبر قبولاً تاماً وصريحاً. يتم تسجيل عنوان IP، ووكيل المستخدم، وتاريخ الخادم، وبصمة SHA-256 لهذا المستند كدليل.

بالتوقيع، يقر البائع بأنه قرأ وفهم كامل هذا العقد.`,

    en: () => `VENDOR PARTNERSHIP AGREEMENT — SMART SWI9A
Version ${CONFIG.VENDOR.CONTRACT_VERSION}

Article 1 — Purpose
This agreement governs the listing and sale of products by the Vendor on Smart Swi9a (smartswi9a.top), a Moroccan marketplace for connected devices and home products.

Article 2 — Registration and verification
The Vendor agrees to provide accurate information (shop name, phone, city, ICE or CIN). Any false statement results in immediate account suspension.

Article 3 — Commission
Smart Swi9a charges a ${pct(CONFIG.VENDOR.COMMISSION_RATE)}% commission on the delivery-excluded amount of each sale. This commission may be adjusted between ${pct(CONFIG.VENDOR.COMMISSION_RATE_MIN)}% and ${pct(CONFIG.VENDOR.COMMISSION_RATE_MAX)}% with the Vendor's written consent.

Article 4 — Shipping
The Vendor chooses agency drop-off or Smart Swi9a fulfillment. Drop-off deadlines are ${CONFIG.VENDOR.DROPOFF_DEADLINE_HOURS_NEW} hours (new accounts) or ${CONFIG.VENDOR.DROPOFF_DEADLINE_HOURS_ESTABLISHED} hours (mature accounts). Any delay may result in suspension.

Article 5 — Payment
Earnings are credited to the vendor wallet and become available ${CONFIG.VENDOR.UNLOCK_DAYS_VENDOR} days after confirmed delivery (${CONFIG.VENDOR.UNLOCK_DAYS_SMART} days for Smart Swi9a products). Minimum withdrawal is ${mad(CONFIG.VENDOR.MIN_WITHDRAWAL)} MAD.

Article 6 — Returns
In case of return, a ${mad(CONFIG.VENDOR.RETURN_FEE_SPEEDAF)} MAD fee is charged per returned parcel. Repeated returns may lead to a review of the Vendor's status.

Article 7 — Termination
Either party may terminate this agreement at any time. Pending orders remain subject to these terms.

Article 8 — Governing law
This agreement is governed by Moroccan law. Any dispute falls under the jurisdiction of the courts of Casablanca.

Article 9 — Electronic signature
The electronic signature constitutes full acceptance. The IP, user-agent, server date, and a SHA-256 hash of this document are recorded as evidence.

By signing, the Vendor acknowledges having read and understood this entire agreement.`
};

// ============================================================
// API PUBLIQUE
// ============================================================
/**
 * Retourne le texte du contrat pour une langue donnée.
 * Les valeurs (commission, délais, montants) sont interpolées
 * depuis CONFIG.VENDOR au moment de l'appel — si on change la
 * config, le texte change automatiquement.
 *
 * @param {string} lang — 'fr' | 'ar' | 'en'
 * @returns {string} Texte du contrat prêt à afficher et à hasher.
 */
export function getContractText(lang = 'fr') {
    const builder = BUILDERS[lang] || BUILDERS.fr;
    return builder();
}

/**
 * Retourne la liste des langues supportées.
 */
export const CONTRACT_LANGUAGES = Object.keys(BUILDERS);

console.log('✅ vendor-contract-text.js chargé — v1.0.0 (textes interpolés)');