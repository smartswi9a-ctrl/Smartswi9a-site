#!/usr/bin/env node
/* ============================================================
   TESTS : PWA + notifications push/in-app (PHASE C)
   ------------------------------------------------------------
   Invariants statiques : manifest, Service Worker, cache,
   balises Apple, règles Firestore, déclencheurs Functions.
   Usage : node tests/pwa-notifications.test.mjs
   ============================================================ */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
let failures = 0;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log("PASS: " + name);
  } catch (error) {
    failures += 1;
    console.error("ECHEC: " + name + " -> " + error.message);
  }
}

/* ---------- 1. Manifest ---------- */
check("manifest.json installable", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.name, "Smartswika - Gadgets & Smart Home");
  assert.equal(manifest.short_name, "Smartswika");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.theme_color);
  assert.ok(manifest.background_color);
});

check("manifest : icônes 192 et 512 maskable", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const icons = manifest.icons || [];
  const has = (size, purpose) =>
    icons.some((icon) => icon.sizes === size && String(icon.purpose || "").includes(purpose));
  assert.ok(has("192x192", "maskable"), "192 maskable manquante");
  assert.ok(has("512x512", "maskable"), "512 maskable manquante");
  assert.ok(has("192x192", "any"), "192 any manquante");
  assert.ok(has("512x512", "any"), "512 any manquante");
});

check("icônes PWA présentes sur le disque", () => {
  for (const file of [
    "assets/pwa-192.png",
    "assets/pwa-512.png",
    "assets/pwa-maskable-192.png",
    "assets/pwa-maskable-512.png",
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), "absent : " + file);
  }
});

/* ---------- 2. Service Worker ---------- */
check("Service Worker unifié (cache + FCM)", () => {
  const sw = read("firebase-messaging-sw.js");
  assert.ok(sw.includes("firebase-messaging-compat.js"), "SDK FCM absent");
  assert.ok(sw.includes("onBackgroundMessage"), "handler background absent");
  assert.ok(sw.includes("notificationclick"), "click handler absent");
  assert.ok(sw.includes("showNotification"), "affichage notification absent");
  assert.ok(sw.includes("caches.open"), "cache PWA absent");
  assert.ok(sw.includes("SKIP_WAITING"), "mise à jour SW absente");
});

/* ---------- 3. Cache HTTP ---------- */
check("Cache no-store SW + manifest (Firebase)", () => {
  const config = JSON.parse(read("firebase.json"));
  const headers = config.hosting.headers || [];
  const rule = (source) => headers.find((h) => h.source === source);
  const sw = rule("/firebase-messaging-sw.js");
  const manifest = rule("/manifest.json");
  assert.ok(sw, "règle SW absente");
  assert.ok(manifest, "règle manifest absente");
  assert.ok(
    sw.headers.some((h) => h.key === "Cache-Control" && h.value.includes("no-store")),
    "Cache-Control SW"
  );
  assert.ok(
    manifest.headers.some((h) => h.key === "Cache-Control" && h.value.includes("no-store")),
    "Cache-Control manifest"
  );
});

check("Cache no-store SW + manifest (Cloudflare)", () => {
  const h = read("_headers");
  assert.ok(/\/firebase-messaging-sw\.js[\s\S]*?no-store/.test(h), "bloc SW absent");
  assert.ok(/\/manifest\.json[\s\S]*?no-store/.test(h), "bloc manifest absent");
});

/* ---------- 4. HTML ---------- */
check("index.html : manifest + Apple + CSS PWA", () => {
  const html = read("index.html");
  assert.ok(html.includes('rel="manifest" href="/manifest.json"'), "manifest link");
  assert.ok(html.includes("apple-mobile-web-app-capable"), "meta Apple");
  assert.ok(/\/css\/pwa\.[0-9a-f]{8}\.css/.test(html), "CSS PWA hashé");
});

/* ---------- 5. Règles Firestore ---------- */
check("règles : fcm_tokens verrouillés par rôle", () => {
  const rules = read("firestore.rules");
  assert.ok(rules.includes("match /fcm_tokens/{token}"), "bloc fcm_tokens absent");
  assert.ok(rules.includes("profileRole()"), "validation de rôle absente");
  assert.ok(rules.includes("request.resource.data.token == token"), "token non lié au doc");
});

check("règles : verrou entrepôt (received_at_warehouse)", () => {
  const rules = read("firestore.rules");
  assert.ok(
    rules.includes("data.get('received_at_warehouse', false) == true"),
    "condition de réception absente"
  );
});

/* ---------- 6. Cloud Functions ---------- */
check("déclencheurs notifications enregistrés", () => {
  const triggers = read("functions/triggers.js");
  const expected = [
    "onOrderCreated",
    "onProductWritten",
    "onPickupCreated",
    "onPickupUpdated",
    "onUserWritten",
    "onOrderUpdated",
    "onFlashSaleWritten",
    "onEventsConfigWritten",
    "onCampaignCreated",
  ];
  for (const name of expected) {
    assert.ok(triggers.includes("exports." + name), "déclencheur absent : " + name);
  }
  assert.ok(read("functions/index.js").includes("require('./triggers')"), "index.js ne charge pas triggers");
});

check("push : token stocké dans fcm_tokens avec rôle + plateforme", () => {
  const push = read("js/push.js");
  assert.ok(push.includes("fcm_tokens"), "collection absente");
  assert.ok(push.includes("getToken"), "getToken absent");
  assert.ok(push.includes("pwa_installed"), "plateforme PWA absente");
  assert.ok(push.includes("syncPushToken"), "synchronisation absente");
});

check("admin : confirmation réception entrepôt + bouton", () => {
  const admin = read("js/admin.js");
  assert.ok(admin.includes("confirmWarehouseReceipt"), "fonction absente");
  assert.ok(admin.includes("data-pickup-receive"), "bouton absent");
  assert.ok(admin.includes("received_at_warehouse"), "champ absent");
});

check("push : activation automatique au 1er geste (click + touchend, une seule fois)", () => {
  const push = read("js/push.js");
  assert.ok(push.includes("autoPromptOnFirstGesture"), "mécanisme absent");
  assert.ok(
    /document\.addEventListener\("click", trigger, \{ once: true, passive: true, capture: true \}\)/.test(push),
    "écouteur click mal configuré"
  );
  assert.ok(
    /document\.addEventListener\("touchend", trigger, \{ once: true, passive: true, capture: true \}\)/.test(push),
    "écouteur touchend mal configuré"
  );
  assert.ok(/currentPermission\(\) !== "default"\) return;/.test(push), "garde-fou permission absent");
});

check("push : iOS hors PWA = invite d'installation, jamais de demande", () => {
  const push = read("js/push.js");
  assert.ok(push.includes("iosNeedsInstall"), "détection iOS absente");
  assert.ok(
    /if \(iosNeedsInstall\(\)\) \{[\s\S]{0,80}?showPushCta/.test(push),
    "invite d'installation non conservée"
  );
});

check("push : synchro silencieuse uniquement si permission accordée", () => {
  const push = read("js/push.js");
  assert.ok(/Notification\.permission !== "granted"\) return null;/.test(push), "garde-fou granted absent");
  assert.ok(push.includes("syncInFlight"), "anti-doublon absent");
});

check("push : diagnostic + push de test exposés", () => {
  const push = read("js/push.js");
  assert.ok(push.includes("getPushDiagnostics"), "diagnostic absent");
  assert.ok(push.includes("sendTestPush"), "test push absent");
  assert.ok(push.includes("adminTestPush"), "endpoint test absent");
  assert.ok(push.includes("window.smartswikaPushStatus"), "API window absente");
  assert.ok(push.includes("window.smartswikaSendTestPush"), "API window test absente");
});

check("push : aucune erreur console en cas de non-support (pas de console.error)", () => {
  const push = read("js/push.js");
  assert.equal(/console\.error/.test(push), false, "console.error interdit dans le module push");
});

check("admin : encart « État Push sur cet appareil » + boutons", () => {
  const html = read("admin.html");
  const mod = read("js/admin-notifications.js");
  for (const id of ["pushDiagState", "pushAllowBtn", "pushTestBtn", "pushDiagLog"]) {
    assert.ok(html.includes(`id="${id}"`), "élément manquant : " + id);
  }
  assert.ok(html.includes("État Push sur cet appareil"));
  assert.ok(html.includes("Envoyer une notification test sur cet appareil"));
  assert.ok(mod.includes("renderPushDiag"), "rendu du diagnostic absent");
  assert.ok(mod.includes("window.smartswikaSendTestPush"), "bouton test non branché");
});

check("serveur : adminTestPush protégé (ID token + rôle admin + token possédé)", () => {
  const triggers = read("functions/triggers.js");
  const start = triggers.indexOf("exports.adminTestPush");
  assert.ok(start > 0, "fonction absente");
  const block = triggers.slice(start, start + 3000);
  assert.ok(block.includes("verifyIdToken"), "vérification du jeton absente");
  assert.ok(block.includes("not_admin"), "contrôle du rôle absent");
  assert.ok(block.includes("token_not_owned"), "contrôle de propriété du token absent");
  assert.ok(block.includes("sendPush(tokens"), "envoi absent");
  assert.ok(/where\('uid', '==', decoded\.uid\)/.test(block), "tous les appareils de l'admin non récupérés");
});

check("push haute priorité : bloc natif notification + webpush riche", () => {
  const notif = read("functions/notifications.js");
  assert.ok(notif.includes("const notification = { title: data.title, body: data.body }"), "bloc notification natif absent");
  assert.ok(notif.includes("requireInteraction: true"), "requireInteraction absent");
  assert.ok(notif.includes("assets/pwa-192.png"), "icône/badge absents");
  assert.ok(notif.includes("Urgency: 'high'"), "urgence absente");
  assert.ok(notif.includes("TTL: '86400'"), "TTL absent");
  assert.ok(notif.includes("fcmOptions: { link: absoluteUrl(data.targetUrl) }"), "lien de clic absent");
  const sw = read("firebase-messaging-sw.js");
  assert.ok(sw.includes("payload.notification"), "anti-doublon SW absent");
});

check("admin : push initialisé sur la page admin (sinon « Module indisponible »)", () => {
  const admin = read("js/admin.js");
  assert.ok(/import \{ initPush \} from "\.\/push\.js\?v=\d+"/.test(admin), "admin.js n'importe pas push.js");
  assert.ok(/initPush\(\{ showCta: false \}\)/.test(admin), "initPush non appelé sur /admin");
  assert.ok(admin.includes("smartswika:push-ready"), "événement de disponibilité absent");
});

check("push : enregistre le Service Worker s'il n'existe pas (pages sans app.js)", () => {
  const push = read("js/push.js");
  assert.ok(push.includes("ensureSwRegistration"), "helper absent");
  assert.ok(
    /serviceWorker\.register\("\/firebase-messaging-sw\.js", \{ scope: "\/" \}\)/.test(push),
    "enregistrement explicite du SW absent"
  );
});

check("push test : utilisateur résolu via Firebase Auth (authStateReady + getIdToken(true))", () => {
  const push = read("js/push.js");
  assert.ok(push.includes("resolveAccount"), "résolution du compte absente");
  assert.ok(push.includes("authStateReady()"), "attente de l'état d'auth absente");
  assert.ok(push.includes("getIdToken(true)"), "jeton forcé absent");
  assert.ok(/import \{ db, auth \} from "\.\/firebase\.js"/.test(push), "auth non importé");
  assert.ok(
    /registerToken\(\{ user: account \}\)/.test(push),
    "le token doit être ré-enregistré sous le compte avant l'envoi"
  );
});

check("push test : messages d'erreur explicites côté admin", () => {
  const mod = read("js/admin-notifications.js");
  for (const code of ["no_user", "not_admin", "token_not_owned", "invalid_token", "no_token"]) {
    assert.ok(mod.includes(code + ":"), "message manquant pour " + code);
  }
});

console.log("\n" + checks + " verification(s), " + failures + " echec(s)");
process.exit(failures === 0 ? 0 : 1);
