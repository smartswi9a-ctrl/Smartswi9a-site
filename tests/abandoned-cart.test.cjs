/* ============================================================
   tests/abandoned-cart.test.cjs
   GARDE-FOU — RELANCES PANIERS ABANDONNÉS (module 2026-11-26)
   ------------------------------------------------------------
   Vérifie sans navigateur :
     1. capture vitrine (js/abandoned-cart.js) + intégration pages ;
     2. Cloud Function planifiée 15 min, pic Maroc, 3 langues,
        lien ?recover_cart, 0 EmailJS ;
     3. règles Firestore strictes + index composite ;
     4. onglet admin (sidebar, KPI, filtres, tableau) + parité
        trilingue du dictionnaire admin ;
     5. cache-busting (Service Worker v6).
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
let verifications = 0;
let echecs = 0;

function check(nom, condition, detail) {
  verifications++;
  if (condition) console.log("PASS: " + nom + (detail ? " -> " + detail : ""));
  else {
    echecs++;
    console.error("ECHEC: " + nom + (detail ? " -> " + detail : ""));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const capture = read("js/abandoned-cart.js");
const adminModule = read("js/admin-abandoned.js");
const adminUi = read("js/admin-ui.js");
const adminHtml = read("admin.html");
const functionsJs = read("functions/index.js");
const rules = read("firestore.rules");
const indexes = JSON.parse(read("firestore.indexes.json"));
const sw = read("firebase-messaging-sw.js");
const pkg = JSON.parse(read("package.json"));

/* --------------------------------------------- 1. capture vitrine */

check("capture : collection abandoned_carts", capture.includes('"abandoned_carts"'));
check("capture : délai 45 minutes", capture.includes("45 * 60 * 1000"));
check("capture : identité invité persistante", capture.includes('GUEST_KEY = "swi9a_guest_id"'));
check(
  "capture : téléphone marocain validé",
  capture.includes("isValidMoroccanPhone") && capture.includes("cleanMoroccanPhone")
);
check(
  "capture : champs formulaire panier suivis",
  capture.includes('"cartName"') && capture.includes('"cartPhone"') && capture.includes('"cityFilterInput"')
);
check("capture : événement order-created -> recovered", capture.includes('"order-created"') && capture.includes("markRecovered"));
check("capture : statuts reminded_push / recovered", capture.includes('"recovered"') && capture.includes("status"));
check("capture : lien ?recover_cart restauré", capture.includes("recover_cart"));
check(
  "capture : deleteCart sans panier synchronisé ne supprime rien",
  capture.includes("if (!state)") && capture.includes("rien à supprimer")
);
check(
  "capture : permission-denied / not-found silencieux",
  capture.includes("isMissingCartDocError") && capture.includes("if (!isMissingCartDocError(e))")
);

const pages = ["index.html", "koulchi.html", "produit.html", "panier.html", "boutique.html", "blog.html", "villesmaroc.html"];
const missingPages = pages.filter((page) => !read(page).includes("/js/abandoned-cart.js?v=2"));
check("capture : script présent sur les pages panier/vitrine", missingPages.length === 0, missingPages.join(",") || pages.length + " pages");

/* --------------------------------------------- 2. Cloud Function */

check("function : planification 15 minutes", functionsJs.includes("schedule: 'every 15 minutes'"));
check("function : fuseau Africa/Casablanca", functionsJs.includes("timeZone: 'Africa/Casablanca'"));
check(
  "function : fenêtres de pic 11h-14h30 / 18h30-23h",
  functionsJs.includes("11 * 60, 14 * 60 + 30") && functionsJs.includes("18 * 60 + 30, 23 * 60")
);
check("function : seuil 45 minutes", functionsJs.includes("ABANDON_REMINDER_DELAY_MS = 45 * 60 * 1000"));
check("function : fenêtre maximale 48 h", functionsJs.includes("ABANDON_MAX_AGE_MS = 48 * 60 * 60 * 1000"));
check("function : statut actif uniquement", functionsJs.includes("where('status', '==', 'active')"));
check("function : token push obligatoire", functionsJs.includes("const token = typeof data.fcmToken === 'string'"));
check(
  "function : Urgency high + requireInteraction",
  functionsJs.includes("Urgency: 'high'") && functionsJs.includes("requireInteraction: true")
);
check("function : lien de récupération", functionsJs.includes("https://smartswika.ma/?recover_cart="));
check(
  "function : statut reminded_push + remindedAt",
  functionsJs.includes("status: 'reminded_push'") && functionsJs.includes("remindedAt: FieldValue.serverTimestamp()")
);
check("function : aucun email (0 EmailJS)", functionsJs.includes("emailjs: 0") && !functionsJs.includes("sendPromoDigestEmail"));

const messages = [
  "🛒 Votre panier Smartswika vous attend !",
  "Finalisez votre commande maintenant (paiement à la livraison 24-72h).",
  "🛒 Your Smartswika cart is waiting!",
  "Complete your order now (Cash on Delivery 24-72h).",
  "🛒 سلة مشترياتك في Smartswika بانتظارك!",
  "أكمل طلبك الآن مع الدفع عند الاستلام خلال 24-72 ساعة."
];
const missingMessages = messages.filter((message) => !functionsJs.includes(message));
check("function : 3 messages FR / EN / AR exacts", missingMessages.length === 0, missingMessages.join(" | "));

/* --------------------------------------------- 3. Règles Firestore */

check("rules : collection abandoned_carts", rules.includes("match /abandoned_carts/{cartDocId}"));
check("rules : propriétaire uid", rules.includes("function isSignedOwner()"));
check("rules : session invitée uid null", rules.includes("function isGuestSession()") && rules.includes("request.auth == null"));
check("rules : téléphone 06/07 strict", rules.includes("matches('^0[67][0-9]{8}$')"));
check(
  "rules : statuts autorisés",
  ["active", "abandoned", "reminded_push", "reminded_whatsapp", "recovered"].every((status) =>
    rules.includes("'" + status + "'")
  )
);
check("rules : admin lecture + gestion", rules.includes("allow delete: if isAdmin() || isGuestSession() || isSignedOwner()"));
check(
  "index : composite status + updatedAt",
  indexes.indexes.some(
    (index) =>
      index.collectionGroup === "abandoned_carts" &&
      index.fields.some((f) => f.fieldPath === "status") &&
      index.fields.some((f) => f.fieldPath === "updatedAt")
  )
);

/* --------------------------------------------- 4. Onglet admin */

check("admin : onglet sidebar data-tab=abandoned", adminHtml.includes('data-tab="abandoned"'));
check("admin : badge compteur temps réel", adminHtml.includes('id="navBadgeAbandoned"'));
check("admin : panneau tab-abandoned", adminHtml.includes('id="tab-abandoned"'));
check(
  "admin : 4 cartes KPI",
  ["abandonedKpiAbandoned", "abandonedKpiAmount", "abandonedKpiRecovered", "abandonedKpiRate"].every((id) =>
    adminHtml.includes('id="' + id + '"')
  )
);
check(
  "admin : 4 filtres rapides",
  ["all", "phone", "push", "recovered"].every((filter) =>
    adminHtml.includes('data-abandoned-filter="' + filter + '"')
  )
);
check("admin : tableau responsive (tbody dédié)", adminHtml.includes('id="abandonedCartsBody"'));
check("admin : module chargé avec cache-busting", adminHtml.includes("/js/admin.js?v=ads2026c5") && adminHtml.includes("/js/admin-ui.js?v=7"));

check("admin module : relance WhatsApp wa.me", adminModule.includes("https://wa.me/"));
check(
  "admin module : numéro marocain 2126/2127",
  adminModule.includes('"212" + digits.slice(1)') && adminModule.includes("/^[67]/")
);
check("admin module : statut reminded_whatsapp", adminModule.includes('"reminded_whatsapp"') && adminModule.includes("serverTimestamp()"));
check("admin module : suppression confirmée", adminModule.includes("confirmAction(") && adminModule.includes("deleteDoc("));
check("admin module : écoute temps réel", adminModule.includes("onSnapshot("));
check("admin module : badge > 45 min + téléphone/token", adminModule.includes("ABANDON_DELAY_MS") && adminModule.includes("cart.phone || cart.fcmToken"));
check(
  "admin module : WhatsApp localisé FR/EN/AR",
  adminModule.includes("Your Smartswika cart is waiting") && adminModule.includes("سلتك في Smartswika بانتظارك")
);

/* Parité stricte des nouvelles clés dans le dictionnaire admin. */
function extractAdminDict(lang) {
  const marker = "\n  " + lang + ": {";
  const start = adminUi.indexOf(marker);
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = adminUi.indexOf("{", start); i < adminUi.length; i++) {
    if (adminUi[i] === "{") depth++;
    else if (adminUi[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  return [...adminUi.slice(start, end).matchAll(/^\s{4}(abandoned[A-Za-z0-9_]*):/gm)].map((m) => m[1]);
}

const frAbandoned = extractAdminDict("fr");
const enAbandoned = extractAdminDict("en");
const arAbandoned = extractAdminDict("ar");
check("admin-ui : clés abandoned non vides", frAbandoned.length >= 30, frAbandoned.length + " clés");
check(
  "admin-ui : parité FR / EN / AR des clés abandoned",
  frAbandoned.length === enAbandoned.length &&
    frAbandoned.length === arAbandoned.length &&
    frAbandoned.every((key) => enAbandoned.includes(key) && arAbandoned.includes(key)),
  `fr=${frAbandoned.length} en=${enAbandoned.length} ar=${arAbandoned.length}`
);

/* --------------------------------------------- 5. Cache / tests */

check("service worker : version sw-2026-11-26-v13", sw.includes("'sw-2026-11-26-v13'"));
check(
  "package.json : suite abandoned-cart branchée sur npm test",
  String(pkg.scripts && pkg.scripts.test).includes("tests/abandoned-cart.test.cjs")
);

console.log("\n" + verifications + " verification(s), " + echecs + " echec(s)");
process.exit(echecs === 0 ? 0 : 1);
