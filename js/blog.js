/* ============================================================ js/blog.js BLOG CÔTÉ CLIENT - SMARTSWIKA Version 9.0.0 - Lot 17/30 : double debounce + image fallback CHANGEMENTS v9.0.0 : - B-BLOG-1 (P1) : searchBlog() ne debounce plus en interne. events.js gère déjà 300ms pour 'blog:search'. Total 600ms avant -> 300ms maintenant. - B-BLOG-2 (P2) : images articles (cards + hero modale) ont un `onerror` qui bascule sur getFallbackImage() (SVG). Plus d'icône "image cassée" du navigateur. - B-BLOG-3 (P3) : import truncate retiré (inutilisé). - B-BLOG-4 (P3) : renderBlogPagination silencieux si blogGrid.parentNode est null. Évite le layout cassé. - B-BLOG-5 (P3) : initBlogPage avec guard _initInProgress. - B-BLOG-6 (P3) : post.id null-safe dans le choix de gradient. - JSDoc sur les exports publics. - Bump version 2.0.0 -> 9.0.0. LIMITATION CONNUE : loadBlogPosts() utilise limit(50) sans orderBy (index-free). Le blog est donc limité à 50 articles les plus récents. Si le blog dépasse 50 articles, passer à orderBy + pagination (nécessitera un index Firestore composite - voir Lot 48). ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import { collection, query, where, getDocs, limit } from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG } from "./config.js";
import {
  t,
  escapeHTML,
  formatDate,
  toDate,
  estimateReadTime,
  getFallbackImage,
} from "./utils.js";
import {
  getBlogPosts,
  setBlogPosts,
  getBlogFilters,
  setBlogFilters,
  getBlogPagination,
  setBlogPagination,
  setBlogLoadedPromise,
} from "./store.js";
import { showToast, openImageLightbox } from "./ui-core.js";

/* ============================================================ CONSTANTES ============================================================ */
const POSTS_PER_PAGE = CONFIG.BLOG.PER_PAGE || 6;

/* B-BLOG-1 : SEARCH_DEBOUNCE_MS supprimé. events.js gère 300ms. */
const SEARCH_DEBOUNCE_MS = 300;

/* B-BLOG-5 : guard concurrent. */
let _initInProgress = false;

/* I16.1 (conservé) : ESC handler unique pour éviter les fuites. */
let _currentEscHandler = null;

/* ============================================================ HELPERS i18n - Catégories blog + Read time ============================================================ */
const CAT_KEY_MAP = {
  conseils: "blogCatConseils",
  tendances: "blogCatTendances",
  tests: "blogCatTests",
  tutoriels: "blogCatTutoriels",
  "smart-home": "blogCatSmartHome",
  gadgets: "blogCatGadgets",
  actualites: "blogCatActualites",
  general: "blogCatGeneral",
};

function tCategory(catId) {
  return t(CAT_KEY_MAP[catId] || "blogCatGeneral");
}

function tReadTime(min) {
  return t("blogReadTime").replace("{min}", min);
}

/* ============================================================ VALIDATION IMAGES (whitelist) ============================================================ Accepte : - http://... / https://... - /chemin/relatif/... Refuse : - data: (base64, vecteur XSS) - javascript: (XSS) - //evil.com (protocol-relative) - "" / null / undefined ============================================================ */
function isValidImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("//")) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (trimmed.startsWith("/")) return true;
  return false;
}

/* ============================================================ TRUNCATE au mot le plus proche ============================================================ */
function truncateWords(text, maxLength = 150) {
  if (!text) return "";
  const str = String(text).trim();
  if (str.length <= maxLength) return str;
  const cut = str.substring(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return (
    (lastSpace > maxLength * 0.7 ? cut.substring(0, lastSpace) : cut) + "…"
  );
}

/* ============================================================ CHARGEMENT DES ARTICLES (sans orderBy, tri client) ============================================================ Sans index composite, orderBy + where échoue. On charge limit(50) puis on trie côté client. ============================================================ */

/** * Charge les articles publiés (limit 50, tri par date côté client). * @returns {Promise<Array>} */
export async function loadBlogPosts() {
  try {
    console.log("Chargement des articles de blog...");

    const q = query(
      collection(db, "blog"),
      where("status", "==", "published"),
      limit(50)
    );

    const snapshot = await getDocs(q);
    const posts = snapshot.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        publishedAt: toDate(data.publishedAt) || toDate(data.createdAt),
        createdAt: toDate(data.createdAt),
        updatedAt: toDate(data.updatedAt),
      };
    });

    posts.sort((a, b) => {
      const da = a.publishedAt?.getTime?.() || 0;
      const dbb = b.publishedAt?.getTime?.() || 0;
      return dbb - da;
    });

    console.log(`${posts.length} articles chargés`);
    setBlogPosts(posts);
    return posts;
  } catch (e) {
    console.error("Erreur chargement blog :", e);
    setBlogPosts([]);
    return [];
  }
}

/* ============================================================ FILTRAGE ============================================================ */

/** * Retourne la liste filtrée des articles selon les filtres actifs * (catégorie + recherche). * @returns {Array} */
export function getFilteredPosts() {
  const posts = getBlogPosts();
  const filters = getBlogFilters();
  let list = [...posts];

  if (filters.category && filters.category !== "all") {
    list = list.filter((p) => p.category === filters.category);
  }

  if (filters.search && filters.search.trim()) {
    const q = filters.search.toLowerCase().trim();
    list = list.filter((p) => {
      const title = (p.title || "").toLowerCase();
      const excerpt = (p.excerpt || "").toLowerCase();
      const content = (p.content || "").toLowerCase();
      return title.includes(q) || excerpt.includes(q) || content.includes(q);
    });
  }

  return list;
}

/* ============================================================ RENDU DE LA LISTE ============================================================ */

/** * Re-render la liste des articles avec filtres + pagination. * @returns {Promise<void>} */
export async function renderBlogList() {
  const grid = document.getElementById("blogGrid");
  if (!grid) return;

  grid.innerHTML = `<div class="blog-loading">${ t("blogLoading") || "Chargement..." }</div>`;

  let posts = getBlogPosts();
  if (!posts || posts.length === 0) {
    posts = await loadBlogPosts();
  }

  renderBlogFilters();

  const filtered = getFilteredPosts();
  const total = filtered.length;

  if (total === 0) {
    grid.innerHTML = ` <div class="blog-empty"> <div style="font-size:3rem;margin-bottom:1rem;">📝</div> <p>${t("blogNoArticles") || "Aucun article pour le moment"}</p> </div> `;
    return;
  }

  const pagination = getBlogPagination();
  const totalPages = Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
  let currentPage = pagination.currentPage;
  if (currentPage > totalPages) currentPage = 1;
  setBlogPagination({ currentPage, totalPages });

  const start = (currentPage - 1) * POSTS_PER_PAGE;
  const pagePosts = filtered.slice(start, start + POSTS_PER_PAGE);

  let html = "";
  pagePosts.forEach((post, index) => {
    html += renderBlogCard(post, index);
  });
  grid.innerHTML = html;

  renderBlogPagination(totalPages, currentPage);

  grid.querySelectorAll(".blog-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const postId = card.dataset.id;
      if (postId) openBlogArticle(postId);
    });
  });
}

/* ============================================================ CARTE ARTICLE ============================================================ */
function renderBlogCard(post, index) {
  const title = escapeHTML(post.title || "Sans titre");
  const excerpt = escapeHTML(
    truncateWords(post.excerpt || post.content || "", 130)
  );
  const categoryLabel = escapeHTML(tCategory(post.category || "general"));
  const date = formatDate(post.publishedAt || post.createdAt) || "";
  const readTime = estimateReadTime(post.content || "");

  const hasImg = isValidImageUrl(post.image);
  const gradientClass = `blog-img-bg-${(index % 6) + 1}`;

  const catEmojiMap = {
    conseils: "💡",
    tendances: "🔥",
    tests: "🧪",
    tutoriels: "📖",
    "smart-home": "🏠",
    gadgets: "📱",
    actualites: "📰",
  };
  const catEmoji = catEmojiMap[post.category] || "📝";

  /* B-BLOG-2 : onerror -> bascule sur le SVG fallback. */
  let imgHtml;
  if (hasImg) {
    const fallback = getFallbackImage(post.title || "Article");
    imgHtml = `<img src="${escapeHTML( post.image )}" alt="${title}" loading="lazy" onerror="this.onerror=null;this.src='${fallback}';this.style.objectFit='contain';">`;
  } else {
    imgHtml = `<span style="font-size:3rem;">${catEmoji}</span>`;
  }

  return ` <article class="blog-card" data-id="${escapeHTML( post.id )}" style="cursor:pointer;"> <div class="blog-img ${hasImg ? "" : gradientClass}"> ${imgHtml} </div> <div class="blog-body"> <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.5rem;"> <span class="blog-category-tag">${catEmoji} ${categoryLabel}</span> </div> <div class="blog-date">${date} - ${tReadTime(readTime)}</div> <h2 class="blog-title">${title}</h2> <p class="blog-excerpt">${excerpt}</p> <span class="blog-read-more">${ t("blogReadMore") || "Lire la suite" } →</span> </div> </article> `;
}

/* ============================================================ FILTRES CATÉGORIES ============================================================ */

/** * Re-render la barre de filtres (catégories + counts). * @returns {void} */
export function renderBlogFilters() {
  const container = document.getElementById("blogFilters");
  if (!container) return;

  const filters = getBlogFilters();
  const posts = getBlogPosts();
  const categories = CONFIG.BLOG.CATEGORIES || [];

  const counts = { all: posts.length };
  posts.forEach((p) => {
    if (p.category) {
      counts[p.category] = (counts[p.category] || 0) + 1;
    }
  });

  let html = "";
  categories.forEach((cat) => {
    const count = cat.id === "all" ? counts.all : counts[cat.id] || 0;
    if (cat.id !== "all" && count === 0) return;
    const isActive = filters.category === cat.id;
    const label = cat.id === "all" ? t("filterAll") : tCategory(cat.id);
    html += ` <button class="filter-btn ${ isActive ? "active" : "" }" data-blog-category="${cat.id}"> ${cat.emoji || ""} ${escapeHTML(label)} (${count}) </button> `;
  });
  container.innerHTML = html;

  container.querySelectorAll("[data-blog-category]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.blogCategory;
      filterBlogByCategory(cat);
    });
  });
}

/* ============================================================ FILTRER PAR CATÉGORIE ============================================================ */

/** * Change la catégorie active et re-render. * @param {string} category */
export function filterBlogByCategory(category) {
  setBlogFilters({ category });
  setBlogPagination({ currentPage: 1 });
  renderBlogList();
}

/* ============================================================ RECHERCHE (B-BLOG-1 : pas de debounce interne) ============================================================ events.js gère déjà 300ms pour 'blog:search'. Ce module update le state + render immédiatement. Si appelé directement (sans events.js), le caller doit gérer son propre debounce. ============================================================ */

/** * Recherche les articles (met à jour le state + render). * @param {string} query */
export function searchBlog(query) {
  setBlogFilters({ search: query });
  setBlogPagination({ currentPage: 1 });
  renderBlogList();
}

/* ============================================================ PAGINATION ============================================================ */
function renderBlogPagination(totalPages, currentPage) {
  const existing = document.getElementById("blogPagination");
  if (existing) existing.remove();

  if (totalPages <= 1) return;

  const container = document.getElementById("blogGrid");
  if (!container) return;

  /* B-BLOG-4 : guard. Si pas de parentNode, skip silencieux (sinon la pagination s'insère DANS la grille display:grid et casse le layout). */
  const parent = container.parentNode;
  if (!parent) {
    console.warn(
      "renderBlogPagination : blogGrid sans parentNode, pagination ignorée"
    );
    return;
  }

  const pag = document.createElement("div");
  pag.id = "blogPagination";
  pag.className = "pagination-container";
  pag.style.gridColumn = "1 / -1";

  let html = `<button class="pagination-btn ${ currentPage === 1 ? "disabled" : "" }" data-blog-page="${currentPage - 1}">‹</button>`;
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="pagination-btn ${ i === currentPage ? "active" : "" }" data-blog-page="${i}">${i}</button>`;
  }
  html += `<button class="pagination-btn ${ currentPage === totalPages ? "disabled" : "" }" data-blog-page="${currentPage + 1}">›</button>`;
  pag.innerHTML = html;

  parent.insertBefore(pag, container.nextSibling);

  pag.querySelectorAll("[data-blog-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = parseInt(btn.dataset.blogPage);
      if (isNaN(page) || page < 1 || page > totalPages) return;
      setBlogPagination({ currentPage: page });
      renderBlogList();
      document
        .getElementById("blogGrid")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

/* ============================================================ OUVRIR UN ARTICLE (modale) ============================================================ */

/** * Ouvre la modale de lecture d'un article. * @param {string} postId */
export function openBlogArticle(postId) {
  const post = getBlogPosts().find((p) => p.id === postId);
  if (!post) {
    showToast(t("articleNotFound"));
    return;
  }

  const modal = document.getElementById("blogArticleModal");
  const content = document.getElementById("blogArticleContent");
  if (!modal || !content) return;

  const title = escapeHTML(post.title || "Sans titre");
  const categoryLabel = escapeHTML(tCategory(post.category || "general"));
  const date = formatDate(post.publishedAt || post.createdAt) || "";
  const author = escapeHTML(post.author || "Smartswika");
  const readTime = estimateReadTime(post.content || "");

  const catEmojiMap = {
    conseils: "💡",
    tendances: "🔥",
    tests: "🧪",
    tutoriels: "📖",
    "smart-home": "🏠",
    gadgets: "📱",
    actualites: "📰",
  };
  const catEmoji = catEmojiMap[post.category] || "📝";

  const hasImg = isValidImageUrl(post.image);
  /* B-BLOG-2 + B-BLOG-6 : onerror + gradient null-safe. */
  const bgIdx = post.id ? (post.id.length % 6) + 1 : 1;
  let heroHtml;
  if (hasImg) {
    const fallback = getFallbackImage(post.title || "Article");
    heroHtml = `<img src="${escapeHTML( post.image )}" alt="${title}" class="blog-article-hero" data-photo-url="${escapeHTML( post.image )}" style="cursor:zoom-in;" onerror="this.onerror=null;this.src='${fallback}';this.style.objectFit='contain';this.style.cursor='default';this.removeAttribute('data-photo-url');">`;
  } else {
    heroHtml = `<div class="blog-article-hero blog-img-bg-${bgIdx}" style="display:flex;align-items:center;justify-content:center;font-size:5rem;">${catEmoji}</div>`;
  }

  content.innerHTML = ` <button class="blog-article-close" id="closeBlogArticleBtn" aria-label="${t( "close" )}">✕</button> ${heroHtml} <div class="blog-article-body"> <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.8rem;"> <span class="blog-category-tag">${catEmoji} ${categoryLabel}</span> <span style="font-size:0.75rem;color:var(--text-dim);align-self:center;"> ${date} - ${tReadTime(readTime)} - ${author} </span> </div> <h2 class="blog-article-title">${title}</h2> <div class="blog-article-text">${escapeHTML( post.content || "" )}</div> </div> `;

  modal.classList.add("open");
  document.body.style.overflow = "hidden";
  modal.scrollTop = 0;

  document
    .getElementById("closeBlogArticleBtn")
    .addEventListener("click", closeBlogArticle);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeBlogArticle();
  });

  /* I16.1 : cleanup AVANT d'attacher le nouveau. */
  if (_currentEscHandler) {
    document.removeEventListener("keydown", _currentEscHandler);
    _currentEscHandler = null;
  }
  _currentEscHandler = (e) => {
    if (e.key === "Escape") closeBlogArticle();
  };
  document.addEventListener("keydown", _currentEscHandler);

  const heroImg = content.querySelector("[data-photo-url]");
  if (heroImg) {
    heroImg.addEventListener("click", () => {
      openImageLightbox(heroImg.dataset.photoUrl);
    });
  }
}

/* ============================================================ FERMER L'ARTICLE (cleanup ESC) ============================================================ */

/** * Ferme la modale article et libère les listeners. */
export function closeBlogArticle() {
  const modal = document.getElementById("blogArticleModal");
  if (!modal) return;
  modal.classList.remove("open");
  document.body.style.overflow = "";

  if (_currentEscHandler) {
    document.removeEventListener("keydown", _currentEscHandler);
    _currentEscHandler = null;
  }
}

/* ============================================================ INITIALISATION GLOBALE DU BLOG ============================================================ */

/** * Point d'entrée : charge les posts puis render. Guard concurrent. * @returns {Promise<void>} */
export async function initBlogPage() {
  /* B-BLOG-5 : guard concurrent. */
  if (_initInProgress) {
    console.log("initBlogPage déjà en cours - skip");
    return;
  }

  _initInProgress = true;
  try {
    console.log("Initialisation de la page blog...");

    const promise = loadBlogPosts();
    setBlogLoadedPromise(promise);
    await promise;

    await renderBlogList();
  } finally {
    _initInProgress = false;
  }
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ blog.js chargé - v9.0.0 (Lot 17 : double debounce fixé + image fallback)"
);