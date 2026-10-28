/* ============================================================
   js/auth.js
   AUTHENTIFICATION - SMART SWI9A
   Version 9.2.0 - Lot 51 : wallet à l'approbation + upgrade via
                             demande de conversion
   ============================================================ */

import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    sendEmailVerification,
    onAuthStateChanged,
    signOut,
    updatePassword,
    reload,
    deleteUser,
    GoogleAuthProvider,
    FacebookAuthProvider,
    signInWithPopup
} from "firebase/auth";
import {
    doc, setDoc, getDoc, deleteDoc, Timestamp, serverTimestamp,
    collection, addDoc, query, where, getDocs, limit
} from "firebase/firestore";
import { auth, db } from "./firebase.js";
import { CONFIG, SIGNUP_METHODS, ROLES, VENDOR_STATUS, CONTRACT_STATUS } from "./config.js";
import {
    t, safeGetItem, safeSetItem, safeRemoveItem,
    isValidEmail, cleanEmail
} from "./utils.js";
import { setUser, getUser } from "./store.js";
import { showToast } from "./ui-core.js";

/* ============================================================
   LOG SÉCURISÉ
   ============================================================ */
function isLocalDev() {
    if (typeof window === "undefined") return false;
    const h = window.location.hostname;
    return h === "localhost" || h === "127.0.0.1";
}

function logAuthError(context, error) {
    if (isLocalDev()) {
        console.error(context, error);
    } else {
        const code = (error && (error.code || error.name)) || "unknown";
        console.error(context + " [" + code + "]");
    }
}

/* ============================================================
   ÉTAT GLOBAL
   ============================================================ */
let authReady = false;
let authReadyResolve;

export const authReadyPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
        console.warn("authReadyPromise résolue par timeout (10s)");
        resolve();
    }, 10000);
    authReadyResolve = () => {
        clearTimeout(timeout);
        resolve();
    };
});

export function isAuthReady() { return authReady; }
export function getCurrentUser() { return getUser(); }

function sanitizeUserForStorage(user) {
    if (!user) return null;
    return {
        uid: user.uid || "",
        email: user.email || "",
        emailVerified: user.emailVerified === true,
        name: user.name || "",
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        role: user.role || ROLES.USER,
        signupMethod: user.signupMethod || "",
        photoURL: user.photoURL || "",
        needsVerification: user.needsVerification === true
    };
}

export function setCurrentUser(user) {
    setUser(user);
    if (user) {
        try {
            safeSetItem(CONFIG.STORAGE_KEYS.USER, sanitizeUserForStorage(user));
        } catch (e) {
            logAuthError("safeSetItem échoué (quota ?)", e);
        }
        if (!user._fromCache && user.emailVerified !== false && !user.needsVerification) {
            startIdleTimer();
        }
    } else {
        safeRemoveItem(CONFIG.STORAGE_KEYS.USER);
        stopIdleTimer();
    }
    document.dispatchEvent(new CustomEvent("auth-updated", { detail: { user } }));
}

export function isEmailVerified() {
    const user = auth.currentUser;
    if (!user) return false;
    return user.emailVerified === true;
}

/* ============================================================
   PROFIL UTILISATEUR (Firestore)
   ============================================================ */
export async function saveUserProfile(uid, data) {
    try {
        await setDoc(doc(db, "users", uid), data, { merge: true });
        return true;
    } catch (e) {
        logAuthError("saveUserProfile", e);
        return false;
    }
}

export async function getUserProfile(uid) {
    try {
        const snap = await getDoc(doc(db, "users", uid));
        return snap.exists() ? snap.data() : null;
    } catch (e) {
        logAuthError("getUserProfile", e);
        return null;
    }
}

export async function getUserProfileStatus(uid) {
    try {
        const snap = await getDoc(doc(db, "users", uid));
        if (!snap.exists()) return { exists: false, data: null, error: null };
        return { exists: true, data: snap.data(), error: null };
    } catch (e) {
        logAuthError("getUserProfileStatus", e);
        return { exists: false, data: null, error: e };
    }
}

/* ============================================================
   HELPER : Mapper les erreurs Firebase Auth
   ============================================================ */
function getAuthErrorMessage(error, context = "generic") {
    const code = error?.code || "";

    if (context === "login") {
        if (code === "auth/user-not-found") return t("userNotFound");
        if (code === "auth/wrong-password" || code === "auth/invalid-credential") return t("wrongPassword");
        if (code === "auth/too-many-requests") return t("tooManyRequests");
        if (code === "auth/network-request-failed") return "Pas de connexion internet";
        if (code === "auth/user-disabled") return "Ce compte a été désactivé";
        if (code === "auth/requires-recent-login") return "Reconnectez-vous pour continuer";
        if (code === "auth/multi-factor-auth-required") return "Vérification en deux étapes requise";
        return t("loginError");
    }

    if (context === "register") {
        if (code === "auth/email-already-in-use") return "Cet email est déjà utilisé";
        if (code === "auth/invalid-email") return "Email invalide";
        if (code === "auth/weak-password") return "Mot de passe trop faible";
        if (code === "auth/network-request-failed") return "Pas de connexion internet";
        if (code === "auth/too-many-requests") return t("tooManyRequests");
        if (code === "auth/operation-not-allowed") return "Inscription désactivée (contactez le support)";
        return "Erreur lors de la création du compte";
    }

    if (context === "reset") {
        if (code === "auth/user-not-found") return t("emailNotFound");
        if (code === "auth/invalid-email") return "Email invalide";
        if (code === "auth/too-many-requests") return t("rateLimitError");
        if (code === "auth/network-request-failed") return "Pas de connexion internet";
        return t("resetError");
    }

    if (context === "social") {
        if (code === "auth/popup-closed-by-user") return t("socialPopupClosed");
        if (code === "auth/popup-blocked") return "Popup bloquée. Autorisez les popups.";
        if (code === "auth/account-exists-with-different-credential") return t("socialAccountExists");
        if (code === "auth/cancelled-popup-request") return t("socialPopupClosed");
        if (code === "auth/network-request-failed") return "Pas de connexion internet";
        if (code === "auth/operation-not-allowed") return "Connexion désactivée (contactez le support)";
        return t("error");
    }

    return t("error");
}

/* ============================================================
   INSCRIPTION CLIENT
   ============================================================ */
export async function registerWithFirebase(name, email, phone, dob, password) {
    console.log("registerWithFirebase");

    if (!email || !isValidEmail(email)) {
        showToast("Email invalide");
        return { success: false, error: "invalid_email" };
    }
    if (!password || password.length < 6) {
        showToast("Mot de passe trop faible (min 6 caractères)");
        return { success: false, error: "weak_password" };
    }
    if (!name || name.trim().length < 2) {
        showToast("Nom trop court");
        return { success: false, error: "invalid_name" };
    }

    let userCredential;
    try {
        userCredential = await createUserWithEmailAndPassword(auth, email, password);
    } catch (error) {
        logAuthError("registerWithFirebase (create)", error);
        showToast(getAuthErrorMessage(error, "register"));
        return { success: false, error: error.code || "unknown" };
    }

    const user = userCredential.user;
    const uid = user.uid;

    const parts = name.trim().split(" ");
    const firstName = parts[0] || "";
    const lastName = parts.slice(1).join(" ") || "";

    const profile = {
        name: name.trim(),
        firstName,
        lastName,
        email: cleanEmail(email),
        phone: phone || "",
        dob: dob || "",
        role: ROLES.USER,
        signupMethod: SIGNUP_METHODS.OTP,
        emailVerified: false,
        addresses: [],
        favorites: [],
        notifications: [],
        createdAt: Timestamp.now()
    };

    const profileOk = await saveUserProfile(uid, profile);
    if (!profileOk) {
        try {
            await deleteUser(user);
            console.warn("registerWithFirebase : compte Auth supprimé (profil Firestore échoué)");
        } catch (delErr) {
            logAuthError("registerWithFirebase (deleteUser fallback)", delErr);
            showToast("Erreur d'inscription. Contactez le support.");
        }
        return { success: false, error: "profile_save_failed" };
    }

    try {
        await sendEmailVerification(user, {
            url: `${CONFIG.SHOP.URL}/`,
            handleCodeInApp: false
        });
    } catch (e) {
        logAuthError("registerWithFirebase (sendEmailVerification)", e);
    }

    setCurrentUser({
        uid,
        email: cleanEmail(email),
        emailVerified: false,
        needsVerification: true,
        ...profile
    });

    return {
        success: true,
        uid,
        email: cleanEmail(email),
        emailSent: true,
        needsVerification: true
    };
}

/* ============================================================
   INSCRIPTION VENDEUR
   ============================================================ */
export async function registerVendorWithFirebase(vendorData, password) {
    console.log("registerVendorWithFirebase");

    if (!vendorData?.email || !isValidEmail(vendorData.email)) {
        throw new Error("Email invalide");
    }
    if (
        typeof password !== "string" ||
        password.length < 8 ||
        !/[A-Za-z]/.test(password) ||
        !/\d/.test(password)
    ) {
        throw new Error("Mot de passe trop faible (8 caractères min, lettres et chiffres).");
    }

    const shopName = (vendorData.shopName || "").trim();
    if (shopName.length < 2 || shopName.length > 60) {
        throw new Error("Nom de boutique invalide (2 à 60 caractères).");
    }
    if (!/^\+212[67]\d{8}$/.test(vendorData.phone || "")) {
        throw new Error("Téléphone marocain invalide (06XXXXXXXX ou +2126XXXXXXXX).");
    }
    const city = (vendorData.city || "").trim();
    if (city.length < 2 || city.length > 80) {
        throw new Error("Ville invalide.");
    }
    const iceCin = (vendorData.iceCin || "").trim().toUpperCase();
    if (!(
        /^\d{15}$/.test(iceCin) ||
        /^[A-Z]{1,2}\d{5,6}$/.test(iceCin) ||
        /^\d{6,8}$/.test(iceCin)
    )) {
        throw new Error("ICE ou CIN invalide.");
    }
    if (!["dropoff", "fulfillment"].includes(vendorData.shippingMethod)) {
        throw new Error("Mode de livraison invalide.");
    }

    let userCredential;
    try {
        userCredential = await createUserWithEmailAndPassword(auth, vendorData.email, password);
    } catch (error) {
        logAuthError("registerVendorWithFirebase (create) [" + (error.code || "unknown") + "]", error);
        throw error;
    }

    const user = userCredential.user;
    const uid = user.uid;

    const profile = {
        name: shopName,
        email: cleanEmail(vendorData.email),
        phone: vendorData.phone,
        role: ROLES.VENDOR,
        signupMethod: SIGNUP_METHODS.VENDOR,
        emailVerified: false,
        createdAt: serverTimestamp(),
        vendorInfo: {
            shopName,
            iceCin,
            city,
            shippingMethod: vendorData.shippingMethod,
            status: VENDOR_STATUS.PENDING,
            contractStatus: CONTRACT_STATUS.PENDING,
            delayCount: 0,
            commissionRate: CONFIG.VENDOR.COMMISSION_RATE
        }
    };

    const profileOk = await saveUserProfile(uid, profile);
    if (!profileOk) {
        try { await deleteUser(user); } catch (e) {
            logAuthError("registerVendorWithFirebase (deleteUser après profile failed)", e);
        }
        throw new Error("Impossible d'enregistrer le profil vendeur.");
    }

    try {
        await addDoc(collection(db, "admin_alerts"), {
            type: "vendor_signup",
            vendorId: uid,
            shopName,
            city,
            status: "pending",
            createdAt: serverTimestamp()
        });
    } catch (alertErr) {
        logAuthError("registerVendorWithFirebase (admin_alerts) [" + (alertErr.code || "unknown") + "]", alertErr);
    }

    try {
        await sendEmailVerification(user, {
            url: `${CONFIG.SHOP.URL}/`,
            handleCodeInApp: false
        });
    } catch (e) {
        logAuthError("registerVendorWithFirebase (sendEmailVerification)", e);
    }

    setCurrentUser({
        uid,
        email: cleanEmail(vendorData.email),
        emailVerified: false,
        needsVerification: true,
        ...profile,
        createdAt: new Date()
    });

    return { success: true, uid, needsVerification: true, isNewVendor: true };
}

/* ============================================================
   UPGRADE CLIENT -> VENDEUR (via demande de conversion)
   ============================================================ */
export async function convertUserToVendor(email, password, vendorData) {
    console.log("convertUserToVendor");

    let userCredential;
    try {
        userCredential = await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
        logAuthError("convertUserToVendor (login) [" + (error.code || "unknown") + "]", error);
        throw new Error("Mot de passe incorrect pour ce compte existant.");
    }

    const user = userCredential.user;
    const uid = user.uid;

    const profileStatus = await getUserProfileStatus(uid);
    if (!profileStatus.exists) {
        throw new Error("Profil introuvable.");
    }
    if (profileStatus.data.role === ROLES.VENDOR) {
        throw new Error("Ce compte est déjà un compte vendeur.");
    }
    if (profileStatus.data.role === ROLES.ADMIN) {
        throw new Error("Un administrateur ne peut pas devenir vendeur.");
    }

    const shopName = (vendorData.shopName || "").trim();
    const city = (vendorData.city || "").trim();
    const iceCin = (vendorData.iceCin || "").trim().toUpperCase();

    if (shopName.length < 2 || shopName.length > 60) throw new Error("Nom de boutique invalide.");
    if (city.length < 2 || city.length > 80) throw new Error("Ville invalide.");
    if (!(/^\d{15}$/.test(iceCin) || /^[A-Z]{1,2}\d{5,6}$/.test(iceCin) || /^\d{6,8}$/.test(iceCin))) {
        throw new Error("ICE ou CIN invalide.");
    }
    if (!["dropoff", "fulfillment"].includes(vendorData.shippingMethod)) {
        throw new Error("Mode de livraison invalide.");
    }

    try {
        const existingQ = query(
            collection(db, "vendor_conversion_requests"),
            where("userId", "==", uid),
            where("status", "==", "pending"),
            limit(1)
        );
        const existing = await getDocs(existingQ);
        if (!existing.empty) {
            throw new Error("Vous avez déjà une demande de conversion en cours d'examen.");
        }
    } catch (e) {
        if (e && e.message && e.message.includes("déjà une demande")) {
            throw e;
        }
        logAuthError("convertUserToVendor (check existing)", e);
    }

    try {
        await addDoc(collection(db, "vendor_conversion_requests"), {
            userId: uid,
            shopName,
            iceCin,
            city,
            shippingMethod: vendorData.shippingMethod,
            phone: vendorData.phone || "",
            status: "pending",
            createdAt: serverTimestamp()
        });
    } catch (e) {
        logAuthError("convertUserToVendor (create request) [" + (e.code || "unknown") + "]", e);
        throw new Error("Impossible d'enregistrer votre demande de conversion. Contactez le support.");
    }

    return { success: true, uid, isConversionRequest: true };
}

/* ============================================================
   RENVOYER L'EMAIL DE VÉRIFICATION
   ============================================================ */
export async function resendVerificationEmail() {
    const user = auth.currentUser;
    if (!user) {
        showToast("Aucun utilisateur connecté");
        return false;
    }
    if (user.emailVerified) {
        showToast("Votre email est déjà vérifié");
        return false;
    }
    try {
        await sendEmailVerification(user, {
            url: `${CONFIG.SHOP.URL}/`,
            handleCodeInApp: false
        });
        showToast("Email de vérification renvoyé");
        return true;
    } catch (error) {
        logAuthError("resendVerificationEmail", error);
        if (error.code === "auth/too-many-requests") {
            showToast("Trop de demandes, attendez quelques minutes");
        } else {
            showToast(t("error"));
        }
        return false;
    }
}

/* ============================================================
   VÉRIFIER SI L'EMAIL EST CONFIRMÉ
   ============================================================ */
export async function checkEmailVerification() {
    const user = auth.currentUser;
    if (!user) return false;
    try {
        await reload(user);
        const verified = auth.currentUser?.emailVerified || false;
        if (verified && user.uid) {
            await saveUserProfile(user.uid, { emailVerified: true });
            const currentUser = getCurrentUser();
            if (currentUser) {
                currentUser.emailVerified = true;
                currentUser.needsVerification = false;
                setCurrentUser(currentUser);
            }
        }
        return verified;
    } catch (error) {
        logAuthError("checkEmailVerification", error);
        return false;
    }
}

/* ============================================================
   GOOGLE & FACEBOOK SIGN-IN
   ============================================================ */
export async function loginWithGoogle() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });

    try {
        const result = await signInWithPopup(auth, provider);
        const user = result.user;
        const uid = user.uid;

        let profile = await getUserProfile(uid);
        let isNewUser = false;

        if (!profile) {
            isNewUser = true;
            profile = {
                name: user.displayName || (user.email ? user.email.split("@")[0] : "Utilisateur"),
                firstName: (user.displayName || "").split(" ")[0] || "",
                lastName: (user.displayName || "").split(" ").slice(1).join(" ") || "",
                email: cleanEmail(user.email),
                phone: "",
                dob: "",
                photoURL: user.photoURL || "",
                role: ROLES.USER,
                signupMethod: SIGNUP_METHODS.GOOGLE,
                emailVerified: true,
                addresses: [],
                favorites: [],
                notifications: [],
                createdAt: Timestamp.now()
            };
            await saveUserProfile(uid, profile);
        }

        setCurrentUser({ uid, email: user.email, ...profile, emailVerified: true, needsVerification: false });
        showToast(isNewUser ? "Bienvenue !" : t("loginSuccess"));
        return { uid, email: user.email, ...profile };
    } catch (error) {
        logAuthError("loginWithGoogle", error);
        if (error.code !== "auth/popup-closed-by-user" && error.code !== "auth/cancelled-popup-request") {
            showToast(getAuthErrorMessage(error, "social"));
        }
        return null;
    }
}

export async function loginWithFacebook() {
    const provider = new FacebookAuthProvider();
    provider.addScope("email");
    provider.setCustomParameters({ display: "popup" });

    try {
        const result = await signInWithPopup(auth, provider);
        const user = result.user;
        const uid = user.uid;

        let profile = await getUserProfile(uid);
        let isNewUser = false;

        if (!profile) {
            isNewUser = true;
            profile = {
                name: user.displayName || (user.email ? user.email.split("@")[0] : "Utilisateur"),
                firstName: (user.displayName || "").split(" ")[0] || "",
                lastName: (user.displayName || "").split(" ").slice(1).join(" ") || "",
                email: cleanEmail(user.email),
                phone: "",
                dob: "",
                photoURL: user.photoURL || "",
                role: ROLES.USER,
                signupMethod: SIGNUP_METHODS.FACEBOOK,
                emailVerified: true,
                addresses: [],
                favorites: [],
                notifications: [],
                createdAt: Timestamp.now()
            };
            await saveUserProfile(uid, profile);
        }

        setCurrentUser({ uid, email: user.email, ...profile, emailVerified: true, needsVerification: false });
        showToast(isNewUser ? "Bienvenue !" : t("loginSuccess"));
        return { uid, email: user.email, ...profile };
    } catch (error) {
        logAuthError("loginWithFacebook", error);
        if (error.code !== "auth/popup-closed-by-user" && error.code !== "auth/cancelled-popup-request") {
            showToast(getAuthErrorMessage(error, "social"));
        }
        return null;
    }
}

/* ============================================================
   CONNEXION
   ============================================================ */
export async function loginUser(email, password) {
    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const firebaseUser = userCredential.user;
        const uid = firebaseUser.uid;

        if (!firebaseUser.emailVerified) {
            console.log("Connexion bloquée : email non vérifié");

            try {
                await sendEmailVerification(firebaseUser, {
                    url: `${CONFIG.SHOP.URL}/`,
                    handleCodeInApp: false
                });
            } catch (e) {
                logAuthError("loginUser (renvoi email vérif)", e);
            }

            await signOut(auth);
            setUser(null);
            safeRemoveItem(CONFIG.STORAGE_KEYS.USER);

            return {
                success: false,
                reason: "email_not_verified",
                email: cleanEmail(email)
            };
        }

        let profile = await getUserProfile(uid);
        if (!profile) {
            profile = {
                name: email.split("@")[0],
                email: cleanEmail(email),
                role: ROLES.USER,
                signupMethod: SIGNUP_METHODS.OTP,
                emailVerified: true,
                favorites: [],
                addresses: [],
                notifications: []
            };
            await saveUserProfile(uid, profile);
        }

        setCurrentUser({
            uid,
            email,
            emailVerified: true,
            needsVerification: false,
            ...profile
        });

        return { success: true, user: getCurrentUser() };
    } catch (error) {
        logAuthError("loginUser", error);
        return {
            success: false,
            reason: error.code || "unknown",
            message: getAuthErrorMessage(error, "login")
        };
    }
}

/* ============================================================
   DÉCONNEXION
   ============================================================ */
export async function logoutUser() {
    try {
        await signOut(auth);
        setCurrentUser(null);
        safeRemoveItem(CONFIG.STORAGE_KEYS.USER);
        return true;
    } catch (e) {
        logAuthError("logoutUser", e);
        return false;
    }
}

/* ============================================================
   MOT DE PASSE OUBLIÉ & CHANGEMENT
   ============================================================ */
export async function requestPasswordReset(email) {
    try {
        await sendPasswordResetEmail(auth, email);
        return true;
    } catch (error) {
        logAuthError("requestPasswordReset", error);
        showToast(getAuthErrorMessage(error, "reset"));
        return false;
    }
}

export async function updateUserPassword(newPassword) {
    const user = auth.currentUser;
    if (!user) throw new Error("Aucun utilisateur connecté");
    await updatePassword(user, newPassword);
}

/* ============================================================
   LISTENER D'AUTHENTIFICATION
   ============================================================ */
let currentAuthUnsubscribe = null;

export function initAuthListener() {
    if (currentAuthUnsubscribe) {
        try { currentAuthUnsubscribe(); } catch (_) { /* ignore */ }
        currentAuthUnsubscribe = null;
    }

    currentAuthUnsubscribe = onAuthStateChanged(auth, async (user) => {
        if (user) {
            const isPasswordProvider = user.providerData?.[0]?.providerId === "password";
            const needsVerification = isPasswordProvider && !user.emailVerified;

            if (needsVerification) {
                const profile = await getUserProfile(user.uid);
                setCurrentUser({
                    uid: user.uid,
                    email: user.email,
                    emailVerified: false,
                    needsVerification: true,
                    ...(profile || {})
                });
            } else {
                const cached = getUser();
                if (cached && cached.uid === user.uid && cached.email === user.email && cached.role) {
                    console.log("Profil en cache");
                } else {
                    const profile = await getUserProfile(user.uid);
                    if (profile) {
                        setCurrentUser({
                            uid: user.uid,
                            email: user.email,
                            emailVerified: user.emailVerified,
                            needsVerification: false,
                            ...profile
                        });
                    } else {
                        setCurrentUser({
                            uid: user.uid,
                            email: user.email,
                            emailVerified: user.emailVerified,
                            needsVerification: false
                        });
                    }
                }
            }
        } else {
            setCurrentUser(null);
        }

        authReady = true;
        if (authReadyResolve) {
            authReadyResolve();
            authReadyResolve = null;
        }
    });

    return currentAuthUnsubscribe;
}

/* ============================================================
   IDLE TIMER
   ============================================================ */
let idleTimer = null;
let lastActivity = Date.now();
let idleListeners = [];

function startIdleTimer() {
    stopIdleTimer();
    lastActivity = Date.now();

    const resetActivity = () => { lastActivity = Date.now(); };
    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    events.forEach(evt => document.addEventListener(evt, resetActivity, { passive: true }));
    idleListeners = events.map(evt => [evt, resetActivity]);

    idleTimer = setInterval(async () => {
        if (getCurrentUser() && (Date.now() - lastActivity > CONFIG.SESSION.IDLE_TIMEOUT)) {
            await logoutUser();
            showToast(t("inactivityLogout"));
        }
    }, 60000);
}

function stopIdleTimer() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
    idleListeners.forEach(([evt, fn]) => document.removeEventListener(evt, fn));
    idleListeners = [];
}

/* ============================================================
   RÔLE ADMIN
   ============================================================ */
export function isUserAdmin() {
    const user = getCurrentUser();
    return !!(user && user.role === ROLES.ADMIN);
}

export async function isUserAdminVerified() {
    const cached = getCurrentUser();
    if (!cached || !cached.uid) return false;
    try {
        const profile = await getUserProfile(cached.uid);
        return !!(profile && profile.role === ROLES.ADMIN);
    } catch (e) {
        console.warn("Vérification admin impossible");
        return false;
    }
}

/* ============================================================
   RESTAURER LA SESSION
   ============================================================ */
export function restoreSession() {
    try {
        const saved = safeGetItem(CONFIG.STORAGE_KEYS.USER);
        if (saved && saved.uid) {
            setCurrentUser({ ...saved, _fromCache: true });
        }
    } catch (e) {
        console.warn("Erreur restauration session");
    }
}

/* ============================================================
   LOG
   ============================================================ */
console.log("✅ auth.js chargé - v9.2.0 (Lot 51 : wallet à l'approbation + upgrade via conversion request)");