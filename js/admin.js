// js/admin.js
// ============================================================
// PANNEAU ADMINISTRATION - SMART SWI9A
// Version 10.1.0 — Marketplace (correctifs Vendeurs + Retraits + N2 fix)
//   - B1/B2 : approbation vendeur écrit users ET vendorsPublic (transaction)
//   - B3 : refus d'approbation si contrat non signé (lecture contracts/)
//   - B4 : tri vendeurs (pending → approved → rejeté/suspendu)
//   - B5 : affichage contrat (signé / non signé / révoqué)
//   - B6 : serverTimestamp pour les mises à jour statut vendeur
//   - B8/B9 : payouts bornés et vendorId fallback
//   - B10 : message d'erreur enrichi
//   - B11 : null-guards sur les éléments critiques du login
//   - N2 : lecture contracts/contract_<uid> + sync vendorInfo.contractStatus
// ============================================================

import { auth, db, storage } from "./firebase.js";
import {
    onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "firebase/auth";
import {
    collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
    query, where, writeBatch, Timestamp, getCountFromServer,
    orderBy, limit, increment, addDoc, deleteField, runTransaction,
    serverTimestamp
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import {
    ROLES, ORDER_STATUS, CATEGORIES, CATEGORY_GROUPS, CONFIG, normalizeOrderStatus,
    normalizeCategory, getCategoryById, APP_MODE, isTestMode,
    VENDOR_STATUS, PAYOUT_STATUS, WALLET_TX_TYPE, CONTRACT_STATUS
} from "./config.js";
import {
    escapeHTML, slugify, getStoragePathFromUrl, isStorageUrl,
    getSignupMethodLabel, getSignupMethodEmoji, toDate, t, getCityName
} from "./utils.js";
import {
    renderAdminOrders, resetAdminOrdersCache, openReturnModal, syncSpeedafStatus
} from "./orders.js";
import { renderAdminReviews } from "./reviews.js";
import { showToast, confirmAction } from "./ui-core.js";

// ============================================================
// 🧪 MODE TEST — CONFIGURATION
// ============================================================
const PROTECTED_USER_EMAILS = [
    "asaminfo20@gmail.com"   // Compte test permanent — jamais supprimé
];

const TEST_SNAPSHOT_ROOT = "_test_snapshots";

const COLLECTIONS_TO_SNAPSHOT = [
    "products",
    "orders",
    "coupons",
    "coupon_uses",
    "reviews",
    "notifications",
    "speedaf_pickups",
    "users",
    "blog",
    "vendorsPublic",
    "wallets",
    "contracts",
    "payout_requests",
    "wallet_transactions"
];

// ============================================================
// ÉTAT LOCAL
// ============================================================
let currentAdmin = null;
let cachedProducts = [];
let cachedUsers = [];
let cachedVendors = [];
let cachedPayouts = [];
let cachedBlogPosts = [];
let cachedPurchases = [];
let cachedExpenses = [];
let cachedTransactions = [];
let cachedCoupons = [];
let speedafOrdersCache = [];
let lastProductsLoadTime = 0;

let simulatorListenersAttached = false;
let alertInterval = null;
let tempStockFilter = null;
let isSyncingAllSpeedaf = false;

let revenueChartInstance = null;
let currentChartPeriod = 7;
let chartListenersAttached = false;

const PRODUCTS_PER_PAGE = 20;
let productsCurrentPage = 1;
const BLOG_PER_PAGE = 15;
let blogCurrentPage = 1;

let pendingLoginError = null;

// ============================================================
// HELPERS i18n
// ============================================================
const BLOG_CAT_KEY_MAP = {
    conseils: 'blogCatConseils', tendances: 'blogCatTendances',
    tests: 'blogCatTests', tutoriels: 'blogCatTutoriels',
    'smart-home': 'blogCatSmartHome', gadgets: 'blogCatGadgets',
    actualites: 'blogCatActualites', general: 'blogCatGeneral'
};
function tBlogCategory(catId) { return t(BLOG_CAT_KEY_MAP[catId] || 'blogCatGeneral'); }

const COUPON_TYPES = {
    percentage: { label: 'Pourcentage', emoji: '📊', cssClass: 'coupon-type-percentage' },
    fixed: { label: 'Montant fixe', emoji: '💰', cssClass: 'coupon-type-fixed' },
    free_shipping: { label: 'Livraison gratuite', emoji: '🚚', cssClass: 'coupon-type-free_shipping' }
};

// ============================================================
// HELPERS COMPTABILITÉ & DATES
// ============================================================
function formatMAD(n) {
    const num = Number(n) || 0;
    return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2, useGrouping: true })
        .format(num).replace(/\u202f|\u00a0/g, ' ') + ' MAD';
}
function safeDate(d) { const date = toDate(d); return date ? date.getTime() : 0; }
function isInRange(date, start, end) {
    if (!date) return false; const d = toDate(date); if (!d) return false; return d >= start && d <= end;
}
function getDateRangeFromPeriod(period, customStart, customEnd) {
    const now = new Date(); let start, end;
    switch (period) {
        case 'today': start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999); break;
        case 'week': { const dayOfWeek = now.getDay() || 7; start = new Date(now); start.setDate(now.getDate() - dayOfWeek + 1); start.setHours(0, 0, 0, 0); end = new Date(now); end.setHours(23, 59, 59, 999); break; }
        case 'month': start = new Date(now.getFullYear(), now.getMonth(), 1); end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999); break;
        case 'quarter': { const q = Math.floor(now.getMonth() / 3); start = new Date(now.getFullYear(), q * 3, 1); end = new Date(now.getFullYear(), (q + 1) * 3, 0, 23, 59, 59, 999); break; }
        case 'year': start = new Date(now.getFullYear(), 0, 1); end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999); break;
        case 'all': start = new Date(2020, 0, 1); end = new Date(now.getFullYear() + 1, 0, 1); break;
        case 'custom': default: start = customStart ? new Date(customStart) : new Date(now.getFullYear(), now.getMonth(), 1); start.setHours(0, 0, 0, 0); end = customEnd ? new Date(customEnd) : new Date(); end.setHours(23, 59, 59, 999);
    }
    return { start, end };
}

function generateUniqueSku(category) {
    const catPrefix = category ? category.substring(0, 4).toUpperCase() : 'GEN';
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const randomStr = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `SW-${catPrefix}-${dateStr}-${randomStr}`;
}

// ============================================================
// STORAGE HELPERS
// ============================================================
async function deleteStorageImage(url) {
    if (!isStorageUrl(url)) return false;
    const path = getStoragePathFromUrl(url);
    if (!path) return false;
    try { await deleteObject(ref(storage, path)); return true; } catch (e) { return false; }
}
async function deleteStorageImages(urls) {
    if (!urls || urls.length === 0) return;
    await Promise.allSettled(urls.map(url => deleteStorageImage(url)));
}

// ============================================================
// 🧪 MODE TEST — COLLECTE ET SUPPRESSION DES FICHIERS STORAGE
// ============================================================
async function collectTestFiles(batchId) {
    const urlsToDelete = new Set();
    const FILE_FIELDS = { products: ['img', 'gallery'], reviews: ['photos'], blog: ['image'] };

    for (const [coll, fields] of Object.entries(FILE_FIELDS)) {
        try {
            const snapDocs = await getDocs(collection(db, TEST_SNAPSHOT_ROOT, batchId, coll));
            const snapshotUrls = new Set();
            snapDocs.forEach(d => {
                const data = d.data();
                fields.forEach(f => {
                    const v = data[f];
                    if (typeof v === 'string' && v) snapshotUrls.add(v);
                    else if (Array.isArray(v)) v.forEach(u => u && snapshotUrls.add(u));
                });
            });

            const curDocs = await getDocs(collection(db, coll));
            curDocs.forEach(d => {
                const data = d.data();
                fields.forEach(f => {
                    const v = data[f];
                    const addIfNew = (u) => {
                        if (u && typeof u === 'string' && u.startsWith('http') && !snapshotUrls.has(u)) urlsToDelete.add(u);
                    };
                    if (typeof v === 'string') addIfNew(v);
                    else if (Array.isArray(v)) v.forEach(addIfNew);
                });
            });
        } catch (e) {}
    }
    return Array.from(urlsToDelete);
}

async function deleteStorageFiles(urls) {
    let deleted = 0, failed = 0;
    for (const url of urls) {
        try {
            const path = getStoragePathFromUrl(url);
            if (!path) { failed++; continue; }
            await deleteObject(ref(storage, path));
            deleted++;
        } catch (e) { failed++; }
    }
    return { deleted, failed };
}

// ============================================================
// 🧪 MODE TEST — INITIALISATION & ROLLBACK
// ============================================================
function initTestMode() {
    const saved = localStorage.getItem('swi9a_app_mode');
    if (saved === 'test' || saved === 'production') {
        APP_MODE.current = saved === 'test' ? 'test' : 'production';
        APP_MODE.testBatchId = saved === 'test' ? localStorage.getItem('swi9a_test_batch') : null;
        activateAdminPanel();
    } else {
        showModeChoiceScreen();
    }
}

function showModeChoiceScreen() {
    // B11 : null-guards
    const loginBox = document.getElementById('adminLoginBox');
    const panel = document.getElementById('adminPanel');
    const choice = document.getElementById('modeChoiceScreen');
    if (loginBox) loginBox.style.display = 'none';
    if (panel) panel.style.display = 'none';
    if (choice) choice.style.display = 'flex';
    document.body.style.paddingTop = '';
    const realBtn = document.getElementById('chooseRealModeBtn');
    const testBtn = document.getElementById('chooseTestModeBtn');
    if (realBtn) realBtn.onclick = () => chooseMode('production');
    if (testBtn) testBtn.onclick = () => chooseMode('test');
}

async function chooseMode(mode) {
    if (mode === 'test') {
        const ok = await confirmAction(
            'Cette action va :\n\n1. Créer un SNAPSHOT complet de ta base\n2. Activer le mode test\n\nPendant le mode test :\n• Speedaf DÉSACTIVÉ\n• TOUTES tes actions seront enregistrées\n\nQuand tu cliqueras "Test Terminé", TOUT sera restauré.\n\nContinuer ?',
            { title: '🔴 Activer Mode Test', confirmText: 'Activer', cancelText: 'Annuler', variant: 'danger' }
        );
        if (!ok) return;
        const btn = document.getElementById('chooseTestModeBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<div style="font-size:1.5rem;font-weight:800;margin-bottom:0.3rem;">⏳ Snapshot...</div>';
        }
        await startTestBatch(btn);
    } else {
        APP_MODE.current = 'production';
        APP_MODE.testBatchId = null;
        localStorage.setItem('swi9a_app_mode', 'production');
        localStorage.removeItem('swi9a_test_batch');
        activateAdminPanel();
    }
}

async function startTestBatch(btn) {
    const batchId = 'batch_' + Date.now();
    try {
        let totalDocs = 0;
        for (const coll of COLLECTIONS_TO_SNAPSHOT) {
            try {
                const snap = await getDocs(collection(db, coll));
                totalDocs += snap.size;
                for (let i = 0; i < snap.docs.length; i += 400) {
                    const batch = writeBatch(db);
                    snap.docs.slice(i, i + 400).forEach(d => {
                        batch.set(doc(db, TEST_SNAPSHOT_ROOT, batchId, coll, d.id), d.data());
                    });
                    await batch.commit();
                }
            } catch (e) {}
        }
        await setDoc(doc(db, TEST_SNAPSHOT_ROOT, batchId), { batchId, startedAt: Timestamp.now(), collections: COLLECTIONS_TO_SNAPSHOT, totalDocs, status: 'active' });
        APP_MODE.current = 'test';
        APP_MODE.testBatchId = batchId;
        localStorage.setItem('swi9a_app_mode', 'test');
        localStorage.setItem('swi9a_test_batch', batchId);
        showToast(`🔴 Mode TEST activé — ${totalDocs} docs sauvegardés`);
        activateAdminPanel();
    } catch (e) {
        showToast('❌ Snapshot : ' + e.message);
        if (btn) { btn.disabled = false; btn.innerHTML = '<div style="font-size:1.5rem;font-weight:800;margin-bottom:0.3rem;">🔴 Mode Test</div><div style="font-size:0.85rem;opacity:0.9;">Snapshot base</div>'; }
    }
}

async function endTestBatch() {
    const batchId = APP_MODE.testBatchId;
    if (!batchId) { showToast('⚠️ Aucun batch actif'); return; }
    const ok = await confirmAction('🟢 ROLLBACK COMPLET\n\nTOUT sera restauré à l\'état d\'avant le test.\n\nContinuer ?', { title: '🟢 Test Terminé', confirmText: 'TOUT RESTAURER', cancelText: 'Annuler', variant: 'danger' });
    if (!ok) return;

    const btn = document.getElementById('endTestBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Rollback...'; }
    APP_MODE.current = 'production';
    APP_MODE.testBatchId = null;
    localStorage.setItem('swi9a_app_mode', 'production');
    localStorage.removeItem('swi9a_test_batch');
    updateTestModeUI();

    let totalDeleted = 0, totalRestored = 0, filesDeleted = 0, filesFailed = 0;

    try {
        const testFiles = await collectTestFiles(batchId);
        for (const coll of COLLECTIONS_TO_SNAPSHOT) {
            try {
                const snapDocs = await getDocs(collection(db, TEST_SNAPSHOT_ROOT, batchId, coll));
                const snapshotMap = new Map();
                snapDocs.forEach(d => snapshotMap.set(d.id, d.data()));
                const curDocs = await getDocs(collection(db, coll));
                const isProtected = (d) => coll === 'users' && PROTECTED_USER_EMAILS.map(e => e.toLowerCase()).includes((d.data()?.email || '').toLowerCase());
                const toDelete = curDocs.docs.filter(d => !snapshotMap.has(d.id) && !isProtected(d));
                for (let i = 0; i < toDelete.length; i += 400) {
                    const batch = writeBatch(db);
                    toDelete.slice(i, i + 400).forEach(d => batch.delete(d.ref));
                    await batch.commit();
                }
                totalDeleted += toDelete.length;
                const arr = Array.from(snapshotMap.entries());
                for (let i = 0; i < arr.length; i += 400) {
                    const batch = writeBatch(db);
                    arr.slice(i, i + 400).forEach(([id, data]) => batch.set(doc(db, coll, id), data));
                    await batch.commit();
                }
                totalRestored += arr.length;
                for (let i = 0; i < snapDocs.docs.length; i += 400) {
                    const batch = writeBatch(db);
                    snapDocs.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
                    await batch.commit();
                }
            } catch (e) {}
        }
        if (testFiles.length > 0) {
            const r = await deleteStorageFiles(testFiles);
            filesDeleted = r.deleted; filesFailed = r.failed;
        }
        try { await deleteDoc(doc(db, TEST_SNAPSHOT_ROOT, batchId)); } catch (e) {}
        let msg = `✅ Rollback OK : ${totalDeleted} créés supprimés, ${totalRestored} docs restaurés`;
        if (filesDeleted > 0) msg += `, ${filesDeleted} fichiers supprimés`;
        showToast(msg, 5000);
        await loadStats(); await loadOrders(); await loadProducts(true);
    } catch (e) {
        showToast('❌ Rollback : ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🟢 Test Terminé (Rollback)'; }
    }
}

function updateTestModeUI() {
    const indicator = document.getElementById('adminModeIndicator');
    const banner = document.getElementById('testModeBanner');
    if (isTestMode()) {
        if (indicator) { indicator.innerHTML = '🔴 MODE TEST'; indicator.style.color = '#dc3545'; }
        if (banner) banner.style.display = 'flex';
        document.body.style.paddingTop = '50px';
    } else {
        if (indicator) { indicator.innerHTML = '🟢 MODE RÉEL'; indicator.style.color = '#2ecc71'; }
        if (banner) banner.style.display = 'none';
        document.body.style.paddingTop = '';
    }
}

function activateAdminPanel() {
    // B11 : null-guards
    const choice = document.getElementById('modeChoiceScreen');
    const loginBox = document.getElementById('adminLoginBox');
    const panel = document.getElementById('adminPanel');
    if (choice) choice.style.display = 'none';
    if (loginBox) loginBox.style.display = 'none';
    if (panel) panel.style.display = 'block';
    if (currentAdmin) {
        const emailEl = document.getElementById('adminUserEmail');
        if (emailEl) emailEl.textContent = currentAdmin.email;
    }
    updateTestModeUI();
    if (isTestMode()) {
        const endBtn = document.getElementById('endTestBtn');
        if (endBtn) endBtn.onclick = endTestBatch;
    }
    loadStats(); loadAllData(); initAdminAlerts(); attachChartListeners();
}

function showLoginBox() {
    // B11 : null-guards
    const loginBox = document.getElementById('adminLoginBox');
    const choice = document.getElementById('modeChoiceScreen');
    const panel = document.getElementById('adminPanel');
    if (loginBox) loginBox.style.display = 'block';
    if (choice) choice.style.display = 'none';
    if (panel) panel.style.display = 'none';
    const msgEl = document.getElementById('adminLoginMsg');
    if (msgEl) {
        const displayMsg = pendingLoginError || '';
        msgEl.textContent = displayMsg;
        msgEl.style.color = displayMsg ? 'var(--danger)' : '';
    }
}

// ============================================================
// LOGIN & INITIALISATION
// ============================================================
async function handleLogin() {
    const email = document.getElementById('adminEmail').value.trim();
    const password = document.getElementById('adminPassword').value;
    const msgEl = document.getElementById('adminLoginMsg');
    const btn = document.getElementById('adminLoginBtn');
    pendingLoginError = null;

    if (!email || !password) { if (msgEl) { msgEl.textContent = '⚠️ Email et mot de passe requis'; msgEl.style.color = 'var(--danger)'; } return; }
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Connexion...'; }
    if (msgEl) { msgEl.textContent = '⏳ Connexion en cours...'; msgEl.style.color = 'var(--text-muted)'; }

    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
        const errorMap = {
            'auth/invalid-email': '📧 Format d\'email invalide.',
            'auth/user-not-found': '❌ Aucun compte trouvé.',
            'auth/wrong-password': '🔒 Mot de passe incorrect.',
            'auth/invalid-credential': '🔒 Email ou mot de passe incorrect.',
            'auth/too-many-requests': '⏳ Trop de tentatives. Patientez.',
            'auth/network-request-failed': '📡 Pas de connexion internet.'
        };
        if (msgEl) { msgEl.textContent = errorMap[e.code] || '❌ Erreur inconnue'; msgEl.style.color = 'var(--danger)'; }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔓 Se connecter'; }
    }
}

function initAdmin() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            if (!user.emailVerified && user.providerData?.[0]?.providerId === 'password') {
                currentAdmin = null;
                pendingLoginError = '📧 Vérifiez votre email avant de vous connecter.';
                showLoginBox();
                await signOut(auth);
                return;
            }
            try {
                const userDoc = await getDoc(doc(db, "users", user.uid));
                if (userDoc.exists() && userDoc.data().role === ROLES.ADMIN) {
                    currentAdmin = user;
                    pendingLoginError = null;
                    resetAdminOrdersCache();
                    initTestMode();
                } else {
                    pendingLoginError = '⚠️ Ce compte n\'a pas les droits administrateur.';
                    currentAdmin = null;
                    showLoginBox();
                    await signOut(auth);
                }
            } catch (e) {
                pendingLoginError = '❌ Erreur de vérification.';
                currentAdmin = null;
                showLoginBox();
                await signOut(auth);
            }
        } else {
            currentAdmin = null;
            showLoginBox();
            const banner = document.getElementById('adminAlertBanner');
            if (banner) banner.style.display = 'none';
            if (alertInterval) clearInterval(alertInterval);
        }
    });

    document.getElementById('adminLoginBtn')?.addEventListener('click', handleLogin);
    document.getElementById('adminEmail')?.addEventListener('input', () => { pendingLoginError = null; const msgEl = document.getElementById('adminLoginMsg'); if (msgEl && msgEl.textContent) msgEl.textContent = ''; });
    document.getElementById('adminPassword')?.addEventListener('input', () => { pendingLoginError = null; const msgEl = document.getElementById('adminLoginMsg'); if (msgEl && msgEl.textContent) msgEl.textContent = ''; });
    document.getElementById('adminPassword')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleLogin(); } });

    document.getElementById('adminLogoutBtn')?.addEventListener('click', async () => {
        resetAdminOrdersCache();
        if (alertInterval) clearInterval(alertInterval);
        await signOut(auth);
        localStorage.removeItem('swi9a_app_mode');
        localStorage.removeItem('swi9a_test_batch');
        APP_MODE.current = 'production';
        APP_MODE.testBatchId = null;
        showToast('👋 Déconnecté');
    });

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
            else if (tab === 'vendors') await loadVendors();
            else if (tab === 'wallets') await loadPayouts();
            else if (tab === 'speedaf') await loadSpeedafTab();
            else if (tab === 'coupons') await loadCoupons();
            else if (tab === 'finances') await loadFinancesTab();
            else if (tab === 'users') await loadUsers();
            else if (tab === 'reviews') await loadReviews();
        });
    });

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

    document.addEventListener('order-stock-changed', async () => { try { await loadProducts(); await loadStats(); refreshAdminAlerts(); } catch (e) {} });
    attachAllRemainingEvents();
}

// ============================================================
// CHARGEMENT DONNÉES (Stats, Produits, Commandes)
// ============================================================
async function loadAllData() {
    await loadProducts(); await loadStats(); await loadUsers(); await loadCoupons();
    await loadBlogPosts(); await loadReviews();
    try { await Promise.all([loadPurchases(), loadExpenses(), loadTransactions()]); } catch (e) {}
}

async function loadStats() {
    try {
        const c = await getCountFromServer(collection(db, "products"));
        const el = document.getElementById('statProducts');
        if (el) el.textContent = c.data().count;

        const [ordersSnap, pendingOrdersSnap] = await Promise.allSettled([
            getCountFromServer(collection(db, "orders")),
            getCountFromServer(query(collection(db, "orders"), where("status", "==", "pending")))
        ]);

        let revenue = 0;
        try {
            const qRev = query(collection(db, "orders"), where("status", "in", ["delivered", "received"]), limit(500));
            const revSnap = await getDocs(qRev);
            revSnap.forEach(d => { revenue += Number(d.data().total) || 0; });
        } catch(e) {}

        const sO = document.getElementById('statOrders');
        const sOP = document.getElementById('statOrdersPending');
        const sR = document.getElementById('statRevenue');
        if (sO) sO.textContent = ordersSnap.value?.data().count || 0;
        if (sOP) sOP.textContent = pendingOrdersSnap.value?.data().count || 0;
        if (sR) sR.textContent = `${revenue} MAD`;

        const cu = await getCountFromServer(collection(db, "users"));
        const elU = document.getElementById('statUsers');
        if (elU) elU.textContent = cu.data().count;

        const cr = await getCountFromServer(query(collection(db, "reviews"), where("status", "==", "pending")));
        const elR = document.getElementById('statReviewsPending');
        if (elR) elR.textContent = cr.data().count;

        try {
            const cc = await getCountFromServer(collection(db, "cities"));
            const elC = document.getElementById('statCities');
            if (elC) elC.textContent = cc.data().count;
        } catch (e) { if (document.getElementById('statCities')) document.getElementById('statCities').textContent = '—'; }
    } catch (e) { console.error('❌ loadStats:', e); }
}

async function loadOrders() { await renderAdminOrders('adminOrdersList'); }
async function loadReviews() { await renderAdminReviews('reviewsList', 'all'); }

// ------------------------------------------------------------
// FIN PARTIE 1/4 — la suite (loadProducts → …) commence en PARTIE 2/4
// ------------------------------------------------------------
// ============================================================
// PRODUITS
// ============================================================
async function loadProducts(force = false) {
    const container = document.getElementById('adminProductsList');
    const now = Date.now();
    if (!force && cachedProducts.length > 0 && (now - lastProductsLoadTime) < 300000) {
        if (container) filterProductsList(false);
        return;
    }
    if (container) container.innerHTML = `<div class="admin-loading">⏳ Chargement...</div>`;
    populateCategoriesFilter();
    try {
        const snap = await getDocs(collection(db, "products"));
        cachedProducts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        cachedProducts.sort((a, b) => (a.nameFr || '').localeCompare(b.nameFr || ''));
        lastProductsLoadTime = Date.now();
        productsCurrentPage = 1;
        if (container) filterProductsList(false);
    } catch (e) {
        if (container) container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur</div>`;
    }
}

function populateCategoriesFilter() {
    const selectFilter = document.getElementById('productCategoryFilter');
    if (selectFilter && !selectFilter._populated) {
        let html = `<option value="all">Toutes catégories</option>`;
        CATEGORY_GROUPS.forEach(group => {
            html += `<option value="${group.id}" style="font-weight:bold;">📁 ${t(group.label)}</option>`;
            group.children.forEach(cat => {
                html += `<option value="${cat.id}">&nbsp;&nbsp;&nbsp;↳ ${cat.emoji} ${t(cat.label)}</option>`;
            });
        });
        selectFilter.innerHTML = html;
        selectFilter._populated = true;
    }

    const parentSelect = document.getElementById('pParentCategory');
    const childSelect = document.getElementById('pCategory');
    if (parentSelect && !parentSelect._populated) {
        let html = '<option value="">-- Choisir --</option>';
        CATEGORY_GROUPS.forEach(group => { html += `<option value="${group.id}">${group.emoji} ${t(group.label)}</option>`; });
        parentSelect.innerHTML = html;
        parentSelect._populated = true;
        parentSelect.addEventListener('change', () => {
            const selectedGroup = CATEGORY_GROUPS.find(g => g.id === parentSelect.value);
            childSelect.innerHTML = '';
            if (!selectedGroup) { childSelect.innerHTML = '<option value="">-- Sous-catégorie --</option>'; return; }
            let childHtml = '<option value="">-- Sous-catégorie --</option>';
            selectedGroup.children.forEach(child => { childHtml += `<option value="${child.id}">${child.emoji} ${t(child.label)}</option>`; });
            childSelect.innerHTML = childHtml;
        });
    }
}

function attachClearTempFilterListener() {
    const btn = document.getElementById('clearTempFilterBtn');
    if (!btn || btn._listenerAttached) return;
    btn._listenerAttached = true;
    btn.addEventListener('click', () => { tempStockFilter = null; filterProductsList(); });
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
        container.innerHTML = filterIndicator + `<div class="admin-empty">Aucun produit trouvé.</div>`;
        attachClearTempFilterListener();
        return;
    }

    const totalPages = Math.max(1, Math.ceil(products.length / PRODUCTS_PER_PAGE));
    if (productsCurrentPage > totalPages) productsCurrentPage = totalPages;
    const start = (productsCurrentPage - 1) * PRODUCTS_PER_PAGE;
    const pageProducts = products.slice(start, start + PRODUCTS_PER_PAGE);

    let html = filterIndicator;
    if (totalPages > 1) html += `<div style="text-align:center;font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem;">${productsCurrentPage} / ${totalPages} — ${products.length}</div>`;

    pageProducts.forEach(p => {
        const name = escapeHTML(p.nameFr || p.nameEn || 'Sans nom');
        const price = Number(p.price) || 0;
        const oldPrice = Number(p.oldPrice) || 0;
        const stock = Number(p.stock) || 0;
        const sku = p.sku ? `<span style="background:#e0e0e0;color:#333;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:30px;margin-left:0.3rem;font-family:monospace;">${escapeHTML(p.sku)}</span>` : '';
        const catObj = getCategoryById(p.category);
        const categoryLabel = catObj ? `${catObj.emoji} ${t(catObj.label)}` : (p.category || '—');
        const isPromo = oldPrice > price && oldPrice > 0;
        let stockColor = 'var(--text)', stockEmoji = '📦';
        if (stock === 0) { stockColor = 'var(--danger)'; stockEmoji = '❌'; }
        else if (stock <= 4) { stockColor = 'var(--warning)'; stockEmoji = '⚠️'; }
        else if (stock >= 20) { stockColor = 'var(--success)'; stockEmoji = '✅'; }
        const hasVideo = typeof p.video === 'string' && p.video.trim() !== '';
        const videoBadge = hasVideo ? `<span style="background:var(--gold);color:#fff;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:30px;margin-left:0.3rem;vertical-align:middle;">🎥</span>` : '';
        const hasVariants = p.variants && p.variants.length > 0;
        const variantBadge = hasVariants ? `<span style="background:var(--info);color:#fff;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:30px;margin-left:0.3rem;vertical-align:middle;">🎨</span>` : '';
        const vendorBadge = p.vendorId && p.vendorId !== 'smartswi9a'
            ? `<span style="background:#3498db;color:#fff;font-size:0.6rem;padding:0.1rem 0.4rem;border-radius:30px;margin-left:0.3rem;vertical-align:middle;">🏪</span>`
            : '';
        const pendingBadge = p.status === 'pending_admin_approval'
            ? `<span style="background:var(--warning);color:#fff;font-size:0.6rem;padding:0.1rem 0.4rem;border-radius:30px;margin-left:0.3rem;vertical-align:middle;">⏳ À valider</span>`
            : '';

        html += `
            <div class="admin-list-item" data-product-id="${p.id}">
                <div class="admin-list-item-info">
                    <strong>${name}${videoBadge}${variantBadge}${vendorBadge}${pendingBadge}${sku}</strong>
                    <div style="font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem;">📂 ${categoryLabel} · 💰 ${price} MAD ${isPromo ? `<small style="text-decoration:line-through;color:var(--text-dim);">${oldPrice}</small>` : ''} · <span style="color:${stockColor};font-weight:700;">${stockEmoji} ${stock}</span></div>
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
        for (let i = 1; i <= totalPages; i++) html += `<button class="admin-btn-icon ${i === productsCurrentPage ? 'active' : ''}" data-page="${i}" style="${i === productsCurrentPage ? 'background:var(--gold);color:#fff;' : ''}">${i}</button>`;
        html += `<button class="admin-btn-icon" data-page="next" ${productsCurrentPage === totalPages ? 'disabled' : ''}>›</button></div>`;
    }
    container.innerHTML = html;
    attachClearTempFilterListener();

    container.querySelectorAll('[data-action="restock-product"]').forEach(btn => btn.addEventListener('click', () => openRestockModal(btn.dataset.id)));
    container.querySelectorAll('[data-action="edit-product"]').forEach(btn => btn.addEventListener('click', () => editProduct(btn.dataset.id)));
    container.querySelectorAll('[data-action="delete-product"]').forEach(btn => btn.addEventListener('click', () => deleteProduct(btn.dataset.id)));
    container.querySelectorAll('[data-page]').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.page;
            if (val === 'prev' && productsCurrentPage > 1) productsCurrentPage--;
            else if (val === 'next' && productsCurrentPage < totalPages) productsCurrentPage++;
            else if (!isNaN(parseInt(val))) productsCurrentPage = parseInt(val);
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

    if (tempStockFilter === 'out') filtered = filtered.filter(p => (Number(p.stock) || 0) === 0);
    else if (tempStockFilter === 'low') filtered = filtered.filter(p => { const s = Number(p.stock) || 0; return s > 0 && s <= 4; });

    if (resetPage) productsCurrentPage = 1;
    renderProductsList(filtered);
}

// ============================================================
// RESTOCK & FORMULAIRE PRODUIT
// ============================================================
async function openRestockModal(productId) {
    let product = cachedProducts.find(p => p.id === productId);
    if (!product) {
        const snap = await getDoc(doc(db, "products", productId));
        if (!snap.exists()) { showToast('❌ Produit introuvable'); return; }
        product = { id: snap.id, ...snap.data() };
    }

    if (product.variants && product.variants.length > 0) {
        showToast('ℹ️ Ce produit a des variantes. Modifiez les stocks via l\'édition.');
        await editProduct(productId);
        return;
    }

    document.getElementById('restockModal')?.remove();
    const name = escapeHTML(product.nameFr || 'Sans nom');
    const currentStock = Math.max(0, Number(product.stock) || 0);

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
        btn.disabled = true; btn.textContent = '⏳...';
        try {
            await updateDoc(doc(db, "products", productId), { stock: increment(qty), updatedAt: Timestamp.now() });
            showToast('✅ Stock +' + qty);
            closeModal();
            await loadProducts(true);
            await loadStats();
        } catch (e) {
            showToast('❌ ' + e.message);
            btn.disabled = false; btn.textContent = '✅ Ajouter';
        }
    });
}

function attachProductFormEvents() {
    const pNameFr = document.getElementById('pNameFr');
    const pSlug = document.getElementById('pSlug');
    if (pNameFr && pSlug) {
        pNameFr.addEventListener('input', () => {
            if (!document.getElementById('productEditId').value) pSlug.value = slugify(pNameFr.value);
        });
    }

    document.getElementById('generateSkuBtn')?.addEventListener('click', () => {
        const category = document.getElementById('pCategory').value;
        document.getElementById('pSku').value = generateUniqueSku(category);
    });

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

    document.getElementById('clearVideoBtn')?.addEventListener('click', () => {
        document.getElementById('pVideo').value = '';
        showToast('🗑️ Champ vidéo vidé');
    });

    document.getElementById('saveProductBtn')?.addEventListener('click', saveProduct);
    document.getElementById('cancelProductEdit')?.addEventListener('click', resetProductForm);
    document.getElementById('generateVariantsBtn')?.addEventListener('click', generateVariants);
}

function generateVariants() {
    const sizesRaw = document.getElementById('pSizes').value.trim();
    const colorsRaw = document.getElementById('pColors').value.trim();
    const sizes = sizesRaw ? sizesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const colors = colorsRaw ? colorsRaw.split(',').map(c => c.trim()).filter(Boolean) : [];

    const existingValues = {};
    document.querySelectorAll('#variantsTable tbody tr').forEach(tr => {
        const key = `${tr.dataset.size || ''}__${tr.dataset.color || ''}`;
        existingValues[key] = {
            price: parseFloat(tr.querySelector('.var-price')?.value) || null,
            stock: parseInt(tr.querySelector('.var-stock')?.value) ?? null
        };
    });

    const container = document.getElementById('variantsContainer');
    const tbody = document.querySelector('#variantsTable tbody');

    if (sizes.length === 0 && colors.length === 0) {
        container.style.display = 'none';
        tbody.innerHTML = '';
        return;
    }

    tbody.innerHTML = '';
    container.style.display = 'block';

    const combinations = [];
    if (sizes.length > 0 && colors.length > 0) sizes.forEach(s => colors.forEach(c => combinations.push({ size: s, color: c })));
    else if (sizes.length > 0) sizes.forEach(s => combinations.push({ size: s, color: '' }));
    else if (colors.length > 0) colors.forEach(c => combinations.push({ size: '', color: c }));

    const defaultPrice = parseFloat(document.getElementById('pPrice').value) || 0;
    const defaultStock = parseInt(document.getElementById('pStock').value) || 0;

    combinations.forEach(combo => {
        const key = `${combo.size || ''}__${combo.color || ''}`;
        const existing = existingValues[key];
        const price = existing?.price ?? defaultPrice;
        const stock = existing?.stock ?? defaultStock;

        const label = [combo.size, combo.color].filter(Boolean).join(' - ');
        const tr = document.createElement('tr');
        tr.dataset.size = combo.size;
        tr.dataset.color = combo.color;

        tr.innerHTML = `
            <td style="font-weight:600;font-size:0.85rem;">${escapeHTML(label)}</td>
            <td><input type="number" class="var-price" value="${price}" min="0" max="100000" step="0.01" style="width:100%;padding:0.3rem;border:1px solid var(--border);border-radius:4px;text-align:center;"></td>
            <td><input type="number" class="var-stock" value="${stock}" min="0" max="99999" step="1" style="width:100%;padding:0.3rem;border:1px solid var(--border);border-radius:4px;text-align:center;"></td>
        `;
        tbody.appendChild(tr);
    });
}

function resetProductForm() {
    document.getElementById('productFormTitle').textContent = '➕ Ajouter un produit';
    document.getElementById('productEditId').value = '';
    ['pNameFr', 'pNameAr', 'pNameEn', 'pSlug', 'pSku', 'pPrice', 'pOldPrice', 'pPurchasePrice', 'pStock', 'pRating',
     'pDescFr', 'pDescAr', 'pDescEn', 'pFeaturesFr', 'pFeaturesAr', 'pFeaturesEn', 'pImg', 'pGallery', 'pVideo',
     'pWeight', 'pLength', 'pWidth', 'pHeight', 'pSizes', 'pColors'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

    document.getElementById('pParentCategory').value = '';
    document.getElementById('pCategory').innerHTML = '<option value="">-- Choisir une sous-catégorie --</option>';
    document.getElementById('pIsNew').checked = false;
    document.getElementById('pLogisticsFee').checked = true;
    document.getElementById('pSizeGuide').checked = false;
    document.getElementById('variantsContainer').style.display = 'none';
    document.querySelector('#variantsTable tbody').innerHTML = '';
    document.getElementById('pImgFile').value = '';
    document.getElementById('pGalleryFiles').value = '';
    document.getElementById('pImgPreview').style.display = 'none';
    document.getElementById('pGalleryPreview').innerHTML = '';
    document.getElementById('saveProductBtnText').textContent = 'Enregistrer le produit';
    document.getElementById('cancelProductEdit').style.display = 'none';
    document.getElementById('tab-products')?.scrollIntoView({ behavior: 'smooth' });
}

async function editProduct(id) {
    try {
        const snap = await getDoc(doc(db, "products", id));
        if (!snap.exists()) return;
        const p = snap.data();
        document.getElementById('productFormTitle').textContent = '✏️ Modifier le produit';
        document.getElementById('productEditId').value = id;
        document.getElementById('pNameFr').value = p.nameFr || '';
        document.getElementById('pNameAr').value = p.nameAr || '';
        document.getElementById('pNameEn').value = p.nameEn || '';
        document.getElementById('pSlug').value = p.slug || '';
        document.getElementById('pSku').value = p.sku || '';

        const parentSelect = document.getElementById('pParentCategory');
        const childSelect = document.getElementById('pCategory');
        let foundParentId = '';
        CATEGORY_GROUPS.forEach(g => { if (g.children.some(c => c.id === p.category)) foundParentId = g.id; });

        if (foundParentId) {
            parentSelect.value = foundParentId;
            parentSelect.dispatchEvent(new Event('change'));
            childSelect.value = p.category || '';
        } else {
            parentSelect.value = '';
            childSelect.innerHTML = `<option value="${p.category}">${p.category} (Ancienne)</option>`;
            childSelect.value = p.category || '';
        }

        const hasLogisticsFee = p.logisticsFee > 0;
        document.getElementById('pLogisticsFee').checked = hasLogisticsFee;
        document.getElementById('pPrice').value = hasLogisticsFee ? (Number(p.price) - Number(p.logisticsFee)) : (p.price || '');

        document.getElementById('pOldPrice').value = p.oldPrice || '';
        document.getElementById('pPurchasePrice').value = p.purchasePrice || '';
        document.getElementById('pStock').value = p.stock || '';
        document.getElementById('pRating').value = p.ratingAvg || '';
        document.getElementById('pIsNew').checked = !!p.isNew;
        document.getElementById('pSizeGuide').checked = !!p.hasSizeGuide;

        document.getElementById('pWeight').value = p.dimensions?.weight || '';
        document.getElementById('pLength').value = p.dimensions?.length || '';
        document.getElementById('pWidth').value = p.dimensions?.width || '';
        document.getElementById('pHeight').value = p.dimensions?.height || '';

        const variantsContainer = document.getElementById('variantsContainer');
        const variantsTbody = document.querySelector('#variantsTable tbody');
        variantsTbody.innerHTML = '';

        if (p.variants && p.variants.length > 0) {
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
                    <td style="font-weight:600;font-size:0.85rem;">${escapeHTML(label)}</td>
                    <td><input type="number" class="var-price" value="${combo.price || p.price}" min="0" max="100000" step="0.01" style="width:100%;padding:0.3rem;border:1px solid var(--border);border-radius:4px;text-align:center;"></td>
                    <td><input type="number" class="var-stock" value="${combo.stock || 0}" min="0" max="99999" step="1" style="width:100%;padding:0.3rem;border:1px solid var(--border);border-radius:4px;text-align:center;"></td>
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
        if (p.img && typeof p.img === 'string') { ip.src = p.img.startsWith('http') ? p.img : '/' + p.img; ip.style.display = 'block'; }
        else ip.style.display = 'none';
        const gp = document.getElementById('pGalleryPreview');
        gp.innerHTML = '';
        (p.gallery || []).forEach(url => {
            const img = document.createElement('img');
            img.src = url.startsWith('http') ? url : '/' + url;
            gp.appendChild(img);
        });
        document.getElementById('saveProductBtnText').textContent = 'Enregistrer';
        document.getElementById('cancelProductEdit').style.display = 'inline-flex';
        document.getElementById('tab-products')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { showToast('❌ Erreur de chargement'); }
}

async function saveProduct() {
    const editId = document.getElementById('productEditId').value;
    const saveBtn = document.getElementById('saveProductBtn');
    const btnText = document.getElementById('saveProductBtnText');
    const nameFr = document.getElementById('pNameFr').value.trim();
    const slug = document.getElementById('pSlug').value.trim();
    const sku = document.getElementById('pSku').value.trim();
    const priceBase = parseFloat(document.getElementById('pPrice').value);
    const applyFee = document.getElementById('pLogisticsFee').checked;
    const purchasePriceRaw = parseFloat(document.getElementById('pPurchasePrice').value);
    const stockRaw = parseInt(document.getElementById('pStock').value);
    const category = document.getElementById('pCategory').value;

    if (!nameFr) { showToast('⚠️ Le nom est obligatoire'); return; }
    if (!slug) { showToast('⚠️ Le slug est obligatoire'); return; }
    if (!category) { showToast('⚠️ Sélectionnez une sous-catégorie'); return; }
    if (isNaN(priceBase) || priceBase < 0) { showToast('⚠️ Prix invalide'); return; }
    if (isNaN(stockRaw) || stockRaw < 0) { showToast('⚠️ Stock invalide'); return; }

    saveBtn.disabled = true;
    const oldText = btnText.textContent;
    btnText.textContent = '⏳ Enregistrement...';

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
        const variants = [];
        const variantsTbody = document.querySelector('#variantsTable tbody');
        if (document.getElementById('variantsContainer').style.display !== 'none') {
            variantsTbody.querySelectorAll('tr').forEach(tr => {
                const vPrice = parseFloat(tr.querySelector('.var-price').value);
                const vStock = parseInt(tr.querySelector('.var-stock').value);
                const safeSize = String(tr.dataset.size).replace(/[<>"'&]/g, '').trim().slice(0, 50);
                const safeColor = String(tr.dataset.color).replace(/[<>"'&]/g, '').trim().slice(0, 50);
                if (!Number.isFinite(vPrice) || vPrice < 0 || vPrice > 100000) throw new Error(`Prix invalide pour ${safeSize}/${safeColor}`);
                if (!Number.isFinite(vStock) || vStock < 0 || vStock > 99999) throw new Error(`Stock invalide pour ${safeSize}/${safeColor}`);
                variants.push({ size: safeSize, color: safeColor, price: vPrice + (applyFee ? 5 : 0), stock: vStock });
            });
        }

        let finalStock = stockRaw;
        if (variants.length > 0) finalStock = variants.reduce((sum, v) => sum + v.stock, 0);

        const dimensions = {
            weight: parseFloat(document.getElementById('pWeight').value) || 0,
            length: parseFloat(document.getElementById('pLength').value) || 0,
            width: parseFloat(document.getElementById('pWidth').value) || 0,
            height: parseFloat(document.getElementById('pHeight').value) || 0
        };

        let finalSku = sku;
        if (!finalSku) finalSku = generateUniqueSku(category);
        const finalPrice = priceBase + (applyFee ? 5 : 0);

        const productData = {
            nameFr,
            nameAr: document.getElementById('pNameAr').value.trim(),
            nameEn: document.getElementById('pNameEn').value.trim(),
            slug, sku: finalSku, category,
            basePrice: priceBase,
            logisticsFee: applyFee ? 5 : 0,
            price: finalPrice,
            oldPrice: Math.max(0, parseFloat(document.getElementById('pOldPrice').value) || 0),
            purchasePrice: isNaN(purchasePriceRaw) ? 0 : purchasePriceRaw,
            stock: finalStock,
            ratingAvg: Math.min(5, Math.max(0, parseFloat(document.getElementById('pRating').value) || 0)),
            isNew: document.getElementById('pIsNew').checked,
            hasSizeGuide: document.getElementById('pSizeGuide').checked,
            dimensions, variants,
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
            showToast('✅ Produit mis à jour');
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
            productData.isSpeedafStored = false;
            productData.vendorId = 'smartswi9a'; // Admin crée pour Swi9a
            productData.status = 'approved';
            if (!videoValue) delete productData.video;
            await setDoc(doc(db, "products", newId), productData);
            showToast('✅ Produit créé');
        }
        resetProductForm();
        await loadProducts(true);
        await loadStats();
    } catch (e) {
        showToast('❌ ' + (e.message || 'Erreur'));
    } finally {
        saveBtn.disabled = false;
        btnText.textContent = oldText;
    }
}

async function deleteProduct(id) {
    const confirmed = await confirmAction('Supprimer définitivement ce produit ?', {
        title: '🗑️ Supprimer', confirmText: 'Supprimer', cancelText: 'Annuler', variant: 'danger'
    });
    if (!confirmed) return;
    try {
        const snap = await getDoc(doc(db, "products", id));
        if (!snap.exists()) { showToast('⚠️ Produit introuvable'); return; }
        const product = snap.data();
        await deleteDoc(doc(db, "products", id));
        const toDel = [];
        if (isStorageUrl(product.img)) toDel.push(product.img);
        (product.gallery || []).forEach(u => { if (isStorageUrl(u)) toDel.push(u); });
        if (toDel.length) await deleteStorageImages(toDel);
        showToast('🗑️ Produit supprimé');
        await loadProducts(true);
        await loadStats();
    } catch (e) { showToast('❌ Erreur'); }
}

// ============================================================
// CLIENTS
// ============================================================
async function loadUsers() {
    const container = document.getElementById('adminUsersList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ Chargement...</div>`;
    try {
        const snap = await getDocs(collection(db, "users"));
        cachedUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderUsersList(cachedUsers);
    } catch (e) {
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur</div>`;
    }
}

function renderUsersList(users) {
    const container = document.getElementById('adminUsersList');
    if (!container) return;
    if (users.length === 0) { container.innerHTML = `<div class="admin-empty">Aucun client.</div>`; return; }
    let html = '';
    users.forEach(u => {
        const name = escapeHTML(u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || '—');
        const email = escapeHTML(u.email || '');
        const phone = escapeHTML(u.phone || '');
        const role = u.role || 'user';
        const signupMethod = u.signupMethod || 'otp';
        const methodEmoji = getSignupMethodEmoji(signupMethod);
        const methodLabel = getSignupMethodLabel(signupMethod);
        const roleBadge = role === 'vendor'
            ? `<span style="background:var(--info);color:#fff;padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">🏪 Vendeur</span>`
            : '';
        html += `
            <div class="admin-list-item" data-user-id="${u.id}">
                <div class="admin-list-item-info">
                    <strong>${name}</strong> ${roleBadge}
                    <div style="font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem;">📧 ${email} ${phone ? `· 📞 ${phone}` : ''}</div>
                    <div style="font-size:0.75rem;color:var(--text-dim);margin-top:0.2rem;display:flex;gap:0.6rem;flex-wrap:wrap;">
                        <span>${methodEmoji} ${methodLabel}</span>
                        <span>Rôle : <strong style="color:${role === 'admin' ? 'var(--gold)' : 'var(--text-muted)'};">${role}</strong></span>
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
                showToast('⚠️ Vous ne pouvez pas retirer votre propre rôle admin');
                sel.value = ROLES.ADMIN;
                return;
            }
            try {
                await updateDoc(doc(db, "users", userId), { role: newRole });
                showToast('✅ Rôle mis à jour');
            } catch (e) {
                showToast('❌ Erreur');
                sel.value = newRole === 'admin' ? 'user' : 'admin';
            }
        });
    });

    container.querySelectorAll('[data-action="delete-user"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const userId = btn.dataset.id;
            if (currentAdmin && userId === currentAdmin.uid) {
                showToast('⚠️ Vous ne pouvez pas vous supprimer');
                return;
            }
            const confirmed = await confirmAction('Supprimer définitivement ce client ?', {
                title: '🗑️ Supprimer', confirmText: 'Supprimer', cancelText: 'Annuler', variant: 'danger'
            });
            if (!confirmed) return;
            try {
                await deleteDoc(doc(db, "users", userId));
                showToast('🗑️ Client supprimé');
                await loadUsers();
                await loadStats();
            } catch (e) { showToast('❌ Erreur'); }
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

// ------------------------------------------------------------
// FIN PARTIE 2/4 — la suite (vendeurs + retraits + blog + coupons + Speedaf) commence en PARTIE 3/4
// ------------------------------------------------------------
// ============================================================
// 🆕 VENDEURS — loadVendors / filterVendorsList / renderVendorsList
// ============================================================
const VENDOR_STATUS_ORDER = {
    [VENDOR_STATUS.PENDING]: 0,
    [VENDOR_STATUS.APPROVED]: 1,
    [VENDOR_STATUS.SUSPENDED]: 2,
    [VENDOR_STATUS.REJECTED]: 3
};

async function loadVendors() {
    const container = document.getElementById('adminVendorsList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ Chargement des vendeurs...</div>`;
    try {
        const q = query(collection(db, "users"), where("role", "==", "vendor"), limit(500));
        const snap = await getDocs(q);
        cachedVendors = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        // N2 : enrichir chaque vendeur avec le statut RÉEL du contrat (source de vérité = contracts/contract_<uid>)
        // Lecture en parallèle, tolérante aux erreurs (collection absente, permission refusée, etc.)
        const contractSnaps = await Promise.all(
            cachedVendors.map(v =>
                getDoc(doc(db, "contracts", `contract_${v.id}`))
                    .then(s => ({ ok: true, exists: s.exists(), data: s.exists() ? s.data() : null }))
                    .catch(() => ({ ok: false, exists: false, data: null }))
            )
        );
        cachedVendors.forEach((v, i) => {
            const r = contractSnaps[i];
            v._contractExists = r.ok && r.exists;
            v._contractStatus = r.ok && r.exists ? (r.data?.status || 'pending') : null;
            v._contractVersion = r.ok && r.exists ? (r.data?.version || null) : null;
        });

        // B4 : tri par priorité d'action
        cachedVendors.sort((a, b) => {
            const sa = a.vendorInfo?.status || VENDOR_STATUS.PENDING;
            const sb = b.vendorInfo?.status || VENDOR_STATUS.PENDING;
            const oa = VENDOR_STATUS_ORDER[sa] ?? 99;
            const ob = VENDOR_STATUS_ORDER[sb] ?? 99;
            if (oa !== ob) return oa - ob;
            // au sein d'un statut : plus récents en premier
            const da = toDate(a.createdAt)?.getTime() || 0;
            const db_ = toDate(b.createdAt)?.getTime() || 0;
            return db_ - da;
        });

        filterVendorsList();
    } catch (e) {
        console.error(e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur de chargement.</div>`;
    }
}

function filterVendorsList() {
    const search = document.getElementById('vendorSearchAdmin')?.value.toLowerCase().trim() || '';
    const activeFilter = document.querySelector('[data-vendor-filter].active');
    const statusFilter = activeFilter?.dataset.vendorFilter || 'all';

    let filtered = cachedVendors;
    if (statusFilter !== 'all') {
        filtered = filtered.filter(v => (v.vendorInfo?.status || 'pending') === statusFilter);
    }
    if (search) {
        filtered = filtered.filter(v => {
            const name = (v.vendorInfo?.shopName || v.name || '').toLowerCase();
            const email = (v.email || '').toLowerCase();
            const phone = (v.phone || '').toLowerCase();
            return name.includes(search) || email.includes(search) || phone.includes(search);
        });
    }

    renderVendorsList(filtered);
}

function renderVendorsList(vendors) {
    const container = document.getElementById('adminVendorsList');
    if (!container) return;
    if (vendors.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucun vendeur trouvé.</div>`;
        return;
    }

    let html = '';
    vendors.forEach(v => {
        const shopName = escapeHTML(v.vendorInfo?.shopName || v.name || 'Boutique');
        const email = escapeHTML(v.email || '');
        const phone = escapeHTML(v.phone || '');
        const city = escapeHTML(v.vendorInfo?.city || '');
        const iceCin = escapeHTML(v.vendorInfo?.iceCin || '');
        const status = v.vendorInfo?.status || 'pending';
        const shippingMethod = v.vendorInfo?.shippingMethod === 'dropoff' ? '📤 Drop-off' : '📥 Fulfillment';
        const createdAt = toDate(v.createdAt)?.toLocaleDateString('fr-FR') || '—';

        // N2 : statut CONTRAT réel (contracts/ en priorité, fallback legacy)
        const contractStatus = v._contractStatus || v.vendorInfo?.contractStatus || 'pending';
        const canApprove = contractStatus === 'accepted';

        let statusBadge = '';
        if (status === 'pending') statusBadge = `<span style="background:var(--warning-bg);color:var(--warning);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">⏳ En attente</span>`;
        else if (status === 'approved') statusBadge = `<span style="background:var(--success-bg);color:var(--success);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">✅ Approuvé</span>`;
        else if (status === 'rejected') statusBadge = `<span style="background:var(--danger-bg);color:var(--danger);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">❌ Rejeté</span>`;
        else if (status === 'suspended') statusBadge = `<span style="background:var(--danger-bg);color:var(--danger);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">🚫 Suspendu</span>`;

        // B5 : badge contrat — utilise la source de vérité contracts/
        let contractBadge = '';
        if (contractStatus === 'accepted') {
            const ver = v._contractVersion ? ` (v${escapeHTML(v._contractVersion)})` : '';
            contractBadge = `<span style="background:var(--success-bg);color:var(--success);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.7rem;font-weight:700;">📜 Contrat signé${ver}</span>`;
        } else if (contractStatus === 'revoked') {
            contractBadge = `<span style="background:var(--danger-bg);color:var(--danger);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.7rem;font-weight:700;">📜 Contrat révoqué</span>`;
        } else if (!v._contractExists) {
            contractBadge = `<span style="background:var(--warning-bg);color:var(--warning);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.7rem;font-weight:700;">📜 Aucun contrat</span>`;
        } else {
            contractBadge = `<span style="background:var(--warning-bg);color:var(--warning);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.7rem;font-weight:700;">📜 Contrat non signé</span>`;
        }

        let actionsHtml = '';
        if (status === 'pending') {
            const approveDisabledAttr = canApprove ? '' : 'disabled title="Le contrat doit être signé (statut accepted) avant approbation"';
            const approveStyle = canApprove ? '' : 'opacity:0.5;cursor:not-allowed;';
            actionsHtml = `
                <button class="admin-btn-approve" data-action="vendor-approve" data-id="${v.id}" ${approveDisabledAttr} style="${approveStyle}">✅ Approuver</button>
                <button class="admin-btn-icon admin-btn-danger" data-action="vendor-reject" data-id="${v.id}">❌ Rejeter</button>
            `;
        } else if (status === 'approved') {
            actionsHtml = `
                <button class="admin-btn-icon admin-btn-danger" data-action="vendor-suspend" data-id="${v.id}">🚫 Suspendre</button>
            `;
        } else if (status === 'suspended' || status === 'rejected') {
            const approveDisabledAttr = canApprove ? '' : 'disabled title="Le contrat doit être signé (statut accepted) avant approbation"';
            const approveStyle = canApprove ? '' : 'opacity:0.5;cursor:not-allowed;';
            actionsHtml = `
                <button class="admin-btn-approve" data-action="vendor-approve" data-id="${v.id}" ${approveDisabledAttr} style="${approveStyle}">✅ Réactiver</button>
            `;
        }

        html += `
            <div class="admin-list-item" style="flex-direction:column; align-items:stretch; padding:1rem;">
                <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.5rem;">
                    <div>
                        <strong style="color:var(--gold); font-size:1rem;">🏪 ${shopName}</strong>
                        <span style="margin-left:0.5rem;">${statusBadge}</span>
                        <span style="margin-left:0.5rem;">${contractBadge}</span>
                    </div>
                    <div style="font-size:0.8rem; color:var(--text-dim);">Inscrit le ${createdAt}</div>
                </div>
                <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.5rem;">
                    📧 ${email} · 📞 ${phone} · 🏙️ ${city} · 🆔 ${iceCin}<br>
                    🚚 Mode : <strong>${shippingMethod}</strong>
                </div>
                <div style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:0.5rem;">
                    ${actionsHtml}
                </div>
            </div>
        `;
    });

    container.innerHTML = html;

    container.querySelectorAll('[data-action="vendor-approve"]').forEach(btn => {
        if (btn.disabled) return;
        btn.addEventListener('click', () => handleVendorAction(btn.dataset.id, VENDOR_STATUS.APPROVED));
    });
    container.querySelectorAll('[data-action="vendor-reject"]').forEach(btn => btn.addEventListener('click', () => handleVendorAction(btn.dataset.id, VENDOR_STATUS.REJECTED)));
    container.querySelectorAll('[data-action="vendor-suspend"]').forEach(btn => btn.addEventListener('click', () => handleVendorAction(btn.dataset.id, VENDOR_STATUS.SUSPENDED)));
}

async function handleVendorAction(vendorId, newStatus) {
    const labels = { approved: 'approuver', rejected: 'rejeter', suspended: 'suspendre' };
    const confirmed = await confirmAction(`Voulez-vous vraiment ${labels[newStatus]} ce vendeur ?`, {
        title: '⚠️ Confirmation', confirmText: 'Oui', cancelText: 'Annuler', variant: newStatus === 'approved' ? 'primary' : 'danger'
    });
    if (!confirmed) return;

    try {
        // N2 : dans la transaction, relire le CONTRAT (source de vérité) et sync vendorInfo.contractStatus
        await runTransaction(db, async (tx) => {
            const userRef = doc(db, "users", vendorId);
            const userSnap = await tx.get(userRef);
            if (!userSnap.exists()) throw new Error("Utilisateur vendeur introuvable.");

            const data = userSnap.data();
            const vendorInfo = data.vendorInfo || {};

            let contractOk = false;
            let contractStatusValue = null;

            if (newStatus === VENDOR_STATUS.APPROVED) {
                const contractRef = doc(db, "contracts", `contract_${vendorId}`);
                const contractSnap = await tx.get(contractRef);
                if (contractSnap.exists()) {
                    contractStatusValue = contractSnap.data()?.status || 'pending';
                    contractOk = contractStatusValue === 'accepted';
                } else {
                    // Fallback legacy (contrat antérieur à la collection contracts/)
                    contractOk = vendorInfo.contractStatus === 'accepted';
                    contractStatusValue = contractOk ? 'accepted' : 'pending';
                }
                if (!contractOk) {
                    throw new Error(`Contrat non signé (statut "${contractStatusValue}"). Approbation refusée — demandez au vendeur de signer.`);
                }
            }

            // 1) users/{uid} — mise à jour du statut vendeur
            const userUpdate = {
                "vendorInfo.status": newStatus,
                "vendorInfo.updatedAt": serverTimestamp()
            };
            // N2 : on ne force contractStatus = accepted QU'À l'approbation, et seulement après vérif
            if (newStatus === VENDOR_STATUS.APPROVED) {
                userUpdate["vendorInfo.contractStatus"] = 'accepted';
            }
            tx.update(userRef, userUpdate);

            // 2) vendorsPublic/{uid} — collection publique (cf. E10)
            const publicRef = doc(db, "vendorsPublic", vendorId);
            const shopName = vendorInfo.shopName || data.name || 'Boutique';
            const city = vendorInfo.city || '';
            tx.set(publicRef, {
                shopName: String(shopName).slice(0, 60),
                status: newStatus,
                city: String(city).slice(0, 80),
                updatedAt: serverTimestamp()
            }, { merge: true });
        });

        const verb = newStatus === VENDOR_STATUS.APPROVED ? 'approuvé'
            : newStatus === VENDOR_STATUS.REJECTED ? 'rejeté'
            : 'suspendu';
        showToast(`✅ Vendeur ${verb}`);
        await loadVendors();
    } catch (e) {
        console.error('❌ handleVendorAction:', e);
        showToast('❌ ' + (e.message || 'Erreur'));
    }
}

// ============================================================
// 🆕 RETRAITS / PAYOUTS (collection : payout_requests — cf. N6)
// ============================================================
async function loadPayouts() {
    const container = document.getElementById('payoutsList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ Chargement des demandes...</div>`;
    try {
        // B8 : orderBy + limit
        const q = query(
            collection(db, "payout_requests"),
            orderBy("requestedAt", "desc"),
            limit(200)
        );
        const snap = await getDocs(q);
        cachedPayouts = snap.docs.map(d => ({ id: d.id, ...d.data(), requestedAt: toDate(d.data().requestedAt) }));
        cachedPayouts.sort((a, b) => (b.requestedAt?.getTime() || 0) - (a.requestedAt?.getTime() || 0));
        filterPayoutsList();
    } catch (e) {
        console.error(e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur de chargement.</div>`;
    }
}

function filterPayoutsList() {
    const search = document.getElementById('payoutSearchAdmin')?.value.toLowerCase().trim() || '';
    const activeFilter = document.querySelector('[data-payout-filter].active');
    const statusFilter = activeFilter?.dataset.payoutFilter || 'all';

    let filtered = cachedPayouts;
    if (statusFilter !== 'all') {
        filtered = filtered.filter(p => (p.status || 'pending') === statusFilter);
    }
    if (search) {
        filtered = filtered.filter(p => {
            const name = (p.vendorName || '').toLowerCase();
            const phone = (p.phone || '').toLowerCase();
            const vid = (p.vendorId || '').toLowerCase();
            return name.includes(search) || phone.includes(search) || vid.includes(search);
        });
    }

    renderPayoutsList(filtered);
}

function renderPayoutsList(payouts) {
    const container = document.getElementById('payoutsList');
    if (!container) return;
    if (payouts.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucune demande de retrait.</div>`;
        return;
    }

    let html = '';
    payouts.forEach(p => {
        // B9 : fallback si vendorName absent
        const vendorName = p.vendorName
            ? escapeHTML(p.vendorName)
            : (p.vendorId ? `Vendeur ${String(p.vendorId).slice(0, 8)}…` : 'Inconnu');
        const amount = Number(p.amount) || 0;
        const method = escapeHTML(p.method || 'Wafacash');
        const phone = escapeHTML(p.phone || '');
        const status = p.status || 'pending';
        const date = p.requestedAt ? p.requestedAt.toLocaleDateString('fr-FR') : '—';

        let statusBadge = '';
        if (status === 'pending') statusBadge = `<span style="background:var(--warning-bg);color:var(--warning);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">⏳ En attente</span>`;
        else if (status === 'paid') statusBadge = `<span style="background:var(--success-bg);color:var(--success);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">✅ Payé</span>`;
        else if (status === 'rejected') statusBadge = `<span style="background:var(--danger-bg);color:var(--danger);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">❌ Rejeté</span>`;

        let actionsHtml = '';
        if (status === 'pending') {
            actionsHtml = `
                <button class="admin-btn-approve" data-action="payout-pay" data-id="${p.id}" data-vendor="${p.vendorId}" data-amount="${amount}">✅ Marquer payé</button>
                <button class="admin-btn-icon admin-btn-danger" data-action="payout-reject" data-id="${p.id}">❌ Rejeter</button>
            `;
        }

        html += `
            <div class="admin-list-item" style="flex-direction:column; align-items:stretch; padding:1rem;">
                <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.5rem;">
                    <div>
                        <strong style="color:var(--gold); font-size:1rem;">💸 ${amount} MAD</strong>
                        <span style="margin-left:0.5rem;">${statusBadge}</span>
                    </div>
                    <div style="font-size:0.8rem; color:var(--text-dim);">Demandé le ${date}</div>
                </div>
                <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.5rem;">
                    🏪 <strong>${vendorName}</strong> · 📞 ${phone} · 📍 ${method}
                </div>
                <div style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:0.5rem;">
                    ${actionsHtml}
                </div>
            </div>
        `;
    });

    container.innerHTML = html;

    container.querySelectorAll('[data-action="payout-pay"]').forEach(btn => {
        btn.addEventListener('click', () => handlePayoutPaid(btn.dataset.id, btn.dataset.vendor, parseFloat(btn.dataset.amount)));
    });

    container.querySelectorAll('[data-action="payout-reject"]').forEach(btn => {
        btn.addEventListener('click', () => handlePayoutReject(btn.dataset.id));
    });
}

async function handlePayoutPaid(payoutId, vendorId, amount) {
    const confirmed = await confirmAction(`Confirmez-vous avoir envoyé ${amount} MAD à ce vendeur via Wafacash ?`, {
        title: '💸 Confirmer le virement', confirmText: 'Oui, payé', cancelText: 'Annuler', variant: 'primary'
    });
    if (!confirmed) return;

    try {
        await runTransaction(db, async (transaction) => {
            const payoutRef = doc(db, "payout_requests", payoutId);
            const payoutSnap = await transaction.get(payoutRef);
            if (!payoutSnap.exists()) throw new Error("Demande introuvable");

            const walletRef = doc(db, "wallets", vendorId);
            const walletSnap = await transaction.get(walletRef);
            if (!walletSnap.exists()) throw new Error("Wallet introuvable");

            const wallet = walletSnap.data();
            // B10 : message enrichi
            if (Number(wallet.availableBalance) < amount) {
                throw new Error(`Solde insuffisant : disponible ${Number(wallet.availableBalance) || 0} MAD, demandé ${amount} MAD.`);
            }

            transaction.update(walletRef, {
                availableBalance: increment(-amount),
                totalWithdrawn: increment(amount)
            });

            transaction.update(payoutRef, {
                status: 'paid',
                paidAt: Timestamp.now()
            });

            const txRef = doc(collection(db, "wallet_transactions"));
            transaction.set(txRef, {
                vendorId: vendorId,
                type: WALLET_TX_TYPE?.PAYOUT || 'payout',
                amount: -amount,
                status: "completed",
                description: `Retrait payé (admin)`,
                createdAt: Timestamp.now()
            });
        });

        showToast('✅ Retrait marqué comme payé avec succès !');
        await loadPayouts();
    } catch (e) {
        console.error(e);
        showToast('❌ ' + (e.message || 'Erreur'));
    }
}

async function handlePayoutReject(payoutId) {
    const confirmed = await confirmAction('Rejeter cette demande de retrait ? Le solde ne sera pas déduit.', {
        title: '❌ Rejeter', confirmText: 'Rejeter', cancelText: 'Annuler', variant: 'danger'
    });
    if (!confirmed) return;

    try {
        await updateDoc(doc(db, "payout_requests", payoutId), {
            status: 'rejected',
            rejectedAt: Timestamp.now()
        });
        showToast('❌ Demande rejetée');
        await loadPayouts();
    } catch (e) {
        showToast('❌ Erreur : ' + e.message);
    }
}

// ============================================================
// BLOG
// ============================================================
async function loadBlogPosts() {
    const container = document.getElementById('adminBlogList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ Chargement des articles...</div>`;
    try {
        const snap = await getDocs(collection(db, "blog"));
        cachedBlogPosts = snap.docs.map(d => {
            const data = d.data();
            return { id: d.id, ...data, createdAt: toDate(data.createdAt), updatedAt: toDate(data.updatedAt), publishedAt: toDate(data.publishedAt) };
        });
        cachedBlogPosts.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
        blogCurrentPage = 1;
        renderBlogListAdmin(cachedBlogPosts);
    } catch (e) {
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur</div>`;
    }
}

function renderBlogListAdmin(posts) {
    const container = document.getElementById('adminBlogList');
    if (!container) return;
    if (posts.length === 0) { container.innerHTML = `<div class="admin-empty">Aucun article.</div>`; return; }
    const totalPages = Math.max(1, Math.ceil(posts.length / BLOG_PER_PAGE));
    if (blogCurrentPage > totalPages) blogCurrentPage = totalPages;
    const start = (blogCurrentPage - 1) * BLOG_PER_PAGE;
    const pagePosts = posts.slice(start, start + BLOG_PER_PAGE);
    let html = '';

    pagePosts.forEach(post => {
        const title = escapeHTML(post.title || 'Sans titre');
        const categoryLabel = escapeHTML(tBlogCategory(post.category || 'general'));
        const status = post.status || 'draft';
        const statusLabel = status === 'published' ? '✅ Publié' : '📝 Brouillon';
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
                        <button class="admin-btn-icon" data-action="edit-post" data-id="${post.id}">✏️ Modifier</button>
                        <button class="admin-btn-icon admin-btn-danger" data-action="delete-post" data-id="${post.id}">🗑️</button>
                    </div>
                </div>
            </div>
        `;
    });

    if (totalPages > 1) {
        html += `<div style="display:flex;justify-content:center;gap:0.3rem;margin-top:1rem;flex-wrap:wrap;">`;
        html += `<button class="admin-btn-icon" data-blog-page="prev" ${blogCurrentPage === 1 ? 'disabled' : ''}>‹</button>`;
        for (let i = 1; i <= totalPages; i++) html += `<button class="admin-btn-icon ${i === blogCurrentPage ? 'active' : ''}" data-blog-page="${i}" style="${i === blogCurrentPage ? 'background:var(--gold);color:#fff;' : ''}">${i}</button>`;
        html += `<button class="admin-btn-icon" data-blog-page="next" ${blogCurrentPage === totalPages ? 'disabled' : ''}>›</button></div>`;
    }

    container.innerHTML = html;

    container.querySelectorAll('[data-action="edit-post"]').forEach(btn => btn.addEventListener('click', () => editBlogPost(btn.dataset.id)));
    container.querySelectorAll('[data-action="delete-post"]').forEach(btn => btn.addEventListener('click', () => deleteBlogPost(btn.dataset.id)));

    container.querySelectorAll('[data-blog-page]').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.blogPage;
            if (val === 'prev' && blogCurrentPage > 1) blogCurrentPage--;
            else if (val === 'next' && blogCurrentPage < totalPages) blogCurrentPage++;
            else if (!isNaN(parseInt(val))) blogCurrentPage = parseInt(val);
            else return;
            filterBlogList(false);
            container.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
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
        const cats = [
            { id: 'conseils', label: '💡 Conseils' }, { id: 'tendances', label: '🔥 Tendances' },
            { id: 'tests', label: '🧪 Tests' }, { id: 'tutoriels', label: '📖 Tutoriels' },
            { id: 'smart-home', label: '🏠 Smart Home' }, { id: 'gadgets', label: '📱 Gadgets' },
            { id: 'actualites', label: '📰 Actualités' }, { id: 'general', label: '📝 Général' }
        ];
        cats.forEach(cat => { html += `<option value="${cat.id}">${cat.label}</option>`; });
        catSelect.innerHTML = html;
        catSelect._populated = true;
    }
    document.getElementById('saveBlogBtn')?.addEventListener('click', saveBlogPost);
    document.getElementById('cancelBlogEdit')?.addEventListener('click', resetBlogForm);
}

function resetBlogForm() {
    document.getElementById('blogFormTitle').textContent = '➕ Nouvel article';
    document.getElementById('blogEditId').value = '';
    ['bTitle', 'bSlug', 'bExcerpt', 'bContent', 'bImage', 'bTags'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('bCategory').value = 'conseils';
    document.getElementById('bImageFile').value = '';
    document.getElementById('bStatus').value = 'draft';
    document.getElementById('bAuthor').value = 'Smart Swi9a';
    document.getElementById('bImagePreview').style.display = 'none';
    document.getElementById('saveBlogBtnText').textContent = 'Enregistrer l\'article';
    document.getElementById('cancelBlogEdit').style.display = 'none';
}

async function editBlogPost(id) {
    try {
        const snap = await getDoc(doc(db, "blog", id));
        if (!snap.exists()) return;
        const p = snap.data();
        document.getElementById('blogFormTitle').textContent = '✏️ Modifier l\'article';
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
        if (p.image && typeof p.image === 'string') { ip.src = p.image.startsWith('http') ? p.image : '/' + p.image; ip.style.display = 'block'; }
        else ip.style.display = 'none';
        document.getElementById('saveBlogBtnText').textContent = 'Enregistrer';
        document.getElementById('cancelBlogEdit').style.display = 'inline-flex';
        document.getElementById('tab-blog')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { showToast('❌ Erreur'); }
}

async function saveBlogPost() {
    const editId = document.getElementById('blogEditId').value;
    const saveBtn = document.getElementById('saveBlogBtn');
    const btnText = document.getElementById('saveBlogBtnText');
    const title = document.getElementById('bTitle').value.trim();
    const slug = document.getElementById('bSlug').value.trim();
    const content = document.getElementById('bContent').value.trim();
    if (!title) { showToast('⚠️ Le titre est obligatoire'); return; }
    if (!slug) { showToast('⚠️ Le slug est obligatoire'); return; }
    if (!content) { showToast('⚠️ Le contenu est obligatoire'); return; }

    saveBtn.disabled = true;
    const oldText = btnText.textContent;
    btnText.textContent = '⏳ Enregistrement...';
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
            showToast('✅ Article mis à jour');
            if (oldData.image && oldData.image !== imgUrl && isStorageUrl(oldData.image)) await deleteStorageImage(oldData.image);
        } else {
            postData.createdAt = Timestamp.now();
            await setDoc(doc(db, "blog", Date.now().toString()), postData);
            showToast('✅ Article créé');
        }
        resetBlogForm();
        await loadBlogPosts();
    } catch (e) {
        showToast('❌ ' + (e.message || 'Erreur'));
    } finally {
        saveBtn.disabled = false;
        btnText.textContent = oldText;
    }
}

async function deleteBlogPost(id) {
    const confirmed = await confirmAction('Supprimer définitivement cet article ?', {
        title: '🗑️ Supprimer', confirmText: 'Supprimer', cancelText: 'Annuler', variant: 'danger'
    });
    if (!confirmed) return;
    try {
        const snap = await getDoc(doc(db, "blog", id));
        if (!snap.exists()) { showToast('⚠️ Article introuvable'); return; }
        const post = snap.data();
        await deleteDoc(doc(db, "blog", id));
        if (post.image && isStorageUrl(post.image)) await deleteStorageImage(post.image);
        showToast('🗑️ Article supprimé');
        await loadBlogPosts();
    } catch (e) { showToast('❌ Erreur'); }
}

// ============================================================
// COUPONS
// ============================================================
async function loadCoupons() {
    const container = document.getElementById('couponsList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ Chargement...</div>`;
    try {
        const snap = await getDocs(collection(db, "coupons"));
        cachedCoupons = snap.docs.map(d => {
            const data = d.data();
            return { id: d.id, ...data, expiresAt: data.expiresAt ? toDate(data.expiresAt) : null, createdAt: toDate(data.createdAt), updatedAt: toDate(data.updatedAt) };
        });
        cachedCoupons.sort((a, b) => {
            if (a.isActive !== b.isActive) return b.isActive ? 1 : -1;
            return (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0);
        });
        renderCouponsList(cachedCoupons);
    } catch (e) {
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur</div>`;
    }
}

function renderCouponsList(coupons) {
    const container = document.getElementById('couponsList');
    if (!container) return;
    if (coupons.length === 0) {
        container.innerHTML = `<div class="admin-empty" style="padding:3rem 1rem;"><div style="font-size:3rem;margin-bottom:0.5rem;">🎟️</div><p>Aucun code promo.</p></div>`;
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
        if (!isActive) { statusLabel = '⏸️ Désactivé'; statusClass = 'coupon-status-inactive'; }
        else if (isExpired) { statusLabel = '⏰ Expiré'; statusClass = 'coupon-status-expired'; }
        else if (isFull) { statusLabel = '🚫 Épuisé'; statusClass = 'coupon-status-expired'; }
        else { statusLabel = '✅ Actif'; statusClass = 'coupon-status-active'; }

        let valueLabel = type === 'percentage' ? `-${value}%` : (type === 'fixed' ? `-${value} MAD` : 'Livraison offerte');

        let progressHtml = '';
        if (maxUses > 0) {
            const percent = Math.min(100, (usedCount / maxUses) * 100);
            progressHtml = `<div class="coupon-meta" style="margin-top:0.2rem;"><span>📊 Utilisations : <strong>${usedCount}/${maxUses}</strong></span></div><div class="coupon-progress"><div class="coupon-progress-fill ${percent >= 100 ? 'full' : ''}" style="width:${percent}%"></div></div>`;
        } else {
            progressHtml = `<div class="coupon-meta" style="margin-top:0.2rem;"><span>📊 Utilisations : <strong>${usedCount}</strong> (illimité)</span></div>`;
        }

        let expireLabel = '<span style="color:var(--text-dim);">Jamais</span>';
        if (expiresAt) {
            const dateStr = expiresAt.toLocaleDateString('fr-FR');
            expireLabel = isExpired ? `<span style="color:var(--danger);font-weight:700;">⚠️ Expiré le ${dateStr}</span>` : `<span style="color:var(--success);">📅 Expire le ${dateStr}</span>`;
        }

        const minLabel = minPurchase > 0 ? `<span>🛒 Min : <strong>${minPurchase} MAD</strong></span>` : '';
        const oneUseLabel = oneUsePerUser ? `<span>👤 <strong>1 usage/client</strong></span>` : '';

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
                <div class="coupon-meta">${expireLabel}${minLabel}${oneUseLabel}</div>
                ${progressHtml}
                <div class="coupon-actions">
                    <button class="admin-btn-icon" data-action="coupon-toggle" data-id="${coupon.id}">${isActive ? '⏸️ Désactiver' : '▶️ Activer'}</button>
                    <button class="admin-btn-icon" data-action="coupon-edit" data-id="${coupon.id}">✏️ Modifier</button>
                    <button class="admin-btn-icon admin-btn-danger" data-action="coupon-delete" data-id="${coupon.id}">🗑️ Supprimer</button>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;

    container.querySelectorAll('[data-action="coupon-toggle"]').forEach(btn => btn.addEventListener('click', () => toggleCouponActive(btn.dataset.id)));
    container.querySelectorAll('[data-action="coupon-edit"]').forEach(btn => btn.addEventListener('click', () => editCoupon(btn.dataset.id)));
    container.querySelectorAll('[data-action="coupon-delete"]').forEach(btn => btn.addEventListener('click', () => deleteCoupon(btn.dataset.id)));
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
        document.getElementById('cExpiresAt').value = c.expiresAt ? (toDate(c.expiresAt)?.toISOString().split('T')[0] || '') : '';
        document.getElementById('cOneUsePerUser').checked = c.oneUsePerUser === true;
        document.getElementById('cIsActive').checked = c.isActive === true;
        document.getElementById('saveCouponBtnText').textContent = 'Enregistrer';
        document.getElementById('cancelCouponEdit').style.display = 'inline-flex';
        document.getElementById('tab-coupons')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { showToast('❌ Erreur'); }
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

    if (!code || code.length < 3) { showToast('⚠️ Le code doit faire au moins 3 caractères'); return; }
    if (code.length > 30) { showToast('⚠️ Le code est trop long (max 30)'); return; }
    if (type !== 'free_shipping' && (isNaN(valueRaw) || valueRaw <= 0)) { showToast('⚠️ La valeur doit être > 0'); return; }
    if (type === 'percentage' && valueRaw > 100) { showToast('⚠️ Un pourcentage ne peut dépasser 100%'); return; }

    const deterministicId = code.replace(/[^A-Z0-9]/g, '_');

    try {
        const existingDoc = await getDoc(doc(db, "coupons", deterministicId));
        if (existingDoc.exists() && existingDoc.id !== editId) {
            showToast('⚠️ Ce code existe déjà — choisissez-en un autre');
            return;
        }

        saveBtn.disabled = true;
        const oldText = btnText.textContent;
        btnText.textContent = '⏳...';

        const couponData = {
            code, description, type,
            value: type === 'free_shipping' ? 0 : valueRaw,
            minPurchase, maxUses, oneUsePerUser, isActive,
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
            await setDoc(doc(db, "coupons", deterministicId), couponData);
            showToast('✅ Code promo créé : ' + code);
        }

        resetCouponForm();
        await loadCoupons();
    } catch (e) {
        showToast('❌ ' + (e.message || 'Erreur'));
    } finally {
        saveBtn.disabled = false;
        btnText.textContent = oldText;
    }
}

async function toggleCouponActive(id) {
    try {
        const snap = await getDoc(doc(db, "coupons", id));
        if (!snap.exists()) return;
        const current = snap.data().isActive === true;
        await updateDoc(doc(db, "coupons", id), { isActive: !current, updatedAt: Timestamp.now() });
        showToast(!current ? '✅ Code activé' : '⏸️ Code désactivé');
        await loadCoupons();
    } catch (e) { showToast('❌ Erreur'); }
}

async function deleteCoupon(id) {
    const confirmed = await confirmAction('Supprimer définitivement ce code promo ?', { title: '🗑️ Supprimer', confirmText: 'Supprimer', cancelText: 'Annuler', variant: 'danger' });
    if (!confirmed) return;
    try {
        await deleteDoc(doc(db, "coupons", id));
        showToast('🗑️ Code promo supprimé');
        await loadCoupons();
    } catch (e) { showToast('❌ Erreur'); }
}

function filterCouponsList() {
    const search = document.getElementById('couponSearchAdmin')?.value.toLowerCase().trim() || '';
    let filtered = cachedCoupons;
    if (search) filtered = filtered.filter(c => (c.code || '').toLowerCase().includes(search) || (c.description || '').toLowerCase().includes(search));
    renderCouponsList(filtered);
}

// ============================================================
// SPEEDAF — COMPLET (résout N1)
// ============================================================
async function loadSpeedafTab() {
    const container = document.getElementById('adminSpeedafList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ Chargement des commandes Speedaf...</div>`;
    try {
        const q = query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(100));
        const snap = await getDocs(q);
        speedafOrdersCache = snap.docs.map(d => {
            const data = d.data();
            return { id: d.id, ...data, createdAt: toDate(data.createdAt) };
        });
        updateSpeedafStats();
        renderSpeedafList();
    } catch (e) {
        console.error('❌ Erreur chargement Speedaf :', e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur de chargement.</div>`;
    }
}

function updateSpeedafStats() {
    let pending = 0, shipping = 0, delivered = 0;
    speedafOrdersCache.forEach(o => {
        const status = normalizeOrderStatus(o.status);
        if (status === 'pending') pending++;
        else if (status === 'shipping') shipping++;
        else if (status === 'delivered') delivered++;
    });
    const storedCount = cachedProducts.filter(p => p.isSpeedafStored === true).length;

    const elP = document.getElementById('speedafStatPending');
    const elS = document.getElementById('speedafStatShipping');
    const elD = document.getElementById('speedafStatDelivered');
    const elSt = document.getElementById('speedafStatStorage');

    if (elP) elP.textContent = pending;
    if (elS) elS.textContent = shipping;
    if (elD) elD.textContent = delivered;
    if (elSt) {
        elSt.textContent = `${storedCount} / 10`;
        elSt.style.color = storedCount >= 10 ? 'var(--danger)' : 'var(--text)';
    }
}

function renderSpeedafList() {
    const container = document.getElementById('adminSpeedafList');
    if (!container) return;

    const search = document.getElementById('speedafSearchAdmin')?.value.toLowerCase().trim() || '';
    const filterStatus = document.getElementById('speedafStatusFilter')?.value || 'all';

    let filtered = speedafOrdersCache;
    if (filterStatus !== 'all') filtered = filtered.filter(o => normalizeOrderStatus(o.status) === filterStatus);
    if (search) {
        filtered = filtered.filter(o => {
            const idStr = o.id.slice(0, 8).toLowerCase();
            const trackingStr = (o.speedafTracking || '').toLowerCase();
            const clientName = (o.deliveryAddress?.name || '').toLowerCase();
            return idStr.includes(search) || trackingStr.includes(search) || clientName.includes(search);
        });
    }

    if (filtered.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucune commande trouvée.</div>`;
        return;
    }

    let html = '';
    filtered.forEach(order => {
        const status = normalizeOrderStatus(order.status);
        const dateStr = order.createdAt ? order.createdAt.toLocaleDateString('fr-FR') : '—';
        const idShort = order.id.slice(0, 8).toUpperCase();
        const cityStr = getCityName({
            name: order.deliveryAddress?.cityAr || order.deliveryAddress?.city,
            nameFr: order.deliveryAddress?.cityFr,
            nameAr: order.deliveryAddress?.cityAr
        });

        let statusBadge = '';
        if (status === 'pending') statusBadge = '⏳ À expédier';
        else if (status === 'confirmed') statusBadge = '✅ Confirmée';
        else if (status === 'shipping') statusBadge = '🚚 En cours';
        else if (status === 'delivered') statusBadge = '📦 Livré';
        else if (status === 'returned') statusBadge = '↩️ Retourné';
        else if (status === 'cancelled') statusBadge = '❌ Annulé';

        const trackingHtml = order.speedafTracking
            ? `<div style="font-size:0.8rem; color:var(--gold); margin-top:0.2rem;">🔗 <strong>Suivi:</strong> ${escapeHTML(order.speedafTracking)}</div>`
            : '';

        const printBtn = order.speedafLabelUrl
            ? `<a href="${escapeHTML(order.speedafLabelUrl)}" target="_blank" class="admin-btn-primary" style="padding:0.4rem 0.8rem; font-size:0.75rem; text-decoration:none; margin-left:0.3rem;">🖨️ Étiquette</a>`
            : '';

        const syncBtn = order.speedafTracking && ['shipping', 'confirmed'].includes(status)
            ? `<button class="admin-btn-secondary" data-sync-id="${order.id}" style="padding:0.4rem 0.8rem; font-size:0.75rem; margin-left:0.3rem;">🔄 Sync</button>`
            : '';

        html += `
            <div class="admin-list-item" style="flex-direction:column; align-items:stretch; padding:1rem;">
                <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.5rem;">
                    <div>
                        <strong style="color:var(--gold); font-size:1rem;">#${idShort}</strong>
                        <span style="margin-left:0.5rem; font-size:0.85rem; color:var(--text-muted);">${dateStr}</span>
                        <span style="margin-left:0.5rem; font-size:0.8rem; font-weight:700;">${statusBadge}</span>
                    </div>
                    <div style="font-weight:700; color:var(--text);">${order.total || 0} MAD</div>
                </div>
                <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.5rem;">
                    👤 ${escapeHTML(order.deliveryAddress?.name || '—')} · 📞 ${escapeHTML(order.deliveryAddress?.phone || '')} · 🏙️ ${escapeHTML(cityStr)}
                </div>
                ${trackingHtml}
                <div style="display:flex; justify-content:flex-end; margin-top:0.5rem;">
                    ${syncBtn}
                    ${printBtn}
                </div>
            </div>
        `;
    });

    container.innerHTML = html;

    container.querySelectorAll('[data-sync-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.syncId;
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '⏳...';
            const res = await syncSpeedafStatus(orderId);
            if (res.success) {
                if (res.updated) {
                    showToast(`✅ Statut mis à jour : ${res.newStatus}`);
                    await loadSpeedafTab();
                } else {
                    showToast(`ℹ️ Statut Speedaf : ${res.currentStatus}`);
                }
            } else {
                showToast(`❌ Erreur: ${res.error}`);
            }
            btn.disabled = false; btn.innerHTML = originalText;
        });
    });
}

async function handleSyncAllSpeedaf() {
    if (isSyncingAllSpeedaf) return;
    const btn = document.getElementById('syncAllSpeedafBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Synchronisation...'; }
    isSyncingAllSpeedaf = true;

    const ordersToSync = speedafOrdersCache.filter(o =>
        o.speedafTracking && ['shipping', 'confirmed'].includes(normalizeOrderStatus(o.status))
    );

    if (ordersToSync.length === 0) {
        showToast('ℹ️ Aucune commande en cours à synchroniser.');
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Synchroniser les statuts'; }
        isSyncingAllSpeedaf = false;
        return;
    }

    let updatedCount = 0, errorCount = 0;
    for (const order of ordersToSync) {
        try {
            const res = await syncSpeedafStatus(order.id);
            if (res.success && res.updated) updatedCount++;
        } catch (e) { errorCount++; }
    }

    showToast(`✅ ${updatedCount} commande(s) mise(s) à jour. ${errorCount > 0 ? errorCount + ' erreur(s).' : ''}`);
    await loadSpeedafTab();

    if (btn) { btn.disabled = false; btn.textContent = '🔄 Synchroniser les statuts'; }
    isSyncingAllSpeedaf = false;
}

async function handleConfirmPickup() {
    const dateVal = document.getElementById('pickupDate').value;
    const packages = parseInt(document.getElementById('pickupPackages').value) || 1;
    const weight = parseFloat(document.getElementById('pickupWeight').value) || 1;
    const note = document.getElementById('pickupNote').value.trim();
    if (!dateVal) { showToast('⚠️ Sélectionnez une date'); return; }

    const btn = document.getElementById('confirmPickupBtn');
    btn.disabled = true; btn.textContent = '⏳ Envoi...';

    try {
        await addDoc(collection(db, "speedaf_pickups"), {
            date: Timestamp.fromDate(new Date(dateVal)),
            packages, weight, note,
            status: isTestMode() ? 'test_mode' : 'pending_manual',
            createdAt: Timestamp.now()
        });
        showToast(isTestMode() ? '🧪 [TEST] Demande enregistrée (rollback à la fin)' : '✅ Demande enregistrée (à confirmer avec Speedaf)');
        document.getElementById('pickupModal').classList.remove('open');
    } catch (e) {
        showToast('❌ Erreur : ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '🚀 Envoyer la demande';
    }
}

// ------------------------------------------------------------
// FIN PARTIE 3/4 — la suite (alertes + charts + finances + simulateur + outils + attachAllRemainingEvents + initAdmin) commence en PARTIE 4/4
// ------------------------------------------------------------
// ============================================================
// ALERTES BANNER
// ============================================================
function formatTooltipList(arr, max = 5) {
    if (!arr || arr.length === 0) return '';
    if (arr.length <= max) return arr.join(', ');
    return arr.slice(0, max).join(', ') + ` +${arr.length - max} autre(s)`;
}

function initAdminAlerts() {
    refreshAdminAlerts();
    if (alertInterval) clearInterval(alertInterval);
    alertInterval = setInterval(refreshAdminAlerts, 60000);

    document.getElementById('closeAlertBannerBtn')?.addEventListener('click', () => {
        const banner = document.getElementById('adminAlertBanner');
        if (banner) banner.style.display = 'none';
    });

    document.getElementById('alertOrdersBtn')?.addEventListener('click', () => document.querySelector('[data-tab="orders"]')?.click());
    document.getElementById('alertReviewsBtn')?.addEventListener('click', () => document.querySelector('[data-tab="reviews"]')?.click());
    document.getElementById('alertStockOutBtn')?.addEventListener('click', () => { tempStockFilter = 'out'; document.querySelector('[data-tab="products"]')?.click(); });
    document.getElementById('alertStockLowBtn')?.addEventListener('click', () => { tempStockFilter = 'low'; document.querySelector('[data-tab="products"]')?.click(); });
}

async function refreshAdminAlerts() {
    const banner = document.getElementById('adminAlertBanner');
    if (!banner || !auth.currentUser) return;

    try {
        const [ordersSnap, reviewsSnap] = await Promise.allSettled([
            getCountFromServer(query(collection(db, "orders"), where("status", "==", "pending"))),
            getCountFromServer(query(collection(db, "reviews"), where("status", "==", "pending")))
        ]);

        const pendingOrdersCount = ordersSnap.value?.data().count || 0;
        const pendingReviewsCount = reviewsSnap.value?.data().count || 0;

        const stockOutNames = [];
        const stockLowNames = [];

        if (cachedProducts.length > 0) {
            cachedProducts.forEach(p => {
                const name = p.nameFr || p.nameEn || 'Sans nom';
                if (p.variants && p.variants.length > 0) {
                    p.variants.forEach(v => {
                        const vStock = Number(v.stock) || 0;
                        const vLabel = [v.size, v.color].filter(Boolean).join('/');
                        if (vStock === 0) stockOutNames.push(`${name} [${vLabel}]`);
                        else if (vStock <= 4) stockLowNames.push(`${name} [${vLabel}]`);
                    });
                } else {
                    const stock = Number(p.stock) || 0;
                    if (stock === 0) stockOutNames.push(name);
                    else if (stock > 0 && stock <= 4) stockLowNames.push(name);
                }
            });
        }

        const btnO = document.getElementById('alertOrdersBtn');
        const btnR = document.getElementById('alertReviewsBtn');
        const btnSO = document.getElementById('alertStockOutBtn');
        const btnSL = document.getElementById('alertStockLowBtn');

        let hasAlerts = false;
        if (btnO) { if (pendingOrdersCount > 0) { document.getElementById('alertOrdersCount').textContent = pendingOrdersCount; btnO.style.display = 'inline-flex'; hasAlerts = true; } else btnO.style.display = 'none'; }
        if (btnR) { if (pendingReviewsCount > 0) { document.getElementById('alertReviewsCount').textContent = pendingReviewsCount; btnR.style.display = 'inline-flex'; hasAlerts = true; } else btnR.style.display = 'none'; }
        if (btnSO) {
            if (stockOutNames.length > 0) {
                document.getElementById('alertStockOutCount').textContent = stockOutNames.length;
                const tip = document.getElementById('alertStockOutTooltip');
                if (tip) tip.textContent = formatTooltipList(stockOutNames);
                btnSO.style.display = 'inline-flex'; hasAlerts = true;
            } else btnSO.style.display = 'none';
        }
        if (btnSL) {
            if (stockLowNames.length > 0) {
                document.getElementById('alertStockLowCount').textContent = stockLowNames.length;
                const tip = document.getElementById('alertStockLowTooltip');
                if (tip) tip.textContent = formatTooltipList(stockLowNames);
                btnSL.style.display = 'inline-flex'; hasAlerts = true;
            } else btnSL.style.display = 'none';
        }

        banner.style.display = hasAlerts ? 'block' : 'none';
    } catch (e) { console.warn('⚠️ Alertes :', e); }
}

// ============================================================
// CHART REVENUS
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

async function renderRevenueChart(period = 7, preloadedOrders = null) {
    const canvas = document.getElementById('revenueChart');
    if (!canvas || typeof window.Chart === 'undefined') return;

    try {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(now.getDate() - period + 1);
        startDate.setHours(0, 0, 0, 0);

        let orders = preloadedOrders;
        if (!orders) {
            const ordersSnap = await getDocs(collection(db, "orders"));
            orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        }

        const buckets = {};
        for (let i = 0; i < period; i++) {
            const d = new Date(startDate); d.setDate(startDate.getDate() + i);
            buckets[d.toISOString().split('T')[0]] = { revenue: 0, date: d };
        }

        orders.forEach(o => {
            const date = toDate(o.createdAt);
            if (!date) return;
            const key = date.toISOString().split('T')[0];
            if (!buckets[key]) return;
            const status = o.status === 'validated' ? 'confirmed' : (o.status === 'received' ? 'delivered' : o.status);
            if (status === 'delivered') buckets[key].revenue += Number(o.total) || 0;
        });

        const sortedKeys = Object.keys(buckets).sort();
        const labels = sortedKeys.map(k => buckets[k].date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
        const revenueData = sortedKeys.map(k => buckets[k].revenue);

        if (revenueChartInstance) revenueChartInstance.destroy();

        revenueChartInstance = new window.Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels, datasets: [{ label: '💰 CA (Livré)', data: revenueData, borderColor: '#a57b2e', backgroundColor: 'rgba(165, 123, 46, 0.12)', fill: true, tension: 0.3 }] },
            options: { responsive: true, maintainAspectRatio: false }
        });
    } catch (e) { console.error(e); }
}

// ============================================================
// COMPTABILITÉ — CHARGEMENT
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
        } catch (err2) { cachedPurchases = []; }
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
        } catch (err2) { cachedExpenses = []; }
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
        } catch (err2) { cachedTransactions = []; }
    }
    return cachedTransactions;
}

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
    if (!kpis || !waterfall) return;

    kpis.innerHTML = '<div class="admin-loading">⏳ Calcul...</div>';
    waterfall.innerHTML = '<div class="admin-loading">⏳ Calcul...</div>';

    try {
        const period = document.getElementById('accPeriod')?.value || 'month';
        const startVal = document.getElementById('accStart')?.value;
        const endVal = document.getElementById('accEnd')?.value;
        const { start, end } = getDateRangeFromPeriod(period, startVal, endVal);

        const [ordersSnap, purchasesSnap, expensesSnap, transactionsSnap] = await Promise.all([
            getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(1000))),
            getDocs(query(collection(db, "purchases"), orderBy("date", "desc"), limit(500))),
            getDocs(query(collection(db, "expenses"), orderBy("date", "desc"), limit(500))),
            getDocs(query(collection(db, "transactions"), orderBy("date", "desc"), limit(500)))
        ]);

        let revenue = 0, cogs = 0, shippingCost = 0, adSpend = 0, otherExpenses = 0, extraIncome = 0;
        let ordersCount = 0;

        ordersSnap.forEach(d => {
            const o = d.data();
            const orderDate = toDate(o.createdAt);
            if (!isInRange(orderDate, start, end)) return;
            const status = normalizeOrderStatus(o.status);
            if (status === 'delivered') {
                ordersCount++;
                revenue += Number(o.total) || 0;
                (o.items || []).forEach(item => {
                    const p = cachedProducts.find(pp => String(pp.id) === String(item.productId));
                    const buyPrice = p ? Number(p.purchasePrice) || 0 : 0;
                    const logistics = p && p.logisticsFee ? Number(p.logisticsFee) : 0;
                    cogs += (buyPrice + logistics) * (Number(item.quantity) || 1);
                });
                shippingCost += Number(o.deliveryFee) || 0;
            }
        });

        purchasesSnap.forEach(d => {
            const p = d.data();
            if (!isInRange(toDate(p.date), start, end)) return;
            cogs += Number(p.totalCost) || 0;
        });

        expensesSnap.forEach(d => {
            const e = d.data();
            if (!isInRange(toDate(e.date), start, end)) return;
            const amount = Number(e.amount) || 0;
            if (e.category === 'marketing') adSpend += amount;
            else otherExpenses += amount;
        });

        transactionsSnap.forEach(d => {
            const t_ = d.data();
            if (!isInRange(toDate(t_.date), start, end)) return;
            if (t_.type === 'income') extraIncome += Number(t_.amount) || 0;
            else otherExpenses += Number(t_.amount) || 0;
        });

        const grossProfit = revenue - cogs;
        const netProfit = grossProfit - shippingCost - adSpend - otherExpenses + extraIncome;
        const margin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

        kpis.innerHTML = `
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--success);">${formatMAD(revenue)}</span><span class="stat-label">💰 Chiffre d'affaires</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(cogs)}</span><span class="stat-label">📦 COGS</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(shippingCost)}</span><span class="stat-label">🚚 Frais livraison</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(adSpend)}</span><span class="stat-label">📢 Publicité</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(otherExpenses)}</span><span class="stat-label">📉 Autres dépenses</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--info);">${formatMAD(extraIncome)}</span><span class="stat-label">💸 Autres revenus</span></div>
            <div class="admin-stat-card" style="border-color:var(--gold);"><span class="stat-value" style="color:var(--gold);">${formatMAD(netProfit)}</span><span class="stat-label">🏆 Bénéfice NET</span></div>
            <div class="admin-stat-card"><span class="stat-value">${margin.toFixed(1)}%</span><span class="stat-label">📊 Marge nette</span></div>
        `;

        waterfall.innerHTML = `
            <table class="acc-table" style="width:100%;">
                <tr><td>💰 Chiffre d'affaires</td><td style="text-align:right;color:var(--success);font-weight:700;">${formatMAD(revenue)}</td></tr>
                <tr><td>📦 COGS</td><td style="text-align:right;color:var(--danger);">-${formatMAD(cogs)}</td></tr>
                <tr style="font-weight:700;background:rgba(0,0,0,0.02);"><td>💵 Marge Brute</td><td style="text-align:right;">${formatMAD(grossProfit)}</td></tr>
                <tr><td>🚚 Livraison</td><td style="text-align:right;color:var(--danger);">-${formatMAD(shippingCost)}</td></tr>
                <tr><td>📢 Pub</td><td style="text-align:right;color:var(--danger);">-${formatMAD(adSpend)}</td></tr>
                <tr><td>📉 Autres dép.</td><td style="text-align:right;color:var(--danger);">-${formatMAD(otherExpenses)}</td></tr>
                <tr><td>💸 Autres rev.</td><td style="text-align:right;color:var(--info);">+${formatMAD(extraIncome)}</td></tr>
                <tr style="font-weight:800;background:var(--bg-surface);border-top:2px solid var(--gold);"><td>🏆 Bénéfice NET</td><td style="text-align:right;color:var(--gold);">${formatMAD(netProfit)}</td></tr>
            </table>
        `;

        await renderRevenueChart(currentChartPeriod, ordersSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
        console.error('❌ refreshAccOverview:', e);
        kpis.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur</div>`;
        waterfall.innerHTML = '';
    }
}

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

// ============================================================
// ACHATS / DÉPENSES / TRANSACTIONS — CRUD
// ============================================================
async function saveNewPurchase() {
    const productId = document.getElementById('purProductId').value;
    const qty = parseInt(document.getElementById('purQty').value);
    const unitPrice = parseFloat(document.getElementById('purUnitPrice').value);
    const shippingCost = parseFloat(document.getElementById('purShippingCost').value) || 0;
    const supplier = document.getElementById('purSupplier').value.trim();
    const dateVal = document.getElementById('purDate').value;
    const note = document.getElementById('purNote').value.trim();

    if (!productId) { showToast('⚠️ Sélectionnez un produit'); return; }
    if (!qty || qty < 1) { showToast('⚠️ Quantité invalide'); return; }
    if (isNaN(unitPrice) || unitPrice < 0) { showToast('⚠️ Prix invalide'); return; }
    if (!dateVal) { showToast('⚠️ Date invalide'); return; }

    const btn = document.getElementById('addPurchaseBtn');
    btn.disabled = true; btn.textContent = '⏳...';

    try {
        const totalCost = (qty * unitPrice) + shippingCost;
        const product = cachedProducts.find(p => p.id === productId);

        await addDoc(collection(db, "purchases"), {
            productId, productName: product?.nameFr || 'Inconnu',
            quantity: qty, unitPrice, shippingCost, totalCost,
            supplier, date: Timestamp.fromDate(new Date(dateVal)), note,
            createdAt: Timestamp.now()
        });

        if (product) {
            await updateDoc(doc(db, "products", productId), {
                stock: increment(qty),
                purchasePrice: unitPrice,
                updatedAt: Timestamp.now()
            });
        }

        showToast('✅ Achat enregistré et stock mis à jour');
        document.getElementById('purQty').value = '';
        document.getElementById('purUnitPrice').value = '';
        document.getElementById('purShippingCost').value = '0';
        document.getElementById('purNote').value = '';

        await loadPurchases();
        await loadProducts(true);
        await renderPurchasesList();
    } catch (e) {
        showToast('❌ ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '💾 Enregistrer l\'achat';
    }
}

async function renderPurchasesList() {
    const container = document.getElementById('purchasesList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ Chargement...</div>`;
    await loadPurchases();

    if (cachedPurchases.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucun achat enregistré.</div>`;
        return;
    }

    let html = `<table class="acc-table"><thead><tr><th>Date</th><th>Produit</th><th>Qté</th><th>Prix Unit.</th><th>Livraison</th><th>Total</th><th>Fournisseur</th></tr></thead><tbody>`;
    cachedPurchases.forEach(p => {
        html += `<tr>
            <td>${p.date ? p.date.toLocaleDateString('fr-FR') : '—'}</td>
            <td><strong>${escapeHTML(p.productName)}</strong></td>
            <td>${p.quantity}</td>
            <td>${formatMAD(p.unitPrice)}</td>
            <td>${formatMAD(p.shippingCost)}</td>
            <td style="font-weight:700;color:var(--danger);">${formatMAD(p.totalCost)}</td>
            <td>${escapeHTML(p.supplier || '—')}</td>
        </tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

async function saveNewExpense() {
    const category = document.getElementById('expCategory').value;
    const amount = parseFloat(document.getElementById('expAmount').value);
    const dateVal = document.getElementById('expDate').value;
    const description = document.getElementById('expDescription').value.trim();

    if (isNaN(amount) || amount <= 0) { showToast('⚠️ Montant invalide'); return; }
    if (!dateVal) { showToast('⚠️ Date invalide'); return; }
    if (!description) { showToast('⚠️ Description requise'); return; }

    const btn = document.getElementById('addExpenseBtn');
    btn.disabled = true; btn.textContent = '⏳...';

    try {
        await addDoc(collection(db, "expenses"), {
            category, amount, description,
            date: Timestamp.fromDate(new Date(dateVal)),
            createdAt: Timestamp.now()
        });
        showToast('✅ Dépense enregistrée');
        document.getElementById('expAmount').value = '';
        document.getElementById('expDescription').value = '';
        await loadExpenses();
        await renderExpensesList();
    } catch (e) {
        showToast('❌ ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '💾 Enregistrer la dépense';
    }
}

async function renderExpensesList() {
    const container = document.getElementById('expensesList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ Chargement...</div>`;
    await loadExpenses();

    if (cachedExpenses.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucune dépense enregistrée.</div>`;
        return;
    }

    let html = `<table class="acc-table"><thead><tr><th>Date</th><th>Catégorie</th><th>Description</th><th>Montant</th></tr></thead><tbody>`;
    cachedExpenses.forEach(e => {
        html += `<tr>
            <td>${e.date ? e.date.toLocaleDateString('fr-FR') : '—'}</td>
            <td>${escapeHTML(e.category)}</td>
            <td>${escapeHTML(e.description)}</td>
            <td style="font-weight:700;color:var(--danger);">${formatMAD(e.amount)}</td>
        </tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

async function saveNewTransaction() {
    const type = document.getElementById('transType').value;
    const amount = parseFloat(document.getElementById('transAmount').value);
    const dateVal = document.getElementById('transDate').value;
    const description = document.getElementById('transDescription').value.trim();

    if (isNaN(amount) || amount <= 0) { showToast('⚠️ Montant invalide'); return; }
    if (!dateVal) { showToast('⚠️ Date invalide'); return; }
    if (!description) { showToast('⚠️ Description requise'); return; }

    const btn = document.getElementById('addTransactionBtn');
    btn.disabled = true; btn.textContent = '⏳...';

    try {
        await addDoc(collection(db, "transactions"), {
            type, amount, description,
            date: Timestamp.fromDate(new Date(dateVal)),
            createdAt: Timestamp.now()
        });
        showToast('✅ Transaction enregistrée');
        document.getElementById('transAmount').value = '';
        document.getElementById('transDescription').value = '';
        await loadTransactions();
        await renderTransactionsList();
    } catch (e) {
        showToast('❌ ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '💾 Enregistrer';
    }
}

async function renderTransactionsList() {
    const container = document.getElementById('transactionsList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">⏳ Chargement...</div>`;
    await loadTransactions();

    const search = document.getElementById('transSearch')?.value.toLowerCase() || '';
    const filterType = document.getElementById('transFilterType')?.value || 'all';

    let filtered = cachedTransactions;
    if (filterType !== 'all') filtered = filtered.filter(t => t.type === filterType);
    if (search) filtered = filtered.filter(t => (t.description || '').toLowerCase().includes(search));

    if (filtered.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucune transaction trouvée.</div>`;
        return;
    }

    let html = `<table class="acc-table"><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Montant</th></tr></thead><tbody>`;
    filtered.forEach(t => {
        const isIncome = t.type === 'income';
        html += `<tr>
            <td>${t.date ? t.date.toLocaleDateString('fr-FR') : '—'}</td>
            <td><span style="color:${isIncome ? 'var(--success)' : 'var(--danger)'};font-weight:700;">${isIncome ? '💰 Revenu' : '📉 Dépense'}</span></td>
            <td>${escapeHTML(t.description)}</td>
            <td style="font-weight:700;color:${isIncome ? 'var(--success)' : 'var(--danger)'};">${isIncome ? '+' : '-'} ${formatMAD(t.amount)}</td>
        </tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

// ============================================================
// RAPPORTS
// ============================================================
async function generateReport() {
    const startVal = document.getElementById('reportStart').value;
    const endVal = document.getElementById('reportEnd').value;
    const container = document.getElementById('reportContent');
    if (!startVal || !endVal) { showToast('⚠️ Sélectionnez une période'); return; }
    if (!container) return;

    container.innerHTML = `<div class="admin-loading">⏳ Génération du rapport...</div>`;

    try {
        const start = new Date(startVal); start.setHours(0,0,0,0);
        const end = new Date(endVal); end.setHours(23,59,59,999);

        const [ordersSnap, expensesSnap, purchasesSnap] = await Promise.all([
            getDocs(query(collection(db, "orders"), where("createdAt", ">=", Timestamp.fromDate(start)), where("createdAt", "<=", Timestamp.fromDate(end)))),
            getDocs(query(collection(db, "expenses"), where("date", ">=", Timestamp.fromDate(start)), where("date", "<=", Timestamp.fromDate(end)))),
            getDocs(query(collection(db, "purchases"), where("date", ">=", Timestamp.fromDate(start)), where("date", "<=", Timestamp.fromDate(end))))
        ]);

        let revenue = 0, ordersCount = 0;
        ordersSnap.forEach(d => {
            const o = d.data();
            if (normalizeOrderStatus(o.status) === 'delivered') { revenue += Number(o.total) || 0; ordersCount++; }
        });

        let expenses = 0;
        expensesSnap.forEach(d => expenses += Number(d.data().amount) || 0);
        let purchases = 0;
        purchasesSnap.forEach(d => purchases += Number(d.data().totalCost) || 0);

        const net = revenue - expenses - purchases;
        const margin = revenue > 0 ? (net / revenue) * 100 : 0;

        container.innerHTML = `
            <div class="admin-form" style="margin-top:1rem;">
                <h3>📈 Rapport du ${start.toLocaleDateString('fr-FR')} au ${end.toLocaleDateString('fr-FR')}</h3>
                <table class="acc-table" style="margin-top:1rem;">
                    <tr><td>📦 Commandes livrées</td><td style="text-align:right;font-weight:700;">${ordersCount}</td></tr>
                    <tr><td>💰 Chiffre d'affaires</td><td style="text-align:right;color:var(--success);font-weight:700;">${formatMAD(revenue)}</td></tr>
                    <tr><td>📉 Dépenses</td><td style="text-align:right;color:var(--danger);">-${formatMAD(expenses)}</td></tr>
                    <tr><td>📦 Achats</td><td style="text-align:right;color:var(--danger);">-${formatMAD(purchases)}</td></tr>
                    <tr style="font-weight:800;background:var(--bg-surface);border-top:2px solid var(--gold);">
                        <td>🏆 Résultat NET</td>
                        <td style="text-align:right;color:${net >= 0 ? 'var(--success)' : 'var(--danger)'};">${formatMAD(net)}</td>
                    </tr>
                    <tr><td>📊 Marge nette</td><td style="text-align:right;">${margin.toFixed(1)}%</td></tr>
                </table>
            </div>
        `;
    } catch (e) {
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">${e.message}</div>`;
    }
}

function downloadCSV(csvContent, fileName) {
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function exportReportCSV() {
    const table = document.querySelector('#reportContent table');
    if (!table) { showToast('⚠️ Générez d\'abord un rapport'); return; }
    let csv = "";
    table.querySelectorAll('tr').forEach(row => {
        const cols = Array.from(row.querySelectorAll('td, th')).map(c => `"${c.innerText.replace(/"/g, '""')}"`).join(',');
        csv += cols + "\n";
    });
    downloadCSV(csv, `rapport_${new Date().toISOString().split('T')[0]}.csv`);
    showToast('✅ Export CSV généré');
}

async function exportOrdersCSV() {
    try {
        showToast('⏳ Chargement des commandes...');
        const snap = await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc")));
        let csv = "ID,Date,Nom,Telephone,Ville,Adresse,Statut,Total\n";
        snap.forEach(d => {
            const o = d.data();
            const date = toDate(o.createdAt)?.toLocaleDateString('fr-FR') || '';
            const addr = o.deliveryAddress || {};
            csv += `"${d.id.slice(0,8).toUpperCase()}","${date}","${addr.name||''}","${addr.phone||''}","${addr.city||''}","${addr.address||''}","${o.status}","${o.total}"\n`;
        });
        downloadCSV(csv, `commandes_${new Date().toISOString().split('T')[0]}.csv`);
        showToast('✅ Export CSV généré');
    } catch (e) { showToast('❌ ' + e.message); }
}

async function exportProductsCSV() {
    try {
        showToast('⏳ Chargement...');
        const snap = await getDocs(collection(db, "products"));
        let csv = "Nom,SKU,Slug,Categorie,Prix,Base_Price,Cout_Achat,Stock,VendorId,Status\n";
        snap.forEach(d => {
            const p = d.data();
            csv += `"${p.nameFr||''}","${p.sku||''}","${p.slug||''}","${p.category||''}","${p.price||0}","${p.basePrice||p.price||0}","${p.purchasePrice||0}","${p.stock||0}","${p.vendorId||''}","${p.status||''}"\n`;
        });
        downloadCSV(csv, `inventaire_${new Date().toISOString().split('T')[0]}.csv`);
        showToast('✅ Export CSV généré');
    } catch (e) { showToast('❌ ' + e.message); }
}

// ============================================================
// SIMULATEUR
// ============================================================
function renderFinanceProductSelection() {
    const container = document.getElementById('financeProductSelector');
    if (!container) return;

    if (!cachedProducts || cachedProducts.length === 0) {
        container.innerHTML = `<p style="text-align:center;color:var(--text-muted);font-size:0.85rem;padding:1rem;">Chargement des produits...</p>`;
        return;
    }

    let html = '';
    cachedProducts.forEach(p => {
        const name = p.nameFr || p.nameEn || 'Sans nom';
        const buyPrice = Number(p.purchasePrice) || 0;
        const salePrice = Number(p.basePrice || p.price) || 0;
        const stock = Number(p.stock) || 0;

        html += `
            <label style="display:flex;align-items:center;gap:0.6rem;padding:0.5rem;border-bottom:1px solid var(--border);cursor:pointer;">
                <input type="checkbox" class="fin-product-checkbox" value="${p.id}" data-buy="${buyPrice}" data-sale="${salePrice}" data-stock="${stock}" style="width:auto;margin:0;">
                <div style="flex:1;">
                    <strong style="font-size:0.85rem;color:var(--text);">${escapeHTML(name)}</strong>
                    <div style="font-size:0.75rem;color:var(--text-muted);">Achat: ${buyPrice} MAD · Vente: ${salePrice} MAD · Stock: ${stock}</div>
                </div>
            </label>
        `;
    });
    container.innerHTML = html;
}

function attachSimulatorListeners() {
    if (simulatorListenersAttached) return;
    simulatorListenersAttached = true;

    document.getElementById('finSelectAll')?.addEventListener('click', () => {
        document.querySelectorAll('.fin-product-checkbox').forEach(cb => cb.checked = true);
    });
    document.getElementById('finSelectNone')?.addEventListener('click', () => {
        document.querySelectorAll('.fin-product-checkbox').forEach(cb => cb.checked = false);
    });
    document.getElementById('finSelectProfitable')?.addEventListener('click', () => {
        document.querySelectorAll('.fin-product-checkbox').forEach(cb => {
            const buy = parseFloat(cb.dataset.buy) || 0;
            const sale = parseFloat(cb.dataset.sale) || 0;
            cb.checked = sale > buy;
        });
    });
    document.getElementById('finSelectTop5')?.addEventListener('click', () => {
        const checkboxes = Array.from(document.querySelectorAll('.fin-product-checkbox'));
        checkboxes.forEach(cb => cb.checked = false);
        const sorted = checkboxes.sort((a, b) => {
            const marginA = (parseFloat(a.dataset.sale) || 0) - (parseFloat(a.dataset.buy) || 0);
            const marginB = (parseFloat(b.dataset.sale) || 0) - (parseFloat(b.dataset.buy) || 0);
            return marginB - marginA;
        });
        sorted.slice(0, 5).forEach(cb => cb.checked = true);
    });

    document.getElementById('finReturnRate')?.addEventListener('input', (e) => {
        const el = document.getElementById('finReturnRateValue');
        if (el) el.textContent = e.target.value + '%';
    });

    document.getElementById('calculateFinancesBtn')?.addEventListener('click', calculateFinances);
}

function calculateFinances() {
    const adSpend = parseFloat(document.getElementById('finAdSpend').value) || 0;
    const packaging = parseFloat(document.getElementById('finPackaging').value) || 0;
    const returnShipping = parseFloat(document.getElementById('finReturnShipping').value) || 0;
    const safetyMargin = parseFloat(document.getElementById('finSafetyMargin').value) || 0;
    const returnRate = parseFloat(document.getElementById('finReturnRate').value) || 0;

    const selected = [];
    document.querySelectorAll('.fin-product-checkbox:checked').forEach(cb => {
        selected.push({
            id: cb.value,
            buy: parseFloat(cb.dataset.buy) || 0,
            sale: parseFloat(cb.dataset.sale) || 0,
            stock: parseFloat(cb.dataset.stock) || 0
        });
    });

    if (selected.length === 0) { showToast('⚠️ Sélectionnez au moins un produit'); return; }

    const logisticsCost = packaging + (returnRate / 100) * (returnShipping + packaging);

    let totalRevenue = 0, totalInvestment = 0, totalLogistics = 0, totalGrossProfit = 0, totalUnits = 0;
    const results = [];

    selected.forEach(p => {
        const finalSalePrice = p.sale + 5;
        const spdDeliveryCost = 35;
        const marginNetUnit = finalSalePrice - p.buy - spdDeliveryCost - logisticsCost;
        const cpaMax = Math.max(0, marginNetUnit * (1 - safetyMargin / 100));
        const profitTotal = marginNetUnit * p.stock;
        const roi = p.buy > 0 ? (marginNetUnit / p.buy) * 100 : 0;

        totalRevenue += finalSalePrice * p.stock;
        totalInvestment += p.buy * p.stock;
        totalLogistics += (spdDeliveryCost + logisticsCost) * p.stock;
        totalGrossProfit += profitTotal;
        totalUnits += p.stock;

        results.push({ ...p, marginNetUnit, cpaMax, profitTotal, roi });
    });

    const netProfit = totalGrossProfit - adSpend;
    const globalRoi = totalInvestment > 0 ? (totalGrossProfit / totalInvestment) * 100 : 0;
    const breakEven = adSpend > 0 && totalGrossProfit > 0 && totalUnits > 0
        ? Math.ceil(adSpend / (totalGrossProfit / totalUnits))
        : 0;

    document.getElementById('financesResults').style.display = 'block';
    document.getElementById('finTotalRevenue').textContent = formatMAD(totalRevenue);
    document.getElementById('finTotalInvestment').textContent = formatMAD(totalInvestment);
    document.getElementById('finTotalLogistics').textContent = formatMAD(totalLogistics);
    document.getElementById('finTotalGrossProfit').textContent = formatMAD(totalGrossProfit);
    document.getElementById('finTotalProfit').textContent = formatMAD(netProfit);
    document.getElementById('finTotalProfit').style.color = netProfit >= 0 ? 'var(--success)' : 'var(--danger)';

    document.getElementById('finTotalROI').textContent = `${globalRoi.toFixed(1)}%`;
    document.getElementById('finTotalROI').style.color = globalRoi > 0 ? 'var(--success)' : 'var(--danger)';

    document.getElementById('finBreakEven').textContent = `${breakEven} colis`;
    document.getElementById('finTotalProducts').textContent = selected.length;
    document.getElementById('finTotalUnits').textContent = totalUnits;
    document.getElementById('finStockSaleValue').textContent = formatMAD(totalRevenue);

    let recHtml = '';
    if (netProfit < 0) {
        recHtml = `<div style="background:var(--danger-bg);border:1px solid var(--danger);padding:1rem;border-radius:var(--radius-sm);color:var(--danger);margin-bottom:1rem;"><strong>⚠️ Attention :</strong> Votre budget pub dépasse votre profit brut.</div>`;
    } else if (globalRoi < 50) {
        recHtml = `<div style="background:var(--warning-bg);border:1px solid var(--warning);padding:1rem;border-radius:var(--radius-sm);color:var(--warning);margin-bottom:1rem;"><strong>💡 Conseil :</strong> ROI de ${globalRoi.toFixed(1)}%. Objectif : 100%+</div>`;
    } else {
        recHtml = `<div style="background:var(--success-bg);border:1px solid var(--success);padding:1rem;border-radius:var(--radius-sm);color:var(--success);margin-bottom:1rem;"><strong>✅ Excellente rentabilité :</strong> ROI de ${globalRoi.toFixed(1)}%.</div>`;
    }
    document.getElementById('finRecommendations').innerHTML = recHtml;

    const tbody = document.getElementById('financesTableBody');
    let rows = '';
    results.forEach(r => {
        const p = cachedProducts.find(pp => pp.id === r.id);
        const name = p ? (p.nameFr || p.nameEn) : 'Inconnu';
        const verdict = r.marginNetUnit > 0 ? '✅ Rentable' : '❌ Non rentable';
        rows += `<tr>
            <td>${escapeHTML(name)}</td>
            <td style="text-align:center;">${r.buy} MAD</td>
            <td style="text-align:center;">${r.sale + 5} MAD</td>
            <td style="text-align:center;font-weight:700;color:${r.marginNetUnit>0?'var(--success)':'var(--danger)'};">${r.marginNetUnit.toFixed(2)} MAD</td>
            <td style="text-align:center;">${r.cpaMax.toFixed(2)} MAD</td>
            <td style="text-align:center;">${r.stock}</td>
            <td style="text-align:center;font-weight:700;">${r.profitTotal.toFixed(2)} MAD</td>
            <td style="text-align:center;">${r.roi.toFixed(1)}%</td>
            <td style="text-align:center;">${verdict}</td>
        </tr>`;
    });
    tbody.innerHTML = rows;
}

// ============================================================
// OUTILS — MIGRATIONS
// ============================================================
async function handleMigrateCities() {
    const btn = document.getElementById('migrateCitiesBtn');
    const logEl = document.getElementById('migrationLog');
    const log = (msg, isErr = false) => { if (!logEl) return; logEl.classList.add('active'); const span = document.createElement('div'); if (isErr) span.className = 'error'; span.textContent = msg; logEl.appendChild(span); logEl.scrollTop = logEl.scrollHeight; };
    if (logEl) logEl.innerHTML = '';
    btn.disabled = true;
    if (!auth.currentUser) { log('❌ Login requis', true); btn.disabled = false; return; }

    let cities;
    try {
        const res = await fetch('/villes.json');
        cities = await res.json();
        log(`✅ ${cities.length} villes chargées`);
    } catch (e) { log(`❌ ${e.message}`, true); btn.disabled = false; return; }

    const existingSnap = await getDocs(collection(db, "cities"));
    if (!existingSnap.empty) {
        const confirmed = await confirmAction(`La collection "cities" contient ${existingSnap.size} documents. Ils seront SUPPRIMÉS et remplacés par les ${cities.length} villes de villes.json. Continuer ?`, { title: '⚠️ Migration villes', confirmText: 'Remplacer', cancelText: 'Annuler', variant: 'danger' });
        if (!confirmed) { btn.disabled = false; return; }

        log(`⏳ Suppression des anciennes villes...`);
        const oldDocs = existingSnap.docs;
        for (let i = 0; i < oldDocs.length; i += 400) {
            const batch = writeBatch(db);
            oldDocs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
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
    log(`\n🎉 Migration OK — ${cities.length} villes`);
    btn.disabled = false;
    btn.textContent = '✅ Terminé';
    loadCollectionsStatus();
    loadStats();
    showToast('🎉 Villes migrées');
}

async function handleMigrateLegacyCategories() {
    const btn = document.getElementById('migrateLegacyCategoriesBtn');
    const logEl = document.getElementById('legacyMigrationLog');
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

    try {
        const snap = await getDocs(collection(db, "products"));
        let updatedCount = 0;
        let batch = writeBatch(db);
        let batchCount = 0;

        for (const docSnap of snap.docs) {
            const p = docSnap.data();
            const oldCat = p.category;
            if (!oldCat) continue;

            const newCat = normalizeCategory(oldCat);

            if (newCat !== oldCat) {
                batch.update(docSnap.ref, { category: newCat });
                updatedCount++;
                batchCount++;
                log(`🔄 ${p.nameFr || docSnap.id} : ${oldCat} ➔ ${newCat}`);

                if (batchCount === 400) {
                    await batch.commit();
                    log(`💾 Lot de 400 produits sauvegardé...`);
                    batchCount = 0;
                    batch = writeBatch(db);
                }
            }
        }

        if (batchCount > 0) await batch.commit();

        if (updatedCount === 0) {
            log(`\n✅ Aucun produit à migrer.`);
        } else {
            log(`\n🎉 Migration terminée ! ${updatedCount} produit(s) mis à jour.`);
            showToast(`✅ ${updatedCount} produits migrés`);
        }
    } catch (e) {
        log(`❌ Erreur : ${e.message}`, true);
    } finally {
        btn.disabled = false;
    }
}

async function handleMigrateSku() {
    const btn = document.getElementById('migrateSkuBtn');
    const logEl = document.getElementById('skuMigrationLog');
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
    log('⏳ Recherche des produits sans SKU...');

    try {
        const snap = await getDocs(collection(db, "products"));
        let updatedCount = 0;
        let batch = writeBatch(db);
        let batchCount = 0;

        for (const docSnap of snap.docs) {
            const p = docSnap.data();
            if (!p.sku) {
                const newSku = `SW-LEGACY-${String(docSnap.id).slice(-4)}`;
                batch.update(docSnap.ref, { sku: newSku });
                updatedCount++;
                batchCount++;
                log(`🔄 ${p.nameFr || docSnap.id} ➔ ${newSku}`);

                if (batchCount === 400) {
                    await batch.commit();
                    batchCount = 0;
                    batch = writeBatch(db);
                }
            }
        }

        if (batchCount > 0) await batch.commit();

        if (updatedCount === 0) {
            log(`\n✅ Tous les produits ont déjà un SKU.`);
        } else {
            log(`\n🎉 ${updatedCount} produit(s) mis à jour avec un SKU.`);
            showToast(`✅ ${updatedCount} SKU générés`);
            await loadProducts(true);
        }
    } catch (e) {
        log(`❌ Erreur : ${e.message}`, true);
    } finally {
        btn.disabled = false;
    }
}

async function loadCollectionsStatus() {
    const cols = ['products', 'orders', 'users', 'reviews', 'cities', 'blog', 'coupons'];
    const ids = { products: 'countProducts', orders: 'countOrders', users: 'countUsers', reviews: 'countReviews', cities: 'countCities', blog: 'countBlog', coupons: 'countCoupons' };
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
// ATTACH ALL REMAINING EVENTS
// ============================================================
function attachAllRemainingEvents() {
    attachProductFormEvents();

    // Produits
    document.getElementById('productSearchAdmin')?.addEventListener('input', () => { tempStockFilter = null; productsCurrentPage = 1; filterProductsList(); });
    document.getElementById('productCategoryFilter')?.addEventListener('change', () => { tempStockFilter = null; productsCurrentPage = 1; filterProductsList(); });

    // Clients
    document.getElementById('userSearchAdmin')?.addEventListener('input', filterUsersList);
    document.querySelectorAll('[data-signup-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-signup-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filterUsersList();
        });
    });

    // 🆕 Vendeurs (N1-c)
    document.getElementById('vendorSearchAdmin')?.addEventListener('input', filterVendorsList);
    document.querySelectorAll('[data-vendor-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-vendor-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filterVendorsList();
        });
    });

    // 🆕 Retraits (N1-c)
    document.getElementById('payoutSearchAdmin')?.addEventListener('input', filterPayoutsList);
    document.querySelectorAll('[data-payout-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-payout-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filterPayoutsList();
        });
    });

    // Blog
    document.getElementById('blogSearchAdmin')?.addEventListener('input', () => { blogCurrentPage = 1; filterBlogList(); });

    // Coupons
    document.getElementById('couponSearchAdmin')?.addEventListener('input', filterCouponsList);

    // Speedaf
    document.getElementById('speedafSearchAdmin')?.addEventListener('input', renderSpeedafList);
    document.getElementById('speedafStatusFilter')?.addEventListener('change', renderSpeedafList);
    document.getElementById('syncAllSpeedafBtn')?.addEventListener('click', handleSyncAllSpeedaf);
    document.getElementById('pickupSpeedafBtn')?.addEventListener('click', () => {
        document.getElementById('pickupDate').valueAsDate = new Date();
        document.getElementById('pickupModal').classList.add('open');
    });
    document.getElementById('closePickupModalBtn')?.addEventListener('click', () => document.getElementById('pickupModal').classList.remove('open'));
    document.getElementById('confirmPickupBtn')?.addEventListener('click', handleConfirmPickup);

    // Outils
    document.getElementById('migrateCitiesBtn')?.addEventListener('click', handleMigrateCities);
    document.getElementById('migrateLegacyCategoriesBtn')?.addEventListener('click', handleMigrateLegacyCategories);
    document.getElementById('migrateSkuBtn')?.addEventListener('click', handleMigrateSku);
    document.getElementById('refreshCollectionsBtn')?.addEventListener('click', loadCollectionsStatus);

    // Comptabilité
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

    // Valeurs par défaut des dates
    ['purDate', 'expDate', 'transDate'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.valueAsDate = new Date();
    });

    attachBlogFormEvents();
    attachCouponFormEvents();
}

// ============================================================
// DÉMARRAGE
// ============================================================
initAdmin();
console.log('✅ admin.js chargé — v10.1.0 (Marketplace + N2 contractStatus fix)');