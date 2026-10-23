// js/vendor-contract.js
// ============================================================
// SIGNATURE ÉLECTRONIQUE DU CONTRAT VENDEUR
// Version 1.0.0
// ============================================================

import { doc, setDoc, Timestamp } from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG } from "./config.js";

// ============================================================
// CAPTURE D'IP (via Worker Cloudflare)
// ============================================================
async function captureIpAndUa() {
    try {
        const res = await fetch(CONFIG.SECURITY.IP_WORKER_URL);
        if (!res.ok) throw new Error('IP fetch failed');
        const data = await res.json();
        return { ip: data.ip || 'unknown', ua: data.ua || navigator.userAgent };
    } catch (e) {
        console.warn('⚠️ Impossible de récupérer l\'IP, fallback UA only', e);
        return { ip: 'unknown', ua: navigator.userAgent };
    }
}

// ============================================================
// HASH SHA-256 (pour preuve d'intégrité)
// ============================================================
async function generateHash(text) {
    if (!crypto.subtle) return 'hash-unsupported';
    const msgBuffer = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest(CONFIG.SECURITY.CONTRACT_HASH_ALGO, msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================
// SAUVEGARDE DU CONTRAT SIGNÉ
// ============================================================
export async function signVendorContract(userId, contractText) {
    const { ip, ua } = await captureIpAndUa();
    
    // On crée un hash du contenu + du contexte pour prouver qu'il n'a pas été altéré
    const contextString = `${userId}-${CONFIG.VENDOR.CONTRACT_VERSION}-${ip}-${new Date().toISOString()}`;
    const contractHash = await generateHash(contractText + contextString);

    const contractData = {
        vendorId: userId,
        version: CONFIG.VENDOR.CONTRACT_VERSION,
        acceptedAt: Timestamp.now(),
        ipAddress: ip,
        userAgent: ua,
        contractHash: contractHash,
        status: 'accepted'
    };

    try {
        // On utilise un ID déterministe pour qu'un vendeur n'ait qu'un seul contrat
        await setDoc(doc(db, "contracts", `contract_${userId}`), contractData);
        return { success: true, ip, hash: contractHash };
    } catch (e) {
        console.error("❌ Erreur sauvegarde contrat :", e);
        throw new Error("Impossible d'enregistrer la signature du contrat.");
    }
}