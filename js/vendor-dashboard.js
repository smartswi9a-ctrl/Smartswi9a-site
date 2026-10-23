// js/vendor-dashboard.js
// ============================================================
// LOGIQUE DU DASHBOARD VENDEUR
// Version 1.0.0
// ============================================================

import { doc, getDoc, collection, query, where, getDocs } from "firebase/firestore";
import { db } from "./firebase.js";
import { getCurrentUser, logoutUser } from "./auth.js";
import { CONFIG, ROLES, VENDOR_STATUS } from "./config.js";
import { showToast } from "./ui-core.js";

let currentVendor = null;
let currentWallet = null;

// ============================================================
// INITIALISATION
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    const user = getCurrentUser();
    
    // 1. Vérification des droits
    if (!user || user.role !== ROLES.VENDOR) {
        window.location.href = '/';
        return;
    }

    // 2. Charger les données du vendeur et son wallet
    try {
        const vendorDoc = await getDoc(doc(db, "users", user.uid));
        if (vendorDoc.exists()) {
            currentVendor = vendorDoc.data();
            document.getElementById('vShopName').textContent = currentVendor.vendorInfo.shopName;
            
            const statusEl = document.getElementById('vShopStatus');
            if (currentVendor.vendorInfo.status === 'approved') {
                statusEl.textContent = '✅ Approuvé';
                statusEl.className = 'v-shop-status';
            } else if (currentVendor.vendorInfo.status === 'pending') {
                statusEl.textContent = '⏳ En attente';
                statusEl.className = 'v-shop-status pending';
            }
        }

        const walletDoc = await getDoc(doc(db, "wallets", user.uid));
        if (walletDoc.exists()) {
            currentWallet = walletDoc.data();
        }

        // 3. Afficher l'onglet par défaut
        renderTab('overview');
        setupNavigation();

    } catch (e) {
        console.error(e);
        showToast("Erreur de chargement des données.");
    }
});

// ============================================================
// NAVIGATION
// ============================================================
function setupNavigation() {
    const links = document.querySelectorAll('.v-nav-link[data-tab]');
    links.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            links.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            
            const tab = link.dataset.tab;
            document.getElementById('vPageTitle').textContent = link.querySelector('.v-nav-label').textContent;
            renderTab(tab);
        });
    });

    // Déconnexion
    document.getElementById('logoutBtn').addEventListener('click', async () => {
        await logoutUser();
        window.location.href = '/';
    });

    // Mobile toggle
    const sidebar = document.getElementById('vSidebar');
    const overlay = document.getElementById('vOverlay');
    document.getElementById('vMobileToggle').addEventListener('click', () => {
        sidebar.classList.add('open');
        overlay.classList.add('open');
    });
    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
    });
}

// ============================================================
// RENDU DES ONGLETS
// ============================================================
async function renderTab(tabName) {
    const container = document.getElementById('vTabContent');
    
    if (tabName === 'overview') {
        container.innerHTML = `
            <div class="v-kpi-grid">
                <div class="v-kpi-card primary">
                    <div class="v-kpi-header"><span class="v-kpi-icon">💰</span><span class="v-kpi-label">Solde dispo.</span></div>
                    <p class="v-kpi-value">${currentWallet?.availableBalance || 0} MAD</p>
                </div>
                <div class="v-kpi-card">
                    <div class="v-kpi-header"><span class="v-kpi-icon">⏳</span><span class="v-kpi-label">En attente</span></div>
                    <p class="v-kpi-value">${currentWallet?.pendingBalance || 0} MAD</p>
                </div>
            </div>
            <div class="v-card">
                <h3 class="v-card-title">👋 Bienvenue sur votre espace</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Utilisez le menu de gauche pour gérer vos commandes et votre stock.</p>
            </div>
        `;
    } 
    else if (tabName === 'orders') {
        // On affichera les commandes plus tard, pour l'instant un état vide
        container.innerHTML = `
            <div class="v-empty">
                <div class="v-empty-icon">📋</div>
                <h3 class="v-empty-title">Aucune commande pour le moment</h3>
                <p class="v-empty-desc">Vos commandes apparaîtront ici.</p>
            </div>
        `;
    }
    else if (tabName === 'wallet') {
        container.innerHTML = `
            <div class="v-wallet-hero">
                <div class="v-wallet-label">Solde disponible</div>
                <div class="v-wallet-amount">${currentWallet?.availableBalance || 0} <span style="font-size:1.2rem">MAD</span></div>
                <button class="v-btn v-btn-secondary" style="margin-top:1rem;">💸 Demander un retrait</button>
            </div>
        `;
    }
    else if (tabName === 'stock') {
        container.innerHTML = `
            <div class="v-empty">
                <div class="v-empty-icon">📥</div>
                <h3 class="v-empty-title">Aucun stock Fulfillment</h3>
                <p class="v-empty-desc">Envoyez vos produits chez Speedaf pour que nous gérions la livraison.</p>
            </div>
        `;
    }
}