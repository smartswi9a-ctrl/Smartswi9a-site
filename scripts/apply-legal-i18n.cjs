/* ============================================================
   scripts/apply-legal-i18n.cjs
   ------------------------------------------------------------
   Objectif : rendre les pages légales traduisibles (FR / AR / EN).

   Le contenu juridique est long et structuré (titres, paragraphes,
   listes). Poser les data-key à la main serait long et fragile.

   Ce script :
     1. lit chaque page légale ;
     2. attribue une clé stable à chaque élément de texte
        (h1/h2/h3/h4, p, li, th, td, label, summary, figcaption) ;
     3. ajoute l attribut data-key sur la balise si absent ;
     4. génère un fichier JSON des textes sources (FR) à traduire.

   Les clés sont dérivées du fichier + d un index séquentiel :
   ex. `cguA1`, `cguA2` pour cgu-acheteur.html.
   L ordre est déterministe : relancer le script ne change rien.

   UTILISATION :
     node scripts/apply-legal-i18n.cjs            (applique)
     node scripts/apply-legal-i18n.cjs --dry-run  (simule)

   NOTE : ne traite PAS les pages du dossier admin (interne).
   ============================================================ */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/* Préfixe de clé par page. */
const PAGES = {
  "cgu-acheteur.html": "cguA",
  "cgu-vendeur.html": "cguV",
  "contrat-vendeur.html": "ctrV",
  "politique-confidentialite.html": "priv",
};

/* Balises dont le texte est traduisible. */
const TAGS = ["h1", "h2", "h3", "h4", "p", "li", "th", "td", "label", "summary", "figcaption", "strong", "em"];

const DRY = process.argv.includes("--dry-run");

/* ---------------------------------------------
   Utilitaires
   --------------------------------------------- */

function hasTextOnlyChildren(inner) {
  /* On n attribue une clé que si le contenu est du texte simple
     (aucune balise enfant bloquante). Les <a>, <strong> et <em> sont
     acceptés car sans impact sur le sens. */
  const stripped = inner.replace(/<\/?(a|strong|em|b|i|span)\b[^>]*>/gi, "");
  return !/<[a-z!/]/i.test(stripped);
}

function normalize(text) {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------------------------------------------
   Traitement
   --------------------------------------------- */

const output = {};

for (const [file, prefix] of Object.entries(PAGES)) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.warn("  [skip] absent : " + file);
    continue;
  }

  let html = fs.readFileSync(abs, "utf8");
  const original = html;

  /* On ne touche pas au contenu des scripts ni des styles. */
  const protectedRanges = [];
  const protectRe = /<(script|style)\b[\s\S]*?<\/\1>/gi;
  let pm;
  while ((pm = protectRe.exec(html))) {
    protectedRanges.push([pm.index, pm.index + pm[0].length]);
  }
  const isProtected = (idx) => protectedRanges.some(([a, b]) => idx >= a && idx < b);

  const tagRe = new RegExp("<(" + TAGS.join("|") + ")(\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>", "gi");

  let counter = 0;
  const entries = [];
  const matches = [];

  let m;
  while ((m = tagRe.exec(html))) {
    if (isProtected(m.index)) continue;
    const attrs = m[2] || "";
    if (/data-key\s*=/.test(attrs)) continue;

    const inner = m[3];
    if (!hasTextOnlyChildren(inner)) continue;

    const text = normalize(inner);
    if (text.length < 2) continue;
    /* Ignorer les numéros/ponctuations seuls. */
    if (!/[A-Za-z\u0600-\u06FF]{2,}/.test(text)) continue;

    matches.push({ full: m[0], tag: m[1], attrs, inner, text, index: m.index });
  }

  /* On reconstruit du dernier au premier pour ne pas invalider les index. */
  for (let i = matches.length - 1; i >= 0; i--) {
    const item = matches[i];
    counter++;
    const key = prefix + String(counter).padStart(3, "0");
    entries.unshift({ key, tag: item.tag, text: item.text });

    const newOpen = "<" + item.tag + item.attrs + ' data-key="' + key + '">';
    const newFull = newOpen + item.inner + "</" + item.tag + ">";
    html = html.slice(0, item.index) + newFull + html.slice(item.index + item.full.length);
  }

  if (html !== original && !DRY) {
    fs.writeFileSync(abs, html, "utf8");
  }

  output[file] = entries;
  console.log("  " + file.padEnd(34) + entries.length + " cles" + (DRY ? " (simulation)" : ""));
}

/* ---------------------------------------------
   Sortie : JSON des textes FR à traduire
   --------------------------------------------- */

const outFile = path.join(ROOT, "docs", "i18n-legal-fr.json");
if (!DRY) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), "utf8");
  console.log("");
  console.log("Textes FR extraits -> " + path.relative(ROOT, outFile));

  const total = Object.values(output).reduce((n, arr) => n + arr.length, 0);
  console.log("Total : " + total + " textes a traduire en AR et EN.");
}
