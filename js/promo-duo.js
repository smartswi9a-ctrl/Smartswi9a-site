/* ============================================================
   js/promo-duo.js
   VITRINE KOULCHI DIALK + VENTES FLASH COTE A COTE (K7)
   ============================================================
   AliExpress affiche ses bandeaux commerciaux cote a cote sur grand
   ecran. On reproduit ce principe avec trois garde-fous :

     1. La carte vitrine Koulchi est TOUJOURS affichee : elle ne
        depend pas du catalogue (visuel d appel si vide).
     2. Sans vente flash active, la vitrine prend TOUTE la largeur
        (un 50/50 avec une colonne vide donnerait l impression d un
        site casse).
     3. Sous 1024 px, empilement vertical : deux demi-blocs sont
        illisibles sur tablette et mobile.

   L ordre est celui du DOM : vitrine d abord (gauche en FR/EN,
   droite en AR grace a dir="rtl" qui inverse la grille). Aucun
   `order` explicite n est donc necessaire.

   ALERTE 1 : aucun commentaire de ligne dans ce fichier.
   ============================================================ */

const VITRINE_ID = "koulchiVitrine";
const FLASH_ID = "flashSection";

/**
 * Met le conteneur dans le bon mode :
 *   is-empty  aucune section -> rien du tout
 *   is-single une seule       -> pleine largeur
 *   is-pair   les deux        -> deux colonnes (desktop uniquement)
 */
function syncDuo() {
  const duo = document.getElementById("promoDuo");
  if (!duo) return;

  const vitrine = document.getElementById(VITRINE_ID);
  const flash = document.getElementById(FLASH_ID);
  const vitrineVisible = Boolean(vitrine && !vitrine.hidden);
  const flashVisible = Boolean(flash && !flash.hidden);
  const visible = (vitrineVisible ? 1 : 0) + (flashVisible ? 1 : 0);

  duo.classList.toggle("is-empty", visible === 0);
  duo.classList.toggle("is-single", visible === 1);
  duo.classList.toggle("is-pair", visible === 2);
}

function initPromoDuo() {
  if (!document.getElementById("promoDuo")) return;

  syncDuo();

  /* La vente flash est remplie puis affichee de facon asynchrone
     (produits Firestore). On observe donc l attribut `hidden`. */
  const observer = new MutationObserver(syncDuo);
  for (const id of [VITRINE_ID, FLASH_ID]) {
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

console.log("[promo] duo vitrine Koulchi + ventes flash actif (K7)");
