/* ============================================================
   js/koulchi-page.js
   KOULCHI DIALK - FACADE COMMERCIALE (K6)
   ============================================================
   Section dediee sur l accueil : regle des paliers, filtres par
   categorie, cartes produit avec prix de groupe.

   PRINCIPES
     - La section reste `hidden` si aucun produit n a de prix de
       groupe valide : jamais de bloc vide, jamais de promesse vaine.
     - Les produits a variantes sont exclus (prix de groupe = prix
       produit), comme partout ailleurs.
     - Aucun prix n est invente : tout vient du catalogue.
     - Le rendu suit la langue courante (re-render sur lang-changed).

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
import { getCategoryById } from "./config.js";
import { getKoulchiCatalog, KOULCHI_TIERS } from "./koulchi.js";

let activeCategory = "";

/**
 * Produits reellement affichables dans la facade.
 * @returns {Array}
 */
function eligibleProducts() {
  return getKoulchiCatalog(getProducts());
}

/**
 * Carte produit de la facade.
 * @param {object} product
 * @returns {string}
 */
function renderCard(product) {
  const groupPrice = Number(product.koulchiPrice) || 0;
  const classicPrice = Number(product.price) || 0;
  const percent = getDiscountPercent(classicPrice, groupPrice);
  const name = escapeHTML(getProductName(product));
  const img = getProductImageUrl(product);
  const fallback = getFallbackImage(name);
  const url = `/produit?slug=${encodeURIComponent(product.slug || "")}`;
  const safeId = escapeHTML(String(product.id ?? ""));

  /* Preuve sociale facon marketplace : etoiles et nombre de ventes.
     Rien n est affiche si la donnee manque (pas de « 0 vendu »). */
  const sold = Math.round(Number(product.salesCount) || 0);
  const rating = Number(product.ratingAvg) || 0;
  const reviews = Math.round(Number(product.ratingCount) || 0);
  const metaHtml =
    sold > 0 || rating > 0
      ? `<span class="koulchi-card-meta">${
          rating > 0
            ? `<span class="koulchi-card-stars">★ ${rating.toFixed(1)}${
                reviews > 0 ? ` <i>(${reviews})</i>` : ""
              }</span>`
            : ""
        }${
          sold > 0
            ? `<span class="koulchi-card-sold">${escapeHTML(
                t("soldCount").replace("{n}", sold)
              )}</span>`
            : ""
        }</span>`
      : "";

  return `<li class="koulchi-card" role="listitem" data-product-id="${safeId}">
      <a class="koulchi-card-link" href="${url}">
        <span class="koulchi-card-badge">−${percent} %</span>
        <img class="koulchi-card-img" src="${img}" alt="${name}" width="160" height="160" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'">
        <span class="koulchi-card-name">${name}</span>
        ${metaHtml}
        <span class="koulchi-card-prices">
          <strong>${groupPrice} ${t("currency")}</strong>
          <s>${classicPrice} ${t("currency")}</s>
        </span>
        <span class="koulchi-card-cta">${t("koulchiCardCta")}</span>
      </a>
    </li>`;
}

/**
 * Filtres par categorie (affiches seulement s il y en a plusieurs).
 * @param {Array} products
 * @returns {string}
 */
function renderChips(products) {
  const categories = [];
  for (const product of products) {
    const id = String(product.category || "");
    if (!id || categories.includes(id)) continue;
    categories.push(id);
  }
  if (categories.length < 2) return "";

  const chips = [
    `<button type="button" class="koulchi-chip${
      activeCategory ? "" : " is-active"
    }" data-koulchi-category="">${t("koulchiHomeAll")}</button>`,
  ];

  for (const id of categories) {
    const category = getCategoryById(id);
    const label = category
      ? `${category.emoji} ${t(category.label)}`
      : escapeHTML(id);
    chips.push(
      `<button type="button" class="koulchi-chip${
        activeCategory === id ? " is-active" : ""
      }" data-koulchi-category="${escapeHTML(id)}">${label}</button>`
    );
  }

  return `<div class="koulchi-chips" role="group">${chips.join("")}</div>`;
}

/**
 * Rend (ou masque) la facade commerciale.
 */
export function renderKoulchiHome() {
  const section = document.getElementById("koulchiSection");
  if (!section) return;

  const all = eligibleProducts();
  if (all.length === 0) {
    section.hidden = true;
    section.innerHTML = "";
    return;
  }

  if (
    activeCategory &&
    !all.some((product) => String(product.category) === activeCategory)
  ) {
    activeCategory = "";
  }
  const visible = activeCategory
    ? all.filter((product) => String(product.category) === activeCategory)
    : all;

  const rules = KOULCHI_TIERS.slice()
    .sort((a, b) => a.min - b.min)
    .map(
      (tier) =>
        `<li><span>${tier.min}+</span><strong>−${tier.percent} %</strong></li>`
    )
    .join("");

  section.innerHTML = `<div class="koulchi-home-inner" id="koulchi">
      <div class="koulchi-home-head">
        <span class="koulchi-home-tag">${t("koulchiHomeTag")}</span>
        <h2 class="section-title" id="koulchiHomeTitle">${t("koulchiHomeTitle")}</h2>
        <p class="section-sub">${t("koulchiHomeSubtitle")}</p>
      </div>
      <ul class="koulchi-home-rules">${rules}</ul>
      ${renderChips(all)}
      <ul class="koulchi-home-track" id="koulchiHomeTrack" role="list">${visible
        .map(renderCard)
        .join("")}</ul>
      <div class="koulchi-home-foot">
        <span class="koulchi-home-rule-text">${t("koulchiHomeRules")}</span>
        <span class="koulchi-home-actions">
          <a class="btn-secondary" href="/panier">${t("koulchiHomeCta")}</a>
          <a class="btn-secondary koulchi-home-seeall" href="/koulchi.html">${t(
            "koulchiHomeSeeAll"
          )}</a>
        </span>
      </div>
    </div>`;

  section.hidden = false;

  section.querySelectorAll("[data-koulchi-category]").forEach((button) => {
    button.addEventListener("click", () => {
      activeCategory = button.dataset.koulchiCategory || "";
      renderKoulchiHome();
    });
  });
}

async function initKoulchiHome() {
  try {
    const ready = getProductsLoadedPromise();
    if (ready) await ready;
  } catch (e) {
    /* catalogue indisponible : la section reste masquee */
  }
  renderKoulchiHome();
  document.addEventListener("lang-changed", renderKoulchiHome);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initKoulchiHome);
} else {
  initKoulchiHome();
}

console.log("[koulchi] facade commerciale chargee (K6)");