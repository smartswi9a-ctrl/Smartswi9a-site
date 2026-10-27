/* ============================================================
   js/vendor-contract.js
   Signature électronique du contrat vendeur — Lot 27/30

   Version 9.0.0 — Fix race condition + JSDoc + logs

   CHANGEMENTS v9.0.0 :
     - B-VC-1 (P2) : signVendorContract utilise maintenant
       runTransaction pour la phase get + set. Empêche la race
       condition sur double-signature (deux onglets, deux
       signatures simultanées). Le 2ème appel throw
       CONTRACT_ALREADY_SIGNED au lieu d'écraser le 1er.
     - P3-1 : tous les logs préfixés [vendor-contract] (cohérence
       avec les Lots 2-26).
     - P3-2 : JSDoc sur compareVersions, needsResign,
       isContractCurrent.
     - P3-3 : needsResign documenté explicitement (patch = pas de
       re-signature).
     - Bump version 1.2.0 -> 9.0.0.

   COMPATIBILITÉ :
     - Compatible avec CONTRACT_TEMPLATES 1.1.0 ET 1.2.0
       (vendor-contract-text.js v9.0.0).
     - verifyContractIntegrity fonctionne sur les deux versions.
     - needsResign détecte correctement 1.1.0 -> 1.2.0 (mineur).

   RAPPEL ARCHITECTURAL :
     - Chaque signature crée un document versionné
       contract_<uid>_v<semver>. Impossible d'écraser une version
       existante (protégé par la transaction).
     - Une re-signature (1.1.0 -> 1.2.0) crée un NOUVEAU document
       (contract_<uid>_v1.2.0). L'ancien reste pour audit.
     - Le contractHash combine vendorId|version|language|textHash
       → toute modification détectée par verifyContractIntegrity.

   DÉPENDANCES :
     - ./vendor-contract-text.js (getContractText, buildTermsSnapshot)
     - ./config.js (CONFIG.VENDOR.CONTRACT_VERSION, CONFIG.SECURITY.*)
     - ./firebase.js (db)

   ALERTE 1 : plus aucun commentaire de ligne (//) en début de
   ligne utile. Tout est en bloc.
   ============================================================ */

import { doc, getDoc, setDoc, runTransaction, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase.js";
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
 * Refuse les UID temporaires (temp_xxx) et les versions invalides.
 * @param {string} userId
 * @param {string} [version=CONFIG.VENDOR.CONTRACT_VERSION]
 * @returns {string}
 * @throws {Error}
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
 *
 * Politique :
 *   - Changement majeur (1.x -> 2.x) : re-signature obligatoire.
 *   - Changement mineur (1.1 -> 1.2) : re-signature obligatoire.
 *   - Changement patch (1.2.0 -> 1.2.1) : pas de re-signature
 *     (correction de coquille, pas de changement de fond).
 *
 * B-VC-P3-3 : le comportement patch est désormais documenté.
 *
 * @param {Object} vendorInfo - Objet users/{uid}.vendorInfo
 * @returns {boolean} true si re-signature nécessaire.
 */
export function needsResign(vendorInfo) {
    if (!vendorInfo || typeof vendorInfo !== "object") return true;
    const v = parseVersion(vendorInfo.contractVersion);
    const c = parseVersion(CONFIG.VENDOR.CONTRACT_VERSION);
    if (!v || !c) return true;
    if (v.major < c.major) return true;
    if (v.major > c.major) return false;
    if (v.minor < c.minor) return true;
    /* Si major et minor égaux : patch ignoré (pas de re-signature). */
    return false;
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
   CAPTURE IP + UA VIA WORKER CLOUDFLARE
   ============================================================
   L'IP est requise pour la preuve légale de signature. Si le
   Worker est indisponible, on continue avec ip='unknown' et
   ipSource='unavailable' (transparent pour l'utilisateur).
   ============================================================ */
async function captureIpAndUa() {
    const clientUa = (typeof navigator !== "undefined" && navigator.userAgent) || "unknown";
    try {
        const res = await fetch(CONFIG.SECURITY.IP_WORKER_URL, {
            method: "GET",
            credentials: "omit",
            cache: "no-store"
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const ip = (data && typeof data.ip === "string" && data.ip.trim()) ? data.ip.trim() : null;
        if (!ip) throw new Error("IP absente de la réponse Worker");
        return { ip, ua: clientUa, source: "worker" };
    } catch (e) {
        console.warn("[vendor-contract] IP Worker indisponible, ipSource=unavailable.", e?.message || e);
        return { ip: "unknown", ua: clientUa, source: "unavailable" };
    }
}

/* ============================================================
   HASH SHA-256 (Web Crypto obligatoire)
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
 * @throws {Error} si le texte est vide ou si Web Crypto est indisponible.
 */
export async function computeContractTextHash(contractText) {
    if (!contractText || typeof contractText !== "string") {
        throw new Error("computeContractTextHash : texte de contrat invalide.");
    }
    return await generateHash(contractText);
}

/* ============================================================
   SIGNATURE VERSIONNÉE
   ============================================================
   B-VC-1 : utilise runTransaction pour la phase get + set.
   L'atomicité empêche la race condition sur double-signature.
   ============================================================ */

/**
 * Signe un contrat vendeur et crée le document contracts/{id}
 * correspondant (ID versionné).
 *
 * @param {string} userId - UID Firebase réel du vendeur.
 * @param {string} contractText - Texte exact du contrat signé.
 * @param {Object} [preSignatureData]
 * @param {string} [preSignatureData.textHash] - Hash pré-calculé (optionnel).
 * @param {string} [preSignatureData.language] - 'fr' | 'ar' | 'en'.
 * @param {string} [preSignatureData.version] - Semver (défaut: CONFIG.VENDOR.CONTRACT_VERSION).
 * @param {Object} [preSignatureData.termsSnapshot] - Snapshot figé.
 * @param {string} [preSignatureData.source] - 'signup' | 'dashboard' | 'resign'.
 * @returns {Promise<{ success: boolean, contractId: string, version: string, hash: string, textHash: string, ip: string, ipSource: string }>}
 * @throws {Error} si signé déjà, ou si la sauvegarde échoue.
 */
export async function signVendorContract(userId, contractText, preSignatureData = {}) {
    if (!userId || typeof userId !== "string" || userId.startsWith("temp_")) {
        throw new Error("signVendorContract : UID Firebase réel requis (pas de temp_…).");
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

    const contractId = getContractId(userId, version);
    const contractDocRef = doc(db, "contracts", contractId);

    /* Capture IP + UA (async, avant la transaction). */
    const { ip, ua, source: ipSource } = await captureIpAndUa();
    const truncatedUa = (ua || "unknown").slice(0, 300);

    /* Hash du texte + hash de contexte. */
    const textHash = (typeof preSignatureData.textHash === "string" && SHA256_HEX_RE.test(preSignatureData.textHash))
        ? preSignatureData.textHash.toLowerCase()
        : await computeContractTextHash(contractText);

    const contextString = [userId, version, language, textHash].join("|");
    const contractHash = await generateHash(contextString);

    const contractData = {
        vendorId: userId,
        version: version,
        language: language,
        acceptedAt: serverTimestamp(),
        ipAddress: ip,
        ipSource: ipSource,
        userAgent: truncatedUa,
        contractHash: contractHash,
        textHash: textHash,
        termsSnapshot: termsSnapshot,
        source: source,
        status: "accepted"
    };

    /* B-VC-1 : transaction pour get + set atomiques. */
    try {
        await runTransaction(db, async (transaction) => {
            const existing = await transaction.get(contractDocRef);
            if (existing.exists()) {
                throw new Error("CONTRACT_ALREADY_SIGNED");
            }
            transaction.set(contractDocRef, contractData);
        });

        return {
            success: true,
            contractId: contractId,
            version: version,
            hash: contractHash,
            textHash: textHash,
            ip: ip,
            ipSource: ipSource
        };
    } catch (e) {
        if (e && e.message === "CONTRACT_ALREADY_SIGNED") {
            throw e;
        }
        console.error("[vendor-contract] Erreur sauvegarde contrat :", e?.message || e);
        if (e && (e.code === "permission-denied" || e.code === "already-exists")) {
            throw new Error("Contrat déjà signé ou accès refusé.");
        }
        throw new Error("Impossible d'enregistrer la signature du contrat.");
    }
}

/* ============================================================
   VÉRIFICATION D'INTÉGRITÉ
   ============================================================
   Compatible 1.1.0 ET 1.2.0 (les deux gabarits existent dans
   vendor-contract-text.js v9.0.0).
   ============================================================ */

/**
 * Vérifie l'intégrité d'un document contrat en recalculant les
 * hash (textHash et contractHash) depuis le snapshot stocké.
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
            return { ok: false, textHashOk: false, contractHashOk: false, reason: "version inconnue ou invalide" };
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
            return { ok: false, textHashOk: false, contractHashOk: false, reason: "gabarit introuvable pour cette version" };
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
console.log("[vendor-contract] v9.0.0 chargé (Lot 27 : transaction + JSDoc)");