/* ============================================================
   tests/dropoff-removed.test.cjs
   GARDE-FOU : le mode dropoff ne doit plus exister.
   ------------------------------------------------------------
   Decision produit du 2026-11-19 : tout le stock vendeur passe par
   l entrepot Smart Swika. Livo ne recupere les colis qu a l entrepot.
   Ce test statique echoue si un choix dropoff reapparait dans
   l inscription, la fiche produit, l admin ou les Functions.

   Aucune dependance, aucun reseau.
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

function lire(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const inscription = lire("inscription-vendeur.html");
const vendorDash = lire("js/vendor-dashboard.js");
const admin = lire("js/admin.js");
const fonctions = lire("functions/index.js");
const config = lire("js/config.js");

check(
  "inscription : aucun choix dropoff",
  !inscription.includes('value="dropoff"') && !inscription.includes("choice-dropoff")
);
check(
  "inscription : mode fulfillment coche par defaut",
  /name="vShipping" value="fulfillment" checked/.test(inscription)
);
check(
  "fiche produit : plus de select dropoff",
  !vendorDash.includes('id="vProdDeliveryMode"') &&
    !vendorDash.includes('value="dropoff"')
);
check(
  "admin : plus de Drop-off Livo",
  !admin.includes("Drop-off Livo")
);
check(
  "Functions : seuls les vendeurs entrepot sont acceptes",
  fonctions.includes("if (shippingMethod !== 'fulfillment')")
);
check(
  "Functions : delivery_mode fige a smartswika_warehouse",
  /delivery_mode:\s*'smartswika_warehouse'/.test(fonctions)
);
check(
  "config : VENDOR_SHIPPING_METHOD ne contient plus dropoff",
  !/VENDOR_SHIPPING_METHOD\s*=\s*\{[^}]*dropoff/.test(config)
);

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Mode entrepot unique : verifie.");
