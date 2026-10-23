// js/vendor-dashboard.js
// ============================================================
// LOGIQUE DU DASHBOARD VENDEUR - SMART SWI9A
// Version 2.0.0 — N6/N7/N8 (Retrait, Reprise signature, Produits/Commandes/Stock)
// ============================================================

import {
    doc, getDoc, collection, query, where, getDocs, limit,
    addDoc, serverTimestamp, updateDoc, deleteDoc, writeBatch
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { db, storage } from "./firebase.js";
import {
    getCurrentUser,
    logoutUser,
    getUserProfile,
    initAuthListener,
    authReadyPromise,
    resendVerificationEmail
} from "./auth.js";
import {
    CONFIG,
    ROLES,
    VENDOR_STATUS,
    CONTRACT_STATUS,
    LANGUAGES,
    DEFAULT_LANGUAGE
} from "./config.js";
import { showToast, confirmAction } from "./ui-core.js";
import { signVendorContract, computeContractTextHash } from "./vendor-contract.js";

// ============================================================
// TEXTES DU CONTRAT (identiques à vendor-signup.js)
// ⚠️ TODO étape 6 : extraire ce bloc dans un module commun
//    `js/vendor-contract-text.js` pour éviter la duplication.
// ============================================================
const CONTRACT_TEXTS = {
    fr: `CONTRAT DE PARTENARIAT VENDEUR — SMART SWI9A
Version ${CONFIG.VENDOR.CONTRACT_VERSION}

Article 1 — Objet
Le présent contrat encadre la mise en vente de produits par le Vendeur sur la plateforme Smart Swi9a (smartswi9a.top), marketplace marocaine d'appareils connectés et de produits pour la maison.

Article 2 — Inscription et vérification
Le Vendeur s'engage à fournir des informations exactes (nom de boutique, téléphone, ville, ICE ou CIN). Toute fausse déclaration entraîne la suspension immédiate du compte.

Article 3 — Commission
Smart Swi9a prélève une commission de 7 % sur le montant hors livraison de chaque vente. Cette commission peut être ajustée entre 5 % et 15 % avec l'accord écrit du Vendeur.

Article 4 — Expédition
Le Vendeur choisit le dépôt en agence (drop-off) ou la logistique Smart Swi9a (fulfillment). Les délais de dépôt sont de 72 heures (nouveaux comptes) ou 48 heures (comptes matures). Tout retard peut entraîner une suspension.

Article 5 — Paiement
Les gains sont crédités sur le portefeuille vendeur et deviennent disponibles 7 jours après livraison confirmée (15 jours pour les produits Smart Swi9a). Le retrait minimum est de 200 MAD.

Article 6 — Retours
En cas de retour, des frais de 20 MAD sont prélevés par colis retourné. Les retours répétés peuvent entraîner une révision du statut du Vendeur.

Article 7 — Résiliation
Chaque partie peut résilier ce contrat à tout moment. Les commandes en cours restent soumises aux présentes conditions.

Article 8 — Loi applicable
Le présent contrat est régi par le droit marocain. Tout litige relève des tribunaux de Casablanca.

Article 9 — Signature électronique
La signature électronique vaut acceptation pleine et entière. L'IP, le user-agent, la date serveur et un hash SHA-256 du présent document sont enregistrés à titre de preuve.

En signant, le Vendeur reconnaît avoir lu et compris l'intégralité du présent contrat.`,
    ar: `عقد شراكة البائع — سمارت سويقة
الإصدار ${CONFIG.VENDOR.CONTRACT_VERSION}

المادة 1 — الموضوع
ينظم هذا العقد عرض البائع لمنتجاته للبيع على منصة سمارت سويقة (smartswi9a.top)، وهي سوق مغربية للأجهزة المتصلة ومنتجات المنزل.

المادة 2 — التسجيل والتحقق
يلتزم البائع بتقديم معلومات صحيحة (اسم المتجر، الهاتف، المدينة، ICE أو CIN). أي تصريح كاذب يؤدي إلى تعليق الحساب فوراً.

المادة 3 — العمولة
تقتطع سمارت سويقة عمولة قدرها 7% على مبلغ كل عملية بيع دون احتساب التوصيل. يمكن تعديل هذه العمولة بين 5% و15% بموافقة كتابية من البائع.

المادة 4 — الشحن
يختار البائع الإيداع في الوكالة (drop-off) أو لوجستيك سمارت سويقة (fulfillment). مهل الإيداع هي 72 ساعة (الحسابات الجديدة) أو 48 ساعة (الحسابات الناضجة). أي تأخير قد يؤدي إلى تعليق الحساب.

المادة 5 — الدفع
تُضاف الأرباح إلى محفظة البائع وتصبح متاحة بعد 7 أيام من تأكيد التسليم (15 يوماً لمنتجات سمارت سويقة). الحد الأدنى للسحب هو 200 درهم.

المادة 6 — الإرجاع
في حالة الإرجاع، تُخصم رسوم قدرها 20 درهماً لكل طرد مُرجع. الإرجاعات المتكررة قد تؤدي إلى مراجعة وضع البائع.

المادة 7 — الإنهاء
يمكن لأي طرف إنهاء هذا العقد في أي وقت. تبقى الطلبات الجارية خاضعة لهذه الشروط.

المادة 8 — القانون المطبق
يخضع هذا العقد للقانون المغربي. يختص القضاء في الدار البيضاء بأي نزاع.

المادة 9 — التوقيع الإلكتروني
التوقيع الإلكتروني يعتبر قبولاً تاماً وصريحاً. يتم تسجيل عنوان IP، ووكيل المستخدم، وتاريخ الخادم، وبصمة SHA-256 لهذا المستند كدليل.

بالتوقيع، يقر البائع بأنه قرأ وفهم كامل هذا العقد.`,
    en: `VENDOR PARTNERSHIP AGREEMENT — SMART SWI9A
Version ${CONFIG.VENDOR.CONTRACT_VERSION}

Article 1 — Purpose
This agreement governs the listing and sale of products by the Vendor on Smart Swi9a (smartswi9a.top), a Moroccan marketplace for connected devices and home products.

Article 2 — Registration and verification
The Vendor agrees to provide accurate information (shop name, phone, city, ICE or CIN). Any false statement results in immediate account suspension.

Article 3 — Commission
Smart Swi9a charges a 7% commission on the delivery-excluded amount of each sale. This commission may be adjusted between 5% and 15% with the Vendor's written consent.

Article 4 — Shipping
The Vendor chooses agency drop-off or Smart Swi9a fulfillment. Drop-off deadlines are 72 hours (new accounts) or 48 hours (mature accounts). Any delay may result in suspension.

Article 5 — Payment
Earnings are credited to the vendor wallet and become available 7 days after confirmed delivery (15 days for Smart Swi9a products). Minimum withdrawal is 200 MAD.

Article 6 — Returns
In case of return, a 20 MAD fee is charged per returned parcel. Repeated returns may lead to a review of the Vendor's status.

Article 7 — Termination
Either party may terminate this agreement at any time. Pending orders remain subject to these terms.

Article 8 — Governing law
This agreement is governed by Moroccan law. Any dispute falls under the jurisdiction of the courts of Casablanca.

Article 9 — Electronic signature
The electronic signature constitutes full acceptance. The IP, user-agent, server date, and a SHA-256 hash of this document are recorded as evidence.

By signing, the Vendor acknowledges having read and understood this entire agreement.`
};

// ============================================================
// ÉTAT MODULE
// ============================================================
let currentVendor = null;
let currentWallet = null;
let currentUserUid = null;
let authBound = false;
let cachedWithdrawals = [];
let cachedProducts = [];
let cachedOrders = [];

// ============================================================
// HELPERS
// ============================================================
const madFormatter = new Intl.NumberFormat('fr-MA', {
    style: 'currency',
    currency: 'MAD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

function formatMAD(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return madFormatter.format(0);
    return madFormatter.format(n);
}

function escapeHTML(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeImageUrl(url) {
    if (typeof url !== 'string') return '';
    if (/^https?:\/\//i.test(url) || url.startsWith('/')) return escapeHTML(url);
    return '';
}

function getCurrentLanguage() {
    const htmlLang = (document.documentElement.lang || '').toLowerCase();
    if (LANGUAGES.includes(htmlLang)) return htmlLang;
    try {
        const stored = localStorage.getItem(CONFIG.STORAGE_KEYS.LANG);
        if (stored && LANGUAGES.includes(stored)) return stored;
    } catch (_) { /* ignore */ }
    return DEFAULT_LANGUAGE;
}

function tr(key, fallback) {
    const lang = getCurrentLanguage();
    const dict = (window.translations && window.translations[lang]) || {};
    const frDict = (window.translations && window.translations[DEFAULT_LANGUAGE]) || {};
    return dict[key] || frDict[key] || fallback || key;
}

function applyLanguageDirection() {
    const lang = getCurrentLanguage();
    if (document.documentElement.lang !== lang) document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

// ============================================================
// ÉTAT DÉRIVÉ
// ============================================================
function getVendorStatus() {
    return (currentVendor && currentVendor.vendorInfo && currentVendor.vendorInfo.status) || VENDOR_STATUS.PENDING;
}
function getContractStatus() {
    return (currentVendor && currentVendor.vendorInfo && currentVendor.vendorInfo.contractStatus) || CONTRACT_STATUS.PENDING;
}
function isVendorApproved() {
    return getVendorStatus() === VENDOR_STATUS.APPROVED
        && getContractStatus() === CONTRACT_STATUS.ACCEPTED;
}
function canRequestWithdrawal() {
    if (!isVendorApproved()) return false;
    if (!currentWallet) return false;
    const available = Number(currentWallet.availableBalance) || 0;
    return available >= CONFIG.VENDOR.MIN_WITHDRAWAL;
}

// ============================================================
// BANNIÈRES
// ============================================================
function renderBanners(banners) {
    const container = document.getElementById('vBanners');
    if (!container) return;
    if (!banners || !banners.length) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = banners.map(b => {
        const type = ['info', 'warning', 'danger', 'success'].includes(b.type) ? b.type : 'info';
        const action = b.actionId
            ? `<button type="button" class="v-btn v-btn-secondary" data-banner-action="${escapeHTML(b.actionId)}">${escapeHTML(b.actionLabel || 'OK')}</button>`
            : '';
        return `<div class="v-banner v-banner--${type}"><span>${escapeHTML(b.text)}</span>${action}</div>`;
    }).join('');
}

function attachBannerActions(handlers) {
    const container = document.getElementById('vBanners');
    if (!container) return;
    container.querySelectorAll('[data-banner-action]').forEach(btn => {
        const id = btn.getAttribute('data-banner-action');
        const handler = handlers[id];
        if (typeof handler === 'function') {
            btn.addEventListener('click', handler);
        }
    });
}

function buildBanners(profile) {
    const banners = [];
    const params = new URLSearchParams(location.search);
    const user = getCurrentUser();
    const emailVerified = (user && user.emailVerified === true);

    const vendorInfo = profile.vendorInfo || {};
    const status = vendorInfo.status || VENDOR_STATUS.PENDING;
    const contractStatus = vendorInfo.contractStatus || CONTRACT_STATUS.PENDING;

    if (params.get('welcome') === '1') {
        banners.push({ type: 'success', text: tr('vendor.banner.welcome', "🎉 Bienvenue sur votre espace vendeur ! Votre compte est en cours d'examen.") });
    }
    if (params.get('verifyEmail') === '1' && !emailVerified) {
        banners.push({
            type: 'warning',
            text: tr('vendor.banner.verifyEmail', "📧 Vérifiez votre adresse e-mail : un lien vous a été envoyé. Cliquez sur « Renvoyer » si besoin."),
            actionId: 'resendVerify',
            actionLabel: tr('vendor.banner.resend', 'Renvoyer')
        });
    }
    // N7 : reprise de signature
    if (params.get('contractFailed') === '1' && contractStatus !== CONTRACT_STATUS.ACCEPTED) {
        banners.push({
            type: 'danger',
            text: tr('vendor.banner.contractFailed', "⚠️ La signature de votre contrat a échoué. Cliquez sur « Signer maintenant » pour finaliser."),
            actionId: 'resignContract',
            actionLabel: tr('vendor.banner.resign', 'Signer maintenant')
        });
    }
    if (params.has('welcome') || params.has('verifyEmail') || params.has('contractFailed')) {
        params.delete('welcome');
        params.delete('verifyEmail');
        params.delete('contractFailed');
        const newUrl = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
        history.replaceState({}, '', newUrl);
    }

    if (status === VENDOR_STATUS.PENDING) {
        banners.push({ type: 'warning', text: tr('vendor.banner.pending', "⏳ Votre compte est en attente d'approbation par l'administration. Certaines fonctionnalités sont limitées.") });
    } else if (status === VENDOR_STATUS.REJECTED) {
        banners.push({ type: 'danger', text: tr('vendor.banner.rejected', "❌ Votre inscription a été refusée. Contactez le support pour plus d'informations.") });
    } else if (status === VENDOR_STATUS.SUSPENDED) {
        banners.push({ type: 'danger', text: tr('vendor.banner.suspended', "🚫 Votre compte est suspendu. Vous ne pouvez plus vendre. Contactez le support.") });
    }

    if (!currentWallet) {
        banners.push({ type: 'warning', text: tr('vendor.banner.walletMissing', "⚠️ Votre portefeuille vendeur n'est pas encore initialisé. Contactez le support.") });
    }

    if (!emailVerified && !params.get('verifyEmail')) {
        banners.push({
            type: 'warning',
            text: tr('vendor.banner.emailNotVerified', "📧 Votre e-mail n'est pas vérifié. Cliquez sur « Renvoyer » pour recevoir un nouveau lien."),
            actionId: 'resendVerify',
            actionLabel: tr('vendor.banner.resend', 'Renvoyer')
        });
    }

    return banners;
}

// ============================================================
// SIDEBAR / STATUT
// ============================================================
function updateSidebarUI(profile) {
    const shopNameEl = document.getElementById('vShopName');
    const statusEl = document.getElementById('vShopStatus');
    if (!shopNameEl || !statusEl) return;

    const vendorInfo = profile.vendorInfo || {};
    const shopName = vendorInfo.shopName || profile.name || tr('vendor.shop.fallbackName', 'Ma boutique');
    shopNameEl.textContent = shopName;
    shopNameEl.removeAttribute('data-i18n');

    const status = vendorInfo.status || VENDOR_STATUS.PENDING;
    const mapping = {
        [VENDOR_STATUS.APPROVED]:  { text: '✅ ' + tr('vendor.shop.status.approved',  'Approuvé'),  cls: 'approved' },
        [VENDOR_STATUS.PENDING]:   { text: '⏳ ' + tr('vendor.shop.status.pending',   'En attente'), cls: 'pending' },
        [VENDOR_STATUS.REJECTED]:  { text: '❌ ' + tr('vendor.shop.status.rejected',  'Rejeté'),     cls: 'rejected' },
        [VENDOR_STATUS.SUSPENDED]: { text: '🚫 ' + tr('vendor.shop.status.suspended', 'Suspendu'),   cls: 'suspended' }
    };
    const entry = mapping[status] || mapping[VENDOR_STATUS.PENDING];
    statusEl.textContent = entry.text;
    statusEl.className = `v-shop-status ${entry.cls}`;
    statusEl.removeAttribute('data-i18n');
}

// ============================================================
// CHARGEMENT DES DONNÉES VENDEUR
// ============================================================
async function loadVendorData(uid) {
    let profile = null;
    try {
        const vendorDoc = await getDoc(doc(db, "users", uid));
        profile = vendorDoc.exists() ? vendorDoc.data() : null;
    } catch (e) {
        console.error('❌ Lecture users/{uid} impossible :', e);
        throw e;
    }

    if (!profile) return { profile: null, wallet: null, reason: 'profile-missing' };
    if (profile.role !== ROLES.VENDOR) return { profile: null, wallet: null, reason: 'not-vendor' };

    let wallet = null;
    try {
        const walletDoc = await getDoc(doc(db, "wallets", uid));
        wallet = walletDoc.exists() ? walletDoc.data() : null;
    } catch (e) {
        console.warn('⚠️ Lecture wallets/{uid} impossible :', e);
        wallet = null;
    }

    return { profile, wallet, reason: null };
}

// ============================================================
// INJECTION DES MODALES (N6, N7, N8)
// — Injectées dynamiquement, aucune modif de dashboard.html requise
// ============================================================
function injectModals() {
    if (document.getElementById('vModalsRoot')) return;

    const root = document.createElement('div');
    root.id = 'vModalsRoot';
    root.innerHTML = `
        <!-- ====== MODALE RETRAIT (N6) ====== -->
        <div class="modal-overlay" id="vWithdrawModal" style="z-index:2500;">
            <div class="modal" style="max-width:480px;">
                <button class="modal-close" id="closeWithdrawModal">✕</button>
                <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:1rem;">
                    💸 Demander un retrait
                </h2>
                <p style="text-align:center;font-size:0.85rem;color:var(--text-muted);margin-bottom:1.2rem;">
                    Solde disponible : <strong id="vWithdrawAvailable">0 MAD</strong><br>
                    Minimum : <strong>${CONFIG.VENDOR.MIN_WITHDRAWAL} MAD</strong>
                </p>
                <div class="v-field">
                    <label class="v-label">Montant à retirer (MAD) *</label>
                    <input type="number" id="vWithdrawAmount" class="v-input"
                           min="${CONFIG.VENDOR.MIN_WITHDRAWAL}" step="1"
                           placeholder="${CONFIG.VENDOR.MIN_WITHDRAWAL}">
                </div>
                <div class="v-field">
                    <label class="v-label">Méthode de réception *</label>
                    <select id="vWithdrawMethod" class="v-input">
                        <option value="Wafacash">Wafacash</option>
                        <option value="Cash Plus">Cash Plus</option>
                        <option value="Virement bancaire">Virement bancaire</option>
                    </select>
                </div>
                <div class="v-field">
                    <label class="v-label">Téléphone / RIB de réception *</label>
                    <input type="text" id="vWithdrawPhone" class="v-input" placeholder="06XXXXXXXX ou RIB complet">
                </div>
                <div id="vWithdrawError" style="color:var(--danger);font-size:0.85rem;min-height:1.2rem;text-align:center;margin:0.5rem 0;"></div>
                <button type="button" id="vWithdrawSubmitBtn" class="v-btn v-btn-primary v-btn-block">
                    ✅ Envoyer la demande
                </button>
            </div>
        </div>

        <!-- ====== MODALE PRODUIT (N8-a) ====== -->
        <div class="modal-overlay" id="vProductModal" style="z-index:2500;">
            <div class="modal" style="max-width:600px;">
                <button class="modal-close" id="closeProductModal">✕</button>
                <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:1rem;">
                    ➕ Nouveau produit
                </h2>
                <div class="v-field">
                    <label class="v-label">Nom du produit (Français) *</label>
                    <input type="text" id="vProdNameFr" class="v-input" placeholder="Ex: Montre connectée">
                </div>
                <div class="v-field">
                    <label class="v-label">Nom du produit (Arabe)</label>
                    <input type="text" id="vProdNameAr" class="v-input" placeholder="ساعة ذكية">
                </div>
                <div class="v-field">
                    <label class="v-label">Nom du produit (Anglais)</label>
                    <input type="text" id="vProdNameEn" class="v-input" placeholder="Smartwatch">
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.8rem;">
                    <div class="v-field">
                        <label class="v-label">Prix de vente (MAD) *</label>
                        <input type="number" id="vProdPrice" class="v-input" min="1" step="0.5">
                    </div>
                    <div class="v-field">
                        <label class="v-label">Stock initial *</label>
                        <input type="number" id="vProdStock" class="v-input" min="1" value="1">
                    </div>
                </div>
                <div class="v-field">
                    <label class="v-label">Description (Français)</label>
                    <textarea id="vProdDescFr" class="v-input" rows="3" placeholder="Décrivez votre produit..."></textarea>
                </div>
                <div class="v-field">
                    <label class="v-label">Image du produit *</label>
                    <input type="file" id="vProdImageFile" accept="image/*" class="v-input">
                </div>
                <div id="vProdError" style="color:var(--danger);font-size:0.85rem;min-height:1.2rem;text-align:center;margin:0.5rem 0;"></div>
                <button type="button" id="vProdSubmitBtn" class="v-btn v-btn-primary v-btn-block">
                    ✅ Envoyer pour validation
                </button>
            </div>
        </div>

        <!-- ====== MODALE CONTRAT (N7) ====== -->
        <div class="modal-overlay" id="vContractModal" style="z-index:2500;">
            <div class="modal" style="max-width:800px;padding:0;display:flex;flex-direction:column;height:90vh;">
                <div style="padding:1.5rem;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
                    <h2 id="vContractTitle" style="font-family:var(--font-secondary);color:var(--gold);margin:0;">Contrat de Partenariat</h2>
                    <button type="button" id="closeContractModal" aria-label="Fermer" style="background:none;border:none;font-size:1.5rem;cursor:pointer;">✕</button>
                </div>
                <div id="vContractText" tabindex="0" style="flex:1;overflow-y:auto;padding:2rem;font-size:0.9rem;line-height:1.7;color:#444;background:#fafafa;"></div>
                <div style="padding:1.5rem;border-top:1px solid #eee;background:#fff;text-align:center;">
                    <p id="vContractHint" style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.75rem;">Faites défiler pour lire l'intégralité du contrat.</p>
                    <label class="v-checkbox" for="vContractCheckbox">
                        <input type="checkbox" id="vContractCheckbox">
                        <span>J'ai lu et j'accepte le contrat dans son intégralité</span>
                    </label>
                    <button type="button" id="vContractAcceptBtn" class="v-btn v-btn-primary v-btn-block" disabled style="opacity:0.5;margin-top:0.75rem;">
                        ✍️ Signer le contrat
                    </button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(root);
}

// ============================================================
// N6 — MODALE DE RETRAIT
// ============================================================
function openWithdrawModal() {
    if (!canRequestWithdrawal()) {
        const available = Number(currentWallet?.availableBalance) || 0;
        if (!isVendorApproved()) {
            showToast(tr('vendor.wallet.withdrawLockedNotApproved', "Compte non approuvé : retrait verrouillé."));
        } else if (available < CONFIG.VENDOR.MIN_WITHDRAWAL) {
            showToast(tr('vendor.wallet.withdrawLockedMin', "Solde insuffisant (minimum : {min}).").replace('{min}', CONFIG.VENDOR.MIN_WITHDRAWAL + ' MAD'));
        }
        return;
    }

    const modal = document.getElementById('vWithdrawModal');
    if (!modal) return;
    document.getElementById('vWithdrawAvailable').textContent = formatMAD(currentWallet.availableBalance);
    document.getElementById('vWithdrawAmount').value = '';
    document.getElementById('vWithdrawPhone').value = '';
    document.getElementById('vWithdrawError').textContent = '';
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';

    setTimeout(() => document.getElementById('vWithdrawAmount')?.focus(), 100);
}

function closeWithdrawModal() {
    const modal = document.getElementById('vWithdrawModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
}

async function submitWithdrawal() {
    const amountEl = document.getElementById('vWithdrawAmount');
    const methodEl = document.getElementById('vWithdrawMethod');
    const phoneEl = document.getElementById('vWithdrawPhone');
    const errEl = document.getElementById('vWithdrawError');
    const btn = document.getElementById('vWithdrawSubmitBtn');

    const amount = parseFloat(amountEl.value);
    const method = methodEl.value;
    const phone = (phoneEl.value || '').trim();
    const available = Number(currentWallet?.availableBalance) || 0;

    errEl.textContent = '';

    if (!Number.isFinite(amount) || amount < CONFIG.VENDOR.MIN_WITHDRAWAL) {
        errEl.textContent = `Minimum : ${CONFIG.VENDOR.MIN_WITHDRAWAL} MAD.`;
        return;
    }
    if (amount > available) {
        errEl.textContent = `Solde insuffisant (${formatMAD(available)} disponibles).`;
        return;
    }
    if (phone.length < 6) {
        errEl.textContent = 'Téléphone ou RIB invalide.';
        return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Envoi...';

    try {
        await addDoc(collection(db, "payout_requests"), {
            vendorId: currentUserUid,
            vendorName: currentVendor.vendorInfo?.shopName || currentVendor.name || 'Vendeur',
            amount: amount,
            method,
            phone,
            status: 'pending',
            requestedAt: serverTimestamp()
        });

        showToast('✅ Demande de retrait envoyée ! Traitement sous 3 jours ouvrés.');
        closeWithdrawModal();
        await loadWithdrawals();
        await renderWallet(document.getElementById('vTabContent'));
    } catch (e) {
        console.error('❌ Erreur retrait :', e);
        errEl.textContent = 'Erreur : ' + (e.message || 'inconnue');
        btn.disabled = false;
        btn.textContent = '✅ Envoyer la demande';
    }
}

async function loadWithdrawals() {
    try {
        const q = query(
            collection(db, "payout_requests"),
            where("vendorId", "==", currentUserUid)
        );
        const snap = await getDocs(q);
        cachedWithdrawals = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => {
                const ta = a.requestedAt?.toDate?.()?.getTime?.() || 0;
                const tb = b.requestedAt?.toDate?.()?.getTime?.() || 0;
                return tb - ta;
            });
    } catch (e) {
        console.warn('⚠️ Lecture retraits échouée :', e);
        cachedWithdrawals = [];
    }
}

// ============================================================
// N8-a — MODALE PRODUIT
// ============================================================
function openProductModal() {
    const modal = document.getElementById('vProductModal');
    if (!modal) return;
    ['vProdNameFr', 'vProdNameAr', 'vProdNameEn', 'vProdPrice', 'vProdStock', 'vProdDescFr'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = id === 'vProdStock' ? '1' : '';
    });
    document.getElementById('vProdImageFile').value = '';
    document.getElementById('vProdError').textContent = '';
    document.getElementById('vProdSubmitBtn').disabled = false;
    document.getElementById('vProdSubmitBtn').textContent = '✅ Envoyer pour validation';

    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('vProdNameFr')?.focus(), 100);
}

function closeProductModal() {
    const modal = document.getElementById('vProductModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
}

function generateSlug(str) {
    return String(str || '').toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-').replace(/-+/g, '-');
}

async function submitProduct() {
    const nameFr = (document.getElementById('vProdNameFr').value || '').trim();
    const nameAr = (document.getElementById('vProdNameAr').value || '').trim();
    const nameEn = (document.getElementById('vProdNameEn').value || '').trim();
    const price = parseFloat(document.getElementById('vProdPrice').value);
    const stock = parseInt(document.getElementById('vProdStock').value);
    const descFr = (document.getElementById('vProdDescFr').value || '').trim();
    const file = document.getElementById('vProdImageFile').files[0];
    const errEl = document.getElementById('vProdError');
    const btn = document.getElementById('vProdSubmitBtn');

    errEl.textContent = '';

    if (!nameFr || nameFr.length < 2) { errEl.textContent = 'Nom (FR) requis (min 2 caractères).'; return; }
    if (!Number.isFinite(price) || price <= 0) { errEl.textContent = 'Prix invalide.'; return; }
    if (!Number.isFinite(stock) || stock < 1) { errEl.textContent = 'Stock invalide.'; return; }
    if (!file) { errEl.textContent = 'Image requise.'; return; }
    if (file.size > 5 * 1024 * 1024) { errEl.textContent = 'Image trop lourde (max 5 MB).'; return; }

    btn.disabled = true;
    btn.textContent = '⏳ Upload...';

    try {
        // 1. Upload image vers vendors/{uid}/products/
        const ts = Date.now();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storageRef = ref(storage, `vendors/${currentUserUid}/products/${ts}_${safeName}`);
        await uploadBytes(storageRef, file);
        const imgUrl = await getDownloadURL(storageRef);

        btn.textContent = '⏳ Enregistrement...';

        // 2. Créer le doc product
        const slug = generateSlug(nameFr) + '-' + ts.toString(36).slice(-4);
        const productData = {
            nameFr,
            nameAr: nameAr || nameFr,
            nameEn: nameEn || nameFr,
            slug,
            sku: `VND-${String(ts).slice(-6)}`,
            category: 'all',
            basePrice: price,
            price: price,
            oldPrice: 0,
            purchasePrice: 0,
            stock: stock,
            ratingAvg: 0,
            ratingCount: 0,
            salesCount: 0,
            isNew: false,
            hasSizeGuide: false,
            dimensions: { weight: 0, length: 0, width: 0, height: 0 },
            variants: [],
            descFr: descFr || '',
            descAr: '',
            descEn: '',
            featuresFr: [],
            featuresAr: [],
            featuresEn: [],
            img: imgUrl,
            gallery: [],
            vendorId: currentUserUid,
            status: 'pending_admin_approval',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };

        await addDoc(collection(db, "products"), productData);

        showToast('✅ Produit envoyé pour validation admin.');
        closeProductModal();
        await loadVendorProducts();
        await renderProducts(document.getElementById('vTabContent'));
    } catch (e) {
        console.error('❌ Erreur création produit :', e);
        errEl.textContent = 'Erreur : ' + (e.message || 'inconnue');
        btn.disabled = false;
        btn.textContent = '✅ Envoyer pour validation';
    }
}

async function loadVendorProducts() {
    try {
        const q = query(collection(db, "products"), where("vendorId", "==", currentUserUid));
        const snap = await getDocs(q);
        cachedProducts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.warn('⚠️ Lecture products échouée :', e);
        cachedProducts = [];
    }
}

async function deleteVendorProduct(productId) {
    const ok = await confirmAction('Supprimer ce produit définitivement ?', {
        title: '🗑️ Supprimer', confirmText: 'Supprimer', cancelText: 'Annuler', variant: 'danger'
    });
    if (!ok) return;
    try {
        const docRef = doc(db, "products", productId);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
            const data = snap.data();
            // Supprimer l'image Storage si applicable
            if (data.img && /firebasestorage\.googleapis\.com/.test(data.img)) {
                try {
                    const m = data.img.match(/\/o\/([^?]+)/);
                    if (m && m[1]) {
                        const path = decodeURIComponent(m[1]);
                        if (path.startsWith(`vendors/${currentUserUid}/`)) {
                            await deleteObject(ref(storage, path));
                        }
                    }
                } catch (_) { /* ignore */ }
            }
        }
        await deleteDoc(docRef);
        showToast('🗑️ Produit supprimé');
        await loadVendorProducts();
        await renderProducts(document.getElementById('vTabContent'));
    } catch (e) {
        console.error(e);
        showToast('❌ ' + (e.message || 'Erreur'));
    }
}

// ============================================================
// N7 — MODALE CONTRAT (Reprise de signature)
// ============================================================
let _contractTextHash = null;
let _contractLang = DEFAULT_LANGUAGE;
let _contractScrollReached = false;

async function openContractModal() {
    const modal = document.getElementById('vContractModal');
    if (!modal) return;

    const lang = getCurrentLanguage();
    const text = CONTRACT_TEXTS[lang] || CONTRACT_TEXTS[DEFAULT_LANGUAGE];
    _contractLang = lang;

    const textEl = document.getElementById('vContractText');
    textEl.textContent = text;
    textEl.setAttribute('lang', lang);
    textEl.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    textEl.scrollTop = 0;

    try {
        _contractTextHash = await computeContractTextHash(text);
    } catch (e) {
        console.error('❌ Hash contrat impossible :', e);
        showToast('❌ Erreur hash contrat.');
        return;
    }

    _contractScrollReached = false;
    document.getElementById('vContractCheckbox').checked = false;
    document.getElementById('vContractAcceptBtn').disabled = true;
    document.getElementById('vContractAcceptBtn').style.opacity = '0.5';
    document.getElementById('vContractHint').textContent = "Faites défiler pour lire l'intégralité du contrat.";
    document.getElementById('vContractHint').style.color = 'var(--text-muted)';

    modal.classList.add('open');
    document.body.style.overflow = 'hidden';

    requestAnimationFrame(() => requestAnimationFrame(() => checkContractScroll()));
}

function checkContractScroll() {
    const textEl = document.getElementById('vContractText');
    if (!textEl) return;
    const sh = textEl.scrollHeight;
    const ch = textEl.clientHeight;
    const st = textEl.scrollTop;
    const tol = 8;
    const noScrollNeeded = sh <= ch + tol;
    const atEnd = (st + ch) >= (sh - tol);
    if (noScrollNeeded || atEnd) {
        _contractScrollReached = true;
        updateContractAcceptButton();
    }
}

function updateContractAcceptButton() {
    const btn = document.getElementById('vContractAcceptBtn');
    const cb = document.getElementById('vContractCheckbox');
    const hint = document.getElementById('vContractHint');
    if (!btn || !cb) return;

    const ready = _contractScrollReached && cb.checked;
    btn.disabled = !ready;
    btn.style.opacity = ready ? '1' : '0.5';

    if (hint) {
        if (ready) {
            hint.textContent = '✅ Vous pouvez maintenant signer.';
            hint.style.color = 'var(--success)';
        } else if (!_contractScrollReached) {
            hint.textContent = "Faites défiler pour lire l'intégralité du contrat.";
            hint.style.color = 'var(--text-muted)';
        } else {
            hint.textContent = 'Cochez la case pour accepter.';
            hint.style.color = 'var(--text-muted)';
        }
    }
}

function closeContractModal() {
    const modal = document.getElementById('vContractModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
}

async function submitContractSignature() {
    const btn = document.getElementById('vContractAcceptBtn');
    if (!btn || btn.disabled) return;

    if (!_contractTextHash) {
        showToast('❌ Hash contrat manquant.');
        return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Signature...';

    const lang = _contractLang;
    const text = CONTRACT_TEXTS[lang] || CONTRACT_TEXTS[DEFAULT_LANGUAGE];

    try {
        await signVendorContract(currentUserUid, text, {
            textHash: _contractTextHash,
            language: lang
        });
        // Synchroniser vendorInfo.contractStatus dans users/{uid}
        await updateDoc(doc(db, "users", currentUserUid), {
            "vendorInfo.contractStatus": CONTRACT_STATUS.ACCEPTED,
            "vendorInfo.contractUpdatedAt": serverTimestamp()
        });

        showToast('✅ Contrat signé avec succès !');
        closeContractModal();

        // Recharger le profil
        const loaded = await loadVendorData(currentUserUid);
        currentVendor = loaded.profile;
        currentWallet = loaded.wallet;

        // Re-render la bannière + le tab courant
        const banners = buildBanners(currentVendor);
        renderBanners(banners);
        attachBannerActions(createBannerHandlers());
        updateSidebarUI(currentVendor);
        setActiveTab('overview');
        await renderTab('overview');
    } catch (e) {
        console.error('❌ Signature contrat échouée :', e);
        showToast('❌ ' + (e.message || 'Erreur lors de la signature.'));
        btn.disabled = false;
        btn.textContent = '✍️ Signer le contrat';
    }
}

// ============================================================
// RENDU DES ONGLETS
// ============================================================
function renderEmptyState(icon, title, desc, actionHtml = '') {
    return `
        <div class="v-empty">
            <div class="v-empty-icon" aria-hidden="true">${icon}</div>
            <h3 class="v-empty-title">${escapeHTML(title)}</h3>
            <p class="v-empty-desc">${escapeHTML(desc)}</p>
            ${actionHtml}
        </div>
    `;
}

async function renderOverview(container) {
    const available = formatMAD(currentWallet && currentWallet.availableBalance);
    const pending = formatMAD(currentWallet && currentWallet.pendingBalance);
    const totalEarnings = formatMAD(currentWallet && currentWallet.totalEarnings);
    const totalWithdrawn = formatMAD(currentWallet && currentWallet.totalWithdrawn);

    container.innerHTML = `
        <div class="v-kpi-grid">
            <div class="v-kpi-card primary">
                <div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">💰</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.available', 'Solde disponible'))}</span></div>
                <p class="v-kpi-value">${available}</p>
            </div>
            <div class="v-kpi-card">
                <div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">⏳</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.pending', 'En attente'))}</span></div>
                <p class="v-kpi-value">${pending}</p>
            </div>
            <div class="v-kpi-card">
                <div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">📈</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.totalEarnings', 'Gains cumulés'))}</span></div>
                <p class="v-kpi-value">${totalEarnings}</p>
            </div>
            <div class="v-kpi-card">
                <div class="v-kpi-header"><span class="v-kpi-icon" aria-hidden="true">🏦</span><span class="v-kpi-label">${escapeHTML(tr('vendor.kpi.totalWithdrawn', 'Total retiré'))}</span></div>
                <p class="v-kpi-value">${totalWithdrawn}</p>
            </div>
        </div>
        <div class="v-card">
            <h3 class="v-card-title">👋 ${escapeHTML(tr('vendor.overview.welcomeTitle', 'Bienvenue sur votre espace'))}</h3>
            <p style="color:var(--text-muted); font-size:0.9rem;">
                ${escapeHTML(tr('vendor.overview.welcomeDesc', 'Utilisez le menu pour gérer vos produits, commandes, wallet et stock.'))}
            </p>
        </div>
    `;
}

async function renderProducts(container) {
    if (!isVendorApproved()) {
        container.innerHTML = renderEmptyState(
            '📦',
            tr('vendor.products.locked.title', 'Publication verrouillée'),
            tr('vendor.products.locked.desc', "Votre compte doit être approuvé et votre contrat signé pour publier des produits.")
        );
        return;
    }

    if (!cachedProducts.length) {
        await loadVendorProducts();
    }

    const newBtnHtml = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:1rem;">
            <button type="button" id="vNewProductBtn" class="v-btn v-btn-primary">➕ Nouveau produit</button>
        </div>
    `;

    if (!cachedProducts.length) {
        container.innerHTML = newBtnHtml + renderEmptyState(
            '📦',
            tr('vendor.products.empty.title', 'Aucun produit'),
            tr('vendor.products.empty.desc', 'Publiez votre premier produit pour commencer à vendre.')
        );
        document.getElementById('vNewProductBtn')?.addEventListener('click', openProductModal);
        return;
    }

    const cards = cachedProducts.map(p => {
        const image = safeImageUrl(p.img);
        const name = escapeHTML(p.nameFr || p.nameEn || '—');
        const price = formatMAD(p.price);
        const stock = Number(p.stock) || 0;
        const status = p.status || 'pending_admin_approval';
        const statusBadge = status === 'approved'
            ? `<span style="background:var(--success-bg);color:var(--success);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.7rem;font-weight:700;">✅ Approuvé</span>`
            : status === 'rejected'
                ? `<span style="background:var(--danger-bg);color:var(--danger);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.7rem;font-weight:700;">❌ Rejeté</span>`
                : `<span style="background:var(--warning-bg);color:var(--warning);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.7rem;font-weight:700;">⏳ En validation</span>`;

        return `
            <div class="v-card v-product-card">
                ${image ? `<img src="${image}" alt="${name}" loading="lazy" style="width:80px;height:80px;object-fit:cover;border-radius:8px;">` : `<div style="width:80px;height:80px;background:#eee;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;">📦</div>`}
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name}</div>
                    <div style="color:var(--text-muted); font-size:0.9rem;">${price} · Stock : ${stock}</div>
                    <div style="margin-top:0.3rem;">${statusBadge}</div>
                </div>
                <button type="button" class="v-btn v-btn-secondary" data-delete-product="${escapeHTML(p.id)}" style="padding:0.4rem 0.8rem;font-size:0.8rem;">🗑️</button>
            </div>
        `;
    }).join('');

    container.innerHTML = newBtnHtml + `<div class="v-product-list" style="display:flex; flex-direction:column; gap:12px;">${cards}</div>`;

    document.getElementById('vNewProductBtn')?.addEventListener('click', openProductModal);
    container.querySelectorAll('[data-delete-product]').forEach(btn => {
        btn.addEventListener('click', () => deleteVendorProduct(btn.dataset.deleteProduct));
    });
}

async function renderOrders(container) {
    container.innerHTML = `<div style="text-align:center;padding:2rem;"><div class="spinner" style="margin:0 auto;"></div></div>`;

    try {
        const q = query(
            collection(db, "orders"),
            where("vendorIds", "array-contains", currentUserUid),
            limit(100)
        );
        const snap = await getDocs(q);
        cachedOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.warn('⚠️ Lecture orders échouée (vendorIds pas encore écrit par orders.js étape 7) :', e);
        cachedOrders = [];
    }

    if (!cachedOrders.length) {
        container.innerHTML = renderEmptyState(
            '📋',
            tr('vendor.orders.empty.title', 'Aucune commande pour le moment'),
            tr('vendor.orders.empty.desc', 'Vos commandes apparaîtront ici dès que vos produits seront vendus.')
        );
        return;
    }

    const rows = cachedOrders.map(o => {
        const shortId = (o.id || '').slice(0, 8).toUpperCase();
        const status = o.status || 'pending';
        const total = formatMAD(o.total || 0);
        const date = o.createdAt?.toDate?.()?.toLocaleDateString?.() || '—';
        const myItems = (o.items || []).filter(it => it.vendorId === currentUserUid);
        const myTotal = myItems.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);

        return `
            <div class="v-card" style="display:flex;flex-direction:column;gap:0.5rem;">
                <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
                    <strong style="color:var(--gold);">#${shortId}</strong>
                    <span style="font-size:0.8rem;color:var(--text-muted);">${date}</span>
                </div>
                <div style="font-size:0.85rem;color:var(--text-muted);">
                    Statut : <strong>${escapeHTML(status)}</strong> · Total commande : ${total}
                </div>
                <div style="font-size:0.85rem;color:var(--text);">
                    Vos articles : ${myItems.length} · Votre part : <strong>${formatMAD(myTotal)}</strong>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = `<div style="display:flex;flex-direction:column;gap:0.8rem;">${rows}</div>`;
}

async function renderStock(container) {
    container.innerHTML = renderEmptyState(
        '📥',
        tr('vendor.stock.empty.title', 'Aucun stock Fulfillment'),
        tr('vendor.stock.empty.desc', 'Envoyez vos produits chez Speedaf pour que nous gérions la livraison.')
    );
}

async function renderWallet(container) {
    if (!cachedWithdrawals.length) await loadWithdrawals();

    const available = formatMAD(currentWallet && currentWallet.availableBalance);
    const pending = formatMAD(currentWallet && currentWallet.pendingBalance);
    const minWithdrawal = formatMAD(CONFIG.VENDOR.MIN_WITHDRAWAL);
    const canWithdraw = canRequestWithdrawal();
    const disabledAttr = canWithdraw ? '' : 'disabled';
    const reason = !isVendorApproved()
        ? tr('vendor.wallet.withdrawLockedNotApproved', "Compte non approuvé : retrait verrouillé.")
        : (currentWallet && Number(currentWallet.availableBalance) < CONFIG.VENDOR.MIN_WITHDRAWAL)
            ? tr('vendor.wallet.withdrawLockedMin', "Solde insuffisant (minimum : {min}).").replace('{min}', minWithdrawal)
            : '';

    const withdrawalRows = cachedWithdrawals.length
        ? cachedWithdrawals.map(w => {
            const st = w.status || 'pending';
            const statusBadge = st === 'paid'
                ? `<span style="background:var(--success-bg);color:var(--success);padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">✅ Payé</span>`
                : st === 'rejected'
                    ? `<span style="background:var(--danger-bg);color:var(--danger);padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">❌ Rejeté</span>`
                    : `<span style="background:var(--warning-bg);color:var(--warning);padding:0.15rem 0.5rem;border-radius:30px;font-size:0.7rem;font-weight:700;">⏳ En attente</span>`;
            const date = w.requestedAt?.toDate?.()?.toLocaleDateString?.() || '—';
            return `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:0.7rem 0;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:0.5rem;">
                    <div>
                        <strong>${formatMAD(w.amount)}</strong> · ${escapeHTML(w.method || '—')} · ${date}
                    </div>
                    <div>${statusBadge}</div>
                </div>
            `;
        }).join('')
        : `<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;">${tr('vendor.wallet.noWithdrawals', 'Aucune demande de retrait pour le moment.')}</p>`;

    container.innerHTML = `
        <div class="v-wallet-hero">
            <div class="v-wallet-label">${escapeHTML(tr('vendor.wallet.available', 'Solde disponible'))}</div>
            <div class="v-wallet-amount">${available}</div>
            <div style="margin-top:0.5rem; color:var(--text-muted); font-size:0.9rem;">
                ${escapeHTML(tr('vendor.wallet.pending', 'En attente'))} : ${pending}
            </div>
            <button type="button" id="btnRequestWithdrawal" class="v-btn v-btn-primary" style="margin-top:1rem;" ${disabledAttr}>
                💸 ${escapeHTML(tr('vendor.wallet.requestWithdrawal', 'Demander un retrait'))}
            </button>
            ${reason ? `<div style="margin-top:0.5rem; color:var(--text-muted); font-size:0.85rem;">${escapeHTML(reason)}</div>` : ''}
        </div>
        <div class="v-card" style="margin-top:1.5rem;">
            <h3 class="v-card-title">📜 ${escapeHTML(tr('vendor.wallet.historyTitle', 'Historique des retraits'))}</h3>
            ${withdrawalRows}
        </div>
    `;

    const btn = document.getElementById('btnRequestWithdrawal');
    if (btn && canWithdraw) {
        btn.addEventListener('click', openWithdrawModal);
    }
}

async function renderTab(tabName) {
    const container = document.getElementById('vTabContent');
    if (!container) return;
    try {
        if (tabName === 'overview') return await renderOverview(container);
        if (tabName === 'products') return await renderProducts(container);
        if (tabName === 'orders')   return await renderOrders(container);
        if (tabName === 'wallet')   return await renderWallet(container);
        if (tabName === 'stock')    return await renderStock(container);
    } catch (e) {
        console.error('❌ renderTab ' + tabName + ' :', e);
        container.innerHTML = renderEmptyState('⚠️', tr('vendor.error.tab', 'Erreur de chargement'), tr('vendor.error.tabDesc', 'Veuillez réessayer.'));
    }
}

// ============================================================
// NAVIGATION
// ============================================================
const TAB_I18N_KEYS = {
    overview: 'vendor.page.overview',
    products: 'vendor.nav.products',
    orders:   'vendor.nav.orders',
    wallet:   'vendor.nav.wallet',
    stock:    'vendor.nav.stock'
};
const TAB_FALLBACK_TITLES = {
    overview: "Vue d'ensemble",
    products: 'Mes produits',
    orders:   'Commandes',
    wallet:   'Mon Wallet',
    stock:    'Stock Fulfillment'
};

function setActiveTab(tabName) {
    const links = document.querySelectorAll('.v-nav-link[data-tab]');
    links.forEach(l => {
        const isActive = l.dataset.tab === tabName;
        l.classList.toggle('active', isActive);
        if (l.hasAttribute('role')) l.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    const titleEl = document.getElementById('vPageTitle');
    if (titleEl) {
        const key = TAB_I18N_KEYS[tabName];
        titleEl.textContent = tr(key, TAB_FALLBACK_TITLES[tabName] || tabName);
    }
}

function closeMobileSidebar() {
    const sidebar = document.getElementById('vSidebar');
    const overlay = document.getElementById('vOverlay');
    const toggle  = document.getElementById('vMobileToggle');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function setupNavigation() {
    document.querySelectorAll('.v-nav-link[data-tab]').forEach(link => {
        link.addEventListener('click', async (e) => {
            e.preventDefault();
            const tab = link.dataset.tab;
            if (!tab) return;
            setActiveTab(tab);
            await renderTab(tab);
            if (window.matchMedia('(max-width: 1024px)').matches) closeMobileSidebar();
        });
    });

    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
        try { await logoutUser(); } catch (e) { console.warn(e); }
        window.location.href = '/';
    });

    const sidebar = document.getElementById('vSidebar');
    const overlay = document.getElementById('vOverlay');
    const toggle  = document.getElementById('vMobileToggle');

    if (toggle && sidebar && overlay) {
        toggle.addEventListener('click', () => {
            const open = !sidebar.classList.contains('open');
            if (open) {
                sidebar.classList.add('open');
                overlay.classList.add('open');
                toggle.setAttribute('aria-expanded', 'true');
            } else {
                closeMobileSidebar();
            }
        });
        overlay.addEventListener('click', () => closeMobileSidebar());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeMobileSidebar();
        });
    }
}

// ============================================================
// BANNIÈRES — Handlers
// ============================================================
function createBannerHandlers() {
    return {
        resendVerify: async () => {
            const ok = await resendVerificationEmail();
            if (ok) showToast(tr('vendor.banner.emailResent', '📧 Email renvoyé'));
        },
        resignContract: async () => {
            await openContractModal();
        }
    };
}

// ============================================================
// ATTACHE LES LISTENERS DES MODALES INJECTÉES
// ============================================================
function attachModalListeners() {
    // Retrait (N6)
    document.getElementById('closeWithdrawModal')?.addEventListener('click', closeWithdrawModal);
    document.getElementById('vWithdrawModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'vWithdrawModal') closeWithdrawModal();
    });
    document.getElementById('vWithdrawSubmitBtn')?.addEventListener('click', submitWithdrawal);

    // Produit (N8-a)
    document.getElementById('closeProductModal')?.addEventListener('click', closeProductModal);
    document.getElementById('vProductModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'vProductModal') closeProductModal();
    });
    document.getElementById('vProdSubmitBtn')?.addEventListener('click', submitProduct);

    // Contrat (N7)
    document.getElementById('closeContractModal')?.addEventListener('click', closeContractModal);
    document.getElementById('vContractModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'vContractModal') closeContractModal();
    });
    document.getElementById('vContractText')?.addEventListener('scroll', checkContractScroll, { passive: true });
    document.getElementById('vContractCheckbox')?.addEventListener('change', updateContractAcceptButton);
    document.getElementById('vContractAcceptBtn')?.addEventListener('click', submitContractSignature);
    window.addEventListener('resize', () => {
        const modal = document.getElementById('vContractModal');
        if (modal && modal.classList.contains('open')) checkContractScroll();
    });
}

// ============================================================
// INITIALISATION
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    applyLanguageDirection();

    if (!authBound) {
        try { initAuthListener(); } catch (e) { console.warn('initAuthListener déjà appelé', e); }
        authBound = true;
    }

    try { await authReadyPromise; } catch (e) { console.warn('authReadyPromise', e); }

    const user = getCurrentUser();
    if (!user || !user.uid) {
        console.log('⛔ Non connecté — redirection');
        window.location.href = '/';
        return;
    }

    currentUserUid = user.uid;

    let loaded;
    try {
        loaded = await loadVendorData(user.uid);
    } catch (e) {
        console.error('❌ Chargement vendeur échoué :', e);
        showToast(tr('vendor.error.loading', "Erreur de chargement des données."));
        return;
    }

    if (!loaded || !loaded.profile) {
        console.warn('⛔ Profil vendeur introuvable');
        window.location.href = '/';
        return;
    }

    currentVendor = loaded.profile;
    currentWallet = loaded.wallet;

    // Injecter les modales (avant d'attacher les listeners)
    injectModals();
    attachModalListeners();

    // Sidebar + navigation
    updateSidebarUI(currentVendor);
    setupNavigation();

    // Bannières + actions
    const banners = buildBanners(currentVendor);
    renderBanners(banners);
    attachBannerActions(createBannerHandlers());

    // Onglet par défaut
    setActiveTab('overview');
    await renderTab('overview');
});