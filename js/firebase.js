// js/firebase.js
// ============================================================
// INITIALISATION FIREBASE - SMART SWI9A
// Version 2.0.0 — Offline persistence + robust init
// ============================================================
// CHANGEMENTS v2.0.0 :
// ✅ I4.1 — Persistance offline Firestore (cache multi-onglets)
// ✅ I4.2 — measurementId retiré (déjà dans config.js v3.1.0)
// ✅ M4.1 — Init robuste (fallback mémoire si HMR/browser incompatible)
// ✅ M4.2 — Default export `app` retiré (dead code, jamais importé)
// ✅ M4.3 — Import `storage` conservé (produits, avis, blog — justifié)
// ⚠️ C4.1 — CSP media-src à corriger dans firebase.json (Fichier 19)
// ⚠️ M4.4 — Vérifier "Authorized Domains" dans Firebase Console :
//            Console → Authentication → Settings → Authorized Domains
//            Doit inclure : smartswi9a.top, www.smartswi9a.top,
//            et localhost (si dev)
// ⚠️ M4.5 — Vérifier storageBucket dans config.js :
//            "smartswi9a-31063.firebasestorage.app" ✅ (nouveau format)
//            ou "smartswi9a-31063.appspot.com" (ancien format)
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
// ✅ I4.1 — FIRESTORE avec persistance offline
// ------------------------------------------------------------
// Avantages :
//  - Cache local IndexedDB (les requêtes sont servies depuis le cache)
//  - Support multi-onglets (les onglets partagent le cache)
//  - Mutations en attente pendant une coupure réseau
//  - UX nettement meilleure en 3G marocaine
//
// ⚠️ Edge cases :
//  - HMR / double-init → getFirestore() pour récupérer l'instance existante
//  - Navigateur incompatible (Safari private mode, vieux Firefox) →
//    fallback silencieux vers cache mémoire
//
// ⚠️ Sécurité multi-utilisateurs :
//  Firebase Auth isole le cache par UID. Quand un user se déconnecte,
//  son cache reste en IndexedDB jusqu'à la prochaine connexion d'un autre
//  user OU jusqu'à clearFirestoreCache().
//  Pour un appareil partagé (rare en COD), appeler clearFirestoreCache()
//  au logout + window.location.reload().
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
    // Cas 1 : déjà initialisé (HMR, double-import, etc.)
    const isAlreadyInit =
        e?.code === 'failed-precondition' ||
        /already.*initialized/i.test(e?.message || '');

    if (isAlreadyInit) {
        console.log('ℹ️ Firestore : instance existante réutilisée (HMR)');
    } else {
        // Cas 2 : navigateur incompatible (Safari private, etc.)
        console.warn('⚠️ Persistance offline indisponible, fallback mémoire:', e?.message);
    }

    // Dans les deux cas, on récupère l'instance disponible
    _db = getFirestore(app);
}

export const db = _db;

// ============================================================
// ✅ M4.3 — STORAGE
// ------------------------------------------------------------
// Note : `getStorage(app)` ne télécharge rien — c'est juste l'instanciation
// du service object. Le coût bundle est déjà payé par l'import du SDK.
// Utilisé partout (upload images produits, photos avis, images blog).
// ============================================================
export const storage = getStorage(app);

// ============================================================
// ✅ HELPER LOGOUT — Vider le cache Firestore IndexedDB
// ------------------------------------------------------------
// Utilisation recommandée (dans auth.js logout, AVANT signOut) :
//
//   import { clearFirestoreCache } from './firebase.js';
//   await signOut(auth);
//   await clearFirestoreCache();
//   window.location.reload();   // ← OBLIGATOIRE après clear
//
// ⚠️ clearIndexedDbPersistence() EXIGE que db ne soit plus utilisé.
//    En pratique, seul un reload garantit que plus aucun listener
//    n'utilise l'instance. C'est pourquoi le reload est documenté.
//
// ⚠️ Ne PAS appeler cette fonction en production sauf si :
//   - L'appareil est partagé entre plusieurs utilisateurs
//   - Conformité RGPD / effacement de données à la demande
//
// Pour notre cas d'usage (COD, appareil personnel), la persistance
// multi-user de Firebase Auth suffit — pas besoin d'appeler ce helper.
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
console.log('✅ firebase.js chargé — v2.0.0 (offline persistence)');