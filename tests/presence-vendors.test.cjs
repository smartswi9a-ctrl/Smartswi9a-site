/* ============================================================
   tests/presence-vendors.test.cjs
   GARDE-FOU — presence temps reel (clients + vendeurs) et
   suspension / annulation de suspension cote admin.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const lire = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

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

const presence = lire("js/presence.js");
const rules = lire("firestore.rules");
const adminJs = lire("js/admin.js");
const adminUi = lire("js/admin-ui.js");
const adminHtml = lire("admin.html");
const appJs = lire("js/app.js");
const vendorHtml = lire("vendor/dashboard.html");
const indexHtml = lire("index.html");
const koulchiHtml = lire("koulchi.html");
const shopUi = lire("js/shop-ui.js");
const shopCss = lire("css/shop-modern.css");
const fnIndex = lire("functions/index.js");
const translations = lire("translations.js");

/* --------------------------------------------- 1. presence.js */
check("presence : module present", presence.includes("export function initPresence"));
check("presence : battement economique 60 s", /PRESENCE_HEARTBEAT_MS = 60000/.test(presence));
check("presence : ecriture isOnline + lastSeenAt", presence.includes("isOnline") && presence.includes("lastSeenAt") && presence.includes('updateDoc(doc(db, "users"'));
check("presence : onglet visible uniquement", /document\.visibilityState === "visible"/.test(presence));
check("presence : pagehide -> hors ligne", presence.includes('"pagehide"'));
check("presence : branche sur toutes les pages client", appJs.includes('import "./presence.js'));
check("presence : branche sur le dashboard vendeur", vendorHtml.includes("/js/presence.js"));

/* --------------------------------------------- 2. firestore.rules */
check(
  "rules : presence limitee a lastSeenAt / isOnline",
  /hasOnly\(\[\s*'lastSeenAt', 'isOnline'\s*\]\)/.test(rules)
);
check("rules : lecture admin des profils conservee", /match \/users\/\{uid\} \{[\s\S]{0,80}allow read: if isAdmin\(\) \|\| isSelf\(uid\);/.test(rules));
check("rules : le role reste intouchable par le proprietaire", rules.includes("request.resource.data.role == resource.data.role"));

/* --------------------------------------------- 3. admin.js */
check("admin : fenetre en ligne de 2 minutes", /const ONLINE_WINDOW_MS = 120000;/.test(adminJs));
check("admin : pastilles connecte / deconnecte", adminJs.includes("presencePillHtml") && adminJs.includes("is-online") && adminJs.includes("is-offline"));
check("admin : compteur X en ligne", adminJs.includes("updateOnlineCounters") && adminJs.includes("usersOnlineCount") && adminJs.includes("vendorsOnlineCount"));
check("admin : filtre rapide En ligne", adminJs.includes("usersOnlineOnly") && adminJs.includes("usersOnlineFilter"));
check(
  "admin : onSnapshot limite aux onglets Clients / Vendeurs",
  adminJs.includes("function setPresenceTab") &&
    adminJs.includes("function stopPresenceStreams") &&
    /onSnapshot\(\s*query\(collection\(db, 'users'\), limit\(500\)\)/.test(adminJs) &&
    /onSnapshot\(\s*query\(collection\(db, 'users'\), where\('role', '==', 'vendor'\), limit\(500\)\)/.test(adminJs)
);
check("admin : bouton Suspendre ouvre la modale", adminJs.includes("openVendorSuspendModal") && adminJs.includes('data-action="vendor-suspend"'));
check("admin : bouton Annuler la suspension", adminJs.includes("vendor-unsuspend") && adminJs.includes("handleVendorUnsuspend"));
check("admin : cause de suspension transmise", adminJs.includes("suspensionType") && adminJs.includes("suspensionCause") && adminJs.includes("suspensionUntil"));
check(
  "admin : cause affichee pour un vendeur suspendu",
  adminJs.includes("admin-suspension-note") && adminJs.includes("suspendedCauseLabel")
);


/* --------------------------------------------- 4. admin.html + i18n */
const htmlIds = [
  "vendorSuspendModal", "vendorSuspendType", "vendorSuspendCause",
  "vendorSuspendUntil", "vendorSuspendConfirm", "usersOnlineCount",
  "vendorsOnlineCount", "usersOnlineFilter",
];
const missingIds = htmlIds.filter((id) => !adminHtml.includes(`id="${id}"`));
check("admin.html : IDs de presence et de suspension", missingIds.length === 0, missingIds.join(","));
check(
  "admin.html : couleurs des pastilles",
  adminHtml.includes("#10B981") && adminHtml.includes("#EF4444")
);

function extractDictKeys(lang) {
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
  return [...adminUi.slice(start, end).matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
}

const NEW_KEYS = [
  "onlineFilter", "onlineNow", "presenceOnline", "presenceOffline",
  "presenceLastSeen", "presenceNever", "suspendTitle", "suspendType",
  "suspendTemporary", "suspendPermanent", "suspendUntil", "suspendCause",
  "suspendCausePlaceholder", "suspendConfirm", "suspendCauseRequired",
  "unsuspendTitle", "unsuspendMessage", "unsuspendConfirm",
  "suspendedCauseLabel", "suspendedUntilLabel",
];
const fr = extractDictKeys("fr");
const en = extractDictKeys("en");
const ar = extractDictKeys("ar");
check("admin-ui : parite FR / EN / AR conservee", fr.length === en.length && fr.length === ar.length, `fr=${fr.length} en=${en.length} ar=${ar.length}`);
const missingI18n = NEW_KEYS.filter((key) => !fr.includes(key) || !en.includes(key) || !ar.includes(key));

/* --------------------------------------------- 5. pages publiques */
check(
  "accueil : vitrine Koulchi compacte a cote des Ventes Flash",
  indexHtml.includes('id="koulchiVitrine"') &&
    indexHtml.includes('id="flashSection"') &&
    indexHtml.indexOf('id="koulchiVitrine"') < indexHtml.indexOf('id="flashSection"')
);
check("accueil : plus de simulateur", !indexHtml.includes("data-koulchi-simulator"));
check("koulchi.html : simulateur conserve", koulchiHtml.includes("data-koulchi-simulator"));
check(
  "simulateur : 3 lignes (titre / barre / resume)",
  shopUi.includes("koulchi-sim-row--head") &&
    shopUi.includes("koulchi-sim-row--bar") &&
    shopUi.includes("koulchi-sim-row--summary") &&
    shopUi.includes("koulchi-sim-markers")
);
check("simulateur : hauteur compacte", !/\.koulchi-experience[^}]*min-height:\s*[4-9]\d\dpx/.test(shopCss) && shopCss.includes("min-height: 0"));
check("vitrine : cles trilingues presentes", ["fr", "en", "ar"].every(() => translations.includes("koulchiVitrineTitle")));

/* --------------------------------------------- 6. Cloud Function */
check("CF : cause de suspension obligatoire", fnIndex.includes("La cause de la suspension est obligatoire."));
check("CF : suspension ecrite dans vendorInfo.suspension", fnIndex.includes("'vendorInfo.suspension'") && fnIndex.includes("suspensionReason"));
check("CF : notification de reactivation", fnIndex.includes("vendor_reactivated") && fnIndex.includes("notifyVendor"));

/* --------------------------------------------- resultat */
console.log("\n" + (verifications - echecs) + "/" + verifications + " verification(s) reussie(s).");
if (echecs > 0) {
  console.error(echecs + " echec(s).");
  process.exit(1);
}

check("admin-ui : cles presence / suspension traduites", missingI18n.length === 0, missingI18n.join(","));
