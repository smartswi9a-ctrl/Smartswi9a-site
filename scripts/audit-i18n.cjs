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

/* ---------------------------------------------
   Détection des textes SANS traduction
   ---------------------------------------------
   Un noeud texte est considéré comme traduit si :
     - son élément porte data-key ou data-i18n, ou
     - un de ses ancêtres (max 6 niveaux) en porte un, ou
     - il est dans <script>, <style>, <noscript>.

   DIFFÉRENCE CLÉ avec l ancienne version : on retire les emojis avant
   de comparer. "🏪 Espace vendeur" sans data-key doit être signalé,
   car l ancienne comparaison le croyait traduit (l emoji faisait
   échouer la correspondance et il passait pour "connu").
   --------------------------------------------- */

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu;

function normalizeText(t) {
  return t.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
}

/* Un texte est-il couvert par un mécanisme de traduction ? */
function isTranslatedAt(html, index) {
  const before = html.slice(0, index);
  const tags = before.match(/<([a-z][a-z0-9]*)\b[^>]*>/gi) || [];
  /* Les 6 dernières balises ouvrantes = chaîne d ancêtres probable. */
  for (const tag of tags.slice(-6)) {
    if (/^<(script|style|noscript)/i.test(tag)) return true;
    if (/data-key\s*=|data-i18n\s*=|data-placeholder-key\s*=/.test(tag)) return true;
  }
  return false;
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

  /* On neutralise les zones non visibles en CONSERVANT la longueur
     (remplacement par des espaces), pour que les index restent alignés
     avec le HTML d origine. Sinon les faux positifs <script>/<style>
     polluent le rapport. */
  const masked = raw
    .replace(/<script[\s\S]*?<\/script>/gi, (s) => " ".repeat(s.length))
    .replace(/<style[\s\S]*?<\/style>/gi, (s) => " ".repeat(s.length))
    .replace(/<!--[\s\S]*?-->/g, (s) => " ".repeat(s.length));

  const hard = [];
  const re = />([^<>]{3,})</g;
  let m;
  while ((m = re.exec(masked))) {
    const index = m.index;
    const text = normalizeText(m[1]);
    if (!/[A-Za-z\u0600-\u06FF]{3,}/.test(text)) continue;

    /* Déjà couvert par data-key / data-i18n / data-placeholder-key ? */
    if (isTranslatedAt(raw, index)) continue;

    const low = text.toLowerCase();
    if (IGNORE.has(low)) continue;
    if (known.has(low)) continue;

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
