--- js/vendor-signup.js ---
/* ============================================================
   js/vendor-signup.js
   Logique d'inscription vendeur — Lot 51
   Version 9.3.1 — Chemin /vendor/dashboard (minuscule) + conversion
   ============================================================ */

import { registerVendorWithFirebase, convertUserToVendor } from "./auth.js";
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
let _openInProgress = false;

const els = {};

/* ============================================================
   I18N
   ============================================================ */
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
    "vendor.contract.required":     { fr: "Vous devez lire et accepter le contrat avant de créer votre compte.", ar: "يجب قراءة العقد وقبوله قبل إنشاء حسابك.",            en: "You must read and accept the contract before creating your account." },
    "vendor.signup.creating":       { fr: "Création du compte...",                 ar: "جارٍ إنشاء الحساب...",                en: "Creating account..." },
    "vendor.signup.submit":         { fr: "Créer mon compte vendeur",              ar: "إنشاء حساب البائع",                   en: "Create my vendor account" },
    "vendor.signup.success":        { fr: "Inscription réussie ! Vérifiez votre email.", ar: "تم التسجيل! تحقق من بريدك.",     en: "Registration successful! Check your email." },
    "vendor.signup.successContractFailed": { fr: "Compte créé, mais signature échouée. Connectez-vous pour finaliser.", ar: "تم إنشاء الحساب لكن التوقيع فشل.", en: "Account created, but signature failed." },
    "vendor.signup.transitionFailed": { fr: "Compte créé et contrat signé, mais la synchronisation du profil a échoué. Finalisez depuis le dashboard.", ar: "تم إنشاء الحساب وتوقيع العقد، لكن مزامنة الملف الشخصي فشلت. أكمل من لوحة التحكم.", en: "Account created and contract signed, but profile sync failed. Complete from the dashboard." },
    "vendor.signup.error":          { fr: "Erreur lors de l'inscription",          ar: "خطأ أثناء التسجيل",                    en: "Registration error" },
    "vendor.signup.invalidFields":  { fr: "Champs invalides :",                    ar: "حقول غير صالحة:",                      en: "Invalid fields:" },
    "vendor.signup.contractSignError": { fr: "Erreur de sécurité. Le site doit être en HTTPS pour signer.",          ar: "خطأ في توقيع العقد.",                  en: "Security error. Site must be HTTPS to sign." },
    "vendor.signup.conversionRequested": { fr: "Votre demande de conversion en compte vendeur a été envoyée à l'administrateur. Vous recevrez une notification après approbation.", ar: "تم إرسال طلب التحويل إلى المسؤول.", en: "Your conversion request has been sent to the administrator." },
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
function isValidEmail(v) { return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254; }
function normalizePhone(raw) {
    if (typeof raw !== "string") return "";
    const s = raw.replace(/[\s\-\(\)\.]/g, "");
    if (/^0[67]\d{8}$/.test(s)) return "+212" + s.substring(1);
    if (/^\+212[67]\d{8}$/.test(s)) return s;
    if (/^00212[67]\d{8}$/.test(s)) return "+" + s.substring(2);
    return s;
}
function isValidMoroccanPhone(raw) { return /^\+212[67]\d{8}$/.test(normalizePhone(raw)); }
function isValidIceCin(v) {
    if (typeof v !== "string") return false;
    const t = v.trim().toUpperCase();
    return /^\d{15}$/.test(t) || /^[A-Z]{1,2}\d{5,6}$/.test(t) || /^\d{6,8}$/.test(t);
}
function isValidPassword(p) { return typeof p === "string" && p.length >= 8 && p.length <= 128 && /[A-Za-z]/.test(p) && /\d/.test(p); }
function isValidShopName(s) {
    if (typeof s !== "string") return false;
    const t = s.trim();
    return t.length >= 2 && t.length <= 60 && /^[\p{L}\p{N}\s\-'&\.]{2,60}$/u.test(t);
}
function isValidCity(s) {
    if (typeof s !== "string") return false;
    const t = s.trim();
    return t.length >= 2 && t.length <= 80 && /^[\p{L}\p{N}\s\-'\.]{2,80}$/u.test(t);
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

async function computePreSignature() {
    const lang = getCurrentLanguage();
    const version = CONFIG.VENDOR.CONTRACT_VERSION;

    /* SÉCURITÉ : Vérification de l'API Web Crypto (HTTPS requis) */
    if (typeof crypto === "undefined" || !crypto.subtle) {
        console.error("[vendor-signup] Web Crypto API non disponible. Le site doit être en HTTPS.");
        showToast("Erreur de sécurité : le site doit être en HTTPS pour signer le contrat.");
        return { text: "", lang, ok: false };
    }

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
async function openContractModal() {
    if (!els.modal || _openInProgress) return;
    _openInProgress = true;

    try {
        const { text, lang, ok } = await computePreSignature();

        if (!text) {
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

        if (!ok && els.scrollHint) {
            els.scrollHint.textContent = "⚠️ Erreur de sécurité. Le site doit être en HTTPS pour valider la signature.";
            els.scrollHint.style.color = "var(--danger)";
        }

        els.modal.classList.add("open");
        els.modal.setAttribute("aria-modal", "true");
        els.modal.setAttribute("role", "dialog");
        document.body.style.overflow = "hidden";

        if (els.btnAcceptContract) els.btnAcceptContract.focus();
        requestAnimationFrame(() => requestAnimationFrame(checkScrollReached));
    } catch (err) {
        console.error("[vendor-signup] Erreur à l'ouverture du contrat :", err);
        showToast("Erreur d'ouverture du contrat.");
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
    const focusables = els.modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
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

    document.querySelectorAll(".v-choice").forEach(card => {
        card.addEventListener("click", () => {
            document.querySelectorAll(".v-choice").forEach(c => c.classList.remove("selected"));
            card.classList.add("selected");
            const radio = card.querySelector('input[type="radio"]');
            if (radio) radio.checked = true;
        });
    });

    els.btnOpenContract?.addEventListener("click", (e) => { e.preventDefault(); openContractModal(); });
    els.btnCloseContract?.addEventListener("click", (e) => { e.preventDefault(); closeContractModal(); });
    els.modal.addEventListener("click", (e) => { if (e.target === els.modal) closeContractModal(); });

    document.addEventListener("keydown", (e) => {
        if (!els.modal.classList.contains("open")) return;
        if (e.key === "Escape") { e.preventDefault(); closeContractModal(); }
        else trapFocus(e);
    });

    els.contractText?.addEventListener("scroll", checkScrollReached, { passive: true });
    window.addEventListener("resize", () => {
        if (els.modal && els.modal.classList.contains("open")) checkScrollReached();
    });

    els.btnAcceptContract?.addEventListener("click", async () => {
        if (!preSignature.textHash) {
            showToast(tr("vendor.signup.contractSignError"));
            return;
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

    /* ============================================================
       SOUMISSION FINALE (avec Upgrade automatique)
       ============================================================ */
    els.form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (submitInProgress) return;

        if (!contractAccepted || !preSignature.textHash) {
            showToast(tr("vendor.contract.required"));
            return;
        }

        const honeypot = document.getElementById("vWebsite");
        if (honeypot && honeypot.value.trim()) return;

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
            showToast(tr("vendor.signup.invalidFields") + " " + fieldErrors.map(k => tr("vendor.field." + k)).join(", "));
            return;
        }

        submitInProgress = true;
        setButtonLoading(els.btnSubmitVendor, true, tr("vendor.signup.creating"), tr("vendor.signup.submit"));

        const vendorData = {
            shopName, email, phone: normalizePhone(phoneRaw), city, iceCin,
            shippingMethod: shippingRadio.value, signupMethod: SIGNUP_METHODS.VENDOR
        };

        let authResult;
        let isUpgrade = false;

        try {
            /* 1. On tente de créer un nouveau compte */
            authResult = await registerVendorWithFirebase(vendorData, password);
        } catch (err) {
            /* 🚨 SI L'EMAIL EXISTE DÉJÀ : On tente l'Upgrade */
            if (err.code === "auth/email-already-in-use") {
                try {
                    console.log("[vendor-signup] Email existant détecté. Création d'une demande de conversion...");
                    authResult = await convertUserToVendor(email, password, vendorData);
                    isUpgrade = true;
                } catch (upgradeErr) {
                    console.error("[vendor-signup] Échec de la conversion [" + (upgradeErr.code || "unknown") + "] :", upgradeErr);
                    showToast(upgradeErr.message || "Erreur : impossible de convertir ce compte client en vendeur.", 7000);
                    setButtonLoading(els.btnSubmitVendor, false, null, tr("vendor.signup.submit"));
                    submitInProgress = false;
                    return;
                }
            } else {
                /* Autre erreur Firebase */
                console.error("[vendor-signup] Erreur inscription vendeur [" + (err.code || "unknown") + "] :", err);
                showToast(err?.message || tr("vendor.signup.error"), 6000);
                setButtonLoading(els.btnSubmitVendor, false, null, tr("vendor.signup.submit"));
                submitInProgress = false;
                return;
            }
        }

        if (!authResult || !authResult.uid) {
            console.error("[vendor-signup] authResult invalide :", authResult);
            showToast(tr("vendor.signup.error"));
            setButtonLoading(els.btnSubmitVendor, false, null, tr("vendor.signup.submit"));
            submitInProgress = false;
            return;
        }

        /* ============================================================
           CAS UPGRADE : conversion request (pas de signature de contrat)
           ============================================================
           L'utilisateur reste `user` jusqu'à approbation admin. Il n'a
           donc pas le droit d'écrire dans `contracts` ni `users.vendorInfo`.
           On affiche un message clair et on redirige vers l'accueil.
           ============================================================ */
        if (isUpgrade && authResult.isConversionRequest) {
            showToast(tr("vendor.signup.conversionRequested"), 7000);
            setButtonLoading(els.btnSubmitVendor, false, null, tr("vendor.signup.submit"));
            /* On garde submitInProgress = true pour empêcher un re-clic
               pendant la redirection. */
            setTimeout(() => {
                window.location.href = "/";
            }, 2500);
            return;
        }

        /* ============================================================
           CAS INSCRIPTION NORMALE : signature du contrat
           ============================================================ */
        let contractText;
        try {
            contractText = getContractText(preSignature.language, preSignature.version, preSignature.termsSnapshot);
        } catch (err) {
            console.error("[vendor-signup] Reconstruction du contrat impossible :", err);
            showToast(tr("vendor.signup.contractSignError"), 6000);
            setButtonLoading(els.btnSubmitVendor, false, null, tr("vendor.signup.submit"));
            submitInProgress = false;
            return;
        }

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
            console.error("[vendor-signup] Signature contrat échouée [" + (err.code || err.message || "unknown") + "] :", err);
        }

        let transitionOk = false;
        if (contractSigned && signResult) {
            try {
                await updateDoc(doc(db, "users", authResult.uid), {
                    "vendorInfo.contractStatus": "accepted",
                    "vendorInfo.currentContractId": signResult.contractId,
                    "vendorInfo.contractVersion": signResult.version,
                    "vendorInfo.contractSignedAt": serverTimestamp(),
                    "updatedAt": serverTimestamp()
                });
                transitionOk = true;
            } catch (err) {
                console.error("[vendor-signup] Transition users.vendorInfo échouée [" + (err.code || "unknown") + "] :", err);
            }
        }

        /* Construction de l'URL de redirection : /vendor/dashboard
           (minuscule + cleanUrls => pas de .html). */
        const params = new URLSearchParams();
        params.set("welcome", "1");
        params.set("verifyEmail", "1");
        if (!contractSigned) params.set("contractFailed", "1");
        else if (!transitionOk) params.set("contractTransitionFailed", "1");

        let toastMsg;
        let redirectDelayMs;
        let toastDurationMs;

        if (!contractSigned) {
            toastMsg = tr("vendor.signup.successContractFailed");
            redirectDelayMs = 4000;
            toastDurationMs = 6000;
        } else if (!transitionOk) {
            toastMsg = tr("vendor.signup.transitionFailed");
            redirectDelayMs = 4000;
            toastDurationMs = 6000;
        } else {
            toastMsg = tr("vendor.signup.success");
            redirectDelayMs = 1200;
            toastDurationMs = 4000;
        }
        showToast(toastMsg, toastDurationMs);

        const queryString = params.toString() ? "?" + params.toString() : "";
        setTimeout(() => {
            /* CORRECTION ICI : /vendor/dashboard en minuscule */
            window.location.href = "/vendor/dashboard" + queryString;
        }, redirectDelayMs);
    });
});

console.log("[vendor-signup] v9.3.1 chargé (chemin /vendor/dashboard + conversion request)");
--- fin js/vendor-signup.js ---