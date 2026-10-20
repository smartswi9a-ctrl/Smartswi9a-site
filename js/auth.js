// js/auth.js
// ============================================================
// AUTHENTIFICATION - SMART SWI9A
// Version 3.0.0 — Fix C10.1 (ne plus signOut après signup)
// ============================================================
// CHANGEMENTS v3.0.0 :
// ✅ C10.1 — registerWithFirebase : garde connecté (needsVerification)
// ✅ C10.1 — initAuthListener : garde non-vérifiés (pas de signOut forcé)
// ✅ Login : signOut conservé si non vérifié (sécurité)
// ✅ checkEmailVerification() : sync le store
// ✅ resendVerificationEmail() : marche maintenant (user connecté)
// ✅ Reset idle timer au logout
// ============================================================
// ⚠️ RÈGLE : Email vérifié requis AVANT login (via password).
//    Exception : après signup, user reste connecté avec needsVerification=true.
//    ui.js affiche la vue verify et permet de renvoyer l'email.
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
import { doc, setDoc, getDoc, Timestamp } from "firebase/firestore";
import { auth, db } from "./firebase.js";
import { CONFIG, SIGNUP_METHODS } from "./config.js";
import {
    t, safeGetItem, safeSetItem, safeRemoveItem,
    isValidEmail, cleanEmail
} from "./utils.js";
import { setUser, getUser } from "./store.js";
import { showToast } from "./ui-core.js";

// ============================================================
// ÉTAT GLOBAL
// ============================================================
let pendingRegistration = null;
let pendingPassword = null;

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

export function setCurrentUser(user) {
    setUser(user);
    if (user) {
        safeSetItem(CONFIG.STORAGE_KEYS.USER, user);
        // ✅ Ne démarrer le timer que si l'utilisateur est vérifié
        if (user.emailVerified !== false && !user.needsVerification) {
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
        if (code === 'auth/weak-password') return '⚠️ Mot de passe trop faible (min 6 caractères)';
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
// ✅ C10.1 : INSCRIPTION FIREBASE
// ------------------------------------------------------------
// CHANGEMENT MAJEUR : on NE FAIT PLUS signOut après inscription.
// L'utilisateur reste connecté mais marqué needsVerification=true.
// → ui.js affiche la vue verify et permet de renvoyer l'email.
// → L'idle timer n'est PAS démarré tant que non vérifié.
// → Les features critiques (dashboard) affichent la vue verify.
// ============================================================
export async function registerWithFirebase(name, email, phone, dob, password) {
    console.log('📝 Inscription Firebase pour :', email);

    // Validations
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
        // 1. Créer le compte dans Firebase Auth
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        const uid = user.uid;

        // 2. Préparer le profil
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
            role: 'user',
            signupMethod: SIGNUP_METHODS.OTP,
            emailVerified: false,
            addresses: [],
            favorites: [],
            notifications: [],
            createdAt: Timestamp.now()
        };

        // 3. Sauvegarder dans Firestore
        await saveUserProfile(uid, profile);

        // 4. Envoyer l'email de vérification
        try {
            await sendEmailVerification(user, {
                url: `${CONFIG.SHOP.URL}/`,
                handleCodeInApp: false
            });
            console.log('📧 Email de vérification envoyé');
        } catch (e) {
            console.warn('⚠️ Erreur envoi email vérif :', e);
        }

        // 5. ✅ C10.1 : GARDER CONNECTÉ avec needsVerification
        setCurrentUser({
            uid,
            email: cleanEmail(email),
            emailVerified: false,
            needsVerification: true,
            ...profile
        });
        console.log('✅ Inscription Firebase réussie — email de vérification envoyé (user connecté)');

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
// RENVOYER L'EMAIL DE VÉRIFICATION (utilisateur connecté)
// ------------------------------------------------------------
// ✅ C10.1 : fonctionne maintenant car le user reste connecté
// ============================================================
export async function resendVerificationEmail() {
    const user = auth.currentUser;
    if (!user) {
        showToast('⚠️ Aucun utilisateur connecté — connectez-vous pour renvoyer l\'email');
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
// RENVOYER LE LIEN POUR UN EMAIL NON CONNECTÉ
// ------------------------------------------------------------
// Utilisé par loginUser quand l'email n'est pas vérifié :
// on signIn temporairement pour envoyer, puis signOut.
// ============================================================
export async function resendVerificationForEmail(email, password) {
    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        if (user.emailVerified) {
            await signOut(auth);
            return { success: false, reason: 'already_verified' };
        }

        await sendEmailVerification(user, {
            url: `${CONFIG.SHOP.URL}/`,
            handleCodeInApp: false
        });

        await signOut(auth);
        setUser(null);
        safeRemoveItem(CONFIG.STORAGE_KEYS.USER);

        console.log('📧 Lien de vérification renvoyé pour :', email);
        return { success: true };

    } catch (error) {
        console.error('❌ Erreur renvoi pour email :', error);
        return { success: false, error: error.code };
    }
}

// ============================================================
// VÉRIFIER SI L'EMAIL EST CONFIRMÉ
// ------------------------------------------------------------
// Recharge le user Firebase + met à jour le store si vérifié.
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
            // Vérifié → démarrer le timer idle
            startIdleTimer();
        }
        return verified;
    } catch (error) {
        console.error('❌ Erreur vérification :', error);
        return false;
    }
}

// ============================================================
// GOOGLE SIGN-IN (toujours vérifié)
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
                role: 'user',
                signupMethod: SIGNUP_METHODS.GOOGLE,
                emailVerified: true,
                addresses: [],
                favorites: [],
                notifications: [],
                createdAt: Timestamp.now()
            };
            await saveUserProfile(uid, profile);
            console.log('✅ Nouveau compte Google :', uid);
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

// ============================================================
// FACEBOOK SIGN-IN (toujours vérifié)
// ============================================================
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
                role: 'user',
                signupMethod: SIGNUP_METHODS.FACEBOOK,
                emailVerified: true,
                addresses: [],
                favorites: [],
                notifications: [],
                createdAt: Timestamp.now()
            };
            await saveUserProfile(uid, profile);
            console.log('✅ Nouveau compte Facebook :', uid);
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
// CONNEXION (avec vérification email OBLIGATOIRE)
// ------------------------------------------------------------
// Comportement conservé : si email non vérifié → signOut + return
// email_not_verified (l'utilisateur doit cliquer sur le lien reçu
// par email). C'est le SEUL cas où on signOut un utilisateur valide.
// ============================================================
export async function loginUser(email, password) {
    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const firebaseUser = userCredential.user;
        const uid = firebaseUser.uid;

        // ✅ VÉRIFICATION EMAIL OBLIGATOIRE
        if (!firebaseUser.emailVerified) {
            console.log('⛔ Email non vérifié — connexion bloquée');

            // Renvoyer l'email automatiquement
            try {
                await sendEmailVerification(firebaseUser, {
                    url: `${CONFIG.SHOP.URL}/`,
                    handleCodeInApp: false
                });
                console.log('📧 Nouveau lien de vérification renvoyé');
            } catch (e) {
                console.warn('⚠️ Impossible de renvoyer le lien :', e);
            }

            await signOut(auth);
            setUser(null);
            safeRemoveItem(CONFIG.STORAGE_KEYS.USER);

            return {
                success: false,
                reason: 'email_not_verified',
                email: cleanEmail(email)
            };
        }

        // ✅ Email vérifié → connexion autorisée
        let profile = await getUserProfile(uid);
        if (!profile) {
            profile = {
                name: email.split('@')[0],
                email: cleanEmail(email),
                role: 'user',
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
// MOT DE PASSE OUBLIÉ
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

// ============================================================
// CHANGER LE MOT DE PASSE
// ============================================================
export async function updateUserPassword(newPassword) {
    const user = auth.currentUser;
    if (!user) throw new Error('Aucun utilisateur connecté');
    await updatePassword(user, newPassword);
}

// ============================================================
// ✅ C10.1 : LISTENER D'AUTHENTIFICATION
// ------------------------------------------------------------
// CHANGEMENT : on NE SIGNOUT PLUS les non-vérifiés.
// → L'utilisateur reste connecté avec needsVerification=true.
// → ui.js affiche la vue verify et permet de renvoyer l'email.
// → L'idle timer ne démarre PAS tant que non vérifié.
// ============================================================
export function initAuthListener() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const isPasswordProvider = user.providerData?.[0]?.providerId === 'password';
            const needsVerification = isPasswordProvider && !user.emailVerified;

            if (needsVerification) {
                console.log('📧 User password non vérifié — connecté avec needsVerification');

                // Charger le profil pour les données affichage
                const profile = await getUserProfile(user.uid);
                setCurrentUser({
                    uid: user.uid,
                    email: user.email,
                    emailVerified: false,
                    needsVerification: true,
                    ...(profile || {})
                });
            } else {
                // Profil normal (vérifié ou social)
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
export function isUserAdmin() {
    const user = getCurrentUser();
    return user && user.role === 'admin';
}

// ============================================================
// RESTAURER LA SESSION
// ============================================================
export function restoreSession() {
    try {
        const saved = safeGetItem(CONFIG.STORAGE_KEYS.USER);
        if (saved && saved.uid) {
            setCurrentUser(saved);
        }
    } catch (e) {
        console.warn('⚠️ Erreur restauration session :', e);
    }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ auth.js chargé — v3.0.0 (C10.1 fix : needsVerification)');