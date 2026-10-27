/* ============================================================ js/firebase.js INITIALISATION FIREBASE - SMART SWI9A Version 9.0.0 - Lot 4/30 : consolidation (JSDoc + documentation) CHANGEMENTS v9.0.0 : - Ajout : JSDoc sur tous les exports (auth, db, storage, clearFirestoreCache). - Documentation : commentaires détaillés sur le try/catch de initializeFirestore (pourquoi il existe, quand il se déclenche). - Documentation : limitation de clearFirestoreCache() reformulée pour clarté. - Bump version 8.0.1 -> 9.0.0. - AUCUN changement fonctionnel : tous les imports/exports et signatures restent identiques. RAPPEL IMPORTANT : ce module importe "firebase/storage". L'importmap de TOUTES les pages qui le chargent (directement ou transitivement via auth.js) DOIT inclure "firebase/storage" - sinon lève : "Failed to resolve module specifier 'firebase/storage'". ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  clearIndexedDbPersistence,
} from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { CONFIG } from "./config.js";

/* ============================================================ INITIALISATION APP ============================================================ Défensif : si le module était rechargé (double <script>, HMR, ou double import), on réutilise l'app existante au lieu de provoquer "Firebase App named '[DEFAULT]' already exists". ============================================================ */
const app = getApps().length ? getApp() : initializeApp(CONFIG.FIREBASE);

/* ============================================================ AUTH ============================================================ Persistance par défaut = browserLocalPersistence (session qui survit au reload, géré par Firebase). On ne force PAS de persistance ici : le cache local (localStorage[swi9a_user]) ne sert qu'à l'affichage, jamais à décider un droit (cf. auth.js). ============================================================ */

/** * Instance Firebase Auth du projet Smart Swi9a. * Utilisée par auth.js, admin.js, vendor-signup.js, etc. * @type {import('firebase/auth').Auth} */
export const auth = getAuth(app);

/* ============================================================ FIRESTORE avec persistance offline ============================================================ Pourquoi le try/catch : - Firebase lève une erreur si l'instance Firestore a déjà été initialisée (par exemple avec les anciennes options). Cela peut arriver en développement local (HMR de Vite/Webpack) ou si le fichier était déjà chargé une première fois avec getFirestore(). - On tente donc l'init optimisée (persistance offline multi-onglets). - En cas d'échec (déjà initialisé ou IndexedDB indisponible), on tombe sur getFirestore() qui retourne l'instance existante ou crée une instance en mémoire. - Le fallback "getFirestore(app)" fonctionne dans TOUS les cas. ============================================================ */
let _db;

try {
  _db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });
  console.log("Firestore : persistance offline activée");
} catch (e) {
  const isAlreadyInit =
    e?.code === "failed-precondition" ||
    /already.*initialized/i.test(e?.message || "");

  if (isAlreadyInit) {
    /* Cas normal en dev (HMR) ou double include : pas de warning. */
    console.log(
      "Firestore : instance existante réutilisée (HMR ou double include)"
    );
  } else {
    /* Cas inhabituel : persistance offline indisponible (IndexedDB désactivé, mode navigation privée stricte, etc.). On le signale sans casser l'app. */
    console.warn(
      "Persistance offline indisponible, fallback mémoire:",
      e?.message
    );
  }

  _db = getFirestore(app);
}

/** * Instance Firestore du projet Smart Swi9a. * Persistance offline multi-onglets activée par défaut. * Fallback automatique en mémoire si IndexedDB indisponible. * @type {import('firebase/firestore').Firestore} */
export const db = _db;

/* ============================================================ STORAGE ============================================================ */

/** * Instance Firebase Storage du projet Smart Swi9a. * Utilisée par admin.js, reviews.js, vendor-dashboard.js pour * uploader des images (produits, avis, blog). * @type {import('firebase/storage').FirebaseStorage} */
export const storage = getStorage(app);

/* ============================================================ HELPER - Vider le cache Firestore IndexedDB ============================================================ LIMITATION IMPORTANTE : clearIndexedDbPersistence() ne fonctionne QUE si AUCUN appel Firestore n'a encore été fait dans la page. Dès qu'un getDoc, getDocs, onSnapshot, setDoc, etc. a eu lieu, l'appel lève : "Firestore has already been started and its persistence can no longer be cleared". Ce helper reste utile pour les rares cas où on veut nettoyer AVANT toute lecture (page de secours, purge manuelle). Ne PAS l'utiliser comme "nettoyage de logout" standard : logoutUser() ferme la session via signOut(), et le cache IndexedDB est purgé par le navigateur à la prochaine éviction. Si un nettoyage immédiat est indispensable, faire suivre l'appel par un location.reload(). ============================================================ */

/** * Tente de vider le cache Firestore IndexedDB. * Ne fonctionne que si aucun appel Firestore n'a encore été fait * dans la page courante. Idempotent. * * @returns {Promise<boolean>} true si le cache a pu être vidé, * false sinon (cas normal après init). */
export async function clearFirestoreCache() {
  try {
    await clearIndexedDbPersistence(db);
    console.log("Cache Firestore vidé (IndexedDB cleared)");
    return true;
  } catch (e) {
    console.warn("Impossible de vider le cache Firestore:", e?.message);
    return false;
  }
}

/* ============================================================ LOG ============================================================ */
console.log("✅ firebase.js chargé - v9.0.0 (Lot 4 : consolidation JSDoc)");