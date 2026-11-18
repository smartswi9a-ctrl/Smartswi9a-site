/* ============================================================
   js/ranking-sync.js
   SYNCHRONISATION DU CLASSEMENT (A1)
   ============================================================
   Le classement vit TOUJOURS en local (localStorage). Quand un
   utilisateur est connecte, il est EN PLUS conserve dans son propre
   document users/{uid}.ranking, ce qui permet de retrouver ses
   priorites sur un autre appareil.

   REGLES DE FUSION
     - au chargement : local + distant, par evenement (plus grand
       compte ET date la plus recente), aucune source n ecrase l autre ;
     - a chaque evenement : ecriture differee de 4 s (une seule
       ecriture par rafale de clics) ;
     - hors ligne ou en erreur : le local reste la source, rien n est
       perdu et rien n est bloque.

   Aucun acces en ecriture au document d un autre utilisateur : les
   regles Firestore n autorisent que isSelf(uid), et le champ ranking
   n est pas dans les champs proteges.

   ALERTE 1 : aucun commentaire de ligne dans ce fichier.
   ============================================================ */

import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "./firebase.js";
import { getCurrentUser } from "./auth.js";
import {
  loadRankingState,
  saveRankingState,
  mergeRanking,
  trimRanking,
} from "./ranking.js";

const PUSH_DELAY_MS = 4000;
let pushTimer = null;
let syncing = false;

function sameState(a, b) {
  try {
    return JSON.stringify(a || null) === JSON.stringify(b || null);
  } catch (e) {
    return false;
  }
}

/**
 * Fusionne local et distant, puis renvoie au serveur si necessaire.
 * @returns {Promise<boolean>}
 */
export async function syncRankingWithCloud() {
  const user = getCurrentUser();
  if (!user || !user.uid || syncing) return false;

  syncing = true;
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    const remote = snap.exists() ? snap.data().ranking || null : null;
    const merged = trimRanking(mergeRanking(loadRankingState(), remote));

    saveRankingState(merged);
    document.dispatchEvent(new CustomEvent("ranking-updated-local"));

    if (!sameState(remote, merged) && snap.exists()) {
      await updateDoc(ref, { ranking: merged });
    }
    return true;
  } catch (e) {
    /* hors ligne, droits, document absent : le local suffit */
    return false;
  } finally {
    syncing = false;
  }
}

async function pushRankingNow() {
  const user = getCurrentUser();
  if (!user || !user.uid) return;
  try {
    await updateDoc(doc(db, "users", user.uid), {
      ranking: trimRanking(loadRankingState()),
    });
  } catch (e) {
    /* non bloquant */
  }
}

/**
 * Programme une ecriture differee (une par rafale d evenements).
 */
export function scheduleRankingPush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushRankingNow();
  }, PUSH_DELAY_MS);
}

function initRankingSync() {
  if (typeof document === "undefined") return;

  document.addEventListener("auth-updated", (event) => {
    if (event && event.detail && event.detail.user) {
      syncRankingWithCloud();
    }
  });
  document.addEventListener("ranking-updated", scheduleRankingPush);

  if (getCurrentUser()) syncRankingWithCloud();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initRankingSync);
} else {
  initRankingSync();
}

console.log("[ranking] synchronisation du classement active (A1)");