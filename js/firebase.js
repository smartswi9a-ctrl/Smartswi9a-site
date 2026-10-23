// js/firebase.js
// ============================================================
// INITIALISATION FIREBASE - SMART SWI9A
// Version 8.0.1 — Offline persistence + robust init
// ============================================================
// ⚠️ Ce module importe "firebase/storage". L'importmap de TOUTES les
//     pages qui le chargent (directement ou transitivement via auth.js)
//     DOIT inclure "firebase/storage" — sinon lève :
//     "Failed to resolve module specifier 'firebase/storage'"
//     (cf. E4 — corrigé dans inscription-vendeur.html).
// Dépend de : config.js
// Exporte   : auth, db, storage, clearFirestoreCache()
// ============================================================

import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
    initializeFirestore,
    getFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    clearIndexedDbPersistence
} from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { CONFIG } from "./config.js";

// ============================================================
// INITIALISATION APP
// Défensif : si le module était rechargé (double <script>, HMR,
// ou double import), on réutilise l'app existante au lieu de
// provoquer "Firebase App named '[DEFAULT]' already exists".
// ============================================================
const app = getApps().length ? getApp() : initializeApp(CONFIG.FIREBASE);

// ============================================================
// AUTH
// Persistance par défaut = browserLocalPersistence (session qui survit
// au reload, géré par Firebase). On ne force PAS de persistance ici :
// le cache local (localStorage[swi9a_user]) ne sert qu'à l'affichage,
// jamais à décider un droit (cf. auth.js v3.3.0).
// ============================================================
export const auth = getAuth(app);

// ============================================================
// FIRESTORE avec persistance offline
// ============================================================
let _db;

try {
    _db = initializeFirestore(app, {
        localCache: persistentLocalCache({
            tabManager: persistentMultipleTabManager()
        })
    });
    console.log('✅ Firestore : persistance offline activée');
} catch (e) {
    const isAlreadyInit =
        e?.code === 'failed-precondition' ||
        /already.*initialized/i.test(e?.message || '');

    if (isAlreadyInit) {
        console.log('ℹ️ Firestore : instance existante réutilisée (HMR)');
    } else {
        console.warn('⚠️ Persistance offline indisponible, fallback mémoire:', e?.message);
    }

    _db = getFirestore(app);
}

export const db = _db;

// ============================================================
// STORAGE
// ============================================================
export const storage = getStorage(app);

// ============================================================
// HELPER — Vider le cache Firestore IndexedDB
// ============================================================
/**
 * ⚠️ LIMITATION : `clearIndexedDbPersistence` ne fonctionne QUE si
 * AUCUN appel Firestore n'a encore été fait dans la page.
 * Dès qu'un getDoc/getDocs/onSnapshot/setDoc a eu lieu, l'appel lève
 *   "Firestore has already been started and its persistence can no
 *    longer be cleared".
 *
 * Ce helper reste utile pour les rares cas où on veut nettoyer AVANT
 * toute lecture (page de secours, purge manuelle), mais ne doit PAS
 * être utilisé comme « nettoyage de logout » standard. À la place,
 * `logoutUser()` (auth.js) ferme la session via signOut() ; le cache
 * IndexedDB est purgé par le navigateur à la prochaine éviction.
 * Si un nettoyage immédiat est indispensable, faire suivre l'appel
 * par un `location.reload()`.
 *
 * @returns {Promise<boolean>} true si le cache a pu être vidé, false sinon.
 */
export async function clearFirestoreCache() {
    try {
        await clearIndexedDbPersistence(db);
        console.log('✅ Cache Firestore vidé (IndexedDB cleared)');
        return true;
    } catch (e) {
        console.warn('⚠️ Impossible de vider le cache Firestore:', e?.message);
        return false;
    }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ firebase.js chargé — v8.0.1 (offline persistence)');