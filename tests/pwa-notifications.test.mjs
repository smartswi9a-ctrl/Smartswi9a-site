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

console.log("\n" + checks + " verification(s), " + failures + " echec(s)");
process.exit(failures === 0 ? 0 : 1);
