/* ============================================================
   js/promo-duo.js
   METTRE VENTES FLASH ET KOULCHI COTE A COTE (K6b)
   ============================================================
   AliExpress affiche ses bandeaux commerciaux cote a cote sur grand
   ecran. On reproduit ce principe, mais avec DEUX garde-fous que le
   50/50 litteral casse :

     1. Une seule section active -> elle prend TOUTE la largeur.
        Un 50/50 avec une colonne vide donne l impression d un site
        casse (et une vente flash est souvent seule).
     2. Sous 1100px, retour a l empilement vertical : sur mobile deux
        demi-carrousels sont illisibles.

   Ce module ne connait ni flash-sales.js ni koulchi-page.js : il
   observe l attribut `hidden` des deux sections et pose une classe
   sur le conteneur. Aucun couplage, aucun ordre de chargement impose.

   ALERTE 1 : aucun commentaire de ligne dans ce fichier.
   ============================================================ */

const SECTIONS = ["flashSection", "koulchiSection"];

/**
 * Compte les sections visibles et met le conteneur dans le bon mode :
 *   is-empty  aucune -> rien du tout
 *   is-single une seule -> pleine largeur
 *   is-pair   les deux -> deux colonnes (desktop uniquement, via CSS)
 */
function syncDuo() {
  const duo = document.getElementById("promoDuo");
  if (!duo) return;

  let visible = 0;
  for (const id of SECTIONS) {
    const section = document.getElementById(id);
    if (section && !section.hidden) visible += 1;
  }

  duo.classList.toggle("is-empty", visible === 0);
  duo.classList.toggle("is-single", visible === 1);
  duo.classList.toggle("is-pair", visible === 2);
}

function initPromoDuo() {
  if (!document.getElementById("promoDuo")) return;

  syncDuo();

  /* Les deux sections sont remplies puis affichees de facon asynchrone
     (produits Firestore). On observe donc l attribut `hidden`. */
  const observer = new MutationObserver(syncDuo);
  for (const id of SECTIONS) {
    const section = document.getElementById(id);
    if (section) {
      observer.observe(section, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPromoDuo);
} else {
  initPromoDuo();
}

console.log("[promo] duo ventes flash + koulchi actif (K6b)");