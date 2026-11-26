/* ============================================================
   tests/admin-ui.test.cjs
   GARDE-FOU — admin.html / js/admin-ui.js / js/admin.js
   ------------------------------------------------------------
   Verifie sans navigateur :
     1. navigation en 5 groupes + 17 onglets + panneaux associes ;
     2. selecteur de langue FR/EN/AR + parite stricte du dictionnaire ;
     3. toutes les cles data-admin-i18n existent en fr ;
     4. IDs critiques preserves et aucun ID duplique ;
     5. breakpoints responsive (240/72/drawer) et KPI 4/2 colonnes ;
     6. graphiques Chart.js (CA vs NET, donut, trafic) + count-up.
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

const html = read("admin.html");
const ui = read("js/admin-ui.js");
const adminJs = read("js/admin.js");

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

check("admin-ui : dictionnaire FR non vide", frKeys.length > 80, frKeys.length + " cles");
check(
  "admin-ui : parite FR / EN / AR",
  frKeys.length === enKeys.length && frKeys.length === arKeys.length,
  `fr=${frKeys.length} en=${enKeys.length} ar=${arKeys.length}`
);

const frSet = new Set(frKeys);
const missingEn = frKeys.filter((key) => !enKeys.includes(key));
const missingAr = frKeys.filter((key) => !arKeys.includes(key));
check("admin-ui : toutes les cles FR existent en EN", missingEn.length === 0, missingEn.join(","));
check("admin-ui : toutes les cles FR existent en AR", missingAr.length === 0, missingAr.join(","));

const usedKeys = [...html.matchAll(/data-admin-i18n="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
const unknownKeys = [...new Set(usedKeys)].filter((key) => !frSet.has(key));
check(
  "admin.html : toutes les cles data-admin-i18n existent en FR",
  unknownKeys.length === 0,
  unknownKeys.join(",") || usedKeys.length + " cles"
);

/* --------------------------------------------- 2. navigation */

const tabValues = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
const expectedTabs = [
  "dashboard", "traffic", "products", "flash", "coupons", "ads",
  "orders", "preparation", "livo", "disputes", "abandoned",
  "vendors", "users", "reviews", "blog",
  "finances", "wallets", "notifications", "tools",
];
check("admin.html : 19 onglets", tabValues.length === 19, tabValues.length + " onglets");
check(
  "admin.html : les 19 data-tab attendus sont presents",
  expectedTabs.every((tab) => tabValues.includes(tab))
);
check(
  "admin.html : chaque onglet a son panneau tab-*",
  tabValues.every((tab) => html.includes(`id="tab-${tab}"`))
);

const groupLabels = [...html.matchAll(/class="admin-nav-group-label"[^>]*data-admin-i18n="([^"]+)"/g)].map((m) => m[1]);
check(
  "admin.html : 6 groupes de navigation",
  groupLabels.length === 6 &&
    ["groupPilotage", "groupCatalog", "groupMarketing", "groupLogistics", "groupCommunity", "groupFinance"].every((key) => groupLabels.includes(key)),
  groupLabels.join(",")
);

const accTabs = [...html.matchAll(/data-acc-tab="([^"]+)"/g)].map((m) => m[1]);
check(
  "admin.html : 6 sous-onglets comptables + panneaux",
  accTabs.length === 6 && accTabs.every((tab) => html.includes(`id="acc-${tab}"`))
);

/* --------------------------------------------- 3. IDs preserves */

const CRITICAL_IDS = [
  "adminLoginBox", "adminPanel", "adminStats", "adminTabs", "adminShell", "adminSidebar",
  "adminMain", "adminMenuToggle", "adminLangSelect", "adminSidebarToggle", "adminSidebarBackdrop",
  "statProducts", "statProductsPending", "statOrders", "statUsers", "statReviewsPending",
  "statOrdersPending", "statRevenue", "statCities",
  "revenueChart", "revenueChartDashboard", "ordersStatusChart", "ordersStatusTotal",
  "trafficChart", "trafficPeriod", "trafficChartSummary",
  "adminProductsList", "adminOrdersList", "adminUsersList", "adminVendorsList",
  "adminLivoList", "adminDisputesList", "adminPickupRequests",
  "financeProductSelector", "financesResults", "finFreeCalcBtn", "finFreeResults",
  "orderStatusFilter", "vendorStatusFilters", "payoutStatusFilters",
  "accPeriod", "accKPIs", "accWaterfall",
];
const missingIds = CRITICAL_IDS.filter((id) => !html.includes(`id="${id}"`));
check("admin.html : IDs critiques preserves", missingIds.length === 0, missingIds.join(",") || CRITICAL_IDS.length + " IDs");

const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
const allIds = [...withoutComments.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const duplicates = [...new Set(allIds.filter((id, index) => allIds.indexOf(id) !== index))];
check("admin.html : aucun ID duplique", duplicates.length === 0, duplicates.join(",") || "aucun");

/* --------------------------------------------- 4. responsive + i18n */

check(
  "admin.html : selecteur de langue topbar FR/EN/AR",
  html.includes('id="adminLangSelect"') &&
    /<option value="fr">FR<\/option>/.test(html) &&
    /<option value="en">EN<\/option>/.test(html) &&
    /<option value="ar">AR<\/option>/.test(html)
);
check(
  "admin.html : shell + sidebar + main",
  html.includes('id="adminShell"') &&
    html.includes('id="adminSidebar"') &&
    html.includes('id="adminMain"')
);
check(
  "admin.html : KPI 4 colonnes desktop",
  /#adminStats[\s\S]{0,160}repeat\(4, minmax\(0, 1fr\)\)/.test(html)
);
check(
  "admin.html : KPI 2 colonnes tablette/mobile",
  (html.match(/repeat\(2, minmax\(0, 1fr\)\)/g) || []).length >= 2
);
check(
  "admin.html : breakpoints 767 / 768 / 1023 / 1024",
  ["max-width: 767px", "min-width: 768px", "max-width: 1023px", "min-width: 1024px"].every(
    (token) => html.includes(token)
  )
);
check("admin.html : transition 180ms", /0\.18s/.test(html));
check("admin.html : backdrop du tiroir mobile", html.includes('id="adminSidebarBackdrop"'));
check("admin.html : zones tactiles >= 44px", /min-height:\s*44px/.test(html));
check(
  "admin-ui : bascule dir=rtl en arabe",
  /documentElement\.dir\s*=\s*currentAdminLang === "ar"/.test(ui)
);
check("admin-ui : count-up 600ms", /const duration = 600/.test(ui));
check("admin-ui : animation Chart.js 800ms", /duration:\s*800/.test(ui));
check(
  "admin.html : admin-ui.js charge avant admin.js",
  html.indexOf("/js/admin-ui.js") > -1 &&
    html.indexOf("/js/admin-ui.js") < html.indexOf("/js/admin.js")
);

/* --------------------------------------------- 5. fonctionnalites */

check(
  "admin.js : graphique CA vs benefice NET",
  adminJs.includes("revenueChartDashboard") && adminJs.includes("netData")
);
check(
  "admin.js : donut repartition des statuts",
  adminJs.includes("renderOrdersStatusChart") && adminJs.includes("ordersStatusChart")
);
check("admin.js : barres arrondies (trafic)", adminJs.includes("borderRadius: 8"));
check("admin.js : redessin au changement de langue", adminJs.includes("admin-lang-changed"));
check("admin.js : etat vide du simulateur explicite", adminJs.includes("simNoProducts"));
check(
  "admin.js : suppression client via corbeille",
  adminJs.includes('data-action="delete-user"') && adminJs.includes("🗑️")
);
check("admin.js : grille des demandes de ramassage", adminJs.includes("pickup-grid"));
check("admin.js : IDs metier conserves (statProducts)", adminJs.includes("statProducts"));

console.log("\n" + verifications + " verification(s), " + echecs + " echec(s)");
process.exit(echecs === 0 ? 0 : 1);
