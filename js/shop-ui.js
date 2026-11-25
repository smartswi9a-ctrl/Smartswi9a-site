/* ============================================================
   js/shop-ui.js — interactions vitrine modernes
   ------------------------------------------------------------
   Filtres rapides, compteurs, scroll reveal, simulateur Koulchi
   dialk et aperçu blog. Aucune modification du tri produits ni
   des modules passifs (product_views / rotation 10:1).
   ============================================================ */

import { shopT, applyShopTranslations } from "./shop-i18n.js";
import { getFilters, setFilters, setPagination, getBlogPosts } from "./store.js";
import { renderProducts, renderCategoryFilters } from "./products.js";
import { KOULCHI_TIERS } from "./koulchi.js";
import { getLang } from "./utils.js";

const QUICK_FILTERS = [
  { id: "all", key: "quickAll", icon: "✦" },
  { id: "new", key: "quickNew", icon: "✨" },
  { id: "promos", key: "quickPromos", icon: "%" },
  { id: "flash", key: "quickFlash", icon: "⚡" },
  { id: "smart", key: "quickSmart", icon: "✅" },
  { id: "vendors", key: "quickVendors", icon: "🏪" },
  { id: "stock", key: "quickStock", icon: "📦" },
];

let _shopUiReady = false;
let _homeBlogPosts = [];

function formatShopMoney(value) {
  const lang = getLang();
  const locale = lang === "ar" ? "ar-MA" : lang === "en" ? "en-GB" : "fr-FR";
  const number = Math.max(0, Number(value) || 0);
  try {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(number)} MAD`;
  } catch (e) {
    return `${Math.round(number)} MAD`;
  }
}

/* ============================================================
   FILTRES RAPIDES
   ============================================================ */
export function renderShopQuickFilters() {
  const box = document.getElementById("shopQuickFilters");
  if (!box) return;
  const filters = getFilters();
  const active = filters.quick || "all";
  box.setAttribute("aria-label", shopT("quickAria"));
  box.innerHTML = QUICK_FILTERS.map((item) => {
    const isActive = active === item.id;
    return `<button type="button" class="shop-quick-pill${isActive ? " is-active" : ""}" data-shop-quick="${item.id}" aria-pressed="${isActive ? "true" : "false"}"><span aria-hidden="true">${item.icon}</span>${escapeShop(shopT(item.key))}</button>`;
  }).join("");
}

function escapeShop(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bindQuickFilters() {
  const box = document.getElementById("shopQuickFilters");
  if (!box || box.dataset.bound === "1") return;
  box.dataset.bound = "1";
  box.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-shop-quick]");
    if (!btn) return;
    const quick = btn.dataset.shopQuick || "all";
    setFilters({
      quick,
      category: "all",
      promos: quick === "promos",
      inStock: quick === "stock",
    });
    setPagination({ currentPage: 1 });
    renderShopQuickFilters();
    renderCategoryFilters();
    renderProducts();
  });

  /* Les filtres historiques (catégories / reset) remettent la pill Tous
     AVANT le handler métier : sinon la grille resterait filtrée par l'ancienne pill. */
  document.addEventListener(
    "click",
    (event) => {
      const category = event.target.closest(".category-scroll-item");
      const reset = event.target.closest("#filterResetBtn");
      if (!category && !reset) return;
      setFilters({ quick: "all", promos: false, inStock: false });
      window.setTimeout(renderShopQuickFilters, 0);
    },
    true
  );
}

/* ============================================================
   COMPTEURS ANIMÉS (600 ms)
   ============================================================ */
function animateShopCounter(el) {
  if (!el || el.dataset.shopCounted === "1") return;
  el.dataset.shopCounted = "1";
  const target = Number(el.dataset.shopCount) || 0;
  const suffix = el.dataset.shopSuffix || "";
  const duration = 600;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = `${Math.round(target * eased)}${suffix}`;
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = `${target}${suffix}`;
  };
  requestAnimationFrame(step);
}

function initShopCounters() {
  const nodes = [...document.querySelectorAll("[data-shop-count]")];
  if (!nodes.length) return;
  if (!("IntersectionObserver" in window)) {
    nodes.forEach(animateShopCounter);
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        animateShopCounter(entry.target);
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.35 }
  );
  nodes.forEach((node) => observer.observe(node));
}

/* ============================================================
   SCROLL REVEAL (IntersectionObserver, sans librairie)
   ============================================================ */
function initShopReveal() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;
  const targets = [...document.querySelectorAll(".section, .trust-bar, .shop-stats-strip")]
    .filter((el) => !el.closest(".hero-section") && !el.classList.contains("shop-reveal"));
  if (!targets.length) return;
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.08, rootMargin: "0px 0px -32px 0px" }
  );
  targets.forEach((el) => {
    el.classList.add("shop-reveal");
    observer.observe(el);
  });

  /* Filet de sécurité : si l'observateur ne se déclenche pas (scroll
     programmatique, navigateur exotique), le contenu reste accessible. */
  window.setTimeout(() => {
    targets.forEach((el) => el.classList.add("is-visible"));
  }, 2600);
}

/* ============================================================
   SIMULATEUR KOULCHI DIALK
   ============================================================ */
function sortedKoulchiTiers() {
  return KOULCHI_TIERS.slice().sort((a, b) => a.min - b.min);
}

function koulchiPercentFor(qty) {
  let percent = 0;
  sortedKoulchiTiers().forEach((tier) => {
    if (qty >= tier.min) percent = tier.percent;
  });
  return percent;
}

function updateKoulchiSimulator(container) {
  const qty = Math.max(0, Math.min(10, Number(container.dataset.simQty) || 0));
  const avg = Math.max(49, Math.min(999, Number(container.dataset.simAvg) || 199));
  container.dataset.simQty = String(qty);
  container.dataset.simAvg = String(avg);

  const percent = koulchiPercentFor(qty);
  const subtotal = qty * avg;
  const savings = Math.round((subtotal * percent) / 100);
  const total = Math.max(0, subtotal - savings);

  const countEl = container.querySelector("[data-sim-count]");
  if (countEl) countEl.textContent = String(qty);
  const avgEl = container.querySelector("[data-sim-avg]");
  if (avgEl && Number(avgEl.value) !== avg) avgEl.value = String(avg);
  const avgOut = container.querySelector("[data-sim-avg-out]");
  if (avgOut) avgOut.textContent = formatShopMoney(avg);

  const bar = container.querySelector("[data-sim-bar]");
  if (bar) bar.style.width = `${Math.min(100, (qty / 9) * 100)}%`;
  const progress = container.querySelector("[data-sim-progress]");
  if (progress) progress.setAttribute("aria-valuenow", String(Math.min(100, Math.round((qty / 9) * 100))));

  container.querySelectorAll("[data-sim-qty]").forEach((step) => {
    const min = Number(step.dataset.simQty) || 0;
    step.classList.toggle("is-reached", qty >= min);
    step.classList.toggle("is-active", qty === min);
  });

  const next = sortedKoulchiTiers().find((tier) => qty < tier.min);
  const status = container.querySelector("[data-sim-next]");
  if (status) {
    status.textContent = next
      ? shopT("koulchiNextTier", { n: next.min - qty, p: next.percent })
      : shopT("koulchiMaxTier", { p: percent || 15 });
    status.classList.toggle("is-max", !next);
  }

  const set = (selector, value) => {
    const el = container.querySelector(selector);
    if (el) el.textContent = formatShopMoney(value);
  };
  set("[data-sim-subtotal]", subtotal);
  set("[data-sim-savings]", savings);
  set("[data-sim-total]", total);
  const badge = container.querySelector("[data-sim-percent]");
  if (badge) badge.textContent = `−${percent} %`;
}


function mountKoulchiSimulator(container) {
  if (!container) return;
  const qty = Math.max(0, Math.min(10, Number(container.dataset.simQty) || 0));
  const avg = Math.max(49, Math.min(999, Number(container.dataset.simAvg) || 199));
  const steps = sortedKoulchiTiers()
    .map(
      (tier, index) => `<button type="button" class="koulchi-sim-step" data-sim-qty="${tier.min}" aria-label="${escapeShop(shopT("koulchiTier" + (index + 1)))} ${tier.percent}%">
        <span class="koulchi-sim-step-min">${tier.min}</span>
        <span class="koulchi-sim-step-arrow" aria-hidden="true">→</span>
        <strong>−${tier.percent} %</strong>
      </button>`
    )
    .join("");

  const markers = sortedKoulchiTiers()
    .map((tier) => `<li>−${tier.percent} %</li>`)
    .join("");

  container.innerHTML = `<div class="koulchi-sim koulchi-sim--compact">
      <div class="koulchi-sim-row koulchi-sim-row--head">
        <h2 class="koulchi-sim-short" id="koulchiExperienceTitle" data-shop-i18n="koulchiSimShortTitle"></h2>
        <div class="koulchi-sim-steps" role="group" aria-label="${escapeShop(shopT("koulchiSimShortTitle"))}">${steps}</div>
        <span class="koulchi-sim-flag" data-shop-i18n="koulchiSimNonCumul"></span>
      </div>
      <div class="koulchi-sim-row koulchi-sim-row--bar">
        <div class="koulchi-sim-progress" data-sim-progress role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="${escapeShop(shopT("koulchiSimShortTitle"))}">
          <span data-sim-bar></span>
        </div>
        <ol class="koulchi-sim-markers" role="list">${markers}</ol>
      </div>
      <div class="koulchi-sim-row koulchi-sim-row--summary">
        <span class="koulchi-sim-sum"><strong data-sim-count>${qty}</strong> <span data-shop-i18n="koulchiItems"></span></span>
        <span class="koulchi-sim-sum koulchi-sim-sum--saving"><span data-shop-i18n="koulchiSavings"></span> <strong data-sim-savings></strong><em data-sim-percent></em></span>
        <span class="koulchi-sim-sum koulchi-sim-sum--total"><span data-shop-i18n="koulchiTotal"></span> <strong data-sim-total></strong></span>
        <span class="koulchi-sim-next" data-sim-next></span>
        <span class="koulchi-sim-stepper">
          <button type="button" class="koulchi-sim-round" data-sim-dec aria-label="${escapeShop(shopT("koulchiSimMinus"))}">−</button>
          <button type="button" class="koulchi-sim-round" data-sim-inc aria-label="${escapeShop(shopT("koulchiSimPlus"))}">+</button>
        </span>
      </div>
    </div>`;

  container.dataset.simAvg = String(avg);
  applyShopTranslations(container);
  updateKoulchiSimulator(container);

  container.querySelector("[data-sim-inc]")?.addEventListener("click", () => {
    container.dataset.simQty = String(Math.min(10, (Number(container.dataset.simQty) || 0) + 1));
    updateKoulchiSimulator(container);
  });
  container.querySelector("[data-sim-dec]")?.addEventListener("click", () => {
    container.dataset.simQty = String(Math.max(0, (Number(container.dataset.simQty) || 0) - 1));
    updateKoulchiSimulator(container);
  });
  container.querySelectorAll("[data-sim-qty]").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.dataset.simQty = btn.dataset.simQty;
      updateKoulchiSimulator(container);
    });
  });
}

function initKoulchiSimulators() {
  document.querySelectorAll("[data-koulchi-simulator]").forEach(mountKoulchiSimulator);
}

/* ============================================================
   APERÇU BLOG SUR L'ACCUEIL
   ============================================================ */
function renderHomeBlogPreview() {
  const grid = document.getElementById("homeBlogGrid");
  if (!grid) return;
  if (!_homeBlogPosts.length) {
    grid.innerHTML = `<div class="shop-blog-empty"><span aria-hidden="true">📝</span><p>${escapeShop(shopT("blogPreviewEmpty"))}</p></div>`;
    return;
  }
  grid.innerHTML = _homeBlogPosts
    .slice(0, 3)
    .map((post) => {
      const title = escapeShop(post.title || "Smartswika");
      const excerpt = escapeShop(String(post.excerpt || post.content || "").slice(0, 130));
      const image = post.image && /^(https?:)?\/\//i.test(post.image) ? post.image : "";
      const category = escapeShop(post.category || "general");
      const read = Math.max(1, Math.ceil(String(post.content || "").length / 900));
      return `<article class="blog-card shop-blog-card" data-id="${escapeShop(post.id || "")}" tabindex="0">
        <div class="blog-img shop-blog-img">${image ? `<img src="${escapeShop(image)}" alt="${title}" loading="lazy" width="400" height="250">` : `<span aria-hidden="true">📝</span>`}</div>
        <div class="blog-body">
          <span class="blog-category-tag">${category}</span>
          <div class="blog-date">${escapeShop(shopT("blogReadTime", { min: read }))}</div>
          <h3 class="blog-title">${title}</h3>
          <p class="blog-excerpt">${excerpt}</p>
          <span class="blog-read-more">${escapeShop(shopT("blogReadArticle"))} →</span>
        </div>
      </article>`;
    })
    .join("");
  grid.querySelectorAll(".blog-card").forEach((card) => {
    const go = () => {
      const id = card.dataset.id;
      window.location.href = id ? `/blog?article=${encodeURIComponent(id)}` : "/blog";
    };
    card.addEventListener("click", go);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        go();
      }
    });
  });
}

async function initHomeBlogPreview() {
  const grid = document.getElementById("homeBlogGrid");
  if (!grid) return;
  try {
    _homeBlogPosts = getBlogPosts() || [];
    if (!_homeBlogPosts.length) {
      const mod = await import("./blog.js");
      _homeBlogPosts = await mod.loadBlogPosts();
    }
  } catch (e) {
    _homeBlogPosts = [];
  }
  renderHomeBlogPreview();
}

/* ============================================================
   INITIALISATION + CHANGEMENT DE LANGUE
   ============================================================ */
function refreshShopUiForLang() {
  applyShopTranslations(document);
  renderShopQuickFilters();
  initKoulchiSimulators();
  if (_homeBlogPosts.length) renderHomeBlogPreview();
  try {
    renderCategoryFilters();
    renderProducts();
  } catch (e) {
    /* garde : la grille peut ne pas exister sur cette page */
  }
}

export function initShopUi() {
  if (_shopUiReady) return;
  _shopUiReady = true;
  applyShopTranslations(document);
  renderShopQuickFilters();
  bindQuickFilters();
  initShopCounters();
  initShopReveal();
  initKoulchiSimulators();
  initHomeBlogPreview();
  document.addEventListener("lang-changed", refreshShopUiForLang);
  window.__shopUi = {
    refresh: refreshShopUiForLang,
    quickFilters: renderShopQuickFilters,
    simulator: initKoulchiSimulators,
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initShopUi);
} else {
  initShopUi();
}
