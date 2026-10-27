/* ============================================================ js/banner.js CARROUSELS AUTOMATIQUES - SMART SWI9A Version 9.0.0 - Lot 14/30 : delta-time + cleanup + fallback CHANGEMENTS v9.0.0 : - B-BAN-1 (P2) : animation delta-time. La vitesse est normalisée à 60 fps via `performance.now()`. Sur 144 Hz, la bannière défile à la même vitesse que sur 60 Hz. - B-BAN-2 (P2) : si ResizeObserver est indisponible, le fallback window.addEventListener('resize') est stocké dans `this._fallbackResizeHandler` et retiré dans destroy(). Empêche l'accumulation de listeners. - B-BAN-3 (P2) : createItem passe le nom BRUT à getFallbackImage (qui gère son propre échappement). Évite le double-échappement (L'iPhone -> L#39;iPhone en alt). - JSDoc sur initBanners et refreshBanners. - Bump version 1.3.0 -> 9.0.0. NOTE : pas de changement de signature, rétrocompatible 100 %. initBanners() et refreshBanners() conservent leur comportement (destroy + recreate) - l'idempotence est garantie. ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import {
  t,
  escapeHTML,
  getProductName,
  getProductImageUrl,
  getFallbackImage,
} from "./utils.js";
import {
  getNewProducts,
  getPromoProducts,
  openProductPage,
} from "./products.js";

/* ============================================================ ACCESSIBILITÉ : détection prefers-reduced-motion ============================================================ Évalué une seule fois au chargement du module. Si l'utilisateur change la préférence pendant la session, il devra recharger la page pour que ça prenne effet (comportement accepté). ============================================================ */
const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ============================================================ CLASSE INFINITE BANNER ============================================================ Bannière défilante infinie avec : - Duplication des produits pour un scroll continu. - Pause automatique quand la bannière est hors viewport (IntersectionObserver) ou quand l'onglet est caché. - Mise à jour des dimensions au resize (ResizeObserver). - Animation delta-time pour vitesse constante sur tous les taux de rafraîchissement. ============================================================ */
class InfiniteBanner {
  constructor(trackId, products, options = {}) {
    this.track = document.getElementById(trackId);
    if (!this.track) {
      console.warn(`Élément #${trackId} introuvable`);
      return;
    }

    this.products = Array.isArray(products) ? products : [];
    this.options = {
      speed: options.speed || 0.4,
      showDiscount: options.showDiscount || false,
      showNewBadge: options.showNewBadge || false,
    };

    /* Aucun produit : afficher un message, sortir proprement. */
    if (this.products.length === 0) {
      this.renderEmpty();
      return;
    }

    this.offset = 0;
    this.animId = null;
    this.lastFrameTime = 0;
    this.paused = false;
    this.itemWidth = 0;
    this.setWidth = 0;

    this.container = this.track.closest(".banner-carousel");
    this.prevBtn = this.container?.querySelector(".banner-prev");
    this.nextBtn = this.container?.querySelector(".banner-next");
    this.observer = null;
    this.resizeObserver = null;
    this._fallbackResizeHandler = null;
    this._visibilityHandler = null;

    this.build();
    this.bind();

    if (!prefersReducedMotion) {
      this.start();
      this.setupIntersectionObserver();
      this.setupResizeObserver();

      this._visibilityHandler = this.visibilityHandler.bind(this);
      document.addEventListener("visibilitychange", this._visibilityHandler);
    } else {
      /* Mouvement réduit : on affiche les items sans animation, mais on garde la mise à jour des dimensions. */
      requestAnimationFrame(() => this.updateDimensions());
      this.setupResizeObserver();
    }
  }

  /* ---------------------------------------------------------- État vide (aucun produit). ---------------------------------------------------------- */
  renderEmpty() {
    this.track.innerHTML = `
            <div style="text-align:center;width:100%;color:var(--text-muted);padding:1.5rem 1rem;font-size:0.85rem;">
                ${
                  this.options.showDiscount
                    ? t("noPromotions")
                    : t("noNewProducts")
                }
            </div>
        `;
  }

  /* ---------------------------------------------------------- Construction des items (dupliqués pour scroll infini). ---------------------------------------------------------- */
  build() {
    this.track.innerHTML = "";
    const items = [...this.products, ...this.products];
    items.forEach((p) => this.track.appendChild(this.createItem(p)));
    requestAnimationFrame(() => this.updateDimensions());
  }

  /* ---------------------------------------------------------- Création d'un item. B-BAN-3 : `rawName` (non échappé) passé à getFallbackImage qui gère son propre échappement. ---------------------------------------------------------- */
  createItem(p) {
    const div = document.createElement("div");
    div.className = "banner-item";

    const rawName = getProductName(p) || "Produit";
    const name = escapeHTML(rawName);
    const img = getProductImageUrl(p);
    const fallback = getFallbackImage(rawName);
    const price = Number(p.price) || 0;
    const oldPrice = Number(p.oldPrice) || 0;
    const isPromo = oldPrice > price;
    const discountPercent =
      isPromo && oldPrice > 0
        ? Math.round(((oldPrice - price) / oldPrice) * 100)
        : 0;

    let badgeHtml = "";
    if (this.options.showDiscount && isPromo) {
      badgeHtml = `<span class="banner-discount-badge">-${discountPercent}%</span>`;
    } else if (this.options.showNewBadge) {
      badgeHtml = `<span class="banner-discount-badge" style="background:var(--success);">NEW</span>`;
    }

    div.innerHTML = `
            ${badgeHtml}
            <img src="${img}" alt="${name}" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'">
            <span>${name}</span>
            <div style="font-size:0.75rem;text-align:center;padding:0 0.5rem 0.5rem;color:var(--gold);font-weight:700;">
                ${price} ${t("currency")}
                ${
                  isPromo
                    ? `<small style="color:var(--text-muted);text-decoration:line-through;font-weight:400;margin-left:0.3rem;">${oldPrice}</small>`
                    : ""
                }
            </div>
        `;

    div.addEventListener("click", () => {
      if (p.slug) openProductPage(p.slug);
    });

    return div;
  }

  /* ---------------------------------------------------------- Recalcul des dimensions après rendu / resize. ---------------------------------------------------------- */
  updateDimensions() {
    const first = this.track.querySelector(".banner-item");
    if (!first) return;

    const style = window.getComputedStyle(first);
    const marginRight = parseFloat(style.marginRight) || 0;
    this.itemWidth = first.offsetWidth + marginRight;
    this.setWidth = this.products.length * this.itemWidth;

    if (this.setWidth > 0) {
      /* Normaliser l'offset dans [−setWidth, 0]. */
      if (this.offset < -this.setWidth) this.offset += this.setWidth;
      if (this.offset > 0) this.offset -= this.setWidth;
      this.track.style.transform = `translateX(${this.offset}px)`;
    }
  }

  /* ---------------------------------------------------------- Boutons précédent / suivant. ---------------------------------------------------------- */
  bind() {
    if (this.prevBtn) {
      this._movePrev = () => this.move(-1);
      this.prevBtn.addEventListener("click", this._movePrev);
    }
    if (this.nextBtn) {
      this._moveNext = () => this.move(1);
      this.nextBtn.addEventListener("click", this._moveNext);
    }
  }

  move(dir) {
    if (this.products.length === 0) return;
    const step = this.itemWidth * 3;
    this.offset += dir * step;
    if (this.offset > 0) this.offset -= this.setWidth;
    if (this.offset < -this.setWidth) this.offset += this.setWidth;
    this.track.style.transform = `translateX(${this.offset}px)`;
  }

  /* ---------------------------------------------------------- Animation delta-time (B-BAN-1). ---------------------------------------------------------- `this.options.speed` = pixels par frame-60fps. `deltaFactor` = ms_écoulées / 16.67 ms (durée frame 60fps). Résultat : même vitesse (px/s) sur 60 Hz, 120 Hz, 144 Hz. ---------------------------------------------------------- */
  start() {
    if (this.animId) cancelAnimationFrame(this.animId);
    this.lastFrameTime = 0;
    this.animate(0);
  }

  animate(timestamp) {
    /* Normalise à 60 fps. Cap à 100 ms pour éviter les sauts quand l'onglet revient après une longue pause. */
    const deltaMs = this.lastFrameTime
      ? Math.min(timestamp - this.lastFrameTime, 100)
      : 16.67;
    const deltaFactor = deltaMs / 16.67;
    this.lastFrameTime = timestamp;

    if (!this.paused && !document.hidden && this.products.length > 0) {
      this.offset -= this.options.speed * deltaFactor;
      if (this.offset <= -this.setWidth) this.offset += this.setWidth;
      this.track.style.transform = `translateX(${this.offset}px)`;
    }
    this.animId = requestAnimationFrame((t) => this.animate(t));
  }

  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }

  /* ---------------------------------------------------------- Pause hors viewport. ---------------------------------------------------------- */
  setupIntersectionObserver() {
    if (!this.container || typeof IntersectionObserver === "undefined") return;
    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) this.resume();
          else this.pause();
        });
      },
      { threshold: 0.1 }
    );
    this.observer.observe(this.container);
  }

  /* ---------------------------------------------------------- Recalcul des dimensions au resize. B-BAN-2 : fallback stocké et nettoyable. ---------------------------------------------------------- */
  setupResizeObserver() {
    if (typeof ResizeObserver === "undefined") {
      this._fallbackResizeHandler = () => this.updateDimensions();
      window.addEventListener("resize", this._fallbackResizeHandler);
      return;
    }
    this.resizeObserver = new ResizeObserver(() => {
      this.updateDimensions();
    });
    this.resizeObserver.observe(this.track);
  }

  /* ---------------------------------------------------------- Pause quand l'onglet est caché. ---------------------------------------------------------- */
  visibilityHandler() {
    if (document.hidden) this.pause();
    else this.resume();
  }

  /* ---------------------------------------------------------- Nettoyage complet. Idempotent. ---------------------------------------------------------- */
  destroy() {
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this._fallbackResizeHandler) {
      window.removeEventListener("resize", this._fallbackResizeHandler);
      this._fallbackResizeHandler = null;
    }
    if (this.prevBtn && this._movePrev) {
      this.prevBtn.removeEventListener("click", this._movePrev);
    }
    if (this.nextBtn && this._moveNext) {
      this.nextBtn.removeEventListener("click", this._moveNext);
    }
    if (this._visibilityHandler) {
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this.track) this.track.innerHTML = "";
  }
}

/* ============================================================ INSTANCES GLOBALES ============================================================ */
let promoBanner = null;
let newBanner = null;

/* ============================================================ INITIALISER / RAFRAÎCHIR ============================================================ */

/** * Point d'entrée principal. Appelé par app.js au chargement. * Équivalent à refreshBanners() (destruction + recréation des * instances existantes). */
export function initBanners() {
  refreshBanners();
}

/** * Détruit les instances existantes et en recrée de nouvelles * à partir du catalogue actuel. * * Idempotent : peut être appelé plusieurs fois (ex: changement * de langue via events.js) sans fuite de listeners ni doublons * de DOM. */
export function refreshBanners() {
  /* Nettoyage des anciennes instances. */
  if (promoBanner) {
    promoBanner.destroy();
    promoBanner = null;
  }
  if (newBanner) {
    newBanner.destroy();
    newBanner = null;
  }

  /* Bannière Nouveautés. */
  const newTrack = document.getElementById("newBannerTrack");
  if (newTrack) {
    const newProducts = getNewProducts(10);
    newBanner = new InfiniteBanner("newBannerTrack", newProducts, {
      speed: 0.4,
      showNewBadge: true,
    });
  }

  /* Bannière Promotions (masquée si aucune promo). */
  const promoWrapper = document.getElementById("promoBannerWrapper");
  const promoTrack = document.getElementById("promoBannerTrack");

  if (promoTrack) {
    const promoProducts = getPromoProducts();

    if (promoProducts.length > 0) {
      if (promoWrapper) promoWrapper.style.display = "";
      promoBanner = new InfiniteBanner("promoBannerTrack", promoProducts, {
        speed: 0.4,
        showDiscount: true,
      });
    } else {
      if (promoWrapper) promoWrapper.style.display = "none";
    }
  }
}

/* ============================================================ LOG ============================================================ */
console.log(
  `✅ banner.js chargé - v9.0.0 (Lot 14 : delta-time + cleanup)${
    prefersReducedMotion ? " (animations désactivées)" : ""
  }`
);