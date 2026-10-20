// js/admin.js
// ============================================================
// PANNEAU ADMINISTRATION - SMART SWI9A
// Version 5.0.0 — Gestion Catégories, Dimensions, Variantes, Guide Tailles
// ============================================================

import { auth, db, storage } from "./firebase.js";
import {
    onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "firebase/auth";
import {
    collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
    query, where, writeBatch, Timestamp, getCountFromServer,
    orderBy, limit, increment, addDoc, deleteField
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { 
    ROLES, ORDER_STATUS, CATEGORIES, CATEGORY_GROUPS, CONFIG, normalizeOrderStatus 
} from "./config.js";
import {
    escapeHTML, slugify, getStoragePathFromUrl, isStorageUrl,
    getSignupMethodLabel, getSignupMethodEmoji, toDate, t
} from "./utils.js";
import { renderAdminOrders, resetAdminOrdersCache } from "./orders.js";
import { renderAdminReviews } from "./reviews.js";
import { showToast, confirmAction } from "./ui-core.js";

// ============================================================
// ÉTAT LOCAL
// ============================================================
let currentAdmin = null;
let cachedProducts = [];
let cachedUsers = [];
let cachedBlogPosts = [];
let cachedPurchases = [];
let cachedExpenses = [];
let cachedTransactions = [];
let cachedCoupons = [];

let simulatorListenersAttached = false;
let alertInterval = null;
let tempStockFilter = null;

// État du graphique
let revenueChartInstance = null;
let currentChartPeriod = 7;
let chartListenersAttached = false;

const PRODUCTS_PER_PAGE = 20;
let productsCurrentPage = 1;
const BLOG_PER_PAGE = 15;
let blogCurrentPage = 1;

// ============================================================
// HELPERS i18n — Catégories blog
// ============================================================
const BLOG_CAT_KEY_MAP = {
    conseils: 'blogCatConseils', tendances: 'blogCatTendances',
    tests: 'blogCatTests', tutoriels: 'blogCatTutoriels',
    'smart-home': 'blogCatSmartHome', gadgets: 'blogCatGadgets',
    actualites: 'blogCatActualites', general: 'blogCatGeneral'
};
function tBlogCategory(catId) {
    return t(BLOG_CAT_KEY_MAP[catId] || 'blogCatGeneral');
}

// ============================================================
// HELPERS i18n — Types de coupons
// ============================================================
const COUPON_TYPES = {
    percentage:     { label: 'Pourcentage',       emoji: '📊', cssClass: 'coupon-type-percentage' },
    fixed:          { label: 'Montant fixe',      emoji: '💰', cssClass: 'coupon-type-fixed' },
    free_shipping:  { label: 'Livraison gratuite', emoji: '🚚', cssClass: 'coupon-type-free_shipping' }
};

// ============================================================
// HELPERS COMPTABILITÉ
// ============================================================
function formatMAD(n) {
    const num = Number(n) || 0;
    return new Intl.NumberFormat('fr-FR', {
        maximumFractionDigits: 2, useGrouping: true
    }).format(num).replace(/\u202f|\u00a0/g, ' ') + ' MAD';
}

function safeDate(d) {
    const date = toDate(d);
    return date ? date.getTime() : 0;
}

function isInRange(date, start, end) {
    if (!date) return false;
    const d = toDate(date);
    if (!d) return false;
    return d >= start && d <= end;
}

function getDateRangeFromPeriod(period, customStart, customEnd) {
    const now = new Date();
    let start, end;
    switch (period) {
        case 'today':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
            break;
        case 'week': {
            const dayOfWeek = now.getDay() || 7;
            start = new Date(now);
            start.setDate(now.getDate() - dayOfWeek + 1);
            start.setHours(0, 0, 0, 0);
            end = new Date(now); end.setHours(23, 59, 59, 999);
            break;
        }
        case 'month':
            start = new Date(now.getFullYear(), now.getMonth(), 1);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
            break;
        case 'quarter': {
            const q = Math.floor(now.getMonth() / 3);
            start = new Date(now.getFullYear(), q * 3, 1);
            end = new Date(now.getFullYear(), (q + 1) * 3, 0, 23, 59, 59, 999);
            break;
        }
        case 'year':
            start = new Date(now.getFullYear(), 0, 1);
            end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
            break;
        case 'all':
            start = new Date(2020, 0, 1);
            end = new Date(now.getFullYear() + 1, 0, 1);
            break;
        case 'custom':
        default:
            start = customStart ? new Date(customStart) : new Date(now.getFullYear(), now.getMonth(), 1);
            start.setHours(0, 0, 0, 0);
            end = customEnd ? new Date(customEnd) : new Date();
            end.setHours(23, 59, 59, 999);
    }
    return { start, end };
}

// ============================================================
// STORAGE HELPERS
// ============================================================
async function deleteStorageImage(url) {
    if (!isStorageUrl(url)) return false;
    const path = getStoragePathFromUrl(url);
    if (!path) return false;
    try {
        await deleteObject(ref(storage, path));
        return true;
    } catch (e) { return false; }
}

async function deleteStorageImages(urls) {
    if (!urls || urls.length === 0) return;
    await Promise.allSettled(urls.map(url => deleteStorageImage(url)));
}

// ============================================================
// LOADERS ROBUSTES
// ============================================================
async function loadPurchases() {
    try {
        const snap = await getDocs(query(collection(db, "purchases"), orderBy("date", "desc"), limit(500)));
        cachedPurchases = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
    } catch (err) {
        try {
            const snap = await getDocs(collection(db, "purchases"));
            cachedPurchases = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
            cachedPurchases.sort((a, b) => safeDate(b.date) - safeDate(a.date));
        } catch (err2) {
            cachedPurchases = [];
            throw err2;
        }
    }
    return cachedPurchases;
}

async function loadExpenses() {
    try {
        const snap = await getDocs(query(collection(db, "expenses"), orderBy("date", "desc"), limit(500)));
        cachedExpenses = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
    } catch (err) {
        try {
            const snap = await getDocs(collection(db, "expenses"));
            cachedExpenses = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
            cachedExpenses.sort((a, b) => safeDate(b.date) - safeDate(a.date));
        } catch (err2) {
            cachedExpenses = [];
            throw err2;
        }
    }
    return cachedExpenses;
}

async function loadTransactions() {
    try {
        const snap = await getDocs(query(collection(db, "transactions"), orderBy("date", "desc"), limit(500)));
        cachedTransactions = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
    } catch (err) {
        try {
            const snap = await getDocs(collection(db, "transactions"));
            cachedTransactions = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
            cachedTransactions.sort((a, b) => safeDate(b.date) - safeDate(a.date));
        } catch (err2) {
            cachedTransactions = [];
            throw err2;
        }
    }
    return cachedTransactions;
}

// ============================================================
// BANDEAU D'ALERTES — INITIALISATION
// ============================================================
function initAdminAlerts() {
    refreshAdminAlerts();
    if (alertInterval) clearInterval(alertInterval);
    alertInterval = setInterval(refreshAdminAlerts, 60000);

    document.getElementById('closeAlertBannerBtn')?.addEventListener('click', () => {
        const banner = document.getElementById('adminAlertBanner');
        if (banner) banner.style.display = 'none';
    });

    document.getElementById('alertOrdersBtn')?.addEventListener('click', () => {
        document.querySelector('[data-tab="orders"]')?.click();
    });

    document.getElementById('alertReviewsBtn')?.addEventListener('click', () => {
        document.querySelector('[data-tab="reviews"]')?.click();
    });

    document.getElementById('alertStockOutBtn')?.addEventListener('click', () => {
        tempStockFilter = 'out';
        document.querySelector('[data-tab="products"]')?.click();
    });

    document.getElementById('alertStockLowBtn')?.addEventListener('click', () => {
        tempStockFilter = 'low';
        document.querySelector('[data-tab="products"]')?.click();
    });
}

async function refreshAdminAlerts() {
    const banner = document.getElementById('adminAlertBanner');
    if (!banner || !auth.currentUser) return;

    try {
        const qOrders = query(collection(db, "orders"), where("status", "==", "pending"));
        const snapOrders = await getDocs(qOrders);
        const pendingOrdersCount = snapOrders.size;

        const qReviews = query(collection(db, "reviews"), where("status", "==", "pending"));
        const snapReviews = await getDocs(qReviews);
        const pendingReviewsCount = snapReviews.size;

        const snapProducts = await getDocs(collection(db, "products"));
        const stockOutNames = [];
        const stockLowNames = [];

        snapProducts.forEach(d => {
            const p = d.data();
            const stock = Number(p.stock) || 0;
            const name = p.nameFr || p.nameEn || 'Sans nom';
            if (stock === 0) stockOutNames.push(name);
            else if (stock > 0 && stock <= 4) stockLowNames.push(name);
        });

        const btnOrders = document.getElementById('alertOrdersBtn');
        const btnReviews = document.getElementById('alertReviewsBtn');
        const btnStockOut = document.getElementById('alertStockOutBtn');
        const btnStockLow = document.getElementById('alertStockLowBtn');

        let hasAlerts = false;

        if (btnOrders) {
            if (pendingOrdersCount > 0) {
                document.getElementById('alertOrdersCount').textContent = pendingOrdersCount;
                btnOrders.style.display = 'inline-flex';
                hasAlerts = true;
            } else {
                btnOrders.style.display = 'none';
            }
        }

        if (btnReviews) {
            if (pendingReviewsCount > 0) {
                document.getElementById('alertReviewsCount').textContent = pendingReviewsCount;
                btnReviews.style.display = 'inline-flex';
                hasAlerts = true;
            } else {
                btnReviews.style.display = 'none';
            }
        }

        if (btnStockOut) {
            if (stockOutNames.length > 0) {
                document.getElementById('alertStockOutCount').textContent = stockOutNames.length;
                const tooltip = document.getElementById('alertStockOutTooltip');
                if (tooltip) tooltip.textContent = formatTooltipList(stockOutNames);
                btnStockOut.style.display = 'inline-flex';
                hasAlerts = true;
            } else {
                btnStockOut.style.display = 'none';
            }
        }

        if (btnStockLow) {
            if (stockLowNames.length > 0) {
                document.getElementById('alertStockLowCount').textContent = stockLowNames.length;
                const tooltip = document.getElementById('alertStockLowTooltip');
                if (tooltip) tooltip.textContent = formatTooltipList(stockLowNames);
                btnStockLow.style.display = 'inline-flex';
                hasAlerts = true;
            } else {
                btnStockLow.style.display = 'none';
            }
        }

        banner.style.display = hasAlerts ? 'block' : 'none';

    } catch (e) {
        console.warn('⚠️ Impossible de rafraîchir les alertes :', e);
    }
}

function formatTooltipList(arr, max = 5) {
    if (!arr || arr.length === 0) return '';
    if (arr.length <= max) return arr.join(', ');
    return arr.slice(0, max).join(', ') + ` +${arr.length - max} autre(s)`;
}

// ============================================================
// INITIALISATION
// ============================================================
function initAdmin() {
    console.log('🚀 Admin : initialisation...');

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            try {
                const userDoc = await getDoc(doc(db, "users", user.uid));
                if (userDoc.exists() && userDoc.data().role === ROLES.ADMIN) {
                    currentAdmin = user;
                    resetAdminOrdersCache();
                    showAdminPanel(user);
                    loadAllData();
                    initAdminAlerts();
                    attachChartListeners();
                } else {
                    showLoginBox('⚠️ ' + t('loginRequired'));
                    await signOut(auth);
                }
            } catch (e) {
                console.error('❌ Erreur vérif admin :', e);
                showLoginBox('⚠️ ' + t('error'));
                await signOut(auth);
            }
        } else {
            showLoginBox();
            document.getElementById('adminAlertBanner').style.display = 'none';
            if (alertInterval) clearInterval(alertInterval);
        }
    });

    document.getElementById('adminLoginBtn')?.addEventListener('click', handleLogin);
    document.getElementById('adminLogoutBtn')?.addEventListener('click', async () => {
        resetAdminOrdersCache();
        if (alertInterval) clearInterval(alertInterval);
        await signOut(auth);
        showToast('👋 ' + t('logout'));
    });

    // Onglets principaux
    document.querySelectorAll('.admin-tabs > button[data-tab]').forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('.admin-tabs > button[data-tab]').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.admin-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            document.getElementById(`tab-${tab}`)?.classList.add('active');

            refreshAdminAlerts();

            if (tab === 'tools') loadCollectionsStatus();
            else if (tab === 'blog') loadBlogPosts();
            else if (tab === 'products') { await loadProducts(); await loadStats(); }
            else if (tab === 'orders') await loadOrders();
            else if (tab === 'coupons') await loadCoupons();
            else if (tab === 'finances') await loadFinancesTab();
        });
    });

    // Sous-onglets comptabilité
    document.querySelectorAll('[data-acc-tab]').forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('[data-acc-tab]').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.acc-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`acc-${btn.dataset.accTab}`)?.classList.add('active');

            if (btn.dataset.accTab === 'overview') await refreshAccOverview();
            else if (btn.dataset.accTab === 'purchases') await renderPurchasesList();
            else if (btn.dataset.accTab === 'expenses') await renderExpensesList();
            else if (btn.dataset.accTab === 'transactions') await renderTransactionsList();
            else if (btn.dataset.accTab === 'simulator') {
                if (!cachedProducts || cachedProducts.length === 0) await loadProducts();
                renderFinanceProductSelection();
                attachSimulatorListeners();
            }
        });
    });

    document.addEventListener('order-stock-changed', async () => {
        try {
            await loadProducts();
            await loadStats();
            refreshAdminAlerts();
        } catch (e) {}
    });

    attachProductFormEvents();
    populateCategoriesFilter();
    attachBlogFormEvents();
    attachCouponFormEvents();

    document.getElementById('productSearchAdmin')?.addEventListener('input', () => {
        tempStockFilter = null;
        productsCurrentPage = 1; filterProductsList();
    });
    document.getElementById('productCategoryFilter')?.addEventListener('change', () => {
        tempStockFilter = null;
        productsCurrentPage = 1; filterProductsList();
    });

    document.getElementById('userSearchAdmin')?.addEventListener('input', filterUsersList);
    document.querySelectorAll('[data-signup-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-signup-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filterUsersList();
        });
    });
    document.getElementById('blogSearchAdmin')?.addEventListener('input', () => {
        blogCurrentPage = 1; filterBlogList();
    });
    document.getElementById('couponSearchAdmin')?.addEventListener('input', filterCouponsList);

    document.getElementById('migrateCitiesBtn')?.addEventListener('click', handleMigrateCities);
    document.getElementById('refreshCollectionsBtn')?.addEventListener('click', loadCollectionsStatus);

    // Événements comptabilité
    document.getElementById('accRefreshBtn')?.addEventListener('click', refreshAccOverview);
    document.getElementById('accPeriod')?.addEventListener('change', (e) => {
        const startEl = document.getElementById('accStart');
        const endEl = document.getElementById('accEnd');
        const isCustom = e.target.value === 'custom';
        if (startEl) startEl.disabled = !isCustom;
        if (endEl) endEl.disabled = !isCustom;
        if (!isCustom) refreshAccOverview();
    });

    const accStartInit = document.getElementById('accStart');
    const accEndInit = document.getElementById('accEnd');
    if (accStartInit) accStartInit.disabled = true;
    if (accEndInit) accEndInit.disabled = true;

    document.getElementById('addPurchaseBtn')?.addEventListener('click', saveNewPurchase);
    document.getElementById('addExpenseBtn')?.addEventListener('click', saveNewExpense);
    document.getElementById('addTransactionBtn')?.addEventListener('click', saveNewTransaction);
    document.getElementById('generateReportBtn')?.addEventListener('click', generateReport);
    document.getElementById('exportCSVBtn')?.addEventListener('click', exportReportCSV);
    document.getElementById('printReportBtn')?.addEventListener('click', () => window.print());

    document.getElementById('exportOrdersCSVBtn')?.addEventListener('click', exportOrdersCSV);
    document.getElementById('exportProductsCSVBtn')?.addEventListener('click', exportProductsCSV);

    document.getElementById('transSearch')?.addEventListener('input', renderTransactionsList);
    document.getElementById('transFilterType')?.addEventListener('change', renderTransactionsList);
    document.getElementById('reportType')?.addEventListener('change', updateReportDates);

    ['purDate', 'expDate', 'transDate'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.valueAsDate = new Date();
    });

    document.getElementById('calculateFinancesBtn')?.addEventListener('click', calculateFinances);

    const slider = document.getElementById('finReturnRate');
    if (slider) {
        slider.addEventListener('input', (e) => {
            const el = document.getElementById('finReturnRateValue');
            if (el) el.textContent = e.target.value + '%';
        });
    }

    // Événements pour les variantes
    document.getElementById('generateVariantsBtn')?.addEventListener('click', generateVariants);
}

// ============================================================
// CHART : Listeners des boutons de période
// ============================================================
function attachChartListeners() {
    if (chartListenersAttached) return;
    chartListenersAttached = true;

    const buttons = document.querySelectorAll('.chart-period-btn');
    if (buttons.length === 0) return;

    buttons.forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('.chart-period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentChartPeriod = parseInt(btn.dataset.chartPeriod) || 7;
            await renderRevenueChart(currentChartPeriod);
        });
    });
}

// ============================================================
// CHART : Rendu du graphique d'évolution du CA
// ============================================================
async function renderRevenueChart(period = 7, preloadedOrders = null) {
    const canvas = document.getElementById('revenueChart');
    if (!canvas) return;

    if (typeof window.Chart === 'undefined') {
        console.log('⏳ Attente du chargement de Chart.js...');
        await new Promise(resolve => setTimeout(resolve, 500));
        if (typeof window.Chart === 'undefined') {
            console.warn('⚠️ Chart.js non chargé — vérifiez la CSP dans firebase.json');
            return;
        }
    }

    try {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(now.getDate() - period + 1);
        startDate.setHours(0, 0, 0, 0);

        await Promise.allSettled([
            cachedPurchases.length === 0 ? loadPurchases() : Promise.resolve(),
            cachedExpenses.length === 0 ? loadExpenses() : Promise.resolve(),
            cachedTransactions.length === 0 ? loadTransactions() : Promise.resolve()
        ]);

        let orders = preloadedOrders;
        if (!orders) {
            const ordersSnap = await getDocs(collection(db, "orders"));
            orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        }

        const buckets = {};
        for (let i = 0; i < period; i++) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
            const key = d.toISOString().split('T')[0];
            buckets[key] = { revenue: 0, costs: 0, date: d };
        }

        orders.forEach(o => {
            const date = toDate(o.createdAt);
            if (!date) return;
            const key = date.toISOString().split('T')[0];
            if (!buckets[key]) return;
            const status = o.status === 'validated' ? 'confirmed'
                : o.status === 'received' ? 'delivered'
                : o.status;
            if (status === 'delivered') {
                buckets[key].revenue += Number(o.total) || 0;
            }
        });

        cachedPurchases.forEach(p => {
            const date = toDate(p.date);
            if (!date) return;
            const key = date.toISOString().split('T')[0];
            if (!buckets[key]) return;
            buckets[key].costs += Number(p.totalCost) || 0;
        });

        cachedExpenses.forEach(e => {
            const date = toDate(e.date);
            if (!date) return;
            const key = date.toISOString().split('T')[0];
            if (!buckets[key]) return;
            buckets[key].costs += Number(e.amount) || 0;
        });

        cachedTransactions.forEach(tx => {
            if (tx.type !== 'expense') return;
            const date = toDate(tx.date);
            if (!date) return;
            const key = date.toISOString().split('T')[0];
            if (!buckets[key]) return;
            buckets[key].costs += Number(tx.amount) || 0;
        });

        const sortedKeys = Object.keys(buckets).sort();
        const labels = [];
        const revenueData = [];
        const costsData = [];
        const profitData = [];

        sortedKeys.forEach(key => {
            const b = buckets[key];
            labels.push(b.date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
            revenueData.push(b.revenue);
            costsData.push(b.costs);
            profitData.push(b.revenue - b.costs);
        });

        if (revenueChartInstance) {
            revenueChartInstance.destroy();
            revenueChartInstance = null;
        }

        const ctx = canvas.getContext('2d');
        revenueChartInstance = new window.Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: '💰 CA (commandes livrées)',
                        data: revenueData,
                        borderColor: '#a57b2e',
                        backgroundColor: 'rgba(165, 123, 46, 0.12)',
                        fill: true,
                        tension: 0.3,
                        borderWidth: 2.5,
                        pointRadius: period > 30 ? 0 : 3,
                        pointHoverRadius: 6,
                        pointBackgroundColor: '#a57b2e',
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 2
                    },
                    {
                        label: '💸 Coûts',
                        data: costsData,
                        borderColor: '#b03a2e',
                        backgroundColor: 'rgba(176, 58, 46, 0.08)',
                        fill: false,
                        tension: 0.3,
                        borderWidth: 2,
                        pointRadius: period > 30 ? 0 : 3,
                        pointHoverRadius: 6,
                        pointBackgroundColor: '#b03a2e',
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 2
                    },
                    {
                        label: '🏆 Profit net',
                        data: profitData,
                        borderColor: '#2ecc71',
                        backgroundColor: 'rgba(46, 204, 113, 0.08)',
                        fill: false,
                        tension: 0.3,
                        borderWidth: 2.5,
                        borderDash: [5, 3],
                        pointRadius: period > 30 ? 0 : 3,
                        pointHoverRadius: 6,
                        pointBackgroundColor: '#2ecc71',
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 2
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            font: { size: 12, family: 'Inter, sans-serif', weight: '600' },
                            color: '#1a1a2e',
                            usePointStyle: true,
                            padding: 15
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(26, 26, 46, 0.95)',
                        titleColor: '#ffffff',
                        bodyColor: '#ffffff',
                        padding: 12,
                        cornerRadius: 8,
                        titleFont: { size: 13, weight: '700' },
                        bodyFont: { size: 12 },
                        callbacks: {
                            label: function(context) {
                                const label = context.dataset.label || '';
                                const value = context.parsed.y || 0;
                                return `${label}: ${formatMAD(value)}`;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: '#5c5c5c',
                            font: { size: 11 },
                            callback: function(value) {
                                if (value >= 1000) return (value / 1000).toFixed(1) + 'k MAD';
                                return value + ' MAD';
                            }
                        },
                        grid: {
                            color: 'rgba(0, 0, 0, 0.05)'
                        }
                    },
                    x: {
                        ticks: {
                            color: '#5c5c5c',
                            font: { size: 11 },
                            maxRotation: 45,
                            minRotation: 0,
                            autoSkip: true,
                            maxTicksLimit: period > 30 ? 20 : 15
                        },
                        grid: {
                            display: false
                        }
                    }
                }
            }
        });

        setTimeout(() => {
            if (revenueChartInstance) {
                revenueChartInstance.resize();
            }
        }, 150);

        console.log(`✅ Graphique rendu : ${period} jours, ${orders.length} commandes analysées`);
    } catch (e) {
        console.error('❌ Erreur renderRevenueChart :', e);
    }
}

// ============================================================
// SIMULATEUR — LISTENERS
// ============================================================
function attachSimulatorListeners() {
    if (simulatorListenersAttached) return;
    simulatorListenersAttached = true;

    loadSimulatorParams();

    const inputsToWatch = [
        'finAdSpend', 'finPackaging', 'finReturnShipping',
        'finSafetyMargin', 'finReturnRate'
    ];

    let debounceTimer = null;
    const scheduleRecalc = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            saveSimulatorParams();
            const results = document.getElementById('financeResults');
            if (results && results.style.display === 'block') {
                calculateFinances();
            }
        }, 400);
    };

    inputsToWatch.forEach(id => {
        document.getElementById(id)?.addEventListener('input', scheduleRecalc);
    });

    document.getElementById('financeProductSelector')?.addEventListener('change', (e) => {
        if (e.target.classList.contains('fin-prod-checkbox')) {
            saveSimulatorParams();
            const results = document.getElementById('financeResults');
            if (results && results.style.display === 'block') {
                scheduleRecalc();
            }
        }
    });
}

// ============================================================
// SIMULATEUR — SAUVEGARDE / RESTAURATION DES PARAMÈTRES
// ============================================================
const SIMULATOR_STORAGE_KEY = 'swi9a_simulator_params';

function loadSimulatorParams() {
    try {
        const saved = localStorage.getItem(SIMULATOR_STORAGE_KEY);
        if (!saved) return;
        const params = JSON.parse(saved);
        if (params.adSpend !== undefined) document.getElementById('finAdSpend').value = params.adSpend;
        if (params.packaging !== undefined) document.getElementById('finPackaging').value = params.packaging;
        if (params.returnShipping !== undefined) document.getElementById('finReturnShipping').value = params.returnShipping;
        if (params.safetyMargin !== undefined) document.getElementById('finSafetyMargin').value = params.safetyMargin;
        if (params.returnRate !== undefined) {
            document.getElementById('finReturnRate').value = params.returnRate;
            const label = document.getElementById('finReturnRateValue');
            if (label) label.textContent = params.returnRate + '%';
        }
    } catch (e) {
        console.warn('⚠️ Impossible de restaurer les paramètres du simulateur:', e);
    }
}

function saveSimulatorParams() {
    try {
        const params = {
            adSpend: document.getElementById('finAdSpend')?.value,
            packaging: document.getElementById('finPackaging')?.value,
            returnShipping: document.getElementById('finReturnShipping')?.value,
            safetyMargin: document.getElementById('finSafetyMargin')?.value,
            returnRate: document.getElementById('finReturnRate')?.value
        };
        localStorage.setItem(SIMULATOR_STORAGE_KEY, JSON.stringify(params));
    } catch (e) {
        console.warn('⚠️ Impossible de sauvegarder les paramètres du simulateur:', e);
    }
}

// ============================================================
// LOGIN / LOGOUT / PANEL
// ============================================================
async function handleLogin() {
    const email = document.getElementById('adminEmail').value.trim();
    const password = document.getElementById('adminPassword').value;
    const msg = document.getElementById('adminLoginMsg');
    if (!email || !password) { if (msg) msg.textContent = t('fillAllFields'); return; }
    if (msg) msg.textContent = '⏳ ' + t('loading');
    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
        if (msg) msg.textContent = '❌ ' + (e.code === 'auth/wrong-password' ? t('wrongPassword') : e.message);
    }
}

function showLoginBox(errorMsg = '') {
    const loginBox = document.getElementById('adminLoginBox');
    const panel = document.getElementById('adminPanel');
    if (loginBox) loginBox.style.display = 'block';
    if (panel) panel.style.display = 'none';
    const msg = document.getElementById('adminLoginMsg');
    if (msg) msg.textContent = errorMsg;
}

function showAdminPanel(user) {
    const loginBox = document.getElementById('adminLoginBox');
    const panel = document.getElementById('adminPanel');
    if (loginBox) loginBox.style.display = 'none';
    if (panel) panel.style.display = 'block';
    const emailEl = document.getElementById('adminUserEmail');
    if (emailEl) emailEl.textContent = user.email;
}

// ============================================================
// CHARGEMENT GLOBAL
// ============================================================
async function loadAllData() {
    await Promise.allSettled([
        loadStats(), loadProducts(), loadOrders(), loadUsers(), loadReviews()
    ]);
}

// ============================================================
// STATS
// ============================================================
async function loadStats() {
    try {
        try {
            const c = await getCountFromServer(collection(db, "products"));
            const el = document.getElementById('statProducts');
            if (el) el.textContent = c.data().count;
        } catch (e) {
            const snap = await getDocs(collection(db, "products"));
            const el = document.getElementById('statProducts');
            if (el) el.textContent = snap.size;
        }

        const ordersSnap = await getDocs(collection(db, "orders"));
        let pendingOrders = 0, revenue = 0;
        ordersSnap.forEach(d => {
            const o = d.data();
            const status = o.status === 'validated' ? 'confirmed' : o.status === 'received' ? 'delivered' : o.status;
            if (status === 'pending') pendingOrders++;
            if (o.paymentStatus === 'paid' || status === 'delivered') revenue += Number(o.total) || 0;
        });
        const sO = document.getElementById('statOrders');
        const sOP = document.getElementById('statOrdersPending');
        const sR = document.getElementById('statRevenue');
        if (sO) sO.textContent = ordersSnap.size;
        if (sOP) sOP.textContent = pendingOrders;
        if (sR) sR.textContent = `${revenue} MAD`;

        try {
            const c = await getCountFromServer(collection(db, "users"));
            const el = document.getElementById('statUsers');
            if (el) el.textContent = c.data().count;
        } catch (e) {
            const snap = await getDocs(collection(db, "users"));
            const el = document.getElementById('statUsers');
            if (el) el.textContent = snap.size;
        }

        try {
            const snap = await getDocs(query(collection(db, "reviews"), where("status", "==", "pending")));
            const el = document.getElementById('statReviewsPending');
            if (el) el.textContent = snap.size;
        } catch (e) {}

        try {
            const c = await getCountFromServer(collection(db, "cities"));
            const el = document.getElementById('statCities');
            if (el) el.textContent = c.data().count;
        } catch (e) {
            const el = document.getElementById('statCities');
            if (el) el.textContent = '—';
        }
    } catch (e) { console.error('❌ loadStats:', e); }
}

// ============================================================
// PRODUITS
// ============================================================
async function loadProducts() {
    const container = document.getElementById('adminProductsList');
    if (container) container.innerHTML = `<div class="admin-loading">⏳ ${t('loading')}</div>`;
    populateCategoriesFilter();
    try {
        const snap = await getDocs(collection(db, "products"));
        cachedProducts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        cachedProducts.sort((a, b) => (a.nameFr || '').localeCompare(b.nameFr || ''));
        productsCurrentPage = 1;
        if (container) filterProductsList(false);
    } catch (e) {
        if (container) container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">${t('loadingError')}</div>`;
    }
}

// ✅ NOUVEAU : Gestion des catégories parentes/enfants
function populateCategoriesFilter() {
    // 1. Filtre de la liste des produits (recherche)
    const selectFilter = document.getElementById('productCategoryFilter');
    if (selectFilter && !selectFilter._populated) {
        let html = `<option value="all">${t('filterAll')}</option>`;
        CATEGORY_GROUPS.forEach(group => {
            html += `<option value="${group.id}" style="font-weight:bold;">📁 ${t(group.label)}</option>`;
            group.children.forEach(cat => {
                html += `<option value="${cat.id}">&nbsp;&nbsp;&nbsp;↳ ${cat.emoji} ${t(cat.label)}</option>`;
            });
        });
        selectFilter.innerHTML = html;
        selectFilter._populated = true;
    }

    // 2. Formulaire d'ajout de produit
    const parentSelect = document.getElementById('pParentCategory');
    const childSelect = document.getElementById('pCategory');
    
    if (parentSelect && !parentSelect._populated) {
        let html = '<option value="">-- Choisir une catégorie --</option>';
        CATEGORY_GROUPS.forEach(group => {
            html += `<option value="${group.id}">${group.emoji} ${t(group.label)}</option>`;
        });
        parentSelect.innerHTML = html;
        parentSelect._populated = true;
        
        parentSelect.addEventListener('change', () => {
            const selectedGroup = CATEGORY_GROUPS.find(g => g.id === parentSelect.value);
            childSelect.innerHTML = '';
            if (!selectedGroup) {
                childSelect.innerHTML = '<option value="">-- Choisir une sous-catégorie --</option>';
                return;
            }
            let childHtml = '<option value="">-- Choisir une sous-catégorie --</option>';
            selectedGroup.children.forEach(child => {
                childHtml += `<option value="${child.id}">${child.emoji} ${t(child.label)}</option>`;
            });
            childSelect.innerHTML = childHtml;
        });
    }
}

function attachClearTempFilterListener() {
    const btn = document.getElementById('clearTempFilterBtn');
    if (!btn) return;
    if (btn._listenerAttached) return;
    btn._listenerAttached = true;
    btn.addEventListener('click', () => {
        tempStockFilter = null;
        filterProductsList();
    });
}

function renderProductsList(products) {
    const container = document.getElementById('adminProductsList');
    if (!container) return;

    let filterIndicator = '';
    if (tempStockFilter === 'out' || tempStockFilter === 'low') {
        const label = tempStockFilter === 'out' ? '❌ Ruptures de stock' : '🟠 Stocks bas (< 5)';
        filterIndicator = `
            <div style="background:rgba(212,175,55,0.1);border:1px solid var(--border-gold);border-radius:var(--radius-sm);padding:0.6rem 1rem;margin-bottom:1rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;font-size:0.85rem;">
                <span>🔍 <strong>Filtre actif :</strong> ${label} (<strong>${products.length}</strong> produit${products.length > 1 ? 's' : ''})</span>
                <button id="clearTempFilterBtn" class="admin-btn-secondary" style="padding:0.3rem 0.8rem;font-size:0.75rem;">✖️ Enlever le filtre</button>
            </div>
        `;
    }

    if (products.length === 0) {
        container.innerHTML = filterIndicator + `<div class="admin-empty">${t('noProductsFound')}</div>`;
        attachClearTempFilterListener();
        return;
    }

    const totalPages = Math.max(1, Math.ceil(products.length / PRODUCTS_PER_PAGE));
    if (productsCurrentPage > totalPages) productsCurrentPage = totalPages;
    const start = (productsCurrentPage - 1) * PRODUCTS_PER_PAGE;
    const pageProducts = products.slice(start, start + PRODUCTS_PER_PAGE);

    let html = filterIndicator;
    if (totalPages > 1) {
        html += `<div style="text-align:center;font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem;">${productsCurrentPage} / ${totalPages} — ${products.length}</div>`;
    }
    pageProducts.forEach(p => {
        const name = escapeHTML(p.nameFr || p.nameEn || 'Sans nom');
        const price = Number(p.price) || 0;
        const oldPrice = Number(p.oldPrice) || 0;
        const stock = Number(p.stock) || 0;
        const category = p.category || '—';
        const isPromo = oldPrice > price && oldPrice > 0;
        let stockColor = 'var(--text)', stockEmoji = '📦';
        if (stock === 0) { stockColor = 'var(--danger)'; stockEmoji = '❌'; }
        else if (stock <= 4) { stockColor = 'var(--warning)'; stockEmoji = '⚠️'; }
        else if (stock >= 20) { stockColor = 'var(--success)'; stockEmoji = '✅'; }

        // ✅ BADGE VIDÉO (typeof)
        const hasVideo = typeof p.video === 'string' && p.video.trim() !== '';
        const videoBadge = hasVideo 
            ? `<span style="background:var(--gold);color:#fff;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:30px;margin-left:0.3rem;vertical-align:middle;" title="Vidéo R2: ${escapeHTML(p.video)}">🎥</span>` 
            : '';
            
        // Badge Variantes
        const hasVariants = p.variants && p.variants.length > 0;
        const variantBadge = hasVariants 
            ? `<span style="background:var(--info);color:#fff;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:30px;margin-left:0.3rem;vertical-align:middle;" title="${p.variants.length} variante(s)">🎨</span>` 
            : '';

        html += `
            <div class="admin-list-item" data-product-id="${p.id}">
                <div class="admin-list-item-info">
                    <strong>${name}${videoBadge}${variantBadge}</strong>
                    <div style="font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem;">
                        📂 ${category} · 💰 ${price} MAD ${isPromo ? `<small style="text-decoration:line-through;color:var(--text-dim);">${oldPrice}</small>` : ''} · <span style="color:${stockColor};font-weight:700;">${stockEmoji} ${stock}</span>
                    </div>
                </div>
                <div class="admin-list-item-actions">
                    <button class="admin-btn-restock" data-action="restock-product" data-id="${p.id}">➕</button>
                    <button class="admin-btn-icon" data-action="edit-product" data-id="${p.id}">✏️</button>
                    <button class="admin-btn-icon admin-btn-danger" data-action="delete-product" data-id="${p.id}">🗑️</button>
                </div>
            </div>
        `;
    });
    if (totalPages > 1) {
        html += `<div style="display:flex;justify-content:center;gap:0.3rem;margin-top:1rem;flex-wrap:wrap;">`;
        html += `<button class="admin-btn-icon" data-page="prev" ${productsCurrentPage === 1 ? 'disabled' : ''}>‹</button>`;
        for (let i = 1; i <= totalPages; i++) {
            html += `<button class="admin-btn-icon ${i === productsCurrentPage ? 'active' : ''}" data-page="${i}" style="${i === productsCurrentPage ? 'background:var(--gold);color:#fff;' : ''}">${i}</button>`;
        }
        html += `<button class="admin-btn-icon" data-page="next" ${productsCurrentPage === totalPages ? 'disabled' : ''}>›</button></div>`;
    }
    container.innerHTML = html;

    attachClearTempFilterListener();

    container.querySelectorAll('[data-action="restock-product"]').forEach(btn => {
        btn.addEventListener('click', () => openRestockModal(btn.dataset.id));
    });
    container.querySelectorAll('[data-action="edit-product"]').forEach(btn => {
        btn.addEventListener('click', () => editProduct(btn.dataset.id));
    });
    container.querySelectorAll('[data-action="delete-product"]').forEach(btn => {
        btn.addEventListener('click', () => deleteProduct(btn.dataset.id));
    });
    container.querySelectorAll('[data-page]').forEach(btn => {
        btn.addEventListener('click', () => {
            const t = btn.dataset.page;
            if (t === 'prev' && productsCurrentPage > 1) productsCurrentPage--;
            else if (t === 'next' && productsCurrentPage < totalPages) productsCurrentPage++;
            else if (!isNaN(parseInt(t))) productsCurrentPage = parseInt(t);
            else return;
            filterProductsList(false);
            container.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}

function filterProductsList(resetPage = true) {
    const search = document.getElementById('productSearchAdmin')?.value.toLowerCase().trim() || '';
    const category = document.getElementById('productCategoryFilter')?.value || 'all';
    let filtered = cachedProducts;

    if (category !== 'all') {
        // Si c'est une catégorie parente, on affiche tous les produits qui ont un parentId = category
        const isParent = CATEGORY_GROUPS.some(g => g.id === category);
        if (isParent) {
            const validChildIds = CATEGORY_GROUPS.find(g => g.id === category).children.map(c => c.id);
            filtered = filtered.filter(p => validChildIds.includes(p.category) || p.category === category);
        } else {
            filtered = filtered.filter(p => p.category === category);
        }
    }

    if (search) filtered = filtered.filter(p => {
        const name = (p.nameFr || p.nameEn || p.nameAr || '').toLowerCase();
        const slug = (p.slug || '').toLowerCase();
        return name.includes(search) || slug.includes(search);
    });

    if (tempStockFilter === 'out') {
        filtered = filtered.filter(p => (Number(p.stock) || 0) === 0);
    } else if (tempStockFilter === 'low') {
        filtered = filtered.filter(p => {
            const s = Number(p.stock) || 0;
            return s > 0 && s <= 4;
        });
    }

    if (resetPage) productsCurrentPage = 1;
    renderProductsList(filtered);
}

// ============================================================
// RESTOCK MODAL
// ============================================================
async function openRestockModal(productId) {
    let product = cachedProducts.find(p => p.id === productId);
    if (!product) {
        const snap = await getDoc(doc(db, "products", productId));
        if (!snap.exists()) { showToast('❌ ' + t('productNotFound')); return; }
        product = { id: snap.id, ...snap.data() };
    }
    document.getElementById('restockModal')?.remove();
    const name = escapeHTML(product.nameFr || 'Sans nom');
    const currentStock = Number(product.stock) || 0;

    const modalHtml = `
        <div class="modal-overlay open" id="restockModal" style="z-index:2200;">
            <div class="modal" style="max-width:420px;">
                <button class="modal-close" id="closeRestockModalBtn">✕</button>
                <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:0.5rem;">➕ Restocker</h2>
                <p style="text-align:center;font-size:0.85rem;color:var(--text-muted);margin-bottom:1.2rem;"><strong>${name}</strong></p>
                <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.8rem;margin-bottom:1rem;text-align:center;">
                    <div style="font-size:0.8rem;color:var(--text-muted);">Stock actuel</div>
                    <div style="font-size:1.6rem;font-weight:800;">${currentStock}</div>
                </div>
                <label style="display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.4rem;">Combien à ajouter ?</label>
                <input type="number" id="restockQuantityInput" min="1" value="1" style="width:100%;padding:0.8rem;border:2px solid var(--border-gold);border-radius:var(--radius-sm);text-align:center;font-weight:700;font-size:1.4rem;margin-bottom:1rem;">
                <div style="background:rgba(46,204,113,0.08);border:1px solid rgba(46,204,113,0.3);border-radius:var(--radius-sm);padding:0.8rem;margin-bottom:1.2rem;text-align:center;">
                    <div style="font-size:0.75rem;color:var(--text-muted);">Nouveau stock</div>
                    <div style="font-size:1.8rem;font-weight:800;color:var(--success);" id="restockNewStockPreview">${currentStock + 1}</div>
                </div>
                <div style="display:flex;gap:0.5rem;justify-content:center;">
                    <button id="cancelRestockBtn" style="padding:0.7rem 1.2rem;background:transparent;border:1px solid var(--border);border-radius:30px;cursor:pointer;">Annuler</button>
                    <button id="confirmRestockBtn" style="padding:0.7rem 1.2rem;background:linear-gradient(135deg,var(--gold),#7d5a1d);color:#fff;border:none;border-radius:30px;font-weight:700;cursor:pointer;">✅ Ajouter</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = document.getElementById('restockModal');
    const qtyInput = document.getElementById('restockQuantityInput');
    const preview = document.getElementById('restockNewStockPreview');
    const closeModal = () => modal?.remove();

    document.getElementById('closeRestockModalBtn').addEventListener('click', closeModal);
    document.getElementById('cancelRestockBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    qtyInput.addEventListener('input', () => {
        let q = parseInt(qtyInput.value) || 1;
        if (q < 1) q = 1;
        preview.textContent = currentStock + q;
    });
    setTimeout(() => { qtyInput.focus(); qtyInput.select(); }, 100);

    document.getElementById('confirmRestockBtn').addEventListener('click', async () => {
        const qty = parseInt(qtyInput.value) || 1;
        if (qty < 1) { showToast('⚠️ Quantité invalide'); return; }
        const btn = document.getElementById('confirmRestockBtn');
        btn.disabled = true;
        btn.textContent = '⏳...';
        try {
            await updateDoc(doc(db, "products", productId), { stock: increment(qty), updatedAt: Timestamp.now() });
            showToast('✅ Stock +' + qty);
            closeModal();
            await loadProducts();
            await loadStats();
        } catch (e) {
            showToast('❌ ' + e.message);
            btn.disabled = false;
            btn.textContent = '✅ Ajouter';
        }
    });
}

// ============================================================
// FORMULAIRE PRODUIT
// ============================================================
function attachProductFormEvents() {
    const pNameFr = document.getElementById('pNameFr');
    const pSlug = document.getElementById('pSlug');
    if (pNameFr && pSlug) {
        pNameFr.addEventListener('input', () => {
            if (!document.getElementById('productEditId').value) pSlug.value = slugify(pNameFr.value);
        });
    }
    const imgUrl = document.getElementById('pImg');
    const imgPreview = document.getElementById('pImgPreview');
    if (imgUrl && imgPreview) {
        imgUrl.addEventListener('input', () => {
            const url = imgUrl.value.trim();
            if (url) { imgPreview.src = url; imgPreview.style.display = 'block'; }
            else imgPreview.style.display = 'none';
        });
    }
    const imgFile = document.getElementById('pImgFile');
    if (imgFile && imgPreview) {
        imgFile.addEventListener('change', () => {
            const file = imgFile.files[0];
            if (!file) return;
            const r = new FileReader();
            r.onload = (e) => { imgPreview.src = e.target.result; imgPreview.style.display = 'block'; };
            r.readAsDataURL(file);
        });
    }
    const galleryFiles = document.getElementById('pGalleryFiles');
    const galleryPreview = document.getElementById('pGalleryPreview');
    if (galleryFiles && galleryPreview) {
        galleryFiles.addEventListener('change', () => {
            galleryPreview.innerHTML = '';
            Array.from(galleryFiles.files).forEach(file => {
                const r = new FileReader();
                r.onload = (e) => {
                    const img = document.createElement('img');
                    img.src = e.target.result;
                    galleryPreview.appendChild(img);
                };
                r.readAsDataURL(file);
            });
        });
    }
    
    // ✅ BOUTON EFFACER VIDÉO
    const clearVideoBtn = document.getElementById('clearVideoBtn');
    if (clearVideoBtn) {
        clearVideoBtn.addEventListener('click', () => {
            document.getElementById('pVideo').value = '';
            showToast('🗑️ Champ vidéo vidé (sera supprimé à l\'enregistrement)');
        });
    }

    document.getElementById('saveProductBtn')?.addEventListener('click', saveProduct);
    document.getElementById('cancelProductEdit')?.addEventListener('click', resetProductForm);
}

// ✅ GÉNÉRATION DES VARIANTES
function generateVariants() {
    const sizesRaw = document.getElementById('pSizes').value.trim();
    const colorsRaw = document.getElementById('pColors').value.trim();
    
    const sizes = sizesRaw ? sizesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const colors = colorsRaw ? colorsRaw.split(',').map(c => c.trim()).filter(Boolean) : [];
    
    const container = document.getElementById('variantsContainer');
    const tbody = document.querySelector('#variantsTable tbody');
    
    if (sizes.length === 0 && colors.length === 0) {
        container.style.display = 'none';
        tbody.innerHTML = '';
        return;
    }

    tbody.innerHTML = '';
    container.style.display = 'block';

    // On génère les combinaisons
    const combinations = [];
    if (sizes.length > 0 && colors.length > 0) {
        sizes.forEach(s => colors.forEach(c => combinations.push({ size: s, color: c })));
    } else if (sizes.length > 0) {
        sizes.forEach(s => combinations.push({ size: s, color: '' }));
    } else if (colors.length > 0) {
        colors.forEach(c => combinations.push({ size: '', color: c }));
    }

    // Prix et stock par défaut (ceux du formulaire principal)
    const defaultPrice = parseFloat(document.getElementById('pPrice').value) || 0;
    const defaultStock = parseInt(document.getElementById('pStock').value) || 0;

    combinations.forEach(combo => {
        const label = [combo.size, combo.color].filter(Boolean).join(' - ');
        const tr = document.createElement('tr');
        tr.dataset.size = combo.size;
        tr.dataset.color = combo.color;
        
        tr.innerHTML = `
            <td style="font-weight:600;font-size:0.85rem;">${label}</td>
            <td><input type="number" class="var-price" value="${defaultPrice}" min="0" style="width:100%;padding:0.3rem;border:1px solid var(--border);border-radius:4px;text-align:center;"></td>
            <td><input type="number" class="var-stock" value="${defaultStock}" min="0" style="width:100%;padding:0.3rem;border:1px solid var(--border);border-radius:4px;text-align:center;"></td>
        `;
        tbody.appendChild(tr);
    });
}

function resetProductForm() {
    document.getElementById('productFormTitle').textContent = '➕ ' + t('adminAddProduct');
    document.getElementById('productEditId').value = '';
    
    ['pNameFr', 'pNameAr', 'pNameEn', 'pSlug', 'pPrice', 'pOldPrice', 'pPurchasePrice', 'pStock', 'pRating',
     'pDescFr', 'pDescAr', 'pDescEn', 'pFeaturesFr', 'pFeaturesAr', 'pFeaturesEn', 'pImg', 'pGallery', 'pVideo',
     'pWeight', 'pLength', 'pWidth', 'pHeight', 'pSizes', 'pColors'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        
    document.getElementById('pParentCategory').value = '';
    document.getElementById('pCategory').innerHTML = '<option value="">-- Choisir une sous-catégorie --</option>';
    document.getElementById('pIsNew').checked = false;
    document.getElementById('pSizeGuide').checked = false;
    
    document.getElementById('variantsContainer').style.display = 'none';
    document.querySelector('#variantsTable tbody').innerHTML = '';

    document.getElementById('pImgFile').value = '';
    document.getElementById('pGalleryFiles').value = '';
    document.getElementById('pImgPreview').style.display = 'none';
    document.getElementById('pGalleryPreview').innerHTML = '';
    document.getElementById('saveProductBtnText').textContent = t('save');
    document.getElementById('cancelProductEdit').style.display = 'none';
    document.getElementById('tab-products')?.scrollIntoView({ behavior: 'smooth' });
}

async function editProduct(id) {
    try {
        const snap = await getDoc(doc(db, "products", id));
        if (!snap.exists()) return;
        const p = snap.data();
        document.getElementById('productFormTitle').textContent = '✏️ ' + t('adminEditProduct');
        document.getElementById('productEditId').value = id;
        document.getElementById('pNameFr').value = p.nameFr || '';
        document.getElementById('pNameAr').value = p.nameAr || '';
        document.getElementById('pNameEn').value = p.nameEn || '';
        document.getElementById('pSlug').value = p.slug || '';
        
        // Catégorie
        const parentSelect = document.getElementById('pParentCategory');
        const childSelect = document.getElementById('pCategory');
        
        let foundParentId = '';
        CATEGORY_GROUPS.forEach(g => {
            if (g.children.some(c => c.id === p.category)) foundParentId = g.id;
        });

        if (foundParentId) {
            parentSelect.value = foundParentId;
            parentSelect.dispatchEvent(new Event('change')); // Déclenche le remplissage des enfants
            childSelect.value = p.category || '';
        } else {
            // Si ancienne catégorie pas dans l'arborescence
            parentSelect.value = '';
            childSelect.innerHTML = `<option value="${p.category}">${p.category} (Ancienne)</option>`;
            childSelect.value = p.category || '';
        }

        document.getElementById('pPrice').value = p.price || '';
        document.getElementById('pOldPrice').value = p.oldPrice || '';
        document.getElementById('pPurchasePrice').value = p.purchasePrice || '';
        document.getElementById('pStock').value = p.stock || '';
        document.getElementById('pRating').value = p.ratingAvg || '';
        document.getElementById('pIsNew').checked = !!p.isNew;
        document.getElementById('pSizeGuide').checked = !!p.hasSizeGuide;
        
        // Dimensions
        document.getElementById('pWeight').value = p.dimensions?.weight || '';
        document.getElementById('pLength').value = p.dimensions?.length || '';
        document.getElementById('pWidth').value = p.dimensions?.width || '';
        document.getElementById('pHeight').value = p.dimensions?.height || '';
        
        // Variantes
        const variantsContainer = document.getElementById('variantsContainer');
        const variantsTbody = document.querySelector('#variantsTable tbody');
        variantsTbody.innerHTML = '';
        
        if (p.variants && p.variants.length > 0) {
            // Extraire les tailles et couleurs uniques
            const sizes = [...new Set(p.variants.map(v => v.size).filter(Boolean))];
            const colors = [...new Set(p.variants.map(v => v.color).filter(Boolean))];
            document.getElementById('pSizes').value = sizes.join(', ');
            document.getElementById('pColors').value = colors.join(', ');
            
            variantsContainer.style.display = 'block';
            p.variants.forEach(combo => {
                const label = [combo.size, combo.color].filter(Boolean).join(' - ');
                const tr = document.createElement('tr');
                tr.dataset.size = combo.size || '';
                tr.dataset.color = combo.color || '';
                tr.innerHTML = `
                    <td style="font-weight:600;font-size:0.85rem;">${label}</td>
                    <td><input type="number" class="var-price" value="${combo.price || p.price}" min="0" style="width:100%;padding:0.3rem;border:1px solid var(--border);border-radius:4px;text-align:center;"></td>
                    <td><input type="number" class="var-stock" value="${combo.stock || 0}" min="0" style="width:100%;padding:0.3rem;border:1px solid var(--border);border-radius:4px;text-align:center;"></td>
                `;
                variantsTbody.appendChild(tr);
            });
        } else {
            document.getElementById('pSizes').value = '';
            document.getElementById('pColors').value = '';
            variantsContainer.style.display = 'none';
        }

        document.getElementById('pDescFr').value = p.descFr || '';
        document.getElementById('pDescAr').value = p.descAr || '';
        document.getElementById('pDescEn').value = p.descEn || '';
        document.getElementById('pFeaturesFr').value = (p.featuresFr || []).join('\n');
        document.getElementById('pFeaturesAr').value = (p.featuresAr || []).join('\n');
        document.getElementById('pFeaturesEn').value = (p.featuresEn || []).join('\n');
        document.getElementById('pImg').value = p.img || '';
        document.getElementById('pGallery').value = (p.gallery || []).join(', ');
        document.getElementById('pVideo').value = p.video || '';
        
        const ip = document.getElementById('pImgPreview');
        if (p.img && typeof p.img === 'string') { 
            ip.src = p.img.startsWith('http') ? p.img : '/' + p.img; 
            ip.style.display = 'block'; 
        }
        else ip.style.display = 'none';
        const gp = document.getElementById('pGalleryPreview');
        gp.innerHTML = '';
        (p.gallery || []).forEach(url => {
            const img = document.createElement('img');
            img.src = url.startsWith('http') ? url : '/' + url;
            gp.appendChild(img);
        });
        document.getElementById('saveProductBtnText').textContent = t('save');
        document.getElementById('cancelProductEdit').style.display = 'inline-flex';
        document.getElementById('tab-products')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { showToast('❌ ' + t('loadError')); }
}

async function saveProduct() {
    const editId = document.getElementById('productEditId').value;
    const saveBtn = document.getElementById('saveProductBtn');
    const btnText = document.getElementById('saveProductBtnText');
    const nameFr = document.getElementById('pNameFr').value.trim();
    const slug = document.getElementById('pSlug').value.trim();
    const priceRaw = parseFloat(document.getElementById('pPrice').value);
    const purchasePriceRaw = parseFloat(document.getElementById('pPurchasePrice').value);
    const stockRaw = parseInt(document.getElementById('pStock').value);
    const category = document.getElementById('pCategory').value;

    if (!nameFr) { showToast('⚠️ ' + t('adminProductNameRequired')); return; }
    if (!slug) { showToast('⚠️ ' + t('adminProductSlugRequired')); return; }
    if (!category) { showToast('⚠️ Sélectionnez une sous-catégorie'); return; }
    if (isNaN(priceRaw) || priceRaw < 0) { showToast('⚠️ ' + t('adminProductPriceInvalid')); return; }
    if (isNaN(stockRaw) || stockRaw < 0) { showToast('⚠️ ' + t('adminProductStockInvalid')); return; }

    saveBtn.disabled = true;
    const oldText = btnText.textContent;
    btnText.textContent = '⏳ ' + t('loading');

    try {
        let imgUrl = document.getElementById('pImg').value.trim();
        const imgFile = document.getElementById('pImgFile').files[0];
        if (imgFile) {
            const storageRef = ref(storage, `products/${Date.now()}_${imgFile.name}`);
            await uploadBytes(storageRef, imgFile);
            imgUrl = await getDownloadURL(storageRef);
        }
        let gallery = document.getElementById('pGallery').value.split(',').map(u => u.trim()).filter(u => u);
        const galleryFiles = document.getElementById('pGalleryFiles').files;
        for (const file of Array.from(galleryFiles)) {
            const gRef = ref(storage, `products/gallery/${Date.now()}_${file.name}`);
            await uploadBytes(gRef, file);
            gallery.push(await getDownloadURL(gRef));
        }

        const videoValue = document.getElementById('pVideo').value.trim();

        // Gestion des variantes
        const variants = [];
        const variantsTbody = document.querySelector('#variantsTable tbody');
        if (document.getElementById('variantsContainer').style.display !== 'none') {
            variantsTbody.querySelectorAll('tr').forEach(tr => {
                variants.push({
                    size: tr.dataset.size || '',
                    color: tr.dataset.color || '',
                    price: parseFloat(tr.querySelector('.var-price').value) || priceRaw,
                    stock: parseInt(tr.querySelector('.var-stock').value) || 0
                });
            });
        }

        // Si des variantes existent, le stock global est la somme des stocks des variantes
        let finalStock = stockRaw;
        if (variants.length > 0) {
            finalStock = variants.reduce((sum, v) => sum + v.stock, 0);
        }

        // Dimensions
        const dimensions = {
            weight: parseFloat(document.getElementById('pWeight').value) || 0,
            length: parseFloat(document.getElementById('pLength').value) || 0,
            width: parseFloat(document.getElementById('pWidth').value) || 0,
            height: parseFloat(document.getElementById('pHeight').value) || 0
        };

        const productData = {
            nameFr,
            nameAr: document.getElementById('pNameAr').value.trim(),
            nameEn: document.getElementById('pNameEn').value.trim(),
            slug,
            category,
            price: priceRaw,
            oldPrice: Math.max(0, parseFloat(document.getElementById('pOldPrice').value) || 0),
            purchasePrice: isNaN(purchasePriceRaw) ? 0 : purchasePriceRaw,
            stock: finalStock,
            ratingAvg: Math.min(5, Math.max(0, parseFloat(document.getElementById('pRating').value) || 0)),
            isNew: document.getElementById('pIsNew').checked,
            hasSizeGuide: document.getElementById('pSizeGuide').checked,
            dimensions,
            variants,
            descFr: document.getElementById('pDescFr').value.trim(),
            descAr: document.getElementById('pDescAr').value.trim(),
            descEn: document.getElementById('pDescEn').value.trim(),
            featuresFr: document.getElementById('pFeaturesFr').value.split('\n').map(l => l.trim()).filter(l => l),
            featuresAr: document.getElementById('pFeaturesAr').value.split('\n').map(l => l.trim()).filter(l => l),
            featuresEn: document.getElementById('pFeaturesEn').value.split('\n').map(l => l.trim()).filter(l => l),
            img: imgUrl, gallery, 
            video: videoValue || deleteField(),
            updatedAt: Timestamp.now()
        };

        if (editId) {
            const oldSnap = await getDoc(doc(db, "products", editId));
            const oldData = oldSnap.exists() ? oldSnap.data() : {};
            await updateDoc(doc(db, "products", editId), productData);
            showToast('✅ ' + t('success'));
            const orphans = [];
            if (oldData.img && oldData.img !== imgUrl && isStorageUrl(oldData.img)) orphans.push(oldData.img);
            const newSet = new Set(gallery);
            (oldData.gallery || []).forEach(u => { if (isStorageUrl(u) && !newSet.has(u)) orphans.push(u); });
            if (orphans.length) await deleteStorageImages(orphans);
        } else {
            const newId = Date.now().toString();
            productData.createdAt = Timestamp.now();
            productData.salesCount = 0;
            productData.ratingCount = 0;
            if (!videoValue) delete productData.video; 
            await setDoc(doc(db, "products", newId), productData);
            showToast('✅ ' + t('success'));
        }
        resetProductForm();
        await loadProducts();
        await loadStats();
    } catch (e) {
        showToast('❌ ' + (e.message || t('error')));
    } finally {
        saveBtn.disabled = false;
        btnText.textContent = oldText;
    }
}

async function deleteProduct(id) {
    const confirmed = await confirmAction(t('confirmDeleteProductMsg'), {
        title: t('confirmDeleteProductTitle'), confirmText: t('confirmDeleteYes'),
        cancelText: t('confirmDeleteNo'), variant: 'danger'
    });
    if (!confirmed) return;
    try {
        const snap = await getDoc(doc(db, "products", id));
        if (!snap.exists()) { showToast('⚠️ ' + t('productNotFound')); return; }
        const product = snap.data();
        await deleteDoc(doc(db, "products", id));
        const toDel = [];
        if (isStorageUrl(product.img)) toDel.push(product.img);
        (product.gallery || []).forEach(u => { if (isStorageUrl(u)) toDel.push(u); });
        if (toDel.length) await deleteStorageImages(toDel);
        showToast('🗑️ ' + t('delete'));
        await loadProducts();
        await loadStats();
    } catch (e) { showToast('❌ ' + t('error')); }
}

// ============================================================
// COMMANDES / CLIENTS / AVIS
// ============================================================
async function loadOrders() { await renderAdminOrders('adminOrdersList'); }
async function loadReviews() { await renderAdminReviews('reviewsList', 'all'); }

async function loadUsers() {
    const container = document.getElementById('adminUsersList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ ${t('loading')}</div>`;
    try {
        const snap = await getDocs(collection(db, "users"));
        cachedUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderUsersList(cachedUsers);
    } catch (e) {
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">${t('error')}</div>`;
    }
}

function renderUsersList(users) {
    const container = document.getElementById('adminUsersList');
    if (!container) return;
    if (users.length === 0) { container.innerHTML = `<div class="admin-empty">${t('noOrders')}</div>`; return; }
    let html = '';
    users.forEach(u => {
        const name = escapeHTML(u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || '—');
        const email = escapeHTML(u.email || '');
        const phone = escapeHTML(u.phone || '');
        const role = u.role || 'user';
        const signupMethod = u.signupMethod || 'otp';
        const methodEmoji = getSignupMethodEmoji(signupMethod);
        const methodLabel = getSignupMethodLabel(signupMethod);
        html += `
            <div class="admin-list-item" data-user-id="${u.id}">
                <div class="admin-list-item-info">
                    <strong>${name}</strong>
                    <div style="font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem;">📧 ${email} ${phone ? `· 📞 ${phone}` : ''}</div>
                    <div style="font-size:0.75rem;color:var(--text-dim);margin-top:0.2rem;display:flex;gap:0.6rem;flex-wrap:wrap;">
                        <span>${methodEmoji} ${t('signupMethod')} : <strong style="color:var(--gold);">${methodLabel}</strong></span>
                        <span>${t('profile')} : <strong style="color:${role === 'admin' ? 'var(--gold)' : 'var(--text-muted)'};">${role}</strong></span>
                    </div>
                </div>
                <div class="admin-list-item-actions">
                    <select class="admin-btn-icon" data-action="change-role" data-id="${u.id}" style="padding:0.3rem 0.6rem;border-radius:30px;">
                        <option value="user" ${role === 'user' ? 'selected' : ''}>👤 User</option>
                        <option value="admin" ${role === 'admin' ? 'selected' : ''}>🔑 Admin</option>
                    </select>
                    <button class="admin-btn-icon admin-btn-danger" data-action="delete-user" data-id="${u.id}">🗑️</button>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;

    container.querySelectorAll('[data-action="change-role"]').forEach(sel => {
        sel.addEventListener('change', async () => {
            const userId = sel.dataset.id;
            const newRole = sel.value;
            if (currentAdmin && userId === currentAdmin.uid && newRole !== ROLES.ADMIN) {
                showToast('⚠️ ' + t('adminCantRemoveSelf'));
                sel.value = ROLES.ADMIN;
                return;
            }
            try {
                await updateDoc(doc(db, "users", userId), { role: newRole });
                showToast('✅ ' + t('success'));
            } catch (e) {
                showToast('❌ ' + t('error'));
                sel.value = newRole === 'admin' ? 'user' : 'admin';
            }
        });
    });

    container.querySelectorAll('[data-action="delete-user"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const userId = btn.dataset.id;
            if (currentAdmin && userId === currentAdmin.uid) {
                showToast('⚠️ ' + t('adminCantDeleteSelf'));
                return;
            }
            const confirmed = await confirmAction(t('confirmDeleteUserMsg'), {
                title: t('confirmDeleteUserTitle'), confirmText: t('confirmDeleteYes'),
                cancelText: t('confirmDeleteNo'), variant: 'danger'
            });
            if (!confirmed) return;
            try {
                await deleteDoc(doc(db, "users", userId));
                showToast('🗑️ ' + t('delete'));
                await loadUsers();
                await loadStats();
            } catch (e) { showToast('❌ ' + t('error')); }
        });
    });
}

function filterUsersList() {
    const search = document.getElementById('userSearchAdmin')?.value.toLowerCase().trim() || '';
    const activeFilter = document.querySelector('[data-signup-filter].active');
    const signupFilter = activeFilter?.dataset.signupFilter || 'all';
    let filtered = cachedUsers;
    if (signupFilter !== 'all') filtered = filtered.filter(u => (u.signupMethod || 'otp') === signupFilter);
    if (search) filtered = filtered.filter(u => {
        const name = (u.name || `${u.firstName || ''} ${u.lastName || ''}`).toLowerCase();
        const email = (u.email || '').toLowerCase();
        return name.includes(search) || email.includes(search);
    });
    renderUsersList(filtered);
}

// ============================================================
// BLOG
// ============================================================
async function loadBlogPosts() {
    const container = document.getElementById('adminBlogList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ ${t('blogLoading')}</div>`;
    try {
        const snap = await getDocs(collection(db, "blog"));
        cachedBlogPosts = snap.docs.map(d => {
            const data = d.data();
            return {
                id: d.id, ...data,
                createdAt: toDate(data.createdAt),
                updatedAt: toDate(data.updatedAt),
                publishedAt: toDate(data.publishedAt)
            };
        });
        cachedBlogPosts.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
        blogCurrentPage = 1;
        renderBlogListAdmin(cachedBlogPosts);
    } catch (e) {
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">${t('loadingError')}</div>`;
    }
}

function renderBlogListAdmin(posts) {
    const container = document.getElementById('adminBlogList');
    if (!container) return;
    if (posts.length === 0) { container.innerHTML = `<div class="admin-empty">${t('blogAdminEmpty')}</div>`; return; }
    const totalPages = Math.max(1, Math.ceil(posts.length / BLOG_PER_PAGE));
    if (blogCurrentPage > totalPages) blogCurrentPage = totalPages;
    const start = (blogCurrentPage - 1) * BLOG_PER_PAGE;
    const pagePosts = posts.slice(start, start + BLOG_PER_PAGE);
    let html = '';
    pagePosts.forEach(post => {
        const title = escapeHTML(post.title || 'Sans titre');
        const categoryLabel = escapeHTML(tBlogCategory(post.category || 'general'));
        const status = post.status || 'draft';
        const statusLabel = status === 'published' ? '✅ ' + t('blogAdminFormStatusPublished') : '📝 ' + t('blogAdminFormStatusDraft');
        const statusClass = status === 'published' ? 'published' : 'draft';
        const date = post.publishedAt ? post.publishedAt.toLocaleDateString('fr-FR') : (post.createdAt ? post.createdAt.toLocaleDateString('fr-FR') : '—');
        const thumb = post.image ? `<img src="${escapeHTML(post.image)}" class="admin-blog-thumb" alt="Cover">` : `<div class="admin-blog-thumb" style="display:flex;align-items:center;justify-content:center;font-size:2rem;background:var(--bg-surface);">📝</div>`;
        html += `
            <div class="admin-blog-item" data-post-id="${post.id}">
                ${thumb}
                <div class="admin-blog-info">
                    <h4>${title}</h4>
                    <div class="meta">📂 ${categoryLabel} · 📅 ${date} · <span class="status ${statusClass}">${statusLabel}</span></div>
                    <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
                        <button class="admin-btn-icon" data-action="edit-post" data-id="${post.id}">✏️ ${t('edit')}</button>
                        <button class="admin-btn-icon admin-btn-danger" data-action="delete-post" data-id="${post.id}">🗑️</button>
                    </div>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
    container.querySelectorAll('[data-action="edit-post"]').forEach(btn => btn.addEventListener('click', () => editBlogPost(btn.dataset.id)));
    container.querySelectorAll('[data-action="delete-post"]').forEach(btn => btn.addEventListener('click', () => deleteBlogPost(btn.dataset.id)));
}

function filterBlogList(resetPage = true) {
    const search = document.getElementById('blogSearchAdmin')?.value.toLowerCase().trim() || '';
    let filtered = cachedBlogPosts;
    if (search) filtered = filtered.filter(p => (p.title || '').toLowerCase().includes(search) || (p.slug || '').toLowerCase().includes(search));
    if (resetPage) blogCurrentPage = 1;
    renderBlogListAdmin(filtered);
}

function attachBlogFormEvents() {
    const titleInput = document.getElementById('bTitle');
    const slugInput = document.getElementById('bSlug');
    if (titleInput && slugInput) {
        titleInput.addEventListener('input', () => {
            if (!document.getElementById('blogEditId').value) slugInput.value = slugify(titleInput.value);
        });
    }
    const imgUrl = document.getElementById('bImage');
    const imgPreview = document.getElementById('bImagePreview');
    if (imgUrl && imgPreview) {
        imgUrl.addEventListener('input', () => {
            const url = imgUrl.value.trim();
            if (url) { imgPreview.src = url; imgPreview.style.display = 'block'; }
            else imgPreview.style.display = 'none';
        });
    }
    const imgFile = document.getElementById('bImageFile');
    if (imgFile && imgPreview) {
        imgFile.addEventListener('change', () => {
            const file = imgFile.files[0];
            if (!file) return;
            const r = new FileReader();
            r.onload = (e) => { imgPreview.src = e.target.result; imgPreview.style.display = 'block'; };
            r.readAsDataURL(file);
        });
    }
    const catSelect = document.getElementById('bCategory');
    if (catSelect && !catSelect._populated) {
        let html = '';
        (CONFIG.BLOG.CATEGORIES || []).filter(c => c.id !== 'all').forEach(cat => {
            html += `<option value="${cat.id}">${cat.emoji} ${tBlogCategory(cat.id)}</option>`;
        });
        catSelect.innerHTML = html;
        catSelect._populated = true;
    }
    document.getElementById('saveBlogBtn')?.addEventListener('click', saveBlogPost);
    document.getElementById('cancelBlogEdit')?.addEventListener('click', resetBlogForm);
}

function resetBlogForm() {
    document.getElementById('blogFormTitle').textContent = t('blogAdminAdd');
    document.getElementById('blogEditId').value = '';
    ['bTitle', 'bSlug', 'bExcerpt', 'bContent', 'bImage', 'bTags'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('bCategory').value = 'conseils';
    document.getElementById('bImageFile').value = '';
    document.getElementById('bStatus').value = 'draft';
    document.getElementById('bAuthor').value = 'Smart Swi9a';
    document.getElementById('bImagePreview').style.display = 'none';
    document.getElementById('saveBlogBtnText').textContent = t('blogAdminFormSave');
    document.getElementById('cancelBlogEdit').style.display = 'none';
}

async function editBlogPost(id) {
    try {
        const snap = await getDoc(doc(db, "blog", id));
        if (!snap.exists()) return;
        const p = snap.data();
        document.getElementById('blogFormTitle').textContent = t('blogAdminEdit');
        document.getElementById('blogEditId').value = id;
        document.getElementById('bTitle').value = p.title || '';
        document.getElementById('bSlug').value = p.slug || '';
        document.getElementById('bCategory').value = p.category || 'conseils';
        document.getElementById('bExcerpt').value = p.excerpt || '';
        document.getElementById('bContent').value = p.content || '';
        document.getElementById('bImage').value = p.image || '';
        document.getElementById('bStatus').value = p.status || 'draft';
        document.getElementById('bAuthor').value = p.author || 'Smart Swi9a';
        document.getElementById('bTags').value = (p.tags || []).join(', ');
        const ip = document.getElementById('bImagePreview');
        if (p.image && typeof p.image === 'string') { 
            ip.src = p.image.startsWith('http') ? p.image : '/' + p.image; 
            ip.style.display = 'block'; 
        }
        else ip.style.display = 'none';
        document.getElementById('saveBlogBtnText').textContent = t('save');
        document.getElementById('cancelBlogEdit').style.display = 'inline-flex';
        document.getElementById('tab-blog')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { showToast('❌ ' + t('loadError')); }
}

async function saveBlogPost() {
    const editId = document.getElementById('blogEditId').value;
    const saveBtn = document.getElementById('saveBlogBtn');
    const btnText = document.getElementById('saveBlogBtnText');
    const title = document.getElementById('bTitle').value.trim();
    const slug = document.getElementById('bSlug').value.trim();
    const content = document.getElementById('bContent').value.trim();
    if (!title) { showToast('⚠️ ' + t('blogAdminFormTitle')); return; }
    if (!slug) { showToast('⚠️ ' + t('blogAdminFormSlug')); return; }
    if (!content) { showToast('⚠️ ' + t('blogAdminFormContent')); return; }

    saveBtn.disabled = true;
    const oldText = btnText.textContent;
    btnText.textContent = '⏳ ' + t('loading');
    try {
        let imgUrl = document.getElementById('bImage').value.trim();
        const imgFile = document.getElementById('bImageFile').files[0];
        if (imgFile) {
            const storageRef = ref(storage, `blog/${Date.now()}_${imgFile.name}`);
            await uploadBytes(storageRef, imgFile);
            imgUrl = await getDownloadURL(storageRef);
        }
        const status = document.getElementById('bStatus').value;
        const tagsRaw = document.getElementById('bTags').value;
        const postData = {
            title, slug,
            category: document.getElementById('bCategory').value,
            excerpt: document.getElementById('bExcerpt').value.trim(),
            content, image: imgUrl, status,
            author: document.getElementById('bAuthor').value.trim() || 'Smart Swi9a',
            tags: tagsRaw.split(',').map(x => x.trim()).filter(x => x),
            updatedAt: Timestamp.now()
        };
        if (status === 'published') postData.publishedAt = Timestamp.now();
        if (editId) {
            const oldSnap = await getDoc(doc(db, "blog", editId));
            const oldData = oldSnap.exists() ? oldSnap.data() : {};
            await updateDoc(doc(db, "blog", editId), postData);
            showToast('✅ ' + t('blogAdminUpdated'));
            if (oldData.image && oldData.image !== imgUrl && isStorageUrl(oldData.image)) {
                await deleteStorageImage(oldData.image);
            }
        } else {
            postData.createdAt = Timestamp.now();
            await setDoc(doc(db, "blog", Date.now().toString()), postData);
            showToast('✅ ' + t('blogAdminSaved'));
        }
        resetBlogForm();
        await loadBlogPosts();
    } catch (e) {
        showToast('❌ ' + (e.message || t('error')));
    } finally {
        saveBtn.disabled = false;
        btnText.textContent = oldText;
    }
}

async function deleteBlogPost(id) {
    const confirmed = await confirmAction(t('confirmDeletePostMsg'), {
        title: t('confirmDeletePostTitle'), confirmText: t('confirmDeleteYes'),
        cancelText: t('confirmDeleteNo'), variant: 'danger'
    });
    if (!confirmed) return;
    try {
        const snap = await getDoc(doc(db, "blog", id));
        if (!snap.exists()) { showToast('⚠️ ' + t('articleNotFound')); return; }
        const post = snap.data();
        await deleteDoc(doc(db, "blog", id));
        if (post.image && isStorageUrl(post.image)) await deleteStorageImage(post.image);
        showToast('🗑️ ' + t('blogAdminDeleted'));
        await loadBlogPosts();
    } catch (e) { showToast('❌ ' + t('error')); }
}

// ============================================================
// CODES PROMO
// ============================================================
async function loadCoupons() {
    const container = document.getElementById('couponsList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ ${t('loading')}</div>`;

    try {
        const snap = await getDocs(collection(db, "coupons"));
        cachedCoupons = snap.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                expiresAt: data.expiresAt ? toDate(data.expiresAt) : null,
                createdAt: toDate(data.createdAt),
                updatedAt: toDate(data.updatedAt)
            };
        });
        cachedCoupons.sort((a, b) => {
            if (a.isActive !== b.isActive) return b.isActive ? 1 : -1;
            return (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0);
        });
        renderCouponsList(cachedCoupons);
    } catch (e) {
        console.error('❌ Erreur loadCoupons :', e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">❌ ${e.message || t('loadingError')}</div>`;
    }
}

function renderCouponsList(coupons) {
    const container = document.getElementById('couponsList');
    if (!container) return;

    if (coupons.length === 0) {
        container.innerHTML = `
            <div class="admin-empty" style="padding:3rem 1rem;">
                <div style="font-size:3rem;margin-bottom:0.5rem;">🎟️</div>
                <p>Aucun code promo pour le moment.<br>Créez-en un avec le formulaire ci-dessus.</p>
            </div>
        `;
        return;
    }

    const now = Date.now();
    let html = '';

    coupons.forEach(coupon => {
        const code = escapeHTML(coupon.code || '');
        const description = escapeHTML(coupon.description || '');
        const type = coupon.type || 'percentage';
        const typeMeta = COUPON_TYPES[type] || COUPON_TYPES.percentage;
        const value = Number(coupon.value) || 0;
        const minPurchase = Number(coupon.minPurchase) || 0;
        const maxUses = Number(coupon.maxUses) || 0;
        const usedCount = Number(coupon.usedCount) || 0;
        const isActive = coupon.isActive === true;
        const oneUsePerUser = coupon.oneUsePerUser === true;
        const expiresAt = coupon.expiresAt;
        const isExpired = expiresAt && expiresAt.getTime() < now;
        const isFull = maxUses > 0 && usedCount >= maxUses;

        let statusLabel, statusClass;
        if (!isActive) {
            statusLabel = '⏸️ Désactivé';
            statusClass = 'coupon-status-inactive';
        } else if (isExpired) {
            statusLabel = '⏰ Expiré';
            statusClass = 'coupon-status-expired';
        } else if (isFull) {
            statusLabel = '🚫 Épuisé';
            statusClass = 'coupon-status-expired';
        } else {
            statusLabel = '✅ Actif';
            statusClass = 'coupon-status-active';
        }

        let valueLabel = '';
        if (type === 'percentage') valueLabel = `-${value}%`;
        else if (type === 'fixed') valueLabel = `-${value} MAD`;
        else if (type === 'free_shipping') valueLabel = 'Livraison offerte';

        let progressHtml = '';
        if (maxUses > 0) {
            const percent = Math.min(100, (usedCount / maxUses) * 100);
            const fillClass = percent >= 100 ? 'full' : '';
            progressHtml = `
                <div class="coupon-meta" style="margin-top:0.2rem;">
                    <span>📊 Utilisations : <strong>${usedCount}/${maxUses}</strong></span>
                </div>
                <div class="coupon-progress">
                    <div class="coupon-progress-fill ${fillClass}" style="width:${percent}%"></div>
                </div>
            `;
        } else {
            progressHtml = `
                <div class="coupon-meta" style="margin-top:0.2rem;">
                    <span>📊 Utilisations : <strong>${usedCount}</strong> <span style="color:var(--text-dim);">(illimité)</span></span>
                </div>
            `;
        }

        let expireLabel = '<span style="color:var(--text-dim);">Jamais</span>';
        if (expiresAt) {
            const dateStr = expiresAt.toLocaleDateString('fr-FR');
            expireLabel = isExpired
                ? `<span style="color:var(--danger);font-weight:700;">⚠️ Expiré le ${dateStr}</span>`
                : `<span style="color:var(--success);">📅 Expire le ${dateStr}</span>`;
        }

        const minLabel = minPurchase > 0
            ? `<span>🛒 Min : <strong>${minPurchase} MAD</strong></span>`
            : '';

        const oneUseLabel = oneUsePerUser
            ? `<span>👤 <strong>1 usage/client</strong></span>`
            : '';

        const cardClasses = ['coupon-card'];
        if (!isActive) cardClasses.push('is-inactive');
        if (isExpired || isFull) cardClasses.push('is-expired');

        html += `
            <div class="${cardClasses.join(' ')}" data-coupon-id="${coupon.id}">
                <div class="coupon-header">
                    <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;">
                        <span class="coupon-code-badge">${code}</span>
                        <span class="coupon-type-badge ${typeMeta.cssClass}">${typeMeta.emoji} ${valueLabel}</span>
                        <span class="coupon-status-badge ${statusClass}">${statusLabel}</span>
                    </div>
                </div>

                ${description ? `<div class="coupon-desc">💬 ${description}</div>` : ''}

                <div class="coupon-meta">
                    ${expireLabel}
                    ${minLabel}
                    ${oneUseLabel}
                </div>

                ${progressHtml}

                <div class="coupon-actions">
                    <button class="admin-btn-icon" data-action="coupon-toggle" data-id="${coupon.id}" title="${isActive ? 'Désactiver' : 'Activer'}">
                        ${isActive ? '⏸️ Désactiver' : '▶️ Activer'}
                    </button>
                    <button class="admin-btn-icon" data-action="coupon-edit" data-id="${coupon.id}">✏️ Modifier</button>
                    <button class="admin-btn-icon admin-btn-danger" data-action="coupon-delete" data-id="${coupon.id}">🗑️ Supprimer</button>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;

    container.querySelectorAll('[data-action="coupon-toggle"]').forEach(btn => {
        btn.addEventListener('click', () => toggleCouponActive(btn.dataset.id));
    });
    container.querySelectorAll('[data-action="coupon-edit"]').forEach(btn => {
        btn.addEventListener('click', () => editCoupon(btn.dataset.id));
    });
    container.querySelectorAll('[data-action="coupon-delete"]').forEach(btn => {
        btn.addEventListener('click', () => deleteCoupon(btn.dataset.id));
    });
}

function attachCouponFormEvents() {
    const codeInput = document.getElementById('cCode');
    if (codeInput) {
        codeInput.addEventListener('input', () => {
            const pos = codeInput.selectionStart;
            codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
            codeInput.setSelectionRange(pos, pos);
        });
    }

    const typeSelect = document.getElementById('cType');
    if (typeSelect) {
        typeSelect.addEventListener('change', () => {
            const valueInput = document.getElementById('cValue');
            if (!valueInput) return;
            if (typeSelect.value === 'percentage') valueInput.placeholder = '10';
            else if (typeSelect.value === 'fixed') valueInput.placeholder = '50';
            else { valueInput.value = '0'; valueInput.placeholder = '0'; }
        });
    }

    document.getElementById('saveCouponBtn')?.addEventListener('click', saveCoupon);
    document.getElementById('cancelCouponEdit')?.addEventListener('click', resetCouponForm);
}

function resetCouponForm() {
    document.getElementById('couponFormTitle').textContent = '➕ Créer un code promo';
    document.getElementById('couponEditId').value = '';
    document.getElementById('cCode').value = '';
    document.getElementById('cDescription').value = '';
    document.getElementById('cType').value = 'percentage';
    document.getElementById('cValue').value = '';
    document.getElementById('cValue').placeholder = '10';
    document.getElementById('cMinPurchase').value = '0';
    document.getElementById('cMaxUses').value = '0';
    document.getElementById('cExpiresAt').value = '';
    document.getElementById('cOneUsePerUser').checked = false;
    document.getElementById('cIsActive').checked = true;
    document.getElementById('saveCouponBtnText').textContent = 'Créer le code';
    document.getElementById('cancelCouponEdit').style.display = 'none';
}

async function editCoupon(id) {
    try {
        const snap = await getDoc(doc(db, "coupons", id));
        if (!snap.exists()) { showToast('❌ Coupon introuvable'); return; }
        const c = snap.data();

        document.getElementById('couponFormTitle').textContent = '✏️ Modifier le code promo';
        document.getElementById('couponEditId').value = id;
        document.getElementById('cCode').value = c.code || '';
        document.getElementById('cDescription').value = c.description || '';
        document.getElementById('cType').value = c.type || 'percentage';
        document.getElementById('cValue').value = c.value !== undefined ? c.value : '';
        document.getElementById('cMinPurchase').value = c.minPurchase || 0;
        document.getElementById('cMaxUses').value = c.maxUses || 0;
        document.getElementById('cExpiresAt').value = c.expiresAt
            ? (toDate(c.expiresAt)?.toISOString().split('T')[0] || '')
            : '';
        document.getElementById('cOneUsePerUser').checked = c.oneUsePerUser === true;
        document.getElementById('cIsActive').checked = c.isActive === true;

        document.getElementById('saveCouponBtnText').textContent = 'Enregistrer les modifications';
        document.getElementById('cancelCouponEdit').style.display = 'inline-flex';
        document.getElementById('tab-coupons')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
        console.error('❌ Erreur editCoupon :', e);
        showToast('❌ ' + t('loadError'));
    }
}

async function saveCoupon() {
    const editId = document.getElementById('couponEditId').value;
    const saveBtn = document.getElementById('saveCouponBtn');
    const btnText = document.getElementById('saveCouponBtnText');

    const code = document.getElementById('cCode').value.trim().toUpperCase();
    const description = document.getElementById('cDescription').value.trim();
    const type = document.getElementById('cType').value;
    const valueRaw = parseFloat(document.getElementById('cValue').value);
    const minPurchase = parseFloat(document.getElementById('cMinPurchase').value) || 0;
    const maxUses = parseInt(document.getElementById('cMaxUses').value) || 0;
    const expiresAtStr = document.getElementById('cExpiresAt').value;
    const oneUsePerUser = document.getElementById('cOneUsePerUser').checked;
    const isActive = document.getElementById('cIsActive').checked;

    if (!code || code.length < 3) {
        showToast('⚠️ Le code doit faire au moins 3 caractères');
        return;
    }
    if (code.length > 30) {
        showToast('⚠️ Le code est trop long (max 30)');
        return;
    }
    if (type !== 'free_shipping' && (isNaN(valueRaw) || valueRaw <= 0)) {
        showToast('⚠️ La valeur doit être supérieure à 0');
        return;
    }
    if (type === 'percentage' && valueRaw > 100) {
        showToast('⚠️ Un pourcentage ne peut pas dépasser 100%');
        return;
    }

    try {
        const q = query(collection(db, "coupons"), where("code", "==", code));
        const snap = await getDocs(q);
        const duplicate = snap.docs.find(d => d.id !== editId);
        if (duplicate) {
            showToast('⚠️ Ce code existe déjà — choisissez-en un autre');
            return;
        }
    } catch (e) {
        console.warn('⚠️ Vérification unicité impossible :', e);
    }

    saveBtn.disabled = true;
    const oldText = btnText.textContent;
    btnText.textContent = '⏳ ' + t('loading');

    try {
        const couponData = {
            code,
            description,
            type,
            value: type === 'free_shipping' ? 0 : valueRaw,
            minPurchase,
            maxUses,
            oneUsePerUser,
            isActive,
            updatedAt: Timestamp.now()
        };

        if (expiresAtStr) {
            const expDate = new Date(expiresAtStr + 'T23:59:59');
            couponData.expiresAt = Timestamp.fromDate(expDate);
        } else {
            couponData.expiresAt = null;
        }

        if (editId) {
            await updateDoc(doc(db, "coupons", editId), couponData);
            showToast('✅ Code promo mis à jour');
        } else {
            couponData.usedCount = 0;
            couponData.createdAt = Timestamp.now();
            const newId = code.replace(/[^A-Z0-9]/g, '_') + '_' + Date.now();
            await setDoc(doc(db, "coupons", newId), couponData);
            showToast('✅ Code promo créé : ' + code);
        }

        resetCouponForm();
        await loadCoupons();
    } catch (e) {
        console.error('❌ Erreur saveCoupon :', e);
        if (e.code === 'permission-denied') {
            showToast('❌ Permission refusée — vérifiez firestore.rules');
        } else {
            showToast('❌ ' + (e.message || t('error')));
        }
    } finally {
        saveBtn.disabled = false;
        btnText.textContent = oldText;
    }
}

async function toggleCouponActive(id) {
    try {
        const snap = await getDoc(doc(db, "coupons", id));
        if (!snap.exists()) { showToast('❌ Coupon introuvable'); return; }
        const current = snap.data().isActive === true;
        await updateDoc(doc(db, "coupons", id), {
            isActive: !current,
            updatedAt: Timestamp.now()
        });
        showToast(!current ? '✅ Code activé' : '⏸️ Code désactivé');
        await loadCoupons();
    } catch (e) {
        console.error('❌ Erreur toggleCouponActive :', e);
        showToast('❌ ' + (e.message || t('error')));
    }
}

async function deleteCoupon(id) {
    const confirmed = await confirmAction(
        'Supprimer définitivement ce code promo ? Cette action est irréversible.',
        {
            title: '🗑️ Supprimer le code promo',
            confirmText: 'Supprimer',
            cancelText: 'Annuler',
            variant: 'danger'
        }
    );
    if (!confirmed) return;

    try {
        await deleteDoc(doc(db, "coupons", id));
        showToast('🗑️ Code promo supprimé');
        await loadCoupons();
    } catch (e) {
        console.error('❌ Erreur deleteCoupon :', e);
        showToast('❌ ' + (e.message || t('error')));
    }
}

function filterCouponsList() {
    const search = document.getElementById('couponSearchAdmin')?.value.toLowerCase().trim() || '';
    let filtered = cachedCoupons;
    if (search) {
        filtered = filtered.filter(c => {
            const code = (c.code || '').toLowerCase();
            const desc = (c.description || '').toLowerCase();
            return code.includes(search) || desc.includes(search);
        });
    }
    renderCouponsList(filtered);
}

// ============================================================
// MIGRATION VILLES
// ============================================================
async function handleMigrateCities() {
    const btn = document.getElementById('migrateCitiesBtn');
    const logEl = document.getElementById('migrationLog');
    const log = (msg, isErr = false) => {
        if (!logEl) return;
        logEl.classList.add('active');
        const span = document.createElement('div');
        if (isErr) span.className = 'error';
        span.textContent = msg;
        logEl.appendChild(span);
        logEl.scrollTop = logEl.scrollHeight;
    };
    if (logEl) logEl.innerHTML = '';
    btn.disabled = true;
    if (!auth.currentUser) { log('❌ Login requis', true); btn.disabled = false; return; }
    log(`✅ ${auth.currentUser.email}`);

    let cities;
    try {
        const res = await fetch('/villes.json');
        cities = await res.json();
        log(`✅ ${cities.length} villes`);
    } catch (e) { log(`❌ ${e.message}`, true); btn.disabled = false; return; }

    const existingSnap = await getDocs(collection(db, "cities"));
    if (!existingSnap.empty) {
        const confirmed = await confirmAction(t('confirmMigrateMsg').replace('{n}', existingSnap.size), {
            title: t('confirmMigrateTitle'), confirmText: t('confirmMigrateYes'),
            cancelText: t('confirmDeleteNo'), variant: 'danger'
        });
        if (!confirmed) { btn.disabled = false; return; }
    }

    const BATCH = 400;
    let processed = 0;
    for (let i = 0; i < cities.length; i += BATCH) {
        const batch = writeBatch(db);
        const chunk = cities.slice(i, i + BATCH);
        for (const city of chunk) {
            if (!city.id || (!city.name && !city.nameAr)) continue;
            const ref = doc(db, "cities", String(city.id));
            batch.set(ref, {
                id: Number(city.id),
                key: String(city.key || '').toLowerCase().trim(),
                name: String(city.nameAr || city.name || '').trim(),
                nameAr: String(city.nameAr || city.name || '').trim(),
                nameFr: String(city.nameFr || city.name || '').trim(),
                nameEn: String(city.nameEn || city.nameFr || city.name || '').trim(),
                price: Number(city.price) || 30,
                delay: String(city.delay || '48h').trim()
            });
        }
        try {
            await batch.commit();
            processed += chunk.length;
            log(`  ✓ ${processed}/${cities.length}`);
        } catch (e) { log(`❌ batch ${i} : ${e.message}`, true); btn.disabled = false; return; }
    }
    const finalSnap = await getDocs(collection(db, "cities"));
    log(`\n🎉 Migration OK — ${finalSnap.size} villes`);
    btn.disabled = false;
    btn.textContent = '✅ ' + t('success');
    loadCollectionsStatus();
    loadStats();
    showToast('🎉 ' + t('success'));
}

async function loadCollectionsStatus() {
    const cols = ['products', 'orders', 'users', 'reviews', 'cities', 'blog', 'coupons'];
    const ids = {
        products: 'countProducts', orders: 'countOrders',
        users: 'countUsers', reviews: 'countReviews',
        cities: 'countCities', blog: 'countBlog',
        coupons: 'countCoupons'
    };
    for (const col of cols) {
        const el = document.getElementById(ids[col]);
        if (el) el.textContent = '⏳';
    }
    for (const col of cols) {
        const el = document.getElementById(ids[col]);
        if (!el) continue;
        try {
            const snap = await getCountFromServer(collection(db, col));
            el.textContent = `${snap.data().count}`;
            el.style.color = snap.data().count > 0 ? 'var(--success)' : 'var(--text-muted)';
        } catch (e) {
            el.textContent = '❌';
            el.style.color = 'var(--danger)';
        }
    }
}

// ============================================================
// COMPTABILITÉ — ONGLET
// ============================================================
async function loadFinancesTab() {
    if (!cachedProducts || cachedProducts.length === 0) await loadProducts();
    const periodEl = document.getElementById('accPeriod');
    const startEl = document.getElementById('accStart');
    const endEl = document.getElementById('accEnd');
    if (periodEl && periodEl.value !== 'custom') {
        const now = new Date();
        if (startEl && !startEl.value) startEl.value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        if (endEl && !endEl.value) endEl.value = now.toISOString().split('T')[0];
        if (startEl) startEl.disabled = true;
        if (endEl) endEl.disabled = true;
    }
    updateReportDates();
    await refreshAccOverview();
}

async function refreshAccOverview() {
    const kpis = document.getElementById('accKPIs');
    const waterfall = document.getElementById('accWaterfall');
    const recent = document.getElementById('accRecentActivity');
    if (!kpis || !waterfall) return;
    kpis.innerHTML = '<div class="admin-loading">⏳ Calcul en cours...</div>';

    try {
        const periodEl = document.getElementById('accPeriod');
        const period = periodEl ? periodEl.value : 'month';
        const customStart = document.getElementById('accStart')?.value;
        const customEnd = document.getElementById('accEnd')?.value;
        const { start, end } = getDateRangeFromPeriod(period, customStart, customEnd);

        await Promise.allSettled([
            cachedProducts.length === 0 ? loadProducts() : Promise.resolve(),
            loadPurchases(), loadExpenses(), loadTransactions()
        ]);

        const ordersSnap = await getDocs(collection(db, "orders"));
        const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        let revenue = 0, pendingRevenue = 0, lostRevenue = 0, deliveredCount = 0;
        orders.forEach(o => {
            const date = toDate(o.createdAt);
            if (!isInRange(date, start, end)) return;
            const status = o.status === 'validated' ? 'confirmed' : o.status === 'received' ? 'delivered' : o.status;
            if (status === 'delivered') { revenue += Number(o.total) || 0; deliveredCount++; }
            else if (['pending', 'confirmed', 'shipping'].includes(status)) pendingRevenue += Number(o.total) || 0;
            else if (['cancelled', 'returned'].includes(status)) lostRevenue += Number(o.total) || 0;
        });

        const periodPurchases = cachedPurchases.filter(p => isInRange(p.date, start, end));
        const periodExpenses = cachedExpenses.filter(e => isInRange(e.date, start, end));
        const periodTransactions = cachedTransactions.filter(t => isInRange(t.date, start, end));

        const totalPurchases = periodPurchases.reduce((s, p) => s + (Number(p.totalCost) || 0), 0);
        const totalExpenses = periodExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
        const extraIncome = periodTransactions.filter(t => t.type === 'income').reduce((s, t) => s + (Number(t.amount) || 0), 0);
        const extraExpense = periodTransactions.filter(t => t.type === 'expense').reduce((s, t) => s + (Number(t.amount) || 0), 0);

        const totalIn = revenue + extraIncome;
        const totalOut = totalPurchases + totalExpenses + extraExpense;
        const netProfit = totalIn - totalOut;
        const marginPct = totalIn > 0 ? (netProfit / totalIn) * 100 : 0;

        kpis.innerHTML = `
            <div class="admin-stat-card" style="border-color:var(--success);">
                <span class="stat-value" style="color:var(--success);">${formatMAD(revenue)}</span>
                <span class="stat-label">💰 Revenus (livrés)</span>
            </div>
            <div class="admin-stat-card">
                <span class="stat-value" style="color:var(--text-muted);">${formatMAD(totalPurchases)}</span>
                <span class="stat-label">📦 Achats stock</span>
            </div>
            <div class="admin-stat-card">
                <span class="stat-value" style="color:var(--text-muted);">${formatMAD(totalExpenses)}</span>
                <span class="stat-label">📉 Dépenses</span>
            </div>
            <div class="admin-stat-card" style="border-color:${netProfit >= 0 ? 'var(--success)' : 'var(--danger)'};">
                <span class="stat-value" style="color:${netProfit >= 0 ? 'var(--success)' : 'var(--danger)'};">${netProfit >= 0 ? '+' : ''}${formatMAD(netProfit)}</span>
                <span class="stat-label">🎯 Profit net</span>
            </div>
            <div class="admin-stat-card">
                <span class="stat-value">${marginPct.toFixed(1)}%</span>
                <span class="stat-label">📈 Marge %</span>
            </div>
            <div class="admin-stat-card">
                <span class="stat-value" style="color:var(--gold);">${pendingRevenue > 0 ? formatMAD(pendingRevenue) : '—'}</span>
                <span class="stat-label">⏳ En attente</span>
            </div>
        `;

        waterfall.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
                <tr style="border-bottom:1px solid var(--border);">
                    <td style="padding:0.7rem;font-weight:600;">1. 💰 Revenus (commandes livrées)</td>
                    <td style="padding:0.7rem;text-align:right;color:var(--success);font-weight:700;">+ ${formatMAD(revenue)}</td>
                </tr>
                ${extraIncome > 0 ? `<tr style="border-bottom:1px solid var(--border);"><td style="padding:0.7rem;padding-left:2rem;color:var(--text-muted);font-size:0.85rem;">+ Autres revenus</td><td style="padding:0.7rem;text-align:right;color:var(--success);font-size:0.85rem;">+ ${formatMAD(extraIncome)}</td></tr>` : ''}
                <tr style="background:rgba(212,175,55,0.05);border-bottom:2px solid var(--border);">
                    <td style="padding:0.7rem;font-weight:700;">= Total Entrées</td>
                    <td style="padding:0.7rem;text-align:right;color:var(--success);font-weight:800;font-size:1rem;">${formatMAD(totalIn)}</td>
                </tr>
                <tr style="border-bottom:1px solid var(--border);">
                    <td style="padding:0.7rem;font-weight:600;">2. 📦 Achats de stock</td>
                    <td style="padding:0.7rem;text-align:right;color:var(--danger);font-weight:700;">− ${formatMAD(totalPurchases)}</td>
                </tr>
                <tr style="border-bottom:1px solid var(--border);">
                    <td style="padding:0.7rem;font-weight:600;">3. 📉 Dépenses</td>
                    <td style="padding:0.7rem;text-align:right;color:var(--danger);font-weight:700;">− ${formatMAD(totalExpenses)}</td>
                </tr>
                ${extraExpense > 0 ? `<tr style="border-bottom:1px solid var(--border);"><td style="padding:0.7rem;padding-left:2rem;color:var(--text-muted);font-size:0.85rem;">+ Autres dépenses</td><td style="padding:0.7rem;text-align:right;color:var(--danger);font-size:0.85rem;">− ${formatMAD(extraExpense)}</td></tr>` : ''}
                <tr style="background:rgba(212,175,55,0.05);border-bottom:2px solid var(--border);">
                    <td style="padding:0.7rem;font-weight:700;">= Total Sorties</td>
                    <td style="padding:0.7rem;text-align:right;color:var(--danger);font-weight:800;font-size:1rem;">${formatMAD(totalOut)}</td>
                </tr>
                <tr style="background:${netProfit >= 0 ? 'var(--gold)' : 'var(--danger)'};color:#fff;">
                    <td style="padding:1rem;font-weight:800;font-size:1rem;">${netProfit >= 0 ? '🏆' : '⚠️'} PROFIT NET</td>
                    <td style="padding:1rem;text-align:right;font-weight:800;font-size:1.2rem;">${formatMAD(netProfit)}</td>
                </tr>
            </table>
            <div style="margin-top:1rem;padding:0.7rem;background:var(--bg-surface);border-radius:var(--radius-sm);font-size:0.8rem;color:var(--text-muted);line-height:1.6;">
                <div>📊 <strong>${deliveredCount}</strong> commande(s) livrée(s)</div>
                ${pendingRevenue > 0 ? `<div>⏳ <strong>${formatMAD(pendingRevenue)}</strong> de commandes en cours</div>` : ''}
                ${lostRevenue > 0 ? `<div>❌ <strong>${formatMAD(lostRevenue)}</strong> de commandes annulées/retournées</div>` : ''}
            </div>
        `;

        const allActivity = [
            ...periodPurchases.map(p => ({ date: p.date, label: `📦 ${p.productName} ×${p.qty}`, amount: -(Number(p.totalCost) || 0) })),
            ...periodExpenses.map(e => ({ date: e.date, label: `📉 ${e.description}`, amount: -(Number(e.amount) || 0) })),
            ...periodTransactions.map(t => ({ date: t.date, label: `${t.type === 'income' ? '💰' : '📉'} ${t.description}`, amount: t.type === 'income' ? Number(t.amount) : -Number(t.amount) }))
        ].sort((a, b) => safeDate(b.date) - safeDate(a.date)).slice(0, 10);

        if (allActivity.length === 0) {
            recent.innerHTML = '<div class="admin-empty">Aucune activité dans cette période.</div>';
        } else {
            let actHtml = '<div style="background:var(--bg-card);border-radius:var(--radius-md);padding:0.5rem;box-shadow:var(--shadow-sm);">';
            allActivity.forEach(a => {
                const color = a.amount >= 0 ? 'var(--success)' : 'var(--danger)';
                const sign = a.amount >= 0 ? '+' : '';
                actHtml += `<div style="padding:0.5rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;font-size:0.85rem;">
                    <span style="color:var(--text);flex:1;min-width:0;">${escapeHTML(a.label)}</span>
                    <span style="color:${color};font-weight:700;white-space:nowrap;">${sign}${formatMAD(a.amount)}</span>
                </div>`;
            });
            actHtml += '</div>';
            recent.innerHTML = actHtml;
        }

        await renderRevenueChart(currentChartPeriod, orders);
    } catch (e) {
        console.error('❌ refreshAccOverview:', e);
        kpis.innerHTML = `<div class="admin-empty" style="color:var(--danger);">❌ Erreur : ${e.message}</div>`;
    }
}

// ============================================================
// ACHATS
// ============================================================
async function renderPurchasesList() {
    const container = document.getElementById('purchasesList');
    if (!container) return;

    if (!cachedProducts || cachedProducts.length === 0) await loadProducts();

    const selectProd = document.getElementById('purProductId');
    if (selectProd) {
        if (cachedProducts.length === 0) {
            selectProd.innerHTML = '<option value="">⚠️ Aucun produit</option>';
        } else {
            let opts = '<option value="">-- Choisir un produit --</option>';
            cachedProducts.forEach(p => {
                opts += `<option value="${p.id}">${escapeHTML(p.nameFr || 'Sans nom')} (stock: ${p.stock || 0})</option>`;
            });
            selectProd.innerHTML = opts;
        }
    }

    try {
        await loadPurchases();
    } catch (e) {
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">❌ Impossible de lire "purchases" : ${e.code || e.message}</div>`;
        return;
    }

    if (cachedPurchases.length === 0) {
        container.innerHTML = '<div class="admin-empty">Aucun achat enregistré.</div>';
        return;
    }

    const total = cachedPurchases.reduce((s, p) => s + (Number(p.totalCost) || 0), 0);
    let html = `<div style="background:rgba(212,175,55,0.08);border:1px solid var(--border-gold);border-radius:var(--radius-sm);padding:0.7rem 1rem;margin-bottom:1rem;font-size:0.9rem;">
        💰 <strong>Total des achats :</strong> <span style="color:var(--gold);font-weight:800;">${formatMAD(total)}</span>
    </div>`;

    html += `<div style="background:var(--bg-card);border-radius:var(--radius-md);overflow:hidden;box-shadow:var(--shadow-sm);">
        <table class="acc-table">
            <thead><tr>
                <th>Date</th><th>Produit</th>
                <th style="text-align:center;">Qté</th>
                <th style="text-align:center;">Prix unit.</th>
                <th style="text-align:center;">Livraison</th>
                <th style="text-align:right;">Total</th>
                <th style="text-align:center;">Actions</th>
            </tr></thead><tbody>`;

    cachedPurchases.forEach(p => {
        const dateStr = p.date ? p.date.toLocaleDateString('fr-FR') : '—';
        html += `<tr>
            <td>${dateStr}</td>
            <td style="font-weight:600;">${escapeHTML(p.productName || '—')}<br>
                <small style="color:var(--text-muted);font-weight:normal;">${escapeHTML(p.supplier || '')} ${p.note ? '· ' + escapeHTML(p.note) : ''}</small>
            </td>
            <td style="text-align:center;">${p.qty}</td>
            <td style="text-align:center;">${p.unitPrice} MAD</td>
            <td style="text-align:center;">${p.shippingCost || 0} MAD</td>
            <td style="text-align:right;font-weight:700;color:var(--danger);">${formatMAD(p.totalCost)}</td>
            <td style="text-align:center;"><button class="admin-btn-danger" data-action="delete-purchase" data-id="${p.id}" style="font-size:0.7rem;padding:0.3rem 0.6rem;">🗑️</button></td>
        </tr>`;
    });
    html += `</tbody></table></div>`;
    container.innerHTML = html;

    container.querySelectorAll('[data-action="delete-purchase"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!await confirmAction('Supprimer cet achat ?', { variant: 'danger', title: '🗑️' })) return;
            try {
                await deleteDoc(doc(db, "purchases", btn.dataset.id));
                showToast('🗑️ Supprimé');
                await renderPurchasesList();
            } catch (e) { showToast('❌ ' + e.message); }
        });
    });
}

async function saveNewPurchase() {
    const productId = document.getElementById('purProductId').value;
    const qty = parseInt(document.getElementById('purQty').value);
    const unitPrice = parseFloat(document.getElementById('purUnitPrice').value);
    const shippingCost = parseFloat(document.getElementById('purShippingCost').value) || 0;
    const supplier = document.getElementById('purSupplier').value.trim();
    const dateStr = document.getElementById('purDate').value;
    const note = document.getElementById('purNote').value.trim();

    if (!productId) { showToast('⚠️ Sélectionnez un produit'); return; }
    if (isNaN(qty) || qty < 1) { showToast('⚠️ Quantité invalide'); return; }
    if (isNaN(unitPrice) || unitPrice < 0) { showToast('⚠️ Prix invalide'); return; }
    if (!dateStr) { showToast('⚠️ Date manquante'); return; }

    const product = cachedProducts.find(p => String(p.id) === String(productId));
    if (!product) { showToast('❌ Produit introuvable'); return; }

    const btn = document.getElementById('addPurchaseBtn');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '⏳ Enregistrement...';

    try {
        const totalCost = (qty * unitPrice) + shippingCost;
        await addDoc(collection(db, "purchases"), {
            productId: String(productId),
            productName: product.nameFr || 'Sans nom',
            qty, unitPrice, shippingCost, totalCost,
            supplier, note,
            date: Timestamp.fromDate(new Date(dateStr)),
            createdAt: Timestamp.now()
        });
        await updateDoc(doc(db, "products", productId), {
            stock: increment(qty),
            purchasePrice: unitPrice,
            updatedAt: Timestamp.now()
        });
        showToast('✅ Achat enregistré — stock +' + qty);

        document.getElementById('purProductId').value = '';
        document.getElementById('purQty').value = '';
        document.getElementById('purUnitPrice').value = '';
        document.getElementById('purShippingCost').value = '0';
        document.getElementById('purSupplier').value = '';
        document.getElementById('purNote').value = '';
        document.getElementById('purDate').valueAsDate = new Date();

        await loadProducts();
        await renderPurchasesList();
    } catch (e) {
        if (e.code === 'permission-denied') {
            showToast('❌ Permission refusée — vérifiez firestore.rules (collection "purchases")');
        } else {
            showToast('❌ ' + (e.code || e.message));
        }
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// ============================================================
// DÉPENSES
// ============================================================
async function renderExpensesList() {
    const container = document.getElementById('expensesList');
    if (!container) return;
    try {
        await loadExpenses();
    } catch (e) {
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">❌ Impossible de lire "expenses" : ${e.code || e.message}</div>`;
        return;
    }
    if (cachedExpenses.length === 0) {
        container.innerHTML = '<div class="admin-empty">Aucune dépense enregistrée.</div>';
        return;
    }
    const catLabels = {
        rent: '🏢 Loyer', salary: '👥 Salaires', marketing: '📢 Publicité',
        software: '💻 Logiciels', utilities: '💡 Électricité/Internet',
        logistics: '🚚 Logistique', tax: '🏛️ Taxes', other: '📝 Autre'
    };
    const total = cachedExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    let html = `<div style="background:rgba(176,58,46,0.08);border:1px solid var(--danger);border-radius:var(--radius-sm);padding:0.7rem 1rem;margin-bottom:1rem;font-size:0.9rem;">
        💸 <strong>Total :</strong> <span style="color:var(--danger);font-weight:800;">${formatMAD(total)}</span>
    </div>`;
    html += `<div style="background:var(--bg-card);border-radius:var(--radius-md);overflow:hidden;box-shadow:var(--shadow-sm);">
        <table class="acc-table">
            <thead><tr><th>Date</th><th>Catégorie</th><th>Description</th><th style="text-align:right;">Montant</th><th style="text-align:center;">Actions</th></tr></thead><tbody>`;
    cachedExpenses.forEach(e => {
        const dateStr = e.date ? e.date.toLocaleDateString('fr-FR') : '—';
        html += `<tr>
            <td>${dateStr}</td>
            <td>${catLabels[e.category] || e.category}</td>
            <td>${escapeHTML(e.description || '')}</td>
            <td style="text-align:right;font-weight:700;color:var(--danger);">${formatMAD(e.amount)}</td>
            <td style="text-align:center;"><button class="admin-btn-danger" data-action="delete-expense" data-id="${e.id}" style="font-size:0.7rem;padding:0.3rem 0.6rem;">🗑️</button></td>
        </tr>`;
    });
    html += `</tbody></table></div>`;
    container.innerHTML = html;

    container.querySelectorAll('[data-action="delete-expense"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!await confirmAction('Supprimer ?', { variant: 'danger', title: '🗑️' })) return;
            try {
                await deleteDoc(doc(db, "expenses", btn.dataset.id));
                showToast('🗑️ Supprimée');
                await renderExpensesList();
            } catch (e) { showToast('❌ ' + e.message); }
        });
    });
}

async function saveNewExpense() {
    const category = document.getElementById('expCategory').value;
    const amount = parseFloat(document.getElementById('expAmount').value);
    const dateStr = document.getElementById('expDate').value;
    const description = document.getElementById('expDescription').value.trim();
    if (isNaN(amount) || amount <= 0) { showToast('⚠️ Montant invalide'); return; }
    if (!dateStr) { showToast('⚠️ Date manquante'); return; }
    if (!description) { showToast('⚠️ Description manquante'); return; }

    const btn = document.getElementById('addExpenseBtn');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '⏳...';

    try {
        await addDoc(collection(db, "expenses"), {
            category, amount, description,
            date: Timestamp.fromDate(new Date(dateStr)),
            createdAt: Timestamp.now()
        });
        showToast('✅ Dépense enregistrée');
        document.getElementById('expAmount').value = '';
        document.getElementById('expDescription').value = '';
        document.getElementById('expDate').valueAsDate = new Date();
        await renderExpensesList();
    } catch (e) {
        if (e.code === 'permission-denied') {
            showToast('❌ Permission refusée — vérifiez firestore.rules (collection "expenses")');
        } else {
            showToast('❌ ' + (e.code || e.message));
        }
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// ============================================================
// TRANSACTIONS
// ============================================================
async function renderTransactionsList() {
    const container = document.getElementById('transactionsList');
    if (!container) return;
    try {
        await loadTransactions();
    } catch (e) {
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">❌ Impossible de lire "transactions" : ${e.code || e.message}</div>`;
        return;
    }
    const search = document.getElementById('transSearch')?.value.toLowerCase() || '';
    const typeFilter = document.getElementById('transFilterType')?.value || 'all';
    let filtered = cachedTransactions;
    if (typeFilter !== 'all') filtered = filtered.filter(t => t.type === typeFilter);
    if (search) filtered = filtered.filter(t => (t.description || '').toLowerCase().includes(search));

    if (filtered.length === 0) {
        container.innerHTML = '<div class="admin-empty">Aucune transaction.</div>';
        return;
    }

    let html = '';
    filtered.forEach(t => {
        const isIncome = t.type === 'income';
        const dateStr = t.date ? t.date.toLocaleDateString('fr-FR') : '—';
        const color = isIncome ? 'var(--success)' : 'var(--danger)';
        const sign = isIncome ? '+' : '−';
        html += `<div class="admin-list-item">
            <div class="admin-list-item-info">
                <strong style="color:${color};">${sign} ${formatMAD(t.amount)}</strong>
                <div style="font-size:0.85rem;color:var(--text);margin-top:0.2rem;">${escapeHTML(t.description || '')}</div>
                <div style="font-size:0.75rem;color:var(--text-muted);">📅 ${dateStr} ${isIncome ? '· 💰 Revenu' : '· 📉 Dépense'}</div>
            </div>
            <button class="admin-btn-danger" data-action="delete-trans" data-id="${t.id}" style="font-size:0.7rem;padding:0.3rem 0.6rem;">🗑️</button>
        </div>`;
    });
    container.innerHTML = html;

    container.querySelectorAll('[data-action="delete-trans"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!await confirmAction('Supprimer ?', { variant: 'danger', title: '🗑️' })) return;
            try {
                await deleteDoc(doc(db, "transactions", btn.dataset.id));
                showToast('🗑️ Supprimée');
                await renderTransactionsList();
            } catch (e) { showToast('❌ ' + e.message); }
        });
    });
}

async function saveNewTransaction() {
    const type = document.getElementById('transType').value;
    const amount = parseFloat(document.getElementById('transAmount').value);
    const dateStr = document.getElementById('transDate').value;
    const description = document.getElementById('transDescription').value.trim();
    if (isNaN(amount) || amount <= 0) { showToast('⚠️ Montant invalide'); return; }
    if (!dateStr) { showToast('⚠️ Date manquante'); return; }
    if (!description) { showToast('⚠️ Description manquante'); return; }

    const btn = document.getElementById('addTransactionBtn');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '⏳...';

    try {
        await addDoc(collection(db, "transactions"), {
            type, amount, description,
            date: Timestamp.fromDate(new Date(dateStr)),
            createdAt: Timestamp.now()
        });
        showToast('✅ Transaction enregistrée');
        document.getElementById('transAmount').value = '';
        document.getElementById('transDescription').value = '';
        document.getElementById('transDate').valueAsDate = new Date();
        await renderTransactionsList();
    } catch (e) {
        if (e.code === 'permission-denied') {
            showToast('❌ Permission refusée — vérifiez firestore.rules (collection "transactions")');
        } else {
            showToast('❌ ' + (e.code || e.message));
        }
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// ============================================================
// RAPPORTS
// ============================================================
function updateReportDates() {
    const type = document.getElementById('reportType')?.value;
    const startEl = document.getElementById('reportStart');
    const endEl = document.getElementById('reportEnd');
    if (!startEl || !endEl) return;
    const now = new Date();
    if (type === 'monthly') {
        startEl.value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        endEl.value = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    } else if (type === 'lastmonth') {
        startEl.value = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
        endEl.value = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];
    }
}

async function generateReport() {
    const startStr = document.getElementById('reportStart').value;
    const endStr = document.getElementById('reportEnd').value;
    const container = document.getElementById('reportContent');
    if (!startStr || !endStr) { showToast('⚠️ Sélectionnez une période'); return; }

    const start = new Date(startStr); start.setHours(0, 0, 0, 0);
    const end = new Date(endStr); end.setHours(23, 59, 59, 999);
    container.innerHTML = '<div class="admin-loading">⏳ Génération...</div>';

    try {
        await Promise.allSettled([
            cachedProducts.length === 0 ? loadProducts() : Promise.resolve(),
            loadPurchases(), loadExpenses(), loadTransactions()
        ]);
        const ordersSnap = await getDocs(collection(db, "orders"));
        const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        let revenue = 0, deliveredCount = 0;
        const topProducts = {};
        orders.forEach(o => {
            const date = toDate(o.createdAt);
            if (!isInRange(date, start, end)) return;
            const status = o.status === 'received' ? 'delivered' : (o.status === 'validated' ? 'confirmed' : o.status);
            if (status === 'delivered') {
                revenue += Number(o.total) || 0;
                deliveredCount++;
                (o.items || []).forEach(item => {
                    if (!topProducts[item.productId]) topProducts[item.productId] = { name: item.name, qty: 0, revenue: 0 };
                    topProducts[item.productId].qty += Number(item.quantity) || 0;
                    topProducts[item.productId].revenue += (Number(item.price) || 0) * (Number(item.quantity) || 0);
                });
            }
        });
        const pPurchases = cachedPurchases.filter(p => isInRange(p.date, start, end));
        const pExpenses = cachedExpenses.filter(e => isInRange(e.date, start, end));
        const pTransactions = cachedTransactions.filter(t => isInRange(t.date, start, end));
        const totalPurchases = pPurchases.reduce((s, p) => s + (Number(p.totalCost) || 0), 0);
        const totalExpenses = pExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
        const extraIncome = pTransactions.filter(t => t.type === 'income').reduce((s, t) => s + (Number(t.amount) || 0), 0);
        const extraExpense = pTransactions.filter(t => t.type === 'expense').reduce((s, t) => s + (Number(t.amount) || 0), 0);
        const totalIn = revenue + extraIncome;
        const totalOut = totalPurchases + totalExpenses + extraExpense;
        const netProfit = totalIn - totalOut;
        const topList = Object.entries(topProducts).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5);
        const expByCat = {};
        pExpenses.forEach(e => { expByCat[e.category] = (expByCat[e.category] || 0) + Number(e.amount); });
        const catLabels = {
            rent: '🏢 Loyer', salary: '👥 Salaires', marketing: '📢 Publicité',
            software: '💻 Logiciels', utilities: '💡 Électricité/Internet',
            logistics: '🚚 Logistique', tax: '🏛️ Taxes', other: '📝 Autre'
        };
        container.innerHTML = `
            <div style="background:var(--bg-card);border:1px solid var(--border-gold);border-radius:var(--radius-md);padding:1.5rem;margin-bottom:1rem;">
                <h3 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:0.5rem;">📊 Rapport du ${start.toLocaleDateString('fr-FR')} au ${end.toLocaleDateString('fr-FR')}</h3>
                <p style="font-size:0.85rem;color:var(--text-muted);">${deliveredCount} commande(s) livrée(s)</p>
            </div>
            <div class="admin-stats" style="margin-bottom:1.5rem;">
                <div class="admin-stat-card" style="border-color:var(--success);"><span class="stat-value" style="color:var(--success);">${formatMAD(totalIn)}</span><span class="stat-label">💰 Entrées</span></div>
                <div class="admin-stat-card" style="border-color:var(--danger);"><span class="stat-value" style="color:var(--danger);">${formatMAD(totalOut)}</span><span class="stat-label">💸 Sorties</span></div>
                <div class="admin-stat-card" style="border-color:${netProfit >= 0 ? 'var(--success)' : 'var(--danger)'};"><span class="stat-value" style="color:${netProfit >= 0 ? 'var(--success)' : 'var(--danger)'};">${netProfit >= 0 ? '+' : ''}${formatMAD(netProfit)}</span><span class="stat-label">🎯 Profit</span></div>
            </div>
            <h4 style="color:var(--gold);margin:1.5rem 0 1rem;">📦 Détail</h4>
            <table class="acc-table">
                <tr><td>💰 Revenus</td><td style="text-align:right;color:var(--success);font-weight:700;">${formatMAD(revenue)}</td></tr>
                ${extraIncome > 0 ? `<tr><td>💰 Autres revenus</td><td style="text-align:right;color:var(--success);">${formatMAD(extraIncome)}</td></tr>` : ''}
                <tr><td>📦 Achats</td><td style="text-align:right;color:var(--danger);">${formatMAD(totalPurchases)}</td></tr>
                ${Object.entries(expByCat).map(([cat, amt]) => `<tr><td style="padding-left:2rem;font-size:0.85rem;color:var(--text-muted);">${catLabels[cat] || cat}</td><td style="text-align:right;color:var(--danger);font-size:0.85rem;">${formatMAD(amt)}</td></tr>`).join('')}
                ${extraExpense > 0 ? `<tr><td>💸 Autres dépenses</td><td style="text-align:right;color:var(--danger);">${formatMAD(extraExpense)}</td></tr>` : ''}
                <tr style="background:${netProfit >= 0 ? 'var(--gold)' : 'var(--danger)'};color:#fff;">
                    <td style="padding:0.9rem;font-weight:800;">PROFIT NET</td>
                    <td style="padding:0.9rem;text-align:right;font-weight:800;font-size:1.1rem;">${formatMAD(netProfit)}</td>
                </tr>
            </table>
            ${topList.length > 0 ? `
                <h4 style="color:var(--gold);margin:1.5rem 0 1rem;">🏆 Top 5 produits</h4>
                <div style="background:var(--bg-card);border-radius:var(--radius-md);padding:0.5rem;">
                    ${topList.map(([id, p], i) => `
                        <div style="display:flex;justify-content:space-between;padding:0.6rem;border-bottom:1px solid var(--border);font-size:0.9rem;">
                            <div><strong>${i + 1}. ${escapeHTML(p.name)}</strong> <span style="color:var(--text-muted);font-size:0.8rem;">×${p.qty}</span></div>
                            <strong style="color:var(--gold);">${formatMAD(p.revenue)}</strong>
                        </div>`).join('')}
                </div>` : ''}
        `;
        window._lastReport = { start, end, revenue, totalPurchases, totalExpenses, expByCat, catLabels, totalIn, totalOut, netProfit, pPurchases, pExpenses, pTransactions };
    } catch (e) {
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">❌ ${e.message}</div>`;
    }
}

// ============================================================
// EXPORTS CSV (helpers + fonctions)
// ============================================================
function downloadCSV(csvContent, filename) {
    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function escapeCSV(val) {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function exportReport() {
    exportReportCSV();
}

function exportReportCSV() {
    const report = window._lastReport;
    if (!report) { showToast('⚠️ Générez d\'abord un rapport'); return; }
    try {
        const { start, end, revenue, totalPurchases, totalExpenses, expByCat, catLabels, totalIn, totalOut, netProfit } = report;
        const rows = [
            ['RAPPORT SMART SWI9A'],
            ['Période', `${start.toLocaleDateString('fr-FR')} → ${end.toLocaleDateString('fr-FR')}`],
            [],
            ['Section', 'Description', 'Montant (MAD)'],
            ['Entrées', 'Revenus (commandes livrées)', revenue],
            ['Sorties', 'Achats stock', totalPurchases],
            ['Sorties', 'Dépenses', totalExpenses],
            ...Object.entries(expByCat).map(([cat, amt]) => ['Sorties', `  ${catLabels[cat] || cat}`, amt]),
            ['TOTAL', 'Entrées', totalIn],
            ['TOTAL', 'Sorties', totalOut],
            ['TOTAL', 'Profit net', netProfit]
        ];
        const csv = rows.map(r => r.map(escapeCSV).join(',')).join('\n');
        downloadCSV(csv, `rapport_${start.toISOString().split('T')[0]}.csv`);
        showToast('✅ CSV exporté');
    } catch (e) { showToast('❌ ' + e.message); }
}

async function exportOrdersCSV() {
    try {
        showToast('⏳ Chargement...');
        const snap = await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc")));
        const orders = snap.docs.map(d => {
            const data = d.data();
            return { id: d.id, ...data, createdAt: toDate(data.createdAt) };
        });
        if (orders.length === 0) { showToast('⚠️ Aucune commande'); return; }
        const headers = ['N°', 'Date', 'Client', 'Téléphone', 'Adresse', 'Ville', 'Produits', 'Sous-total', 'Livraison', 'Total', 'Statut', 'Paiement'];
        const rows = orders.map(o => {
            const addr = o.deliveryAddress || {};
            const products = (o.items || []).map(i => {
                const variantText = i.variant ? ` (${[i.variant.size, i.variant.color].filter(Boolean).join('-')})` : '';
                return `${i.name}${variantText} x${i.quantity}`;
            }).join(' | ');
            return [
                o.id.slice(0, 8).toUpperCase(),
                o.createdAt ? o.createdAt.toLocaleDateString('fr-FR') : '',
                addr.name || '', addr.phone || '', addr.address || '', addr.city || '',
                products, o.subtotal || 0, o.deliveryFee || 0, o.total || 0,
                normalizeOrderStatus(o.status), o.paymentStatus || 'unpaid'
            ];
        });
        const csv = [headers, ...rows].map(r => r.map(escapeCSV).join(',')).join('\n');
        downloadCSV(csv, `commandes_${new Date().toISOString().split('T')[0]}.csv`);
        showToast(`✅ ${orders.length} commande(s) exportée(s)`);
    } catch (e) { console.error(e); showToast('❌ ' + e.message); }
}

async function exportProductsCSV() {
    try {
        if (cachedProducts.length === 0) await loadProducts();
        if (cachedProducts.length === 0) { showToast('⚠️ Aucun produit'); return; }
        const headers = ['ID', 'Nom FR', 'Nom AR', 'Nom EN', 'Slug', 'Catégorie', 'Prix vente', 'Ancien prix', 'Prix achat', 'Stock', 'Note', 'Ventes', 'Nouveau', 'Variantes', 'Dimensions'];
        const rows = cachedProducts.map(p => [
            p.id, p.nameFr || '', p.nameAr || '', p.nameEn || '',
            p.slug || '', p.category || '', p.price || 0, p.oldPrice || 0,
            p.purchasePrice || 0, p.stock || 0, p.ratingAvg || 0, p.salesCount || 0, p.isNew ? 'Oui' : 'Non',
            (p.variants || []).length,
            p.dimensions ? `${p.dimensions.weight}g ${p.dimensions.length}x${p.dimensions.width}x${p.dimensions.height}cm` : ''
        ]);
        const csv = [headers, ...rows].map(r => r.map(escapeCSV).join(',')).join('\n');
        downloadCSV(csv, `produits_${new Date().toISOString().split('T')[0]}.csv`);
        showToast(`✅ ${cachedProducts.length} produit(s) exporté(s)`);
    } catch (e) { console.error(e); showToast('❌ ' + e.message); }
}

// ============================================================
// SIMULATEUR — SÉLECTION DES PRODUITS
// ============================================================
function renderFinanceProductSelection() {
    const container = document.getElementById('financeProductSelector');
    if (!container) return;
    if (!cachedProducts || cachedProducts.length === 0) {
        container.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--text-muted);">Aucun produit — ajoutez-en d\'abord dans l\'onglet Produits</div>';
        return;
    }
    let html = '';
    cachedProducts.forEach(p => {
        const name = escapeHTML(p.nameFr || p.nameEn || 'Sans nom');
        const purchasePrice = Number(p.purchasePrice) || 0;
        const price = Number(p.price) || 0;
        const stock = Number(p.stock) || 0;
        const margin = price - purchasePrice;
        const marginColor = margin > 0 ? 'var(--success)' : (margin < 0 ? 'var(--danger)' : 'var(--text-muted)');
        html += `
            <label style="display:flex;align-items:center;gap:0.6rem;padding:0.55rem 0.7rem;border-bottom:1px solid var(--border);cursor:pointer;">
                <input type="checkbox" class="fin-prod-checkbox" value="${p.id}"
                    data-purchase="${purchasePrice}" data-price="${price}" data-stock="${stock}" data-name="${name}"
                    style="width:auto;margin:0;flex-shrink:0;">
                <div style="flex:1;min-width:0;">
                    <div style="font-size:0.85rem;font-weight:600;color:var(--text);">${name}</div>
                    <div style="font-size:0.72rem;color:var(--text-muted);line-height:1.4;">
                        Achat: <strong>${purchasePrice} MAD</strong> · Vente: <strong>${price} MAD</strong> · Stock: <strong>${stock}</strong> · 
                        <span style="color:${marginColor};font-weight:700;">Marge: ${margin.toFixed(0)} MAD</span>
                    </div>
                </div>
            </label>`;
    });
    container.innerHTML = html;

    attachFinanceSimulatorBtns();
}

function attachFinanceSimulatorBtns() {
    const btnAll = document.getElementById('finSelectAll');
    if (btnAll && !btnAll._initialized) {
        btnAll._initialized = true;
        btnAll.addEventListener('click', () => {
            document.querySelectorAll('.fin-prod-checkbox').forEach(cb => { cb.checked = true; });
        });
    }

    const btnNone = document.getElementById('finSelectNone');
    if (btnNone && !btnNone._initialized) {
        btnNone._initialized = true;
        btnNone.addEventListener('click', () => {
            document.querySelectorAll('.fin-prod-checkbox').forEach(cb => { cb.checked = false; });
        });
    }

    const btnTop5 = document.getElementById('finSelectTop5');
    if (btnTop5 && !btnTop5._initialized) {
        btnTop5._initialized = true;
        btnTop5.addEventListener('click', () => {
            const cbs = Array.from(document.querySelectorAll('.fin-prod-checkbox'));
            cbs.forEach(cb => {
                const purchase = parseFloat(cb.dataset.purchase) || 0;
                const price = parseFloat(cb.dataset.price) || 0;
                cb._margin = price - purchase;
            });
            cbs.sort((a, b) => b._margin - a._margin);
            cbs.forEach((cb, i) => { cb.checked = i < 5; });
        });
    }

    const btnProfitable = document.getElementById('finSelectProfitable');
    if (btnProfitable && !btnProfitable._initialized) {
        btnProfitable._initialized = true;
        btnProfitable.addEventListener('click', () => {
            document.querySelectorAll('.fin-prod-checkbox').forEach(cb => {
                const purchase = parseFloat(cb.dataset.purchase) || 0;
                const price = parseFloat(cb.dataset.price) || 0;
                cb.checked = price > purchase;
            });
        });
    }
}

function calculateFinances() {
    const adSpend = parseFloat(document.getElementById('finAdSpend').value) || 0;
    const packaging = parseFloat(document.getElementById('finPackaging').value) || 0;
    const returnShipping = parseFloat(document.getElementById('finReturnShipping').value) || 0;
    const safetyMargin = parseFloat(document.getElementById('finSafetyMargin').value) || 0;
    const returnRate = parseFloat(document.getElementById('finReturnRate').value) || 0;

    const checked = document.querySelectorAll('.fin-prod-checkbox:checked');
    if (checked.length === 0) {
        showToast('⚠️ Sélectionnez au moins un produit');
        return;
    }

    const logisticCost = packaging + (returnRate / 100) * (returnShipping + packaging);
    let totalRevenue = 0, totalInvestment = 0, totalLogistics = 0, totalGrossProfit = 0, totalUnits = 0;
    const products = [];

    checked.forEach(cb => {
        const purchasePrice = parseFloat(cb.dataset.purchase) || 0;
        const price = parseFloat(cb.dataset.price) || 0;
        const stock = parseInt(cb.dataset.stock) || 0;
        const name = cb.dataset.name || 'Produit';

        const unitMargin = price - purchasePrice - logisticCost;
        const cpaMax = Math.max(0, unitMargin * (1 - safetyMargin / 100));
        const profitTotal = unitMargin * stock;
        const roi = (purchasePrice * stock) > 0 ? (profitTotal / (purchasePrice * stock)) * 100 : 0;

        totalRevenue += price * stock;
        totalInvestment += purchasePrice * stock;
        totalLogistics += logisticCost * stock;
        totalGrossProfit += profitTotal;
        totalUnits += stock;

        products.push({ name, purchasePrice, price, stock, unitMargin, cpaMax, profitTotal, roi });
    });

    const netProfit = totalGrossProfit - adSpend;
    const globalROI = totalInvestment > 0 ? (totalGrossProfit / totalInvestment) * 100 : 0;
    const avgMargin = totalUnits > 0 ? totalGrossProfit / totalUnits : 0;
    const breakEven = avgMargin > 0 ? Math.ceil(adSpend / avgMargin) : 0;

    document.getElementById('finTotalRevenue').textContent = formatMAD(totalRevenue);
    document.getElementById('finTotalInvestment').textContent = formatMAD(totalInvestment);
    document.getElementById('finTotalLogistics').textContent = formatMAD(totalLogistics);
    document.getElementById('finTotalGrossProfit').textContent = formatMAD(totalGrossProfit);
    document.getElementById('finTotalProfit').textContent = formatMAD(netProfit);
    document.getElementById('finTotalROI').textContent = globalROI.toFixed(1) + '%';
    document.getElementById('finBreakEven').textContent = breakEven + ' colis';
    document.getElementById('finTotalProducts').textContent = products.length;
    document.getElementById('finTotalUnits').textContent = totalUnits;
    document.getElementById('finStockSaleValue').textContent = formatMAD(totalRevenue);

    const recEl = document.getElementById('finRecommendations');
    if (recEl) {
        if (netProfit < 0) {
            recEl.innerHTML = `<div style="background:rgba(176,58,46,0.1);border:1px solid var(--danger);border-radius:var(--radius-sm);padding:1rem;color:var(--text);"><strong style="color:var(--danger);">⚠️ Attention :</strong> Le budget publicitaire (${formatMAD(adSpend)}) dépasse le profit brut (${formatMAD(totalGrossProfit)}). Réduisez la pub ou augmentez les marges.</div>`;
        } else if (netProfit > 0) {
            recEl.innerHTML = `<div style="background:rgba(46,204,113,0.1);border:1px solid var(--success);border-radius:var(--radius-sm);padding:1rem;color:var(--text);"><strong style="color:var(--success);">✅ Rentable :</strong> Profit net de ${formatMAD(netProfit)}. Point mort atteint à <strong>${breakEven} colis</strong> vendus.</div>`;
        } else { recEl.innerHTML = ''; }
    }

    const tbody = document.getElementById('financesTableBody');
    if (tbody) {
        let rowsHtml = '';
        products.forEach(p => {
            let verdict = '❌ Perte', verdictColor = 'var(--danger)';
            if (p.unitMargin > 0) {
                if (p.cpaMax >= 60) { verdict = '✅ Excellent'; verdictColor = 'var(--success)'; }
                else if (p.cpaMax >= 30) { verdict = '👍 Bon'; verdictColor = 'var(--success)'; }
                else { verdict = '⚠️ Moyen'; verdictColor = 'var(--warning)'; }
            }
            rowsHtml += `<tr>
                <td style="font-weight:600;font-size:0.85rem;">${escapeHTML(p.name)}</td>
                <td style="text-align:center;">${p.purchasePrice} MAD</td>
                <td style="text-align:center;">${p.price} MAD</td>
                <td style="text-align:center;font-weight:700;color:${p.unitMargin >= 0 ? 'var(--success)' : 'var(--danger)'};">${p.unitMargin.toFixed(0)} MAD</td>
                <td style="text-align:center;">${p.cpaMax > 0 ? p.cpaMax.toFixed(0) + ' MAD' : '—'}</td>
                <td style="text-align:center;">${p.stock}</td>
                <td style="text-align:center;font-weight:700;color:${p.profitTotal >= 0 ? 'var(--success)' : 'var(--danger)'};">${formatMAD(p.profitTotal)}</td>
                <td style="text-align:center;">${p.roi.toFixed(0)}%</td>
                <td style="text-align:center;font-weight:700;font-size:0.8rem;color:${verdictColor};">${verdict}</td>
            </tr>`;
        });
        tbody.innerHTML = rowsHtml;
    }

    document.getElementById('financeResults').style.display = 'block';
}

// ============================================================
// DÉMARRAGE
// ============================================================
initAdmin();

// ============================================================
// LOG
// ============================================================
console.log('✅ admin.js chargé — v5.0.0 (Variantes, Dimensions, Guide Tailles)');