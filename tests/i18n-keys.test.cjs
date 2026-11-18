/* ============================================================
   tests/i18n-keys.test.cjs
   GARDE-FOU TRADUCTION
   ------------------------------------------------------------
   Verifie que TOUTE cle appelee dans le code existe dans les trois
   langues (fr / ar / en). Sans ce test, une cle oubliee s affiche
   telle quelle a l ecran ("couponApplied") : c est exactement ce qui
   est arrive avec un translations.js en cache.

   Sources scannees :
     - js/*.js            : t("cle")
     - *.html + vendor/   : data-key, data-aria-key,
                            data-placeholder-key, data-title-key

   Les cles construites dynamiquement (t(variable)) sont ignorees :
   elles ne peuvent pas etre verifiees statiquement.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const LANGS = ["fr", "ar", "en"];

/* --------------------------------------------- chargement
   On charge translations.js PUIS js/translations-vendor.js, qui complete
   window.translations pour le dashboard vendeur et le contrat. */
const sandbox = { window: {} };
for (const file of ["translations.js", "js/translations-vendor.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox, {
    timeout: 5000,
  });
}
const translations = sandbox.window.translations;

if (!translations || !translations.fr) {
  console.error("ECHEC : translations.js ne definit pas window.translations.fr");
  process.exit(1);
}

/* --------------------------------------------- collecte */
const used = new Map(); /* cle -> Set(fichier) */

function addKey(key, file) {
  if (!key) return;
  /* Cle construite dynamiquement (ex. tr("vendor.field." + name)) : on ne
     peut pas la verifier statiquement, on l ignore. */
  if (key.endsWith(".")) return;
  if (!used.has(key)) used.set(key, new Set());
  used.get(key).add(file);
}

/* 1. Modules JS */
const JS_EXCLUDE = ["translations-li", "translations-ve"];
for (const file of fs.readdirSync(path.join(ROOT, "js"))) {
  if (!file.endsWith(".js")) continue;
  if (JS_EXCLUDE.some((skip) => file.startsWith(skip))) continue;
  const src = fs.readFileSync(path.join(ROOT, "js", file), "utf8");
  const reT = /\bt\(\s*["']([A-Za-z0-9_]+)["']\s*\)/g;
  let m;
  while ((m = reT.exec(src))) addKey(m[1], "js/" + file);
  /* Les modules vendeur utilisent tr("cle", "fallback") : le fallback est
     du francais en dur, donc la cle DOIT exister en ar / en. */
  const reTr = /\btr\(\s*["']([A-Za-z0-9_.]+)["']/g;
  while ((m = reTr.exec(src))) addKey(m[1], "js/" + file);
}

/* 2. Pages HTML */
function listHtml(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        ".git",
        "css",
        "assets",
        "functions",
        "cloudflare",
        "docs",
        "scripts",
        "tests",
        ".playwright-mcp",
      ].includes(entry.name)
    ) {
      continue;
    }
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) listHtml(abs, acc);
    else if (entry.name.endsWith(".html")) acc.push(abs);
  }
  return acc;
}

for (const page of listHtml(ROOT, [])) {
  const html = fs.readFileSync(page, "utf8");
  const rel = path.relative(ROOT, page).replace(/\\/g, "/");
  const re =
    /data-(?:key|aria-key|placeholder-key|title-key)="([A-Za-z0-9_]+)"/g;
  let m;
  while ((m = re.exec(html))) addKey(m[1], rel);
}

/* --------------------------------------------- verification */
let missing = 0;
const report = [];

for (const lang of LANGS) {
  const dict = translations[lang] || {};
  for (const [key, files] of used) {
    if (dict[key] === undefined) {
      missing += 1;
      report.push(
        "  MANQUE " + lang + " : " + key + "  (" + [...files].join(", ") + ")"
      );
    }
  }
}

/* Parite stricte : les trois langues doivent avoir le meme nombre de cles. */
const counts = LANGS.map((lang) => Object.keys(translations[lang] || {}).length);
const parity = counts.every((n) => n === counts[0]);

console.log("Cles utilisees dans le code : " + used.size);
console.log("Cles par langue : " + LANGS.map((l, i) => l + "=" + counts[i]).join(" · "));

if (report.length) {
  console.log("\n" + report.slice(0, 60).join("\n"));
  if (report.length > 60) console.log("  ... et " + (report.length - 60) + " autres");
}

if (!parity) {
  console.log("\nECHEC : les langues n ont pas le meme nombre de cles.");
  process.exit(1);
}
if (missing > 0) {
  console.log("\nECHEC : " + missing + " cle(s) manquante(s).");
  process.exit(1);
}

console.log("OK — toutes les cles existent en fr / ar / en.");
