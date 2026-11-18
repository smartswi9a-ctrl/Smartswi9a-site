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

console.log("\n" + verifications + " verification(s), " + echecs + " echec(s)");
process.exit(echecs === 0 ? 0 : 1);
