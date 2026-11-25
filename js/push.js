/* ============================================================
   js/push.js — FIREBASE CLOUD MESSAGING (WEB / PWA)
   ------------------------------------------------------------
   - Permission demandée sur action utilisateur (obligatoire).
   - getToken() avec la clé VAPID et le Service Worker unifié.
   - Enregistre fcm_tokens/{token} : uid, role
     (admin|seller|client), platform (web_browser|pwa_installed),
     ua, lang, active, updatedAt.
   - Synchronise au login, supprime au logout.
   - Message au premier plan → toast + rafraîchissement cloche.
   ============================================================ */

import {
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db, auth } from "./firebase.js";
import { onAuthStateChanged } from "firebase/auth";
import { getCurrentUser } from "./auth.js";
import { PWA_CONFIG } from "./config.js?v=2";
import { getSwRegistration, getPlatform, showPushCta } from "./pwa.js";
import { showToast } from "./ui-core.js";
import { t } from "./utils.js";

let messaging = null;
let messagingSdk = null;
let supported = null;
let currentToken = null;
let foregroundBound = false;
let authBound = false;
let gestureBound = false;
let syncInFlight = null;

/* ---------- Détection d'environnement (aucune erreur si non supporté) ---------- */

function pushSupported() {
  return typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator;
}

function isIosDevice() {
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints) > 1;
}

function isStandalone() {
  try {
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch (error) {
    /* matchMedia indisponible */
  }
  return navigator.standalone === true;
}

/**
 * iOS Safari HORS PWA : l'API Push n'existe pas avant installation sur
 * l'écran d'accueil. On n'y demande donc jamais la permission : on garde
 * l'invite d'installation, puis l'activation se fait au 1er toucher
 * une fois l'application ouverte.
 */
function iosNeedsInstall() {
  return isIosDevice() && !isStandalone();
}

function currentPermission() {
  if (!pushSupported()) return "unsupported";
  return Notification.permission || "default";
}

/**
 * Utilisateur réellement connecté (source Firebase Auth).
 * Sur /admin le store de ./auth.js n'est pas initialisé : getCurrentUser()
 * peut renvoyer null alors que auth.currentUser est rempli. On attend
 * authStateReady() pour couvrir un clic juste après la connexion.
 */
async function resolveAccount({ wait = true, timeoutMs = 6000 } = {}) {
  if (auth && auth.currentUser) return auth.currentUser;
  if (wait && auth && typeof auth.authStateReady === "function") {
    try {
      await Promise.race([
        auth.authStateReady(),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } catch (error) {
      /* non bloquant */
    }
  }
  if (auth && auth.currentUser) return auth.currentUser;
  return getCurrentUser();
}

/**
 * Chargement PARESSEUX du SDK messaging : un import statique casserait
 * tout app.js si l'importmap ne contient pas « firebase/messaging ».
 */
async function messagingApi() {
  if (!messagingSdk) messagingSdk = await import("firebase/messaging");
  return messagingSdk;
}

async function ensureMessaging() {
  if (messaging) return messaging;
  if (supported === false) return null;
  try {
    const api = await messagingApi();
    supported = await api.isSupported();
    if (!supported) return null;
    messaging = api.getMessaging();
    return messaging;
  } catch (error) {
    console.warn("[push] FCM indisponible :", error && error.message);
    supported = false;
    return null;
  }
}

/** Rôle stocké dans fcm_tokens : admin | seller | client. */
async function resolveRole(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    const role = snap.exists() ? String(snap.data().role || "user") : "user";
    if (role === "admin") return "admin";
    if (role === "vendor") return "seller";
    return "client";
  } catch (error) {
    return "client";
  }
}

async function saveToken(token, user, role) {
  await setDoc(
    doc(db, "fcm_tokens", token),
    {
      token,
      uid: user.uid,
      role,
      platform: getPlatform(),
      ua: (navigator.userAgent || "").slice(0, 220),
      lang: document.documentElement.getAttribute("lang") || "fr",
      active: true,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function forgetToken(token) {
  if (!token) return;
  try {
    await deleteDoc(doc(db, "fcm_tokens", token));
  } catch (error) {
    /* règle ou réseau : non bloquant */
  }
}

/**
 * Récupère un Service Worker utilisable pour FCM. Enregistre le SW unifié
 * si la page ne l'a pas encore fait (ex. /admin, qui ne charge pas app.js).
 */
async function ensureSwRegistration() {
  const known = getSwRegistration();
  if (known) return known;

  try {
    const existing = await navigator.serviceWorker.getRegistration("/");
    if (existing) return existing;
  } catch (error) {
    /* getRegistration indisponible */
  }

  try {
    return await navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
  } catch (error) {
    console.warn("[push] Service Worker indisponible :", error && error.message);
    return null;
  }
}

/** Récupère (ou renouvelle) le token et l'enregistre si un utilisateur est connu. */
async function registerToken({ user = null } = {}) {
  if (!pushSupported() || iosNeedsInstall()) return null;
  if (!PWA_CONFIG.VAPID_KEY) return null;
  if (Notification.permission !== "granted") return null;

  const msg = await ensureMessaging();
  if (!msg) return null;

  try {
    const registration = await ensureSwRegistration();
    const token = await (await messagingApi()).getToken(msg, {
      vapidKey: PWA_CONFIG.VAPID_KEY,
      ...(registration ? { serviceWorkerRegistration: registration } : {}),
    });
    if (!token) return null;
    currentToken = token;

    const account = user || (await resolveAccount({ wait: false }));
    if (account) {
      await saveToken(token, account, await resolveRole(account.uid));
    }
    return token;
  } catch (error) {
    console.warn("[push] token indisponible :", error && error.message);
    return null;
  }
}

/** Synchronisation silencieuse (permission déjà accordée), à chaque visite. */
export async function syncPushToken() {
  if (!pushSupported() || iosNeedsInstall()) return null;
  if (!PWA_CONFIG.VAPID_KEY) return null;
  if (Notification.permission !== "granted") return null;
  if (syncInFlight) return syncInFlight;

  syncInFlight = registerToken().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

/**
 * Activation. Appelée soit par le premier geste (silencieux), soit par un
 * bouton explicite. Ne lève jamais d'exception.
 */
export async function enablePush(options = {}) {
  const silent = options && options.silent === true;
  const notify = (message) => {
    if (!silent) showToast(message);
  };

  if (!pushSupported() || iosNeedsInstall()) {
    notify("Notifications non prises en charge sur cet appareil.");
    return { ok: false, error: "unsupported" };
  }
  if (!PWA_CONFIG.VAPID_KEY) {
    console.warn("[push] VAPID_KEY absente : push désactivé.");
    notify("Alertes bientôt disponibles sur cet appareil.");
    return { ok: false, error: "no_vapid" };
  }

  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch (error) {
      permission = "denied";
    }
  }
  if (permission !== "granted") {
    notify("Notifications refusées. Réactivez-les dans les réglages du navigateur.");
    return { ok: false, error: permission === "denied" ? "denied" : "dismissed" };
  }

  const token = await registerToken();
  if (!token) {
    notify("Impossible d'activer les alertes pour le moment.");
    return { ok: false, error: "token_error" };
  }
  notify("🔔 Alertes activées");
  document.dispatchEvent(new CustomEvent("smartswika:push-token", { detail: { token } }));
  return { ok: true, token };
}

async function bindForeground() {
  if (foregroundBound) return;
  const msg = await ensureMessaging();
  if (!msg) return;
  foregroundBound = true;

  (await messagingApi()).onMessage(msg, async (payload) => {
    const data = (payload && payload.data) || {};
    const title = data.title || "Smartswika";
    const body = data.body || "";
    showToast(body ? `${title} — ${body}` : title);
    try {
      const mod = await import("./notifications.js");
      await mod.loadNotifications?.();
    } catch (error) {
      /* non bloquant */
    }
    document.dispatchEvent(new CustomEvent("smartswika:push", { detail: data }));
  });
}

function bindAuth() {
  if (authBound) return;
  authBound = true;

  /* Source de vérité : Firebase Auth (fonctionne aussi sur /admin, qui
     n'initialise pas le store de ./auth.js). */
  try {
    onAuthStateChanged(auth, (user) => {
      if (user) syncPushToken();
    });
  } catch (error) {
    /* non bloquant */
  }

  document.addEventListener("auth-updated", async (event) => {
    const user = event.detail && event.detail.user;
    if (user) {
      await syncPushToken();
      return;
    }
    if (currentToken) {
      try {
        const msg = await ensureMessaging();
        if (msg) await (await messagingApi()).deleteToken(msg);
      } catch (error) {
        /* non bloquant */
      }
      await forgetToken(currentToken);
      currentToken = null;
    }
  });
}

/**
 * Activation AUTOMATIQUE au tout premier clic / toucher n'importe où.
 * Les navigateurs exigent un geste utilisateur : on l'utilise au lieu
 * d'attendre que l'utilisateur trouve un bouton.
 */
function autoPromptOnFirstGesture() {
  if (gestureBound || !pushSupported()) return;
  if (currentPermission() !== "default") return;
  if (iosNeedsInstall()) return;
  gestureBound = true;

  const trigger = () => {
    try {
      enablePush({ silent: true });
    } catch (error) {
      /* jamais bloquant pour la navigation */
    }
  };
  document.addEventListener("click", trigger, { once: true, passive: true, capture: true });
  document.addEventListener("touchend", trigger, { once: true, passive: true, capture: true });
}

/** État push de CET appareil (diagnostic admin, lecture seule). */
export async function getPushDiagnostics() {
  const permission = currentPermission();
  let token = currentToken;
  if (!token && permission === "granted") token = await syncPushToken();
  const account = auth.currentUser || getCurrentUser();
  return {
    supported: pushSupported() && !iosNeedsInstall(),
    permission,
    platform: getPlatform(),
    standalone: isStandalone(),
    iosNeedsInstall: iosNeedsInstall(),
    vapid: Boolean(PWA_CONFIG.VAPID_KEY),
    token: token || "",
    tokenHead: token ? token.slice(0, 18) : "",
    uid: account ? account.uid : "",
  };
}

const TEST_PUSH_ENDPOINT =
  "https://europe-west1-smartswi9a-31063.cloudfunctions.net/adminTestPush";

/**
 * Force un token NEUF pour cet appareil (deleteToken + getToken).
 * Un token ancien peut être refusé par FCM : le bouton de test doit toujours
 * partir d'un token fraîchement enregistré sous le compte courant.
 */
async function refreshDeviceToken(account) {
  try {
    const msg = await ensureMessaging();
    if (!msg) return null;
    const api = await messagingApi();
    try {
      await api.deleteToken(msg);
    } catch (error) {
      /* token déjà inexistant */
    }
    const registration = await ensureSwRegistration();
    const token = await api.getToken(msg, {
      vapidKey: PWA_CONFIG.VAPID_KEY,
      ...(registration ? { serviceWorkerRegistration: registration } : {}),
    });
    if (!token) return null;
    currentToken = token;
    await saveToken(token, account, await resolveRole(account.uid));
    return token;
  } catch (error) {
    console.warn("[push] rafraîchissement du token impossible :", error && error.message);
    return null;
  }
}

/** Notification push de test vers CET appareil (admin uniquement côté serveur). */
export async function sendTestPush() {
  /* 1. Utilisateur réellement connecté (Firebase Auth, pas le store). */
  const account = await resolveAccount();
  if (!account) return { ok: false, error: "no_user" };

  /* 2. Token NEUF de cet appareil, enregistré sous ce compte. */
  let token = await refreshDeviceToken(account);
  if (!token) token = await registerToken({ user: account });
  if (!token) token = currentToken;
  if (!token) {
    const result = await enablePush({ silent: true });
    token = result && result.token;
  }
  if (!token) return { ok: false, error: "no_token" };

  try {
    /* 3. Jeton d'identité Firebase forcé (getIdToken(true)). */
    const idToken = await account.getIdToken(true);
    if (!idToken) return { ok: false, error: "no_auth" };

    const response = await fetch(TEST_PUSH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({
        token,
        title: "🔔 Test Smartswika",
        body: "Si cette notification apparaît, le push fonctionne sur cet appareil.",
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.sent) {
      return { ok: false, error: payload.error || `http_${response.status}` };
    }
    return { ok: true, token };
  } catch (error) {
    return { ok: false, error: "network" };
  }
}

/** Initialisation (idempotente). */
export async function initPush(options = {}) {
  if (typeof window === "undefined") return;
  if (window._pushInitialized) return;
  window._pushInitialized = true;
  const showCta = !(options && options.showCta === false);

  /* API exposées même si le push n'est pas disponible : le panneau admin
     peut ainsi afficher un état explicite sans jamais lever d'erreur. */
  window.smartswikaEnablePush = enablePush;
  window.smartswikaPushStatus = getPushDiagnostics;
  window.smartswikaSendTestPush = sendTestPush;

  if (!pushSupported()) return; /* navigateur sans Push : silence total */
  if (!PWA_CONFIG.VAPID_KEY) {
    console.warn("[push] VAPID_KEY absente de js/config.js : push inactif.");
    return;
  }

  /* iOS Safari hors PWA : l'invite d'installation reste affichée, la
     permission sera demandée au 1er toucher dans l'application installée. */
  if (iosNeedsInstall()) {
    if (showCta) showPushCta(() => enablePush());
    return;
  }

  const msg = await ensureMessaging();
  if (!msg) return;

  bindForeground();
  bindAuth();

  if (currentPermission() === "granted") {
    /* 2. Synchro 100 % silencieuse à chaque visite (uid/rôle à jour). */
    await syncPushToken();
    return;
  }

  if (currentPermission() === "default") {
    /* 1. Activation automatique au tout premier clic / toucher. */
    autoPromptOnFirstGesture();
    if (showCta) showPushCta(() => enablePush());
  }
  /* permission === "denied" : on ne redemande rien (impossible), zéro bruit. */
}

export default initPush;
