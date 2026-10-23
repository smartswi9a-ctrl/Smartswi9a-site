// js/auth.js
// ============================================================
// AUTHENTIFICATION - SMART SWI9A
// Version 3.3.0 — Marketplace + Vendor Signup (correctifs E8/E9/E14)
// ============================================================

import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    sendEmailVerification,
    onAuthStateChanged,
    signOut,
    updatePassword,
    reload,
    GoogleAuthProvider,
    FacebookAuthProvider,
    signInWithPopup
} from "firebase/auth";
import { doc, setDoc, getDoc, Timestamp, serverTimestamp } from "firebase/firestore";
import { auth, db } from "./firebase.js";
import { CONFIG, SIGNUP_METHODS, ROLES, VENDOR_STATUS, CONTRACT_STATUS } from "./config.js";
import {
    t, safeGetItem, safeSetItem, safeRemoveItem,
    isValidEmail, cleanEmail
} from "./utils.js";
import { setUser, getUser } from "./store.js";
import { showToast } from "./ui-core.js";

// ============================================================
// ÉTAT GLOBAL
// ============================================================
let authReady = false;
let authReadyResolve;

export const authReadyPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
        console.warn('⚠️ authReadyPromise résolue par timeout (10s)');
        resolve();
    }, 10000);
    authReadyResolve = () => {
        clearTimeout(timeout);
        resolve();
    };
});

// ============================================================
// ÉTAT AUTH
// ============================================================
export function isAuthReady() {
    return authReady;
}

export function getCurrentUser() {
    return getUser();
}

// --- B6 : whitelist avant stockage (PII) ---
// La version complète reste en mémoire (store.js) ; seule une version
// NON sensible est persistée dans localStorage. Le cache ne sert QUE
// à l'affichage au reload, jamais à décider un droit (cf. E8/A).
function sanitizeUserForStorage(user) {
    if (!user) return null;
    return {
        uid: user.uid || '',
        email: user.email || '',
        emailVerified: user.emailVerified === true,
        name: user.name || '',
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        role: user.role || ROLES.USER,
        signupMethod: user.signupMethod || '',
        photoURL: user.photoURL || '',
        needsVerification: user.needsVerification === true
    };
}

export function setCurrentUser(user) {
    // B6 : la mémoire garde la version complète
    setUser(user);
    if (user) {
        // B6 : seule la version whitelist va dans localStorage
        safeSetItem(CONFIG.STORAGE_KEYS.USER, sanitizeUserForStorage(user));
        // B11 : ne pas démarrer le timer idle depuis un cache (uniquement
        // sur une session re-confirmée par onAuthStateChanged)
        if (!user._fromCache && user.emailVerified !== false && !user.needsVerification) {
            startIdleTimer();
        }
    } else {
        safeRemoveItem(CONFIG.STORAGE_KEYS.USER);
        stopIdleTimer();
    }
    document.dispatchEvent(new CustomEvent('auth-updated', { detail: { user } }));
}

// ============================================================
// Vérifier si l'email est vérifié
// ============================================================
export function isEmailVerified() {
    const user = auth.currentUser;
    if (!user) return false;
    return user.emailVerified === true;
}

// ============================================================
// PROFIL UTILISATEUR (Firestore)
// ============================================================
export async function saveUserProfile(uid, data) {
    try {
        await setDoc(doc(db, "users", uid), data, { merge: true });
        return true;
    } catch (e) {
        console.error('❌ Erreur saveUserProfile :', e);
        return false;
    }
}

export async function getUserProfile(uid) {
    try {
        const snap = await getDoc(doc(db, "users", uid));
        return snap.exists() ? snap.data() : null;
    } catch (e) {
        console.error('❌ Erreur getUserProfile :', e);
        return null;
    }
}

// ============================================================
// HELPER : Mapper les erreurs Firebase Auth
// ============================================================
function getAuthErrorMessage(error, context = 'generic') {
    const code = error?.code || '';

    if (context === 'login') {
        if (code === 'auth/user-not-found') return t('userNotFound');
        if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') return t('wrongPassword');
        if (code === 'auth/too-many-requests') return t('tooManyRequests');
        if (code === 'auth/network-request-failed') return '⚠️ Pas de connexion internet';
        if (code === 'auth/user-disabled') return '⚠️ Ce compte a été désactivé';
        return t('loginError');
    }

    if (context === 'register') {
        if (code === 'auth/email-already-in-use') return '⚠️ Cet email est déjà utilisé';
        if (code === 'auth/invalid-email') return '⚠️ Email invalide';
        if (code === 'auth/weak-password') return '⚠️ Mot de passe trop faible';
        if (code === 'auth/network-request-failed') return '⚠️ Pas de connexion internet';
        if (code === 'auth/too-many-requests') return t('tooManyRequests');
        return '❌ Erreur lors de la création du compte';
    }

    if (context === 'reset') {
        if (code === 'auth/user-not-found') return t('emailNotFound');
        if (code === 'auth/invalid-email') return '⚠️ Email invalide';
        if (code === 'auth/too-many-requests') return t('rateLimitError');
        if (code === 'auth/network-request-failed') return '⚠️ Pas de connexion internet';
        return t('resetError');
    }

    if (context === 'social') {
        if (code === 'auth/popup-closed-by-user') return t('socialPopupClosed');
        if (code === 'auth/popup-blocked') return '⚠️ Popup bloquée. Autorisez les popups.';
        if (code === 'auth/account-exists-with-different-credential') return t('socialAccountExists');
        if (code === 'auth/cancelled-popup-request') return t('socialPopupClosed');
        if (code === 'auth/network-request-failed') return '⚠️ Pas de connexion internet';
        return t('error');
    }

    return t('error');
}

// ============================================================
// INSCRIPTION CLIENT
// (B12 : min 6 conservé pour ne pas casser la page client existante.
//  À passer à 8+ lors de la mise à jour de inscription.html — non traité ici.)
// ============================================================
export async function registerWithFirebase(name, email, phone, dob, password) {
    console.log('📝 Inscription Client pour :', email);

    if (!email || !isValidEmail(email)) {
        showToast('⚠️ Email invalide');
        return { success: false, error: 'invalid_email' };
    }
    if (!password || password.length < 6) {
        showToast('⚠️ Mot de passe trop faible (min 6 caractères)');
        return { success: false, error: 'weak_password' };
    }
    if (!name || name.trim().length < 2) {
        showToast('⚠️ Nom trop court');
        return { success: false, error: 'invalid_name' };
    }

    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        const uid = user.uid;

        const parts = name.trim().split(' ');
        const firstName = parts[0] || '';
        const lastName = parts.slice(1).join(' ') || '';

        const profile = {
            name: name.trim(),
            firstName,
            lastName,
            email: cleanEmail(email),
            phone: phone || '',
            dob: dob || '',
            role: ROLES.USER,
            signupMethod: SIGNUP_METHODS.OTP,
            emailVerified: false,
            addresses: [],
            favorites: [],
            notifications: [],
            createdAt: Timestamp.now()
        };

        await saveUserProfile(uid, profile);

        try {
            await sendEmailVerification(user, {
                url: `${CONFIG.SHOP.URL}/`,
                handleCodeInApp: false
            });
        } catch (e) {
            console.warn('⚠️ Erreur envoi email vérif :', e);
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

    } catch (error) {
        console.error('❌ Erreur inscription Firebase :', error);
        showToast(getAuthErrorMessage(error, 'register'));
        return { success: false, error: error.code || 'unknown' };
    }
}

// ============================================================
// INSCRIPTION VENDEUR
// Correctifs B1..B5 + B9 : validations renforcées, signupMethod VENDOR,
// contractStatus PENDING, serverTimestamp pour le wallet.
// ⚠️ Les champs role/status/contractStatus/commissionRate/delayCount
//    écrits ici DOIVENT être validés par les règles Firestore (étape 9).
// ============================================================
export async function registerVendorWithFirebase(vendorData, password) {
    console.log('🏪 Inscription Vendeur pour :', vendorData?.email);

    // --- B5 : mot de passe 8+ avec lettre + chiffre ---
    if (!vendorData?.email || !isValidEmail(vendorData.email)) {
        throw new Error("Email invalide");
    }
    if (
        typeof password !== 'string' ||
        password.length < 8 ||
        !/[A-Za-z]/.test(password) ||
        !/\d/.test(password)
    ) {
        throw new Error("Mot de passe trop faible (8 caractères min, lettres et chiffres).");
    }

    // --- B9 : validations alignées sur vendor-signup.js ---
    const shopName = (vendorData.shopName || '').trim();
    if (shopName.length < 2 || shopName.length > 60) {
        throw new Error("Nom de boutique invalide (2 à 60 caractères).");
    }
    // Le téléphone DOIT être normalisé par l'appelant au format +212[67]XXXXXXXX
    if (!/^\+212[67]\d{8}$/.test(vendorData.phone || '')) {
        throw new Error("Téléphone marocain invalide (06XXXXXXXX ou +2126XXXXXXXX).");
    }
    const city = (vendorData.city || '').trim();
    if (city.length < 2 || city.length > 80) {
        throw new Error("Ville invalide.");
    }
    const iceCin = (vendorData.iceCin || '').trim().toUpperCase();
    if (!(
        /^\d{15}$/.test(iceCin) ||              // ICE
        /^[A-Z]{1,2}\d{5,6}$/.test(iceCin) ||   // CIN courant
        /^\d{6,8}$/.test(iceCin)                // CIN numérique
    )) {
        throw new Error("ICE ou CIN invalide.");
    }
    if (!['dropoff', 'fulfillment'].includes(vendorData.shippingMethod)) {
        throw new Error("Mode de livraison invalide.");
    }

    try {
        // 1. Créer le compte dans Firebase Auth
        const userCredential = await createUserWithEmailAndPassword(auth, vendorData.email, password);
        const user = userCredential.user;
        const uid = user.uid;

        // 2. Préparer le profil vendeur
        // ⚠️ role / status / contractStatus / commissionRate / delayCount
        //    DOIVENT être imposés par les règles Firestore (E8).
        const profile = {
            name: shopName,
            email: cleanEmail(vendorData.email),
            phone: vendorData.phone,
            role: ROLES.VENDOR,
            signupMethod: SIGNUP_METHODS.VENDOR,          // B4 : plus OTP
            emailVerified: false,
            createdAt: serverTimestamp(),                 // B14
            vendorInfo: {
                shopName,
                iceCin,
                city,
                shippingMethod: vendorData.shippingMethod,
                status: VENDOR_STATUS.PENDING,
                // B2 : le contrat N'EST PAS encore signé à ce stade,
                // il le sera dans vendor-signup.js APRÈS cette fonction.
                contractStatus: CONTRACT_STATUS.PENDING,
                delayCount: 0,
                commissionRate: CONFIG.VENDOR.COMMISSION_RATE
            }
        };

        // 3. Enregistrer le profil dans Firestore
        const profileOk = await saveUserProfile(uid, profile);
        if (!profileOk) {
            throw new Error("Impossible d'enregistrer le profil vendeur.");
        }

        // 4. Initialiser le Wallet (B3 : montants à 0 — les règles imposent
        //    cette contrainte à la création, cf. étape 9).
        try {
            await setDoc(doc(db, "wallets", uid), {
                vendorId: uid,
                pendingBalance: 0,
                availableBalance: 0,
                totalEarnings: 0,
                totalWithdrawn: 0,
                negativeBalance: 0,
                createdAt: serverTimestamp(),
                lastUpdated: serverTimestamp()
            });
            console.log('✅ Wallet initialisé pour le vendeur :', uid);
        } catch (walletErr) {
            console.error('❌ Wallet non initialisé :', walletErr);
            // On ne bloque pas l'inscription : le dashboard affichera un état "wallet manquant",
            // et l'admin (ou un cron) pourra le créer. Étape 4 gérera ce cas.
        }

        // 5. Envoi email de vérification
        try {
            await sendEmailVerification(user, {
                url: `${CONFIG.SHOP.URL}/`,
                handleCodeInApp: false
            });
        } catch (e) {
            console.warn('⚠️ Erreur envoi email vérif :', e);
        }

        // 6. Connexion locale (memory). On remplace le sentinel serverTimestamp
        //    par une date locale pour l'affichage immédiat.
        setCurrentUser({
            uid,
            email: cleanEmail(vendorData.email),
            emailVerified: false,
            needsVerification: true,
            ...profile,
            createdAt: new Date()
        });

        return { success: true, uid, needsVerification: true };

    } catch (error) {
        console.error('❌ Erreur inscription vendeur :', error);
        throw error;
    }
}

// ============================================================
// RENVOYER L'EMAIL DE VÉRIFICATION
// ============================================================
export async function resendVerificationEmail() {
    const user = auth.currentUser;
    if (!user) {
        showToast('⚠️ Aucun utilisateur connecté');
        return false;
    }

    if (user.emailVerified) {
        showToast('ℹ️ Votre email est déjà vérifié');
        return false;
    }

    try {
        await sendEmailVerification(user, {
            url: `${CONFIG.SHOP.URL}/`,
            handleCodeInApp: false
        });
        showToast('📧 Email de vérification renvoyé');
        return true;
    } catch (error) {
        console.error('❌ Erreur renvoi vérification :', error);
        if (error.code === 'auth/too-many-requests') {
            showToast('⏳ Trop de demandes, attendez quelques minutes');
        } else {
            showToast('❌ ' + t('error'));
        }
        return false;
    }
}

// ============================================================
// VÉRIFIER SI L'EMAIL EST CONFIRMÉ
// ============================================================
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
            startIdleTimer();
        }
        return verified;
    } catch (error) {
        console.error('❌ Erreur vérification :', error);
        return false;
    }
}

// ============================================================
// GOOGLE & FACEBOOK SIGN-IN
// ============================================================
export async function loginWithGoogle() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    try {
        const result = await signInWithPopup(auth, provider);
        const user = result.user;
        const uid = user.uid;

        let profile = await getUserProfile(uid);
        let isNewUser = false;

        if (!profile) {
            isNewUser = true;
            profile = {
                name: user.displayName || (user.email ? user.email.split('@')[0] : 'Utilisateur'),
                firstName: (user.displayName || '').split(' ')[0] || '',
                lastName: (user.displayName || '').split(' ').slice(1).join(' ') || '',
                email: cleanEmail(user.email),
                phone: '',
                dob: '',
                photoURL: user.photoURL || '',
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
        showToast(isNewUser ? '🎉 Bienvenue !' : '👋 ' + t('loginSuccess'));
        return { uid, email: user.email, ...profile };

    } catch (error) {
        console.error('❌ Erreur Google :', error);
        if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
            showToast(getAuthErrorMessage(error, 'social'));
        }
        return null;
    }
}

export async function loginWithFacebook() {
    const provider = new FacebookAuthProvider();
    provider.addScope('email');
    provider.setCustomParameters({ display: 'popup' });

    try {
        const result = await signInWithPopup(auth, provider);
        const user = result.user;
        const uid = user.uid;

        let profile = await getUserProfile(uid);
        let isNewUser = false;

        if (!profile) {
            isNewUser = true;
            profile = {
                name: user.displayName || (user.email ? user.email.split('@')[0] : 'Utilisateur'),
                firstName: (user.displayName || '').split(' ')[0] || '',
                lastName: (user.displayName || '').split(' ').slice(1).join(' ') || '',
                email: cleanEmail(user.email),
                phone: '',
                dob: '',
                photoURL: user.photoURL || '',
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
        showToast(isNewUser ? '🎉 Bienvenue !' : '👋 ' + t('loginSuccess'));
        return { uid, email: user.email, ...profile };

    } catch (error) {
        console.error('❌ Erreur Facebook :', error);
        if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
            showToast(getAuthErrorMessage(error, 'social'));
        }
        return null;
    }
}

// ============================================================
// CONNEXION
// ============================================================
export async function loginUser(email, password) {
    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const firebaseUser = userCredential.user;
        const uid = firebaseUser.uid;

        if (!firebaseUser.emailVerified) {
            console.log('⛔ Email non vérifié — connexion bloquée');

            try {
                await sendEmailVerification(firebaseUser, {
                    url: `${CONFIG.SHOP.URL}/`,
                    handleCodeInApp: false
                });
            } catch (e) { }

            await signOut(auth);
            setUser(null);
            safeRemoveItem(CONFIG.STORAGE_KEYS.USER);

            return {
                success: false,
                reason: 'email_not_verified',
                email: cleanEmail(email)
            };
        }

        let profile = await getUserProfile(uid);
        if (!profile) {
            profile = {
                name: email.split('@')[0],
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

        return {
            success: true,
            user: getCurrentUser()
        };
    } catch (error) {
        console.error('❌ Erreur connexion :', error);
        return {
            success: false,
            reason: error.code || 'unknown',
            message: getAuthErrorMessage(error, 'login')
        };
    }
}

// ============================================================
// DÉCONNEXION
// ============================================================
export async function logoutUser() {
    try {
        await signOut(auth);
        setCurrentUser(null);
        safeRemoveItem(CONFIG.STORAGE_KEYS.USER);
        return true;
    } catch (e) {
        console.error('❌ Erreur logout :', e);
        return false;
    }
}

// ============================================================
// MOT DE PASSE OUBLIÉ & CHANGEMENT
// ============================================================
export async function requestPasswordReset(email) {
    try {
        await sendPasswordResetEmail(auth, email);
        return true;
    } catch (error) {
        console.error('❌ Erreur reset password :', error);
        showToast(getAuthErrorMessage(error, 'reset'));
        return false;
    }
}

// B15 : pas de validation de force ajoutée ici pour ne pas casser
// les flux de changement de mot de passe existants. À renforcer
// quand les pages de changement de mot de passe seront auditées.
export async function updateUserPassword(newPassword) {
    const user = auth.currentUser;
    if (!user) throw new Error('Aucun utilisateur connecté');
    await updatePassword(user, newPassword);
}

// ============================================================
// LISTENER D'AUTHENTIFICATION
// B10 : retourne désormais l'unsubscribe et annule l'ancien pour
// éviter le cumul de listeners si l'init est appelée plusieurs fois.
// ============================================================
let currentAuthUnsubscribe = null;

export function initAuthListener() {
    if (currentAuthUnsubscribe) {
        try { currentAuthUnsubscribe(); } catch (_) { /* ignore */ }
        currentAuthUnsubscribe = null;
    }

    currentAuthUnsubscribe = onAuthStateChanged(auth, async (user) => {
        if (user) {
            const isPasswordProvider = user.providerData?.[0]?.providerId === 'password';
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
                    console.log('✅ Profil en cache');
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

// ============================================================
// IDLE TIMER
// ============================================================
let idleTimer = null;
let lastActivity = Date.now();
let idleListeners = [];

function startIdleTimer() {
    stopIdleTimer();
    lastActivity = Date.now();

    const resetActivity = () => { lastActivity = Date.now(); };
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach(evt => document.addEventListener(evt, resetActivity, { passive: true }));
    idleListeners = events.map(evt => [evt, resetActivity]);

    idleTimer = setInterval(async () => {
        if (getCurrentUser() && (Date.now() - lastActivity > CONFIG.SESSION.IDLE_TIMEOUT)) {
            await logoutUser();
            showToast('👋 ' + t('inactivityLogout'));
        }
    }, 60000);
}

function stopIdleTimer() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
    idleListeners.forEach(([evt, fn]) => document.removeEventListener(evt, fn));
    idleListeners = [];
}

// ============================================================
// RÔLE ADMIN
// ============================================================

/**
 * ⚠️ NON SÉCURISÉ — lit le cache local (localStorage manipulable).
 * Ne doit servir QU'À l'affichage (masquer/montrer des liens).
 * Pour TOUTE décision de droit (accès admin.html, actions admin),
 * utiliser isUserAdminVerified() (async, relit Firestore).
 */
export function isUserAdmin() {
    const user = getCurrentUser();
    return !!(user && user.role === ROLES.ADMIN);
}

/**
 * Version sécurisée : relit le rôle depuis Firestore.
 * Les règles Firestore protègent ce champ (users/{uid}.role non modifiable
 * par le propriétaire — étape 9).
 */
export async function isUserAdminVerified() {
    const cached = getCurrentUser();
    if (!cached || !cached.uid) return false;
    try {
        const profile = await getUserProfile(cached.uid);
        return !!(profile && profile.role === ROLES.ADMIN);
    } catch (e) {
        console.warn('⚠️ Vérification admin impossible :', e);
        return false;
    }
}

// ============================================================
// RESTAURER LA SESSION
// B7/B11 : la version restaurée est marquée _fromCache pour ne pas
// démarrer le timer idle tant que onAuthStateChanged n'a pas re-confirmé.
// Le cache ne sert QUE pour l'affichage initial.
// ============================================================
export function restoreSession() {
    try {
        const saved = safeGetItem(CONFIG.STORAGE_KEYS.USER);
        if (saved && saved.uid) {
            setCurrentUser({ ...saved, _fromCache: true });
        }
    } catch (e) {
        console.warn('⚠️ Erreur restauration session :', e);
    }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ auth.js chargé — v3.3.0 (Marketplace)');