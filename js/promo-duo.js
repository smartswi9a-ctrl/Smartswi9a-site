/* ============================================================
   js/promo-duo.js
   VITRINE KOULCHI DIALK + VENTES FLASH : DUO JUMEAU (K8)
   ============================================================
   AliExpress affiche ses deux blocs commerciaux cote a cote sur TOUS
   les ecrans. La grille CSS est desormais TOUJOURS en 2 colonnes
   (voir css/shop-modern.css) : ce module ne fait plus que :

     1. garantir la classe `is-pair` (aucun etat « pleine largeur ») ;
     2. retirer les anciennes classes `is-single` / `is-empty` ;
     3. relier le CTA « Voir les ventes flash » au filtre rapide ⚡ de
        la grille produits (aucun texte ni style en dur ici).

   L ordre est celui du DOM : vitrine d abord (gauche en FR/EN, droite
   en AR grace a dir="rtl" qui inverse la grille). Aucun `order` n est
   donc necessaire.

   ALERTE 1 : aucun commentaire de ligne dans ce fichier.
   ============================================================ */

const DUO_ID = "promoDuo";
const VITRINE_ID = "koulchiVitrine";
const FLASH_ID = "flashSection";

/**
 * Force le duo en mode jumeau (2 colonnes, meme si une carte est vide).
 * Garde-fou cache : un ancien js/flash-sales.js encore servi par un
 * Service Worker peut poser `hidden` sur la carte Ventes Flash ; on le
 * retire pour conserver les deux cartes cote a cote avec un etat vide.
 */
function syncDuo() {
  const duo = document.getElementById(DUO_ID);
  if (!duo) return;

  const vitrine = document.getElementById(VITRINE_ID);
  const flash = document.getElementById(FLASH_ID);
  if (flash && flash.hidden) flash.hidden = false;
  const vitrineVisible = Boolean(vitrine && !vitrine.hidden);
  const flashVisible = Boolean(flash && !flash.hidden);

  duo.classList.remove("is-single");
  duo.classList.toggle("is-pair", vitrineVisible || flashVisible);
  duo.classList.toggle("is-empty", !vitrineVisible && !flashVisible);
}

/**
 * CTA de la carte Ventes Flash : applique le filtre rapide ⚡ de la
 * grille produits puis fait defiler jusqu a la section. Le lien garde
 * son href="#produits" en repli sans JavaScript.
 */
function onDuoClick(event) {
  const trigger = event.target.closest("[data-duo-quick]");
  if (!trigger) return;

  const quick = trigger.getAttribute("data-duo-quick");
  if (!quick) return;

  const pill = document.querySelector(`[data-shop-quick="${quick}"]`);
  if (!pill) return;

  event.preventDefault();
  pill.click();

  const target = document.getElementById("produits");
  if (target && typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function initPromoDuo() {
  const duo = document.getElementById(DUO_ID);
  if (!duo) return;

  syncDuo();
  duo.addEventListener("click", onDuoClick);

  /* La vitrine et la vente flash sont rendues de facon asynchrone :
     on observe l attribut `hidden` pour garder `is-pair` a jour. */
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

console.log("[promo] duo jumeau Koulchi + ventes flash actif (K8)");
