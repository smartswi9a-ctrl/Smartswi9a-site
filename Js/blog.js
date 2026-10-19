// js/blog.js
// ============================================================
// BLOG CÔTÉ CLIENT - SMART SWI9A
// Version 1.1.0 — i18n complet (catégories + read time)
// ============================================================
// Dépend de : config, utils, store, firebase, ui-core
// Affiche la liste des articles + ouvre un article en modal
// ============================================================

import {
    collection, query, where, getDocs, orderBy, limit
} from "firebase/firestore";
import { db } from "./firebase.js";
import { CONFIG } from "./config.js";
import {
    t, escapeHTML, formatDate, toDate, estimateReadTime, truncate
} from "./utils.js";
import {
    getBlogPosts, setBlogPosts, getBlogFilters, setBlogFilters,
    resetBlogFilters, getBlogPagination, setBlogPagination,
    setBlogLoadedPromise, getBlogLoadedPromise
} from "./store.js";
import { showToast, openImageLightbox } from "./ui-core.js";

// ============================================================
// CONSTANTES
// ============================================================
const POSTS_PER_PAGE = CONFIG.BLOG.PER_PAGE || 6;

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
// CHARGEMENT DES ARTICLES DEPUIS FIRESTORE
// ============================================================
export async function loadBlogPosts() {
    try {
        console.log('⏳ Chargement des articles de blog...');

        const q = query(
            collection(db, "blog"),
            where("status", "==", "published"),
            orderBy("publishedAt", "desc"),
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

        posts.sort((a, b) => {
            const da = a.publishedAt ? a.publishedAt.getTime() : 0;
            const dbb = b.publishedAt ? b.publishedAt.getTime() : 0;
            return dbb - da;
        });

        console.log(`✅ ${posts.length} articles chargés`);
        setBlogPosts(posts);
        return posts;
    } catch (e) {
        console.error('❌ Erreur chargement blog :', e);
        // Fallback : essaie sans orderBy
        try {
            const q = query(
                collection(db, "blog"),
                where("status", "==", "published")
            );
            const snapshot = await getDocs(q);
            const posts = snapshot.docs.map(d => {
                const data = d.data();
                return {
                    id: d.id,
                    ...data,
                    publishedAt: toDate(data.publishedAt) || toDate(data.createdAt),
                    createdAt: toDate(data.createdAt)
                };
            }).sort((a, b) => {
                const da = a.publishedAt ? a.publishedAt.getTime() : 0;
                const dbb = b.publishedAt ? b.publishedAt.getTime() : 0;
                return dbb - da;
            });
            setBlogPosts(posts);
            return posts;
        } catch (e2) {
            console.error('❌ Fallback blog échoué :', e2);
            setBlogPosts([]);
            return [];
        }
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
// CARTE ARTICLE
// ============================================================
function renderBlogCard(post, index) {
    const title = escapeHTML(post.title || 'Sans titre');
    const excerpt = escapeHTML(truncate(post.excerpt || post.content || '', 130));
    const categoryLabel = escapeHTML(tCategory(post.category || 'general'));
    const date = formatDate(post.publishedAt || post.createdAt) || '';
    const readTime = estimateReadTime(post.content || '');
    const hasImg = post.image && post.image !== '';

    const gradientClass = `blog-img-bg-${(index % 6) + 1}`;

    const catEmojiMap = {
        conseils: '💡',
        tendances: '🔥',
        tests: '🧪',
        tutoriels: '📖',
        'smart-home': '🏠',
        gadgets: '📱',
        actualites: '📰'
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
// RECHERCHE
// ============================================================
export function searchBlog(query) {
    setBlogFilters({ search: query });
    setBlogPagination({ currentPage: 1 });
    renderBlogList();
}

// ============================================================
// PAGINATION
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

    container.parentNode.insertBefore(pag, container.nextSibling);

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
// OUVRIR UN ARTICLE (modal)
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

    const hasImg = post.image && post.image !== '';
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

    document.getElementById('closeBlogArticleBtn').addEventListener('click', closeBlogArticle);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeBlogArticle();
    });

    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closeBlogArticle();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    const heroImg = content.querySelector('[data-photo-url]');
    if (heroImg) {
        heroImg.addEventListener('click', () => {
            openImageLightbox(heroImg.dataset.photoUrl);
        });
    }

    modal.scrollTop = 0;
}

// ============================================================
// FERMER L'ARTICLE
// ============================================================
export function closeBlogArticle() {
    const modal = document.getElementById('blogArticleModal');
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
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
console.log('✅ blog.js chargé — v1.1.0 (i18n complet)');