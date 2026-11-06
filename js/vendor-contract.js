/* ============================================================
   js/vendor-contract.js
   Signature électronique du contrat vendeur — Lot 27/30

   Version 10.0.0 — Sécurisation serveur (API)
   
   CHANGEMENTS v10.0.0 :
     - La signature ne se fait plus côté client via runTransaction.
       Le client envoie les données à la Cloud Function
       /api/signVendorContract qui vérifie le hash, capture l'IP
       côté serveur, et enregistre le contrat.
     - Suppression de la capture d'IP via Worker Cloudflare (le
       serveur s'en charge).
     - Gestion propre de l'idempotence (si le serveur répond
       alreadySigned: true, on ne lève plus d'erreur).
     - Les fonctions de vérification d'intégrité locale
       (verifyContractIntegrity) sont conservées pour l'affichage.

   DÉPENDANCES :
     - ./vendor-contract-text.js (getContractText, buildTermsSnapshot)
     - ./config.js (CONFIG.VENDOR)
     - ./firebase.js (auth)

   ALERTE 1 : plus aucun commentaire de ligne (//) en début de
   ligne utile. Tout est en bloc.
   ============================================================ */

import { auth } from "./firebase.js";
import { CONFIG } from "./config.js";
import { getContractText, buildTermsSnapshot } from "./vendor-contract-text.js";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const ALLOWED_LANGS = ["fr", "ar", "en"];
const ALLOWED_SOURCES = ["signup", "dashboard", "resign"];

/* ============================================================
   HELPERS INTERNES
   ============================================================ */

/**
 * Parse une string semver "x.y.z" en objet { major, minor, patch }.
 * @param {*} str
 * @returns {{major: number, minor: number, patch: number} | null}
 */
function parseVersion(str) {
    if (typeof str !== "string") return null;
    const s = str.trim();
    if (!SEMVER_RE.test(s)) return null;
    const parts = s.split(".");
    return { major: Number(parts[0]), minor: Number(parts[1]), patch: Number(parts[2]) };
}

/* ============================================================
   SEMVER / IDs / POLITIQUE DE RE-SIGNATURE
   ============================================================ */

/**
 * Compare deux versions semver.
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 si a < b, 1 si a > b, 0 si égal ou invalide.
 */
export function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;
    if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
    if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
    if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
    return 0;
}

/**
 * Construit l'ID versionné du document contrat.
 * Format : contract_<uid>_v<semver> (ex: contract_abc123_v1.2.0).
 * @param {string} userId
 * @param {string} [version=CONFIG.VENDOR.CONTRACT_VERSION]
 * @returns {string}
 */
export function getContractId(userId, version = CONFIG.VENDOR.CONTRACT_VERSION) {
    if (!userId || typeof userId !== "string" || userId.startsWith("temp_")) {
        throw new Error("getContractId : UID Firebase réel requis.");
    }
    if (!version || typeof version !== "string" || !SEMVER_RE.test(version)) {
        throw new Error("getContractId : version semver requise (x.y.z).");
    }
    return `contract_${userId}_v${version}`;
}

/**
 * Vérifie si un vendeur doit re-signer le contrat.
 * @param {Object} vendorInfo - Objet users/{uid}.vendorInfo
 * @returns {boolean} true si re-signature nécessaire.
 */
export function needsResign(vendorInfo) {
    if (!vendorInfo || typeof vendorInfo !== "object") return true;
    const v = parseVersion(vendorInfo.contractVersion);
    const c = parseVersion(CONFIG.VENDOR.CONTRACT_VERSION);
    if (!v || !c) return true;
    // Comparer les trois composantes semver : une correction de patch publiée
    // doit également déclencher une nouvelle signature si elle change le contrat.
    return compareVersions(vendorInfo.contractVersion, CONFIG.VENDOR.CONTRACT_VERSION) < 0;
}

/**
 * Inverse de needsResign : true si le contrat du vendeur est à jour.
 * @param {Object} vendorInfo
 * @returns {boolean}
 */
export function isContractCurrent(vendorInfo) {
    return !needsResign(vendorInfo);
}

/* ============================================================
   HASH SHA-256 (Web Crypto)
   ============================================================ */
async function generateHash(text) {
    if (typeof crypto === "undefined" || !crypto.subtle) {
        throw new Error("Hash non supporté (Web Crypto indisponible). Le site doit être servi en HTTPS.");
    }
    const buf = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest(CONFIG.SECURITY.CONTRACT_HASH_ALGO, buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Calcule le hash SHA-256 d'un texte de contrat.
 * Utilisé en interne et exposé pour les vérifications manuelles.
 * @param {string} contractText
 * @returns {Promise<string>} hex 64 chars
 */
export async function computeContractTextHash(contractText) {
    if (!contractText || typeof contractText !== "string") {
        throw new Error("computeContractTextHash : texte de contrat invalide.");
    }
    return await generateHash(contractText);
}

/* ============================================================
   SIGNATURE (Appel API sécurisé)
   ============================================================ */

/**
 * Signe un contrat vendeur via la Cloud Function sécurisée.
 * Le serveur vérifie le hash, capture l'IP, et enregistre le document.
 *
 * @param {string} userId - UID Firebase réel du vendeur.
 * @param {string} contractText - Texte exact du contrat signé.
 * @param {Object} [preSignatureData]
 * @param {string} [preSignatureData.textHash] - Hash pré-calculé.
 * @param {string} [preSignatureData.language] - 'fr' | 'ar' | 'en'.
 * @param {string} [preSignatureData.version] - Semver.
 * @param {Object} [preSignatureData.termsSnapshot] - Snapshot figé.
 * @param {string} [preSignatureData.source] - 'signup' | 'dashboard' | 'resign'.
 * @returns {Promise<{ success: boolean, contractId: string, version: string, alreadySigned: boolean }>}
 */
export async function signVendorContract(userId, contractText, preSignatureData = {}) {
    if (!userId || typeof userId !== "string" || userId.startsWith("temp_")) {
        throw new Error("signVendorContract : UID Firebase réel requis.");
    }
    if (!contractText || typeof contractText !== "string") {
        throw new Error("signVendorContract : texte de contrat requis.");
    }

    const language = ALLOWED_LANGS.includes(preSignatureData.language) ? preSignatureData.language : "fr";
    const version = (typeof preSignatureData.version === "string" && SEMVER_RE.test(preSignatureData.version))
        ? preSignatureData.version
        : CONFIG.VENDOR.CONTRACT_VERSION;
    const termsSnapshot = (preSignatureData.termsSnapshot && typeof preSignatureData.termsSnapshot === "object")
        ? preSignatureData.termsSnapshot
        : buildTermsSnapshot();
    const source = ALLOWED_SOURCES.includes(preSignatureData.source) ? preSignatureData.source : "dashboard";

    const textHash = (typeof preSignatureData.textHash === "string" && SHA256_HEX_RE.test(preSignatureData.textHash))
        ? preSignatureData.textHash.toLowerCase()
        : await computeContractTextHash(contractText);

    const user = auth.currentUser;
    if (!user || user.uid !== userId) {
        throw new Error("Session Firebase invalide.");
    }

    const idToken = await user.getIdToken(true);

    try {
        const response = await fetch('/api/signVendorContract', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${idToken}` 
            },
            body: JSON.stringify({
                version,
                language,
                termsSnapshot,
                textHash,
                source
            })
        });

        const result = await response.json().catch(() => ({}));

        if (!response.ok || !result.success) {
            throw new Error(result.message || "Erreur lors de la signature du contrat.");
        }

        return {
            success: true,
            alreadySigned: result.alreadySigned || false,
            contractId: result.contractId,
            version: result.version || version
        };

    } catch (e) {
        console.error("[vendor-contract] Erreur signature API :", e);
        throw e;
    }
}

/* ============================================================
   VÉRIFICATION D'INTÉGRITÉ (Locale)
   ============================================================ */

/**
 * Vérifie l'intégrité d'un document contrat en recalculant les
 * hash depuis le snapshot stocké.
 *
 * @param {Object} contractDoc - Données du doc contracts/{id}.
 * @returns {Promise<{ ok: boolean, textHashOk: boolean, contractHashOk: boolean, reason: string }>}
 */
export async function verifyContractIntegrity(contractDoc) {
    try {
        if (!contractDoc || typeof contractDoc !== "object") {
            return { ok: false, textHashOk: false, contractHashOk: false, reason: "document manquant" };
        }
        const { vendorId, version, language, textHash, contractHash, termsSnapshot } = contractDoc;
        
        if (!version || typeof version !== "string" || !SEMVER_RE.test(version)) {
            return { ok: false, textHashOk: false, contractHashOk: false, reason: "version inconnue" };
        }
        if (!termsSnapshot || typeof termsSnapshot !== "object") {
            return { ok: false, textHashOk: false, contractHashOk: false, reason: "snapshot manquant" };
        }
        if (!ALLOWED_LANGS.includes(language)) {
            return { ok: false, textHashOk: false, contractHashOk: false, reason: "langue invalide" };
        }
        if (!vendorId || !textHash || !contractHash) {
            return { ok: false, textHashOk: false, contractHashOk: false, reason: "champs obligatoires manquants" };
        }

        const rebuilt = getContractText(language, version, termsSnapshot);
        if (typeof rebuilt !== "string" || !rebuilt) {
            return { ok: false, textHashOk: false, contractHashOk: false, reason: "gabarit introuvable" };
        }

        const rebuiltTextHash = await computeContractTextHash(rebuilt);
        const textHashOk = rebuiltTextHash === textHash;
        
        const ctx = [vendorId, version, language, textHash].join("|");
        const rebuiltContractHash = await generateHash(ctx);
        const contractHashOk = rebuiltContractHash === contractHash;

        if (textHashOk && contractHashOk) {
            return { ok: true, textHashOk: true, contractHashOk: true, reason: "ok" };
        }

        return {
            ok: false,
            textHashOk: textHashOk,
            contractHashOk: contractHashOk,
            reason: !textHashOk ? "textHash différent" : "contractHash différent"
        };
    } catch (e) {
        return {
            ok: false,
            textHashOk: false,
            contractHashOk: false,
            reason: "exception: " + (e && e.message ? e.message : "inconnue")
        };
    }
}

/* ============================================================
   LOG
   ============================================================ */
console.log("[vendor-contract] v10.0.0 chargé (Appel API sécurisé)");