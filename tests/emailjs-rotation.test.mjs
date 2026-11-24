#!/usr/bin/env node
/* ============================================================
   TESTS : EmailJS mode économie + rotation vendeurs 10:1
   ------------------------------------------------------------
   1. Politique email : 5 emails exactement, 0 pour l'admin.
   2. Algorithme 10 produits > 500 MAD → 1 produit ≤ 500 MAD.
   3. Quota mensuel (200) et reset Africa/Casablanca.
   4. Câblage serveur (triggers), règles Firestore, UI admin.
   5. Clé VAPID : déclaration, validateur, script d'activation.
   Usage : node tests/emailjs-rotation.test.mjs
   ============================================================ */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const policy = require(path.join(ROOT, "functions", "email-policy.js"));
const core = require(path.join(ROOT, "functions", "rotation-core.js"));

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

/* ---------- 1. Politique email ---------- */

check("exactement 5 emails automatiques (4 vendeur + 1 client)", () => {
  assert.equal(policy.SELLER_TYPES.length, 4);
  assert.equal(policy.CLIENT_TYPES.length, 1);
  assert.equal(policy.SELLER_TYPES.length + policy.CLIENT_TYPES.length, 5);
  assert.deepEqual([...policy.SELLER_TYPES].sort(), [
    "seller_new_order",
    "seller_pickup_approved",
    "seller_suspended",
    "seller_warehouse_received"
  ]);
  assert.deepEqual([...policy.CLIENT_TYPES], ["client_order_confirmation"]);
});

check("aucun email pour l'admin, quel que soit le type", () => {
  const all = [...policy.SELLER_TYPES, ...policy.CLIENT_TYPES, "campaign", "admin_new_order", ""];
  for (const type of all) {
    assert.equal(policy.shouldSendEmail("admin", type), false, "admin ne doit jamais recevoir " + type);
  }
});

check("vendeur : uniquement les 4 emails autorisés", () => {
  assert.equal(policy.shouldSendEmail("seller", "seller_new_order"), true);
  assert.equal(policy.shouldSendEmail("vendor", "seller_suspended"), true);
  assert.equal(policy.shouldSendEmail("seller", "client_order_confirmation"), false);
  assert.equal(policy.shouldSendEmail("seller", "client_promo"), false);
});

check("client : confirmation initiale uniquement (pas de suivi email)", () => {
  assert.equal(policy.shouldSendEmail("client", "client_order_confirmation"), true);
  assert.equal(policy.shouldSendEmail("client", "client_order_shipping"), false);
  assert.equal(policy.shouldSendEmail("client", "client_order_delivered"), false);
});

check("mois calendaire calculé à l'heure du Maroc", () => {
  const key = policy.monthKey(new Date("2026-11-30T23:30:00Z"));
  assert.equal(key, "2026-12", "23:30 UTC = 00:30 le 1er décembre à Casablanca (UTC+1)");
  assert.match(policy.monthKey(new Date()), /^\d{4}-\d{2}$/);
});

/* ---------- 2. Rotation 10:1 ---------- */

check("10 produits vendeurs > 500 MAD diffusés, compteur 1 → 10", () => {
  let state = { premiumCount: 0, lowPriceQueue: [] };
  for (let i = 1; i <= 10; i += 1) {
    const decision = core.decideRotation(state, 900, "p" + i);
    assert.equal(decision.broadcast, true, "produit " + i + " doit être diffusé");
    assert.equal(decision.premiumCount, i);
    state = { premiumCount: decision.premiumCount, lowPriceQueue: decision.lowPriceQueue };
  }
  assert.equal(state.premiumCount, 10);
});

check("produit vendeur ≤ 500 MAD : mis en file, non diffusé", () => {
  const decision = core.decideRotation({ premiumCount: 3, lowPriceQueue: [] }, 250, "cheap-1");
  assert.equal(decision.broadcast, false);
  assert.equal(decision.lowPriceQueue.length, 1);
  assert.equal(decision.lowPriceQueue[0].productId, "cheap-1");
  assert.equal(decision.premiumCount, 3);
});

check("11e tour : 1 produit ≤ 500 MAD diffusé puis compteur remis à 0", () => {
  const state = { premiumCount: 10, lowPriceQueue: [{ productId: "cheap-9", price: 199 }] };
  const decision = core.decideRotation(state, 100, "cheap-10");
  assert.equal(decision.broadcast, true);
  assert.equal(decision.premiumCount, 0);
  assert.equal(decision.reason, "low_price_slot");
});

check("produit > 500 MAD arrivé à 10 : libère le slot bas prix et repart à 1", () => {
  const state = { premiumCount: 10, lowPriceQueue: [{ productId: "cheap-1", price: 99 }] };
  const decision = core.decideRotation(state, 800, "premium-11");
  assert.equal(decision.broadcast, true);
  assert.equal(decision.premiumCount, 1);
  assert.equal(decision.flushLow.productId, "cheap-1");
  assert.equal(decision.lowPriceQueue.length, 0);
});

check("cycle complet enchaîné : 10 premium puis 1 cheap puis 10 premium", () => {
  let state = { premiumCount: 0, lowPriceQueue: [] };
  for (let i = 0; i < 10; i += 1) {
    const d = core.decideRotation(state, 700, "a" + i);
    state = { premiumCount: d.premiumCount, lowPriceQueue: d.lowPriceQueue };
  }
  const low = core.decideRotation(state, 450, "b1");
  assert.equal(low.broadcast, true);
  assert.equal(low.premiumCount, 0);
  state = { premiumCount: low.premiumCount, lowPriceQueue: low.lowPriceQueue };
  const next = core.decideRotation(state, 650, "c1");
  assert.equal(next.broadcast, true);
  assert.equal(next.premiumCount, 1);
});

check("produits Smartswika : diffusion sans restriction de prix", () => {
  assert.equal(core.isSmartOwner(""), true);
  assert.equal(core.isSmartOwner("smartswika"), true);
  assert.equal(core.isSmartOwner("SmartSwi9a"), true);
  assert.equal(core.isSmartOwner("vendor-123"), false);
});

check("prix invalide : aucune diffusion, état inchangé", () => {
  const decision = core.decideRotation({ premiumCount: 4, lowPriceQueue: [] }, NaN, "x");
  assert.equal(decision.broadcast, false);
  assert.equal(decision.premiumCount, 4);
  assert.equal(decision.reason, "invalid_price");
});

/* ---------- 3. Câblage serveur ---------- */

check("triggers.js déclenche les 5 types d'emails (et eux seuls)", () => {
  const triggers = read("functions/triggers.js");
  const types = [
    "seller_pickup_approved",
    "seller_warehouse_received",
    "seller_new_order",
    "seller_suspended",
    "client_order_confirmation"
  ];
  for (const type of types) {
    assert.ok(triggers.includes(`'${type}'`), "type manquant dans triggers.js : " + type);
  }
  assert.equal(triggers.includes("PHASE 2"), false, "aucun marqueur PHASE 2 ne doit subsister");
});

check("aucun appel d'email avec le rôle admin", () => {
  const triggers = read("functions/triggers.js");
  assert.equal(/sendCriticalEmail\([\s\S]{0,200}role:\s*'admin'/.test(triggers), false);
  assert.equal(/sendCriticalEmail\([\s\S]{0,200}role:\s*"admin"/.test(triggers), false);
});

check("rotation branchée sur la publication / promotion produit", () => {
  const triggers = read("functions/triggers.js");
  assert.ok(triggers.includes("applyRotation({ productId: id"));
  assert.ok(triggers.includes("becameApproved"));
  assert.ok(triggers.includes("promoDrop"));
});

check("quota EmailJS : 200 emails/mois et reset calendaire", () => {
  const emails = read("functions/emails.js");
  assert.ok(/QUOTA_LIMIT\s*=\s*200/.test(emails));
  assert.ok(emails.includes("require('./email-policy')"));
  assert.ok(emails.includes("reserveEmailSlot"));
  assert.ok(emails.includes("USAGE_PATH = 'config/emailjs_usage'"));
});

/* ---------- 4. Règles & UI ---------- */

check("règles Firestore : config email/rotation en lecture admin seule", () => {
  const rules = read("firestore.rules");
  assert.ok(/match \/config\/emailjs_usage\s*\{[\s\S]*?allow read:\s*if isAdmin\(\)/.test(rules));
  assert.ok(/match \/config\/notifications_rotation\s*\{[\s\S]*?allow read:\s*if isAdmin\(\)/.test(rules));
  assert.ok(rules.includes("match /config/notifications_command"));
  assert.ok(/match \/email_logs\/\{logId\}\s*\{[\s\S]*?allow write:\s*if false/.test(rules));
  assert.ok(/match \/campaigns\/\{campaignId\}\s*\{[\s\S]*?allow create:\s*if isAdmin\(\)/.test(rules));
});

check("admin : onglet Campagnes & Notifications + case EmailJS décochée", () => {
  const html = read("admin.html");
  const module = read("js/admin-notifications.js");
  const admin = read("js/admin.js");
  assert.ok(html.includes('data-tab="notifications"'));
  assert.ok(html.includes('id="tab-notifications"'));
  assert.ok(html.includes('id="campaignSendEmail"'));
  assert.equal(/id="campaignSendEmail"[^>]*checked/.test(html), false, "la case doit être décochée par défaut");
  assert.ok(html.includes("Envoyer aussi par EmailJS"));
  assert.ok(module.includes("emailjs_usage"));
  assert.ok(module.includes("notifications_rotation"));
  assert.ok(module.includes("notifications_command"));
  assert.ok(admin.includes("admin-notifications.js"));
});

check("campagnes : file espacée 2,5 s + lien de désinscription", () => {
  const emails = read("functions/emails.js");
  assert.ok(/CAMPAIGN_DELAY_MS\s*=\s*2500/.test(emails));
  assert.ok(emails.includes("unsubscribeUrl"));
  assert.ok(fs.existsSync(path.join(ROOT, "unsubscribe.html")));
  const page = read("unsubscribe.html");
  assert.ok(page.includes("unsubscribeEmail"));
});

check("functions/index.js exporte réellement les déclencheurs (Object.assign)", () => {
  const index = read("functions/index.js");
  assert.ok(
    index.includes("Object.assign(exports, require('./triggers'))"),
    "index.js doit fusionner les exports de triggers.js, sinon aucune fonction n'est déployée"
  );
  assert.equal(
    /^\s*require\('\.\/triggers'\);\s*$/m.test(index),
    false,
    "un require simple n'expose pas les déclencheurs à Firebase"
  );
});

/* ---------- 5. VAPID ---------- */
check("VAPID_KEY déclarée dans js/config.js (et valide si renseignée)", () => {
  const config = read("js/config.js");
  assert.ok(/VAPID_KEY:\s*'[^']*'/.test(config), "PWA_CONFIG.VAPID_KEY doit être déclarée");
  const value = (config.match(/VAPID_KEY:\s*'([^']*)'/) || [])[1] || "";
  if (value) {
    assert.match(value, /^B[A-Za-z0-9_-]{80,100}$/, "clé VAPID au format base64url attendu");
  }
  assert.ok(fs.existsSync(path.join(ROOT, "scripts", "vapid-activate.cjs")));
  const push = read("js/push.js");
  assert.ok(push.includes("PWA_CONFIG.VAPID_KEY"), "push.js doit lire la clé");
});

/* ---------- Bilan ---------- */

console.log("\n" + (checks - failures) + "/" + checks + " vérifications OK");
if (failures > 0) {
  console.error(failures + " échec(s)");
  process.exit(1);
}


