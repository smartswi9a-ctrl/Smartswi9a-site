/* ============================================================
   js/koulchi-page.js
   KOULCHI DIALK - VITRINE COMPACTE DE L ACCUEIL (K7)
   ============================================================
   Remplace l ancien simulateur de l accueil par une CARTE VITRINE
   placee a gauche de la section Ventes Flash (disposition 2 colonnes
   type AliExpress). La carte est toujours visible, meme si le
   catalogue groupe est vide : elle affiche alors un visuel d appel.

   PRINCIPES
     - Aucun texte en dur : tout passe par t() (FR / EN / AR).
     - Aucun prix invente : les miniatures viennent du catalogue.
     - Aucun cumul : les produits en vente flash sont exclus (koulchi.js).
     - Le titre reste un lien vers /koulchi.html (accessibilite + SEO).

   ALERTE 1 : aucun commentaire de ligne dans ce fichier.
   ============================================================ */

import {
  t,
  escapeHTML,
  getProductName,
  getProductImageUrl,
  getFallbackImage,
  getDiscountPercent,
} from "./utils.js";
import { getProducts, getProductsLoadedPromise } from "./store.js";
import { getKoulchiCatalog, KOULCHI_TIERS } from "./koulchi.js";

/**
 * Produits reellement affichables dans la vitrine.
 * @returns {Array}
 */
function eligibleProducts() {
  return getKoulchiCatalog(getProducts());
}

/**
 * Miniature d un produit eligible (3 maximum).
 * @param {object} product
 * @returns {string}
 */
function renderThumb(product) {
  const name = escapeHTML(getProductName(product));
  const img = getProductImageUrl(product);
  const fallback = getFallbackImage(name);
  const percent = getDiscountPercent(
    Number(product.price) || 0,
    Number(product.koulchiPrice) || 0
  );
  const url = `/produit?slug=${encodeURIComponent(product.slug || "")}`;

  return `<li class="koulchi-vitrine-thumb" role="listitem">
      <a href="${url}" aria-label="${name}">
        <img src="${img}" alt="${name}" width="72" height="72" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'">
        <span class="koulchi-vitrine-thumb-off">−${percent} %</span>
      </a>
    </li>`;
}

/**
 * Paliers compacts : 3 art. = −5 % · 6 art. = −10 % · 9 art. = −15 %.
 * @returns {string}
 */
function renderTiers() {
  return KOULCHI_TIERS.slice()
    .sort((a, b) => a.min - b.min)
    .map(
      (tier) =>
        `<li class="koulchi-vitrine-tier" role="listitem"><strong>${tier.min} ${escapeHTML(
          t("koulchiVitrineItemsShort")
        )}</strong><span>= −${tier.percent} %</span></li>`
    )
    .join("");
}

/**
 * Rend (ou rafraichit) la carte vitrine de l accueil.
 * La carte est TOUJOURS visible : catalogue vide = visuel d appel.
 */
export function renderKoulchiHome() {
  const section = document.getElementById("koulchiVitrine");
  const body = document.getElementById("koulchiVitrineBody");
  if (!section || !body) return;

  const products = eligibleProducts();
  const preview = products.slice(0, 3);

  const previewHtml = preview.length
    ? `<ul class="koulchi-vitrine-thumbs" role="list">${preview
        .map(renderThumb)
        .join("")}</ul>`
    : `<div class="koulchi-vitrine-empty" role="presentation">
        <span class="koulchi-vitrine-empty-icon" aria-hidden="true">🛍️</span>
        <span class="koulchi-vitrine-empty-text">${escapeHTML(
          t("koulchiVitrineEmpty")
        )}</span>
      </div>`;

  body.innerHTML = `<div class="koulchi-vitrine-card">
      <div class="koulchi-vitrine-head">
        <span class="koulchi-vitrine-badge">⚡ ${escapeHTML(
          t("koulchiVitrineBadge")
        )}</span>
        <a class="koulchi-home-title-link" href="/koulchi.html"><h2 class="section-title" id="koulchiHomeTitle">${escapeHTML(
          t("koulchiVitrineTitle")
        )}</h2></a>
        <p class="koulchi-vitrine-sub">${escapeHTML(t("koulchiVitrineSub"))}</p>
      </div>
      <ul class="koulchi-vitrine-tiers" role="list">${renderTiers()}</ul>
      <div class="koulchi-vitrine-preview">
        <span class="koulchi-vitrine-preview-label">${escapeHTML(
          t("koulchiVitrinePreview")
        )}</span>
        ${previewHtml}
      </div>
      <div class="koulchi-vitrine-foot">
        <span class="koulchi-vitrine-note">${escapeHTML(
          t("koulchiVitrineNonCumul")
        )}</span>
        <a class="koulchi-vitrine-cta" href="/koulchi.html">${escapeHTML(
          t("koulchiVitrineCta")
        )}</a>
      </div>
    </div>`;

  section.hidden = false;
  section.dataset.tierCount = String(KOULCHI_TIERS.length);
  section.dataset.previewCount = String(preview.length);
}

async function initKoulchiHome() {
  /* Premier rendu IMMEDIAT : la vitrine ne doit jamais apparaitre vide,
     meme si Firestore met plusieurs secondes a repondre. */
  renderKoulchiHome();
  document.addEventListener("lang-changed", renderKoulchiHome);

  try {
    const ready = getProductsLoadedPromise();
    if (ready) await ready;
  } catch (e) {
    /* catalogue indisponible : la carte garde le visuel d appel */
    return;
  }
  renderKoulchiHome();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initKoulchiHome);
} else {
  initKoulchiHome();
}

console.log("[koulchi] vitrine compacte de l accueil chargee (K7)");
