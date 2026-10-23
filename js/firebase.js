// js/firebase.js
// ============================================================
// INITIALISATION FIREBASE - SMART SWI9A
// Version 8.0.0 — Offline persistence + robust init
// ============================================================
// Dépend de : config.js
// Exporte   : auth, db, storage, clearFirestoreCache()
// ============================================================

import { initializeApp } from "firebase/app";
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
// ============================================================
const app = initializeApp(CONFIG.FIREBASE);

// ============================================================
// AUTH
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
// HELPER LOGOUT — Vider le cache Firestore IndexedDB
// ============================================================
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
console.log('✅ firebase.js chargé — v8.0.0 (offline persistence)');