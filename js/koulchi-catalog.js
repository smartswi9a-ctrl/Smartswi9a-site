/* ============================================================
   js/koulchi-catalog.js
   PAGE DEDIEE AUX OFFRES GROUPEES (/koulchi)
   ============================================================
   Reprend le mecanisme des places de marche (AliExpress "Bundle
   deals") :

     - panier Koulchi collant a GAUCHE : paliers, articles, totaux ;
     - bandeau de suggestions a defilement horizontal (fleches
       gauche / droite, 4 visibles sur grand ecran) ;
     - categories puis tri ;
     - grille INFINIE : 12 offres de plus a chaque approche du bas
       de page, sans limite.

   REGLES
     - Aucune donnee inventee : tout vient du catalogue.
     - Un produit sans prix de groupe valide, sans stock, a variantes
       ou en vente flash n apparait jamais (getKoulchiCatalog).
     - L ajout passe par addToCart(..., { mode: "koulchi" }) : les
       bornes (3 max/produit, 10 max/panier) sont verifiees par le
       module de panier, jamais dupliquees ici.
     - Le rendu suit la langue (re-render sur lang-changed).
   ============================================================ */

import {
  t,
  escapeHTML,
  getProductName,
  getProductImageUrl,
  getFallbackImage,
  getDiscountPercent,
} from "./utils.js";
import { appReadyPromise, getProducts, getCart } from "./store.js";
import {
  getKoulchiCatalog,
  KOULCHI_MIN_ITEMS,
  KOULCHI_MAX_ITEMS,
  KOULCHI_MAX_PER_PRODUCT,
  KOULCHI_TIERS,
  getNextKoulchiTier,
  getKoulchiPercent,
} from "./koulchi.js";
import {
  addToCart,
  getCartZoneTotals,
  updateCartQuantity,
  removeFromCart,
} from "./cart.js";
import { showToast } from "./ui-core.js";
import { getCategoryById } from "./config.js?v=2";

/* Nombre d offres ajoutees a chaque declenchement du defilement infini. */
const PAGE_SIZE = 12;

const state = {
  catalog: [],
  filtered: [],
  visible: 0,
  category: "",
  sort: "discount",
  observer: null,
};

function devise() {
  return t("currency");
}

function soldLabel(n) {
  const v = Math.round(Number(n) || 0);
  if (v <= 0) return "";
  return t("soldCount").replace("{n}", v);
}

function productUrl(p) {
  return `/produit?slug=${encodeURIComponent(p.slug || p.id || "")}`;
}

function starsHtml(p) {
  const avg = Number(p.ratingAvg) || 0;
  const count = Math.round(Number(p.ratingCount) || 0);
  if (avg <= 0) return "";
  return `<span class="koulchi-tile-stars">★ ${avg.toFixed(1)}${
    count > 0 ? ` <i>(${count})</i>` : ""
  }</span>`;
}

function percentOf(p) {
  return getDiscountPercent(
    Number(p.price) || 0,
    Number(p.koulchiPrice) || 0
  );
}
/* --------------------------------------------- rendu d une carte */

function renderTile(p) {
  const id = escapeHTML(String(p.id ?? ""));
  const name = escapeHTML(getProductName(p));
  const img = getProductImageUrl(p);
  const fallback = getFallbackImage(name);
  const url = productUrl(p);
  const groupPrice = Number(p.koulchiPrice) || 0;
  const classicPrice = Number(p.price) || 0;
  const percent = percentOf(p);
  const sold = soldLabel(p.salesCount);

  return `<li class="koulchi-tile" data-id="${id}">
      <a class="koulchi-tile-media" href="${url}" tabindex="-1" aria-hidden="true">
        <img src="${img}" alt="${name}" width="300" height="300" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'">
        <span class="koulchi-tile-off">−${percent} %</span>
      </a>
      <div class="koulchi-tile-body">
        <a class="koulchi-tile-name" href="${url}">${name}</a>
        <div class="koulchi-tile-meta">${starsHtml(p)}${
          sold ? `<span class="koulchi-tile-sold">${escapeHTML(sold)}</span>` : ""
        }</div>
        <div class="koulchi-tile-prices">
          <strong>${groupPrice} ${devise()}</strong>
          <s>${classicPrice} ${devise()}</s>
        </div>
        <button type="button" class="koulchi-tile-add" data-add="${id}">
          <span>${t("koulchiPageAdd")}</span>
        </button>
      </div>
    </li>`;
}

/* Carte compacte du bandeau de suggestions (4 visibles). */
function renderSuggestCard(p) {
  const id = escapeHTML(String(p.id ?? ""));
  const name = escapeHTML(getProductName(p));
  const img = getProductImageUrl(p);
  const fallback = getFallbackImage(name);
  const url = productUrl(p);
  const groupPrice = Number(p.koulchiPrice) || 0;
  const classicPrice = Number(p.price) || 0;
  const percent = percentOf(p);

  return `<li class="koulchi-suggest-card">
      <a class="koulchi-suggest-media" href="${url}" tabindex="-1" aria-hidden="true">
        <img src="${img}" alt="${name}" width="240" height="240" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'">
        <span class="koulchi-tile-off">−${percent} %</span>
      </a>
      <a class="koulchi-suggest-name" href="${url}">${name}</a>
      <div class="koulchi-suggest-prices">
        <strong>${groupPrice} ${devise()}</strong>
        <s>${classicPrice} ${devise()}</s>
      </div>
      <button type="button" class="koulchi-tile-add" data-add="${id}">
        <span>${t("koulchiPageAdd")}</span>
      </button>
    </li>`;
}

/* --------------------------------------------- bandeau de suggestions */

function renderSuggestions() {
  const track = document.getElementById("koulchiSuggestTrack");
  if (!track) return;

  const top = state.catalog
    .slice()
    .sort((a, b) => percentOf(b) - percentOf(a))
    .slice(0, 12);

  track.innerHTML = top.map(renderSuggestCard).join("");
  track.scrollLeft = 0;

  const page = () => {
    const card = track.querySelector(".koulchi-suggest-card");
    return card ? Math.round(card.getBoundingClientRect().width + 12) : 200;
  };

  const prev = document.getElementById("koulchiSuggestPrev");
  const next = document.getElementById("koulchiSuggestNext");
  if (prev) {
    prev.onclick = () => track.scrollBy({ left: -page() * 4, behavior: "smooth" });
  }
  if (next) {
    next.onclick = () => track.scrollBy({ left: page() * 4, behavior: "smooth" });
  }
}
/* --------------------------------------------- categories, tri, grille */

function renderCategories() {
  const box = document.getElementById("koulchiCats");
  if (!box) return;

  const counts = new Map();
  for (const p of state.catalog) {
    const id = String(p.category || "");
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  const items = [
    `<button type="button" class="koulchi-cat${
      state.category === "" ? " is-active" : ""
    }" data-cat="">${t("koulchiPageAll")}</button>`,
  ];

  for (const [id, n] of counts) {
    const cat = getCategoryById(id);
    const label = cat ? t(cat.label) : id;
    items.push(
      `<button type="button" class="koulchi-cat${
        state.category === id ? " is-active" : ""
      }" data-cat="${escapeHTML(id)}">${escapeHTML(label)} <i>${n}</i></button>`
    );
  }

  box.innerHTML = items.join("");
  box.querySelectorAll("[data-cat]").forEach((btn) => {
    btn.onclick = () => {
      state.category = btn.dataset.cat || "";
      renderCategories();
      applyFilters();
    };
  });
}

function renderSort() {
  const sel = document.getElementById("koulchiSort");
  if (!sel) return;

  const options = [
    ["discount", t("koulchiSortDiscount")],
    ["priceAsc", t("koulchiSortPriceAsc")],
    ["priceDesc", t("koulchiSortPriceDesc")],
    ["sales", t("koulchiSortSales")],
  ];

  sel.innerHTML = options
    .map(([value, label]) => `<option value="${value}">${escapeHTML(label)}</option>`)
    .join("");
  sel.value = state.sort;
  sel.onchange = () => {
    state.sort = sel.value;
    applyFilters();
  };
}

function sortList(list) {
  const copy = list.slice();
  const price = (p) => Number(p.koulchiPrice) || 0;
  switch (state.sort) {
    case "priceAsc":
      return copy.sort((a, b) => price(a) - price(b));
    case "priceDesc":
      return copy.sort((a, b) => price(b) - price(a));
    case "sales":
      return copy.sort(
        (a, b) => (Number(b.salesCount) || 0) - (Number(a.salesCount) || 0)
      );
    default:
      return copy.sort((a, b) => percentOf(b) - percentOf(a));
  }
}

function applyFilters() {
  const base = state.category
    ? state.catalog.filter((p) => String(p.category || "") === state.category)
    : state.catalog;

  state.filtered = sortList(base);
  state.visible = Math.min(PAGE_SIZE, state.filtered.length);
  renderGrid(true);
}

function renderGrid(reset) {
  const grid = document.getElementById("koulchiGrid");
  const empty = document.getElementById("koulchiEmpty");
  if (!grid) return;

  if (reset) grid.innerHTML = "";

  const next = state.filtered.slice(grid.children.length, state.visible);
  if (next.length) grid.insertAdjacentHTML("beforeend", next.map(renderTile).join(""));

  if (empty) empty.hidden = state.filtered.length > 0;

  const count = document.getElementById("koulchiCount");
  if (count) {
    const total = state.filtered.length;
    count.textContent = total
      ? `${Math.min(state.visible, total)} / ${t("koulchiPageCount").replace("{n}", total)}`
      : "";
  }

  const sentinel = document.getElementById("koulchiSentinel");
  if (sentinel) {
    sentinel.style.display =
      state.visible < state.filtered.length ? "" : "none";
  }
}

function startInfiniteScroll() {
  const sentinel = document.getElementById("koulchiSentinel");
  if (!sentinel) return;

  if (state.observer) state.observer.disconnect();

  if (typeof IntersectionObserver !== "function") {
    return;
  }

  state.observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (state.visible >= state.filtered.length) return;
      state.visible = Math.min(state.visible + PAGE_SIZE, state.filtered.length);
      renderGrid(false);
    },
    { rootMargin: "500px 0px" }
  );

  state.observer.observe(sentinel);
}
/* --------------------------------------------- panier Koulchi (gauche) */

function renderHeroTiers() {
  const box = document.getElementById("koulchiHeroTiers");
  if (!box) return;

  box.innerHTML = KOULCHI_TIERS.slice()
    .sort((a, b) => a.min - b.min)
    .map((tier) => `<li><strong>${tier.min}+</strong><span>−${tier.percent} %</span></li>`)
    .join("");
}

function renderCart() {
  const lines = getCart().filter((line) => line.mode === "koulchi");
  const zone = getCartZoneTotals();
  const qty = Number(zone.koulchiQty) || 0;

  const countEl = document.getElementById("koulchiCartCount");
  if (countEl) countEl.textContent = `${qty}/${KOULCHI_MAX_ITEMS}`;

  const bar = document.getElementById("koulchiCartBar");
  if (bar) bar.style.width = Math.min(100, (qty / KOULCHI_MAX_ITEMS) * 100) + "%";

  const hint = document.getElementById("koulchiCartHint");
  if (hint) {
    if (qty === 0) {
      hint.textContent = t("koulchiCartEmpty");
    } else {
      const nextTier = getNextKoulchiTier(qty);
      hint.textContent = nextTier
        ? t("koulchiCartNextTier")
            .replace("{n}", nextTier.missing)
            .replace("{p}", nextTier.percent)
        : t("koulchiCartMaxTier").replace("{p}", getKoulchiPercent(qty));
    }
  }

  const list = document.getElementById("koulchiCartLines");
  const products = getProducts();
  if (list) {
    if (lines.length === 0) {
      list.innerHTML = `<li class="koulchi-cart-vide">${t("koulchiCartEmptyLines")}</li>`;
    } else {
      list.innerHTML = lines
        .map((line) => {
          const p = products.find((x) => String(x.id) === String(line.productId));
          if (!p) return "";
          const name = escapeHTML(getProductName(p));
          const img = getProductImageUrl(p);
          const unit = Number(p.koulchiPrice) || 0;
          const id = escapeHTML(String(line.id));
          return `<li class="koulchi-cart-line">
              <img src="${img}" alt="" width="44" height="44" loading="lazy">
              <div class="koulchi-cart-line-txt">
                <span>${name}</span>
                <small>${unit} ${devise()}</small>
              </div>
              <div class="koulchi-cart-qty">
                <button type="button" data-dec="${id}" aria-label="−">−</button>
                <b>${line.quantity}</b>
                <button type="button" data-inc="${id}" aria-label="+">+</button>
              </div>
              <button type="button" class="koulchi-cart-x" data-remove="${id}" aria-label="✕">✕</button>
            </li>`;
        })
        .join("");
    }
  }

  const totals = document.getElementById("koulchiCartTotals");
  if (totals) {
    const sub = Number(zone.koulchiSubtotal) || 0;
    const disc = Number(zone.koulchiDiscount) || 0;
    const pct = getKoulchiPercent(qty);
    totals.innerHTML =
      `<div class="koulchi-cart-row"><span>${t("koulchiCartSubtotal")}</span><span>${sub} ${devise()}</span></div>` +
      (disc > 0
        ? `<div class="koulchi-cart-row is-saving"><span>${t(
            "koulchiCartDiscount"
          ).replace("{p}", pct)}</span><span>−${disc} ${devise()}</span></div>`
        : "") +
      `<div class="koulchi-cart-row is-total"><span>${t(
        "koulchiCartTotal"
      )}</span><span>${Math.max(0, sub - disc)} ${devise()}</span></div>`;
  }

  const cta = document.getElementById("koulchiCartCta");
  if (cta) cta.classList.toggle("is-disabled", qty < KOULCHI_MIN_ITEMS);
}
/* --------------------------------------------- ajout au panier */

async function handleAdd(btn) {
  const id = btn.getAttribute("data-add");
  if (!id) return;

  await addToCart(id, null, { mode: "koulchi" });

  const inCart = getCart().some(
    (line) =>
      line.mode === "koulchi" && String(line.productId) === String(id)
  );

  renderCart();

  if (!inCart) return;

  /* Retour visuel sans desactiver le bouton : un client qui clique
     trois fois d affilee doit ajouter trois exemplaires (les bornes
     4/produit et 10/panier sont verifiees par addToCart). */
  const label = btn.querySelector("span");
  if (!label) return;

  if (!btn.dataset.libelle) btn.dataset.libelle = label.textContent;
  label.textContent = t("koulchiPageAdded");

  clearTimeout(Number(btn.dataset.minuterie || 0));
  btn.dataset.minuterie = String(
    setTimeout(() => {
      label.textContent = btn.dataset.libelle;
    }, 900)
  );
}

function handleQty(action, id) {
  const line = getCart().find((l) => String(l.id) === String(id));
  if (!line) return;

  if (action === "remove") {
    removeFromCart(id);
    return;
  }

  if (action === "inc") {
    const zone = getCartZoneTotals();
    if ((Number(zone.koulchiQty) || 0) >= KOULCHI_MAX_ITEMS) {
      showToast(t("koulchiMaxItems"));
      return;
    }
    if (line.quantity >= KOULCHI_MAX_PER_PRODUCT) {
      showToast(t("koulchiMaxPerProduct"));
      return;
    }
    updateCartQuantity(id, line.quantity + 1);
    return;
  }

  if (line.quantity <= 1) removeFromCart(id);
  else updateCartQuantity(id, line.quantity - 1);
}

/* --------------------------------------------- demarrage */

function renderAll() {
  renderHeroTiers();
  renderSuggestions();
  renderCategories();
  renderSort();
  applyFilters();
  renderCart();
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const add = event.target.closest("[data-add]");
    if (add) {
      event.preventDefault();
      handleAdd(add);
      return;
    }

    const inc = event.target.closest("[data-inc]");
    if (inc) return handleQty("inc", inc.getAttribute("data-inc"));

    const dec = event.target.closest("[data-dec]");
    if (dec) return handleQty("dec", dec.getAttribute("data-dec"));

    const rem = event.target.closest("[data-remove]");
    if (rem) return handleQty("remove", rem.getAttribute("data-remove"));
  });

  document.addEventListener("cart-updated", renderCart);
  document.addEventListener("lang-changed", renderAll);
}

async function init() {
  try {
    await appReadyPromise;
  } catch (e) {
    /* le catalogue reste vide : la page affiche son etat vide */
  }

  state.catalog = getKoulchiCatalog(getProducts());
  renderAll();
  startInfiniteScroll();
  bindEvents();

  console.log(
    `[koulchi] ${state.catalog.length} offre(s) groupee(s) chargee(s)`
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}