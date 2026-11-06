const fs = require("node:fs");
const assert = require("node:assert/strict");

const read = (file) => fs.readFileSync(file, "utf8");
const config = read("js/config.js");
const contractText = read("js/vendor-contract-text.js");
const contractClient = read("js/vendor-contract.js");
const signup = read("js/vendor-signup.js");
const dashboard = read("js/vendor-dashboard.js");
const functions = read("functions/index.js");
const firestoreRules = read("firestore.rules");
const storageRules = read("storage.rules");
const worker = read("cloudflare/workers/smart-swi9a-api.js");
const firebase = JSON.parse(read("firebase.json"));
const admin = read("js/admin.js");

const version = config.match(/CONTRACT_VERSION:\s*['"]([^'"]+)['"]/);
assert.ok(version, "CONFIG.VENDOR.CONTRACT_VERSION doit exister.");
const contractVersion = version[1];

const serverVersion = functions.match(/CONTRACT_VERSION:\s*['"]([^'"]+)['"]/);
assert.ok(serverVersion, "OFFICIAL_VENDOR_CONFIG.CONTRACT_VERSION doit exister.");
assert.equal(serverVersion[1], contractVersion, "La version contrat client/serveur doit être identique.");

assert.match(contractText, new RegExp('["'] + contractVersion.replaceAll(".", "\\.") + '["']\\s*:'));
assert.match(functions, new RegExp('if \\(version === ["']' + contractVersion.replaceAll(".", "\\.") + '["']\\)'));
assert.match(firestoreRules, new RegExp("contractVersion', ''\\) == '" + contractVersion.replaceAll(".", "\\.") + "'"));
assert.match(storageRules, new RegExp("contractVersion', ''\\) == '" + contractVersion.replaceAll(".", "\\.") + "'"));

assert.match(contractClient, /function compareVersions/);
assert.match(contractClient, /compareVersions\(vendorInfo\.contractVersion, CONFIG\.VENDOR\.CONTRACT_VERSION\) < 0/);
assert.match(signup, /source:\s*"signup"/);
assert.match(dashboard, /source:\s*_contractSignatureSource/);
assert.match(functions, /function isOfficialVendorContract\(/);
assert.match(functions, /isOfficialVendorContract\(decoded\.uid, existingData\)/);
assert.match(functions, /isOfficialVendorContract\(vendorId, contract\)/);

const exportedFunctions = [...functions.matchAll(/exports\.([A-Za-z0-9_]+)\s*=\s*onRequest/g)]
  .map((match) => match[1]).sort();
const workerMatch = worker.match(/const ALLOWED_FUNCTIONS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(workerMatch, "La liste des fonctions autorisées du Worker doit exister.");
const workerFunctions = [...workerMatch[1].matchAll(/"([^"]+)"/g)]
  .map((match) => match[1]).sort();
const firebaseFunctions = (firebase.hosting?.rewrites || [])
  .filter((rewrite) => rewrite.function)
  .map((rewrite) => rewrite.function.functionId).sort();

assert.deepEqual(workerFunctions, exportedFunctions, "Le Worker doit exposer exactement les Cloud Functions HTTP exportées.");
assert.deepEqual(firebaseFunctions, exportedFunctions, "Les rewrites Firebase doivent correspondre aux Cloud Functions HTTP exportées.");

assert.doesNotMatch(firestoreRules, /match\s+\/_test_snapshots/);
assert.doesNotMatch(admin, /TEST_SNAPSHOT_ROOT|startTestBatch|endTestBatch/);

console.log("PASS: cohérence contrat vendeur, Cloud Functions, routes API et suppression Test Snapshot.");
