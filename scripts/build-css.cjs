/* ============================================================
   scripts/build-css.cjs
   ------------------------------------------------------------
   PROBLEME RESOLU PAR CE SCRIPT
   Les pages HTML chargent le CSS sous une forme HACHEE :

       /css/style.<8 premiers caracteres du SHA256>.css
       /css/style-patches.<...>.css

   Ces fichiers sont des COPIES de style.css et style-patches.css.
   Si on modifie la source sans regenerer la copie, le navigateur
   continue de recevoir l ANCIENNE version : les corrections CSS
   n apparaissent jamais, meme apres un deploiement.

   C est exactement ce qui s est produit pour les drapeaux du
   selecteur de langue (police emoji absente de la version servie).

   CE SCRIPT
     1. calcule le SHA256 de chaque source CSS ;
     2. ecrit css/<nom>.<hash8>.css ;
     3. reecrit les <link rel="stylesheet"> des pages HTML ;
     4. supprime les anciennes copies devenues orphelines.

   USAGE
     node scripts/build-css.cjs            (applique)
     node scripts/build-css.cjs --dry-run  (simule)
   ============================================================ */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const CSS_DIR = path.join(ROOT, "css");
const DRY = process.argv.includes("--dry-run");

/* Sources CSS a versionner. */
const SOURCES = ["style.css", "style-patches.css"];

/* Pages HTML qui referencent le CSS (toute la racine + vendor/). */
function listHtml(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "css", "assets", "functions", "cloudflare", "docs", "scripts"].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) listHtml(abs, acc);
    else if (entry.name.endsWith(".html")) acc.push(abs);
  }
  return acc;
}

function hash8(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
}

if (!fs.existsSync(CSS_DIR)) fs.mkdirSync(CSS_DIR, { recursive: true });

/* ---------------------------------------------
   1. Generer les copies hachees
   --------------------------------------------- */

const mapping = {}; /* "style.css" -> "style.138d2b5f.css" */

for (const src of SOURCES) {
  const abs = path.join(ROOT, src);
  if (!fs.existsSync(abs)) {
    console.warn("  [skip] source absente : " + src);
    continue;
  }
  const h = hash8(abs);
  const base = src.replace(/\.css$/, "");
  const outName = base + "." + h + ".css";
  const outAbs = path.join(CSS_DIR, outName);

  mapping[src] = outName;

  if (!DRY) fs.copyFileSync(abs, outAbs);
  console.log("  " + src.padEnd(22) + " -> css/" + outName);
}

/* ---------------------------------------------
   2. Reecrire les liens dans le HTML
   --------------------------------------------- */

const pages = listHtml(ROOT, []);
let touched = 0;

for (const page of pages) {
  let html = fs.readFileSync(page, "utf8");
  const before = html;

  for (const [src, outName] of Object.entries(mapping)) {
    const base = src.replace(/\.css$/, "");
    /* Remplace n importe quelle version hachee existante du meme fichier. */
    const re = new RegExp("/css/" + base + "\\.[0-9a-f]{8}\\.css", "g");
    html = html.replace(re, "/css/" + outName);
  }

  /* Certaines pages n incluent PAS style-patches.css (ex. dashboard vendeur).
     Sans ce fichier, les correctifs recents (police emoji des drapeaux,
     styles des ventes flash...) ne s appliquent pas. On l ajoute apres
     la feuille principale si elle est presente. */
  const patchesOut = mapping["style-patches.css"];
  if (patchesOut && !html.includes("/css/" + patchesOut)) {
    const mainOut = mapping["style.css"];
    const mainLinkRe = new RegExp('(<link[^>]+href="/css/' + (mainOut || "").replace(".", "\\.") + '"[^>]*>)');
    if (mainOut && mainLinkRe.test(html)) {
      html = html.replace(mainLinkRe, '$1\n    <link rel="stylesheet" href="/css/' + patchesOut + '">');
    }
  }

  if (html !== before) {
    if (!DRY) fs.writeFileSync(page, html, "utf8");
    touched++;
    console.log("  MAJ  " + path.relative(ROOT, page));
  }
}

/* ---------------------------------------------
   3. Nettoyer les anciennes copies orphelines
   --------------------------------------------- */

const keep = new Set(Object.values(mapping));
const removed = [];

for (const file of fs.readdirSync(CSS_DIR)) {
  if (!/^style(-patches)?\.[0-9a-f]{8}\.css$/.test(file)) continue;
  if (keep.has(file)) continue;
  if (!DRY) fs.unlinkSync(path.join(CSS_DIR, file));
  removed.push(file);
}

console.log("");
if (removed.length) {
  console.log((DRY ? "A supprimer : " : "Supprime : ") + removed.join(", "));
}
console.log((DRY ? "Simulation : " : "") + touched + " page(s) mise(s) a jour.");

/* Verifier que plus aucune page ne pointe vers une version perimee.
   En mode --dry-run les pages ne sont pas ecrites : on relit alors le
   contenu deja reecrit en memoire, pas le fichier sur disque. */
let stale = 0;
for (const page of pages) {
  let html = fs.readFileSync(page, "utf8");
  if (DRY) {
    for (const [src, outName] of Object.entries(mapping)) {
      const base = src.replace(/\.css$/, "");
      const re = new RegExp("/css/" + base + "\\.[0-9a-f]{8}\\.css", "g");
      html = html.replace(re, "/css/" + outName);
    }
  }
  for (const [src, outName] of Object.entries(mapping)) {
    const base = src.replace(/\.css$/, "");
    const re = new RegExp("/css/" + base + "\\.([0-9a-f]{8})\\.css", "g");
    let m;
    while ((m = re.exec(html))) {
      if (m[1] !== outName.replace(/^.*\.([0-9a-f]{8})\.css$/, "$1")) stale++;
    }
  }
}

console.log(stale === 0 ? "OK — toutes les pages pointent vers le CSS a jour." : "ATTENTION — " + stale + " reference(s) perimee(s) restante(s).");
process.exit(stale === 0 ? 0 : 1);
