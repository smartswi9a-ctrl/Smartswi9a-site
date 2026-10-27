/* ============================================================
   js/vendor-signup.js
   Logique d'inscription vendeur — Lot 28/30

   Version 9.0.0 — Fix getCurrentLanguage + logs + JSDoc

   CHANGEMENTS v9.0.0 :
     - B-VS-1 (P2) : getCurrentLanguage() utilise safeGetItem()
       (désérialisation JSON) au lieu de localStorage.getItem()
       brut. Le fallback localStorage devient fonctionnel.
     - B-VS-2 (P3) : import VENDOR_SHIPPING_METHOD retiré
       (valeurs hardcodées 'dropoff' / 'fulfillment').
     - B-VS-3 (P3) : URL redirection nettoyée (pas de '?' trailing
       si params vide - cas théorique).
     - B-VS-4 (P3) : emojis des logs et textes remplacés par
       préfixe [vendor-signup] (cohérence Lots 2-27).
     - B-VS-5 (P3) : JSDoc sur les fonctions internes.
     - Guard _openInProgress sur openContractModal (double-clic).
     - Bump version 1.3.0 -> 9.0.0.

   ARCHITECTURE :
     vendor-signup.js orchestre l'inscription vendeur :
       1. Formulaire rempli (shopName, email, phone, city,
          iceCin, password, shippingMethod)
       2. Click "Lire et signer les CGV" → openContractModal()
          → computePreSignature() capture texte + hash + version +
          snapshot FIGÉS en mémoire
       3. Acceptation → preSignature reste en mémoire, contractAccepted=true
       4. Submit → registerVendorWithFirebase() (auth.js) →
          signVendorContract() (vendor-contract.js, transaction Lot 27) →
          updateDoc users/{uid} (transition contractStatus)
       5. Redirection /vendor/dashboard.html avec flags
          (welcome, verifyEmail, contractFailed, contractTransitionFailed)

   IMPORTANT — signature électronique :
     Le texte signé est EXACTEMENT celui affiché à l'acceptation
     (preSignature.textHash). Toute modification entre l'acceptation
     et le submit (impossible en pratique car le texte est en
     mémoire) invaliderait la signature.

   DÉPENDANCES :
     - ./auth.js : registerVendorWithFirebase
     - ./vendor-contract.js : signVendorContract, computeContractTextHash
     - ./vendor-contract-text.js : getContractText, buildTermsSnapshot
     - ./firebase.js : db
     - ./config.js : CONFIG, SIGNUP_METHODS, LANGUAGES, DEFAULT_LANGUAGE
     - ./utils.js : safeGetItem
     - ./ui-core.js : showToast
     - firebase/firestore : doc, updateDoc, serverTimestamp

   ALERTE 1 : plus aucun commentaire de ligne (//) en début de
   ligne utile. Tout est en bloc.
   ============================================================ */

import { registerVendorWithFirebase } from "./auth.js";
import { signVendorContract, computeContractTextHash } from "./vendor-contract.js";
import { getContractText, buildTermsSnapshot } from "./vendor-contract-text.js";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase.js";
import {
    CONFIG,
    SIGNUP_METHODS,
    LANGUAGES,
    DEFAULT_LANGUAGE
} from "./config.js";
import { safeGetItem } from "./utils.js";
import { showToast } from "./ui-core.js";

/* ============================================================
   ÉTAT MODULE
   ============================================================ */
let contractAccepted = false;
let preSignature = {
    textHash: null,
    language: DEFAULT_LANGUAGE,
    version: null,
    termsSnapshot: null
};
let submitInProgress = false;
let scrollReached = false;

/* Guard contre les double-clics sur "Lire et signer". */
let _openInProgress = false;

const els = {};

/* ============================================================
   I18N (fallback inline, indépendant de translations.js)
   ============================================================ */

/**
 * Retourne la langue courante depuis :
 *   1. document.documentElement.lang (défini par setLang ou HTML)
 *   2. localStorage[swi9a_lang] (désérialisé via safeGetItem)
 *   3. DEFAULT_LANGUAGE
 *
 * B-VS-1 : utilise safeGetItem (au lieu de localStorage brut) car
 * safeSetItem sérialise en JSON → localStorage brut retournait
 * '"fr"' au lieu de 'fr' → le fallback était cassé.
 *
 * @returns {string} 'fr' | 'ar' | 'en'
 */
function getCurrentLanguage() {
    const htmlLang = (document.documentElement.lang || "").toLowerCase();
    if (LANGUAGES.includes(htmlLang)) return htmlLang;
    try {
        const stored = safeGetItem(CONFIG.STORAGE_KEYS.LANG);
        if (stored && LANGUAGES.includes(stored)) return stored;
    } catch (_) { /* ignore */ }
    return DEFAULT_LANGUAGE;
}

const MINIMAL_FALLBACKS = {
    "vendor.contract.open":         { fr: "Lire le contrat",                       ar: "قراءة العقد",                         en: "Read contract" },
    "vendor.contract.close":        { fr: "Fermer",                                ar: "إغلاق",                              en: "Close" },
    "vendor.contract.accept":       { fr: "J'accepte les conditions et je signe",  ar: "أوافق على الشروط وأوقّع",              en: "I accept and sign" },
    "vendor.contract.canSign":      { fr: "Vous pouvez maintenant signer.",        ar: "يمكنك الآن التوقيع.",                   en: "You can now sign." },
    "vendor.contract.scrollHint":   { fr: "Faites défiler pour lire le contrat.",  ar: "مرّر لقراءة العقد.",                    en: "Scroll to read the contract." },
    "vendor.contract.checkbox":     { fr: "J'ai lu et j'accepte le contrat",        ar: "لقد قرأت وأوافق على العقد",             en: "I have read and accept the contract" },
    "vendor.contract.accepted":     { fr: "Contrat accepté le {date}. Il sera signé après création du compte.", ar: "تم قبول العقد في {date}. سيتم التوقيع بعد إنشاء الحساب.", en: "Contract accepted on {date}. Will be signed after account creation." },
    "vendor.contract.required":     { fr: "Vous devez lire et accepter le contrat.", ar: "يجب قراءة العقد وقبوله.",            en: "You must read and accept the contract." },
    "vendor.signup.creating":       { fr: "Création du compte...",                 ar: "جارٍ إنشاء الحساب...",                en: "Creating account..." },
    "vendor.signup.submit":         { fr: "Créer mon compte vendeur",              ar: "إنشاء حساب البائع",                   en: "Create my vendor account" },
    "vendor.signup.success":        { fr: "Inscription réussie ! Vérifiez votre email.", ar: "تم التسجيل! تحقق من بريدك.",     en: "Registration successful! Check your email." },
    "vendor.signup.successContractFailed": { fr: "Compte créé, mais signature échouée. Connectez-vous pour finaliser.", ar: "تم إنشاء الحساب لكن التوقيع فشل.", en: "Account created, but signature failed." },
    "vendor.signup.transitionFailed": { fr: "Compte créé et contrat signé, mais la synchronisation du profil a échoué. Finalisez depuis le dashboard.", ar: "تم إنشاء الحساب وتوقيع العقد، لكن مزامنة الملف الشخصي فشلت. أكمل من لوحة التحكم.", en: "Account created and contract signed, but profile sync failed. Complete from the dashboard." },
    "vendor.signup.error":          { fr: "Erreur lors de l'inscription",          ar: "خطأ أثناء التسجيل",                    en: "Registration error" },
    "vendor.signup.invalidFields":  { fr: "Champs invalides :",                    ar: "حقول غير صالحة:",                      en: "Invalid fields:" },
    "vendor.signup.contractSignError": { fr: "Erreur signature contrat.",          ar: "خطأ في توقيع العقد.",                  en: "Contract signature error." },
    "vendor.field.shopName":        { fr: "nom de boutique",                       ar: "اسم المتجر",                          en: "shop name" },
    "vendor.field.email":           { fr: "email",                                 ar: "البريد الإلكتروني",                    en: "email" },
    "vendor.field.phone":           { fr: "téléphone",                             ar: "الهاتف",                              en: "phone" },
    "vendor.field.city":            { fr: "ville",                                 ar: "المدينة",                             en: "city" },
    "vendor.field.iceCin":          { fr: "ICE ou CIN",                            ar: "ICE أو CIN",                          en: "ICE or CIN" },
    "vendor.field.password":        { fr: "mot de passe",                          ar: "كلمة المرور",                         en: "password" },
    "vendor.field.shipping":        { fr: "mode de livraison",                     ar: "طريقة الشحن",                         en: "shipping method" }
};

function tr(key, params = {}) {
    const lang = getCurrentLanguage();
    let value =
        (window.translations && window.translations[lang] && window.translations[lang][key]) ||
        (window.translations && window.translations[DEFAULT_LANGUAGE] && window.translations[DEFAULT_LANGUAGE][key]) ||
        (MINIMAL_FALLBACKS[key] && MINIMAL_FALLBACKS[key][lang]) ||
        (MINIMAL_FALLBACKS[key] && MINIMAL_FALLBACKS[key][DEFAULT_LANGUAGE]) ||
        key;
    for (const p in params) value = value.replace("{" + p + "}", params[p]);
    return value;
}

/* ============================================================
   VALIDATEURS
   ============================================================ */
function isValidEmail(v) {
    return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;
}

function normalizePhone(raw) {
    if (typeof raw !== "string") return "";
    const s = raw.replace(/[\s\-\(\)\.]/g, "");
    if (/^0[67]\d{8}$/.test(s)) return "+212" + s.substring(1);
    if (/^\+212[67]\d{8}$/.test(s)) return s;
    if (/^00212[67]\d{8}$/.test(s)) return "+" + s.substring(2);
    return s;
}

function isValidMoroccanPhone(raw) {
    const s = normalizePhone(raw);
    return /^\+212[67]\d{8}$/.test(s);
}

function isValidIceCin(v) {
    if (typeof v !== "string") return false;
    const t = v.trim().toUpperCase();
    if (/^\d{15}$/.test(t)) return true;
    if (/^[A-Z]{1,2}\d{5,6}$/.test(t)) return true;
    if (/^\d{6,8}$/.test(t)) return true;
    return false;
}

function isValidPassword(p) {
    if (typeof p !== "string" || p.length < 8 || p.length > 128) return false;
    return /[A-Za-z]/.test(p) && /\d/.test(p);
}

function isValidShopName(s) {
    if (typeof s !== "string") return false;
    const t = s.trim();
    if (t.length < 2 || t.length > 60) return false;
    return /^[\p{L}\p{N}\s\-'&\.]{2,60}$/u.test(t);
}

function isValidCity(s) {
    if (typeof s !== "string") return false;
    const t = s.trim();
    if (t.length < 2 || t.length > 80) return false;
    return /^[\p{L}\p{N}\s\-'\.]{2,80}$/u.test(t);
}

/* ============================================================
   HELPERS UI
   ============================================================ */
function setButtonLoading(btn, loading, loadingText, normalText) {
    if (!btn) return;
    btn.disabled = !!loading;
    btn.style.opacity = loading ? "0.7" : "1";
    if (loading && loadingText) btn.textContent = loadingText;
    else if (!loading && normalText) btn.textContent = normalText;
}

function updateAcceptButtonState() {
    if (!els.btnAcceptContract) return;
    const checkboxOK = !els.contractCheckbox || els.contractCheckbox.checked;
    const ready = scrollReached && checkboxOK;
    els.btnAcceptContract.disabled = !ready;
    els.btnAcceptContract.style.opacity = ready ? "1" : "0.5";
    if (els.scrollHint) {
        if (!scrollReached || !checkboxOK) {
            els.scrollHint.textContent = tr("vendor.contract.scrollHint");
            els.scrollHint.style.color = "var(--text-muted)";
        } else {
            els.scrollHint.textContent = tr("vendor.contract.canSign");
            els.scrollHint.style.color = "var(--success)";
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
        els.btnAcceptContract.style.opacity = "0.5";
        els.btnAcceptContract.textContent = tr("vendor.contract.accept");
    }
    if (els.contractCheckbox) els.contractCheckbox.checked = false;
    if (els.scrollHint) {
        els.scrollHint.textContent = tr("vendor.contract.scrollHint");
        els.scrollHint.style.color = "var(--text-muted)";
    }
    if (els.contractText) els.contractText.scrollTop = 0;
    if (els.contractStatus) {
        els.contractStatus.textContent = "";
        els.contractStatus.style.color = "";
    }
}

/**
 * Calcule la pré-signature (texte, hash, version, snapshot) à
 * partir de la langue courante et de la version du contrat dans
 * CONFIG. Le résultat est figé dans preSignature (état module).
 *
 * Le hash textHash est calculé sur le texte EXACT affiché. Toute
 * modification ultérieure du texte (impossible en pratique) rendrait
 * la signature invalide côté verifyContractIntegrity.
 *
 * @returns {Promise<{ text: string, lang: string, ok: boolean }>}
 */
async function computePreSignature() {
    const lang = getCurrentLanguage();
    const version = CONFIG.VENDOR.CONTRACT_VERSION;

    let termsSnapshot;
    let text;
    try {
        termsSnapshot = buildTermsSnapshot();
        text = getContractText(lang, version, termsSnapshot);
    } catch (e) {
        console.error("[vendor-signup] Impossible de générer le contrat :", e);
        preSignature = { textHash: null, language: lang, version: null, termsSnapshot: null };
        return { text: "", lang, ok: false };
    }

    try {
        const hash = await computeContractTextHash(text);
        preSignature = { textHash: hash, language: lang, version, termsSnapshot };
        return { text, lang, ok: true };
    } catch (e) {
        console.error("[vendor-signup] Impossible de calculer le hash du contrat :", e);
        preSignature = { textHash: null, language: lang, version, termsSnapshot };
        return { text, lang, ok: false };
    }
}

/* ============================================================
   MODALE CONTRAT
   ============================================================ */

/**
 * Ouvre la modale contrat en mode signature. Calcule la
 * pré-signature, affiche le texte, active le scroll-safety.
 * Guard _openInProgress contre les double-clics.
 *
 * @returns {Promise<void>}
 */
async function openContractModal() {
    if (!els.modal) return;
    if (_openInProgress) return;
    _openInProgress = true;

    try {
        const { text, lang, ok } = await computePreSignature();
        if (!ok) {
            showToast(tr("vendor.signup.contractSignError"));
            return;
        }

        if (els.contractText) {
            els.contractText.textContent = text;
            els.contractText.setAttribute("lang", lang);
            els.contractText.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
            els.contractText.scrollTop = 0;
        }

        resetContractUI();

        els.modal.classList.add("open");
        els.modal.setAttribute("aria-modal", "true");
        els.modal.setAttribute("role", "dialog");
        document.body.style.overflow = "hidden";

        if (els.btnAcceptContract) els.btnAcceptContract.focus();

        requestAnimationFrame(() => requestAnimationFrame(checkScrollReached));
    } finally {
        _openInProgress = false;
    }
}

function closeContractModal() {
    if (!els.modal) return;
    els.modal.classList.remove("open");
    document.body.style.overflow = "";
}

function trapFocus(e) {
    if (!els.modal || !els.modal.classList.contains("open")) return;
    if (e.key !== "Tab") return;
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

/* ============================================================
   INITIALISATION
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
    els.form = document.getElementById("vendorSignupForm");
    els.modal = document.getElementById("contractModal");
    els.contractText = document.getElementById("contractText");
    els.btnAcceptContract = document.getElementById("btnAcceptContract");
    els.btnOpenContract = document.getElementById("btnOpenContract");
    els.btnCloseContract = document.getElementById("btnCloseContract");
    els.scrollHint = document.getElementById("scrollHint");
    els.btnSubmitVendor = document.getElementById("btnSubmitVendor");
    els.contractStatus = document.getElementById("contractStatus");

    if (!els.form || !els.modal) {
        console.warn("[vendor-signup] Formulaire ou modale absent, arrêt silencieux.");
        return;
    }

    /* Case à cocher (créée si absente du HTML). */
    els.contractCheckbox = document.getElementById("contractCheckbox");
    if (!els.contractCheckbox) {
        const label = document.createElement("label");
        label.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:8px;font-size:14px;cursor:pointer;";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.id = "contractCheckbox";
        label.appendChild(cb);
        label.appendChild(document.createTextNode(" " + tr("vendor.contract.checkbox")));
        if (els.scrollHint && els.scrollHint.parentNode) {
            els.scrollHint.parentNode.insertBefore(label, els.scrollHint.nextSibling);
        } else if (els.contractText && els.contractText.parentNode) {
            els.contractText.parentNode.appendChild(label);
        }
        els.contractCheckbox = cb;
    }
    els.contractCheckbox.addEventListener("change", updateAcceptButtonState);

    if (els.scrollHint) els.scrollHint.setAttribute("aria-live", "polite");

    /* Cartes de livraison. */
    document.querySelectorAll(".v-choice").forEach(card => {
        card.addEventListener("click", () => {
            document.querySelectorAll(".v-choice").forEach(c => c.classList.remove("selected"));
            card.classList.add("selected");
            const radio = card.querySelector('input[type="radio"]');
            if (radio) radio.checked = true;
        });
    });

    /* Ouverture / fermeture modale. */
    els.btnOpenContract?.addEventListener("click", (e) => { e.preventDefault(); openContractModal(); });
    els.btnCloseContract?.addEventListener("click", (e) => { e.preventDefault(); closeContractModal(); });
    els.modal.addEventListener("click", (e) => { if (e.target === els.modal) closeContractModal(); });
    document.addEventListener("keydown", (e) => {
        if (!els.modal.classList.contains("open")) return;
        if (e.key === "Escape") { e.preventDefault(); closeContractModal(); }
        else trapFocus(e);
    });

    /* Scroll contrat. */
    els.contractText?.addEventListener("scroll", checkScrollReached, { passive: true });
    window.addEventListener("resize", () => {
        if (els.modal && els.modal.classList.contains("open")) checkScrollReached();
    });

    /* Acceptation (pré-signature en mémoire). */
    els.btnAcceptContract?.addEventListener("click", async () => {
        if (!preSignature.textHash || !preSignature.version) {
            const { ok } = await computePreSignature();
            if (!ok) { showToast(tr("vendor.signup.contractSignError")); return; }
        }
        contractAccepted = true;
        closeContractModal();

        if (els.contractStatus) {
            els.contractStatus.textContent = tr("vendor.contract.accepted", {
                date: new Date().toLocaleDateString(getCurrentLanguage())
            });
            els.contractStatus.style.color = "var(--success)";
        }
        if (els.btnSubmitVendor) {
            els.btnSubmitVendor.disabled = false;
            els.btnSubmitVendor.style.opacity = "1";
        }
        showToast(tr("vendor.contract.canSign"));
    });

    /* Soumission finale. */
    els.form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (submitInProgress) return;

        const honeypot = document.getElementById("vWebsite");
        if (honeypot && honeypot.value.trim()) {
            console.warn("[vendor-signup] Honeypot déclenché - soumission ignorée.");
            return;
        }

        if (!contractAccepted || !preSignature.textHash || !preSignature.version || !preSignature.termsSnapshot) {
            showToast(tr("vendor.contract.required"));
            return;
        }

        const shopName = (document.getElementById("vShopName")?.value || "").trim();
        const email = (document.getElementById("vEmail")?.value || "").trim().toLowerCase();
        const phoneRaw = (document.getElementById("vPhone")?.value || "").trim();
        const city = (document.getElementById("vCity")?.value || "").trim();
        const iceCin = (document.getElementById("vIceCin")?.value || "").trim().toUpperCase();
        const password = document.getElementById("vPassword")?.value || "";
        const shippingRadio = document.querySelector('input[name="vShipping"]:checked');

        const fieldErrors = [];
        if (!isValidShopName(shopName)) fieldErrors.push("shopName");
        if (!isValidEmail(email)) fieldErrors.push("email");
        if (!isValidMoroccanPhone(phoneRaw)) fieldErrors.push("phone");
        if (!isValidCity(city)) fieldErrors.push("city");
        if (!isValidIceCin(iceCin)) fieldErrors.push("iceCin");
        if (!isValidPassword(password)) fieldErrors.push("password");
        if (!shippingRadio) fieldErrors.push("shipping");

        if (fieldErrors.length) {
            const labels = fieldErrors.map(k => tr("vendor.field." + k)).join(", ");
            showToast(tr("vendor.signup.invalidFields") + " " + labels);
            return;
        }

        submitInProgress = true;
        setButtonLoading(els.btnSubmitVendor, true, tr("vendor.signup.creating"), tr("vendor.signup.submit"));

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
            console.error("[vendor-signup] Inscription échouée :", err);
            showToast(err?.message || tr("vendor.signup.error"));
            setButtonLoading(els.btnSubmitVendor, false, null, tr("vendor.signup.submit"));
            submitInProgress = false;
            return;
        }

        if (!authResult || !authResult.uid) {
            console.error("[vendor-signup] Pas d'UID retourné :", authResult);
            showToast(tr("vendor.signup.error"));
            setButtonLoading(els.btnSubmitVendor, false, null, tr("vendor.signup.submit"));
            submitInProgress = false;
            return;
        }

        /* Reconstruit le texte avec le snapshot capturé à la pré-signature. */
        let contractText;
        try {
            contractText = getContractText(
                preSignature.language,
                preSignature.version,
                preSignature.termsSnapshot
            );
        } catch (err) {
            console.error("[vendor-signup] Reconstruction du contrat impossible :", err);
            showToast(tr("vendor.signup.contractSignError"));
            setButtonLoading(els.btnSubmitVendor, false, null, tr("vendor.signup.submit"));
            submitInProgress = false;
            return;
        }

        /* Signature versionnée (source=signup, version+snapshot transmis). */
        let contractSigned = false;
        let signResult = null;
        try {
            signResult = await signVendorContract(authResult.uid, contractText, {
                textHash: preSignature.textHash,
                language: preSignature.language,
                version: preSignature.version,
                termsSnapshot: preSignature.termsSnapshot,
                source: "signup"
            });
            if (!signResult || !signResult.contractId) {
                throw new Error("signVendorContract : contractId manquant dans le retour.");
            }
            contractSigned = true;
        } catch (err) {
            console.error("[vendor-signup] Signature contrat échouée :", err);
        }

        /* Transition users/{uid} si la signature a réussi. */
        let transitionOk = false;
        if (contractSigned && signResult) {
            try {
                await updateDoc(doc(db, "users", authResult.uid), {
                    "vendorInfo.contractStatus": "accepted",
                    "vendorInfo.currentContractId": signResult.contractId,
                    "vendorInfo.contractVersion": signResult.version,
                    "updatedAt": serverTimestamp()
                });
                transitionOk = true;
            } catch (err) {
                console.error(
                    "[vendor-signup] Transition users.vendorInfo échouée (reprise possible depuis le dashboard) :",
                    err
                );
            }
        }

        /* Redirection vers le dashboard avec paramètres de statut. */
        const params = new URLSearchParams();
        params.set("welcome", "1");
        params.set("verifyEmail", "1");
        if (!contractSigned) {
            params.set("contractFailed", "1");
        } else if (!transitionOk) {
            params.set("contractTransitionFailed", "1");
        }

        let toastMsg;
        if (!contractSigned) {
            toastMsg = tr("vendor.signup.successContractFailed");
        } else if (!transitionOk) {
            toastMsg = tr("vendor.signup.transitionFailed");
        } else {
            toastMsg = tr("vendor.signup.success");
        }
        showToast(toastMsg);

        /* B-VS-3 : URL propre si params vide (cas théorique). */
        const queryString = params.toString() ? "?" + params.toString() : "";
        setTimeout(() => {
            window.location.href = "/vendor/dashboard.html" + queryString;
        }, 1800);
    });
});

/* ============================================================
   LOG
   ============================================================ */
console.log("[vendor-signup] v9.0.0 chargé (Lot 28 : safeGetItem + logs + URL propre)");