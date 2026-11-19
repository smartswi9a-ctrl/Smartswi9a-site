/* ============================================================
   tests/css-integrity.test.cjs
   GARDE-FOU SYNTAXE CSS
   ------------------------------------------------------------
   Un bloc ouvert et jamais referme ne casse pas tout de suite :
   le navigateur transforme les regles suivantes en declarations
   invalides et les SUPPRIME silencieusement.

   C est exactement ce qui est arrive le 2026-11-17 dans
   style-patches.css : un `.cart-delivery-delay {` duplique sans
   accolade fermante a avale TOUTE la section ventes flash
   (`.flash-hero*`, `.flash-item*`). La section s affichait donc
   sans aucun style en production, et rien ne le signalait :
   ni le build, ni les tests, ni la console.

   Ce test verifie, pour chaque feuille source :
     - les accolades sont equilibrees (profondeur finale = 0) ;
     - aucune accolade fermante orpheline (profondeur < 0) ;
     - aucune declaration isolee hors de tout bloc.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const FICHIERS = ["style.css", "style-patches.css", "vendor-style.css", "css/legal.css"];

let echecs = 0;
let verifications = 0;

function ok(nom, detail) {
  verifications++;
  console.log("PASS: " + nom + (detail ? " -> " + detail : ""));
}

function ko(nom, detail) {
  verifications++;
  echecs++;
  console.error("ECHEC: " + nom + (detail ? " -> " + detail : ""));
}

/**
 * Analyse une feuille CSS et retourne les anomalies detectees.
 * Les commentaires, les chaines et les url() sont neutralises pour
 * ne pas fausser le comptage des accolades.
 */
function analyser(css) {
  const lignes = css.split(/\r?\n/);
  const anomalies = [];
  let profondeur = 0;
  let dansCommentaire = false;
  let chaine = null;

  for (let i = 0; i < lignes.length; i++) {
    const ligne = lignes[i];
    let declarationHorsBloc = null;

    for (let j = 0; j < ligne.length; j++) {
      const c = ligne[j];
      const n = ligne[j + 1];

      if (dansCommentaire) {
        if (c === "*" && n === "/") {
          dansCommentaire = false;
          j++;
        }
        continue;
      }
      if (chaine) {
        if (c === "\\") {
          j++;
          continue;
        }
        if (c === chaine) chaine = null;
        continue;
      }
      if (c === "/" && n === "*") {
        dansCommentaire = true;
        j++;
        continue;
      }
      if (c === '"' || c === "'") {
        chaine = c;
        continue;
      }

      if (c === "{") {
        profondeur++;
        declarationHorsBloc = null;
      } else if (c === "}") {
        profondeur--;
        if (profondeur < 0) {
          anomalies.push({
            type: "accolade fermante orpheline",
            ligne: i + 1,
            extrait: ligne.trim().slice(0, 100),
          });
          profondeur = 0;
        }
      } else if (profondeur === 0 && /^[a-z-]+\s*:\s*[^;{}]+;\s*$/.test(ligne.trim())) {
        /* Une vraie declaration se termine par « ; » ET tient sur sa ligne.
           Une liste de selecteurs (`button:focus-visible,`) ne finit jamais
           par « ; » : sans cette condition, tout selecteur multi-ligne
           serait signale a tort. */
        declarationHorsBloc = ligne.trim().slice(0, 100);
      }
    }

    if (declarationHorsBloc) {
      anomalies.push({
        type: "declaration hors de tout bloc",
        ligne: i + 1,
        extrait: declarationHorsBloc,
      });
    }
  }

  return { anomalies, profondeurFinale: profondeur };
}

/* ------------------------------------------------------------ execution */

for (const nom of FICHIERS) {
  const chemin = path.join(ROOT, nom);
  if (!fs.existsSync(chemin)) {
    ko("feuille presente : " + nom, "fichier introuvable");
    continue;
  }

  const { anomalies, profondeurFinale } = analyser(fs.readFileSync(chemin, "utf8"));

  if (profondeurFinale !== 0) {
    ko(
      "accolades equilibrees : " + nom,
      "profondeur finale " + profondeurFinale + " (bloc non ferme)"
    );
  } else if (anomalies.length === 0) {
    ok("syntaxe equilibree : " + nom);
  }

  for (const a of anomalies.slice(0, 5)) {
    ko(nom + " ligne " + a.ligne, a.type + " : " + a.extrait);
  }
}

/* Garde-fou cible : les regles de la section ventes flash doivent etre au
   premier niveau de style-patches.css. Le 2026-11-17, elles se sont
   retrouvees imbriquees dans un `.cart-delivery-delay {` non ferme et le
   navigateur les a toutes supprimees silencieusement. */
const patches = fs.readFileSync(path.join(ROOT, "style-patches.css"), "utf8");
const lignesPatches = patches.split(/\r?\n/);

for (const selecteur of [".flash-hero-track", ".flash-hero-badge", ".flash-item"]) {
  const ligne = lignesPatches.findIndex((l) => l.trim().startsWith(selecteur) && l.includes("{")) + 1;

  if (ligne === 0) {
    ko("regle " + selecteur + " presente", "introuvable dans style-patches.css");
    continue;
  }

  const { profondeurFinale } = analyser(lignesPatches.slice(0, ligne - 1).join("\n"));
  if (profondeurFinale === 0) {
    ok("regle " + selecteur + " au premier niveau", "ligne " + ligne);
  } else {
    ko(
      "regle " + selecteur + " au premier niveau",
      "imbriquee dans un bloc non ferme (profondeur " + profondeurFinale + ")"
    );
  }
}

/* Garde-fou cible : la grille produits doit rester responsive.
   Le 2026-11-18, les cartes mesuraient 551 px sur desktop (2 par ligne)
   et 149 px sur mobile (nom tronque). Les paliers 4 / 3 / 2 colonnes sont
   devenus une regle d affichage : on les protege ici, comme la section
   flash. Une suppression accidentelle d une media query repassera
   silencieusement en 2 colonnes partout sur desktop. */
const prodDebut = patches.indexOf("13. PRODUITS - Grille");
const prodFin = patches.indexOf("14. TRUST BAR");
const sectionGrille =
  prodDebut >= 0 && prodFin > prodDebut ? patches.slice(prodDebut, prodFin) : "";

if (!sectionGrille) {
  ko("section 13 (grille produits)", "introuvable dans style-patches.css");
} else {
  if (
    /@media\s*\(min-width:\s*1100px\)\s*\{[\s\S]*?repeat\(\s*4\s*,/.test(
      sectionGrille
    )
  ) {
    ok("grille desktop : 4 colonnes a partir de 1100px");
  } else {
    ko("grille desktop : 4 colonnes a partir de 1100px", "regle absente");
  }

  if (
    /@media\s*\(min-width:\s*768px\)\s*and\s*\(max-width:\s*1099px\)/.test(
      sectionGrille
    ) &&
    /repeat\(\s*3\s*,/.test(sectionGrille)
  ) {
    ok("grille tablette : 3 colonnes de 768 a 1099px");
  } else {
    ko("grille tablette : 3 colonnes de 768 a 1099px", "regle absente");
  }

  if (
    /@media\s*\(max-width:\s*480px\)\s*\{[\s\S]*?repeat\(\s*2\s*,/.test(
      sectionGrille
    )
  ) {
    ok("grille mobile : 2 colonnes conservees");
  } else {
    ko("grille mobile : 2 colonnes conservees", "regle absente");
  }

  if (!/repeat\(\s*1\s*,/.test(sectionGrille)) {
    ok("grille produits : aucune colonne unique (mobile dense)");
  } else {
    ko(
      "grille produits : aucune colonne unique (mobile dense)",
      "repeat(1, ...) detecte"
    );
  }
}

/* Garde-fou cible : les trois sections de contenu de l accueil.
   Le 2026-11-18, .features-grid / .trust-badges / .about-grid etaient
   en UNE colonne sans media query : ~3067 px de defilement a 1440 px.
   On protege les nouveaux paliers. */
const contenuDebut = patches.indexOf("13 bis. SECTIONS DE CONTENU");
const contenuFin = patches.indexOf("14. TRUST BAR");
const sectionContenu =
  contenuDebut >= 0 && contenuFin > contenuDebut
    ? patches.slice(contenuDebut, contenuFin)
    : "";

if (!sectionContenu) {
  ko("section 13 bis (sections de contenu)", "introuvable dans style-patches.css");
} else {
  if (
    /@media\s*\(min-width:\s*1100px\)\s*\{[\s\S]*?\.features-grid\s*\{[\s\S]{0,160}?repeat\(\s*3\s*,/.test(
      sectionContenu
    )
  ) {
    ok("engagements : 3 colonnes a partir de 1100px");
  } else {
    ko("engagements : 3 colonnes a partir de 1100px", "regle absente");
  }

  if (
    /@media\s*\(min-width:\s*1100px\)\s*\{[\s\S]*?\.trust-badges\s*\{[\s\S]{0,160}?repeat\(\s*4\s*,/.test(
      sectionContenu
    )
  ) {
    ok("confiance : 4 colonnes a partir de 1100px");
  } else {
    ko("confiance : 4 colonnes a partir de 1100px", "regle absente");
  }

  if (
    /@media\s*\(min-width:\s*640px\)\s*\{[\s\S]*?\.about-grid\s*\{[\s\S]{0,160}?repeat\(\s*2\s*,/.test(
      sectionContenu
    )
  ) {
    ok("qui sommes-nous : 2 colonnes a partir de 640px");
  } else {
    ko("qui sommes-nous : 2 colonnes a partir de 640px", "regle absente");
  }

  if (
    /@media\s*\(max-width:\s*639px\)\s*\{[\s\S]*?\.features-grid\s*\{[\s\S]{0,160}?repeat\(\s*2\s*,/.test(
      sectionContenu
    )
  ) {
    ok("mobile : engagements sur 2 colonnes");
  } else {
    ko("mobile : engagements sur 2 colonnes", "regle absente");
  }
}

/* --------------------------------------------- cache du CSS legal */
/* legal.css n est plus servi directement : il doit etre reference via sa
   copie hachee (/css/legal.<8 hex>.css), sinon le cache immutable 1 an
   figerait les corrections pour les visiteurs deja venus. */
const pagesHtml = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith(".html"))
  .sort();
let pagesLegal = 0;
const legalKo = [];

for (const fichier of pagesHtml) {
  const html = fs.readFileSync(path.join(ROOT, fichier), "utf8");
  if (html.indexOf("/css/legal") === -1) continue;
  pagesLegal++;
  const hashed = /\/css\/legal\.[0-9a-f]{8}\.css/.test(html);
  const plain = html.indexOf("/css/legal.css") !== -1;
  if (!hashed || plain) legalKo.push(fichier);
}

if (legalKo.length) {
  ko("CSS legal hache sur toutes les pages", legalKo.join(", "));
} else {
  ok("CSS legal hache sur toutes les pages", pagesLegal + " page(s)");
}

console.log("\n" + verifications + " verification(s), " + echecs + " echec(s)");
process.exit(echecs === 0 ? 0 : 1);
