/* ============================================================
   tests/vendor-ui.test.cjs
   GARDE-FOU — vendor/dashboard.html / js/vendor-ui.js / js/vendor-dashboard.js
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

const html = read("vendor/dashboard.html");
const ui = read("js/vendor-ui.js");
const dash = read("js/vendor-dashboard.js");
const css = read("vendor-ui.css");

/* --------------------------------------------- 1. dictionnaires */
function extractDictKeys(lang) {
  const marker = "\n  " + lang + ": {";
  const start = ui.indexOf(marker);
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = ui.indexOf("{", start); i < ui.length; i++) {
    if (ui[i] === "{") depth++;
    else if (ui[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const block = ui.slice(start, end);
  return [...block.matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
}

const frKeys = extractDictKeys("fr");
const enKeys = extractDictKeys("en");
const arKeys = extractDictKeys("ar");

check("vendor-ui : dictionnaire FR non vide", frKeys.length > 45, frKeys.length + " cles");
check(
  "vendor-ui : parite FR / EN / AR",
  frKeys.length === enKeys.length && frKeys.length === arKeys.length,
  `fr=${frKeys.length} en=${enKeys.length} ar=${arKeys.length}`
);
const missingEn = frKeys.filter((key) => !enKeys.includes(key));
const missingAr = frKeys.filter((key) => !arKeys.includes(key));
check("vendor-ui : toutes les cles FR existent en EN", missingEn.length === 0, missingEn.join(","));
check("vendor-ui : toutes les cles FR existent en AR", missingAr.length === 0, missingAr.join(","));

const usedKeys = [...new Set([...html.matchAll(/data-vendor-i18n="([A-Za-z0-9_]+)"/g)].map((m) => m[1]))];
const frSet = new Set(frKeys);
const unknownKeys = usedKeys.filter((key) => !frSet.has(key));
check(
  "vendor-ui : toutes les cles data-vendor-i18n existent en FR",
  unknownKeys.length === 0,
  unknownKeys.join(",")
);

/* --------------------------------------------- 2. structure HTML */
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
check("vendor : aucun ID duplique", duplicates.length === 0, duplicates.join(","));

const criticalIds = [
  "vLayout", "vSidebar", "vSidebarToggle", "vOverlay", "vMobileToggle",
  "vShopName", "vShopStatus", "vShippingMode", "vPageTitle", "langSelect",
  "vNotifBell", "vNotifBadge", "vNotifPanel", "logoutBtn",
  "vWarehouseWorkflow", "vBanners", "vTabContent",
  "navProductsBadge", "navStockBadge", "navOrdersBadge", "navWalletBadge",
];
const missingIds = criticalIds.filter((id) => !ids.includes(id));
check("vendor : IDs critiques conserves", missingIds.length === 0, missingIds.join(","));

check("vendor : topbar sticky", html.includes("v-topbar") && css.includes(".v-topbar"));
check(
  "vendor : selecteur FR / EN / AR",
  /<option value="fr"[^>]*>FR<\/option>/.test(html) &&
    /<option value="en"[^>]*>EN<\/option>/.test(html) &&
    /<option value="ar"[^>]*>AR<\/option>/.test(html)
);
check("vendor : cloche notifications in-app", html.includes('id="vNotifBell"') && html.includes('id="vNotifPanel"'));
check("vendor : workflow entrepot 3 etapes", html.includes('id="vWarehouseWorkflow"') && dash.includes("v-workflow-step"));
check("vendor : Chart.js charge avant le module", html.includes("chart.umd.min.js"));
check("vendor : vendor-ui.css charge", html.includes("/vendor-ui.css"));

const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
const expectedTabs = ["overview", "products", "flash", "koulchi", "stock", "orders", "wallet", "guide"];
check(
  "vendor : 8 onglets data-tab conserves",
  expectedTabs.every((tab) => tabs.includes(tab)),
  tabs.join(",")
);

/* --------------------------------------------- 3. responsive / RTL */
check("vendor : desktop 240px", css.includes("--v-sidebar-width: 240px"));
check("vendor : desktop replie 72px", css.includes(".v-layout.v-collapsed .v-sidebar { width: 72px; }"));
check("vendor : tablette 768-1023 compacte 72px", css.includes("@media (min-width: 768px) and (max-width: 1023px)"));
check("vendor : mobile < 768 drawer", css.includes("@media (max-width: 767px)"));
check(
  "vendor : KPI 4 colonnes puis 2 colonnes",
  css.includes("grid-template-columns: repeat(4, minmax(0, 1fr))") &&
    css.includes("grid-template-columns: repeat(2, minmax(0, 1fr))")
);
check("vendor : RTL document", ui.includes('document.documentElement.dir = currentVendorLang === "ar" ? "rtl" : "ltr"'));
check("vendor : sidebar RTL a droite", css.includes('[dir="rtl"] .v-sidebar'));
check("vendor : tactile >= 44px", css.includes("min-height: 44px"));

/* --------------------------------------------- 4. graphiques / KPI */
check("vendor : canvas CA / NET", dash.includes('id="vendorRevenueChart"'));
check("vendor : canvas donut statuts", dash.includes('id="vendorOrdersChart"'));
check("vendor : canvas top produits", dash.includes('id="vendorTopProductsChart"'));
check(
  "vendor : Chart.js responsive + animation 800ms",
  dash.includes("maintainAspectRatio: false") && dash.includes("animation: { duration: 800")
);
check("vendor : selecteur 7j / 30j / 90j", dash.includes("data-vendor-chart-period") && dash.includes("period90"));
check("vendor : count-up KPI 600ms", ui.includes("duration = 600"));
check("vendor : MutationObserver", ui.includes("new MutationObserver"));

/* --------------------------------------------- 5. verrou entrepot + commission */
check(
  "vendor : verrou received_at_warehouse === true",
  dash.includes("r.received_at_warehouse === true") && dash.includes("hasWarehouseReceipt")
);
check("vendor : publication produit verrouillee", dash.includes("if (!hasWarehouseReceipt())"));
check(
  "vendor : commission 7 % conservee",
  dash.includes("CONFIG.VENDOR.COMMISSION_RATE") && dash.includes("calculateVendorCommission")
);
check(
  "vendor : produits marques warehouse_received",
  (dash.match(/warehouse_received: true/g) || []).length >= 2
);
check("vendor : expose __vendorT", ui.includes("window.__vendorT = vendorT"));
check("vendor : localStorage swi9a_lang", ui.includes('const VENDOR_LANG_KEY = "swi9a_lang"'));

/* --------------------------------------------- resultat */
console.log(`\n${verifications - echecs}/${verifications} verifications reussies.`);
if (echecs > 0) {
  console.error(`${echecs} echec(s).`);
  process.exit(1);
}
