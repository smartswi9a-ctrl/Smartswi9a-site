/* ============================================================
   tests/vendor-pickup.test.cjs
   GARDE-FOU : ramassage Smart Swika approuve avant creation produit.
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

const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
const vendor = fs.readFileSync(path.join(ROOT, "js", "vendor-dashboard.js"), "utf8");
const admin = fs.readFileSync(path.join(ROOT, "js", "admin.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");

check("regles : collection vendor_pickup_requests", rules.includes("match /vendor_pickup_requests/"));
check("regles : helper pickupApproved", /function pickupApproved\(requestId\)/.test(rules));
check("regles : creation produit exige pickupApproved", rules.includes("pickupApproved(request.resource.data.pickupRequestId)"));
check("vendeur : demande Smart Swika", /async function submitSmartPickupRequest/.test(vendor));
check("vendeur : ecriture vendor_pickup_requests", vendor.includes("collection(db, 'vendor_pickup_requests')"));
check("vendeur : produit lie au ramassage", vendor.includes("warehouse_received: true") && vendor.includes("pickupRequestId"));
check("vendeur : blocage sans ramassage approuve", vendor.includes("Aucun ramassage approuvé"));
check("vendeur : etiquettes SKU + code-barres", vendor.includes("printPickupLabels") && vendor.includes("buildCode128Svg"));
check("vendeur : SKU fige sur le produit", vendor.includes("sku: pickupSkuValue"));
check("admin : attribution SKU a l approbation", admin.includes("pickupSku(requestId, index)"));
check("regles : SKU et index obligatoires", rules.includes("request.resource.data.sku is string") && rules.includes("pickupItemIndex is number"));
check("guide : etiquettes SKU documentees", vendor.includes("étiquettes SKU avec code-barres"));
check("CGU vendeur : mode unique entrepot", fs.readFileSync(path.join(ROOT, "cgu-vendeur.html"), "utf8").includes("Mode unique : entrepôt Smart Swika"));
check("CGU vendeur : SKU et etiquetage obligatoires", fs.readFileSync(path.join(ROOT, "cgu-vendeur.html"), "utf8").includes("SKU et étiquetage obligatoire"));
check("vendeur : variantes taille et couleur", vendor.includes("v-pickup-size") && vendor.includes("v-pickup-color"));
check("vendeur : SKU par variante dans le produit", vendor.includes("pickupLineSkus") && vendor.includes("sku: line.sku"));
check("vendeur : guide mentionne une ligne par variante", vendor.includes("Une ligne = une variante"));
check("admin : validation des demandes", /async function renderPickupRequestsAdmin/.test(admin) && admin.includes("reviewPickupRequest"));
check("admin : conteneur demandes", adminHtml.includes('id="adminPickupRequests"'));

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Ramassage avant produit : verifie.");
