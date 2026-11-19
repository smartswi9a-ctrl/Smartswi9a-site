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

const pass = verifications - echecs;
console.log("\n" + pass + "/" + verifications + " verifications PASS");
if (echecs > 0) {
  console.error("ECHECS: " + echecs);
  process.exit(1);
}
console.log("Navbar mobile : lien Koulchi verifie sur " + pagesAvecMenu + " page(s).");
