// js/vendor-signup.js
// ============================================================
// LOGIQUE D'INSCRIPTION VENDEUR
// Version 1.1.0 — Correctifs E3, E5, E6, E11, E12, E14 :
//   - pré-signature en mémoire (plus de 'temp_...', pas de setDoc avant compte)
//   - texte de contrat FIGÉ par langue (plus de innerText)
//   - scroll : tolérance + auto-enable si le texte tient dans la fenêtre
//   - case à cocher « J'ai lu et j'accepte » (créée si absente)
//   - null-guards partout, anti-double-clic, honeypot, validations
//   - redirection vers /vendor/dashboard.html (minuscules) + paramètres d'état
//   - i18n via tr(key) avec fallback fr/ar/en
//   - signupMethod = SIGNUP_METHODS.VENDOR
// ============================================================

import { registerVendorWithFirebase } from "./auth.js";
import { signVendorContract, computeContractTextHash } from "./vendor-contract.js";
import {
    CONFIG,
    SIGNUP_METHODS,
    VENDOR_SHIPPING_METHOD,
    LANGUAGES,
    DEFAULT_LANGUAGE
} from "./config.js";
import { showToast } from "./ui-core.js";

// ============================================================
// ÉTAT MODULE
// ============================================================
let contractAccepted = false;
let preSignature = { textHash: null, language: DEFAULT_LANGUAGE };
let submitInProgress = false;

// Références DOM (renseignées au DOMContentLoaded)
const els = {};

// État du scroll de la modale
let scrollReached = false;

// ============================================================
// TEXTES DE CONTRAT — FIGÉS ET VERSIONNÉS
// ⚠️ À faire relire par un juriste avant mise en production.
// La version utilisée doit correspondre à CONFIG.VENDOR.CONTRACT_VERSION.
// ============================================================
const CONTRACT_TEXTS = {
    fr: `CONTRAT DE PARTENARIAT VENDEUR — SMART SWI9A
Version ${CONFIG.VENDOR.CONTRACT_VERSION}

Article 1 — Objet
Le présent contrat encadre la mise en vente de produits par le Vendeur sur la plateforme Smart Swi9a (smartswi9a.top), marketplace marocaine d'appareils connectés et de produits pour la maison.

Article 2 — Inscription et vérification
Le Vendeur s'engage à fournir des informations exactes (nom de boutique, téléphone, ville, ICE ou CIN). Toute fausse déclaration entraîne la suspension immédiate du compte.

Article 3 — Commission
Smart Swi9a prélève une commission de 7 % sur le montant hors livraison de chaque vente. Cette commission peut être ajustée entre 5 % et 15 % avec l'accord écrit du Vendeur.

Article 4 — Expédition
Le Vendeur choisit le dépôt en agence (drop-off) ou la logistique Smart Swi9a (fulfillment). Les délais de dépôt sont de 72 heures (nouveaux comptes) ou 48 heures (comptes matures). Tout retard peut entraîner une suspension.

Article 5 — Paiement
Les gains sont crédités sur le portefeuille vendeur et deviennent disponibles 7 jours après livraison confirmée (15 jours pour les produits Smart Swi9a). Le retrait minimum est de 200 MAD.

Article 6 — Retours
En cas de retour, des frais de 20 MAD sont prélevés par colis retourné. Les retours répétés peuvent entraîner une révision du statut du Vendeur.

Article 7 — Résiliation
Chaque partie peut résilier ce contrat à tout moment. Les commandes en cours restent soumises aux présentes conditions.

Article 8 — Loi applicable
Le présent contrat est régi par le droit marocain. Tout litige relève des tribunaux de Casablanca.

Article 9 — Signature électronique
La signature électronique vaut acceptation pleine et entière. L'IP, le user-agent, la date serveur et un hash SHA-256 du présent document sont enregistrés à titre de preuve.

En signant, le Vendeur reconnaît avoir lu et compris l'intégralité du présent contrat.`,

    ar: `عقد شراكة البائع — سمارت سويقة
الإصدار ${CONFIG.VENDOR.CONTRACT_VERSION}

المادة 1 — الموضوع
ينظم هذا العقد عرض البائع لمنتجاته للبيع على منصة سمارت سويقة (smartswi9a.top)، وهي سوق مغربية للأجهزة المتصلة ومنتجات المنزل.

المادة 2 — التسجيل والتحقق
يلتزم البائع بتقديم معلومات صحيحة (اسم المتجر، الهاتف، المدينة، ICE أو CIN). أي تصريح كاذب يؤدي إلى تعليق الحساب فوراً.

المادة 3 — العمولة
تقتطع سمارت سويقة عمولة قدرها 7% على مبلغ كل عملية بيع دون احتساب التوصيل. يمكن تعديل هذه العمولة بين 5% و15% بموافقة كتابية من البائع.

المادة 4 — الشحن
يختار البائع الإيداع في الوكالة (drop-off) أو لوجستيك سمارت سويقة (fulfillment). مهل الإيداع هي 72 ساعة (الحسابات الجديدة) أو 48 ساعة (الحسابات الناضجة). أي تأخير قد يؤدي إلى تعليق الحساب.

المادة 5 — الدفع
تُضاف الأرباح إلى محفظة البائع وتصبح متاحة بعد 7 أيام من تأكيد التسليم (15 يوماً لمنتجات سمارت سويقة). الحد الأدنى للسحب هو 200 درهم.

المادة 6 — الإرجاع
في حالة الإرجاع، تُخصم رسوم قدرها 20 درهماً لكل طرد مُرجع. الإرجاعات المتكررة قد تؤدي إلى مراجعة وضع البائع.

المادة 7 — الإنهاء
يمكن لأي طرف إنهاء هذا العقد في أي وقت. تبقى الطلبات الجارية خاضعة لهذه الشروط.

المادة 8 — القانون المطبق
يخضع هذا العقد للقانون المغربي. يختص القضاء في الدار البيضاء بأي نزاع.

المادة 9 — التوقيع الإلكتروني
التوقيع الإلكتروني يعتبر قبولاً تاماً وصريحاً. يتم تسجيل عنوان IP، ووكيل المستخدم، وتاريخ الخادم، وبصمة SHA-256 لهذا المستند كدليل.

بالتوقيع، يقر البائع بأنه قرأ وفهم كامل هذا العقد.`,

    en: `VENDOR PARTNERSHIP AGREEMENT — SMART SWI9A
Version ${CONFIG.VENDOR.CONTRACT_VERSION}

Article 1 — Purpose
This agreement governs the listing and sale of products by the Vendor on Smart Swi9a (smartswi9a.top), a Moroccan marketplace for connected devices and home products.

Article 2 — Registration and verification
The Vendor agrees to provide accurate information (shop name, phone, city, ICE or CIN). Any false statement results in immediate account suspension.

Article 3 — Commission
Smart Swi9a charges a 7% commission on the delivery-excluded amount of each sale. This commission may be adjusted between 5% and 15% with the Vendor's written consent.

Article 4 — Shipping
The Vendor chooses agency drop-off or Smart Swi9a fulfillment. Drop-off deadlines are 72 hours (new accounts) or 48 hours (mature accounts). Any delay may result in suspension.

Article 5 — Payment
Earnings are credited to the vendor wallet and become available 7 days after confirmed delivery (15 days for Smart Swi9a products). Minimum withdrawal is 200 MAD.

Article 6 — Returns
In case of return, a 20 MAD fee is charged per returned parcel. Repeated returns may lead to a review of the Vendor's status.

Article 7 — Termination
Either party may terminate this agreement at any time. Pending orders remain subject to these terms.

Article 8 — Governing law
This agreement is governed by Moroccan law. Any dispute falls under the jurisdiction of the courts of Casablanca.

Article 9 — Electronic signature
The electronic signature constitutes full acceptance. The IP, user-agent, server date, and a SHA-256 hash of this document are recorded as evidence.

By signing, the Vendor acknowledges having read and understood this entire agreement.`
};

// ============================================================
// FALLBACK I18N (clés de ce fichier)
// À supprimer une fois translations.js mis à jour à l'étape 8.
// ============================================================
const FALLBACK_I18N = {
    fr: {
        'vendor.contract.open': 'Lire le contrat',
        'vendor.contract.close': 'Fermer',
        'vendor.contract.accept': "✍️ J'accepte les conditions et je signe électroniquement",
        'vendor.contract.acceptSigning': '⏳ Enregistrement de votre acceptation…',
        'vendor.contract.canSign': '✅ Vous pouvez maintenant signer.',
        'vendor.contract.scrollHint': 'Faites défiler pour lire le contrat en entier.',
        'vendor.contract.checkbox': "J'ai lu et j'accepte le contrat dans son intégralité",
        'vendor.contract.accepted': '✅ Contrat accepté le {date}. Il sera signé après création de votre compte.',
        'vendor.contract.required': '⚠️ Vous devez lire et accepter le contrat avant de continuer.',
        'vendor.signup.creating': '⏳ Création du compte en cours...',
        'vendor.signup.submit': '✅ Créer mon compte vendeur',
        'vendor.signup.success': '🎉 Inscription réussie ! Vérifiez votre email.',
        'vendor.signup.successContractFailed': '⚠️ Compte créé, mais la signature du contrat a échoué. Connectez-vous pour finaliser.',
        'vendor.signup.error': "Erreur lors de l'inscription",
        'vendor.signup.invalidFields': '⚠️ Champs invalides :',
        'vendor.signup.contractSignError': '❌ Erreur lors de la signature du contrat.',
        'vendor.field.shopName': 'nom de boutique',
        'vendor.field.email': 'email',
        'vendor.field.phone': 'téléphone',
        'vendor.field.city': 'ville',
        'vendor.field.iceCin': 'ICE ou CIN',
        'vendor.field.password': 'mot de passe',
        'vendor.field.shipping': 'mode de livraison'
    },
    ar: {
        'vendor.contract.open': 'قراءة العقد',
        'vendor.contract.close': 'إغلاق',
        'vendor.contract.accept': '✍️ أوافق على الشروط وأوقّع إلكترونياً',
        'vendor.contract.acceptSigning': '⏳ جارٍ تسجيل موافقتك…',
        'vendor.contract.canSign': '✅ يمكنك الآن التوقيع.',
        'vendor.contract.scrollHint': 'مرّر لقراءة العقد بالكامل.',
        'vendor.contract.checkbox': 'لقد قرأت وأوافق على العقد بالكامل',
        'vendor.contract.accepted': '✅ تم قبول العقد بتاريخ {date}. سيتم التوقيع بعد إنشاء حسابك.',
        'vendor.contract.required': '⚠️ يجب قراءة العقد وقبوله للمتابعة.',
        'vendor.signup.creating': '⏳ جارٍ إنشاء الحساب...',
        'vendor.signup.submit': '✅ إنشاء حساب البائع',
        'vendor.signup.success': '🎉 تم التسجيل بنجاح! تحقق من بريدك الإلكتروني.',
        'vendor.signup.successContractFailed': '⚠️ تم إنشاء الحساب، لكن توقيع العقد فشل. سجّل الدخول لإكماله.',
        'vendor.signup.error': 'خطأ أثناء التسجيل',
        'vendor.signup.invalidFields': '⚠️ حقول غير صالحة:',
        'vendor.signup.contractSignError': '❌ خطأ أثناء توقيع العقد.',
        'vendor.field.shopName': 'اسم المتجر',
        'vendor.field.email': 'البريد الإلكتروني',
        'vendor.field.phone': 'الهاتف',
        'vendor.field.city': 'المدينة',
        'vendor.field.iceCin': 'ICE أو CIN',
        'vendor.field.password': 'كلمة المرور',
        'vendor.field.shipping': 'طريقة الشحن'
    },
    en: {
        'vendor.contract.open': 'Read contract',
        'vendor.contract.close': 'Close',
        'vendor.contract.accept': '✍️ I accept the terms and sign electronically',
        'vendor.contract.acceptSigning': '⏳ Recording your acceptance…',
        'vendor.contract.canSign': '✅ You can now sign.',
        'vendor.contract.scrollHint': 'Scroll to read the full contract.',
        'vendor.contract.checkbox': 'I have read and accept the full contract',
        'vendor.contract.accepted': '✅ Contract accepted on {date}. It will be signed after account creation.',
        'vendor.contract.required': '⚠️ You must read and accept the contract before continuing.',
        'vendor.signup.creating': '⏳ Creating account...',
        'vendor.signup.submit': '✅ Create my vendor account',
        'vendor.signup.success': '🎉 Registration successful! Check your email.',
        'vendor.signup.successContractFailed': '⚠️ Account created, but contract signing failed. Log in to complete.',
        'vendor.signup.error': 'Registration error',
        'vendor.signup.invalidFields': '⚠️ Invalid fields:',
        'vendor.signup.contractSignError': '❌ Error signing the contract.',
        'vendor.field.shopName': 'shop name',
        'vendor.field.email': 'email',
        'vendor.field.phone': 'phone',
        'vendor.field.city': 'city',
        'vendor.field.iceCin': 'ICE or CIN',
        'vendor.field.password': 'password',
        'vendor.field.shipping': 'shipping method'
    }
};

// ============================================================
// I18N
// ============================================================
function getCurrentLanguage() {
    const htmlLang = (document.documentElement.lang || '').toLowerCase();
    if (LANGUAGES.includes(htmlLang)) return htmlLang;
    try {
        const stored = localStorage.getItem(CONFIG.STORAGE_KEYS.LANG);
        if (stored && LANGUAGES.includes(stored)) return stored;
    } catch (_) { /* ignore */ }
    return DEFAULT_LANGUAGE;
}

function tr(key, params = {}) {
    const lang = getCurrentLanguage();
    let value =
        (window.translations && window.translations[lang] && window.translations[lang][key]) ||
        (FALLBACK_I18N[lang] && FALLBACK_I18N[lang][key]) ||
        (FALLBACK_I18N[DEFAULT_LANGUAGE] && FALLBACK_I18N[DEFAULT_LANGUAGE][key]) ||
        key;
    for (const p in params) value = value.replace('{' + p + '}', params[p]);
    return value;
}

// ============================================================
// VALIDATEURS
// ============================================================
function isValidEmail(v) {
    return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;
}

function normalizePhone(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.replace(/[\s\-\(\)\.]/g, '');
    if (/^0[67]\d{8}$/.test(s)) return '+212' + s.substring(1);
    if (/^\+212[67]\d{8}$/.test(s)) return s;
    if (/^00212[67]\d{8}$/.test(s)) return '+' + s.substring(2);
    return s;
}

function isValidMoroccanPhone(raw) {
    const s = normalizePhone(raw);
    return /^\+212[67]\d{8}$/.test(s);
}

// ICE = 15 chiffres — CIN Maroc = 1-2 lettres + 5-6 chiffres (ou 6-8 chiffres)
function isValidIceCin(v) {
    if (typeof v !== 'string') return false;
    const t = v.trim().toUpperCase();
    if (/^\d{15}$/.test(t)) return true; // ICE
    if (/^[A-Z]{1,2}\d{5,6}$/.test(t)) return true; // CIN courant
    if (/^\d{6,8}$/.test(t)) return true; // CIN numérique
    return false;
}

function isValidPassword(p) {
    if (typeof p !== 'string' || p.length < 8 || p.length > 128) return false;
    return /[A-Za-z]/.test(p) && /\d/.test(p);
}

function isValidShopName(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (t.length < 2 || t.length > 60) return false;
    // Lettres (Unicode), chiffres, espaces, tiret, apostrophe, &, .
    return /^[\p{L}\p{N}\s\-'&\.]{2,60}$/u.test(t);
}

function isValidCity(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (t.length < 2 || t.length > 80) return false;
    return /^[\p{L}\p{N}\s\-'\.]{2,80}$/u.test(t);
}

// ============================================================
// HELPERS UI
// ============================================================
function setButtonLoading(btn, loading, loadingText, normalText) {
    if (!btn) return;
    btn.disabled = !!loading;
    btn.style.opacity = loading ? '0.7' : '1';
    if (loading && loadingText) btn.textContent = loadingText;
    else if (!loading && normalText) btn.textContent = normalText;
}

function updateAcceptButtonState() {
    if (!els.btnAcceptContract) return;
    const checkboxOK = !els.contractCheckbox || els.contractCheckbox.checked;
    const ready = scrollReached && checkboxOK;
    els.btnAcceptContract.disabled = !ready;
    els.btnAcceptContract.style.opacity = ready ? '1' : '0.5';
    if (els.scrollHint) {
        if (!scrollReached) {
            els.scrollHint.textContent = tr('vendor.contract.scrollHint');
            els.scrollHint.style.color = 'var(--text-muted)';
        } else if (!checkboxOK) {
            els.scrollHint.textContent = tr('vendor.contract.scrollHint');
            els.scrollHint.style.color = 'var(--text-muted)';
        } else {
            els.scrollHint.textContent = tr('vendor.contract.canSign');
            els.scrollHint.style.color = 'var(--success)';
        }
    }
}

function checkScrollReached() {
    if (!els.contractText) return;
    const sh = els.contractText.scrollHeight;
    const ch = els.contractText.clientHeight;
    const st = els.contractText.scrollTop;
    const tolerance = 8;
    const noScrollNeeded = sh <= ch + tolerance;
    const scrolledToEnd = (st + ch) >= (sh - tolerance);
    if (noScrollNeeded || scrolledToEnd) scrollReached = true;
    updateAcceptButtonState();
}

function resetContractUI() {
    contractAccepted = false;
    scrollReached = false;
    if (els.btnAcceptContract) {
        els.btnAcceptContract.disabled = true;
        els.btnAcceptContract.style.opacity = '0.5';
        els.btnAcceptContract.textContent = tr('vendor.contract.accept');
    }
    if (els.contractCheckbox) els.contractCheckbox.checked = false;
    if (els.scrollHint) {
        els.scrollHint.textContent = tr('vendor.contract.scrollHint');
        els.scrollHint.style.color = 'var(--text-muted)';
    }
    if (els.contractText) els.contractText.scrollTop = 0;
    if (els.contractStatus) {
        els.contractStatus.textContent = '';
        els.contractStatus.style.color = '';
    }
}

async function computePreSignature() {
    const lang = getCurrentLanguage();
    const text = CONTRACT_TEXTS[lang] || CONTRACT_TEXTS[DEFAULT_LANGUAGE];
    try {
        const hash = await computeContractTextHash(text);
        preSignature = { textHash: hash, language: lang };
        return { text, lang };
    } catch (e) {
        console.error('❌ Impossible de calculer le hash du contrat :', e);
        preSignature = { textHash: null, language: lang };
        return { text, lang };
    }
}

// ============================================================
// MODALE CONTRAT
// ============================================================
async function openContractModal() {
    if (!els.modal) return;

    // 1. Injecter le texte de la version exacte affichée
    const { text, lang } = await computePreSignature();
    if (els.contractText) {
        els.contractText.textContent = text;
        els.contractText.setAttribute('lang', lang);
        els.contractText.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        els.contractText.scrollTop = 0;
    }

    // 2. Reset UI
    resetContractUI();

    // 3. Ouvrir
    els.modal.classList.add('open');
    els.modal.setAttribute('aria-modal', 'true');
    els.modal.setAttribute('role', 'dialog');
    document.body.style.overflow = 'hidden';

    // 4. Focus initial
    if (els.btnAcceptContract) els.btnAcceptContract.focus();

    // 5. Laisser le layout se stabiliser puis vérifier le scroll
    requestAnimationFrame(() => requestAnimationFrame(checkScrollReached));
}

function closeContractModal() {
    if (!els.modal) return;
    els.modal.classList.remove('open');
    document.body.style.overflow = '';
}

function trapFocus(e) {
    if (!els.modal || !els.modal.classList.contains('open')) return;
    if (e.key !== 'Tab') return;
    const focusables = els.modal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

// ============================================================
// INITIALISATION
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    // Références DOM
    els.form = document.getElementById('vendorSignupForm');
    els.modal = document.getElementById('contractModal');
    els.contractText = document.getElementById('contractText');
    els.btnAcceptContract = document.getElementById('btnAcceptContract');
    els.btnOpenContract = document.getElementById('btnOpenContract');
    els.btnCloseContract = document.getElementById('btnCloseContract');
    els.scrollHint = document.getElementById('scrollHint');
    els.btnSubmitVendor = document.getElementById('btnSubmitVendor');
    els.contractStatus = document.getElementById('contractStatus');

    // Si la page ne contient pas le formulaire vendeur, on ne fait rien
    if (!els.form || !els.modal) {
        console.warn('vendor-signup.js : formulaire ou modale absent, arrêt silencieux.');
        return;
    }

    // ---- Case à cocher « J'ai lu et j'accepte » (créée si absente) ----
    els.contractCheckbox = document.getElementById('contractCheckbox');
    if (!els.contractCheckbox) {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;font-size:14px;cursor:pointer;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = 'contractCheckbox';
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + tr('vendor.contract.checkbox')));
        if (els.scrollHint && els.scrollHint.parentNode) {
            els.scrollHint.parentNode.insertBefore(label, els.scrollHint.nextSibling);
        } else if (els.contractText && els.contractText.parentNode) {
            els.contractText.parentNode.appendChild(label);
        }
        els.contractCheckbox = cb;
    }
    els.contractCheckbox.addEventListener('change', updateAcceptButtonState);

    // ---- Aria live sur scrollHint ----
    if (els.scrollHint) {
        els.scrollHint.setAttribute('aria-live', 'polite');
    }

    // ---- Cartes de livraison (v-choice) ----
    document.querySelectorAll('.v-choice').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.v-choice').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            const radio = card.querySelector('input[type="radio"]');
            if (radio) radio.checked = true;
        });
    });

    // ---- Ouverture / fermeture de la modale ----
    if (els.btnOpenContract) {
        els.btnOpenContract.addEventListener('click', (e) => {
            e.preventDefault();
            openContractModal();
        });
    }
    if (els.btnCloseContract) {
        els.btnCloseContract.addEventListener('click', (e) => {
            e.preventDefault();
            closeContractModal();
        });
    }
    els.modal.addEventListener('click', (e) => {
        if (e.target === els.modal) closeContractModal();
    });
    document.addEventListener('keydown', (e) => {
        if (!els.modal.classList.contains('open')) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeContractModal();
        } else {
            trapFocus(e);
        }
    });

    // ---- Scroll du contrat ----
    if (els.contractText) {
        els.contractText.addEventListener('scroll', checkScrollReached, { passive: true });
    }
    window.addEventListener('resize', () => {
        if (els.modal && els.modal.classList.contains('open')) checkScrollReached();
    });

    // ---- Clic sur « J'accepte et je signe » (pré-signature en mémoire seulement) ----
    if (els.btnAcceptContract) {
        els.btnAcceptContract.addEventListener('click', async () => {
            if (!preSignature.textHash) {
                // Recalcul de secours (rare)
                await computePreSignature();
            }
            if (!preSignature.textHash) {
                showToast(tr('vendor.signup.contractSignError'));
                return;
            }
            // Pré-signature : on ne fait AUCUN appel Firestore ici.
            contractAccepted = true;
            closeContractModal();

            if (els.contractStatus) {
                els.contractStatus.textContent = tr('vendor.contract.accepted', {
                    date: new Date().toLocaleDateString(getCurrentLanguage())
                });
                els.contractStatus.style.color = 'var(--success)';
            }
            if (els.btnSubmitVendor) {
                els.btnSubmitVendor.disabled = false;
                els.btnSubmitVendor.style.opacity = '1';
            }
            showToast('✅ ' + tr('vendor.contract.canSign').replace('✅ ', ''));
        });
    }

    // ---- Soumission finale ----
    els.form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (submitInProgress) return;

        // Honeypot anti-bot (champ caché #vWebsite)
        const honeypot = document.getElementById('vWebsite');
        if (honeypot && honeypot.value.trim()) {
            console.warn('Honeypot déclenché — soumission ignorée.');
            return;
        }

        if (!contractAccepted || !preSignature.textHash) {
            showToast(tr('vendor.contract.required'));
            return;
        }

        // Collecte
        const shopNameEl = document.getElementById('vShopName');
        const emailEl = document.getElementById('vEmail');
        const phoneEl = document.getElementById('vPhone');
        const cityEl = document.getElementById('vCity');
        const iceCinEl = document.getElementById('vIceCin');
        const passwordEl = document.getElementById('vPassword');
        const shippingRadio = document.querySelector('input[name="vShipping"]:checked');

        const shopName = (shopNameEl?.value || '').trim();
        const email = (emailEl?.value || '').trim().toLowerCase();
        const phoneRaw = (phoneEl?.value || '').trim();
        const city = (cityEl?.value || '').trim();
        const iceCin = (iceCinEl?.value || '').trim().toUpperCase();
        const password = passwordEl?.value || '';

        const fieldErrors = [];
        if (!isValidShopName(shopName)) fieldErrors.push('shopName');
        if (!isValidEmail(email)) fieldErrors.push('email');
        if (!isValidMoroccanPhone(phoneRaw)) fieldErrors.push('phone');
        if (!isValidCity(city)) fieldErrors.push('city');
        if (!isValidIceCin(iceCin)) fieldErrors.push('iceCin');
        if (!isValidPassword(password)) fieldErrors.push('password');
        if (!shippingRadio) fieldErrors.push('shipping');

        if (fieldErrors.length) {
            const labels = fieldErrors.map(k => tr('vendor.field.' + k)).join(', ');
            showToast(tr('vendor.signup.invalidFields') + ' ' + labels);
            return;
        }

        // Verrou
        submitInProgress = true;
        setButtonLoading(els.btnSubmitVendor, true, tr('vendor.signup.creating'), tr('vendor.signup.submit'));

        const vendorData = {
            shopName,
            email,
            phone: normalizePhone(phoneRaw),
            city,
            iceCin,
            shippingMethod: shippingRadio.value,
            signupMethod: SIGNUP_METHODS.VENDOR
        };

        let authResult;
        try {
            authResult = await registerVendorWithFirebase(vendorData, password);
        } catch (err) {
            console.error('❌ Inscription échouée :', err);
            showToast('❌ ' + (err?.message || tr('vendor.signup.error')));
            setButtonLoading(els.btnSubmitVendor, false, null, tr('vendor.signup.submit'));
            submitInProgress = false;
            return;
        }

        if (!authResult || !authResult.uid) {
            console.error('❌ registerVendorWithFirebase n\'a pas renvoyé d\'UID :', authResult);
            showToast('❌ ' + tr('vendor.signup.error'));
            setButtonLoading(els.btnSubmitVendor, false, null, tr('vendor.signup.submit'));
            submitInProgress = false;
            return;
        }

        // Signature du contrat APRÈS création du compte, une seule fois.
        const lang = preSignature.language;
        const contractText = CONTRACT_TEXTS[lang] || CONTRACT_TEXTS[DEFAULT_LANGUAGE];
        let contractSigned = false;
        try {
            await signVendorContract(authResult.uid, contractText, {
                textHash: preSignature.textHash,
                language: lang
            });
            contractSigned = true;
        } catch (err) {
            // Ne bloque PAS la redirection : l'utilisateur pourra compléter
            // depuis le dashboard (?contractFailed=1) — cf. étape 4.
            console.error('❌ Signature du contrat échouée après création du compte :', err);
        }

        // Paramètres d'état pour le dashboard
        const params = new URLSearchParams();
        params.set('welcome', '1');
        params.set('verifyEmail', '1');
        if (!contractSigned) params.set('contractFailed', '1');

        showToast(contractSigned
            ? tr('vendor.signup.success')
            : tr('vendor.signup.successContractFailed'));

        setTimeout(() => {
            window.location.href = '/vendor/dashboard.html?' + params.toString();
        }, 1800);
    });
});