/* ============================================================
   tests/navbar-mobile.test.cjs
   GARDE-FOU : lien "Koulchi dialk" dans la navbar mobile.
   ------------------------------------------------------------
   Le lien existait dans le menu desktop de l accueil, mais etait
   absent de TOUS les menus mobiles (signalement client du
   2026-11-19). Ce test echoue si le lien disparait d une page
   qui possede un menu mobile.

   Aucune dependance, aucun reseau.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
let verifications = 0;
let echecs = 0;

function check(nom, condition, detail) {
  verifications++;
  if (condition) {
    console.log("PASS: " + nom);
  } else {
    echecs++;
    console.error("ECHEC: " + nom + (detail ? " -> " + detail : ""));
  }
}

const fichiers = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith(".html"))
  .sort();

let pagesAvecMenu = 0;

for (const fichier of fichiers) {
  const html = fs.readFileSync(path.join(ROOT, fichier), "utf8");
  const indexMenu = html.indexOf('id="mobileMenu"');
  if (indexMenu === -1) continue;

  pagesAvecMenu++;
  const finBloc = html.indexOf("</div>", indexMenu);
  const bloc = finBloc === -1 ? "" : html.slice(indexMenu, finBloc);

  check(fichier + " : menu mobile ferme", finBloc !== -1);
  check(
    fichier + " : lien Koulchi present dans le menu mobile",
    bloc.indexOf('data-key="navKoulchi"') !== -1 &&
      bloc.indexOf('href="/koulchi.html"') !== -1
  );

  const posProduits = bloc.indexOf('data-key="navProducts"');
  const posKoulchi = bloc.indexOf('data-key="navKoulchi"');
  check(
    fichier + " : Koulchi place apres Produits",
    posProduits !== -1 && posKoulchi > posProduits
  );
}

check("au moins 7 pages avec menu mobile", pagesAvecMenu >= 7, String(pagesAvecMenu));

/* ---------- En-tête des pages vendeur (logo) ---------- */

const inscription = fs.readFileSync(path.join(ROOT, "inscription-vendeur.html"), "utf8");
check(
  "inscription-vendeur : logo au format standard (.logo + .logo-img + .logo-text)",
  inscription.includes('class="logo"') &&
    inscription.includes('class="logo-img"') &&
    inscription.includes('class="logo-text"'),
  "le logo inline (image au-dessus du texte) cassait la navbar"
);
check(
  "inscription-vendeur : plus de lien logo stylé en inline",
  !/<a href="\/" style="font-family:var\(--font-secondary\);font-size:1\.5rem/.test(inscription)
);
check(
  "inscription-vendeur : navbar sticky + hauteur auto (pas de débordement)",
  /html body\.vendor-page #navbar \{[\s\S]*?position: sticky;[\s\S]*?height: auto;/.test(
    fs.readFileSync(path.join(ROOT, "style-patches.css"), "utf8")
  )
);

/* ---------- Texte : entrepôt Smart Swika, pas Livo ---------- */

const traductions = fs.readFileSync(path.join(ROOT, "translations.js"), "utf8");
check(
  "mode livraison : stock annoncé à l'entrepôt Smart Swika (plus « chez Livo »)",
  traductions.includes("Vous envoyez votre stock à l'entrepôt Smart Swika") &&
    traductions.includes("You send your stock to the Smart Swika warehouse") &&
    traductions.includes("ترسل مخزونك إلى مستودع سمارت سويقة") &&
    !traductions.includes("Vous envoyez votre stock chez Livo")
);

/* ---------- Aucun espace perdu en haut de page ---------- */

const css = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
const patches = fs.readFileSync(path.join(ROOT, "style-patches.css"), "utf8");
const spacing = fs.readFileSync(path.join(ROOT, "spacing.css"), "utf8");

check(
  "body : décalage haut strictement égal à la hauteur de navbar",
  /body \{[\s\S]{0,400}?padding-top: var\(--nav-height\);/.test(css) &&
    !/padding-top: calc\(var\(--nav-height\) \+ \d+px/.test(css + patches + spacing)
);
check(
  "mobile : navbar ramenée à 60px (10px de gagnés)",
  /@media \(max-width: 640px\) \{[\s\S]{0,120}?--nav-height: 60px;/.test(css)
);
check(
  "/vendor-login : aucun padding haut (en-tête en flux normal)",
  /html body\.vendor-login-page \{\s*padding-top: 0 !important;/.test(patches)
);
check(
  "/vendor-login mobile : liens cachés + logo non tronqué",
  /@media \(max-width: 720px\) \{[\s\S]*?\.login-top-links \{\s*display: none !important;/.test(patches) &&
    /\.login-topbar \.logo-text \{[\s\S]*?text-overflow: clip;/.test(patches)
);

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Navbar mobile : lien Koulchi verifie sur " + pagesAvecMenu + " page(s).");
