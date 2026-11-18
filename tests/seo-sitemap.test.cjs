/* ============================================================
   tests/seo-sitemap.test.cjs
   GARDE-FOU : coherence sitemap / canonicals / cleanUrls.
   ------------------------------------------------------------
   Audit du 2026-11-18. Trois defauts constates en production :
     - "/villes" etait declare dans le sitemap mais repondait 404 ;
     - "/villesmaroc.html" y figurait aussi et repondait 308 vers
       "/villesmaroc" (deux URLs pour une seule page) ;
     - "/inscription-vendeur.html" y figurait alors que la page est
       en noindex.

   Regles verifiees ici :
     1. chaque URL du sitemap correspond a un fichier reel
        (cleanUrls : "/x" -> x.html, "/" -> index.html) ;
     2. aucune URL avec extension .html ;
     3. aucune page noindex dans le sitemap ;
     4. le canonical de chaque page listee == son URL de sitemap ;
     5. pas de doublon ; "/villes" reste interdit.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SITE = "https://smartswika.ma";

const sitemap = fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8");
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

let verifications = 0;
let echecs = 0;

function ok(nom, detail) {
  verifications++;
  console.log("PASS: " + nom + (detail ? " -> " + detail : ""));
}

function ko(nom, detail) {
  verifications++;
  echecs++;
  console.error("ECHEC: " + nom + (detail ? " -> " + detail : ""));
}

function verifie(nom, condition, detail) {
  condition ? ok(nom, detail) : ko(nom, detail);
}

/* --------------------------------------------- 0. sitemap lisible */

verifie("sitemap : au moins 5 URLs", locs.length >= 5, locs.length + " URL(s)");

verifie(
  "sitemap : aucun doublon",
  new Set(locs).size === locs.length
);

verifie(
  "sitemap : /villes (404 en prod) absent",
  !locs.includes(SITE + "/villes")
);

/* --------------------------------------------- 1 a 4, page par page */

const pagesNoindex = [];

for (const loc of locs) {
  const rel = loc.replace(SITE, "");
  const fichier = rel === "/" ? "index.html" : rel.replace(/^\//, "") + ".html";
  const abs = path.join(ROOT, fichier);

  if (!fs.existsSync(abs)) {
    ko("fichier present pour " + rel, fichier + " introuvable");
    continue;
  }

  const html = fs.readFileSync(abs, "utf8");
  const robots = html.match(/<meta\s+name="robots"\s+content="([^"]+)"/i);
  const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);

  if (rel.endsWith(".html")) {
    ko("URL sans extension : " + rel, "le sitemap ne doit pas contenir .html");
  }

  if (robots && /noindex/i.test(robots[1])) {
    pagesNoindex.push(rel);
    ko("page indexable : " + rel, "la page est en noindex mais listee dans le sitemap");
  }

  if (canonical && canonical[1].replace(/\/$/, "") !== loc.replace(/\/$/, "")) {
    ko(
      "canonical aligne : " + rel,
      "canonical=" + canonical[1] + " / sitemap=" + loc
    );
  }
}

verifie(
  "sitemap : aucune page noindex listee",
  pagesNoindex.length === 0,
  pagesNoindex.join(", ") || "aucune"
);

/* --------------------------------------------- 5. nettoyage attendu */

verifie(
  "sitemap : /villesmaroc liste une seule fois",
  locs.filter((l) => l.startsWith(SITE + "/villesmaroc")).length === 1
);

verifie(
  "sitemap : /inscription-vendeur (noindex) absent",
  !locs.some((l) => l.startsWith(SITE + "/inscription-vendeur"))
);

/* --------------------------------------------- 6. firebase.json */

let hosting = null;

try {
  hosting = JSON.parse(fs.readFileSync(path.join(ROOT, "firebase.json"), "utf8")).hosting;
  verifie("firebase.json : JSON valide", true);
} catch (e) {
  ko("firebase.json : JSON valide", e.message);
}

if (hosting) {
  const redirects = Array.isArray(hosting.redirects) ? hosting.redirects : [];
  const villesRedirect = redirects.find(
    (r) => r.source === "/villes" && r.destination === "/villesmaroc"
  );

  verifie(
    "firebase.json : /villes redirige en 301 vers /villesmaroc",
    !!villesRedirect && Number(villesRedirect.type) === 301,
    villesRedirect ? "type " + villesRedirect.type : "redirection absente"
  );

  verifie(
    "firebase.json : cleanUrls actif (URLs sans .html)",
    hosting.cleanUrls === true
  );
}

/* --------------------------------------------- resume */

console.log("\n" + verifications + " verification(s), " + echecs + " echec(s)");
process.exit(echecs === 0 ? 0 : 1);
