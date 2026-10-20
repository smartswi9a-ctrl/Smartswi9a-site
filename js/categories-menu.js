// js/categories-menu.js
// ============================================================
// MENU VISUEL DES CATÉGORIES - SMART SWI9A
// Version 1.2.0 — Design compact, aligné, défilant
// ============================================================

import { CATEGORY_GROUPS } from "./config.js";
import { t } from "./utils.js";
import { setCategory } from "./products.js";

let activeParentId = null;

export function openCategoriesMenu() {
    let modal = document.getElementById('categoriesMenuModal');
    
    // 1. Création du menu s'il n'existe pas
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'categoriesMenuModal';
        modal.className = 'categories-menu-overlay';
        modal.innerHTML = `
            <div class="categories-menu-container">
                <div class="categories-menu-header">
                    <h2>☰ ${t('navCategories') || 'Toutes les catégories'}</h2>
                    <button id="closeCategoriesMenuBtn" class="modal-close">✕</button>
                </div>
                <div class="categories-menu-body">
                    <!-- Liste des catégories parents (Gauche) -->
                    <div class="categories-menu-sidebar" id="categoriesSidebar"></div>
                    <!-- Grille des sous-catégories (Droite) -->
                    <div class="categories-menu-content" id="categoriesContent"></div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Fermeture
        document.getElementById('closeCategoriesMenuBtn').addEventListener('click', closeCategoriesMenu);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeCategoriesMenu();
        });
    }

    // 2. Ouverture avec animation
    setTimeout(() => modal.classList.add('open'), 10);
    document.body.style.overflow = 'hidden';

    // 3. Initialisation
    if (!activeParentId && CATEGORY_GROUPS.length > 0) {
        activeParentId = CATEGORY_GROUPS[0].id;
    }

    renderCategoriesSidebar();
    renderCategoriesContent(activeParentId);
}

export function closeCategoriesMenu() {
    const modal = document.getElementById('categoriesMenuModal');
    if (modal) {
        modal.classList.remove('open');
        document.body.style.overflow = '';
    }
}

// ============================================================
// RENDU DE LA LISTE PARENTS (Gauche)
// ============================================================
function renderCategoriesSidebar() {
    const sidebar = document.getElementById('categoriesSidebar');
    if (!sidebar) return;

    let html = '';
    CATEGORY_GROUPS.forEach(group => {
        const isActive = group.id === activeParentId;
        html += `
            <button class="category-sidebar-btn ${isActive ? 'active' : ''}" data-parent-id="${group.id}">
                <span style="font-size:1.2rem;margin-bottom:2px;">${group.emoji}</span>
                <span style="font-size:0.75rem;font-weight:700;">${t(group.label)}</span>
            </button>
        `;
    });
    sidebar.innerHTML = html;

    // Clic sur un parent
    sidebar.querySelectorAll('.category-sidebar-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeParentId = btn.dataset.parentId;
            renderCategoriesSidebar(); // Met à jour le surlignage
            renderCategoriesContent(activeParentId); // Met à jour la grille de droite
        });
    });
}

// ============================================================
// RENDU DES SOUS-CATÉGORIES (Droite)
// ============================================================
function renderCategoriesContent(parentId) {
    const content = document.getElementById('categoriesContent');
    if (!content) return;

    const parentGroup = CATEGORY_GROUPS.find(g => g.id === parentId);
    if (!parentGroup) return;

    // Titre de la section
    let html = `<h3 class="categories-content-title">${parentGroup.emoji} ${t(parentGroup.label)}</h3>`;
    
    // Grille
    html += `<div class="categories-grid">`;

    parentGroup.children.forEach(child => {
        // On pointe vers le dossier assets/categories
        const imgPath = `/assets/categories/${child.id}.webp`;
        
        html += `
            <div class="category-grid-card" data-category-id="${child.id}">
                <div class="category-grid-img-wrapper">
                    <!-- L'image. Si introuvable, on affiche l'emoji -->
                    <img src="${imgPath}" alt="${t(child.label)}" loading="lazy"
                         onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="category-grid-fallback" style="display:none;">${child.emoji}</div>
                </div>
                <span class="category-grid-label">${t(child.label)}</span>
            </div>
        `;
    });

    html += `</div>`;
    
    // Bouton "Voir tout"
    html += `
        <div style="margin-top: 1.5rem; text-align: center;">
            <button class="btn-primary" id="viewAllCategoryBtn" data-category-id="${parentId}" style="padding: 0.6rem 1.5rem; font-size: 0.85rem;">
                Voir tout ${t(parentGroup.label)}
            </button>
        </div>
    `;

    content.innerHTML = html;

    // Clic sur une image/sous-catégorie
    content.querySelectorAll('.category-grid-card').forEach(card => {
        card.addEventListener('click', () => {
            const catId = card.dataset.categoryId;
            closeCategoriesMenu();
            setCategory(catId);
            // Redirige vers la section produits
            window.location.href = `/#produits?cat=${catId}`;
        });
    });

    // Clic sur "Voir tout"
    const viewAllBtn = document.getElementById('viewAllCategoryBtn');
    if (viewAllBtn) {
        viewAllBtn.addEventListener('click', () => {
            const catId = viewAllBtn.dataset.categoryId;
            closeCategoriesMenu();
            setCategory(catId);
            window.location.href = `/#produits?cat=${catId}`;
        });
    }
}