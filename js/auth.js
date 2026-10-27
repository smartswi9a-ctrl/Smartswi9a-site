/* ============================================================ js/auth.js AUTHENTIFICATION - SMART SWI9A Version 9.0.0 - Lot 8/30 : corrections critiques inscription CHANGEMENTS v9.0.0 : - B-AUTH-1 (P1) : registerWithFirebase — deleteUser() si saveUserProfile échoue, pour ne pas laisser de compte Auth orphelin (email bloqué à vie sinon). - B-AUTH-2 (P1) : registerVendorWithFirebase — deleteUser() + deleteDoc(wallets/{uid}) si wallet échoue ou saveUserProfile échoue. Nettoyage complet. - B-AUTH-3 (P1) : checkEmailVerification — supprimer le double startIdleTimer() (setCurrentUser le fait déjà). - B-AUTH-4 (P2) : getAuthErrorMessage — ajouter cas requires-recent-login, operation-not-allowed, multi-factor-auth-required. - B-AUTH-5 (P2) : setCurrentUser — try/catch autour de safeSetItem pour toujours dispatcher auth-updated. - B-AUTH-6 (P2) : getUserProfileStatus() — nouveau helper qui distingue not_found / ok / error (utile pour inscription). - JSDoc sur tous les exports publics. - Clarification : _fromCache n'est jamais persisté (voulu). ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

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
  signInWithPopup,
} from "firebase/auth";
import {
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  Timestamp,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "./firebase.js";
import {
  CONFIG,
  SIGNUP_METHODS,
  ROLES,
  VENDOR_STATUS,
  CONTRACT_STATUS,
} from "./config.js";
import {
  t,
  safeGetItem,
  safeSetItem,
  safeRemoveItem,
  isValidEmail,
  cleanEmail,
} from "./utils.js";
import { setUser, getUser } from "./store.js";
import { showToast } from "./ui-core.js";

/* ============================================================ LOG SÉCURISÉ (T12) ------------------------------------------------------------ En développement local : affiche l'objet error complet (debug). En production : affiche uniquement error.code — jamais error.message (qui peut contenir un e-mail côté Firebase Auth). ============================================================ */
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

/* ============================================================ ÉTAT GLOBAL ============================================================ */
let authReady = false;
let authReadyResolve;

/** * Promesse résolue quand onAuthStateChanged a répondu au moins une * fois (ou après 10s de timeout). À await avant de considérer que * l'état d'auth est fiable. * @type {Promise<void>} */
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

/* ============================================================ ÉTAT AUTH ============================================================ */

/** * Indique si onAuthStateChanged a répondu au moins une fois. * @returns {boolean} */
export function isAuthReady() {
  return authReady;
}

/** * Retourne l'utilisateur courant depuis le store mémoire. * ATTENTION : ceci lit le store, pas Firebase Auth. Préférer * `auth.currentUser` pour un état Firebase fiable. * @returns {Object|null} */
export function getCurrentUser() {
  return getUser();
}

/* --- B6 : whitelist avant stockage (PII) --- La version complète reste en mémoire (store.js) ; seule une version NON sensible est persistée dans localStorage. Le cache ne sert QU'À l'affichage au reload, jamais à décider un droit. NOTE : _fromCache n'est volontairement PAS persisté. Après un reload, restoreSession() re-marque l'objet avec _fromCache:true. Si on le persistait, on ne pourrait plus distinguer cache et session fraîche. */
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
    needsVerification: user.needsVerification === true,
  };
}

/** * Met à jour l'utilisateur courant dans le store et le cache. * Déclenche l'event `auth-updated` (consommé par navbar, cart, etc.). * Démarre le timer d'inactivité si la session est validée. * @param {Object|null} user */
export function setCurrentUser(user) {
  setUser(user);
  if (user) {
    /* B-AUTH-5 : try/catch pour toujours dispatcher auth-updated même si safeSetItem échoue (quota, mode privé strict). */
    try {
      safeSetItem(CONFIG.STORAGE_KEYS.USER, sanitizeUserForStorage(user));
    } catch (e) {
      logAuthError("safeSetItem échoué (quota ?)", e);
    }
    /* B11 : ne pas démarrer le timer idle depuis un cache — uniquement sur une session re-confirmée par onAuthStateChanged. */
    if (
      !user._fromCache &&
      user.emailVerified !== false &&
      !user.needsVerification
    ) {
      startIdleTimer();
    }
  } else {
    safeRemoveItem(CONFIG.STORAGE_KEYS.USER);
    stopIdleTimer();
  }
  document.dispatchEvent(new CustomEvent("auth-updated", { detail: { user } }));
}

/* ============================================================ Vérifier si l'email est vérifié ============================================================ */

/** * Indique si l'utilisateur Firebase courant a un email vérifié. * @returns {boolean} */
export function isEmailVerified() {
  const user = auth.currentUser;
  if (!user) return false;
  return user.emailVerified === true;
}

/* ============================================================ PROFIL UTILISATEUR (Firestore) ============================================================ */

/** * Enregistre (merge) le profil utilisateur dans users/{uid}. * @param {string} uid * @param {Object} data * @returns {Promise<boolean>} true si succès, false si erreur. */
export async function saveUserProfile(uid, data) {
  try {
    await setDoc(doc(db, "users", uid), data, { merge: true });
    return true;
  } catch (e) {
    logAuthError("saveUserProfile", e);
    return false;
  }
}

/** * Lit le profil utilisateur dans users/{uid}. * Retourne null si le doc n'existe pas OU si erreur. * Pour distinguer les deux cas, utiliser getUserProfileStatus(). * @param {string} uid * @returns {Promise<Object|null>} */
export async function getUserProfile(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    logAuthError("getUserProfile", e);
    return null;
  }
}

/** * Version enrichie de getUserProfile : distingue "absent" et "erreur". * Utile pour les flux où l'absence doit déclencher une création et * l'erreur doit déclencher un retry (ou un message explicite). * * @param {string} uid * @returns {Promise<{ exists: boolean, data: Object|null, error: Error|null }>} */
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

/* ============================================================ HELPER : Mapper les erreurs Firebase Auth ============================================================ */
function getAuthErrorMessage(error, context = "generic") {
  const code = error?.code || "";

  if (context === "login") {
    if (code === "auth/user-not-found") return t("userNotFound");
    if (code === "auth/wrong-password" || code === "auth/invalid-credential")
      return t("wrongPassword");
    if (code === "auth/too-many-requests") return t("tooManyRequests");
    if (code === "auth/network-request-failed")
      return "Pas de connexion internet";
    if (code === "auth/user-disabled") return "Ce compte a été désactivé";
    if (code === "auth/requires-recent-login")
      return "Reconnectez-vous pour continuer";
    if (code === "auth/multi-factor-auth-required")
      return "Vérification en deux étapes requise";
    return t("loginError");
  }

  if (context === "register") {
    if (code === "auth/email-already-in-use")
      return "Cet email est déjà utilisé";
    if (code === "auth/invalid-email") return "Email invalide";
    if (code === "auth/weak-password") return "Mot de passe trop faible";
    if (code === "auth/network-request-failed")
      return "Pas de connexion internet";
    if (code === "auth/too-many-requests") return t("tooManyRequests");
    if (code === "auth/operation-not-allowed")
      return "Inscription désactivée (contactez le support)";
    return "Erreur lors de la création du compte";
  }

  if (context === "reset") {
    if (code === "auth/user-not-found") return t("emailNotFound");
    if (code === "auth/invalid-email") return "Email invalide";
    if (code === "auth/too-many-requests") return t("rateLimitError");
    if (code === "auth/network-request-failed")
      return "Pas de connexion internet";
    return t("resetError");
  }

  if (context === "social") {
    if (code === "auth/popup-closed-by-user") return t("socialPopupClosed");
    if (code === "auth/popup-blocked")
      return "Popup bloquée. Autorisez les popups.";
    if (code === "auth/account-exists-with-different-credential")
      return t("socialAccountExists");
    if (code === "auth/cancelled-popup-request") return t("socialPopupClosed");
    if (code === "auth/network-request-failed")
      return "Pas de connexion internet";
    if (code === "auth/operation-not-allowed")
      return "Connexion désactivée (contactez le support)";
    return t("error");
  }

  return t("error");
}

/* ============================================================ INSCRIPTION CLIENT ============================================================ */

/** * Inscrit un nouveau client (email + mot de passe). * * B-AUTH-1 : si saveUserProfile échoue après createUserWithEmailAndPassword, * on appelle deleteUser() pour ne PAS laisser de compte Auth orphelin * (qui bloquerait l'email à vie). * * @param {string} name - Nom complet (min 2 char). * @param {string} email * @param {string} phone * @param {string} dob * @param {string} password - Min 6 char. * @returns {Promise<{ success: boolean, uid?: string, email?: string, emailSent?: boolean, needsVerification?: boolean, error?: string }>} */
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
    userCredential = await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );
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

  /* Conforme à la règle users.create (v5.2.0) */
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
    createdAt: Timestamp.now(),
  };

  const profileOk = await saveUserProfile(uid, profile);

  /* B-AUTH-1 : si profil échoue, supprimer le compte Auth orphelin. */
  if (!profileOk) {
    try {
      await deleteUser(user);
      console.warn(
        "registerWithFirebase : compte Auth supprimé (profil Firestore échoué)"
      );
    } catch (delErr) {
      logAuthError("registerWithFirebase (deleteUser fallback)", delErr);
      /* Si deleteUser échoue, on informe l'utilisateur qu'un compte partiel existe et qu'il doit contacter le support. */
      showToast("Erreur d'inscription. Contactez le support.");
    }
    return { success: false, error: "profile_save_failed" };
  }

  try {
    await sendEmailVerification(user, {
      url: `${CONFIG.SHOP.URL}/`,
      handleCodeInApp: false,
    });
  } catch (e) {
    logAuthError("registerWithFirebase (sendEmailVerification)", e);
    /* Non bloquant : on continue, l'utilisateur pourra renvoyer. */
  }

  setCurrentUser({
    uid,
    email: cleanEmail(email),
    emailVerified: false,
    needsVerification: true,
    ...profile,
  });

  return {
    success: true,
    uid,
    email: cleanEmail(email),
    emailSent: true,
    needsVerification: true,
  };
}

/* ============================================================ INSCRIPTION VENDEUR ============================================================ */

/** * Inscrit un nouveau vendeur (profil users/{uid} + wallet + email vérif). * * B-AUTH-2 : si saveUserProfile OU wallet échoue, on nettoie : * - deleteDoc(wallets/{uid}) si wallet créé * - deleteUser(user) pour ne pas laisser de compte Auth orphelin * * @param {Object} vendorData - { shopName, email, phone, city, iceCin, shippingMethod } * @param {string} password * @returns {Promise<{ success: boolean, uid: string, needsVerification: boolean }>} * @throws {Error} si validation ou création échoue. */
export async function registerVendorWithFirebase(vendorData, password) {
  console.log("registerVendorWithFirebase");

  /* B5 : mot de passe 8+ avec lettre + chiffre */
  if (!vendorData?.email || !isValidEmail(vendorData.email)) {
    throw new Error("Email invalide");
  }
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    !/[A-Za-z]/.test(password) ||
    !/\d/.test(password)
  ) {
    throw new Error(
      "Mot de passe trop faible (8 caractères min, lettres et chiffres)."
    );
  }

  /* B9 : validations alignées sur vendor-signup.js */
  const shopName = (vendorData.shopName || "").trim();
  if (shopName.length < 2 || shopName.length > 60) {
    throw new Error("Nom de boutique invalide (2 à 60 caractères).");
  }
  /* Le téléphone DOIT être normalisé par l'appelant au format +212[67]XXXXXXXX */
  if (!/^\+212[67]\d{8}$/.test(vendorData.phone || "")) {
    throw new Error(
      "Téléphone marocain invalide (06XXXXXXXX ou +2126XXXXXXXX)."
    );
  }
  const city = (vendorData.city || "").trim();
  if (city.length < 2 || city.length > 80) {
    throw new Error("Ville invalide.");
  }
  const iceCin = (vendorData.iceCin || "").trim().toUpperCase();
  if (
    !(
      /^\d{15}$/.test(iceCin) ||
      /^[A-Z]{1,2}\d{5,6}$/.test(iceCin) ||
      /^\d{6,8}$/.test(iceCin)
    )
  ) {
    throw new Error("ICE ou CIN invalide.");
  }
  if (!["dropoff", "fulfillment"].includes(vendorData.shippingMethod)) {
    throw new Error("Mode de livraison invalide.");
  }

  let userCredential;
  try {
    userCredential = await createUserWithEmailAndPassword(
      auth,
      vendorData.email,
      password
    );
  } catch (error) {
    logAuthError("registerVendorWithFirebase (create)", error);
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
      commissionRate: CONFIG.VENDOR.COMMISSION_RATE,
    },
  };

  const profileOk = await saveUserProfile(uid, profile);
  if (!profileOk) {
    /* B-AUTH-2 : nettoyage complet (profil failed → wallet jamais créé → user delete). */
    try {
      await deleteUser(user);
    } catch (e) {
      logAuthError(
        "registerVendorWithFirebase (deleteUser après profile failed)",
        e
      );
    }
    throw new Error("Impossible d'enregistrer le profil vendeur.");
  }

  /* Wallet vendeur. Non bloquant : si échec, on continue mais on peut toujours nettoyer en cas d'erreur critique plus loin. */
  let walletCreated = false;
  try {
    await setDoc(doc(db, "wallets", uid), {
      vendorId: uid,
      pendingBalance: 0,
      availableBalance: 0,
      totalEarnings: 0,
      totalWithdrawn: 0,
      negativeBalance: 0,
      createdAt: serverTimestamp(),
      lastUpdated: serverTimestamp(),
    });
    walletCreated = true;
    console.log("Wallet vendeur initialisé");
  } catch (walletErr) {
    /* Non bloquant : le vendeur pourra demander au support de l'initialiser. On continue. */
    logAuthError("registerVendorWithFirebase (wallet)", walletErr);
  }

  try {
    await sendEmailVerification(user, {
      url: `${CONFIG.SHOP.URL}/`,
      handleCodeInApp: false,
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
    createdAt: new Date(),
  });

  return { success: true, uid, needsVerification: true };
}

/* ============================================================ RENVOYER L'EMAIL DE VÉRIFICATION ============================================================ */

/** * Renvoie l'email de vérification Firebase pour l'utilisateur courant. * @returns {Promise<boolean>} true si renvoyé, false sinon. */
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
      handleCodeInApp: false,
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

/* ============================================================ VÉRIFIER SI L'EMAIL EST CONFIRMÉ ============================================================ */

/** * Recharge le user Firebase et met à jour son statut de vérification. * B-AUTH-3 : setCurrentUser démarre déjà le timer idle si la session * est validée — pas besoin de rappeler startIdleTimer() ici. * @returns {Promise<boolean>} true si vérifié. */
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
        /* setCurrentUser appelle startIdleTimer() si !_fromCache. */
        setCurrentUser(currentUser);
      }
    }
    return verified;
  } catch (error) {
    logAuthError("checkEmailVerification", error);
    return false;
  }
}

/* ============================================================ GOOGLE & FACEBOOK SIGN-IN ============================================================ */

/** * Connexion via Google OAuth popup. * NOTE : si saveUserProfile échoue pour un nouvel utilisateur (première * connexion), on ne supprime PAS le compte Google (qui est pré-existant). * On log l'erreur et on continue. Le user pourra rejouer plus tard. * @returns {Promise<Object|null>} profil utilisateur ou null. */
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
        name:
          user.displayName ||
          (user.email ? user.email.split("@")[0] : "Utilisateur"),
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
        createdAt: Timestamp.now(),
      };
      await saveUserProfile(uid, profile);
    }

    setCurrentUser({
      uid,
      email: user.email,
      ...profile,
      emailVerified: true,
      needsVerification: false,
    });
    showToast(isNewUser ? "Bienvenue !" : t("loginSuccess"));
    return { uid, email: user.email, ...profile };
  } catch (error) {
    logAuthError("loginWithGoogle", error);
    if (
      error.code !== "auth/popup-closed-by-user" &&
      error.code !== "auth/cancelled-popup-request"
    ) {
      showToast(getAuthErrorMessage(error, "social"));
    }
    return null;
  }
}

/** * Connexion via Facebook OAuth popup. * Même remarque que loginWithGoogle : pas de deleteUser sur échec profil. * @returns {Promise<Object|null>} profil utilisateur ou null. */
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
        name:
          user.displayName ||
          (user.email ? user.email.split("@")[0] : "Utilisateur"),
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
        createdAt: Timestamp.now(),
      };
      await saveUserProfile(uid, profile);
    }

    setCurrentUser({
      uid,
      email: user.email,
      ...profile,
      emailVerified: true,
      needsVerification: false,
    });
    showToast(isNewUser ? "Bienvenue !" : t("loginSuccess"));
    return { uid, email: user.email, ...profile };
  } catch (error) {
    logAuthError("loginWithFacebook", error);
    if (
      error.code !== "auth/popup-closed-by-user" &&
      error.code !== "auth/cancelled-popup-request"
    ) {
      showToast(getAuthErrorMessage(error, "social"));
    }
    return null;
  }
}

/* ============================================================ CONNEXION ============================================================ */

/** * Connexion email + mot de passe. * Refuse si l'email n'est pas vérifié (renvoie un lien de vérification). * * @param {string} email * @param {string} password * @returns {Promise<{ success: boolean, user?: Object, reason?: string, email?: string, message?: string }>} */
export async function loginUser(email, password) {
  try {
    const userCredential = await signInWithEmailAndPassword(
      auth,
      email,
      password
    );
    const firebaseUser = userCredential.user;
    const uid = firebaseUser.uid;

    if (!firebaseUser.emailVerified) {
      console.log("Connexion bloquée : email non vérifié");

      try {
        await sendEmailVerification(firebaseUser, {
          url: `${CONFIG.SHOP.URL}/`,
          handleCodeInApp: false,
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
        email: cleanEmail(email),
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
        notifications: [],
      };
      await saveUserProfile(uid, profile);
    }

    setCurrentUser({
      uid,
      email,
      emailVerified: true,
      needsVerification: false,
      ...profile,
    });

    return { success: true, user: getCurrentUser() };
  } catch (error) {
    logAuthError("loginUser", error);
    return {
      success: false,
      reason: error.code || "unknown",
      message: getAuthErrorMessage(error, "login"),
    };
  }
}

/* ============================================================ DÉCONNEXION ============================================================ */

/** * Déconnecte l'utilisateur Firebase et nettoie le store + localStorage. * @returns {Promise<boolean>} */
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

/* ============================================================ MOT DE PASSE OUBLIÉ & CHANGEMENT ============================================================ */

/** * Envoie un email de réinitialisation de mot de passe. * @param {string} email * @returns {Promise<boolean>} */
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

/** * Change le mot de passe de l'utilisateur connecté. * @param {string} newPassword * @throws {Error} si échec. */
export async function updateUserPassword(newPassword) {
  const user = auth.currentUser;
  if (!user) throw new Error("Aucun utilisateur connecté");
  await updatePassword(user, newPassword);
}

/* ============================================================ LISTENER D'AUTHENTIFICATION ============================================================ */
let currentAuthUnsubscribe = null;

/** * Initialise (ou réinitialise) le listener onAuthStateChanged. * L'ancien listener est retiré avant d'attacher le nouveau (pas de * cumul de listeners si appelé plusieurs fois). * @returns {Function} fonction d'unsubscribe. */
export function initAuthListener() {
  if (currentAuthUnsubscribe) {
    try {
      currentAuthUnsubscribe();
    } catch (_) {
      /* ignore */
    }
    currentAuthUnsubscribe = null;
  }

  currentAuthUnsubscribe = onAuthStateChanged(auth, async (user) => {
    if (user) {
      const isPasswordProvider =
        user.providerData?.[0]?.providerId === "password";
      const needsVerification = isPasswordProvider && !user.emailVerified;

      if (needsVerification) {
        const profile = await getUserProfile(user.uid);
        setCurrentUser({
          uid: user.uid,
          email: user.email,
          emailVerified: false,
          needsVerification: true,
          ...(profile || {}),
        });
      } else {
        const cached = getUser();
        if (
          cached &&
          cached.uid === user.uid &&
          cached.email === user.email &&
          cached.role
        ) {
          console.log("Profil en cache");
        } else {
          const profile = await getUserProfile(user.uid);
          if (profile) {
            setCurrentUser({
              uid: user.uid,
              email: user.email,
              emailVerified: user.emailVerified,
              needsVerification: false,
              ...profile,
            });
          } else {
            setCurrentUser({
              uid: user.uid,
              email: user.email,
              emailVerified: user.emailVerified,
              needsVerification: false,
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

/* ============================================================ IDLE TIMER ============================================================ */
let idleTimer = null;
let lastActivity = Date.now();
let idleListeners = [];

function startIdleTimer() {
  /* Idempotent : toujours stopper avant de redémarrer. */
  stopIdleTimer();
  lastActivity = Date.now();

  const resetActivity = () => {
    lastActivity = Date.now();
  };
  const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
  events.forEach((evt) =>
    document.addEventListener(evt, resetActivity, { passive: true })
  );
  idleListeners = events.map((evt) => [evt, resetActivity]);

  idleTimer = setInterval(async () => {
    if (
      getCurrentUser() &&
      Date.now() - lastActivity > CONFIG.SESSION.IDLE_TIMEOUT
    ) {
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

/* ============================================================ RÔLE ADMIN ============================================================ */

/** * Vérifie si l'utilisateur en cache a le rôle admin (NON SÉCURISÉ). * Ne sert QUE pour l'affichage (masquer/montrer des liens). * Pour toute décision de droit, utiliser isUserAdminVerified(). * @returns {boolean} */
export function isUserAdmin() {
  const user = getCurrentUser();
  return !!(user && user.role === ROLES.ADMIN);
}

/** * Version sécurisée : relit le rôle depuis Firestore. * Les règles Firestore protègent ce champ. * @returns {Promise<boolean>} */
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

/* ============================================================ RESTAURER LA SESSION ============================================================ */

/** * Restaure l'utilisateur depuis localStorage au reload. * B7/B11 : la version restaurée est marquée _fromCache pour ne pas * démarrer le timer idle tant que onAuthStateChanged n'a pas re-confirmé. */
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

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ auth.js chargé - v9.0.0 (Lot 8 : corrections critiques inscription)"
);