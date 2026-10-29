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

/* Customer checkout is performed on the trusted server. Prices, stock, seller approval, coupons and totals are read from Firestore, never trusted from the browser. */

/* ============================================================ ACTIONS ADMIN SUR LES VENDEURS Utilise par /api/adminVendorAction depuis le tableau admin. Les contrôles d'autorisation sont faits côté serveur. ============================================================ */
exports.adminVendorAction = onRequest(
  { region: "europe-west1", maxInstances: 5, timeoutSeconds: 30 },
  async (req, res) => {
    if (cors(req, res)) return;
    try {
      const match = String(req.get("authorization") || "").match(
        /^Bearer\s+(.+)$/i
      );
      if (!match)
        return res
          .status(401)
          .json({
            success: false,
            message: "Connexion administrateur requise.",
          });
      const decoded = await getAuth().verifyIdToken(match[1], true);
      const adminSnap = await db.collection("users").doc(decoded.uid).get();
      if (!adminSnap.exists || adminSnap.data()?.role !== "admin") {
        return res
          .status(403)
          .json({
            success: false,
            message: "Action réservée à un administrateur.",
          });
      }

      const vendorId = String(req.body?.vendorId || "").trim();
      const action = String(req.body?.action || "").trim();
      if (
        !vendorId ||
        vendorId.length > 150 ||
        /[\/\u0000-\u001f]/.test(vendorId)
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Identifiant vendeur invalide." });
      }
      if (vendorId === decoded.uid)
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Vous ne pouvez pas effectuer cette action sur votre propre compte.",
          });
      if (!["approved", "rejected", "suspended", "deleted"].includes(action)) {
        return res
          .status(400)
          .json({ success: false, message: "Action vendeur non reconnue." });
      }

      const vendorRef = db.collection("users").doc(vendorId);
      const vendorSnap = await vendorRef.get();
      if (!vendorSnap.exists || vendorSnap.data()?.role !== "vendor") {
        return res
          .status(404)
          .json({ success: false, message: "Profil vendeur introuvable." });
      }
      const vendor = vendorSnap.data();

      if (
        action === "approved" &&
        vendor.vendorInfo?.contractStatus !== "accepted"
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "Impossible d’approuver ce vendeur : le contrat doit être signé.",
          });
      }

      if (action === "deleted") {
        // Supprimer les produits du vendeur par lots bornés, tout en conservant
        // commandes, contrats, portefeuilles et écritures financières pour audit.
        let deletedProducts = 0;
        let productsRemaining = false;
        for (let page = 0; page < 20; page++) {
          const productsSnap = await db
            .collection("products")
            .where("vendorId", "==", vendorId)
            .limit(400)
            .get();
          if (productsSnap.empty) {
            productsRemaining = false;
            break;
          }
          const batch = db.batch();
          productsSnap.docs.forEach((docSnap) => batch.delete(docSnap.ref));
          await batch.commit();
          deletedProducts += productsSnap.size;
          productsRemaining = productsSnap.size === 400;
          if (!productsRemaining) break;
        }
        if (productsRemaining) {
          return res
            .status(409)
            .json({
              success: false,
              message:
                "Suppression interrompue : trop de produits pour un seul traitement. Le profil et le compte vendeur sont conservés ; contactez l’assistance.",
              deletedProducts,
            });
        }
        await vendorRef.delete();
        try {
          await getAuth().deleteUser(vendorId);
        } catch (authErr) {
          if (authErr.code !== "auth/user-not-found") {
            console.error(
              "[adminVendorAction] Suppression Auth incomplète:",
              authErr.code || authErr.message
            );
            return res
              .status(500)
              .json({
                success: false,
                message:
                  "Profil supprimé, mais la suppression du compte Auth a échoué. Vérifiez Firebase Authentication.",
              });
          }
        }
        return res.status(200).json({ success: true, action, deletedProducts });
      }

      await vendorRef.update({
        "vendorInfo.status": action,
        "vendorInfo.statusUpdatedAt": FieldValue.serverTimestamp(),
        "vendorInfo.statusUpdatedBy": decoded.uid,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ success: true, action });
    } catch (error) {
      console.error(
        "[adminVendorAction]",
        error?.code || "",
        error?.message || error
      );
      const message =
        error?.code === "auth/id-token-expired" ||
        error?.code === "auth/invalid-id-token"
          ? "Session administrateur expirée. Reconnectez-vous."
          : error?.message || "Action vendeur impossible.";
      return res.status(500).json({ success: false, message });
    }
  }
);

exports.createCustomerOrder = onRequest(
  { region: "europe-west1", maxInstances: 10, timeoutSeconds: 30 },
  async (req, res) => {
    if (cors(req, res)) return;
    try {
      const match = String(req.get("authorization") || "").match(
        /^Bearer\s+(.+)$/i
      );
      if (!match)
        return res
          .status(401)
          .json({ success: false, message: "Connexion requise." });
      const decoded = await getAuth().verifyIdToken(match[1], true);
      const input = req.body || {};
      const delivery = input.deliveryInfo || {};
      const rawItems = Array.isArray(input.items) ? input.items : [];
      if (!rawItems.length || rawItems.length > 50)
        return res
          .status(400)
          .json({ success: false, message: "Panier vide ou trop volumineux." });
      for (const k of ["name", "phone", "address", "city"]) {
        if (typeof delivery[k] !== "string" || !delivery[k].trim())
          return res
            .status(400)
            .json({
              success: false,
              message: `Champ de livraison obligatoire : ${k}`,
            });
      }
      if (
        delivery.phone.trim().length > 20 ||
        delivery.address.trim().length > 300
      )
        return res
          .status(400)
          .json({
            success: false,
            message: "Coordonnées de livraison invalides.",
          });
      const merged = new Map();
      for (const it of rawItems) {
        const productId = String(it?.productId ?? "").trim();
        const qty = Math.floor(Number(it?.quantity));
        if (!productId || !Number.isFinite(qty) || qty < 1 || qty > 99)
          return res
            .status(400)
            .json({ success: false, message: "Article ou quantité invalide." });
        const v =
          it.variant && typeof it.variant === "object"
            ? {
                size: String(it.variant.size || ""),
                color: String(it.variant.color || ""),
              }
            : null;
        const key = JSON.stringify([productId, v?.size || "", v?.color || ""]);
        const old = merged.get(key);
        if (old) old.quantity += qty;
        else
          merged.set(key, {
            productId,
            quantity: qty,
            variant: v,
            id: String(it.id || productId),
          });
      }
      const items = [...merged.values()];
      if (items.some((i) => i.quantity > 99))
        return res
          .status(400)
          .json({ success: false, message: "Quantité maximale dépassée." });
      const orderRef = db.collection("orders").doc();
      const couponId = String(input.appliedCoupon?.id || "").trim();
      const outcome = await db.runTransaction(async (tx) => {
        const productRefs = items.map((i) =>
          db.collection("products").doc(i.productId)
        );
        const productSnaps = await Promise.all(
          productRefs.map((ref) => tx.get(ref))
        );
        const vendorIdsSet = new Set();
        for (let i = 0; i < productSnaps.length; i++) {
          if (!productSnaps[i].exists)
            throw new Error(`Produit ${items[i].productId} introuvable.`);
          const pd = productSnaps[i].data();
          if (pd.status && pd.status !== "approved")
            throw new Error(
              `Le produit ${
                pd.nameFr || pd.nameEn || ""
              } n'est plus disponible.` ); const vid = String(pd.vendorId || "smartswi9a"); if (vid !== "smartswi9a") vendorIdsSet.add(vid); } const vendorIds = [...vendorIdsSet]; const vendorSnaps = await Promise.all( vendorIds.map((id) => tx.get(db.collection("vendorsPublic").doc(id))) ); vendorSnaps.forEach((snap, i) => { if (!snap.exists || snap.data().status !== "approved") throw new Error(`Le vendeur ${vendorIds[i]} n'est pas actif.`);
        });
        let citySnap = null;
        if (delivery.cityId)
          citySnap = await tx.get(
            db.collection("cities").doc(String(delivery.cityId))
          );
        let couponSnap = null,
          couponUseSnap = null;
        if (couponId) {
          couponSnap = await tx.get(db.collection("coupons").doc(couponId));
          if (couponSnap.exists && couponSnap.data().oneUsePerUser === true)
            couponUseSnap = await tx.get(
              db.collection("coupon_uses").doc(`${couponId}_${decoded.uid}`)
            );
        }
        let subtotal = 0,
          discountableItems = 0;
        const validatedItems = [];
        const productUpdates = new Map();
        const workingProducts = new Map(
          productSnaps.map((snap, i) => [
            items[i].productId,
            {
              ...snap.data(),
              variants: Array.isArray(snap.data().variants)
                ? snap.data().variants.map((v) => ({ ...v }))
                : undefined,
            },
          ])
        );
        for (let i = 0; i < items.length; i++) {
          const item = items[i],
            snap = productSnaps[i],
            data = workingProducts.get(item.productId),
            qty = item.quantity;
          let stock = 0,
            price = Number(data.price) || 0;
          const update = productUpdates.get(item.productId)?.data || {
            salesCount: Number(data.salesCount) || 0,
          };
          update.salesCount = (Number(update.salesCount) || 0) + qty;
          update.lastOrderId = orderRef.id;
          update.updatedAt = FieldValue.serverTimestamp();
          if (item.variant) {
            const variants = Array.isArray(update.variants)
              ? update.variants.map((v) => ({ ...v }))
              : Array.isArray(data.variants)
              ? data.variants.map((v) => ({ ...v }))
              : [];
            const idx = variants.findIndex(
              (v) =>
                String(v.size || "") === item.variant.size &&
                String(v.color || "") === item.variant.color
            );
            if (idx < 0)
              throw new Error(
                `Variante indisponible pour ${
                  data.nameFr || data.nameEn || item.productId
                }.`
              );
            stock = Number(variants[idx].stock) || 0;
            const vp = Number(variants[idx].price);
            if (Number.isFinite(vp) && vp > 0) price = vp;
            if (stock < qty)
              throw new Error(
                `Stock insuffisant pour ${
                  data.nameFr || data.nameEn || item.productId
                }.`
              );
            variants[idx].stock = stock - qty;
            update.variants = variants;
            update.stock = variants.reduce(
              (sum, v) => sum + (Number(v.stock) || 0),
              0
            );
            data.variants = variants;
            data.stock = update.stock;
          } else {
            stock = Number(update.stock ?? data.stock) || 0;
            if (stock < qty)
              throw new Error(
                `Stock insuffisant pour ${
                  data.nameFr || data.nameEn || item.productId
                }.`
              );
            update.stock = stock - qty;
            data.stock = update.stock;
          }
          data.salesCount = update.salesCount;
          productUpdates.set(item.productId, {
            ref: productRefs[i],
            data: update,
          });
          if (!Number.isFinite(price) || price <= 0)
            throw new Error(
              `Prix invalide pour ${
                data.nameFr || data.nameEn || item.productId
              }.`
            );
          subtotal += price * qty;
          discountableItems += qty;
          validatedItems.push({
            id: item.id,
            productId: item.productId,
            vendorId: String(data.vendorId || "smartswi9a"),
            variant: item.variant,
            quantity: qty,
            price,
            name: String(data.nameFr || data.nameEn || "Produit"),
            weight: Number(data.dimensions?.weight) || 0,
          });
        }
        const cityData = citySnap?.exists ? citySnap.data() : null;
        const deliveryFee = cityData
          ? Math.max(0, Number(cityData.price) || 0)
          : 0;
        const discount =
          discountableItems >= 3 ? Math.round(subtotal * 0.05) : 0;
        let couponDiscount = 0,
          couponData = null;
        if (couponId) {
          if (!couponSnap?.exists) throw new Error("Code promo introuvable.");
          const c = couponSnap.data();
          if (c.isActive !== true) throw new Error("Code promo inactif.");
          if (c.expiresAt) {
            const exp = c.expiresAt.toDate
              ? c.expiresAt.toDate()
              : new Date(c.expiresAt);
            if (exp.getTime() < Date.now())
              throw new Error("Code promo expiré.");
          }
          if (
            Number(c.maxUses) > 0 &&
            (Number(c.usedCount) || 0) >= Number(c.maxUses)
          )
            throw new Error("Code promo épuisé.");
          if (Number(c.minPurchase) > 0 && subtotal < Number(c.minPurchase))
            throw new Error(`Minimum ${Number(c.minPurchase)} MAD requis.`);
          if (c.oneUsePerUser === true && couponUseSnap?.exists)
            throw new Error("Vous avez déjà utilisé ce code promo.");
          const value = Math.max(0, Number(c.value) || 0);
          if (c.type === "percentage")
            couponDiscount = Math.round(
              (subtotal * Math.min(100, value)) / 100
            );
          else if (c.type === "fixed")
            couponDiscount = Math.min(value, subtotal);
          else if (c.type === "free_shipping") couponDiscount = deliveryFee;
          if (couponDiscount <= 0)
            throw new Error("Ce code ne produit aucune réduction.");
          couponData = c;
        }
        const totalDiscount = Math.min(discount + couponDiscount, subtotal),
          total = Math.max(0, subtotal - totalDiscount + deliveryFee);
        const now = Date.now(),
          vendorList = [
            ...new Set(
              validatedItems
                .map((i) => i.vendorId)
                .filter((v) => v && v !== "smartswi9a")
            ),
          ];
        const orderData = {
          _test: false,
          _testBatch: null,
          userId: decoded.uid,
          userName: String(delivery.name).trim().slice(0, 100),
          userEmail: String(decoded.email || delivery.email || ""),
          items: validatedItems,
          vendorIds: vendorList,
          status: "pending",
          paymentStatus: "unpaid",
          subtotal,
          discount,
          couponId: couponData ? couponId : null,
          couponCode: couponData
            ? String(couponData.code || input.appliedCoupon?.code || "")
            : null,
          couponDiscount,
          deliveryFee,
          total,
          stockDeducted: true,
          couponRestored: false,
          deliveryAddress: {
            name: String(delivery.name).trim().slice(0, 100),
            phone: String(delivery.phone).trim().slice(0, 20),
            address: String(delivery.address).trim().slice(0, 300),
            city: String(delivery.city).trim().slice(0, 100),
            cityId: delivery.cityId ? String(delivery.cityId) : null,
            cityAr: delivery.cityAr ? String(delivery.cityAr) : null,
            cityFr: delivery.cityFr ? String(delivery.cityFr) : null,
            email: String(delivery.email || decoded.email || ""),
            note: delivery.note
              ? String(delivery.note).trim().slice(0, 300)
              : null,
          },
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          cancellableUntil: new Date(now + 4 * 3600000),
          cancelledAt: null,
        };
        productUpdates.forEach((u) => tx.update(u.ref, u.data));
        tx.set(orderRef, orderData);
        if (couponData) {
          tx.update(db.collection("coupons").doc(couponId), {
            usedCount: FieldValue.increment(1),
          });
          tx.set(
            db.collection("coupon_uses").doc(`${couponId}_${decoded.uid}`),
            {
              couponId,
              code: String(couponData.code || ""),
              userId: decoded.uid,
              orderId: orderRef.id,
              discountApplied: couponDiscount,
              usedAt: FieldValue.serverTimestamp(),
            }
          );
        }
        const notifRef = db.collection("notifications").doc();
        tx.set(notifRef, {
          userId: decoded.uid,
          type: "order_created",
          title: "Commande reçue",
          message: `Merci pour votre commande #${orderRef.id
            .slice(0, 8)
            .toUpperCase()} !`,
          orderId: orderRef.id,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
        });
        return {
          orderId: orderRef.id,
          totals: {
            subtotal,
            discount,
            couponCode: orderData.couponCode,
            couponDiscount,
            deliveryFee,
            total,
            vendorIds: vendorList,
          },
          validatedItems,
        };
      });
      return res.status(200).json({ success: true, ...outcome });
    } catch (error) {
      console.error("[createCustomerOrder]", error?.message || error);
      return res
        .status(400)
        .json({
          success: false,
          message: error.message || "Création de commande impossible.",
        });
    }
  }
);

exports.cancelCustomerOrder = onRequest(
  { region: "europe-west1", maxInstances: 10, timeoutSeconds: 30 },
  async (req, res) => {
    if (cors(req, res)) return;
    try {
      const match = String(req.get("authorization") || "").match(
        /^Bearer\s+(.+)$/i
      );
      if (!match)
        return res
          .status(401)
          .json({ success: false, message: "Connexion requise." });
      const decoded = await getAuth().verifyIdToken(match[1], true);
      const orderId = String(req.body?.orderId || "").trim();
      if (!orderId || orderId.length > 150)
        return res
          .status(400)
          .json({ success: false, message: "Commande invalide." });
      await db.runTransaction(async (tx) => {
        const orderRef = db.collection("orders").doc(orderId),
          orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) throw new Error("Commande introuvable.");
        const order = orderSnap.data();
        if (order.userId !== decoded.uid) throw new Error("Non autorisé.");
        if (!["pending", "confirmed"].includes(order.status))
          throw new Error("Cette commande ne peut plus être annulée.");
        const created = order.createdAt?.toDate
          ? order.createdAt.toDate().getTime()
          : Date.now();
        const deadline = order.cancellableUntil?.toDate
          ? order.cancellableUntil.toDate().getTime()
          : created + 4 * 3600000;
        if (Date.now() > deadline)
          throw new Error("Le délai d’annulation est dépassé.");
        const items = Array.isArray(order.items) ? order.items : [];
        const productIds = [...new Set(items.map((i) => String(i.productId)))];
        const refs = productIds.map((id) => db.collection("products").doc(id));
        const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
        let couponSnap = null,
          couponUseSnap = null;
        if (order.couponId && !order.couponRestored) {
          couponSnap = await tx.get(
            db.collection("coupons").doc(String(order.couponId))
          );
          couponUseSnap = await tx.get(
            db.collection("coupon_uses").doc(`${order.couponId}_${decoded.uid}`)
          );
        }
        if (order.stockDeducted === true) {
          for (let i = 0; i < productIds.length; i++) {
            if (!snaps[i].exists) continue;
            const p = snaps[i].data(),
              productItems = items.filter(
                (item) => String(item.productId) === productIds[i]
              );
            const upd = {
              salesCount: Math.max(
                0,
                (Number(p.salesCount) || 0) -
                  productItems.reduce(
                    (sum, item) =>
                      sum + Math.max(1, Math.floor(Number(item.quantity) || 1)),
                    0
                  )
              ),
              lastOrderId: orderId,
              updatedAt: FieldValue.serverTimestamp(),
            };
            const variants = Array.isArray(p.variants)
              ? p.variants.map((v) => ({ ...v }))
              : [];
            let simpleStock = Number(p.stock) || 0;
            for (const item of productItems) {
              const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
              if (item.variant) {
                const idx = variants.findIndex(
                  (v) =>
                    String(v.size || "") === String(item.variant.size || "") &&
                    String(v.color || "") === String(item.variant.color || "")
                );
                if (idx >= 0)
                  variants[idx].stock =
                    (Number(variants[idx].stock) || 0) + qty;
              } else simpleStock += qty;
            }
            if (productItems.some((item) => item.variant)) {
              upd.variants = variants;
              upd.stock = variants.reduce(
                (sum, v) => sum + (Number(v.stock) || 0),
                0
              );
            } else upd.stock = simpleStock;
            tx.update(refs[i], upd);
          }
        }
        if (order.couponId && !order.couponRestored) {
          if (couponSnap?.exists)
            tx.update(db.collection("coupons").doc(String(order.couponId)), {
              usedCount: FieldValue.increment(-1),
            });
          if (couponUseSnap?.exists)
            tx.delete(
              db
                .collection("coupon_uses")
                .doc(`${order.couponId}_${decoded.uid}`)
            );
        }
        tx.update(orderRef, {
          status: "cancelled",
          cancelledAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          stockDeducted: false,
          couponRestored: true,
        });
        tx.set(db.collection("notifications").doc(), {
          userId: decoded.uid,
          type: "order_cancelled",
          title: "Commande annulée",
          message: `Commande #${orderId.slice(0, 8).toUpperCase()} annulée.`,
          orderId,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      });
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("[cancelCustomerOrder]", error?.message || error);
      return res
        .status(400)
        .json({
          success: false,
          message: error.message || "Annulation impossible.",
        });
    }
  }
);