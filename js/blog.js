// js/blog.js
// ============================================================
// BLOG CÔTÉ CLIENT - SMART SWI9A
// Version 2.0.0 — Perf (index-free) + UX + sécurité images
// ============================================================
// CHANGEMENTS v2.0.0 :
// ✅ C16.1 — Retiré orderBy (pas d'index requis), tri côté client
// ✅ I16.1 — Fuite listener ESC (module-level _currentEscHandler)
// ✅ I16.2 — renderBlogPagination guard parentNode
// ✅ I16.3 — Validation images (whitelist http/https/relative)
// ✅ I16.4 — Debounce interne dans searchBlog
// ✅ M16.1-5 — Divers (truncate, overflow, imports cleanup)
// ============================================================
// Dépend de : config, utils, store, firebase, ui-core
// ============================================================

import {
    collection, query, where, getDocs, limit
} from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG } from "./config.js";
import {
    t, escapeHTML, formatDate, toDate, estimateReadTime, truncate
} from "./utils.js";
import {
    getBlogPosts, setBlogPosts, getBlogFilters, setBlogFilters,
    getBlogPagination, setBlogPagination, setBlogLoadedPromise
} from "./store.js";
import { showToast, openImageLightbox } from "./ui-core.js";

// ============================================================
// CONSTANTES
// ============================================================
const POSTS_PER_PAGE = CONFIG.BLOG.PER_PAGE || 6;

// ✅ I16.4 : debounce interne (self-contained)
let _searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 300;

// ✅ I16.1 : ESC handler unique (fix fuite)
let _currentEscHandler = null;

// ============================================================
// HELPERS i18n — Catégories blog + Read time
// ============================================================
const CAT_KEY_MAP = {
    conseils: 'blogCatConseils',
    tendances: 'blogCatTendances',
    tests: 'blogCatTests',
    tutoriels: 'blogCatTutoriels',
    'smart-home': 'blogCatSmartHome',
    gadgets: 'blogCatGadgets',
    actualites: 'blogCatActualites',
    general: 'blogCatGeneral'
};

function tCategory(catId) {
    return t(CAT_KEY_MAP[catId] || 'blogCatGeneral');
}

function tReadTime(min) {
    return t('blogReadTime').replace('{min}', min);
}

// ============================================================
// ✅ I16.3 : VALIDATION IMAGES (whitelist)
// ------------------------------------------------------------
// Accepte :
//   - http://...  /  https://...
//   - /chemin/relatif/...
// Refuse :
//   - data: (base64, vecteur XSS)
//   - javascript: (XSS)
//   - //evil.com (protocol-relative)
//   - "" / null / undefined
// ============================================================
function isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('//')) return false;         // protocol-relative
    if (/^https?:\/\//i.test(trimmed)) return true;     // absolute
    if (trimmed.startsWith('/')) return true;           // absolute path
    return false;
}

// ============================================================
// ✅ M16.2 : TRUNCATE au mot le plus proche
// ============================================================
function truncateWords(text, maxLength = 150) {
    if (!text) return '';
    const str = String(text).trim();
    if (str.length <= maxLength) return str;
    const cut = str.substring(0, maxLength);
    const lastSpace = cut.lastIndexOf(' ');
    // Si le dernier espace est trop loin du début → couper brutalement
    return (lastSpace > maxLength * 0.7
        ? cut.substring(0, lastSpace)
        : cut) + '…';
}

// ============================================================
// ✅ C16.1 : CHARGEMENT DES ARTICLES (sans orderBy, tri client)
// ------------------------------------------------------------
// Sans index composite, orderBy + where échoue.
// On charge limit(50) puis on trie côté client.
// ============================================================
export async function loadBlogPosts() {
    try {
        console.log('⏳ Chargement des articles de blog...');

        // ✅ C16.1 : PAS d'orderBy → pas d'index composite requis
        const q = query(
            collection(db, "blog"),
            where("status", "==", "published"),
            limit(50)
        );

        const snapshot = await getDocs(q);
        const posts = snapshot.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                publishedAt: toDate(data.publishedAt) || toDate(data.createdAt),
                createdAt: toDate(data.createdAt),
                updatedAt: toDate(data.updatedAt)
            };
        });

        // ✅ C16.1 : tri côté client (plus récent d'abord)
        posts.sort((a, b) => {
            const da = a.publishedAt?.getTime?.() || 0;
            const dbb = b.publishedAt?.getTime?.() || 0;
            return dbb - da;
        });

        console.log(`✅ ${posts.length} articles chargés`);
        setBlogPosts(posts);
        return posts;

    } catch (e) {
        console.error('❌ Erreur chargement blog :', e);
        setBlogPosts([]);
        return [];
    }
}

// ============================================================
// FILTRAGE
// ============================================================
export function getFilteredPosts() {
    const posts = getBlogPosts();
    const filters = getBlogFilters();
    let list = [...posts];

    if (filters.category && filters.category !== 'all') {
        list = list.filter(p => p.category === filters.category);
    }

    if (filters.search && filters.search.trim()) {
        const q = filters.search.toLowerCase().trim();
        list = list.filter(p => {
            const title = (p.title || '').toLowerCase();
            const excerpt = (p.excerpt || '').toLowerCase();
            const content = (p.content || '').toLowerCase();
            return title.includes(q) || excerpt.includes(q) || content.includes(q);
        });
    }

    return list;
}

// ============================================================
// RENDU DE LA LISTE
// ============================================================
export async function renderBlogList() {
    const grid = document.getElementById('blogGrid');
    if (!grid) return;

    grid.innerHTML = `<div class="blog-loading">⏳ ${t('blogLoading') || 'Chargement...'}</div>`;

    let posts = getBlogPosts();
    if (!posts || posts.length === 0) {
        posts = await loadBlogPosts();
    }

    renderBlogFilters();

    const filtered = getFilteredPosts();
    const total = filtered.length;

    if (total === 0) {
        grid.innerHTML = `
            <div class="blog-empty">
                <div style="font-size:3rem;margin-bottom:1rem;">📝</div>
                <p>${t('blogNoArticles') || 'Aucun article pour le moment'}</p>
            </div>
        `;
        return;
    }

    const pagination = getBlogPagination();
    const totalPages = Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
    let currentPage = pagination.currentPage;
    if (currentPage > totalPages) currentPage = 1;
    setBlogPagination({ currentPage, totalPages });

    const start = (currentPage - 1) * POSTS_PER_PAGE;
    const pagePosts = filtered.slice(start, start + POSTS_PER_PAGE);

    let html = '';
    pagePosts.forEach((post, index) => {
        html += renderBlogCard(post, index);
    });
    grid.innerHTML = html;

    renderBlogPagination(totalPages, currentPage);

    grid.querySelectorAll('.blog-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            const postId = card.dataset.id;
            if (postId) openBlogArticle(postId);
        });
    });
}

// ============================================================
// ✅ CARTE ARTICLE (validation image I16.3)
// ============================================================
function renderBlogCard(post, index) {
    const title = escapeHTML(post.title || 'Sans titre');
    const excerpt = escapeHTML(truncateWords(post.excerpt || post.content || '', 130));
    const categoryLabel = escapeHTML(tCategory(post.category || 'general'));
    const date = formatDate(post.publishedAt || post.createdAt) || '';
    const readTime = estimateReadTime(post.content || '');

    // ✅ I16.3 : validation URL
    const hasImg = isValidImageUrl(post.image);

    const gradientClass = `blog-img-bg-${(index % 6) + 1}`;

    const catEmojiMap = {
        conseils: '💡', tendances: '🔥', tests: '🧪',
        tutoriels: '📖', 'smart-home': '🏠', gadgets: '📱', actualites: '📰'
    };
    const catEmoji = catEmojiMap[post.category] || '📝';

    const imgHtml = hasImg
        ? `<img src="${escapeHTML(post.image)}" alt="${title}" loading="lazy">`
        : `<span style="font-size:3rem;">${catEmoji}</span>`;

    return `
        <article class="blog-card" data-id="${escapeHTML(post.id)}" style="cursor:pointer;">
            <div class="blog-img ${hasImg ? '' : gradientClass}">
                ${imgHtml}
            </div>
            <div class="blog-body">
                <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.5rem;">
                    <span class="blog-category-tag">${catEmoji} ${categoryLabel}</span>
                </div>
                <div class="blog-date">📅 ${date} · ⏱️ ${tReadTime(readTime)}</div>
                <h2 class="blog-title">${title}</h2>
                <p class="blog-excerpt">${excerpt}</p>
                <span class="blog-read-more">${t('blogReadMore') || 'Lire la suite'} →</span>
            </div>
        </article>
    `;
}

// ============================================================
// FILTRES CATÉGORIES
// ============================================================
export function renderBlogFilters() {
    const container = document.getElementById('blogFilters');
    if (!container) return;

    const filters = getBlogFilters();
    const posts = getBlogPosts();
    const categories = CONFIG.BLOG.CATEGORIES || [];

    const counts = { all: posts.length };
    posts.forEach(p => {
        if (p.category) {
            counts[p.category] = (counts[p.category] || 0) + 1;
        }
    });

    let html = '';
    categories.forEach(cat => {
        const count = cat.id === 'all' ? counts.all : (counts[cat.id] || 0);
        if (cat.id !== 'all' && count === 0) return;
        const isActive = filters.category === cat.id;
        const label = cat.id === 'all' ? t('filterAll') : tCategory(cat.id);
        html += `
            <button class="filter-btn ${isActive ? 'active' : ''}" data-blog-category="${cat.id}">
                ${cat.emoji || ''} ${escapeHTML(label)} (${count})
            </button>
        `;
    });
    container.innerHTML = html;

    container.querySelectorAll('[data-blog-category]').forEach(btn => {
        btn.addEventListener('click', () => {
            const cat = btn.dataset.blogCategory;
            filterBlogByCategory(cat);
        });
    });
}

// ============================================================
// FILTRER PAR CATÉGORIE
// ============================================================
export function filterBlogByCategory(category) {
    setBlogFilters({ category });
    setBlogPagination({ currentPage: 1 });
    renderBlogList();
}

// ============================================================
// ✅ I16.4 : RECHERCHE (debounce INTERNE)
// ------------------------------------------------------------
// Cette fonction est self-contained : elle peut être appelée
// depuis n'importe où (events.js, input direct, etc.) sans
// provoquer de render excessif.
// ============================================================
export function searchBlog(query) {
    // Mise à jour immédiate du state (pour que l'input reflète la saisie)
    setBlogFilters({ search: query });
    setBlogPagination({ currentPage: 1 });

    // Render debounced
    if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => {
        renderBlogList();
        _searchDebounceTimer = null;
    }, SEARCH_DEBOUNCE_MS);
}

// ============================================================
// ✅ I16.2 : PAGINATION (guard parentNode)
// ============================================================
function renderBlogPagination(totalPages, currentPage) {
    const existing = document.getElementById('blogPagination');
    if (existing) existing.remove();

    if (totalPages <= 1) return;

    const container = document.getElementById('blogGrid');
    if (!container) return;

    const pag = document.createElement('div');
    pag.id = 'blogPagination';
    pag.className = 'pagination-container';
    pag.style.gridColumn = '1 / -1';

    let html = `<button class="pagination-btn ${currentPage === 1 ? 'disabled' : ''}" data-blog-page="${currentPage - 1}">‹</button>`;
    for (let i = 1; i <= totalPages; i++) {
        html += `<button class="pagination-btn ${i === currentPage ? 'active' : ''}" data-blog-page="${i}">${i}</button>`;
    }
    html += `<button class="pagination-btn ${currentPage === totalPages ? 'disabled' : ''}" data-blog-page="${currentPage + 1}">›</button>`;
    pag.innerHTML = html;

    // ✅ I16.2 : guard parent + fallback
    const parent = container.parentNode;
    if (parent) {
        parent.insertBefore(pag, container.nextSibling);
    } else {
        // Fallback : append dans le container lui-même
        container.appendChild(pag);
    }

    pag.querySelectorAll('[data-blog-page]').forEach(btn => {
        btn.addEventListener('click', () => {
            const page = parseInt(btn.dataset.blogPage);
            if (isNaN(page) || page < 1 || page > totalPages) return;
            setBlogPagination({ currentPage: page });
            renderBlogList();
            document.getElementById('blogGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}

// ============================================================
// ✅ I16.1 : OUVRIR UN ARTICLE (fix fuite ESC + validation image)
// ============================================================
export function openBlogArticle(postId) {
    const post = getBlogPosts().find(p => p.id === postId);
    if (!post) {
        showToast('❌ ' + t('articleNotFound'));
        return;
    }

    const modal = document.getElementById('blogArticleModal');
    const content = document.getElementById('blogArticleContent');
    if (!modal || !content) return;

    const title = escapeHTML(post.title || 'Sans titre');
    const categoryLabel = escapeHTML(tCategory(post.category || 'general'));
    const date = formatDate(post.publishedAt || post.createdAt) || '';
    const author = escapeHTML(post.author || 'Smart Swi9a');
    const readTime = estimateReadTime(post.content || '');

    const catEmojiMap = {
        conseils: '💡', tendances: '🔥', tests: '🧪',
        tutoriels: '📖', 'smart-home': '🏠', gadgets: '📱', actualites: '📰'
    };
    const catEmoji = catEmojiMap[post.category] || '📝';

    // ✅ I16.3 : validation image
    const hasImg = isValidImageUrl(post.image);
    const heroHtml = hasImg
        ? `<img src="${escapeHTML(post.image)}" alt="${title}" class="blog-article-hero" data-photo-url="${escapeHTML(post.image)}" style="cursor:zoom-in;">`
        : `<div class="blog-article-hero blog-img-bg-${(post.id.length % 6) + 1}" style="display:flex;align-items:center;justify-content:center;font-size:5rem;">${catEmoji}</div>`;

    content.innerHTML = `
        <button class="blog-article-close" id="closeBlogArticleBtn" aria-label="${t('close')}">✕</button>
        ${heroHtml}
        <div class="blog-article-body">
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.8rem;">
                <span class="blog-category-tag">${catEmoji} ${categoryLabel}</span>
                <span style="font-size:0.75rem;color:var(--text-dim);align-self:center;">
                    📅 ${date} · ⏱️ ${tReadTime(readTime)} · ✍️ ${author}
                </span>
            </div>
            <h2 class="blog-article-title">${title}</h2>
            <div class="blog-article-text">${escapeHTML(post.content || '')}</div>
        </div>
    `;

    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    modal.scrollTop = 0;

    document.getElementById('closeBlogArticleBtn').addEventListener('click', closeBlogArticle);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeBlogArticle();
    });

    // ✅ I16.1 : cleanup AVANT d'attacher le nouveau
    if (_currentEscHandler) {
        document.removeEventListener('keydown', _currentEscHandler);
        _currentEscHandler = null;
    }
    _currentEscHandler = (e) => {
        if (e.key === 'Escape') closeBlogArticle();
    };
    document.addEventListener('keydown', _currentEscHandler);

    const heroImg = content.querySelector('[data-photo-url]');
    if (heroImg) {
        heroImg.addEventListener('click', () => {
            openImageLightbox(heroImg.dataset.photoUrl);
        });
    }
}

// ============================================================
// ✅ I16.1 : FERMER L'ARTICLE (cleanup ESC)
// ============================================================
export function closeBlogArticle() {
    const modal = document.getElementById('blogArticleModal');
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';

    // ✅ I16.1 : cleanup handler
    if (_currentEscHandler) {
        document.removeEventListener('keydown', _currentEscHandler);
        _currentEscHandler = null;
    }
}

// ============================================================
// INITIALISATION GLOBALE DU BLOG
// ============================================================
export async function initBlogPage() {
    console.log('🚀 Initialisation de la page blog...');

    const promise = loadBlogPosts();
    setBlogLoadedPromise(promise);
    await promise;

    await renderBlogList();
}

// ============================================================
// LOG
// ============================================================
console.log('✅ blog.js chargé — v2.0.0 (index-free + debounce + sécurité images)');