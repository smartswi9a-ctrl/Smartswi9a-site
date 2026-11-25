/* ============================================================
   js/secondary-ui.js — micro-interactions des pages secondaires
   ------------------------------------------------------------
   Scroll reveal, apparition des lignes Villes, pop des compteurs.
   Aucune dépendance, aucun impact sur les données ni le JSON-LD.
   Respecte prefers-reduced-motion.
   ============================================================ */
"use strict";

const REVEAL_SELECTOR = [
  ".villes-seo",
  ".ville-stat-card",
  ".villes-table-wrapper",
  ".product-reassurance",
  ".koulchi-offer",
  ".product-vendor-block",
  ".product-details-secondary",
  ".product-features-container",
  "#productReviewsRoot",
  "#relatedProductsRoot",
].join(",");

let _io = null;
let _scanTimer = null;
let _ready = false;

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function revealNow(el) {
  el.classList.add("is-visible");
}

function scan(root = document) {
  const targets = root.querySelectorAll(REVEAL_SELECTOR);
  targets.forEach((el) => {
    if (el.dataset.smReveal === "1") return;
    el.dataset.smReveal = "1";
    el.classList.add("sm-reveal");
    if (_io) _io.observe(el);
    else revealNow(el);
  });
}

function animateCount(el) {
  if (!el || reducedMotion() || typeof el.animate !== "function") return;
  try {
    el.animate(
      [
        { transform: "scale(1)", color: "inherit" },
        { transform: "scale(1.08)", color: "#8A6226" },
        { transform: "scale(1)", color: "inherit" },
      ],
      { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" }
    );
  } catch (e) { /* ignore */ }
}

function watchCityRows() {
  const tbody = document.getElementById("villesTbody");
  if (!tbody || tbody.dataset.smRows === "1") return;
  tbody.dataset.smRows = "1";
  const markRows = () => {
    tbody.querySelectorAll("tr:not(.is-new)").forEach((row) => {
      if (!row.querySelector("td[colspan]")) {
        row.classList.add("is-new");
        window.setTimeout(() => row.classList.remove("is-new"), 700);
      }
    });
  };
  markRows();
  if ("MutationObserver" in window) {
    const obs = new MutationObserver(() => window.setTimeout(markRows, 40));
    obs.observe(tbody, { childList: true });
  }
}

function watchCounters() {
  const selectors = ["#villesCount", "#villesFeesRange", "#villesDelayRange"];
  const nodes = selectors.map((s) => document.querySelector(s)).filter(Boolean);
  if (!nodes.length) return;
  nodes.forEach((node) => {
    if (node.dataset.smCount === "1") return;
    node.dataset.smCount = "1";
    if (!("MutationObserver" in window)) return;
    const obs = new MutationObserver(() => animateCount(node));
    obs.observe(node, { childList: true, characterData: true, subtree: true });
  });
}

function initObserver() {
  if (!("IntersectionObserver" in window)) {
    document.querySelectorAll(".sm-reveal").forEach(revealNow);
    return;
  }
  _io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        revealNow(entry.target);
        _io.unobserve(entry.target);
      });
    },
    { threshold: 0.08, rootMargin: "0px 0px -28px 0px" }
  );
}

function initSecondaryUi() {
  if (_ready) return;
  _ready = true;
  initObserver();
  scan(document);
  watchCityRows();
  watchCounters();

  if ("MutationObserver" in window) {
    const obs = new MutationObserver(() => {
      if (_scanTimer) return;
      _scanTimer = window.setTimeout(() => {
        _scanTimer = null;
        scan(document);
      }, 180);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  /* Filet de sécurité : contenu toujours visible si l'observateur ne
     se déclenche pas (scroll programmatique, navigateur exotique). */
  window.setTimeout(() => {
    document.querySelectorAll(".sm-reveal:not(.is-visible)").forEach(revealNow);
  }, 2600);

  window.__secondaryUi = { scan, revealAll: () => document.querySelectorAll(".sm-reveal").forEach(revealNow) };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSecondaryUi);
} else {
  initSecondaryUi();
}
