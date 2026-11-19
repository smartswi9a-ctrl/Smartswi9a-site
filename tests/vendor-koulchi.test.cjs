/* ============================================================
   tests/vendor-koulchi.test.cjs
   GARDE-FOU : onglet Koulchi dialk + traductions du dashboard.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
let verifications = 0;
let echecs = 0;

function check(nom, condition) {
  verifications++;
  if (condition) console.log("PASS: " + nom);
  else {
    echecs++;
    console.error("ECHEC: " + nom);
  }
}

const html = fs.readFileSync(path.join(ROOT, "vendor", "dashboard.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "js", "vendor-dashboard.js"), "utf8");
const tr = fs.readFileSync(path.join(ROOT, "js", "translations-vendor.js"), "utf8");

check("dashboard : onglet Koulchi present", html.includes('data-tab="koulchi"'));
check("dashboard : libelle Koulchi traduit", html.includes('data-i18n="vendor.nav.koulchi"'));
check("dashboard : libelle Guide traduit", html.includes('data-i18n="vendor.nav.guide"'));
check("JS : fonction renderKoulchi", /async function renderKoulchi\(container\)/.test(js));
check("JS : textes Koulchi FR/AR/EN", (js.match(/KOULCHI_I18N/g) || []).length >= 1 && js.includes("كولشي ديالك"));
check("JS : statistiques commandes groupees", js.includes("i.mode === 'koulchi'") && js.includes("o.koulchiDiscount"));
check("JS : sens RTL pour l arabe", js.includes("lang === 'ar' ? 'rtl' : 'ltr'"));
check("JS : Guide arabe traduit", /function guideArHtml\(\)/.test(js) && js.includes("دليل البائع"));
check("JS : Guide anglais traduit", /function guideEnHtml\(\)/.test(js) && js.includes("Smart Swika vendor guide"));
check("traductions : vendor.nav.koulchi en 3 langues", (tr.match(/vendor\.nav\.koulchi/g) || []).length === 3);
check("traductions : vendor.nav.guide en 3 langues", (tr.match(/vendor\.nav\.guide/g) || []).length === 3);

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Koulchi vendeur + traductions : verifie.");
