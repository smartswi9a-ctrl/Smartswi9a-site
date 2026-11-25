/* ============================================================
   js/presence.js
   PRESENCE EN TEMPS REEL DES COMPTES CONNECTES (clients + vendeurs)
   ============================================================
   Ecrit dans users/{uid} :
     isOnline   true/false
     lastSeenAt serverTimestamp()

   REGLES
     - battement de coeur economique : 1 ecriture par MINUTE, et
       uniquement quand l onglet est visible ;
     - passage a isOnline=false best effort sur pagehide (fermeture
       d onglet ou navigation) ;
     - aucune donnee personnelle supplementaire.

   La vitrine et le tableau de bord vendeur utilisent le meme profil
   users/{uid} : un seul flux, aucun doublon de collection.

   ALERTE 1 : aucun commentaire de ligne dans ce fichier.
   ============================================================ */

import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "firebase/auth";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";

export const PRESENCE_HEARTBEAT_MS = 60000;
export const PRESENCE_WINDOW_MS = 120000;

let heartbeatTimer = null;
let currentUid = null;
let started = false;

function isVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Publie la presence du compte connecte (best effort, jamais bloquant).
 * @param {boolean} online
 */
async function publishPresence(online) {
  const uid = currentUid;
  if (!uid) return;
  if (online && !isVisible()) return;
  try {
    await updateDoc(doc(db, "users", uid), {
      isOnline: online === true,
      lastSeenAt: serverTimestamp(),
    });
  } catch (error) {
    /* reseau, regle ou deconnexion : la presence n est pas critique */
  }
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (currentUid && isVisible()) publishPresence(true);
  }, PRESENCE_HEARTBEAT_MS);
}

/**
 * Demarre l ecoute d authentification et le battement de coeur.
 * Idempotent : un double import ne cree pas deux minuteurs.
 */
export function initPresence() {
  if (started) return;
  started = true;

  onAuthStateChanged(auth, (user) => {
    if (user && user.uid) {
      currentUid = user.uid;
      publishPresence(true);
      startHeartbeat();
    } else {
      clearHeartbeat();
      currentUid = null;
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!currentUid) return;
    if (document.visibilityState === "visible") {
      publishPresence(true);
      startHeartbeat();
    } else {
      clearHeartbeat();
    }
  });

  window.addEventListener("pagehide", () => {
    publishPresence(false);
    clearHeartbeat();
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPresence);
  } else {
    initPresence();
  }
}
