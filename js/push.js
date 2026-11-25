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
import { db } from "./firebase.js";
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

/** Synchronisation silencieuse (permission déjà accordée). */
export async function syncPushToken() {
  const user = getCurrentUser();
  if (!user || !PWA_CONFIG.VAPID_KEY) return null;
  if (!("Notification" in window) || Notification.permission !== "granted") return null;

  const msg = await ensureMessaging();
  if (!msg) return null;

  try {
    const registration = getSwRegistration();
    const token = await (await messagingApi()).getToken(msg, {
      vapidKey: PWA_CONFIG.VAPID_KEY,
      ...(registration ? { serviceWorkerRegistration: registration } : {}),
    });
    if (!token) return null;
    currentToken = token;
    await saveToken(token, user, await resolveRole(user.uid));
    return token;
  } catch (error) {
    console.warn("[push] synchronisation token impossible :", error && error.message);
    return null;
  }
}

/** Demande d'activation explicite (clic utilisateur). */
export async function enablePush() {
  const user = getCurrentUser();
  if (!user) {
    showToast(t("loginRequired") || "Connectez-vous pour activer les alertes.");
    return { ok: false, error: "no_user" };
  }
  if (!("Notification" in window)) {
    showToast("Notifications non prises en charge par ce navigateur.");
    return { ok: false, error: "unsupported" };
  }
  if (!PWA_CONFIG.VAPID_KEY) {
    console.warn("[push] VAPID_KEY absente : push désactivé.");
    showToast("Alertes bientôt disponibles sur cet appareil.");
    return { ok: false, error: "no_vapid" };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    showToast("Notifications refusées. Réactivez-les dans les réglages du navigateur.");
    return { ok: false, error: "denied" };
  }

  const msg = await ensureMessaging();
  if (!msg) {
    showToast("Notifications non prises en charge sur cet appareil.");
    return { ok: false, error: "unsupported" };
  }

  try {
    const registration = getSwRegistration();
    const token = await (await messagingApi()).getToken(msg, {
      vapidKey: PWA_CONFIG.VAPID_KEY,
      ...(registration ? { serviceWorkerRegistration: registration } : {}),
    });
    if (!token) return { ok: false, error: "no_token" };
    currentToken = token;
    await saveToken(token, user, await resolveRole(user.uid));
    showToast("🔔 Alertes activées");
    return { ok: true, token };
  } catch (error) {
    console.warn("[push] activation impossible :", error && error.message);
    showToast("Impossible d'activer les alertes pour le moment.");
    return { ok: false, error: "token_error" };
  }
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

/** Initialisation (idempotente). */
export async function initPush() {
  if (typeof window === "undefined") return;
  if (window._pushInitialized) return;
  window._pushInitialized = true;

  const msg = await ensureMessaging();
  if (!msg) return;

  bindForeground();
  bindAuth();
  window.smartswikaEnablePush = enablePush;

  if (!PWA_CONFIG.VAPID_KEY) {
    console.warn("[push] VAPID_KEY absente de js/config.js : push inactif.");
    return;
  }

  if (getCurrentUser() && Notification.permission === "granted") {
    await syncPushToken();
  } else if (Notification.permission === "default") {
    showPushCta(() => {
      enablePush();
    });
  }
}

export default initPush;
