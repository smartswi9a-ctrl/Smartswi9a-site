/* ============================================================
   tests/importmap.test.cjs
   GARDE-FOU : import maps des pages statiques.
   ------------------------------------------------------------
   Un import map incomplet casse TOUTE la page silencieusement :

     Uncaught TypeError: Failed to resolve module specifier
     "firebase/storage". Relative references must start with
     either "/", "./", or "../".

   Bug reel corrige le 2026-11-19 : reset-password.html importait
   /js/firebase.js (qui depend de firebase/storage) sans mapper
   cette entree. La page de reinitialisation du mot de passe etait
   donc entierement inerte.

   Verifie pour chaque page :
     - import map en JSON valide ;
     - les 4 entrees firebase (app, auth, firestore, storage) ;
     - import map place avant le premier <script type="module">.
   ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const REQUIRED = ["firebase/app", "firebase/auth", "firebase/firestore", "firebase/storage"];

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

function pagesHtml(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) pagesHtml(full, acc);
    else if (entry.name.endsWith(".html")) acc.push(full);
  }
  return acc;
}

function readMap(html) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("bloc import map introuvable");
  return JSON.parse(m[1]);
}

const pages = pagesHtml(ROOT, []);
const withMap = pages.filter((p) => fs.readFileSync(p, "utf8").includes('type="importmap"'));

check("import maps : au moins une page en declare un", () => {
  if (withMap.length === 0) throw new Error("aucun import map trouve dans le site");
});

for (const file of withMap) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const html = fs.readFileSync(file, "utf8");

  check("import map JSON valide (" + rel + ")", () => {
    const parsed = readMap(html);
    if (!parsed || typeof parsed.imports !== "object" || parsed.imports === null) {
      throw new Error("cle \"imports\" absente");
    }
  });

  check("import map complet (" + rel + ")", () => {
    const parsed = readMap(html);
    const missing = REQUIRED.filter((key) => !(key in parsed.imports));
    if (missing.length > 0) throw new Error("entree(s) manquante(s) : " + missing.join(", "));
  });

  check("import map avant le premier module (" + rel + ")", () => {
    const posMap = html.indexOf('type="importmap"');
    const posModule = html.indexOf('type="module"');
    if (posModule !== -1 && posModule < posMap) {
      throw new Error("un <script type=\"module\"> precede l import map");
    }
  });
}

/* --------------------------------------------- resume */

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Import maps : coherents (" + withMap.length + " page(s)).");
