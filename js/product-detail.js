/* ============================================================ js/product-detail.js PAGE PRODUIT DYNAMIQUE - SMARTSWIKA Version 9.0.0 - Lot 20/30 : gallery dedup + image fallback + prix guard CHANGEMENTS v9.0.0 : - B10 (P2) : renderMediaGallery déduplique [img, ...gallery] via Set. Plus de doublons visuels si img est aussi dans gallery. - B-PD-2 (P2) : renderMediaGallery utilise getFallbackImage() si product.img est null/vide. Fini l'icône cassée. - B-PD-4 (P2) : updateVariantDisplay garde le prix variante null/0 et fallback sur product.price. Fini "null MAD". - Faux-positif (annonce précédente) : openSizeGuideModal n'a PAS de data-photo-url. Aucune correction nécessaire. - JSDoc sur renderProductDetail. - Bump version 8.1.0 -> 9.0.0. NOTE (conservé) : la modale guide des tailles affiche un tableau statique S/M/L/XL/XXL. Si les tailles doivent être dynamiques par produit, il faudra un nouveau champ Firestore et une refonte (hors scope). ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG, VIDEO_BASE_URL, getProductOwner } from "./config.js";
import {
  t,
  escapeHTML,
  getProductName,
  getProductDesc,
  getProductFeatures,
  getProductImageUrl,
  getFallbackImage,
  renderStars,
  getDiscountPercent,
  formatDate,
} from "./utils.js";
import { getProducts } from "./store.js";
import { getCurrentUser } from "./auth.js";
import { toggleFavorite } from "./products.js";
import { createReview, canUserReviewProduct, toggleLike } from "./reviews.js";
import { showToast, openImageLightbox } from "./ui-core.js";
import {
  getProductVendorLabel,
  getProductVendorLabelSync,
} from "./vendor-attribution.js";
import { normalizeProductId } from "./domain/product-id.js";

/* ============================================================ HELPERS LOCAUX ============================================================ */

/** * Normalise un ID produit. * Numérique (compat favoris/reviews historiques) -> Number. * Alphanumérique (produits vendeurs Firestore auto-ID) -> String. * @param {*} id * @returns {number|string|null} */

/* ============================================================ ÉTAT LOCAL ============================================================ */
let currentProduct = null;
let currentVideoElement = null;

/* État de sélection des variantes. */
let selectedSize = null;
let selectedColor = null;
let currentVariant = null;

/* État pour l'affichage des avis. */
let allReviewsCache = [];
let showAllReviews = false;
const REVIEWS_LIMIT = 3;

/* ============================================================ LECTURE DU SLUG ============================================================ */
function getSlugFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("slug");
}

/* ============================================================ RENDU PRINCIPAL ============================================================ */

/** * Point d'entrée : lit le slug, charge le produit et rend toutes * les sections de la page produit. * * Comportement : * - Slug absent ou produit introuvable -> renderNotFound. * - Produit vendeur suspendu/rejeté -> renderNotFound. * - Sinon : rendu complet + attache events. * * @returns {Promise<void>} */
export async function renderProductDetail() {
  const mainEl = document.querySelector("main[data-product-page]");
  if (!mainEl) return;

  const slug = getSlugFromUrl();
  if (!slug) {
    renderNotFound(mainEl);
    return;
  }

  let products = getProducts();
  if (!products || products.length === 0) {
    try {
      const { getProductsLoadedPromise } = await import("./store.js");
      const promise = getProductsLoadedPromise();
      if (promise) {
        await promise;
        products = getProducts();
      }
    } catch (e) {
      console.warn("Attente produits échouée :", e);
    }
  }

  const product = products.find((p) => p.slug === slug);
  if (!product) {
    renderNotFound(mainEl);
    return;
  }

  /* Vérifier le statut vendeur (le cache products peut être obsolète). */
  let vendorLabel = { type: "smart", name: "Smartswika" };
  try {
    vendorLabel = await getProductVendorLabel(product);
  } catch (e) {
    console.warn("Lecture statut vendeur impossible :", e?.code || e);
  }
  if (
    vendorLabel.type === "vendor" &&
    (vendorLabel.status === "suspended" || vendorLabel.status === "rejected")
  ) {
    renderNotFound(mainEl);
    return;
  }

  currentProduct = product;
  selectedSize = null;
  selectedColor = null;
  currentVariant = null;
  showAllReviews = false;
  _relatedForProductId = null;
  _relatedProductsCache = null;

  document.title = `${getProductName(product)} | Smartswika`;

  updateMetaTags(product);
  renderBreadcrumbs(product);
  renderMediaGallery(product);
  renderInfoSection(product);
  renderVariantsSection(product);
  renderDimensions(product);
  renderFeaturesSection(product);
  await renderReviewsSection(product);
  renderRelatedProducts(product);

  attachProductEvents(product);
}

/* ============================================================ PRODUIT NON TROUVÉ ============================================================ */
function renderNotFound(mainEl) {
  mainEl.innerHTML = ` <div style="text-align:center;padding:4rem 1rem;"> <div style="font-size:4rem;margin-bottom:1rem;">🔍</div> <h1 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:1rem;">${t( "productNotFound" )}</h1> <p style="color:var(--text-muted);margin-bottom:2rem;">${t( "noProductsFound" )}</p> <a href="/" class="btn-primary">← ${t("productBreadcrumbHome")}</a> </div> `;
}

/* ============================================================ META TAGS DYNAMIQUES (SEO) ============================================================ */
function updateMetaTags(product) {
  const name = getProductName(product);
  const desc = getProductDesc(product);
  const rawImg = getProductImageUrl(product);
  const img = typeof rawImg === "string" ? rawImg : "";
  const url = window.location.href;
  const isAbsolute = /^https?:\/\//i.test(img);
  const absoluteImg = isAbsolute
    ? img
    : `${CONFIG.SHOP.URL}${img || "/assets/og-default.jpg"}`;

  document.title = `${name} | Smartswika`;

  setMeta("name", "description", String(desc || "").substring(0, 160));
  setMeta("property", "og:title", name);
  setMeta("property", "og:description", String(desc || "").substring(0, 200));
  setMeta("property", "og:image", absoluteImg);
  setMeta("property", "og:url", url);
  setMeta("property", "og:type", "product");
  setMeta("property", "product:price:amount", String(product.price || 0));
  setMeta("property", "product:price:currency", "MAD");
  setMeta("name", "twitter:card", "summary_large_image");
  setMeta("name", "twitter:title", name);
  setMeta("name", "twitter:image", absoluteImg);

  let canonical = document.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.appendChild(canonical);
  }
  canonical.href = url;

  const schemaId = "product-schema-ld";
  let schemaEl = document.getElementById(schemaId);
  if (!schemaEl) {
    schemaEl = document.createElement("script");
    schemaEl.id = schemaId;
    schemaEl.type = "application/ld+json";
    document.head.appendChild(schemaEl);
  }
  schemaEl.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: name,
    description: desc,
    image: absoluteImg,
    brand: { "@type": "Brand", name: "Smartswika" },
    offers:
      product.price > 0
        ? {
            "@type": "Offer",
            price: product.price,
            priceCurrency: "MAD",
            availability:
              (product.stock || 0) > 0
                ? "https://schema.org/InStock"
                : "https://schema.org/OutOfStock",
            url: url,
          }
        : undefined,
    aggregateRating: product.ratingAvg
      ? {
          "@type": "AggregateRating",
          ratingValue: product.ratingAvg,
          reviewCount: product.ratingCount || 1,
        }
      : undefined,
  });
}

function setMeta(attrName, attrValue, content) {
  let el = document.querySelector(`meta[${attrName}="${attrValue}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attrName, attrValue);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content || "");
}

/* ============================================================ BREADCRUMBS ============================================================ */
function renderBreadcrumbs(product) {
  const el = document.getElementById("breadcrumbs");
  if (!el) return;

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: t("productBreadcrumbHome"),
        item: CONFIG.SHOP.URL,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: t("productBreadcrumbProducts"),
        item: `${CONFIG.SHOP.URL}/#produits`,
      },
      { "@type": "ListItem", position: 3, name: getProductName(product) },
    ],
  };

  let schemaEl = document.getElementById("breadcrumb-schema");
  if (!schemaEl) {
    schemaEl = document.createElement("script");
    schemaEl.id = "breadcrumb-schema";
    schemaEl.type = "application/ld+json";
    document.head.appendChild(schemaEl);
  }
  schemaEl.textContent = JSON.stringify(breadcrumbSchema);

  const currentSpan = document.getElementById("breadcrumbCurrent");
  if (currentSpan) {
    currentSpan.textContent = getProductName(product);
    currentSpan.removeAttribute("data-key");
  }
}

/* ============================================================ SECTION GALERIE MÉDIA (Images + Vidéo unifiées) ============================================================ B10 : déduplique [img, ...gallery] via Set. B-PD-2 : utilise getFallbackImage si img null/vide. ============================================================ */
function renderMediaGallery(product) {
  const wrapper = document.getElementById("mainMediaWrapper");
  const galleryContainer = document.getElementById("galleryThumbnails");
  if (!wrapper || !galleryContainer) return;

  const mainImageUrl = getProductImageUrl(product);
  galleryContainer.innerHTML = "";

  if (currentVideoElement) {
    currentVideoElement.pause();
    currentVideoElement = null;
  }
  wrapper.innerHTML = "";

  const showImage = (src, activeThumb) => {
    if (currentVideoElement) {
      currentVideoElement.pause();
      currentVideoElement = null;
    }
    /* B-PD-2 : fallback si src vide/null. */
    const safeSrc =
      (src && String(src).trim()) || getFallbackImage(getProductName(product));
    wrapper.innerHTML = `<img id="mainImage" class="main-media-element" src="${escapeHTML( safeSrc )}" alt="${escapeHTML( getProductName(product) )}" loading="eager" onerror="this.onerror=null;this.src='${getFallbackImage( getProductName(product) )}'">`;
    const mainImg = document.getElementById("mainImage");
    if (mainImg)
      mainImg.addEventListener("click", () => openImageLightbox(mainImg.src));
    galleryContainer
      .querySelectorAll(".thumb-img, .thumb-video")
      .forEach((el) => el.classList.remove("active"));
    if (activeThumb) activeThumb.classList.add("active");
  };

  const showVideo = (videoUrl, activeThumb) => {
    wrapper.innerHTML = `<video id="mainVideo" class="main-media-element" src="${escapeHTML( videoUrl )}" controls preload="metadata" playsinline poster="${escapeHTML( mainImageUrl )}" style="background: #000;"></video>`;
    currentVideoElement = document.getElementById("mainVideo");
    galleryContainer
      .querySelectorAll(".thumb-img, .thumb-video")
      .forEach((el) => el.classList.remove("active"));
    if (activeThumb) activeThumb.classList.add("active");
  };

  /* B10 : déduplique [img, ...gallery] via Set. */
  const rawImages = [
    product.img,
    ...(Array.isArray(product.gallery) ? product.gallery : []),
  ];
  const images = [...new Set(rawImages.filter(Boolean))];

  let firstImageThumb = null;

  images.forEach((imgUrl, index) => {
    if (!imgUrl) return;
    const thumb = document.createElement("img");
    thumb.className = "thumb-img";
    thumb.src =
      imgUrl.startsWith("http") || imgUrl.startsWith("/")
        ? imgUrl
        : "/" + imgUrl;
    thumb.alt = `${getProductName(product)} - ${index + 1}`;
    thumb.loading = "lazy";
    thumb.addEventListener("click", () => showImage(thumb.src, thumb));
    if (index === 0) firstImageThumb = thumb;
    galleryContainer.appendChild(thumb);
  });

  const hasVideo =
    typeof product.video === "string" && product.video.trim() !== "";
  let videoThumb = null;

  if (hasVideo) {
    const baseUrl = VIDEO_BASE_URL.endsWith("/")
      ? VIDEO_BASE_URL
      : VIDEO_BASE_URL + "/";
    const videoUrl = baseUrl + product.video.trim();

    videoThumb = document.createElement("div");
    videoThumb.className = "thumb-video";
    videoThumb.innerHTML = ` <img src="${escapeHTML( mainImageUrl )}" style="filter: brightness(0.5);"> <div class="play-icon-overlay"> <div><svg viewBox="0 0 24 24" fill="white" width="14" height="14" style="margin-left: 2px;"><path d="M8 5v14l11-7z"/></svg></div> </div> `;
    videoThumb.addEventListener("click", () => showVideo(videoUrl, videoThumb));
    galleryContainer.insertBefore(videoThumb, galleryContainer.firstChild);
    showVideo(videoUrl, videoThumb);
    if (firstImageThumb) firstImageThumb.classList.remove("active");
  } else {
    showImage(mainImageUrl, firstImageThumb);
  }
}

/* ============================================================ SECTION INFO (Prix, Stock, Boutons) ============================================================ */
function renderInfoSection(product) {
  const titleEl = document.getElementById("productTitleEl");
  const priceEl = document.getElementById("productPrice");
  const oldPriceEl = document.getElementById("productOldPrice");
  const descEl = document.getElementById("productDescEl");
  const stockEl = document.getElementById("productStockStatus");
  const stock = Number(product.stock) || 0;
  const discountPercent = getDiscountPercent(product.oldPrice, product.price);
  const isPromo = discountPercent > 0;

  if (titleEl) {
    titleEl.textContent = getProductName(product);
    titleEl.removeAttribute("data-key");
  }
  if (priceEl) priceEl.textContent = `${product.price} ${t("currency")}`;
  if (oldPriceEl) {
    if (isPromo) {
      oldPriceEl.textContent = `${product.oldPrice} ${t("currency")}`;
      oldPriceEl.style.display = "inline-block";
    } else {
      oldPriceEl.style.display = "none";
    }
  }
  if (descEl) descEl.textContent = getProductDesc(product);

  if (isPromo) {
    const priceBlock = document.querySelector(".product-price-block");
    if (priceBlock) {
      const existing = priceBlock.querySelector(".discount-badge");
      if (existing) existing.remove();
      const badge = document.createElement("span");
      badge.className = "discount-badge";
      badge.style.cssText =
        "background:var(--danger);color:white;padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;";
      badge.textContent = `-${discountPercent}%`;
      priceBlock.appendChild(badge);
    }
  }

  if (stockEl) {
    stockEl.innerHTML =
      stock > 0
        ? `<span style="color:#22c55e;">${t("productInStock")}</span>`
        : `<span style="color:#b03a2e;">${t("productOutOfStock")}</span>`;
  }

  /* Bloc vendeur — sync (données en cache préchargées). */
  renderProductVendorBlock(product);

  const addBtn = document.getElementById("addToCartBtn");
  if (addBtn) {
    addBtn.dataset.id = String(product.id);
    addBtn.disabled = stock === 0;
    addBtn.style.opacity = stock === 0 ? "0.5" : "1";
    addBtn.style.cursor = stock === 0 ? "not-allowed" : "pointer";
  }

  const waBtn = document.getElementById("whatsappOrderBtn");
  if (waBtn) waBtn.dataset.productId = String(product.id);
}

/* ============================================================ Bloc "Vendu par" ============================================================ */
function renderProductVendorBlock(product) {
  const titleEl = document.getElementById("productTitleEl");
  if (!titleEl) return;

  const existing = document.getElementById("productVendorBlock");
  if (existing) existing.remove();

  const vendorInfo = getProductVendorLabelSync(product);
  const owner = getProductOwner(product);
  const isVendorProduct = owner && owner !== "smartswi9a";

  let html;
  if (isVendorProduct) {
    const vendorUid = encodeURIComponent(owner);
    html = ` <div id="productVendorBlock" class="product-vendor-info" style="margin: 0.5rem 0 1rem; display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem;"> <span style="color: var(--text-muted);">${ t("vendorSoldBy") || "Vendu par" } :</span> <a href="/boutique.html?v=${vendorUid}" class="product-vendor-info-link" style="display: inline-flex; align-items: center; gap: 0.3rem; color: #6b46c1; font-weight: 700; text-decoration: none; background: rgba(107, 70, 193, 0.1); padding: 0.2rem 0.6rem; border-radius: 30px; border: 1px solid rgba(107, 70, 193, 0.3);"> <span>🏪</span> <span>${escapeHTML(vendorInfo.name)}</span> <span>→</span> </a> </div> `;
  } else {
    html = ` <div id="productVendorBlock" class="product-vendor-info" style="margin: 0.5rem 0 1rem; display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem;"> <span style="color: var(--text-muted);">${ t("vendorSoldBy") || "Vendu par" } :</span> <span class="product-vendor-info-smart" style="display: inline-flex; align-items: center; gap: 0.3rem; color: var(--gold); font-weight: 700; background: rgba(165, 123, 46, 0.1); padding: 0.2rem 0.6rem; border-radius: 30px; border: 1px solid var(--border-gold);"> <span>✅</span> <span>${t("vendorSmartSwi9a") || "Smartswika"}</span> </span> </div> `;
  }
  titleEl.insertAdjacentHTML("afterend", html);
}

/* ============================================================ SECTION DES VARIANTES (Tailles / Couleurs) ============================================================ */
function renderVariantsSection(product) {
  const root = document.getElementById("productVariantsRoot");
  if (!root) return;

  if (!Array.isArray(product.variants) || product.variants.length === 0) {
    root.innerHTML = "";
    return;
  }

  const sizes = [
    ...new Set(product.variants.map((v) => v.size).filter(Boolean)),
  ];
  const colors = [
    ...new Set(product.variants.map((v) => v.color).filter(Boolean)),
  ];

  let html = "";
  const guideBtnHtml = product.hasSizeGuide
    ? `<button class="size-guide-btn" id="openSizeGuideBtn">Guide des tailles (US/EU)</button>`
    : "";

  if (sizes.length > 0) {
    html += ` <div class="variant-options-group"> <div class="variant-label"> <span>Taille : <span id="selectedSizeLabel" style="color:var(--gold);">Sélectionnez</span></span> ${guideBtnHtml} </div> <div class="variant-buttons" id="sizeButtons"> ${sizes .map( (s) => `<button type="button" class="variant-btn" data-size="${escapeHTML( s )}">${escapeHTML(s)}</button>` ) .join("")} </div> </div> `;
  }

  if (colors.length > 0) {
    html += ` <div class="variant-options-group"> <div class="variant-label"> <span>Couleur : <span id="selectedColorLabel" style="color:var(--gold);">Sélectionnez</span></span> </div> <div class="variant-buttons" id="colorButtons"> ${colors .map( (c) => `<button type="button" class="variant-btn" data-color="${escapeHTML( c )}">${escapeHTML(c)}</button>` ) .join("")} </div> </div> `;
  }

  root.innerHTML = html;

  if (guideBtnHtml)
    document
      .getElementById("openSizeGuideBtn")
      ?.addEventListener("click", openSizeGuideModal);
  document
    .querySelectorAll("#sizeButtons .variant-btn")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        selectVariantOption("size", btn.dataset.size)
      )
    );
  document
    .querySelectorAll("#colorButtons .variant-btn")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        selectVariantOption("color", btn.dataset.color)
      )
    );

  if (sizes.length === 1) selectVariantOption("size", sizes[0]);
  if (colors.length === 1) selectVariantOption("color", colors[0]);
}

function selectVariantOption(type, value) {
  if (type === "size") {
    selectedSize = value;
    const sizeLabel = document.getElementById("selectedSizeLabel");
    if (sizeLabel) sizeLabel.textContent = value;
    document
      .querySelectorAll("#sizeButtons .variant-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.size === value));
  } else if (type === "color") {
    selectedColor = value;
    const colorLabel = document.getElementById("selectedColorLabel");
    if (colorLabel) colorLabel.textContent = value;
    document
      .querySelectorAll("#colorButtons .variant-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.color === value));
  }

  if (!currentProduct || !Array.isArray(currentProduct.variants)) {
    currentVariant = null;
    updateVariantDisplay();
    return;
  }

  const variant = currentProduct.variants.find((v) => {
    const matchSize = !selectedSize || v.size === selectedSize;
    const matchColor = !selectedColor || v.color === selectedColor;
    return matchSize && matchColor;
  });

  currentVariant = variant || null;
  updateVariantDisplay();
}

/* B-PD-4 : prix variante null/0 -> fallback product.price. */
function updateVariantDisplay() {
  const priceEl = document.getElementById("productPrice");
  const oldPriceEl = document.getElementById("productOldPrice");
  const stockEl = document.getElementById("productStockStatus");
  const addBtn = document.getElementById("addToCartBtn");

  if (!currentVariant) {
    if (stockEl) {
      if (selectedSize && selectedColor) {
        stockEl.innerHTML = `<span style="color:var(--danger);font-weight:600;">Combinaison indisponible</span>`;
      } else {
        stockEl.innerHTML = `<span style="color:var(--text-muted);">Sélectionnez les options</span>`;
      }
    }
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.style.opacity = "0.5";
    }
    if (oldPriceEl) oldPriceEl.style.display = "none";
    return;
  }

  /* B-PD-4 : guard prix null/0. */
  const variantPrice = Number(currentVariant.price);
  const safePrice =
    Number.isFinite(variantPrice) && variantPrice > 0
      ? variantPrice
      : Number(currentProduct?.price) || 0;

  if (priceEl) priceEl.textContent = `${safePrice} ${t("currency")}`;

  if (oldPriceEl) {
    if (
      currentProduct &&
      currentProduct.oldPrice &&
      currentProduct.oldPrice > safePrice
    ) {
      oldPriceEl.textContent = `${currentProduct.oldPrice} ${t("currency")}`;
      oldPriceEl.style.display = "inline-block";
    } else {
      oldPriceEl.style.display = "none";
    }
  }

  if (currentVariant.stock > 0) {
    if (stockEl)
      stockEl.innerHTML = `<span style="color:#22c55e;">${t( "productInStock" )} (${currentVariant.stock})</span>`;
    if (addBtn) {
      addBtn.disabled = false;
      addBtn.style.opacity = "1";
      addBtn.style.cursor = "pointer";
    }
  } else {
    if (stockEl)
      stockEl.innerHTML = `<span style="color:#b03a2e;">${t( "productOutOfStock" )}</span>`;
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.style.opacity = "0.5";
      addBtn.style.cursor = "not-allowed";
    }
  }
}

/* ============================================================ DIMENSIONS ============================================================ */
function renderDimensions(product) {
  const root = document.getElementById("productDimensionsRoot");
  if (!root) return;
  if (!product.dimensions || typeof product.dimensions !== "object") {
    root.innerHTML = "";
    return;
  }

  const { weight, length, width, height } = product.dimensions;
  if (!weight && !length && !width && !height) {
    root.innerHTML = "";
    return;
  }

  let html = `<h4 style="font-family:var(--font-secondary);color:var(--gold);margin-top:1.5rem;margin-bottom:0.5rem;font-size:1.1rem;">${ t("productDimensionsTitle") || "Dimensions & Poids" }</h4><table class="dimensions-table">`;
  if (weight)
    html += `<tr><th>${t("productWeight") || "Poids"}</th><td>${escapeHTML( String(weight) )} g</td></tr>`;
  if (length)
    html += `<tr><th>${t("productLength") || "Longueur"}</th><td>${escapeHTML( String(length) )} cm</td></tr>`;
  if (width)
    html += `<tr><th>${t("productWidth") || "Largeur"}</th><td>${escapeHTML( String(width) )} cm</td></tr>`;
  if (height)
    html += `<tr><th>${t("productHeight") || "Hauteur"}</th><td>${escapeHTML( String(height) )} cm</td></tr>`;
  html += `</table>`;
  root.innerHTML = html;
}

/* ============================================================ CARACTÉRISTIQUES ============================================================ */
function renderFeaturesSection(product) {
  const el = document.getElementById("productFeaturesEl");
  if (!el) return;

  const parentDiv = document.getElementById("productFeaturesSection");
  const features = getProductFeatures(product) || [];

  if (features.length === 0) {
    if (parentDiv) parentDiv.style.display = "none";
    el.innerHTML = "";
    return;
  }
  /* Nettoyage : les caracteristiques sont saisies dans l'admin avec un ">"
     initial (heritage d'une liste markdown). On retire ce prefixe ligne par
     ligne + trim, et on ignore les lignes devenues vides. */
  const cleanFeatures = features
    .map((f) =>
      String(f === null || f === undefined ? "" : f)
        .split(/\r?\n/)
        .map((line) => line.replace(/^>\s*/, "").trim())
        .filter((line) => line.length > 0)
        .join(" ")
    )
    .filter((f) => f.length > 0);

  if (cleanFeatures.length === 0) {
    if (parentDiv) parentDiv.style.display = "none";
    el.innerHTML = "";
    return;
  }

  if (parentDiv) parentDiv.style.display = "";
  el.innerHTML = cleanFeatures
    .map(
      (f) =>
        `<li><span class="feature-check">✓</span><span class="feature-text">${escapeHTML( f )}</span></li>`
    )
    .join("");
}

/* ============================================================ AVIS ============================================================ */
async function renderReviewsSection(product) {
  const container = document.getElementById("productReviewsRoot");
  if (!container) return;

  container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">${t( "loadingReviews" )}</div>`;

  const productId = normalizeProductId(product.id);
  if (productId == null) {
    container.innerHTML = `<p style="text-align:center;color:var(--text-muted);">${t( "noReviewsYet" )}</p>`;
    return;
  }

  try {
    const q = query(
      collection(db, "reviews"),
      where("productId", "==", productId),
      where("status", "==", "approved")
    );
    const snapshot = await getDocs(q);

    allReviewsCache = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const da = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
        const dbb = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
        return dbb - da;
      });

    const user = getCurrentUser();
    const reviewCheck = user
      ? await canUserReviewProduct(productId)
      : { canReview: false, reason: "not_logged" };

    let html = `<h3 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:1rem;font-size:1.3rem;">${t( "reviews" )} (${allReviewsCache.length})</h3>`;

    if (allReviewsCache.length > 0) {
      const avg = (
        allReviewsCache.reduce((s, r) => s + (r.rating || 0), 0) /
        allReviewsCache.length
      ).toFixed(1);
      html += ` <div style="display:flex;align-items:center;gap:0.8rem;margin-bottom:1.5rem;padding:1rem;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);"> <div style="font-size:2rem;font-weight:800;color:var(--gold);">${avg}</div> <div> <div style="color:var(--gold);font-size:1.1rem;">${renderStars( Math.round(avg) )}</div> <div style="font-size:0.8rem;color:var(--text-muted);">${ allReviewsCache.length } ${t("reviews").toLowerCase()}</div> </div> </div> `;
    }

    html += `<div id="reviewsListContainer"></div>`;

    if (reviewCheck.canReview) {
      html += renderReviewForm();
    } else if (!user) {
      html += `<p style="font-size:0.85rem;color:var(--text-muted);margin-top:1rem;text-align:center;">${t( "loginRequired" )}</p>`;
    } else if (reviewCheck.reason === "not_purchased") {
      html += `<p style="font-size:0.85rem;color:var(--text-muted);margin-top:1rem;text-align:center;">${t( "reviewOnlyAfterOrder" )}</p>`;
    } else if (reviewCheck.reason === "already_reviewed") {
      html += `<p style="font-size:0.85rem;color:var(--text-muted);margin-top:1rem;text-align:center;">${t( "reviewAlreadyExists" )}</p>`;
    } else if (reviewCheck.reason === "check_failed") {
      html += `<p style="font-size:0.85rem;color:var(--text-muted);margin-top:1rem;text-align:center;">${ t("reviewCheckUnavailable") }</p>`;
    }

    container.innerHTML = html;
    renderReviewsList();
    attachReviewEvents(product, productId);
  } catch (e) {
    console.error("Erreur chargement avis :", e);
    container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:1rem;">${t( "reviewsLoadError" )}</p>`;
  }
}

function renderReviewsList() {
  const listEl = document.getElementById("reviewsListContainer");
  if (!listEl) return;

  if (allReviewsCache.length === 0) {
    listEl.innerHTML = `<p style="color:var(--text-muted);font-size:0.9rem;text-align:center;padding:1rem;">${t( "noReviewsYet" )}</p>`;
    return;
  }

  const user = getCurrentUser();
  const reviewsToShow = showAllReviews
    ? allReviewsCache
    : allReviewsCache.slice(0, REVIEWS_LIMIT);

  let html = "";
  reviewsToShow.forEach((r) => {
    const userName = escapeHTML(r.userName || "Anonyme");
    const title = r.title
      ? `<div style="font-weight:700;font-size:0.95rem;margin-bottom:0.3rem;color:var(--text);">${escapeHTML( r.title )}</div>`
      : "";
    const comment = escapeHTML(r.comment || "");
    const photos = Array.isArray(r.photos) ? r.photos : [];
    const likes = Array.isArray(r.likes) ? r.likes : [];
    const likeCount = likes.length;
    const isLiked = user ? likes.includes(user.uid) : false;
    const dateStr = r.createdAt?.toDate
      ? r.createdAt.toDate().toLocaleDateString()
      : r.createdAt
      ? new Date(r.createdAt).toLocaleDateString()
      : "";

    html += ` <div class="review-item" style="padding: 1rem; border-bottom: 1px solid var(--border); margin-bottom: 1rem; background: var(--bg-card); border-radius: var(--radius-md);"> <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 0.5rem; flex-wrap:wrap; gap:0.5rem;"> <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;"> <div class="review-stars" style="color:var(--gold); font-size:1rem;">${renderStars( r.rating || 0 )}</div> <span style="font-size:0.85rem; color:var(--text); font-weight:600;">${userName}</span> ${ r.serverVerified === true && r.verifiedPurchase === true ? `<span style="background:var(--success-bg);color:var(--success);font-size:0.65rem;padding:0.15rem 0.5rem;border-radius:30px;display:inline-flex;align-items:center;gap:0.2rem;">${t( "reviewVerifiedPurchase" )}</span>` : "" } </div> <div style="font-size:0.75rem; color:var(--text-dim);">${dateStr}</div> </div> <div style="margin-bottom: 0.8rem;"> ${title} <div style="font-size:0.9rem; color:var(--text-muted); line-height:1.6; white-space:pre-wrap;">${comment}</div> </div> ${ photos.length > 0 ? ` <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom: 0.8rem;"> ${photos .map( (url) => ` <img src="${escapeHTML( url )}" alt="Photo avis" loading="lazy" data-photo-url="${escapeHTML( url )}" style="width:80px; height:80px; object-fit:cover; border-radius:var(--radius-sm); border:1px solid var(--border); cursor:zoom-in;"> ` ) .join("")} </div> ` : "" } <div style="display:flex; justify-content:flex-end;"> <button class="review-like-btn ${ isLiked ? "liked" : "" }" data-review-id="${escapeHTML( r.id )}" data-liked="${isLiked}" style="background:transparent; border:1px solid var(--border); color:var(--text-muted); border-radius:30px; padding:0.3rem 0.8rem; font-size:0.8rem; cursor:pointer; display:flex; align-items:center; gap:0.3rem;"> ${t("reviewHelpful")} (${likeCount}) </button> </div> </div> `;
  });

  if (allReviewsCache.length > REVIEWS_LIMIT) {
    html += ` <div style="text-align:center; margin-top:1rem;"> <button id="toggleReviewsBtn" class="btn-secondary" style="padding:0.8rem 1.5rem; font-weight:700; border-radius:30px;"> ${ showAllReviews ? `▲ ${t("reviewsShowLess") || "Voir moins d'avis"}` : `▼ ${ t("reviewsShowAll") || "Afficher tous les commentaires" } (${allReviewsCache.length})` } </button> </div> `;
  }

  listEl.innerHTML = html;

  const toggleBtn = document.getElementById("toggleReviewsBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      showAllReviews = !showAllReviews;
      renderReviewsList();
    });
  }

  listEl.querySelectorAll("img[data-photo-url]").forEach((img) => {
    img.addEventListener("click", () =>
      openImageLightbox(img.dataset.photoUrl)
    );
  });

  listEl.querySelectorAll(".review-like-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!user) {
        showToast(t("loginRequired"));
        document.dispatchEvent(new CustomEvent("open-account"));
        return;
      }
      try {
        const result = await toggleLike(btn.dataset.reviewId);
        const countMatch = btn.textContent.match(/\((\d+)\)/);
        const newCount = countMatch
          ? parseInt(countMatch[1]) + (result.liked ? 1 : -1)
          : result.liked
          ? 1
          : 0;
        btn.innerHTML = `${t("reviewHelpful")} (${Math.max(0, newCount)})`;
        btn.classList.toggle("liked", result.liked);
      } catch (e) {
        console.error(e);
      }
    });
  });
}

function renderReviewForm() {
  return ` <div class="review-form" style="margin-top:1.5rem; padding:1.2rem; background:var(--bg-surface); border:1px solid var(--border-gold); border-radius:var(--radius-md);"> <h4 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:1rem;"> ${t("leaveReview")} </h4> <div id="reviewFormMessage" style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem;"></div> <label style="display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.3rem;">${ t("reviewRating") || "Note" } *</label> <div style="display:flex; align-items:center; gap:0.8rem; margin-bottom:1rem;"> <div class="review-star-input" id="reviewStarInput" style="display:flex; gap:0.2rem; font-size:1.8rem; cursor:pointer; direction:ltr;"> <span class="star" data-star="1" role="button" tabindex="0" aria-label="1 étoile">★</span> <span class="star" data-star="2" role="button" tabindex="0" aria-label="2 étoiles">★</span> <span class="star" data-star="3" role="button" tabindex="0" aria-label="3 étoiles">★</span> <span class="star" data-star="4" role="button" tabindex="0" aria-label="4 étoiles">★</span> <span class="star" data-star="5" role="button" tabindex="0" aria-label="5 étoiles">★</span> </div> <span id="reviewStarLabel" style="font-size:1.1rem; font-weight:800; color:var(--gold);">0/5</span> </div> <label style="display:block;font-size:0.85rem;color:var(--text-muted);margin:0.5rem 0 0.3rem;">${t( "reviewTitle" )}</label> <input type="text" id="reviewTitleInput" placeholder="${t( "reviewTitle" )}" maxlength="80" style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--text);margin-bottom:0.5rem;"> <label style="display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.3rem;">${t( "reviewComment" )} *</label> <textarea id="reviewCommentInput" placeholder="${t( "reviewComment" )}" rows="3" maxlength="500" style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--text);margin-bottom:0.5rem;font-family:inherit;"></textarea> <label style="display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.3rem;">${t( "reviewPhotos" )}</label> <input type="file" id="reviewPhotoInput" accept="image/*" multiple style="margin-bottom:0.5rem;color:var(--text);"> <div id="reviewPhotoPreviews" class="review-photo-grid"></div> <button class="btn-primary" id="submitReviewBtn" style="width:100%;justify-content:center;margin-top:1rem; padding:0.8rem;"> ${t("reviewSubmit")} </button> </div> `;
}

function attachReviewEvents(product, productId) {
  const starInput = document.getElementById("reviewStarInput");
  let selectedRating = 0;
  const stars = starInput ? starInput.querySelectorAll(".star") : [];
  const starLabel = document.getElementById("reviewStarLabel");

  const applyRating = (val) => {
    selectedRating = val;
    stars.forEach((s) =>
      s.classList.toggle("active", parseInt(s.dataset.star) <= selectedRating)
    );
    if (starLabel) starLabel.textContent = `${selectedRating}/5`;
  };

  stars.forEach((star) => {
    star.addEventListener("mouseenter", () => {
      const val = parseInt(star.dataset.star);
      stars.forEach((s) =>
        s.classList.toggle("hover", parseInt(s.dataset.star) <= val)
      );
    });
    star.addEventListener("mouseleave", () => {
      stars.forEach((s) => s.classList.remove("hover"));
    });
    star.addEventListener("click", () => {
      applyRating(parseInt(star.dataset.star));
    });
    star.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        applyRating(parseInt(star.dataset.star));
      }
    });
  });

  const photoInput = document.getElementById("reviewPhotoInput");
  const photoPreviews = document.getElementById("reviewPhotoPreviews");
  let selectedPhotos = [];

  if (photoInput && photoPreviews) {
    photoInput.addEventListener("change", () => {
      const files = Array.from(photoInput.files).slice(0, 5);
      selectedPhotos = files;
      photoPreviews.innerHTML = "";
      files.forEach((file) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const div = document.createElement("div");
          div.className = "review-photo-slot";
          div.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
          photoPreviews.appendChild(div);
        };
        reader.readAsDataURL(file);
      });
    });
  }

  const submitBtn = document.getElementById("submitReviewBtn");
  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      const titleInput = document.getElementById("reviewTitleInput");
      const commentInput = document.getElementById("reviewCommentInput");
      const msgEl = document.getElementById("reviewFormMessage");

      const title = titleInput?.value.trim() || "";
      const comment = commentInput?.value.trim() || "";

      if (selectedRating < 1) {
        if (msgEl) {
          msgEl.textContent =
            t("reviewRatingRequired") || "Veuillez sélectionner une note";
          msgEl.style.color = "var(--danger)";
        }
        return;
      }
      if (!comment) {
        if (msgEl) {
          msgEl.textContent = t("reviewComment");
          msgEl.style.color = "var(--danger)";
        }
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = t("loading");
      if (msgEl) msgEl.textContent = "";

      try {
        await createReview(productId, {
          rating: selectedRating,
          title,
          comment,
          photoFiles: selectedPhotos,
        });
        if (msgEl) {
          msgEl.textContent =
            t("reviewThanks") + " " + t("reviewPendingApproval");
          msgEl.style.color = "var(--success)";
        }
        showToast(t("reviewThanks"));

        if (commentInput) commentInput.value = "";
        if (titleInput) titleInput.value = "";
        selectedRating = 0;
        if (starLabel) starLabel.textContent = "0/5";
        stars.forEach((s) => s.classList.remove("active"));
        if (photoPreviews) photoPreviews.innerHTML = "";
        selectedPhotos = [];
      } catch (e) {
        console.error("Erreur envoi avis :", e);
        if (msgEl) {
          msgEl.textContent = e.message || t("error");
          msgEl.style.color = "var(--danger)";
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = t("reviewSubmit");
      }
    });
  }
}

/* ============================================================ PRODUITS SIMILAIRES ============================================================ */
let _relatedProductsCache = null;
let _relatedForProductId = null;

function renderRelatedProducts(product) {
  const container = document.getElementById("relatedProductsRoot");
  if (!container) return;

  const currentPid = normalizeProductId(product.id);

  if (_relatedForProductId !== currentPid) {
    const all = getProducts();
    const sameCategory = all.filter(
      (p) =>
        normalizeProductId(p.id) !== currentPid &&
        p.category === product.category
    );
    const others = all.filter(
      (p) =>
        normalizeProductId(p.id) !== currentPid &&
        p.category !== product.category
    );

    const shuffle = (arr) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    _relatedProductsCache = [
      ...shuffle(sameCategory),
      ...shuffle(others),
    ].slice(0, 6);
    _relatedForProductId = currentPid;
  }

  if (
    !Array.isArray(_relatedProductsCache) ||
    _relatedProductsCache.length === 0
  ) {
    container.innerHTML = "";
    return;
  }

  const user = getCurrentUser();
  const favs = Array.isArray(user?.favorites)
    ? user.favorites.map(normalizeProductId).filter((f) => f != null)
    : [];

  let html = `<h4 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:1rem;font-size:1.2rem;">${t( "productRelatedTitle" )}</h4>`;
  html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem;">`;

  _relatedProductsCache.forEach((p) => {
    const pid = normalizeProductId(p.id);
    if (pid == null) return;
    const isFav = favs.includes(pid);
    const name = escapeHTML(getProductName(p));
    const img = getProductImageUrl(p);
    const price = p.price;
    const oldPrice = p.oldPrice;

    const safeImg = escapeHTML(img);
    const safeFallback = getFallbackImage(name).replace(/'/g, "%27");

    const isVendor = p.vendorId && p.vendorId !== "smartswi9a";
    const vendorBadge = isVendor
      ? `<div style="font-size:0.65rem;color:#6b46c1;font-weight:700;margin-top:0.2rem;">🏪 ${escapeHTML( p.vendorName || "Boutique" )}</div>`
      : `<div style="font-size:0.65rem;color:var(--gold);font-weight:700;margin-top:0.2rem;">${ t("vendorSmartSwi9a") || "Smartswika" }</div>`;

    html += ` <div class="product-card" data-id="${escapeHTML( String(pid) )}" data-slug="${escapeHTML(p.slug || "")}" style="cursor:pointer;"> <div class="product-img"> <img src="${safeImg}" alt="${name}" width="400" height="400" loading="lazy" onerror="this.onerror=null; this.src='${safeFallback}'"> <button class="favorite-btn ${ isFav ? "is-fav" : "" }" data-id="${escapeHTML(String(pid))}">${ isFav ? "❤️" : "🤍" }</button> </div> <div class="product-body" style="padding:0.8rem;"> <div class="p-name" style="font-size:0.85rem;">${name}</div> ${vendorBadge} <div class="p-price" style="font-size:0.95rem;margin-top:0.3rem;"> ${price} ${t("currency")} ${ oldPrice ? `<small>${oldPrice} ${t("currency")}</small>` : "" } </div> </div> </div> `;
  });

  html += `</div>`;
  container.innerHTML = html;

  container.querySelectorAll(".product-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".favorite-btn")) return;
      const slug = card.dataset.slug;
      if (slug)
        window.location.href = `/produit?slug=${encodeURIComponent(slug)}`;
    });
    const favBtn = card.querySelector(".favorite-btn");
    if (favBtn) {
      favBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(normalizeProductId(favBtn.dataset.id));
      });
    }
  });
}

/* ============================================================ ÉVÉNEMENTS PRINCIPAUX ============================================================ */
function attachProductEvents(product) {
  const addBtn = document.getElementById("addToCartBtn");
  if (addBtn && !addBtn._listenerAttached) {
    addBtn._listenerAttached = true;
    addBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!currentProduct) return;

      if (currentProduct.variants && currentProduct.variants.length > 0) {
        if (!selectedSize && currentProduct.variants.some((v) => v.size)) {
          showToast("Veuillez choisir une taille");
          return;
        }
        if (!selectedColor && currentProduct.variants.some((v) => v.color)) {
          showToast("Veuillez choisir une couleur");
          return;
        }
        if (!currentVariant) {
          showToast("Cette combinaison est introuvable");
          return;
        }
        if (currentVariant.stock <= 0) {
          showToast(t("outOfStock"));
          return;
        }
        import("./cart.js").then((m) =>
          m.addToCart(currentProduct.id, currentVariant)
        );
      } else {
        import("./cart.js").then((m) => m.addToCart(currentProduct.id));
      }
    });
  }

  const waBtn = document.getElementById("whatsappOrderBtn");
  if (waBtn) {
    waBtn.dataset.productId = String(product.id);
  }

  console.log("Page produit prête :", product.slug);
}

/* ============================================================ MODALE GUIDE DES TAILLES ============================================================ NOTE : le tableau est statique (S/M/L/XL/XXL). Si les tailles doivent être dynamiques par produit, il faudra un nouveau champ Firestore et une refonte (hors scope). ============================================================ */
function openSizeGuideModal() {
  document.getElementById("sizeGuideModal")?.remove();

  const modalHtml = ` <div class="modal-overlay open" id="sizeGuideModal" style="z-index:2000;"> <div class="modal" style="max-width:600px;"> <button class="modal-close" id="closeSizeGuideBtn" aria-label="Fermer">✕</button> <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:1rem;">${ t("sizeGuideTitle") || "Guide des tailles" }</h2> <div style="background:var(--bg-surface);padding:1rem;border-radius:var(--radius-sm);margin-bottom:1rem;"> <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem;text-align:center;"> ${ t("sizeGuideHint") || "Ce guide est basé sur des mesures standard. Si vous êtes entre deux tailles, nous vous conseillons de choisir la taille supérieure." } </p> <div style="display:flex; justify-content:center; gap:1rem; margin-bottom:1rem;"> <button class="variant-btn active" id="tabUS">US</button> <button class="variant-btn" id="tabEU">EU</button> </div> <table class="acc-table" id="sizeGuideTable"> <thead> <tr> <th>${t("sizeGuideSize") || "Taille"}</th> <th id="col1Header">${ t("sizeGuideUS") || "US" }</th> <th>${t("sizeGuideBust") || "Buste (cm)"}</th> <th>${t("sizeGuideWaist") || "Taille (cm)"}</th> <th>${ t("sizeGuideLength") || "Longueur (cm)" }</th> </tr> </thead> <tbody id="sizeGuideBody"></tbody> </table> </div> <div style="font-size:0.8rem;color:var(--text-muted);line-height:1.6;"> <strong style="color:var(--text);">${ t("sizeGuideHowTitle") || "Comment prendre vos mesures ?" }</strong><br> • <strong>${t("sizeGuideBust") || "Buste"} :</strong> ${ t("sizeGuideBustHelp") || "Mesurez horizontalement autour de la partie la plus forte de la poitrine." }<br> • <strong>${t("sizeGuideWaist") || "Taille"} :</strong> ${ t("sizeGuideWaistHelp") || "Mesurez autour de la partie la plus fine de votre taille." }<br> • <strong>${ t("sizeGuideLength") || "Longueur" } :</strong> ${ t("sizeGuideLengthHelp") || "Du point le plus haut de l'épaule jusqu'au bas du vêtement." } </div> </div> </div> `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);
  const modal = document.getElementById("sizeGuideModal");
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const closeModal = () => {
    modal?.remove();
    document.body.style.overflow = previousOverflow;
    document.removeEventListener("keydown", escHandler);
  };

  const escHandler = (e) => {
    if (e.key === "Escape") closeModal();
  };
  document.addEventListener("keydown", escHandler);

  document
    .getElementById("closeSizeGuideBtn")
    ?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  const tableBody = document.getElementById("sizeGuideBody");
  const col1Header = document.getElementById("col1Header");
  const tabUS = document.getElementById("tabUS");
  const tabEU = document.getElementById("tabEU");
  if (!tableBody || !col1Header || !tabUS || !tabEU) return;

  const sizeData = [
    {
      size: "S",
      us: "36",
      eu: "46",
      buste: "88-92",
      taille: "72-76",
      longueur: "68",
    },
    {
      size: "M",
      us: "38",
      eu: "48",
      buste: "92-96",
      taille: "76-80",
      longueur: "70",
    },
    {
      size: "L",
      us: "40",
      eu: "50",
      buste: "96-100",
      taille: "80-84",
      longueur: "72",
    },
    {
      size: "XL",
      us: "42",
      eu: "52",
      buste: "100-104",
      taille: "84-88",
      longueur: "74",
    },
    {
      size: "XXL",
      us: "44",
      eu: "54",
      buste: "104-108",
      taille: "88-92",
      longueur: "76",
    },
  ];

  const renderTable = (standard) => {
    col1Header.textContent = standard === "us" ? "US" : "EU";
    let rows = "";
    sizeData.forEach((row) => {
      rows += `<tr> <td style="font-weight:700;">${row.size}</td> <td>${row[standard]}</td> <td>${row.buste}</td> <td>${row.taille}</td> <td>${row.longueur}</td> </tr>`;
    });
    tableBody.innerHTML = rows;
    tabUS.classList.toggle("active", standard === "us");
    tabEU.classList.toggle("active", standard === "eu");
  };

  tabUS.addEventListener("click", () => renderTable("us"));
  tabEU.addEventListener("click", () => renderTable("eu"));
  renderTable("us");
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ product-detail.js chargé - v9.0.0 (Lot 20 : gallery dedup + image fallback + prix guard)"
);