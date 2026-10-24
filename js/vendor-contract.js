/* ============================================================
   js/vendor-contract.js
   Signature électronique du contrat vendeur — T9 (v1.2.0)

   Correctifs T9 :
   C1 — ID versionné contract_<uid>_v<semver> (re-signature possible)
   C2 — textHash sur texte figé (getContractText + termsSnapshot)
   C3 — verifyContractIntegrity() : recalcul + comparaison des hash
   C6 — userAgent tronqué à 300 car., source (signup|dashboard|resign),
        termsSnapshot figé dans le document

   NOUVEAUX EXPORTS : verifyContractIntegrity, compareVersions,
   getContractId, isContractCurrent, needsResign

   DÉPENDANCES (à charger ensemble — v-contract + v-contract-text) :
   - ./vendor-contract-text.js : getContractText, buildTermsSnapshot
   - ./config.js : CONFIG.VENDOR.CONTRACT_VERSION, CONFIG.SECURITY.*
   - ./firebase.js : db

   RAPPEL : toute modification d'un gabarit ⇒ nouvelle version dans
   vendor-contract-text.js. On n'édite JAMAIS un gabarit publié.
   ============================================================ */

import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG } from "./config.js";
import { getContractText, buildTermsSnapshot } from "./vendor-contract-text.js";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const ALLOWED_LANGS = ["fr", "ar", "en"];
const ALLOWED_SOURCES = ["signup", "dashboard", "resign"];

/* ---------- Helpers internes ---------- */

function parseVersion(str) {
    if (typeof str !== "string") return null;
    const s = str.trim();
    if (!SEMVER_RE.test(s)) return null;
    const parts = s.split(".");
    return { major: Number(parts[0]), minor: Number(parts[1]), patch: Number(parts[2]) };
}

/* ---------- Semver / IDs / politique de re-signature ---------- */

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

export function getContractId(userId, version = CONFIG.VENDOR.CONTRACT_VERSION) {
    if (!userId || typeof userId !== "string" || userId.startsWith("temp_")) {
        throw new Error("getContractId : UID Firebase réel requis.");
    }
    if (!version || typeof version !== "string" || !SEMVER_RE.test(version)) {
        throw new Error("getContractId : version semver requise (x.y.z).");
    }
    return `contract_${userId}_v${version}`;
}

/* Politique : seuls les changements majeur/mineur imposent une re-signature.
   Un patch (1.1.0 → 1.1.5) n'en impose pas. */
export function needsResign(vendorInfo) {
    if (!vendorInfo || typeof vendorInfo !== "object") return true;
    const v = parseVersion(vendorInfo.contractVersion);
    const c = parseVersion(CONFIG.VENDOR.CONTRACT_VERSION);
    if (!v || !c) return true;
    if (v.major < c.major) return true;
    if (v.major > c.major) return false;
    if (v.minor < c.minor) return true;
    return false;
}

export function isContractCurrent(vendorInfo) {
    return !needsResign(vendorInfo);
}

/* ---------- Capture IP + UA via Worker Cloudflare ---------- */

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
        console.warn("[vendor-contract] IP Worker indisponible, ipSource=unavailable.", e);
        return { ip: "unknown", ua: clientUa, source: "unavailable" };
    }
}

/* ---------- SHA-256 (Web Crypto obligatoire) ---------- */

async function generateHash(text) {
    if (typeof crypto === "undefined" || !crypto.subtle) {
        throw new Error("Hash non supporté (Web Crypto indisponible). Le site doit être servi en HTTPS.");
    }
    const buf = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest(CONFIG.SECURITY.CONTRACT_HASH_ALGO, buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function computeContractTextHash(contractText) {
    if (!contractText || typeof contractText !== "string") {
        throw new Error("computeContractTextHash : texte de contrat invalide.");
    }
    return await generateHash(contractText);
}

/* ---------- Signature versionnée ---------- */

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

    try {
        const existing = await getDoc(contractDocRef);
        if (existing.exists()) throw new Error("CONTRACT_ALREADY_SIGNED");
    } catch (e) {
        if (e && e.message === "CONTRACT_ALREADY_SIGNED") throw e;
        console.warn("[vendor-contract] Pré-vérification impossible (règles Firestore ?), on continue.", e);
    }

    const { ip, ua, source: ipSource } = await captureIpAndUa();
    const truncatedUa = (ua || "unknown").slice(0, 300);

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

    try {
        await setDoc(contractDocRef, contractData);
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
        console.error("[vendor-contract] Erreur sauvegarde contrat :", e);
        if (e && (e.code === "permission-denied" || e.code === "already-exists")) {
            throw new Error("Contrat déjà signé ou accès refusé.");
        }
        throw new Error("Impossible d'enregistrer la signature du contrat.");
    }
}

/* ---------- Vérification d'intégrité ---------- */

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