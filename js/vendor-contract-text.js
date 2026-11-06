/* ============================================================ js/vendor-contract-text.js Textes du contrat vendeur Smart Swi9a — Lot 26/30 Version 9.0.0 — Ajout gabarit 1.2.0 (vocabulaire Livo) CHANGEMENTS v9.0.0 : - B-CT-1 (P0) : ajout du gabarit 1.2.0 dans CONTRACT_TEMPLATES (3 langues). Aligné sur CONFIG.VENDOR.CONTRACT_VERSION = '1.2.0' (config.js v9.0.0). Sans ce gabarit, toute signature échouait. - B-CT-2 (P1) : buildTermsSnapshot() retourne désormais returnFeeLivo (nouveau nom canonique) en plus de returnFeeSpeedaf (ancien nom, conservé pour compatibilité du gabarit 1.1.0). - Gabarit 1.1.0 CONSERVÉ pour lecture des contrats existants. - JSDoc enrichi. - Bump version 2.0.0 -> 9.0.0. PRINCIPE (inchangé depuis T9) : - Chaque version publiée possède un GABARIT FIGÉ dans CONTRACT_TEMPLATES. On n'édite JAMAIS un gabarit publié. - Pour modifier le contrat : AJOUTER une nouvelle version (nouveau gabarit) + incrémenter CONFIG.VENDOR.CONTRACT_VERSION. - Le texte est paramétré par un termsSnapshot figé au moment de la signature. Même snapshot + version + langue = texte identique octet pour octet. - buildTermsSnapshot() capture l'état actuel de CONFIG.VENDOR. - getContractText() est PURE et DÉTERMINISTE. DIFFÉRENCE 1.1.0 vs 1.2.0 : - Article 6 (Retours) : mention "Livo" au lieu du nom historique du transporteur. - termsSnapshot.returnFeeLivo (nouveau) au lieu de termsSnapshot.returnFeeSpeedaf. - Le reste du texte est identique (aucun changement sémantique). - Un vendeur signataire 1.1.0 est invité à re-signer 1.2.0 dans les CONTRACT_RESIGN_GRACE_DAYS jours (30), grâce au système needsResign() de vendor-contract.js. GARDE-FOU : si CONFIG.VENDOR.CONTRACT_VERSION est incrémentée sans ajouter le gabarit correspondant, getContractText lèvera "version non supportée". Impossible de signer sans gabarit publié. DÉPENDANCES : ./config.js (CONFIG.VENDOR) EXPORTS : CONTRACT_LANGUAGES, CONTRACT_TEMPLATES, buildTermsSnapshot, getContractText, getSupportedContractVersions ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import { CONFIG } from "./config.js";

export const CONTRACT_LANGUAGES = ["fr", "ar", "en"];

/* ============================================================ HELPERS D'INTERPOLATION ============================================================ */
function pct(rate) {
  return (Number(rate) * 100).toFixed(0);
}
function mad(amount) {
  return String(Number(amount) || 0);
}

/* ============================================================ SNAPSHOT DES VALEURS FIGÉES ============================================================ Capture l'état de CONFIG.VENDOR au moment de la signature. Stocké dans contracts/{id} et réutilisé par getContractText pour reconstruire le texte signé. NOTE : retourne à la fois returnFeeLivo (nouveau) et returnFeeSpeedaf (ancien), pour permettre aux gabarits 1.1.0 et 1.2.0 de cohabiter sans casser la lecture des contrats existants. ============================================================ */

/** * Capture l'état actuel de CONFIG.VENDOR sous forme de snapshot * figé. Le snapshot est stocké dans le document contracts/{id} * et permet de reconstruire le texte signé plus tard. * * @param {Object} [config=CONFIG.VENDOR] - Config VENDOR (défaut). * @returns {Object} Snapshot { version, commissionRate, ..., returnFeeLivo, returnFeeSpeedaf } * @throws {Error} si un champ requis de CONFIG.VENDOR est manquant. */
export function buildTermsSnapshot(config = CONFIG.VENDOR) {
  if (!config || typeof config !== "object") {
    throw new Error("buildTermsSnapshot : configuration VENDOR requise.");
  }
  const required = [
    "CONTRACT_VERSION",
    "COMMISSION_RATE",
    "COMMISSION_RATE_MIN",
    "COMMISSION_RATE_MAX",
    "DROPOFF_DEADLINE_HOURS_NEW",
    "DROPOFF_DEADLINE_HOURS_ESTABLISHED",
    "UNLOCK_DAYS_VENDOR",
    "UNLOCK_DAYS_SMART",
    "MIN_WITHDRAWAL",
  ];
  for (let i = 0; i < required.length; i++) {
    const k = required[i];
    if (config[k] === undefined || config[k] === null) {
      throw new Error("buildTermsSnapshot : CONFIG.VENDOR." + k + " manquant.");
    }
  }

  /* B-CT-2 : on lit les DEUX noms (nouveau canonique + ancien), avec fallback croisé pour ne jamais retourner undefined si un seul des deux est défini. */
  const returnFeeLivo =
    config.RETURN_FEE_LIVO !== undefined
      ? config.RETURN_FEE_LIVO
      : config.RETURN_FEE_SPEEDAF;
  const returnFeeSpeedaf =
    config.RETURN_FEE_SPEEDAF !== undefined
      ? config.RETURN_FEE_SPEEDAF
      : config.RETURN_FEE_LIVO;

  return {
    version: String(config.CONTRACT_VERSION),
    commissionRate: Number(config.COMMISSION_RATE),
    commissionRateMin: Number(config.COMMISSION_RATE_MIN),
    commissionRateMax: Number(config.COMMISSION_RATE_MAX),
    dropoffDeadlineHoursNew: Number(config.DROPOFF_DEADLINE_HOURS_NEW),
    dropoffDeadlineHoursEstablished: Number(
      config.DROPOFF_DEADLINE_HOURS_ESTABLISHED
    ),
    unlockDaysVendor: Number(config.UNLOCK_DAYS_VENDOR),
    unlockDaysSmart: Number(config.UNLOCK_DAYS_SMART),
    minWithdrawal: Number(config.MIN_WITHDRAWAL),
    /* Nouveau nom canonique (1.2.0). */
    returnFeeLivo: Number(returnFeeLivo) || 0,
    /* Ancien nom conservé pour compatibilité du gabarit 1.1.0. */
    returnFeeSpeedaf: Number(returnFeeSpeedaf) || 0,
  };
}

/* ============================================================ GABARITS FIGÉS PAR VERSION ============================================================ Ne JAMAIS éditer un gabarit publié. Pour une nouvelle version : copier le gabarit précédent sous une nouvelle clé, adapter le texte, incrémenter CONFIG.VENDOR.CONTRACT_VERSION. ============================================================ */
export const CONTRACT_TEMPLATES = {
  /* ============================================================ VERSION 1.1.0 (T9 — historique) ============================================================ Conservé pour lecture des contrats déjà signés en 1.1.0. Utilise t.returnFeeSpeedaf (ancien nom du champ). À ne PAS modifier. ============================================================ */
  "1.1.0": {
    fr: (t) => `CONTRAT DE PARTENARIAT VENDEUR — SMART SWI9A Version ${t.version} Article 1 — Objet Le présent contrat encadre la mise en vente de produits par le Vendeur sur la plateforme Smart Swi9a (smartswi9a.top), marketplace marocaine d'appareils connectés et de produits pour la maison. Article 2 — Inscription et vérification Le Vendeur s'engage à fournir des informations exactes (nom de boutique, téléphone, ville, ICE ou CIN). Toute fausse déclaration entraîne la suspension immédiate du compte. Article 3 — Commission Smart Swi9a prélève une commission de ${pct( t.commissionRate )} % sur le montant hors livraison de chaque vente. Cette commission peut être ajustée entre ${pct( t.commissionRateMin )} % et ${pct(t.commissionRateMax)} % avec l'accord écrit du Vendeur. Article 4 — Expédition Le Vendeur choisit le dépôt en agence (drop-off) ou la logistique Smart Swi9a (fulfillment). Les délais de dépôt sont de ${ t.dropoffDeadlineHoursNew } heures (nouveaux comptes) ou ${ t.dropoffDeadlineHoursEstablished } heures (comptes matures). Tout retard peut entraîner une suspension. Article 5 — Paiement Les gains sont crédités sur le portefeuille vendeur et deviennent disponibles ${ t.unlockDaysVendor } jours après livraison confirmée (${ t.unlockDaysSmart } jours pour les produits Smart Swi9a). Le retrait minimum est de ${mad( t.minWithdrawal )} MAD. Article 6 — Retours En cas de retour, des frais de ${mad( t.returnFeeSpeedaf )} MAD sont prélevés par colis retourné. Les retours répétés peuvent entraîner une révision du statut du Vendeur. Article 7 — Résiliation Chaque partie peut résilier ce contrat à tout moment. Les commandes en cours restent soumises aux présentes conditions. Article 8 — Loi applicable Le présent contrat est régi par le droit marocain. Tout litige relève des tribunaux de Casablanca. Article 9 — Signature électronique La signature électronique vaut acceptation pleine et entière. L'IP, le user-agent, la date serveur et un hash SHA-256 du présent document sont enregistrés à titre de preuve. En signant, le Vendeur reconnaît avoir lu et compris l'intégralité du présent contrat.`,

    ar: (t) => `عقد شراكة البائع — سمارت سويقة الإصدار ${t.version} المادة 1 — الموضوع ينظم هذا العقد عرض البائع لمنتجاته للبيع على منصة سمارت سويقة (smartswi9a.top)، وهي سوق مغربية للأجهزة المتصلة ومنتجات المنزل. المادة 2 — التسجيل والتحقق يلتزم البائع بتقديم معلومات صحيحة (اسم المتجر، الهاتف، المدينة، ICE أو CIN). أي تصريح كاذب يؤدي إلى تعليق الحساب فوراً. المادة 3 — العمولة تقتطع سمارت سويقة عمولة قدرها ${pct( t.commissionRate )}% على مبلغ كل عملية بيع دون احتساب التوصيل. يمكن تعديل هذه العمولة بين ${pct( t.commissionRateMin )}% و${pct(t.commissionRateMax)}% بموافقة كتابية من البائع. المادة 4 — الشحن يختار البائع الإيداع في الوكالة (drop-off) أو لوجستيك سمارت سويقة (fulfillment). مهل الإيداع هي ${ t.dropoffDeadlineHoursNew } ساعة (الحسابات الجديدة) أو ${ t.dropoffDeadlineHoursEstablished } ساعة (الحسابات الناضجة). أي تأخير قد يؤدي إلى تعليق الحساب. المادة 5 — الدفع تُضاف الأرباح إلى محفظة البائع وتصبح متاحة بعد ${ t.unlockDaysVendor } أيام من تأكيد التسليم (${ t.unlockDaysSmart } يوماً لمنتجات سمارت سويقة). الحد الأدنى للسحب هو ${mad( t.minWithdrawal )} درهم. المادة 6 — الإرجاع في حالة الإرجاع، تُخصم رسوم قدرها ${mad( t.returnFeeSpeedaf )} درهماً لكل طرد مُرجع. الإرجاعات المتكررة قد تؤدي إلى مراجعة وضع البائع. المادة 7 — الإنهاء يمكن لأي طرف إنهاء هذا العقد في أي وقت. تبقى الطلبات الجارية خاضعة لهذه الشروط. المادة 8 — القانون المطبق يخضع هذا العقد للقانون المغربي. يختص القضاء في الدار البيضاء بأي نزاع. المادة 9 — التوقيع الإلكتروني التوقيع الإلكتروني يعتبر قبولاً تاماً وصريحاً. يتم تسجيل عنوان IP، ووكيل المستخدم، وتاريخ الخادم، وبصمة SHA-256 لهذا المستند كدليل. بالتوقيع، يقر البائع بأنه قرأ وفهم كامل هذا العقد.`,

    en: (t) => `VENDOR PARTNERSHIP AGREEMENT — SMART SWI9A Version ${t.version} Article 1 — Purpose This agreement governs the listing and sale of products by the Vendor on Smart Swi9a (smartswi9a.top), a Moroccan marketplace for connected devices and home products. Article 2 — Registration and verification The Vendor agrees to provide accurate information (shop name, phone, city, ICE or CIN). Any false statement results in immediate account suspension. Article 3 — Commission Smart Swi9a charges a ${pct( t.commissionRate )}% commission on the delivery-excluded amount of each sale. This commission may be adjusted between ${pct( t.commissionRateMin )}% and ${pct(t.commissionRateMax)}% with the Vendor's written consent. Article 4 — Shipping The Vendor chooses agency drop-off or Smart Swi9a fulfillment. Drop-off deadlines are ${ t.dropoffDeadlineHoursNew } hours (new accounts) or ${ t.dropoffDeadlineHoursEstablished } hours (mature accounts). Any delay may result in suspension. Article 5 — Payment Earnings are credited to the vendor wallet and become available ${ t.unlockDaysVendor } days after confirmed delivery (${ t.unlockDaysSmart } days for Smart Swi9a products). Minimum withdrawal is ${mad( t.minWithdrawal )} MAD. Article 6 — Returns In case of return, a ${mad( t.returnFeeSpeedaf )} MAD fee is charged per returned parcel. Repeated returns may lead to a review of the Vendor's status. Article 7 — Termination Either party may terminate this agreement at any time. Pending orders remain subject to these terms. Article 8 — Governing law This agreement is governed by Moroccan law. Any dispute falls under the jurisdiction of the courts of Casablanca. Article 9 — Electronic signature The electronic signature constitutes full acceptance. The IP, user-agent, server date, and a SHA-256 hash of this document are recorded as evidence. By signing, the Vendor acknowledges having read and understood this entire agreement.`,
  },

  /* ============================================================ VERSION 1.2.0 (Lot 26 — vocabulaire Livo) ============================================================ Nouveau gabarit aligné sur CONFIG.VENDOR.CONTRACT_VERSION = '1.2.0' (config.js v9.0.0). Changement par rapport à 1.1.0 : - Article 6 (Retours) : mention "Livo" au lieu du nom historique du transporteur. Utilise t.returnFeeLivo. - Aucun autre changement sémantique. Un vendeur signataire 1.1.0 est invité à re-signer 1.2.0 dans les CONTRACT_RESIGN_GRACE_DAYS jours (30), grâce au système needsResign() de vendor-contract.js. ============================================================ */
  "1.2.0": {
    fr: (t) => `CONTRAT DE PARTENARIAT VENDEUR — SMART SWI9A Version ${t.version} Article 1 — Objet Le présent contrat encadre la mise en vente de produits par le Vendeur sur la plateforme Smart Swi9a (smartswi9a.top), marketplace marocaine d'appareils connectés et de produits pour la maison. Article 2 — Inscription et vérification Le Vendeur s'engage à fournir des informations exactes (nom de boutique, téléphone, ville, ICE ou CIN). Toute fausse déclaration entraîne la suspension immédiate du compte. Article 3 — Commission Smart Swi9a prélève une commission de ${pct( t.commissionRate )} % sur le montant hors livraison de chaque vente. Cette commission peut être ajustée entre ${pct( t.commissionRateMin )} % et ${pct(t.commissionRateMax)} % avec l'accord écrit du Vendeur. Article 4 — Expédition Le Vendeur choisit le dépôt en agence (drop-off) ou la logistique Smart Swi9a (fulfillment). Les délais de dépôt sont de ${ t.dropoffDeadlineHoursNew } heures (nouveaux comptes) ou ${ t.dropoffDeadlineHoursEstablished } heures (comptes matures). Tout retard peut entraîner une suspension. Article 5 — Paiement Les gains sont crédités sur le portefeuille vendeur et deviennent disponibles ${ t.unlockDaysVendor } jours après livraison confirmée (${ t.unlockDaysSmart } jours pour les produits Smart Swi9a). Le retrait minimum est de ${mad( t.minWithdrawal )} MAD. Article 6 — Retours En cas de retour, des frais de ${mad( t.returnFeeLivo )} MAD sont prélevés par colis retourné (frais facturés par notre partenaire logistique Livo). Les retours répétés peuvent entraîner une révision du statut du Vendeur. Article 7 — Résiliation Chaque partie peut résilier ce contrat à tout moment. Les commandes en cours restent soumises aux présentes conditions. Article 8 — Loi applicable Le présent contrat est régi par le droit marocain. Tout litige relève des tribunaux de Casablanca. Article 9 — Signature électronique La signature électronique vaut acceptation pleine et entière. L'IP, le user-agent, la date serveur et un hash SHA-256 du présent document sont enregistrés à titre de preuve. En signant, le Vendeur reconnaît avoir lu et compris l'intégralité du présent contrat.`,

    ar: (t) => `عقد شراكة البائع — سمارت سويقة الإصدار ${t.version} المادة 1 — الموضوع ينظم هذا العقد عرض البائع لمنتجاته للبيع على منصة سمارت سويقة (smartswi9a.top)، وهي سوق مغربية للأجهزة المتصلة ومنتجات المنزل. المادة 2 — التسجيل والتحقق يلتزم البائع بتقديم معلومات صحيحة (اسم المتجر، الهاتف، المدينة، ICE أو CIN). أي تصريح كاذب يؤدي إلى تعليق الحساب فوراً. المادة 3 — العمولة تقتطع سمارت سويقة عمولة قدرها ${pct( t.commissionRate )}% على مبلغ كل عملية بيع دون احتساب التوصيل. يمكن تعديل هذه العمولة بين ${pct( t.commissionRateMin )}% و${pct(t.commissionRateMax)}% بموافقة كتابية من البائع. المادة 4 — الشحن يختار البائع الإيداع في الوكالة (drop-off) أو لوجستيك سمارت سويقة (fulfillment). مهل الإيداع هي ${ t.dropoffDeadlineHoursNew } ساعة (الحسابات الجديدة) أو ${ t.dropoffDeadlineHoursEstablished } ساعة (الحسابات الناضجة). أي تأخير قد يؤدي إلى تعليق الحساب. المادة 5 — الدفع تُضاف الأرباح إلى محفظة البائع وتصبح متاحة بعد ${ t.unlockDaysVendor } أيام من تأكيد التسليم (${ t.unlockDaysSmart } يوماً لمنتجات سمارت سويقة). الحد الأدنى للسحب هو ${mad( t.minWithdrawal )} درهم. المادة 6 — الإرجاع في حالة الإرجاع، تُخصم رسوم قدرها ${mad( t.returnFeeLivo )} درهماً لكل طرد مُرجع (رسوم يفرضها شريكنا اللوجستي Livo). الإرجاعات المتكررة قد تؤدي إلى مراجعة وضع البائع. المادة 7 — الإنهاء يمكن لأي طرف إنهاء هذا العقد في أي وقت. تبقى الطلبات الجارية خاضعة لهذه الشروط. المادة 8 — القانون المطبق يخضع هذا العقد للقانون المغربي. يختص القضاء في الدار البيضاء بأي نزاع. المادة 9 — التوقيع الإلكتروني التوقيع الإلكتروني يعتبر قبولاً تاماً وصريحاً. يتم تسجيل عنوان IP، ووكيل المستخدم، وتاريخ الخادم، وبصمة SHA-256 لهذا المستند كدليل. بالتوقيع، يقر البائع بأنه قرأ وفهم كامل هذا العقد.`,

    en: (t) => `VENDOR PARTNERSHIP AGREEMENT — SMART SWI9A Version ${t.version} Article 1 — Purpose This agreement governs the listing and sale of products by the Vendor on Smart Swi9a (smartswi9a.top), a Moroccan marketplace for connected devices and home products. Article 2 — Registration and verification The Vendor agrees to provide accurate information (shop name, phone, city, ICE or CIN). Any false statement results in immediate account suspension. Article 3 — Commission Smart Swi9a charges a ${pct( t.commissionRate )}% commission on the delivery-excluded amount of each sale. This commission may be adjusted between ${pct( t.commissionRateMin )}% and ${pct(t.commissionRateMax)}% with the Vendor's written consent. Article 4 — Shipping The Vendor chooses agency drop-off or Smart Swi9a fulfillment. Drop-off deadlines are ${ t.dropoffDeadlineHoursNew } hours (new accounts) or ${ t.dropoffDeadlineHoursEstablished } hours (mature accounts). Any delay may result in suspension. Article 5 — Payment Earnings are credited to the vendor wallet and become available ${ t.unlockDaysVendor } days after confirmed delivery (${ t.unlockDaysSmart } days for Smart Swi9a products). Minimum withdrawal is ${mad( t.minWithdrawal )} MAD. Article 6 — Returns In case of return, a ${mad( t.returnFeeLivo )} MAD fee is charged per returned parcel (fee charged by our logistics partner Livo). Repeated returns may lead to a review of the Vendor's status. Article 7 — Termination Either party may terminate this agreement at any time. Pending orders remain subject to these terms. Article 8 — Governing law This agreement is governed by Moroccan law. Any dispute falls under the jurisdiction of the courts of Casablanca. Article 9 — Electronic signature The electronic signature constitutes full acceptance. The IP, user-agent, server date, and a SHA-256 hash of this document are recorded as evidence. By signing, the Vendor acknowledges having read and understood this entire agreement.`,
  },
  // Version 1.3.0 : gabarit 1.2.0 inchangé sur le fond, domaine .ma.
  // Les versions publiées précédentes restent immuables pour les hashes.
  "1.3.0": {
    fr: (t) => CONTRACT_TEMPLATES["1.2.0"].fr(t).replaceAll("smartswi9a.top", "smartswika.ma"),
    ar: (t) => CONTRACT_TEMPLATES["1.2.0"].ar(t).replaceAll("smartswi9a.top", "smartswika.ma"),
    en: (t) => CONTRACT_TEMPLATES["1.2.0"].en(t).replaceAll("smartswi9a.top", "smartswika.ma"),
  },
  // Version 1.4.0 : frais de retour réels, distincts par vendeur.
  // Les gabarits 1.1.0, 1.2.0 et 1.3.0 restent immuables.
  "1.4.0": {
    fr: (t) => CONTRACT_TEMPLATES["1.2.0"].fr(t)
      .replace(/Article 6 — Retours En cas de retour,[\s\S]*?Les retours répétés peuvent entraîner une révision du statut du Vendeur\./,
        "Article 6 — Retours Les frais de retour sont facturés séparément à chaque Vendeur selon le montant réel communiqué par le transporteur ou, à défaut, validé par l'administration. Aucun frais n'est débité avant l'enregistrement et la validation de ce montant. Les retours répétés peuvent entraîner une révision du statut du Vendeur.")
      .replaceAll("smartswi9a.top", "smartswika.ma"),
    ar: (t) => CONTRACT_TEMPLATES["1.2.0"].ar(t)
      .replace(/المادة 6 — الإرجاع في حالة الإرجاع،[\s\S]*?الإرجاعات المتكررة قد تؤدي إلى مراجعة وضع البائع\./,
        "المادة 6 — الإرجاع تُفرض رسوم الإرجاع بشكل منفصل على كل بائع وفق المبلغ الفعلي الذي يحدده الناقل، أو الذي تعتمده الإدارة عند عدم توفره. لا يتم خصم أي رسوم قبل تسجيل المبلغ واعتماده. وقد تؤدي الإرجاعات المتكررة إلى مراجعة وضع البائع.")
      .replaceAll("smartswi9a.top", "smartswika.ma"),
    en: (t) => CONTRACT_TEMPLATES["1.2.0"].en(t)
      .replace(/Article 6 — Returns In case of return,[\s\S]*?Repeated returns may lead to a review of the Vendor's status\./,
        "Article 6 — Returns Return fees are charged separately to each Vendor based on the actual amount provided by the carrier or, if unavailable, validated by the administration. No fee is debited until that amount has been recorded and approved. Repeated returns may lead to a review of the Vendor's status.")
      .replaceAll("smartswi9a.top", "smartswika.ma"),
  },
};

/* ============================================================ API PUBLIQUE ============================================================ */

/** * Retourne le texte du contrat pour (langue, version, snapshot). * PURE et DÉTERMINISTE : mêmes arguments = même texte octet pour octet. * * @param {string} [lang='fr'] - 'fr' | 'ar' | 'en' * @param {string} [version] - semver (défaut: CONFIG.VENDOR.CONTRACT_VERSION) * @param {Object|null} [termsSnapshot] - snapshot figé (défaut: buildTermsSnapshot()) * @returns {string} Texte prêt à afficher et à hasher. * @throws {Error} si la version n'a pas de gabarit, ou si le * snapshot est incohérent avec la version. */
export function getContractText( lang = "fr", version = CONFIG.VENDOR.CONTRACT_VERSION, termsSnapshot = null ) {
  const templates = CONTRACT_TEMPLATES[version];
  if (!templates) {
    throw new Error(
      "getContractText : version de contrat non supportée (" + version + ")."
    );
  }
  const builder = templates[lang] || templates.fr;
  if (typeof builder !== "function") {
    throw new Error(
      "getContractText : gabarit indisponible pour la langue " + lang + "."
    );
  }
  const snapshot =
    termsSnapshot && typeof termsSnapshot === "object"
      ? termsSnapshot
      : buildTermsSnapshot();
  if (String(snapshot.version) !== String(version)) {
    throw new Error(
      "getContractText : incohérence version (gabarit " +
        version +
        " vs snapshot " +
        snapshot.version +
        ")."
    );
  }
  return builder(snapshot);
}

/** * Retourne les versions de contrat disponibles, triées en semver * croissant. Ex. actuellement : ['1.1.0', '1.2.0', '1.3.0', '1.4.0']. * @returns {string[]} */
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

/* ============================================================ LOG ============================================================ */
console.log(
  "[vendor-contract-text] v10.0.0 chargé (gabarit 1.4.0 : frais réels par vendeur)"
);