/* ============================================================
   tests/barcode-sku.test.mjs
   GARDE-FOU : Code 128B + SKU de ramassage.
   ============================================================ */
import assert from "node:assert";
import { buildCode128Svg, code128BValues, isValidCode128B } from "../js/barcode-code128.js";
import { pickupSku, normalizeReceivedQuantity } from "../js/domain/pickup-sku.js";

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

check("Code128B : A = START_B, 33, checksum 34", () => {
    assert.deepStrictEqual(code128BValues("A"), [104, 33, 34]);
});

check("Code128B : checksum pondere", () => {
    assert.deepStrictEqual(code128BValues("AB"), [104, 33, 34, 102]);
});

check("Code128B : caracteres non encodables refuses", () => {
    assert.strictEqual(isValidCode128B("SWK-ABC-01"), true);
    assert.strictEqual(isValidCode128B("é"), false);
    assert.throws(() => code128BValues("é"));
});

check("SVG : structure et barres", () => {
    const svg = buildCode128Svg("SWK-ABC-01", { moduleWidth: 2, height: 40 });
    assert.ok(svg.startsWith("<svg"));
    assert.ok(svg.includes("<rect"));
    assert.ok(svg.includes("SWK-ABC-01"));
    assert.ok(svg.includes("viewBox="));
});

check("SKU : deterministe et lisible", () => {
    assert.strictEqual(pickupSku("ABC123456789", 0), "SWK-456789-01");
    assert.strictEqual(pickupSku("ABC123456789", 11), "SWK-456789-12");
});

check("SKU : meme demande = meme SKU", () => {
    assert.strictEqual(pickupSku("req-AAAA1111", 2), pickupSku("req-AAAA1111", 2));
    assert.notStrictEqual(pickupSku("req-AAAA1111", 2), pickupSku("req-BBBB2222", 2));
});

check("Quantite recue : bornee a la quantite declaree", () => {
    assert.strictEqual(normalizeReceivedQuantity(8, 10), 8);
    assert.strictEqual(normalizeReceivedQuantity(15, 10), 10);
    assert.strictEqual(normalizeReceivedQuantity(-2, 10), 10);
    assert.strictEqual(normalizeReceivedQuantity("x", 10), 10);
});

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) process.exit(1);
console.log("Code 128 + SKU : verifies.");
