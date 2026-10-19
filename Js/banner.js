// js/banner.js
// ============================================================
// CARROUSELS AUTOMATIQUES - SMART SWI9A
// Version 1.2.0 — Fix traductions AR/EN (noNewProducts/noPromotions)
// ============================================================
// Dépend de : utils, products
// Bannière "Nouveautés" : 10 produits les plus récents
// Bannière "Promos"     : produits en promotion (oldPrice > price)
// ============================================================

import { t, escapeHTML, getProductName, getProductImageUrl, getFallbackImage } from "./utils.js";
import { getNewProducts, getPromoProducts, openProductPage } from "./products.js";

// ============================================================
// DÉTECTION PREFERS-REDUCED-MOTION
// ============================================================
const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ============================================================
// CLASSE INFINITE BANNER
// ============================================================
class InfiniteBanner {
    constructor(trackId, products, options = {}) {
        this.track = document.getElementById(trackId);
        if (!this.track) {
            console.warn(`⚠️ Élément #${trackId} introuvable`);
            return;
        }

        this.products = products || [];
        this.options = {
            speed: options.speed || 0.4,
            showDiscount: options.showDiscount || false,
            showNewBadge: options.showNewBadge || false
        };

        if (this.products.length === 0) {
            this.renderEmpty();
            return;
        }

        this.offset = 0;
        this.animId = null;
        this.paused = false;
        this.itemWidth = 0;
        this.setWidth = 0;

        this.container = this.track.closest('.banner-carousel');
        this.prevBtn = this.container?.querySelector('.banner-prev');
        this.nextBtn = this.container?.querySelector('.banner-next');
        this.observer = null;
        this.resizeObserver = null;

        this.build();
        this.bind();

        if (!prefersReducedMotion) {
            this.start();
            this.setupIntersectionObserver();
            this.setupResizeObserver();
            this._visibilityHandler = this.visibilityHandler.bind(this);
            document.addEventListener('visibilitychange', this._visibilityHandler);
        } else {
            requestAnimationFrame(() => this.updateDimensions());
            this.setupResizeObserver();
            console.log('⏸️ Animation bannière désactivée (prefers-reduced-motion)');
        }
    }

    renderEmpty() {
        this.track.innerHTML = `
            <div style="text-align:center;width:100%;color:var(--text-muted);padding:2rem 1rem;font-size:0.85rem;">
                ${t('noProductsFound')}
            </div>
        `;
    }

    build() {
        this.track.innerHTML = '';
        const items = [...this.products, ...this.products];
        items.forEach(p => this.track.appendChild(this.createItem(p)));
        requestAnimationFrame(() => this.updateDimensions());
    }

    createItem(p) {
        const div = document.createElement('div');
        div.className = 'banner-item';

        const name = escapeHTML(getProductName(p));
        const img = getProductImageUrl(p);
        const fallback = getFallbackImage(name);
        const price = Number(p.price) || 0;
        const oldPrice = Number(p.oldPrice) || 0;
        const isPromo = oldPrice > price;
        const discountPercent = (isPromo && oldPrice > 0)
            ? Math.round(((oldPrice - price) / oldPrice) * 100)
            : 0;

        let badgeHtml = '';
        if (this.options.showDiscount && isPromo) {
            badgeHtml = `<span class="banner-discount-badge">-${discountPercent}%</span>`;
        } else if (this.options.showNewBadge) {
            badgeHtml = `<span class="banner-discount-badge" style="background:var(--success);">NEW</span>`;
        }

        div.innerHTML = `
            ${badgeHtml}
            <img src="${img}" alt="${name}" loading="lazy" onerror="this.src='${fallback}'">
            <span>${name}</span>
            <div style="font-size:0.75rem;text-align:center;padding:0 0.5rem 0.5rem;color:var(--gold);font-weight:700;">
                ${price} ${t('currency')}
                ${isPromo ? `<small style="color:var(--text-muted);text-decoration:line-through;font-weight:400;margin-left:0.3rem;">${oldPrice}</small>` : ''}
            </div>
        `;

        div.addEventListener('click', () => {
            if (p.slug) openProductPage(p.slug);
        });

        return div;
    }

    updateDimensions() {
        const first = this.track.querySelector('.banner-item');
        if (!first) return;
        const style = window.getComputedStyle(first);
        const marginRight = parseFloat(style.marginRight) || 0;
        this.itemWidth = first.offsetWidth + marginRight;
        this.setWidth = this.products.length * this.itemWidth;

        if (this.setWidth > 0) {
            if (this.offset < -this.setWidth) this.offset += this.setWidth;
            if (this.offset > 0) this.offset -= this.setWidth;
            this.track.style.transform = `translateX(${this.offset}px)`;
        }
    }

    bind() {
        if (this.prevBtn) {
            this._movePrev = () => this.move(-1);
            this.prevBtn.addEventListener('click', this._movePrev);
        }
        if (this.nextBtn) {
            this._moveNext = () => this.move(1);
            this.nextBtn.addEventListener('click', this._moveNext);
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

    start() {
        if (this.animId) cancelAnimationFrame(this.animId);
        this.animate();
    }

    animate() {
        if (!this.paused && !document.hidden && this.products.length > 0) {
            this.offset -= this.options.speed;
            if (this.offset <= -this.setWidth) this.offset += this.setWidth;
            this.track.style.transform = `translateX(${this.offset}px)`;
        }
        this.animId = requestAnimationFrame(() => this.animate());
    }

    pause() { this.paused = true; }
    resume() { this.paused = false; }

    setupIntersectionObserver() {
        if (!this.container || typeof IntersectionObserver === 'undefined') return;
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) this.resume();
                else this.pause();
            });
        }, { threshold: 0.1 });
        this.observer.observe(this.container);
    }

    setupResizeObserver() {
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', () => this.updateDimensions());
            return;
        }
        this.resizeObserver = new ResizeObserver(() => {
            this.updateDimensions();
        });
        this.resizeObserver.observe(this.track);
    }

    visibilityHandler() {
        if (document.hidden) this.pause();
        else this.resume();
    }

    destroy() {
        if (this.animId) cancelAnimationFrame(this.animId);
        if (this.observer) this.observer.disconnect();
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.prevBtn && this._movePrev) this.prevBtn.removeEventListener('click', this._movePrev);
        if (this.nextBtn && this._moveNext) this.nextBtn.removeEventListener('click', this._moveNext);
        if (this._visibilityHandler) {
            document.removeEventListener('visibilitychange', this._visibilityHandler);
        }
        if (this.track) this.track.innerHTML = '';
    }
}

// ============================================================
// INSTANCES GLOBALES
// ============================================================
let promoBanner = null;
let newBanner = null;

// ============================================================
// INITIALISER LES BANNIÈRES
// ============================================================
export function initBanners() {
    refreshBanners();
}

// ============================================================
// RAFRAÎCHIR LES BANNIÈRES
// ============================================================
export function refreshBanners() {
    if (promoBanner) { promoBanner.destroy(); promoBanner = null; }
    if (newBanner) { newBanner.destroy(); newBanner = null; }

    // Bannière Nouveautés
    const newTrack = document.getElementById('newBannerTrack');
    if (newTrack) {
        const newProducts = getNewProducts(10);
        if (newProducts.length > 0) {
            newBanner = new InfiniteBanner('newBannerTrack', newProducts, {
                speed: 0.4,
                showNewBadge: true
            });
        } else {
            newTrack.innerHTML = `
                <div style="text-align:center;width:100%;color:var(--text-muted);padding:1rem;font-size:0.85rem;">
                    ${t('noNewProducts')}
                </div>
            `;
        }
    }

    // Bannière Promos
    const promoWrapper = document.getElementById('promoBannerWrapper');
    const promoTrack = document.getElementById('promoBannerTrack');
    if (promoTrack) {
        const promoProducts = getPromoProducts();
        if (promoProducts.length > 0) {
            if (promoWrapper) promoWrapper.style.display = '';
            promoBanner = new InfiniteBanner('promoBannerTrack', promoProducts, {
                speed: 0.4,
                showDiscount: true
            });
        } else {
            if (promoWrapper) {
                promoWrapper.style.display = 'none';
            } else {
                promoTrack.innerHTML = `
                    <div style="text-align:center;width:100%;color:var(--text-muted);padding:1rem;font-size:0.85rem;">
                        ${t('noPromotions')}
                    </div>
                `;
            }
        }
    }
}

// ============================================================
// LOG
// ============================================================
console.log(`✅ banner.js chargé${prefersReducedMotion ? ' (animations désactivées)' : ''}`);