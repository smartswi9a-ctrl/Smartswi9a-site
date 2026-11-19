/* ============================================================
   tests/contract-1-6.test.mjs
   GARDE-FOU : contrat vendeur 1.6.0 (entrepot, SKU, etiquettes).
   ============================================================ */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../js/config.js";
import { getContractText } from "../js/vendor-contract-text.js";

const ROOT = path.join(import.meta.dirname, "..");
let verifications = 0;
let echecs = 0;

function check(nom, fn) {
    verifications++;
    try {
        fn();
        console.log("PASS: " + nom);
    } catch (e) {
        echecs++;
        console.error("ECHEC: " + nom + " -> " + e.message);
    }
}

check("version contrat = 1.6.0", () => {
    assert.strictEqual(CONFIG.VENDOR.CONTRACT_VERSION, "1.6.0");
});

for (const [lang, marker, oldHeading] of [
    ["fr", "Stock, SKU et étiquetage", "Expédition"],
    ["en", "Stock, SKU and labelling", "Shipping"],
    ["ar", "المخزون وSKU والملصقات", "الشحن"],
]) {
    check("contrat 1.6.0 " + lang + " : article 4 remplace", () => {
        const text = getContractText(lang, "1.6.0");
        assert.ok(text.includes(marker), "article 4 absent");
        assert.ok(!text.includes(oldHeading), "ancien article 4 encore present");
        assert.ok(text.includes("Code 128"));
    });
}

check("functions : version 1.6.0 et article 4", () => {
    const src = fs.readFileSync(path.join(ROOT, "functions", "index.js"), "utf8");
    assert.ok(src.includes("CONTRACT_VERSION: '1.6.0'"));
    assert.ok(src.includes("Article 4 — Stock, SKU et étiquetage"));
});

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) process.exit(1);
console.log("Contrat 1.6.0 : verifie.");
