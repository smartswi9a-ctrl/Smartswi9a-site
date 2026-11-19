/* ============================================================
   tests/vendor-guide.test.cjs
   GARDE-FOU : manuel vendeur present dans le dashboard.
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

check("dashboard : onglet Guide present", html.includes('data-tab="guide"'));
check("dashboard : fonction renderGuide definie", /function renderGuide\(container\)/.test(js));
check("dashboard : routage de l onglet guide", /tabName === 'guide'/.test(js));
check("guide : parle de l entrepot Smart Swika", js.includes("entrepôt Smart Swika"));
check("guide : rappelle le mode entrepot obligatoire", js.includes("mode entrepôt est obligatoire"));
check("guide : aucun mode dropoff", !/dropoff/i.test(js));

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Guide vendeur : verifie.");
