/* ============================================================
   js/seo.js — CANONICAL / HREFLANG / JSON-LD (SEO technique)
   ------------------------------------------------------------
   CORRECTIF AUDIT 2026-11-20 — Deux défauts mesurés en production :

   1. CONFLIT hreflang <-> canonical
      `?lang=ar` déclarait <link rel="alternate" hreflang="ar"> vers
      ?lang=ar, mais la page conservait <link rel="canonical" href="/">
      (sans le paramètre). Google ignore alors TOUTES les annotations
      hreflang. Ici chaque version linguistique devient sa propre
      canonique : fr = URL nue, ar/en = URL + ?lang=xx.

   2. CANONICAL PARASITÉE
      js/product-detail.js utilisait `window.location.href`, donc le
      canonical d'une fiche incluait utm_*, fbclid, etc. On reconstruit
      une URL propre en conservant UNIQUEMENT les paramètres
      fonctionnels (slug, v, id).

   Module volontairement sans dépendance Firebase : il peut être
   importé par n'importe quelle page.
   ============================================================ */

import { getLang } from "./utils.js";

export const SITE_URL = "https://smartswika.ma";

/* Paramètres conservés dans l'URL canonique (identité de la page). */
const KEEP_PARAMS = ["slug", "v", "id"];

/**
 * Normalise le chemin courant : /produit.html -> /produit, / -> /.
 * @returns {string}
 */
function normalizePath() {
  let p = window.location.pathname || "/";
  p = p.replace(/\/index\.html?$/i, "/");
  p = p.replace(/\.html?$/i, "");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p === "" ? "/" : p;
}

/**
 * Construit l'URL canonique propre de la page courante.
 * - conserve slug / v / id ;
 * - ajoute ?lang=ar|en (jamais pour fr, qui est la version de référence) ;
 * - ignore utm_*, fbclid, gclid, etc.
 * @returns {string}
 */
export function buildCanonicalUrl() {
  const url = new URL(SITE_URL + normalizePath());
  const current = new URLSearchParams(window.location.search);
  KEEP_PARAMS.forEach((key) => {
    const value = current.get(key);
    if (value) url.searchParams.set(key, value);
  });
  const lang = getLang();
  if (lang === "ar" || lang === "en") url.searchParams.set("lang", lang);
  return url.toString();
}

/**
 * Écrit (ou met à jour) canonical + hreflang cohérents.
 * @param {string} [canonicalUrl]
 * @returns {string} l'URL canonique appliquée
 */
export function applySeoLinks(canonicalUrl = buildCanonicalUrl()) {
  let canonical = document.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.appendChild(canonical);
  }
  canonical.setAttribute("href", canonicalUrl);

  const base = new URL(canonicalUrl);
  const variants = {
    fr: (() => { const u = new URL(base); u.searchParams.delete("lang"); return u.toString(); })(),
    ar: (() => { const u = new URL(base); u.searchParams.set("lang", "ar"); return u.toString(); })(),
    en: (() => { const u = new URL(base); u.searchParams.set("lang", "en"); return u.toString(); })(),
  };
  variants["x-default"] = variants.fr;

  Object.entries(variants).forEach(([hreflang, href]) => {
    let link = document.querySelector(`link[rel="alternate"][hreflang="${hreflang}"]`);
    if (!link) {
      link = document.createElement("link");
      link.rel = "alternate";
      link.setAttribute("hreflang", hreflang);
      document.head.appendChild(link);
    }
    link.setAttribute("href", href);
  });

  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) ogUrl.setAttribute("content", canonicalUrl);

  return canonicalUrl;
}

/**
 * Initialise le SEO de la page et le maintient à jour au changement
 * de langue (événement `lang-changed` émis par js/utils.js setLang).
 * @returns {void}
 */
export function initSeo() {
  try {
    applySeoLinks();
  } catch (e) {
    console.warn("[seo] canonical non appliquée :", e && e.message);
  }
  document.addEventListener("lang-changed", () => {
    try {
      applySeoLinks();
    } catch (e) {
      /* non bloquant */
    }
  });
}

export default initSeo;
