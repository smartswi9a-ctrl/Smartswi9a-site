/* ============================================================
   tests/order-delivery-mode.test.cjs
   GARDE-FOU : delivery_mode fige sur les items de commande.

   La dette 1 du README imposait de relire la collection products
   a chaque rendu admin pour afficher le badge Mode. Depuis le
   2026-11-19, createCustomerOrder ecrit delivery_mode sur chaque
   item ; orders.js et admin.js le lisent en priorite.

   Ce test est statique (lecture de source), sans dependance ni
   reseau : il detecte une suppression accidentelle du champ ou du
   repli legacy.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
let verifications = 0;
let echecs = 0;

function check(nom, condition) {
  verifications++;
  if (condition) {
    console.log("PASS: " + nom);
  } else {
    echecs++;
    console.error("ECHEC: " + nom);
  }
}

const fonctions = fs.readFileSync(path.join(ROOT, "functions", "index.js"), "utf8");
const orders = fs.readFileSync(path.join(ROOT, "js", "orders.js"), "utf8");
const admin = fs.readFileSync(path.join(ROOT, "js", "admin.js"), "utf8");

check(
  "createCustomerOrder ecrit delivery_mode sur chaque item",
  /delivery_mode:\s*data\.delivery_mode === 'smartswika_warehouse'\s*\?\s*'smartswika_warehouse'\s*:\s*'dropoff'/.test(fonctions)
);

check(
  "la valeur par defaut est dropoff",
  /:\s*'dropoff',/.test(fonctions.slice(fonctions.indexOf("delivery_mode:")))
);

check(
  "orders.js lit item.delivery_mode en priorite",
  orders.includes("item.delivery_mode === 'smartswika_warehouse'")
);

check(
  "orders.js ne charge les produits que si necessaire",
  orders.includes("needsProductFallback")
);

check(
  "admin.js filtre la preparation par item.delivery_mode",
  admin.includes("item.delivery_mode === 'smartswika_warehouse'")
);

check(
  "admin.js ne charge les produits qu en repli",
  admin.includes("if (needsProductFallback)")
);

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Delivery_mode des commandes : verifie.");
