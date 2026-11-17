/* ============================================================
   scripts/audit-i18n.cjs
   ------------------------------------------------------------
   Audit de traduction du site : vérifie que CHAQUE page publique
   a un sélecteur de langue et signale les textes codés en dur.

   Sortie :
     - code 0 si aucune page publique n a de problème bloquant ;
     - code 1 sinon (utilisable en CI).

   Pages EXCLUES (internes, non traduites volontairement) :
     admin.html, generer-villes.html

   USAGE :
     node scripts/audit-i18n.cjs
     node scripts/audit-i18n.cjs --verbose   (liste les textes durs)
   ============================================================ */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const VERBOSE = process.argv.includes("--verbose");

/* Pages internes exclues de l exigence de traduction. */
const EXCLUDED = new Set(["admin.html", "generer-villes.html"]);

/* ---------------------------------------------
   Chargement des traductions (site + vendeur)
   --------------------------------------------- */

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "translations.js"), "utf8"), sandbox);
const vendorFile = path.join(ROOT, "js", "translations-vendor.js");
if (fs.existsSync(vendorFile)) {
  vm.runInContext(fs.readFileSync(vendorFile, "utf8"), sandbox);
}
const T = sandbox.window.translations || {};

const known = new Set();
Object.keys(T).forEach((l) => {
  Object.values(T[l]).forEach((v) => {
    known.add(String(v).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().toLowerCase());
  });
});

/* Mots isolés légitimes (marques, prénoms, unités). */
const IGNORE = new Set(["smartswika", "whatsapp", "instagram", "tiktok", "mad", "email", "e-mail"]);

/* ---------------------------------------------
   Parcours des pages
   --------------------------------------------- */

function listPages(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "css" || entry.name === "assets") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listPages(abs, acc);
    } else if (entry.name.endsWith(".html")) {
      acc.push(path.relative(ROOT, abs));
    }
  }
  return acc;
}

const pages = listPages(ROOT, []).sort();

const problems = [];
let totalHard = 0;

console.log("");
console.log("AUDIT TRADUCTION — " + Object.keys(T).join(" / "));
console.log("");

for (const rel of pages) {
  const isExcluded = EXCLUDED.has(rel);
  const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");

  const hasSelector = /id=["']langSelect["']/.test(raw);

  /* Textes codés en dur (hors scripts, styles, commentaires). */
  let html = raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const bodyAt = html.search(/<body/i);
  if (bodyAt >= 0) html = html.slice(bodyAt);

  const hard = [];
  const re = />([^<>]{3,})</g;
  let m;
  while ((m = re.exec(html))) {
    const text = m[1].replace(/\s+/g, " ").trim();
    if (!/[A-Za-z\u0600-\u06FF]{3,}/.test(text)) continue;
    const low = text.toLowerCase();
    if (known.has(low) || IGNORE.has(low)) continue;
    hard.push(text);
  }
  const uniq = [...new Set(hard)];
  totalHard += uniq.length;

  let status = "OK  ";
  const notes = [];

  if (!isExcluded) {
    if (!hasSelector) {
      status = "FAIL";
      notes.push("aucun sélecteur de langue");
      problems.push(rel + " : sélecteur de langue manquant");
    }
    if (uniq.length > 0) {
      status = status === "FAIL" ? "FAIL" : "WARN";
      notes.push(uniq.length + " texte(s) codé(s) en dur");
    }
  } else {
    status = "SKIP";
    notes.push("page interne");
  }

  console.log("  " + status + "  " + rel.padEnd(34) + uniq.length.toString().padStart(4) + " durs" + (notes.length ? "  (" + notes.join(" ; ") + ")" : ""));

  if (VERBOSE && uniq.length) {
    uniq.slice(0, 12).forEach((t) => console.log("         | " + t.slice(0, 88)));
    if (uniq.length > 12) console.log("         | ... et " + (uniq.length - 12) + " autres");
  }
}

console.log("");
console.log("Total textes durs (toutes pages) : " + totalHard);

if (problems.length) {
  console.log("");
  console.log("PROBLEMES BLOQUANTS (" + problems.length + ") :");
  problems.forEach((p) => console.log("  - " + p));
  console.log("");
  process.exit(1);
}

console.log("");
console.log("Aucun probleme bloquant : toutes les pages publiques ont un selecteur de langue.");
console.log("");
process.exit(0);
