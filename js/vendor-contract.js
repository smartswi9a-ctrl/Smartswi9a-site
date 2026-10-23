// js/vendor-contract.js
// ============================================================
// SIGNATURE ÉLECTRONIQUE DU CONTRAT VENDEUR
// Version 1.1.0 — Correctifs E5/E6 :
//   - hash déterministe + textHash séparé
//   - acceptedAt en serverTimestamp()
//   - création seule (garde + relies sur règles Firestore)
//   - refus explicite des userId "temp_..."
//   - ipSource explicite, UA client toujours prioritaire
//   - export computeContractTextHash pour la pré-signature
// ============================================================

import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG } from "./config.js";

// ============================================================
// CAPTURE D'IP (via Worker Cloudflare)
// ============================================================
async function captureIpAndUa() {
    // Le user-agent du client est la seule source fiable côté navigateur.
    // Le Worker renvoie l'IP vue par Cloudflare (CF-Connecting-IP).
    const clientUa = (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown';
    try {
        const res = await fetch(CONFIG.SECURITY.IP_WORKER_URL, {
            method: 'GET',
            credentials: 'omit',
            cache: 'no-store'
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const ip = (data && typeof data.ip === 'string' && data.ip.trim()) ? data.ip.trim() : null;
        if (!ip) throw new Error('IP absente de la réponse Worker');
        return { ip, ua: clientUa, source: 'worker' };
    } catch (e) {
        console.warn("⚠️ Impossible de récupérer l'IP (Worker indisponible). On marque ipSource='unavailable'.", e);
        return { ip: 'unknown', ua: clientUa, source: 'unavailable' };
    }
}

// ============================================================
// HASH SHA-256
// ============================================================
async function generateHash(text) {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
        // Sur HTTPS, Web Crypto est toujours disponible. Sur HTTP simple, non.
        // Renvoyer un faux hash serait pire que planter : on refuse.
        throw new Error("Hash non supporté (Web Crypto indisponible). Le site doit être servi en HTTPS.");
    }
    const msgBuffer = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest(CONFIG.SECURITY.CONTRACT_HASH_ALGO, msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash du texte SEUL du contrat (dans la langue affichée).
 * À appeler EN MÉMOIRE pendant la pré-signature (E5), avant que
 * createUserWithEmailAndPassword ne soit appelé. Le résultat est
 * passé à signVendorContract via preSignatureData.textHash.
 *
 * @param {string} contractText — Texte exact affiché à l'utilisateur.
 * @returns {Promise<string>} Hash SHA-256 hex (64 caractères).
 */
export async function computeContractTextHash(contractText) {
    if (!contractText || typeof contractText !== 'string') {
        throw new Error("computeContractTextHash : texte de contrat invalide.");
    }
    return await generateHash(contractText);
}

/**
 * Signature électronique — écrit UNE SEULE FOIS dans contracts/contract_<uid>.
 *
 * @param {string} userId — UID Firebase réel (jamais "temp_…", cf. E5).
 * @param {string} contractText — Texte exact affiché, dans la langue affichée.
 * @param {object} [preSignatureData] — Données calculées en pré-signature :
 *        { textHash?: string, language?: 'fr'|'ar'|'en' }.
 *        Si textHash est fourni (64 hex), il est utilisé tel quel
 *        (c'est ce que l'utilisateur a vu). Sinon recalculé depuis contractText.
 *
 * @returns {Promise<{success:true, ip:string, ipSource:'worker'|'unavailable', hash:string, textHash:string}>}
 */
export async function signVendorContract(userId, contractText, preSignatureData = {}) {
    // --- Validation d'entrée (E5) ---
    if (!userId || typeof userId !== 'string' || userId.startsWith('temp_')) {
        throw new Error("signVendorContract : UID Firebase réel requis (pas de 'temp_…').");
    }
    if (!contractText || typeof contractText !== 'string') {
        throw new Error("signVendorContract : texte de contrat requis.");
    }

    const language = ['fr', 'ar', 'en'].includes(preSignatureData.language)
        ? preSignatureData.language
        : 'fr';

    const contractDocRef = doc(db, "contracts", `contract_${userId}`);

    // --- Garde anti-double signature (les règles Firestore tranchent) ---
    // Best-effort côté client : si la lecture est permise et le doc existe,
    // on refuse. Si la lecture échoue (règles), on continue ; l'écriture
    // sera de toute façon bloquée par les règles "création seule".
    try {
        const existing = await getDoc(contractDocRef);
        if (existing.exists()) {
            throw new Error("CONTRACT_ALREADY_SIGNED");
        }
    } catch (e) {
        if (e && e.message === "CONTRACT_ALREADY_SIGNED") throw e;
        console.warn("⚠️ Pré-vérification contrat impossible (règles Firestore ?). On continue, l'écriture sera contrôlée.", e);
    }

    // --- IP + UA (source explicite, E6) ---
    const { ip, ua, source } = await captureIpAndUa();

    // --- textHash : réutilise celui de la pré-signature s'il est valide ---
    const validPreHash = typeof preSignatureData.textHash === 'string'
        && /^[0-9a-f]{64}$/i.test(preSignatureData.textHash);
    const textHash = validPreHash
        ? preSignatureData.textHash.toLowerCase()
        : await computeContractTextHash(contractText);

    // --- contractHash : DÉTERMINISTE et vérifiable plus tard ---
    // Vérification ultérieure possible : recalculer
    //   hash(vendorId | version | language | textHash)
    // et comparer à contractHash stocké. Le textHash lui-même peut être
    // revérifié contre le texte de la version CONTRACT_VERSION / langue.
    const contextString = [userId, CONFIG.VENDOR.CONTRACT_VERSION, language, textHash].join('|');
    const contractHash = await generateHash(contextString);

    // --- Document unique, complet, non modifiable ensuite (E6) ---
    const contractData = {
        vendorId: userId,
        version: CONFIG.VENDOR.CONTRACT_VERSION,
        language: language,
        acceptedAt: serverTimestamp(),      // horloge serveur (autorité)
        ipAddress: ip,                       // 'unknown' si Worker KO
        ipSource: source,                    // 'worker' | 'unavailable'
        userAgent: ua,                       // UA client, toujours
        contractHash: contractHash,          // hash déterministe
        textHash: textHash,                  // hash du texte seul
        status: 'accepted'
    };

    try {
        // setDoc sans merge sur un doc inexistant = création.
        // Si les règles Firestore interdisent update, une 2ᵉ tentative échouera.
        await setDoc(contractDocRef, contractData);
        return {
            success: true,
            ip,
            ipSource: source,
            hash: contractHash,
            textHash
        };
    } catch (e) {
        console.error("❌ Erreur sauvegarde contrat :", e);
        if (e && (e.code === 'permission-denied' || e.code === 'already-exists')) {
            throw new Error("Contrat déjà signé ou accès refusé.");
        }
        throw new Error("Impossible d'enregistrer la signature du contrat.");
    }
}