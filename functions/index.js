const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");

initializeApp();
const db = getFirestore();
const PROJECT_ID = "smartswi9a-31063";
// Web API key is a public Firebase client identifier, not an Admin credential.
// Restrict it in Google Cloud API settings to the APIs and website domains you use.
const FIREBASE_WEB_API_KEY = "AIzaSyBhULwDxPBRqjywsSD_0ny41Bmt968ofSA";
const ALLOWED_ORIGINS = new Set([
  "https://smartswi9a.top",
  "https://www.smartswi9a.top",
]);

function cors(req, res) {
  const origin = req.get("origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  if (req.method !== "POST") {
    res.status(405).json({ success: false, message: "Méthode non autorisée." });
    return true;
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    res.status(403).json({ success: false, message: "Origine non autorisée." });
    return true;
  }
  return false;
}
function validPassword(p) {
  return (
    typeof p === "string" &&
    p.length >= 8 &&
    p.length <= 128 &&
    /[A-Za-z]/.test(p) &&
    /\d/.test(p)
  );
}
function validEmail(e) {
  return (
    typeof e === "string" &&
    e.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
  );
}
async function findUserByEmail(email) {
  const snap = await db
    .collection("users")
    .where("email", "==", email)
    .limit(2)
    .get();
  if (snap.empty) return null;
  // Do not allow ambiguous duplicate profile email records.
  if (snap.size > 1)
    throw new Error(
      "Plusieurs profils utilisent cette adresse. Contactez l’assistance."
    );
  return { uid: snap.docs[0].id, data: snap.docs[0].data() };
}
function approved(profile) {
  return (
    profile &&
    profile.role === "vendor" &&
    profile.vendorInfo &&
    profile.vendorInfo.status === "approved" &&
    profile.vendorInfo.contractStatus === "accepted"
  );
}
function statusMessage(profile) {
  const status = profile?.vendorInfo?.status;
  if (status === "pending")
    return "Votre demande vendeur est en attente de validation par l’administrateur.";
  if (status === "rejected")
    return "Votre demande vendeur a été refusée. Contactez l’administration.";
  if (status === "suspended")
    return "Votre accès vendeur est suspendu. Contactez l’administration.";
  if (status === "approved")
    return "Votre contrat vendeur doit être accepté avant l’accès au tableau de bord.";
  return "Ce compte ne dispose pas d’un accès vendeur approuvé.";
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
function throttleId(email, ip) {
  return crypto
    .createHash("sha256")
    .update(`${email}|${ip || "unknown"}`)
    .digest("hex");
}
async function isLoginThrottled(email, ip) {
  const ref = db.collection("vendorLoginThrottle").doc(throttleId(email, ip));
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data();
  const now = Date.now();
  if (data.windowStartedAt && now - data.windowStartedAt > LOGIN_WINDOW_MS) {
    await ref.delete().catch(() => {});
    return false;
  }
  return (
    Number(data.failures || 0) >= LOGIN_MAX_FAILURES &&
    Number(data.windowStartedAt || now) + LOGIN_WINDOW_MS > now
  );
}
async function recordLoginFailure(email, ip) {
  const ref = db.collection("vendorLoginThrottle").doc(throttleId(email, ip));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data() : {};
    const inWindow =
      data.windowStartedAt && now - data.windowStartedAt <= LOGIN_WINDOW_MS;
    tx.set(ref, {
      email,
      ip: String(ip || "unknown").slice(0, 80),
      failures: inWindow ? Number(data.failures || 0) + 1 : 1,
      windowStartedAt: inWindow ? data.windowStartedAt : now,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}
async function clearLoginFailures(email, ip) {
  await db
    .collection("vendorLoginThrottle")
    .doc(throttleId(email, ip))
    .delete()
    .catch(() => {});
}

exports.setVendorPassword = onRequest(
  { region: "europe-west1", maxInstances: 5, timeoutSeconds: 15 },
  async (req, res) => {
    if (cors(req, res)) return;
    try {
      const authHeader = req.get("authorization") || "";
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match)
        return res
          .status(401)
          .json({
            success: false,
            message: "Connexion requise. Reconnectez-vous puis réessayez.",
          });
      const decoded = await getAuth().verifyIdToken(match[1], true);
      const vendorPassword = req.body?.vendorPassword;
      if (!validPassword(vendorPassword))
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Le mot de passe vendeur doit contenir au moins 8 caractères, des lettres et des chiffres.",
          });
      const ref = db.collection("users").doc(decoded.uid);
      const snap = await ref.get();
      if (!snap.exists)
        return res
          .status(403)
          .json({ success: false, message: "Profil utilisateur introuvable." });
      const profile = snap.data();
      if (
        profile.role !== "vendor" ||
        !profile.vendorInfo ||
        !["pending", "approved"].includes(profile.vendorInfo.status)
      ) {
        return res
          .status(403)
          .json({
            success: false,
            message:
              "La demande vendeur doit être enregistrée avant de définir ce mot de passe.",
          });
      }
      const passwordHash = await bcrypt.hash(vendorPassword, 12);
      await db
        .collection("vendorCredentials")
        .doc(decoded.uid)
        .set(
          {
            uid: decoded.uid,
            email: String(profile.email || decoded.email || "")
              .trim()
              .toLowerCase(),
            passwordHash,
            updatedAt: FieldValue.serverTimestamp(),
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("[setVendorPassword]", error?.message || error);
      return res
        .status(500)
        .json({
          success: false,
          message:
            "Impossible d’enregistrer le mot de passe vendeur. Réessayez.",
        });
    }
  }
);

exports.loginVendor = onRequest(
  { region: "europe-west1", maxInstances: 5, timeoutSeconds: 20 },
  async (req, res) => {
    if (cors(req, res)) return;
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = req.body?.password;
    if (
      !validEmail(email) ||
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 128
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Adresse e-mail ou mot de passe invalide.",
        });
    }
    const clientIp = String(req.ip || req.get("x-forwarded-for") || "unknown")
      .split(",")[0]
      .trim()
      .slice(0, 80);
    try {
      if (await isLoginThrottled(email, clientIp)) {
        return res
          .status(429)
          .json({
            success: false,
            message: "Trop de tentatives. Réessayez dans 15 minutes.",
          });
      }
      const userRecord = await findUserByEmail(email);
      if (!userRecord) {
        await recordLoginFailure(email, clientIp);
        return res
          .status(401)
          .json({
            success: false,
            message: "Identifiants incorrects ou compte vendeur introuvable.",
          });
      }
      const { uid, data: profile } = userRecord;
      // Check the independent seller password first.
      const credentialSnap = await db
        .collection("vendorCredentials")
        .doc(uid)
        .get();
      let validCredential = false;
      if (credentialSnap.exists) {
        const credential = credentialSnap.data();
        if (credential.email === email && credential.passwordHash) {
          validCredential = await bcrypt.compare(
            password,
            credential.passwordHash
          );
        }
      }
      // If that did not match, ask Firebase Authentication to verify the buyer password.
      if (!validCredential) {
        const authResponse = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, returnSecureToken: true }),
          }
        );
        if (authResponse.ok) {
          const authData = await authResponse.json();
          validCredential =
            authData.localId === uid &&
            String(authData.email || "").toLowerCase() === email;
        }
      }
      if (!validCredential) {
        await recordLoginFailure(email, clientIp);
        return res
          .status(401)
          .json({
            success: false,
            message: "Identifiants incorrects ou compte vendeur introuvable.",
          });
      }
      await clearLoginFailures(email, clientIp);
      if (!approved(profile))
        return res
          .status(403)
          .json({ success: false, message: statusMessage(profile) });
      const customToken = await getAuth().createCustomToken(uid, {
        vendorLogin: true,
      });
      return res.status(200).json({ success: true, customToken });
    } catch (error) {
      console.error("[loginVendor]", error?.message || error);
      return res
        .status(500)
        .json({
          success: false,
          message:
            "Erreur temporaire de connexion. Réessayez dans quelques instants.",
        });
    }
  }
);

exports.acceptVendorContract = onRequest(
  { region: "europe-west1", maxInstances: 5, timeoutSeconds: 15 },
  async (req, res) => {
    if (cors(req, res)) return;
    try {
      const authHeader = req.get("authorization") || "";
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match)
        return res
          .status(401)
          .json({ success: false, message: "Connexion requise." });
      const decoded = await getAuth().verifyIdToken(match[1], true);
      const contractId = String(req.body?.contractId || "");
      const version = String(req.body?.version || "");
      if (
        !/^contract_[A-Za-z0-9_-]+_v\d+\.\d+\.\d+$/.test(contractId) ||
        !/^\d+\.\d+\.\d+$/.test(version)
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Référence de contrat invalide." });
      }
      const expectedPrefix = `contract_${decoded.uid}_v`;
      if (!contractId.startsWith(expectedPrefix))
        return res
          .status(403)
          .json({ success: false, message: "Contrat non autorisé." });
      const userRef = db.collection("users").doc(decoded.uid);
      const contractRef = db.collection("contracts").doc(contractId);
      const [userSnap, contractSnap] = await Promise.all([
        userRef.get(),
        contractRef.get(),
      ]);
      if (!userSnap.exists || !contractSnap.exists)
        return res
          .status(404)
          .json({ success: false, message: "Profil ou contrat introuvable." });
      const profile = userSnap.data();
      const contract = contractSnap.data();
      if (
        profile.role !== "vendor" ||
        !profile.vendorInfo ||
        !["pending", "approved"].includes(profile.vendorInfo.status)
      ) {
        return res
          .status(403)
          .json({
            success: false,
            message: "La demande vendeur n’est pas valide.",
          });
      }
      if (
        contract.vendorId !== decoded.uid ||
        contract.status !== "accepted" ||
        contract.version !== version ||
        contractId !== `contract_${decoded.uid}_v${version}` ||
        !["fr", "ar", "en"].includes(contract.language) ||
        !contract.termsSnapshot ||
        typeof contract.termsSnapshot !== "object" ||
        !/^[0-9a-f]{64}$/i.test(contract.textHash || "") ||
        !/^[0-9a-f]{64}$/i.test(contract.contractHash || "")
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message: "La signature du contrat est invalide.",
          });
      }
      const expectedHash = crypto
        .createHash("sha256")
        .update(
          [decoded.uid, version, contract.language, contract.textHash].join("|")
        )
        .digest("hex");
      if (expectedHash !== String(contract.contractHash).toLowerCase())
        return res
          .status(400)
          .json({
            success: false,
            message: "La vérification cryptographique du contrat a échoué.",
          });
      await userRef.update({
        "vendorInfo.contractStatus": "accepted",
        "vendorInfo.currentContractId": contractId,
        "vendorInfo.contractVersion": version,
        "vendorInfo.contractSignedAt":
          contract.acceptedAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("[acceptVendorContract]", error?.message || error);
      return res
        .status(500)
        .json({
          success: false,
          message: "Impossible de valider le contrat pour le moment.",
        });
    }
  }
);