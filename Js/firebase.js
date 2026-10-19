// js/firebase.js
// ============================================================
// INITIALISATION FIREBASE - SMART SWI9A
// ============================================================
// Dépend de : config.js
// Exporte   : auth, db, storage (utilisés par tous les modules)
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { CONFIG } from "./config.js";

// ============================================================
// INITIALISATION
// ============================================================
const app = initializeApp(CONFIG.FIREBASE);

// ============================================================
// EXPORTS DES SERVICES
// ============================================================
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// ============================================================
// EXPORT PAR DÉFAUT (app)
// ============================================================
export default app;

// ============================================================
// LOG
// ============================================================
console.log('✅ firebase.js chargé');