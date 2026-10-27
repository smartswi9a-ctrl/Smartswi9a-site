/* ============================================================
   PARTIE 2/2 - Handlers auth, dashboard, favoris, avis,
                 settings, thème, cookie consent, panier abandonné
   ============================================================ */

/* ============================================================
   HANDLER LOGIN
   ============================================================ */
async function handleLogin() {
    const email = document.getElementById('authEmailLogin').value.trim();
    const password = document.getElementById('authPasswordLogin').value.trim();
    if (!email || !password) { showToast(t('fillAllFields')); return; }

    const loginBtn = document.getElementById('loginBtn');
    loginBtn.disabled = true;
    loginBtn.textContent = t('loading');

    const result = await loginUser(email, password);

    if (!result.success && result.reason === 'email_not_verified') {
        pendingVerificationEmail = result.email || email;
        showToast(t('verifyEmailResent'));
        renderAccountContent();
        return;
    }

    if (result.success) {
        showToast(t('loginSuccess'));
        _reviewReminderShownThisSession = false;
        await renderAccountContent();
        return;
    }

    loginBtn.disabled = false;
    loginBtn.textContent = t('login');
    if (result.message) showToast(result.message);
}

/* ============================================================
   INSCRIPTION CLIENT (min 6 chars conservé - aligné sur HTML)
   ============================================================ */
async function handleRegister() {
    const lastName = document.getElementById('regLastName').value.trim();
    const firstName = document.getElementById('regFirstName').value.trim();
    const dob = document.getElementById('regDob').value;
    const email = document.getElementById('regEmail').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirm = document.getElementById('regConfirmPassword').value;

    if (!lastName || !firstName || !email || !phone || !password) {
        showToast(t('fillAllFields'));
        return;
    }
    if (!isValidEmail(email)) { showToast('Email invalide'); return; }
    if (password.length < 6) { showToast(t('passwordTooShort')); return; }
    if (password !== confirm) { showToast(t('passwordMismatch')); return; }

    const fullName = `${firstName} ${lastName}`;
    const registerBtn = document.getElementById('registerBtn');
    registerBtn.disabled = true;
    registerBtn.textContent = t('loading');

    const result = await registerWithFirebase(fullName, email, phone, dob, password);

    if (result.success) {
        showToast(t('verifyEmailSent'));
        await renderAccountContent();
        return;
    }

    registerBtn.disabled = false;
    registerBtn.textContent = t('register');
}

/* ============================================================
   MOT DE PASSE OUBLIÉ
   ============================================================ */
async function handleForgot() {
    const email = document.getElementById('forgotEmail').value.trim();
    if (!email) { showToast(t('fillAllFields')); return; }
    if (!isValidEmail(email)) { showToast('Email invalide'); return; }

    const success = await requestPasswordReset(email);
    if (success) {
        showToast(t('resetPassword'));
        switchAuthView('login');
    }
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function renderDashboard(user, pendingReviews = 0) {
    const isVendor = user.role === ROLES.VENDOR;

    const ordersBadge = pendingReviews > 0
        ? `<span class="orders-tab-badge" style="background:var(--gold);color:#fff;font-size:0.65rem;padding:0.1rem 0.45rem;border-radius:30px;margin-left:0.3rem;font-weight:700;">${pendingReviews}</span>`
        : '';

    const reminderBanner = pendingReviews > 0 && !isVendor
        ? `
            <div class="review-reminder-banner" style="background:linear-gradient(135deg,rgba(165,123,46,0.12),rgba(165,123,46,0.04));border:1px solid var(--border-gold);border-radius:var(--radius-md);padding:0.9rem 1rem;margin-bottom:1rem;display:flex;align-items:center;gap:0.7rem;flex-wrap:wrap;">
                <span style="font-size:1.8rem;">⭐</span>
                <div style="flex:1;min-width:0;font-size:0.88rem;line-height:1.4;">
                    <strong style="color:var(--gold);">Vous avez ${pendingReviews} avis à donner !</strong><br>
                    <span style="color:var(--text-muted);font-size:0.8rem;">Partagez votre expérience sur vos produits livrés.</span>
                </div>
                <button id="goToReviewsBtn" style="background:linear-gradient(135deg,var(--gold),#7d5a1d);color:#fff;border:none;border-radius:30px;padding:0.5rem 1rem;font-weight:700;cursor:pointer;font-size:0.8rem;white-space:nowrap;">
                    ${t('leaveReview') || 'Laisser un avis'}
                </button>
            </div>
        `
        : '';

    /* Lien vendeur : /vendor/dashboard.html (dossier renommé Session 5). */
    const vendorBanner = isVendor
        ? `
            <div style="background:linear-gradient(135deg,#6b46c1,#5a3aa3);border-radius:var(--radius-md);padding:1.2rem;margin-bottom:1.2rem;color:#fff;text-align:center;">
                <div style="font-size:2rem;margin-bottom:0.5rem;">🏪</div>
                <h3 style="margin:0 0 0.5rem 0;font-size:1.1rem;">Espace Vendeur</h3>
                <p style="font-size:0.85rem;opacity:0.9;margin-bottom:1rem;">Gérez vos produits, commandes et wallet.</p>
                <a href="/vendor/dashboard.html" style="display:inline-flex;align-items:center;gap:0.4rem;background:#fff;color:#6b46c1;padding:0.7rem 1.5rem;border-radius:30px;font-weight:800;text-decoration:none;font-size:0.9rem;">
                    Accéder à mon espace →
                </a>
            </div>
        `
        : '';

    return `
        <div style="text-align:center;padding:0.5rem 0 1rem;">
            <div style="font-size:1.1rem;font-weight:700;color:var(--gold);">
                ${t('emailHello')}, ${escapeHTML(user.name || user.firstName || user.email)}
            </div>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem;">
                ${escapeHTML(user.email)}
            </div>
        </div>

        ${vendorBanner}
        ${reminderBanner}

        <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:0.5rem;">
            <button class="tab-btn active" data-tab="dashboard">${t('dashboard')}</button>
            <button class="tab-btn" data-tab="orders">${t('orders')}${ordersBadge}</button>
            <button class="tab-btn" data-tab="favorites">${t('favorites')}</button>
            <button class="tab-btn" data-tab="myreviews">${t('myReviews')}</button>
            <button class="tab-btn" data-tab="settings">${t('profile')}</button>
            <button class="logout-btn" id="logoutBtn" style="margin-left:auto;">${t('logout')}</button>
        </div>

        <div id="tabContent" style="min-height:200px;"></div>
    `;
}

function attachDashboardEvents(user) {
    const goToReviewsBtn = document.getElementById('goToReviewsBtn');
    if (goToReviewsBtn) {
        goToReviewsBtn.addEventListener('click', async () => {
            const ordersTabBtn = document.querySelector('#accountContent [data-tab="orders"]');
            if (ordersTabBtn) {
                document.querySelectorAll('#accountContent .tab-btn').forEach(b => b.classList.remove('active'));
                ordersTabBtn.classList.add('active');
                await loadDashboardTab('orders', user);
                const filterBtn = await waitForElement('[data-order-filter="delivered"]', 3000);
                if (filterBtn) filterBtn.click();
            }
        });
    }

    document.querySelectorAll('#accountContent .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#accountContent .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadDashboardTab(btn.dataset.tab, user);
        });
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await logoutUser();
            showToast(t('logout'));
            closeAccountModal();
            updateAccountButton();
        });
    }
}

async function loadDashboardTab(tab, user) {
    const container = document.getElementById('tabContent');
    if (!container) return;

    if (tab === 'dashboard') {
        container.innerHTML = `
            <div style="text-align:center;padding:1rem;">
                <div style="font-size:1.2rem;font-weight:700;color:var(--gold);">${escapeHTML(user.name || user.email)}</div>
                <div style="margin-top:0.5rem;font-size:0.85rem;color:var(--text-muted);">
                    ${escapeHTML(user.email || '')}<br>
                    ${user.phone ? escapeHTML(user.phone) : ''}
                </div>
            </div>
        `;
    } else if (tab === 'orders') {
        await renderUserOrders('tabContent');
    } else if (tab === 'favorites') {
        renderFavorites(container, user);
    } else if (tab === 'myreviews') {
        renderMyReviews(container, user);
    } else if (tab === 'settings') {
        renderSettingsForm(container, user);
    }
}

/* ============================================================
   FAVORIS
   ============================================================ */
function renderFavorites(container, user) {
    const favs = Array.isArray(user.favorites)
        ? user.favorites.map(normalizeProductId).filter(f => f != null)
        : [];
    const products = getProducts().filter(p => favs.includes(normalizeProductId(p.id)));

    if (products.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted);">${t('noFavorites')}</div>`;
        return;
    }

    let html = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:0.8rem;">`;
    products.forEach(p => {
        const pid = normalizeProductId(p.id);
        if (pid == null) return;
        html += `
            <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.5rem;text-align:center;cursor:pointer;" data-product-slug="${escapeHTML(p.slug || '')}">
                <img src="${escapeHTML(getProductImageUrl(p))}" style="width:100%;aspect-ratio:1;object-fit:contain;border-radius:8px;" loading="lazy">
                <div style="font-size:0.8rem;font-weight:600;margin-top:0.3rem;">${escapeHTML(getProductName(p))}</div>
                <div style="font-size:0.85rem;color:var(--gold);">${Number(p.price) || 0} ${t('currency')}</div>
            </div>
        `;
    });
    html += `</div>`;
    container.innerHTML = html;

    container.querySelectorAll('[data-product-slug]').forEach(card => {
        card.addEventListener('click', () => {
            const slug = card.dataset.productSlug;
            if (slug) {
                closeAccountModal();
                setTimeout(() => openProductPage(slug), 200);
            }
        });
    });
}

/* ============================================================
   MES AVIS
   ============================================================ */
async function renderMyReviews(container, user) {
    container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">${t('loadingReviews')}</div>`;
    try {
        const { collection, query, where, getDocs } = await import("firebase/firestore");
        const { db } = await import("./firebase.js");
        const q = query(collection(db, "reviews"), where("userId", "==", user.uid));
        const snap = await getDocs(q);
        const reviews = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: toDate(d.data().createdAt) }))
            .sort((a, b) => (b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0));

        if (reviews.length === 0) {
            container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted);">${t('noReviews')}</div>`;
            return;
        }

        let html = '';
        reviews.forEach(r => {
            const statusEmoji = r.status === 'approved' ? '🟢' : (r.status === 'rejected' ? '🔴' : '🟡');
            const statusLabel = r.status === 'approved' ? t('reviewPublished') : (r.status === 'rejected' ? t('reviewStatusRejected') : t('reviewPendingApproval'));
            /* Guard : IDs normalisés + fallback échappé. */
            const targetPid = normalizeProductId(r.productId);
            const product = getProducts().find(p => normalizeProductId(p.id) === targetPid);
            const productName = product
                ? escapeHTML(getProductName(product))
                : `#${escapeHTML(String(r.productId ?? ''))}`;
            /* Guard : photos array + URLs échappées. */
            const photosHtml = (Array.isArray(r.photos) && r.photos.length > 0)
                ? `<div class="review-photos">${r.photos.filter(u => typeof u === 'string').map(url => `<img src="${escapeHTML(url)}" alt="Photo" data-photo-url="${escapeHTML(url)}" style="cursor:zoom-in;">`).join('')}</div>`
                : '';
            /* Guard : title null-safe. */
            const titleHtml = r.title ? `<div style="font-weight:600;font-size:0.9rem;margin-top:0.3rem;">${escapeHTML(r.title)}</div>` : '';
            html += `
                <div class="review-item" style="margin-bottom:0.8rem;">
                    <div style="font-size:0.78rem;color:var(--gold);font-weight:600;margin-bottom:0.3rem;">${productName}</div>
                    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.3rem;">
                        <div style="color:var(--gold);">${'★'.repeat(r.rating || 0)}${'☆'.repeat(5 - (r.rating || 0))}</div>
                        <div style="font-size:0.75rem;">${statusEmoji} ${statusLabel}</div>
                    </div>
                    ${titleHtml}
                    <div style="font-size:0.85rem;color:var(--text-muted);margin:0.3rem 0;">${escapeHTML(r.comment || '')}</div>
                    ${photosHtml}
                    <div style="font-size:0.7rem;color:var(--text-dim);">${formatDateTime(r.createdAt)}</div>
                </div>
            `;
        });
        container.innerHTML = html;

        container.querySelectorAll('img[data-photo-url]').forEach(img => {
            img.addEventListener('click', () => openImageLightbox(img.dataset.photoUrl));
        });
    } catch (e) {
        console.error('Erreur mes avis :', e);
        container.innerHTML = `<div style="text-align:center;color:var(--danger);">${t('loadingError')}</div>`;
    }
}

/* ============================================================
   PARAMÈTRES DU COMPTE
   ============================================================ */
function renderSettingsForm(container, user) {
    /* Un user "password" = otp (email+mdp natif), vendor (email+mdp), ou
       email/password (futurs). Google/Facebook n'ont pas de mdp local. */
    const isPasswordUser = !user.signupMethod
        || user.signupMethod === 'otp'
        || user.signupMethod === 'vendor'
        || user.signupMethod === 'password'
        || user.signupMethod === 'email';

    container.innerHTML = `
        <div class="edit-profile-form">
            <h3 style="margin-bottom:1rem;color:var(--gold);font-family:var(--font-secondary);">${t('editProfile')}</h3>
            <div id="editProfileMsg" style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem;"></div>

            <label style="font-size:0.85rem;color:var(--text-muted);">${t('accountNamePlaceholder')}</label>
            <input type="text" id="editName" value="${escapeHTML(user.name || '')}">

            <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">${t('accountPhonePlaceholder')}</label>
            <input type="tel" id="editPhone" value="${escapeHTML(user.phone || '')}">

            ${isPasswordUser ? `
                <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">${t('newPassword')} (${t('leaveEmpty')})</label>
                <input type="password" id="editNewPassword">

                <label style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;">${t('confirmPassword')}</label>
                <input type="password" id="editConfirmPassword">
            ` : `
                <div style="background:var(--info-bg);border:1px solid var(--info);border-radius:var(--radius-sm);padding:0.7rem;margin-top:0.8rem;font-size:0.85rem;">
                    Connecté via <strong>${escapeHTML(getSignupMethodLabel(user.signupMethod))}</strong> - changement de mot de passe non disponible
                </div>
            `}

            <div style="display:flex;gap:0.5rem;margin-top:1rem;">
                <button class="btn-save-profile" id="saveProfileBtn">${t('save')}</button>
                <button class="btn-cancel-edit" id="cancelEditBtn">${t('cancel')}</button>
            </div>
        </div>
    `;

    const saveBtn = document.getElementById('saveProfileBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const name = document.getElementById('editName')?.value.trim() || '';
            const phone = document.getElementById('editPhone')?.value.trim() || '';
            const newPassword = document.getElementById('editNewPassword')?.value || '';
            const confirmPassword = document.getElementById('editConfirmPassword')?.value || '';
            const msgEl = document.getElementById('editProfileMsg');

            if (newPassword && newPassword !== confirmPassword) {
                if (msgEl) { msgEl.textContent = t('passwordMismatch'); msgEl.style.color = 'var(--danger)'; }
                return;
            }
            if (newPassword && newPassword.length < 6) {
                if (msgEl) { msgEl.textContent = t('passwordTooShort'); msgEl.style.color = 'var(--danger)'; }
                return;
            }

            try {
                const updates = {};
                if (name && name !== user.name) updates.name = name;
                if (phone !== user.phone) updates.phone = phone;

                if (Object.keys(updates).length > 0) {
                    await saveUserProfile(user.uid, updates);
                    setCurrentUser({ ...user, ...updates });
                }
                if (newPassword) {
                    await updateUserPassword(newPassword);
                }
                showToast(t('profileUpdated'));
                if (msgEl) { msgEl.textContent = t('profileUpdated'); msgEl.style.color = 'var(--success)'; }
                await renderAccountContent();
            } catch (e) {
                console.error(e);
                showToast(e.message || t('error'));
            }
        });
    }

    const cancelBtn = document.getElementById('cancelEditBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            renderAccountContent();
        });
    }
}

/* ============================================================
   THÈME (mode clair unique - toggle désactivé)
   ============================================================ */

/**
 * No-op : le site ne supporte que le mode clair.
 * @deprecated Conservé pour compatibilité.
 * @returns {void}
 */
export function toggleTheme() {
    console.log('Mode clair unique - toggle désactivé');
}

/**
 * Force le mode clair (retire la classe light-mode si présente).
 * @returns {void}
 */
export function loadTheme() {
    document.body.classList.remove('light-mode');
}

/* ============================================================
   COOKIE CONSENT
   ============================================================ */

/**
 * Affiche le bandeau cookie si l'utilisateur n'a pas encore choisi.
 * Guard _cookieConsentInitialized pour éviter les doublons.
 * @returns {void}
 */
export function initCookieConsent() {
    if (_cookieConsentInitialized) return;
    _cookieConsentInitialized = true;

    const key = CONFIG.STORAGE_KEYS.COOKIE_CONSENT;
    if (safeGetItem(key) === 'accepted' || safeGetItem(key) === 'declined') return;

    const banner = document.createElement('div');
    banner.id = 'cookieConsent';
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:var(--bg-card);border-top:1px solid var(--border-gold);padding:1rem 1.5rem;z-index:99999;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;backdrop-filter:blur(12px);box-shadow:var(--shadow-lg);';
    banner.innerHTML = `
        <div style="flex:1;min-width:200px;">
            <p style="margin:0;font-size:0.85rem;color:var(--text-muted);">
                ${t('privacyText')}
                <a href="/#legal" style="color:var(--gold);">${t('privacySummary')}</a>
            </p>
        </div>
        <div style="display:flex;gap:0.5rem;">
            <button id="cookieAcceptBtn" style="padding:0.5rem 1.2rem;background:var(--gold);color:#fff;border:none;border-radius:30px;font-weight:700;cursor:pointer;">${t('confirm')}</button>
            <button id="cookieDeclineBtn" style="padding:0.5rem 1.2rem;background:transparent;border:1px solid var(--border);color:var(--text-muted);border-radius:30px;cursor:pointer;">${t('cancel')}</button>
        </div>
    `;
    document.body.appendChild(banner);

    document.getElementById('cookieAcceptBtn').addEventListener('click', () => {
        safeSetItem(key, 'accepted');
        banner.remove();
    });
    document.getElementById('cookieDeclineBtn').addEventListener('click', () => {
        safeSetItem(key, 'declined');
        banner.remove();
    });
}

/* ============================================================
   NOTIFICATION PANIER ABANDONNÉ
   ============================================================ */

/**
 * Affiche une notification si un panier abandonné est détecté
 * (panier non finalisé depuis > 30 min).
 * Cleanup propre : retire toute notification précédente avant.
 * @returns {void}
 */
export function showAbandonedCartNotification() {
    /* Cleanup des notifications précédentes. */
    if (_abandonedCartNotifEl) {
        try { _abandonedCartNotifEl.remove(); } catch (e) { /* ignore */ }
        _abandonedCartNotifEl = null;
    }
    document.querySelectorAll('.abandoned-cart-notification').forEach(el => el.remove());

    const abandoned = checkAbandonedCart();
    if (!abandoned || !abandoned.items || abandoned.items.length === 0) return;

    const count = abandoned.items.reduce((s, i) => s + (i.quantity || 0), 0);

    const notif = document.createElement('div');
    notif.className = 'abandoned-cart-notification show';
    notif.innerHTML = `
        <div class="abandoned-cart-content">
            <div class="abandoned-cart-icon">🛒</div>
            <div class="abandoned-cart-text">
                <strong>${t('abandonedCartTitle')}</strong>
                <span>${t('abandonedCartMessage').replace('{count}', count)}</span>
            </div>
            <div class="abandoned-cart-actions">
                <button class="btn-abandoned-cart">${t('abandonedCartView')}</button>
                <button class="btn-abandoned-dismiss">✕</button>
            </div>
        </div>
    `;
    document.body.appendChild(notif);
    _abandonedCartNotifEl = notif;

    notif.querySelector('.btn-abandoned-cart').addEventListener('click', () => {
        openCart();
        notif.remove();
        _abandonedCartNotifEl = null;
    });
    notif.querySelector('.btn-abandoned-dismiss').addEventListener('click', () => {
        notif.remove();
        _abandonedCartNotifEl = null;
        /* On retire la trace pour ne pas re-proposer en boucle. */
        try {
            localStorage.removeItem(CONFIG.STORAGE_KEYS.ABANDONED_CART);
        } catch (e) { /* ignore */ }
    });
}

/* ============================================================
   LOG
   ============================================================ */
console.log('✅ ui.js chargé - v9.0.0 (Lot 21 : P2-22 polling conditionnel + imports nettoyés)');