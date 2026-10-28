/* ============================================================
   PARTIE 2/3 — Blog + Coupons + Livo + Alertes + Chart + Finances
   Version 12.2.0
   ============================================================ */

/* ============================================================
   BLOG
   ============================================================ */
async function loadBlogPosts() {
    const container = document.getElementById('adminBlogList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement des articles...</div>`;

    const BLOG_LIMIT = 100;
    try {
        const q = query(collection(db, "blog"), limit(BLOG_LIMIT));
        const snap = await getDocs(q);
        cachedBlogPosts = snap.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                createdAt: toDate(data.createdAt),
                updatedAt: toDate(data.updatedAt),
                publishedAt: toDate(data.publishedAt)
            };
        });
        cachedBlogPosts.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));

        if (snap.size === BLOG_LIMIT) {
            console.warn(
                '[admin] Limite de ' + BLOG_LIMIT + ' articles atteinte. ' +
                'Certains articles peuvent ne pas être affichés.'
            );
        }

        blogCurrentPage = 1;
        renderBlogListAdmin(cachedBlogPosts);
    } catch (e) {
        console.error('[admin] loadBlogPosts :', e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur</div>`;
    }
}

function renderBlogListAdmin(posts) {
    const container = document.getElementById('adminBlogList');
    if (!container) return;

    if (posts.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucun article.</div>`;
        return;
    }

    const totalPages = Math.max(1, Math.ceil(posts.length / BLOG_PER_PAGE));
    if (blogCurrentPage > totalPages) blogCurrentPage = totalPages;
    if (blogCurrentPage < 1) blogCurrentPage = 1;
    const start = (blogCurrentPage - 1) * BLOG_PER_PAGE;
    const pagePosts = posts.slice(start, start + BLOG_PER_PAGE);

    let html = '';
    pagePosts.forEach(post => {
        const title = escapeHTML(post.title || 'Sans titre');
        const categoryLabel = escapeHTML(tBlogCategory(post.category || 'general'));
        const status = post.status || 'draft';
        const statusLabel = status === 'published' ? 'Publié' : 'Brouillon';
        const statusClass = status === 'published' ? 'published' : 'draft';
        const date = post.publishedAt
            ? post.publishedAt.toLocaleDateString('fr-FR')
            : (post.createdAt ? post.createdAt.toLocaleDateString('fr-FR') : '—');

        const thumb = post.image
            ? `<img src="${escapeHTML(post.image)}" class="admin-blog-thumb" alt="Cover">`
            : `<div class="admin-blog-thumb" style="display:flex;align-items:center;justify-content:center;font-size:1.5rem;background:var(--bg-surface);">-</div>`;

        html += `<div class="admin-blog-item" data-post-id="${post.id}">${thumb}<div class="admin-blog-info"><h4>${title}</h4><div class="meta">${categoryLabel} · ${date} · <span class="status ${statusClass}">${statusLabel}</span></div><div style="display:flex;gap:0.4rem;flex-wrap:wrap;"><button class="admin-btn-icon" data-action="edit-post" data-id="${post.id}">Modifier</button><button class="admin-btn-icon admin-btn-danger" data-action="delete-post" data-id="${post.id}">Del</button></div></div></div>`;
    });

    if (totalPages > 1) {
        html += `<div style="display:flex;justify-content:center;gap:0.3rem;margin-top:1rem;flex-wrap:wrap;">`;
        html += `<button class="admin-btn-icon" data-blog-page="prev" ${blogCurrentPage === 1 ? 'disabled' : ''}>‹</button>`;
        for (let i = 1; i <= totalPages; i++) {
            html += `<button class="admin-btn-icon ${i === blogCurrentPage ? 'active' : ''}" data-blog-page="${i}" style="${i === blogCurrentPage ? 'background:var(--gold);color:#fff;' : ''}">${i}</button>`;
        }
        html += `<button class="admin-btn-icon" data-blog-page="next" ${blogCurrentPage === totalPages ? 'disabled' : ''}>›</button></div>`;
    }

    container.innerHTML = html;

    container.querySelectorAll('[data-action="edit-post"]').forEach(btn => {
        btn.addEventListener('click', () => editBlogPost(btn.dataset.id));
    });
    container.querySelectorAll('[data-action="delete-post"]').forEach(btn => {
        btn.addEventListener('click', () => deleteBlogPost(btn.dataset.id));
    });
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
    if (search) {
        filtered = filtered.filter(p => (p.title || '').toLowerCase().includes(search) || (p.slug || '').toLowerCase().includes(search));
    }
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
            { id: 'conseils', label: 'Conseils' },
            { id: 'tendances', label: 'Tendances' },
            { id: 'tests', label: 'Tests' },
            { id: 'tutoriels', label: 'Tutoriels' },
            { id: 'smart-home', label: 'Smart Home' },
            { id: 'gadgets', label: 'Gadgets' },
            { id: 'actualites', label: 'Actualités' },
            { id: 'general', label: 'Général' }
        ];
        cats.forEach(cat => { html += `<option value="${cat.id}">${cat.label}</option>`; });
        catSelect.innerHTML = html;
        catSelect._populated = true;
    }

    document.getElementById('saveBlogBtn')?.addEventListener('click', saveBlogPost);
    document.getElementById('cancelBlogEdit')?.addEventListener('click', resetBlogForm);
}

function resetBlogForm() {
    document.getElementById('blogFormTitle').textContent = 'Nouvel article';
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
    document.getElementById('saveBlogBtnText').textContent = 'Enregistrer l\'article';
    document.getElementById('cancelBlogEdit').style.display = 'none';
}

async function editBlogPost(id) {
    try {
        const snap = await getDoc(doc(db, "blog", id));
        if (!snap.exists()) return;
        const p = snap.data();
        document.getElementById('blogFormTitle').textContent = 'Modifier l\'article';
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
        } else ip.style.display = 'none';

        document.getElementById('saveBlogBtnText').textContent = 'Enregistrer';
        document.getElementById('cancelBlogEdit').style.display = 'inline-flex';
        document.getElementById('tab-blog')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
        console.error('[admin] editBlogPost :', e);
        showToast('Erreur');
    }
}

async function saveBlogPost() {
    const editId = document.getElementById('blogEditId').value;
    const saveBtn = document.getElementById('saveBlogBtn');
    const btnText = document.getElementById('saveBlogBtnText');
    const title = document.getElementById('bTitle').value.trim();
    const slug = document.getElementById('bSlug').value.trim();
    const content = document.getElementById('bContent').value.trim();

    if (!title) { showToast('Le titre est obligatoire'); return; }
    if (!slug) { showToast('Le slug est obligatoire'); return; }
    if (!content) { showToast('Le contenu est obligatoire'); return; }

    saveBtn.disabled = true;
    const oldText = btnText.textContent;
    btnText.textContent = 'Enregistrement...';

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

        if (status === 'published') {
            if (editId) {
                const oldSnap = await getDoc(doc(db, "blog", editId));
                const oldData = oldSnap.exists() ? oldSnap.data() : {};
                postData.publishedAt = oldData.publishedAt || Timestamp.now();
            } else {
                postData.publishedAt = Timestamp.now();
            }
        }

        if (editId) {
            const oldSnap = await getDoc(doc(db, "blog", editId));
            const oldData = oldSnap.exists() ? oldSnap.data() : {};
            await updateDoc(doc(db, "blog", editId), postData);
            showToast('Article mis à jour');
            if (oldData.image && oldData.image !== imgUrl && isStorageUrl(oldData.image)) {
                await deleteStorageImage(oldData.image);
            }
        } else {
            postData.createdAt = Timestamp.now();
            await setDoc(doc(db, "blog", Date.now().toString()), postData);
            showToast('Article créé');
        }

        resetBlogForm();
        await loadBlogPosts();
    } catch (e) {
        console.error('[admin] saveBlogPost :', e);
        showToast(e.message || 'Erreur');
    } finally {
        saveBtn.disabled = false;
        btnText.textContent = oldText;
    }
}

async function deleteBlogPost(id) {
    const confirmed = await confirmAction('Supprimer définitivement cet article ?', {
        title: 'Supprimer', confirmText: 'Supprimer', cancelText: 'Annuler', variant: 'danger'
    });
    if (!confirmed) return;
    try {
        const snap = await getDoc(doc(db, "blog", id));
        if (!snap.exists()) { showToast('Article introuvable'); return; }
        const post = snap.data();
        await deleteDoc(doc(db, "blog", id));
        if (post.image && isStorageUrl(post.image)) await deleteStorageImage(post.image);
        showToast('Article supprimé');
        await loadBlogPosts();
    } catch (e) {
        console.error('[admin] deleteBlogPost :', e);
        showToast('Erreur');
    }
}

/* ============================================================
   COUPONS
   ============================================================ */
async function loadCoupons() {
    const container = document.getElementById('couponsList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement...</div>`;

    const COUPONS_LIMIT = 200;
    try {
        const q = query(collection(db, "coupons"), limit(COUPONS_LIMIT));
        const snap = await getDocs(q);
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

        if (snap.size === COUPONS_LIMIT) {
            console.warn(
                '[admin] Limite de ' + COUPONS_LIMIT + ' coupons atteinte. ' +
                'Certains coupons peuvent ne pas être affichés.'
            );
        }

        renderCouponsList(cachedCoupons);
    } catch (e) {
        console.error('[admin] loadCoupons :', e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur</div>`;
    }
}

function renderCouponsList(coupons) {
    const container = document.getElementById('couponsList');
    if (!container) return;

    if (coupons.length === 0) {
        container.innerHTML = `<div class="admin-empty" style="padding:3rem 1rem;"><p>Aucun code promo.</p></div>`;
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
        if (!isActive) { statusLabel = 'Désactivé'; statusClass = 'coupon-status-inactive'; }
        else if (isExpired) { statusLabel = 'Expiré'; statusClass = 'coupon-status-expired'; }
        else if (isFull) { statusLabel = 'Épuisé'; statusClass = 'coupon-status-expired'; }
        else { statusLabel = 'Actif'; statusClass = 'coupon-status-active'; }

        const valueLabel = type === 'percentage' ? `-${value}%` : (type === 'fixed' ? `-${value} MAD` : 'Livraison offerte');

        let progressHtml = '';
        if (maxUses > 0) {
            const percent = Math.min(100, (usedCount / maxUses) * 100);
            progressHtml = `<div class="coupon-meta" style="margin-top:0.2rem;"><span>Utilisations : <strong>${usedCount}/${maxUses}</strong></span></div><div class="coupon-progress"><div class="coupon-progress-fill ${percent >= 100 ? 'full' : ''}" style="width:${percent}%"></div></div>`;
        } else {
            progressHtml = `<div class="coupon-meta" style="margin-top:0.2rem;"><span>Utilisations : <strong>${usedCount}</strong> (illimité)</span></div>`;
        }

        let expireLabel = '<span style="color:var(--text-dim);">Jamais</span>';
        if (expiresAt) {
            const dateStr = expiresAt.toLocaleDateString('fr-FR');
            expireLabel = isExpired
                ? `<span style="color:var(--danger);font-weight:700;">Expiré le ${dateStr}</span>`
                : `<span style="color:var(--success);">Expire le ${dateStr}</span>`;
        }

        const minLabel = minPurchase > 0 ? `<span>Min : <strong>${minPurchase} MAD</strong></span>` : '';
        const oneUseLabel = oneUsePerUser ? `<span><strong>1 usage/client</strong></span>` : '';

        const cardClasses = ['coupon-card'];
        if (!isActive) cardClasses.push('is-inactive');
        if (isExpired || isFull) cardClasses.push('is-expired');

        html += `<div class="${cardClasses.join(' ')}" data-coupon-id="${coupon.id}"><div class="coupon-header"><div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;"><span class="coupon-code-badge">${code}</span><span class="coupon-type-badge ${typeMeta.cssClass}">${valueLabel}</span><span class="coupon-status-badge ${statusClass}">${statusLabel}</span></div></div>${description ? `<div class="coupon-desc">${description}</div>` : ''}<div class="coupon-meta">${expireLabel}${minLabel}${oneUseLabel}</div>${progressHtml}<div class="coupon-actions"><button class="admin-btn-icon" data-action="coupon-toggle" data-id="${coupon.id}">${isActive ? 'Désactiver' : 'Activer'}</button><button class="admin-btn-icon" data-action="coupon-edit" data-id="${coupon.id}">Modifier</button><button class="admin-btn-icon admin-btn-danger" data-action="coupon-delete" data-id="${coupon.id}">Supprimer</button></div></div>`;
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
    document.getElementById('couponFormTitle').textContent = 'Créer un code promo';
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
        if (!snap.exists()) { showToast('Coupon introuvable'); return; }
        const c = snap.data();

        document.getElementById('couponFormTitle').textContent = 'Modifier le code promo';
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
    } catch (e) {
        console.error('[admin] editCoupon :', e);
        showToast('Erreur');
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

    if (!code || code.length < 3) { showToast('Le code doit faire au moins 3 caractères'); return; }
    if (code.length > 30) { showToast('Le code est trop long (max 30)'); return; }
    if (type !== 'free_shipping' && (isNaN(valueRaw) || valueRaw <= 0)) { showToast('La valeur doit être > 0'); return; }
    if (type === 'percentage' && valueRaw > 100) { showToast('Un pourcentage ne peut dépasser 100%'); return; }

    const deterministicId = code.replace(/[^A-Z0-9]/g, '_');
    try {
        const existingDoc = await getDoc(doc(db, "coupons", deterministicId));
        if (existingDoc.exists() && existingDoc.id !== editId) {
            showToast('Ce code existe déjà - choisissez-en un autre');
            return;
        }

        saveBtn.disabled = true;
        const oldText = btnText.textContent;
        btnText.textContent = 'Enregistrement...';

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
            showToast('Code promo mis à jour');
        } else {
            couponData.usedCount = 0;
            couponData.createdAt = Timestamp.now();
            await setDoc(doc(db, "coupons", deterministicId), couponData);
            showToast('Code promo créé : ' + code);
        }

        resetCouponForm();
        await loadCoupons();
    } catch (e) {
        console.error('[admin] saveCoupon :', e);
        showToast(e.message || 'Erreur');
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
        await updateDoc(doc(db, "coupons", id), {
            isActive: !current,
            updatedAt: Timestamp.now()
        });
        showToast(!current ? 'Code activé' : 'Code désactivé');
        await loadCoupons();
    } catch (e) {
        console.error('[admin] toggleCouponActive :', e);
        showToast('Erreur');
    }
}

async function deleteCoupon(id) {
    const confirmed = await confirmAction('Supprimer définitivement ce code promo ?', {
        title: 'Supprimer', confirmText: 'Supprimer', cancelText: 'Annuler', variant: 'danger'
    });
    if (!confirmed) return;
    try {
        await deleteDoc(doc(db, "coupons", id));
        showToast('Code promo supprimé');
        await loadCoupons();
    } catch (e) {
        console.error('[admin] deleteCoupon :', e);
        showToast('Erreur');
    }
}

function filterCouponsList() {
    const search = document.getElementById('couponSearchAdmin')?.value.toLowerCase().trim() || '';
    let filtered = cachedCoupons;
    if (search) {
        filtered = filtered.filter(c =>
            (c.code || '').toLowerCase().includes(search) ||
            (c.description || '').toLowerCase().includes(search)
        );
    }
    renderCouponsList(filtered);
}

/* ============================================================
   LIVO
   ============================================================ */
function _getId(...ids) {
    for (const id of ids) {
        if (!id) continue;
        const el = document.getElementById(id);
        if (el) return el;
    }
    return null;
}

async function loadLivoTab() {
    const container = _getId('adminLivoList', 'adminSpeedafList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement des commandes Livo...</div>`;

    try {
        const q = query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(100));
        const snap = await getDocs(q);
        livoOrdersCache = snap.docs.map(d => {
            const data = d.data();
            return { id: d.id, ...data, createdAt: toDate(data.createdAt) };
        });
        updateLivoStats();
        renderLivoList();
    } catch (e) {
        console.error('[admin] loadLivoTab :', e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur de chargement.</div>`;
    }
}

function updateLivoStats() {
    let pending = 0, shipping = 0, delivered = 0;
    livoOrdersCache.forEach(o => {
        const status = normalizeOrderStatus(o.status);
        if (status === 'pending') pending++;
        else if (status === 'shipping') shipping++;
        else if (status === 'delivered') delivered++;
    });

    const storedCount = cachedProducts.filter(p =>
        p.isLivoStored === true || p.isSpeedafStored === true
    ).length;

    const elP = _getId('livoStatPending', 'speedafStatPending');
    if (elP) elP.textContent = pending;
    const elS = _getId('livoStatShipping', 'speedafStatShipping');
    if (elS) elS.textContent = shipping;
    const elD = _getId('livoStatDelivered', 'speedafStatDelivered');
    if (elD) elD.textContent = delivered;
    const elSt = _getId('livoStatStorage', 'speedafStatStorage');
    if (elSt) {
        elSt.textContent = `${storedCount} / 10`;
        elSt.style.color = storedCount >= 10 ? 'var(--danger)' : 'var(--text)';
    }
}

function renderLivoList() {
    const container = _getId('adminLivoList', 'adminSpeedafList');
    if (!container) return;

    const search = (_getId('livoSearchAdmin', 'speedafSearchAdmin')?.value || '').toLowerCase().trim();
    const filterStatus = _getId('livoStatusFilter', 'speedafStatusFilter')?.value || 'all';

    let filtered = livoOrdersCache;
    if (filterStatus !== 'all') {
        filtered = filtered.filter(o => normalizeOrderStatus(o.status) === filterStatus);
    }
    if (search) {
        filtered = filtered.filter(o => {
            const idStr = o.id.slice(0, 8).toLowerCase();
            const trackingStr = (o.livoTracking || o.speedafTracking || '').toLowerCase();
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
        if (status === 'pending') statusBadge = 'À expédier';
        else if (status === 'confirmed') statusBadge = 'Confirmée';
        else if (status === 'shipping') statusBadge = 'En cours';
        else if (status === 'delivered') statusBadge = 'Livré';
        else if (status === 'returned') statusBadge = 'Retourné';
        else if (status === 'cancelled') statusBadge = 'Annulé';

        const trackingId = order.livoTracking || order.speedafTracking;
        const trackingHtml = trackingId
            ? `<div style="font-size:0.8rem; color:var(--gold); margin-top:0.2rem;"><strong>Suivi:</strong> ${escapeHTML(trackingId)}</div>`
            : '';

        const labelUrl = order.livoLabelUrl || order.speedafLabelUrl;
        const printBtn = labelUrl
            ? `<a href="${escapeHTML(labelUrl)}" target="_blank" class="admin-btn-primary" style="padding:0.4rem 0.8rem; font-size:0.75rem; text-decoration:none; margin-left:0.3rem;">Étiquette</a>`
            : '';

        const syncBtn = trackingId && ['shipping', 'confirmed'].includes(status)
            ? `<button class="admin-btn-secondary" data-sync-id="${order.id}" style="padding:0.4rem 0.8rem; font-size:0.75rem; margin-left:0.3rem;">Sync</button>`
            : '';

        html += `<div class="admin-list-item" style="flex-direction:column; align-items:stretch; padding:1rem;"><div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.5rem;"><div><strong style="color:var(--gold); font-size:1rem;">#${idShort}</strong><span style="margin-left:0.5rem; font-size:0.85rem; color:var(--text-muted);">${dateStr}</span><span style="margin-left:0.5rem; font-size:0.8rem; font-weight:700;">${statusBadge}</span></div><div style="font-weight:700; color:var(--text);">${order.total || 0} MAD</div></div><div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.5rem;">${escapeHTML(order.deliveryAddress?.name || '—')} · ${escapeHTML(order.deliveryAddress?.phone || '')} · ${escapeHTML(cityStr)}</div>${trackingHtml}<div style="display:flex; justify-content:flex-end; margin-top:0.5rem;">${syncBtn}${printBtn}</div></div>`;
    });

    container.innerHTML = html;

    container.querySelectorAll('[data-sync-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.syncId;
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '...';
            const res = await syncLivoStatus(orderId);
            if (res.success) {
                if (res.updated) {
                    showToast(`Statut mis à jour : ${res.newStatus}`);
                    await loadLivoTab();
                } else {
                    showToast(`Statut Livo : ${res.currentStatus}`);
                }
            } else {
                showToast(`Erreur: ${res.error}`);
            }
            btn.disabled = false;
            btn.innerHTML = originalText;
        });
    });
}

async function handleSyncAllLivo() {
    if (isSyncingAllLivo) return;

    const btn = _getId('syncAllLivoBtn', 'syncAllSpeedafBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Synchronisation...'; }
    isSyncingAllLivo = true;

    const ordersToSync = livoOrdersCache.filter(o => {
        const trackingId = o.livoTracking || o.speedafTracking;
        return trackingId && ['shipping', 'confirmed'].includes(normalizeOrderStatus(o.status));
    });

    if (ordersToSync.length === 0) {
        showToast('Aucune commande en cours à synchroniser.');
        if (btn) { btn.disabled = false; btn.textContent = 'Synchroniser les statuts'; }
        isSyncingAllLivo = false;
        return;
    }

    let updatedCount = 0, errorCount = 0;
    for (const order of ordersToSync) {
        try {
            const res = await syncLivoStatus(order.id);
            if (res.success && res.updated) updatedCount++;
        } catch (e) { errorCount++; }
    }

    showToast(`${updatedCount} commande(s) mise(s) à jour.${errorCount > 0 ? ' ' + errorCount + ' erreur(s).' : ''}`);
    await loadLivoTab();

    if (btn) { btn.disabled = false; btn.textContent = 'Synchroniser les statuts'; }
    isSyncingAllLivo = false;
}

async function handleConfirmPickup() {
    const dateVal = _getId('pickupDate')?.value;
    const packages = parseInt(_getId('pickupPackages')?.value) || 1;
    const weight = parseFloat(_getId('pickupWeight')?.value) || 1;
    const note = (_getId('pickupNote')?.value || '').trim();

    if (!dateVal) { showToast('Sélectionnez une date'); return; }

    const selectedDate = new Date(dateVal);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (selectedDate < today) {
        showToast('La date de ramassage ne peut pas être dans le passé');
        return;
    }

    const btn = _getId('confirmPickupBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Envoi...'; }

    const newCollection = CONFIG.LOGISTICS.PICKUPS_FIRESTORE_COLLECTION;
    const legacyCollection = CONFIG.LOGISTICS.LEGACY_PICKUPS_COLLECTION;

    try {
        const itemsToPickup = [];
        const productsToPickup = [];

        let livoResult = { success: false, error: null };
        if (itemsToPickup.length > 0 || productsToPickup.length > 0) {
            if (isTestMode()) {
                livoResult = { success: true, pickupId: 'TEST-PI-' + Date.now(), trackingId: 'TEST-PI-' + Date.now() };
            } else {
                try {
                    livoResult = await createLivoPickup({
                        items: itemsToPickup,
                        products: productsToPickup,
                        desired_date: selectedDate,
                        comment: note || `Ramassage Smart Swi9a — ${packages} colis, ${weight} kg`
                    });
                } catch (e) {
                    livoResult = { success: false, error: e?.message || 'unknown' };
                }
            }
        } else {
            livoResult = { success: false, error: 'No items/products selected (manual fallback)' };
        }

        const pickupData = {
            date: Timestamp.fromDate(selectedDate),
            packages,
            weight,
            note,
            status: isTestMode() ? 'test_mode' : (livoResult.success ? 'sent' : 'pending_manual'),
            livoPickupId: livoResult.success ? (livoResult.pickupId || null) : null,
            livoTrackingId: livoResult.success ? (livoResult.trackingId || null) : null,
            livoError: livoResult.success ? null : (livoResult.error || 'unknown'),
            createdAt: Timestamp.now()
        };

        try {
            await addDoc(collection(db, newCollection), pickupData);
        } catch (e) {
            if (e?.code === 'permission-denied' && legacyCollection) {
                await addDoc(collection(db, legacyCollection), pickupData);
            } else {
                throw e;
            }
        }

        if (isTestMode()) {
            showToast('Ramassage enregistré (mode test)');
        } else if (livoResult.success) {
            showToast(`Ramassage créé chez Livo (ID: ${livoResult.pickupId})`);
        } else {
            showToast(`Livo a refusé : ${livoResult.error}. Enregistré localement.`, 5000);
        }

        _getId('pickupModal')?.classList.remove('open');
    } catch (e) {
        console.error('[admin] handleConfirmPickup :', e);
        showToast('Erreur : ' + (e?.message || 'échec'));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Envoyer la demande'; }
    }
}

/* ============================================================
   ALERTES BANNER
   ============================================================ */
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
    document.getElementById('alertProductsPendingBtn')?.addEventListener('click', () => document.querySelector('[data-tab="products"]')?.click());
    
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
        const [ordersSnap, reviewsSnap, productsSnap] = await Promise.allSettled([
            getCountFromServer(query(collection(db, "orders"), where("status", "==", "pending"))),
            getCountFromServer(query(collection(db, "reviews"), where("status", "==", "pending"))),
            getCountFromServer(query(collection(db, "products"), where("status", "==", "pending_admin_approval")))
        ]);

        const pendingOrdersCount = ordersSnap.value?.data().count || 0;
        const pendingReviewsCount = reviewsSnap.value?.data().count || 0;
        const pendingProductsCount = productsSnap.value?.data().count || 0;

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
        const btnP = document.getElementById('alertProductsPendingBtn');
        const btnSO = document.getElementById('alertStockOutBtn');
        const btnSL = document.getElementById('alertStockLowBtn');
        let hasAlerts = false;

        if (btnO) {
            if (pendingOrdersCount > 0) {
                document.getElementById('alertOrdersCount').textContent = pendingOrdersCount;
                btnO.style.display = 'inline-flex';
                hasAlerts = true;
            } else btnO.style.display = 'none';
        }
        if (btnR) {
            if (pendingReviewsCount > 0) {
                document.getElementById('alertReviewsCount').textContent = pendingReviewsCount;
                btnR.style.display = 'inline-flex';
                hasAlerts = true;
            } else btnR.style.display = 'none';
        }
        if (btnP) {
            if (pendingProductsCount > 0) {
                document.getElementById('alertProductsPendingCount').textContent = pendingProductsCount;
                btnP.style.display = 'inline-flex';
                hasAlerts = true;
            } else btnP.style.display = 'none';
        }
        if (btnSO) {
            if (stockOutNames.length > 0) {
                document.getElementById('alertStockOutCount').textContent = stockOutNames.length;
                const tip = document.getElementById('alertStockOutTooltip');
                if (tip) tip.textContent = formatTooltipList(stockOutNames);
                btnSO.style.display = 'inline-flex';
                hasAlerts = true;
            } else btnSO.style.display = 'none';
        }
        if (btnSL) {
            if (stockLowNames.length > 0) {
                document.getElementById('alertStockLowCount').textContent = stockLowNames.length;
                const tip = document.getElementById('alertStockLowTooltip');
                if (tip) tip.textContent = formatTooltipList(stockLowNames);
                btnSL.style.display = 'inline-flex';
                hasAlerts = true;
            } else btnSL.style.display = 'none';
        }

        banner.style.display = hasAlerts ? 'block' : 'none';
    } catch (e) {
        console.warn('[admin] refreshAdminAlerts :', e);
    }
}

/* ============================================================
   CHART REVENUS
   ============================================================ */
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
            const ordersSnap = await getDocs(query(collection(db, "orders"), limit(500)));
            orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        }

        const buckets = {};
        for (let i = 0; i < period; i++) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
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
            data: {
                labels,
                datasets: [{
                    label: 'CA (Livré)',
                    data: revenueData,
                    borderColor: '#a57b2e',
                    backgroundColor: 'rgba(165, 123, 46, 0.12)',
                    fill: true,
                    tension: 0.3
                }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    } catch (e) {
        console.error('[admin] renderRevenueChart :', e);
    }
}

/* ============================================================
   FINANCES - CHARGEMENT
   ============================================================ */
async function loadPurchases() {
    try {
        const snap = await getDocs(query(collection(db, "purchases"), orderBy("date", "desc"), limit(500)));
        cachedPurchases = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
    } catch (err) {
        try {
            const snap = await getDocs(query(collection(db, "purchases"), limit(500)));
            cachedPurchases = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
            cachedPurchases.sort((a, b) => safeDate(b.date) - safeDate(a.date));
        } catch (err2) {
            cachedPurchases = [];
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
            const snap = await getDocs(query(collection(db, "expenses"), limit(500)));
            cachedExpenses = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
            cachedExpenses.sort((a, b) => safeDate(b.date) - safeDate(a.date));
        } catch (err2) {
            cachedExpenses = [];
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
            const snap = await getDocs(query(collection(db, "transactions"), limit(500)));
            cachedTransactions = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
            cachedTransactions.sort((a, b) => safeDate(b.date) - safeDate(a.date));
        } catch (err2) {
            cachedTransactions = [];
        }
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

    kpis.innerHTML = '<div class="admin-loading">Calcul...</div>';
    waterfall.innerHTML = '<div class="admin-loading">Calcul...</div>';

    try {
        if (cachedProducts.length >= 500) {
            console.warn(
                '[admin] cachedProducts limité à 500 - les COGS peuvent être sous-estimés ' +
                'pour les produits > 500. Augmenter la limite de loadProducts si nécessaire.'
            );
        }

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
            const t = d.data();
            if (!isInRange(toDate(t.date), start, end)) return;
            if (t.type === 'income') extraIncome += Number(t.amount) || 0;
            else otherExpenses += Number(t.amount) || 0;
        });

        const grossProfit = revenue - cogs;
        const netProfit = grossProfit - shippingCost - adSpend - otherExpenses + extraIncome;
        const margin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

        kpis.innerHTML = `
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--success);">${formatMAD(revenue)}</span><span class="stat-label">Chiffre d'affaires</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(cogs)}</span><span class="stat-label">COGS</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(shippingCost)}</span><span class="stat-label">Frais livraison</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(adSpend)}</span><span class="stat-label">Publicité</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(otherExpenses)}</span><span class="stat-label">Autres dépenses</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--info);">${formatMAD(extraIncome)}</span><span class="stat-label">Autres revenus</span></div>
            <div class="admin-stat-card" style="border-color:var(--gold);"><span class="stat-value" style="color:var(--gold);">${formatMAD(netProfit)}</span><span class="stat-label">Bénéfice NET</span></div>
            <div class="admin-stat-card"><span class="stat-value">${margin.toFixed(1)}%</span><span class="stat-label">Marge nette</span></div>
        `;

        waterfall.innerHTML = `<table class="acc-table" style="width:100%;">
            <tr><td>Chiffre d'affaires</td><td style="text-align:right;color:var(--success);font-weight:700;">${formatMAD(revenue)}</td></tr>
            <tr><td>COGS</td><td style="text-align:right;color:var(--danger);">-${formatMAD(cogs)}</td></tr>
            <tr style="font-weight:700;background:rgba(0,0,0,0.02);"><td>Marge Brute</td><td style="text-align:right;">${formatMAD(grossProfit)}</td></tr>
            <tr><td>Livraison</td><td style="text-align:right;color:var(--danger);">-${formatMAD(shippingCost)}</td></tr>
            <tr><td>Pub</td><td style="text-align:right;color:var(--danger);">-${formatMAD(adSpend)}</td></tr>
            <tr><td>Autres dép.</td><td style="text-align:right;color:var(--danger);">-${formatMAD(otherExpenses)}</td></tr>
            <tr><td>Autres rev.</td><td style="text-align:right;color:var(--info);">+${formatMAD(extraIncome)}</td></tr>
            <tr style="font-weight:800;background:var(--bg-surface);border-top:2px solid var(--gold);"><td>Bénéfice NET</td><td style="text-align:right;color:var(--gold);">${formatMAD(netProfit)}</td></tr>
        </table>`;

        await renderRevenueChart(currentChartPeriod, ordersSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
        console.error('[admin] refreshAccOverview :', e);
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

/* ============================================================
   ACHATS / DÉPENSES / TRANSACTIONS — CRUD
   ============================================================ */
async function saveNewPurchase() {
    const productId = document.getElementById('purProductId').value;
    const qty = parseInt(document.getElementById('purQty').value);
    const unitPrice = parseFloat(document.getElementById('purUnitPrice').value);
    const shippingCost = parseFloat(document.getElementById('purShippingCost').value) || 0;
    const supplier = document.getElementById('purSupplier').value.trim();
    const dateVal = document.getElementById('purDate').value;
    const note = document.getElementById('purNote').value.trim();

    if (!productId) { showToast('Sélectionnez un produit'); return; }
    if (!qty || qty < 1) { showToast('Quantité invalide'); return; }
    if (isNaN(unitPrice) || unitPrice < 0) { showToast('Prix invalide'); return; }
    if (!dateVal) { showToast('Date invalide'); return; }

    const btn = document.getElementById('addPurchaseBtn');
    btn.disabled = true;
    btn.textContent = '...';

    try {
        const totalCost = (qty * unitPrice) + shippingCost;
        const product = cachedProducts.find(p => p.id === productId);

        await addDoc(collection(db, "purchases"), {
            productId,
            productName: product?.nameFr || 'Inconnu',
            quantity: qty, unitPrice, shippingCost, totalCost, supplier,
            date: Timestamp.fromDate(new Date(dateVal)),
            note,
            createdAt: Timestamp.now()
        });

        if (product) {
            await updateDoc(doc(db, "products", productId), {
                stock: increment(qty),
                purchasePrice: unitPrice,
                updatedAt: Timestamp.now()
            });
        }

        showToast('Achat enregistré et stock mis à jour');
        document.getElementById('purQty').value = '';
        document.getElementById('purUnitPrice').value = '';
        document.getElementById('purShippingCost').value = '0';
        document.getElementById('purNote').value = '';

        await loadPurchases();
        await loadProducts(true);
        await renderPurchasesList();
    } catch (e) {
        console.error('[admin] saveNewPurchase :', e);
        showToast(e.message || 'Erreur');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enregistrer l\'achat';
    }
}

async function renderPurchasesList() {
    const container = document.getElementById('purchasesList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement...</div>`;

    await loadPurchases();
    if (cachedPurchases.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucun achat enregistré.</div>`;
        return;
    }

    let html = `<table class="acc-table"><thead><tr><th>Date</th><th>Produit</th><th>Qté</th><th>Prix Unit.</th><th>Livraison</th><th>Total</th><th>Fournisseur</th></tr></thead><tbody>`;
    cachedPurchases.forEach(p => {
        html += `<tr><td>${p.date ? p.date.toLocaleDateString('fr-FR') : '—'}</td><td><strong>${escapeHTML(p.productName)}</strong></td><td>${p.quantity}</td><td>${formatMAD(p.unitPrice)}</td><td>${formatMAD(p.shippingCost)}</td><td style="font-weight:700;color:var(--danger);">${formatMAD(p.totalCost)}</td><td>${escapeHTML(p.supplier || '—')}</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

async function saveNewExpense() {
    const category = document.getElementById('expCategory').value;
    const amount = parseFloat(document.getElementById('expAmount').value);
    const dateVal = document.getElementById('expDate').value;
    const description = document.getElementById('expDescription').value.trim();

    if (isNaN(amount) || amount <= 0) { showToast('Montant invalide'); return; }
    if (!dateVal) { showToast('Date invalide'); return; }
    if (!description) { showToast('Description requise'); return; }

    const btn = document.getElementById('addExpenseBtn');
    btn.disabled = true;
    btn.textContent = '...';

    try {
        await addDoc(collection(db, "expenses"), {
            category, amount, description,
            date: Timestamp.fromDate(new Date(dateVal)),
            createdAt: Timestamp.now()
        });
        showToast('Dépense enregistrée');
        document.getElementById('expAmount').value = '';
        document.getElementById('expDescription').value = '';
        await loadExpenses();
        await renderExpensesList();
    } catch (e) {
        console.error('[admin] saveNewExpense :', e);
        showToast(e.message || 'Erreur');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enregistrer la dépense';
    }
}

async function renderExpensesList() {
    const container = document.getElementById('expensesList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement...</div>`;

    await loadExpenses();
    if (cachedExpenses.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucune dépense enregistrée.</div>`;
        return;
    }

    let html = `<table class="acc-table"><thead><tr><th>Date</th><th>Catégorie</th><th>Description</th><th>Montant</th></tr></thead><tbody>`;
    cachedExpenses.forEach(e => {
        html += `<tr><td>${e.date ? e.date.toLocaleDateString('fr-FR') : '—'}</td><td>${escapeHTML(e.category)}</td><td>${escapeHTML(e.description)}</td><td style="font-weight:700;color:var(--danger);">${formatMAD(e.amount)}</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

async function saveNewTransaction() {
    const type = document.getElementById('transType').value;
    const amount = parseFloat(document.getElementById('transAmount').value);
    const dateVal = document.getElementById('transDate').value;
    const description = document.getElementById('transDescription').value.trim();

    if (isNaN(amount) || amount <= 0) { showToast('Montant invalide'); return; }
    if (!dateVal) { showToast('Date invalide'); return; }
    if (!description) { showToast('Description requise'); return; }

    const btn = document.getElementById('addTransactionBtn');
    btn.disabled = true;
    btn.textContent = '...';

    try {
        await addDoc(collection(db, "transactions"), {
            type, amount, description,
            date: Timestamp.fromDate(new Date(dateVal)),
            createdAt: Timestamp.now()
        });
        showToast('Transaction enregistrée');
        document.getElementById('transAmount').value = '';
        document.getElementById('transDescription').value = '';
        await loadTransactions();
        await renderTransactionsList();
    } catch (e) {
        console.error('[admin] saveNewTransaction :', e);
        showToast(e.message || 'Erreur');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enregistrer';
    }
}

async function renderTransactionsList() {
    const container = document.getElementById('transactionsList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement...</div>`;

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
        html += `<tr><td>${t.date ? t.date.toLocaleDateString('fr-FR') : '—'}</td><td><span style="color:${isIncome ? 'var(--success)' : 'var(--danger)'};font-weight:700;">${isIncome ? 'Revenu' : 'Dépense'}</span></td><td>${escapeHTML(t.description)}</td><td style="font-weight:700;color:${isIncome ? 'var(--success)' : 'var(--danger)'};">${isIncome ? '+' : '-'} ${formatMAD(t.amount)}</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}
/* ============================================================
   PARTIE 2/3 — Blog + Coupons + Livo + Alertes + Chart + Finances
   Version 12.2.0
   ============================================================ */

/* ============================================================
   BLOG
   ============================================================ */
async function loadBlogPosts() {
    const container = document.getElementById('adminBlogList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement des articles...</div>`;

    const BLOG_LIMIT = 100;
    try {
        const q = query(collection(db, "blog"), limit(BLOG_LIMIT));
        const snap = await getDocs(q);
        cachedBlogPosts = snap.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                createdAt: toDate(data.createdAt),
                updatedAt: toDate(data.updatedAt),
                publishedAt: toDate(data.publishedAt)
            };
        });
        cachedBlogPosts.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));

        if (snap.size === BLOG_LIMIT) {
            console.warn(
                '[admin] Limite de ' + BLOG_LIMIT + ' articles atteinte. ' +
                'Certains articles peuvent ne pas être affichés.'
            );
        }

        blogCurrentPage = 1;
        renderBlogListAdmin(cachedBlogPosts);
    } catch (e) {
        console.error('[admin] loadBlogPosts :', e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur</div>`;
    }
}

function renderBlogListAdmin(posts) {
    const container = document.getElementById('adminBlogList');
    if (!container) return;

    if (posts.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucun article.</div>`;
        return;
    }

    const totalPages = Math.max(1, Math.ceil(posts.length / BLOG_PER_PAGE));
    if (blogCurrentPage > totalPages) blogCurrentPage = totalPages;
    if (blogCurrentPage < 1) blogCurrentPage = 1;
    const start = (blogCurrentPage - 1) * BLOG_PER_PAGE;
    const pagePosts = posts.slice(start, start + BLOG_PER_PAGE);

    let html = '';
    pagePosts.forEach(post => {
        const title = escapeHTML(post.title || 'Sans titre');
        const categoryLabel = escapeHTML(tBlogCategory(post.category || 'general'));
        const status = post.status || 'draft';
        const statusLabel = status === 'published' ? 'Publié' : 'Brouillon';
        const statusClass = status === 'published' ? 'published' : 'draft';
        const date = post.publishedAt
            ? post.publishedAt.toLocaleDateString('fr-FR')
            : (post.createdAt ? post.createdAt.toLocaleDateString('fr-FR') : '—');

        const thumb = post.image
            ? `<img src="${escapeHTML(post.image)}" class="admin-blog-thumb" alt="Cover">`
            : `<div class="admin-blog-thumb" style="display:flex;align-items:center;justify-content:center;font-size:1.5rem;background:var(--bg-surface);">-</div>`;

        html += `<div class="admin-blog-item" data-post-id="${post.id}">${thumb}<div class="admin-blog-info"><h4>${title}</h4><div class="meta">${categoryLabel} · ${date} · <span class="status ${statusClass}">${statusLabel}</span></div><div style="display:flex;gap:0.4rem;flex-wrap:wrap;"><button class="admin-btn-icon" data-action="edit-post" data-id="${post.id}">Modifier</button><button class="admin-btn-icon admin-btn-danger" data-action="delete-post" data-id="${post.id}">Del</button></div></div></div>`;
    });

    if (totalPages > 1) {
        html += `<div style="display:flex;justify-content:center;gap:0.3rem;margin-top:1rem;flex-wrap:wrap;">`;
        html += `<button class="admin-btn-icon" data-blog-page="prev" ${blogCurrentPage === 1 ? 'disabled' : ''}>‹</button>`;
        for (let i = 1; i <= totalPages; i++) {
            html += `<button class="admin-btn-icon ${i === blogCurrentPage ? 'active' : ''}" data-blog-page="${i}" style="${i === blogCurrentPage ? 'background:var(--gold);color:#fff;' : ''}">${i}</button>`;
        }
        html += `<button class="admin-btn-icon" data-blog-page="next" ${blogCurrentPage === totalPages ? 'disabled' : ''}>›</button></div>`;
    }

    container.innerHTML = html;

    container.querySelectorAll('[data-action="edit-post"]').forEach(btn => {
        btn.addEventListener('click', () => editBlogPost(btn.dataset.id));
    });
    container.querySelectorAll('[data-action="delete-post"]').forEach(btn => {
        btn.addEventListener('click', () => deleteBlogPost(btn.dataset.id));
    });
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
    if (search) {
        filtered = filtered.filter(p => (p.title || '').toLowerCase().includes(search) || (p.slug || '').toLowerCase().includes(search));
    }
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
            { id: 'conseils', label: 'Conseils' },
            { id: 'tendances', label: 'Tendances' },
            { id: 'tests', label: 'Tests' },
            { id: 'tutoriels', label: 'Tutoriels' },
            { id: 'smart-home', label: 'Smart Home' },
            { id: 'gadgets', label: 'Gadgets' },
            { id: 'actualites', label: 'Actualités' },
            { id: 'general', label: 'Général' }
        ];
        cats.forEach(cat => { html += `<option value="${cat.id}">${cat.label}</option>`; });
        catSelect.innerHTML = html;
        catSelect._populated = true;
    }

    document.getElementById('saveBlogBtn')?.addEventListener('click', saveBlogPost);
    document.getElementById('cancelBlogEdit')?.addEventListener('click', resetBlogForm);
}

function resetBlogForm() {
    document.getElementById('blogFormTitle').textContent = 'Nouvel article';
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
    document.getElementById('saveBlogBtnText').textContent = 'Enregistrer l\'article';
    document.getElementById('cancelBlogEdit').style.display = 'none';
}

async function editBlogPost(id) {
    try {
        const snap = await getDoc(doc(db, "blog", id));
        if (!snap.exists()) return;
        const p = snap.data();
        document.getElementById('blogFormTitle').textContent = 'Modifier l\'article';
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
        } else ip.style.display = 'none';

        document.getElementById('saveBlogBtnText').textContent = 'Enregistrer';
        document.getElementById('cancelBlogEdit').style.display = 'inline-flex';
        document.getElementById('tab-blog')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
        console.error('[admin] editBlogPost :', e);
        showToast('Erreur');
    }
}

async function saveBlogPost() {
    const editId = document.getElementById('blogEditId').value;
    const saveBtn = document.getElementById('saveBlogBtn');
    const btnText = document.getElementById('saveBlogBtnText');
    const title = document.getElementById('bTitle').value.trim();
    const slug = document.getElementById('bSlug').value.trim();
    const content = document.getElementById('bContent').value.trim();

    if (!title) { showToast('Le titre est obligatoire'); return; }
    if (!slug) { showToast('Le slug est obligatoire'); return; }
    if (!content) { showToast('Le contenu est obligatoire'); return; }

    saveBtn.disabled = true;
    const oldText = btnText.textContent;
    btnText.textContent = 'Enregistrement...';

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

        if (status === 'published') {
            if (editId) {
                const oldSnap = await getDoc(doc(db, "blog", editId));
                const oldData = oldSnap.exists() ? oldSnap.data() : {};
                postData.publishedAt = oldData.publishedAt || Timestamp.now();
            } else {
                postData.publishedAt = Timestamp.now();
            }
        }

        if (editId) {
            const oldSnap = await getDoc(doc(db, "blog", editId));
            const oldData = oldSnap.exists() ? oldSnap.data() : {};
            await updateDoc(doc(db, "blog", editId), postData);
            showToast('Article mis à jour');
            if (oldData.image && oldData.image !== imgUrl && isStorageUrl(oldData.image)) {
                await deleteStorageImage(oldData.image);
            }
        } else {
            postData.createdAt = Timestamp.now();
            await setDoc(doc(db, "blog", Date.now().toString()), postData);
            showToast('Article créé');
        }

        resetBlogForm();
        await loadBlogPosts();
    } catch (e) {
        console.error('[admin] saveBlogPost :', e);
        showToast(e.message || 'Erreur');
    } finally {
        saveBtn.disabled = false;
        btnText.textContent = oldText;
    }
}

async function deleteBlogPost(id) {
    const confirmed = await confirmAction('Supprimer définitivement cet article ?', {
        title: 'Supprimer', confirmText: 'Supprimer', cancelText: 'Annuler', variant: 'danger'
    });
    if (!confirmed) return;
    try {
        const snap = await getDoc(doc(db, "blog", id));
        if (!snap.exists()) { showToast('Article introuvable'); return; }
        const post = snap.data();
        await deleteDoc(doc(db, "blog", id));
        if (post.image && isStorageUrl(post.image)) await deleteStorageImage(post.image);
        showToast('Article supprimé');
        await loadBlogPosts();
    } catch (e) {
        console.error('[admin] deleteBlogPost :', e);
        showToast('Erreur');
    }
}

/* ============================================================
   COUPONS
   ============================================================ */
async function loadCoupons() {
    const container = document.getElementById('couponsList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement...</div>`;

    const COUPONS_LIMIT = 200;
    try {
        const q = query(collection(db, "coupons"), limit(COUPONS_LIMIT));
        const snap = await getDocs(q);
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

        if (snap.size === COUPONS_LIMIT) {
            console.warn(
                '[admin] Limite de ' + COUPONS_LIMIT + ' coupons atteinte. ' +
                'Certains coupons peuvent ne pas être affichés.'
            );
        }

        renderCouponsList(cachedCoupons);
    } catch (e) {
        console.error('[admin] loadCoupons :', e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur</div>`;
    }
}

function renderCouponsList(coupons) {
    const container = document.getElementById('couponsList');
    if (!container) return;

    if (coupons.length === 0) {
        container.innerHTML = `<div class="admin-empty" style="padding:3rem 1rem;"><p>Aucun code promo.</p></div>`;
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
        if (!isActive) { statusLabel = 'Désactivé'; statusClass = 'coupon-status-inactive'; }
        else if (isExpired) { statusLabel = 'Expiré'; statusClass = 'coupon-status-expired'; }
        else if (isFull) { statusLabel = 'Épuisé'; statusClass = 'coupon-status-expired'; }
        else { statusLabel = 'Actif'; statusClass = 'coupon-status-active'; }

        const valueLabel = type === 'percentage' ? `-${value}%` : (type === 'fixed' ? `-${value} MAD` : 'Livraison offerte');

        let progressHtml = '';
        if (maxUses > 0) {
            const percent = Math.min(100, (usedCount / maxUses) * 100);
            progressHtml = `<div class="coupon-meta" style="margin-top:0.2rem;"><span>Utilisations : <strong>${usedCount}/${maxUses}</strong></span></div><div class="coupon-progress"><div class="coupon-progress-fill ${percent >= 100 ? 'full' : ''}" style="width:${percent}%"></div></div>`;
        } else {
            progressHtml = `<div class="coupon-meta" style="margin-top:0.2rem;"><span>Utilisations : <strong>${usedCount}</strong> (illimité)</span></div>`;
        }

        let expireLabel = '<span style="color:var(--text-dim);">Jamais</span>';
        if (expiresAt) {
            const dateStr = expiresAt.toLocaleDateString('fr-FR');
            expireLabel = isExpired
                ? `<span style="color:var(--danger);font-weight:700;">Expiré le ${dateStr}</span>`
                : `<span style="color:var(--success);">Expire le ${dateStr}</span>`;
        }

        const minLabel = minPurchase > 0 ? `<span>Min : <strong>${minPurchase} MAD</strong></span>` : '';
        const oneUseLabel = oneUsePerUser ? `<span><strong>1 usage/client</strong></span>` : '';

        const cardClasses = ['coupon-card'];
        if (!isActive) cardClasses.push('is-inactive');
        if (isExpired || isFull) cardClasses.push('is-expired');

        html += `<div class="${cardClasses.join(' ')}" data-coupon-id="${coupon.id}"><div class="coupon-header"><div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;"><span class="coupon-code-badge">${code}</span><span class="coupon-type-badge ${typeMeta.cssClass}">${valueLabel}</span><span class="coupon-status-badge ${statusClass}">${statusLabel}</span></div></div>${description ? `<div class="coupon-desc">${description}</div>` : ''}<div class="coupon-meta">${expireLabel}${minLabel}${oneUseLabel}</div>${progressHtml}<div class="coupon-actions"><button class="admin-btn-icon" data-action="coupon-toggle" data-id="${coupon.id}">${isActive ? 'Désactiver' : 'Activer'}</button><button class="admin-btn-icon" data-action="coupon-edit" data-id="${coupon.id}">Modifier</button><button class="admin-btn-icon admin-btn-danger" data-action="coupon-delete" data-id="${coupon.id}">Supprimer</button></div></div>`;
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
    document.getElementById('couponFormTitle').textContent = 'Créer un code promo';
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
        if (!snap.exists()) { showToast('Coupon introuvable'); return; }
        const c = snap.data();

        document.getElementById('couponFormTitle').textContent = 'Modifier le code promo';
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
    } catch (e) {
        console.error('[admin] editCoupon :', e);
        showToast('Erreur');
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

    if (!code || code.length < 3) { showToast('Le code doit faire au moins 3 caractères'); return; }
    if (code.length > 30) { showToast('Le code est trop long (max 30)'); return; }
    if (type !== 'free_shipping' && (isNaN(valueRaw) || valueRaw <= 0)) { showToast('La valeur doit être > 0'); return; }
    if (type === 'percentage' && valueRaw > 100) { showToast('Un pourcentage ne peut dépasser 100%'); return; }

    const deterministicId = code.replace(/[^A-Z0-9]/g, '_');
    try {
        const existingDoc = await getDoc(doc(db, "coupons", deterministicId));
        if (existingDoc.exists() && existingDoc.id !== editId) {
            showToast('Ce code existe déjà - choisissez-en un autre');
            return;
        }

        saveBtn.disabled = true;
        const oldText = btnText.textContent;
        btnText.textContent = 'Enregistrement...';

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
            showToast('Code promo mis à jour');
        } else {
            couponData.usedCount = 0;
            couponData.createdAt = Timestamp.now();
            await setDoc(doc(db, "coupons", deterministicId), couponData);
            showToast('Code promo créé : ' + code);
        }

        resetCouponForm();
        await loadCoupons();
    } catch (e) {
        console.error('[admin] saveCoupon :', e);
        showToast(e.message || 'Erreur');
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
        await updateDoc(doc(db, "coupons", id), {
            isActive: !current,
            updatedAt: Timestamp.now()
        });
        showToast(!current ? 'Code activé' : 'Code désactivé');
        await loadCoupons();
    } catch (e) {
        console.error('[admin] toggleCouponActive :', e);
        showToast('Erreur');
    }
}

async function deleteCoupon(id) {
    const confirmed = await confirmAction('Supprimer définitivement ce code promo ?', {
        title: 'Supprimer', confirmText: 'Supprimer', cancelText: 'Annuler', variant: 'danger'
    });
    if (!confirmed) return;
    try {
        await deleteDoc(doc(db, "coupons", id));
        showToast('Code promo supprimé');
        await loadCoupons();
    } catch (e) {
        console.error('[admin] deleteCoupon :', e);
        showToast('Erreur');
    }
}

function filterCouponsList() {
    const search = document.getElementById('couponSearchAdmin')?.value.toLowerCase().trim() || '';
    let filtered = cachedCoupons;
    if (search) {
        filtered = filtered.filter(c =>
            (c.code || '').toLowerCase().includes(search) ||
            (c.description || '').toLowerCase().includes(search)
        );
    }
    renderCouponsList(filtered);
}

/* ============================================================
   LIVO
   ============================================================ */
function _getId(...ids) {
    for (const id of ids) {
        if (!id) continue;
        const el = document.getElementById(id);
        if (el) return el;
    }
    return null;
}

async function loadLivoTab() {
    const container = _getId('adminLivoList', 'adminSpeedafList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement des commandes Livo...</div>`;

    try {
        const q = query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(100));
        const snap = await getDocs(q);
        livoOrdersCache = snap.docs.map(d => {
            const data = d.data();
            return { id: d.id, ...data, createdAt: toDate(data.createdAt) };
        });
        updateLivoStats();
        renderLivoList();
    } catch (e) {
        console.error('[admin] loadLivoTab :', e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur de chargement.</div>`;
    }
}

function updateLivoStats() {
    let pending = 0, shipping = 0, delivered = 0;
    livoOrdersCache.forEach(o => {
        const status = normalizeOrderStatus(o.status);
        if (status === 'pending') pending++;
        else if (status === 'shipping') shipping++;
        else if (status === 'delivered') delivered++;
    });

    const storedCount = cachedProducts.filter(p =>
        p.isLivoStored === true || p.isSpeedafStored === true
    ).length;

    const elP = _getId('livoStatPending', 'speedafStatPending');
    if (elP) elP.textContent = pending;
    const elS = _getId('livoStatShipping', 'speedafStatShipping');
    if (elS) elS.textContent = shipping;
    const elD = _getId('livoStatDelivered', 'speedafStatDelivered');
    if (elD) elD.textContent = delivered;
    const elSt = _getId('livoStatStorage', 'speedafStatStorage');
    if (elSt) {
        elSt.textContent = `${storedCount} / 10`;
        elSt.style.color = storedCount >= 10 ? 'var(--danger)' : 'var(--text)';
    }
}

function renderLivoList() {
    const container = _getId('adminLivoList', 'adminSpeedafList');
    if (!container) return;

    const search = (_getId('livoSearchAdmin', 'speedafSearchAdmin')?.value || '').toLowerCase().trim();
    const filterStatus = _getId('livoStatusFilter', 'speedafStatusFilter')?.value || 'all';

    let filtered = livoOrdersCache;
    if (filterStatus !== 'all') {
        filtered = filtered.filter(o => normalizeOrderStatus(o.status) === filterStatus);
    }
    if (search) {
        filtered = filtered.filter(o => {
            const idStr = o.id.slice(0, 8).toLowerCase();
            const trackingStr = (o.livoTracking || o.speedafTracking || '').toLowerCase();
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
        if (status === 'pending') statusBadge = 'À expédier';
        else if (status === 'confirmed') statusBadge = 'Confirmée';
        else if (status === 'shipping') statusBadge = 'En cours';
        else if (status === 'delivered') statusBadge = 'Livré';
        else if (status === 'returned') statusBadge = 'Retourné';
        else if (status === 'cancelled') statusBadge = 'Annulé';

        const trackingId = order.livoTracking || order.speedafTracking;
        const trackingHtml = trackingId
            ? `<div style="font-size:0.8rem; color:var(--gold); margin-top:0.2rem;"><strong>Suivi:</strong> ${escapeHTML(trackingId)}</div>`
            : '';

        const labelUrl = order.livoLabelUrl || order.speedafLabelUrl;
        const printBtn = labelUrl
            ? `<a href="${escapeHTML(labelUrl)}" target="_blank" class="admin-btn-primary" style="padding:0.4rem 0.8rem; font-size:0.75rem; text-decoration:none; margin-left:0.3rem;">Étiquette</a>`
            : '';

        const syncBtn = trackingId && ['shipping', 'confirmed'].includes(status)
            ? `<button class="admin-btn-secondary" data-sync-id="${order.id}" style="padding:0.4rem 0.8rem; font-size:0.75rem; margin-left:0.3rem;">Sync</button>`
            : '';

        html += `<div class="admin-list-item" style="flex-direction:column; align-items:stretch; padding:1rem;"><div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.5rem;"><div><strong style="color:var(--gold); font-size:1rem;">#${idShort}</strong><span style="margin-left:0.5rem; font-size:0.85rem; color:var(--text-muted);">${dateStr}</span><span style="margin-left:0.5rem; font-size:0.8rem; font-weight:700;">${statusBadge}</span></div><div style="font-weight:700; color:var(--text);">${order.total || 0} MAD</div></div><div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.5rem;">${escapeHTML(order.deliveryAddress?.name || '—')} · ${escapeHTML(order.deliveryAddress?.phone || '')} · ${escapeHTML(cityStr)}</div>${trackingHtml}<div style="display:flex; justify-content:flex-end; margin-top:0.5rem;">${syncBtn}${printBtn}</div></div>`;
    });

    container.innerHTML = html;

    container.querySelectorAll('[data-sync-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.syncId;
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '...';
            const res = await syncLivoStatus(orderId);
            if (res.success) {
                if (res.updated) {
                    showToast(`Statut mis à jour : ${res.newStatus}`);
                    await loadLivoTab();
                } else {
                    showToast(`Statut Livo : ${res.currentStatus}`);
                }
            } else {
                showToast(`Erreur: ${res.error}`);
            }
            btn.disabled = false;
            btn.innerHTML = originalText;
        });
    });
}

async function handleSyncAllLivo() {
    if (isSyncingAllLivo) return;

    const btn = _getId('syncAllLivoBtn', 'syncAllSpeedafBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Synchronisation...'; }
    isSyncingAllLivo = true;

    const ordersToSync = livoOrdersCache.filter(o => {
        const trackingId = o.livoTracking || o.speedafTracking;
        return trackingId && ['shipping', 'confirmed'].includes(normalizeOrderStatus(o.status));
    });

    if (ordersToSync.length === 0) {
        showToast('Aucune commande en cours à synchroniser.');
        if (btn) { btn.disabled = false; btn.textContent = 'Synchroniser les statuts'; }
        isSyncingAllLivo = false;
        return;
    }

    let updatedCount = 0, errorCount = 0;
    for (const order of ordersToSync) {
        try {
            const res = await syncLivoStatus(order.id);
            if (res.success && res.updated) updatedCount++;
        } catch (e) { errorCount++; }
    }

    showToast(`${updatedCount} commande(s) mise(s) à jour.${errorCount > 0 ? ' ' + errorCount + ' erreur(s).' : ''}`);
    await loadLivoTab();

    if (btn) { btn.disabled = false; btn.textContent = 'Synchroniser les statuts'; }
    isSyncingAllLivo = false;
}

async function handleConfirmPickup() {
    const dateVal = _getId('pickupDate')?.value;
    const packages = parseInt(_getId('pickupPackages')?.value) || 1;
    const weight = parseFloat(_getId('pickupWeight')?.value) || 1;
    const note = (_getId('pickupNote')?.value || '').trim();

    if (!dateVal) { showToast('Sélectionnez une date'); return; }

    const selectedDate = new Date(dateVal);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (selectedDate < today) {
        showToast('La date de ramassage ne peut pas être dans le passé');
        return;
    }

    const btn = _getId('confirmPickupBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Envoi...'; }

    const newCollection = CONFIG.LOGISTICS.PICKUPS_FIRESTORE_COLLECTION;
    const legacyCollection = CONFIG.LOGISTICS.LEGACY_PICKUPS_COLLECTION;

    try {
        const itemsToPickup = [];
        const productsToPickup = [];

        let livoResult = { success: false, error: null };
        if (itemsToPickup.length > 0 || productsToPickup.length > 0) {
            if (isTestMode()) {
                livoResult = { success: true, pickupId: 'TEST-PI-' + Date.now(), trackingId: 'TEST-PI-' + Date.now() };
            } else {
                try {
                    livoResult = await createLivoPickup({
                        items: itemsToPickup,
                        products: productsToPickup,
                        desired_date: selectedDate,
                        comment: note || `Ramassage Smart Swi9a — ${packages} colis, ${weight} kg`
                    });
                } catch (e) {
                    livoResult = { success: false, error: e?.message || 'unknown' };
                }
            }
        } else {
            livoResult = { success: false, error: 'No items/products selected (manual fallback)' };
        }

        const pickupData = {
            date: Timestamp.fromDate(selectedDate),
            packages,
            weight,
            note,
            status: isTestMode() ? 'test_mode' : (livoResult.success ? 'sent' : 'pending_manual'),
            livoPickupId: livoResult.success ? (livoResult.pickupId || null) : null,
            livoTrackingId: livoResult.success ? (livoResult.trackingId || null) : null,
            livoError: livoResult.success ? null : (livoResult.error || 'unknown'),
            createdAt: Timestamp.now()
        };

        try {
            await addDoc(collection(db, newCollection), pickupData);
        } catch (e) {
            if (e?.code === 'permission-denied' && legacyCollection) {
                await addDoc(collection(db, legacyCollection), pickupData);
            } else {
                throw e;
            }
        }

        if (isTestMode()) {
            showToast('Ramassage enregistré (mode test)');
        } else if (livoResult.success) {
            showToast(`Ramassage créé chez Livo (ID: ${livoResult.pickupId})`);
        } else {
            showToast(`Livo a refusé : ${livoResult.error}. Enregistré localement.`, 5000);
        }

        _getId('pickupModal')?.classList.remove('open');
    } catch (e) {
        console.error('[admin] handleConfirmPickup :', e);
        showToast('Erreur : ' + (e?.message || 'échec'));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Envoyer la demande'; }
    }
}

/* ============================================================
   ALERTES BANNER
   ============================================================ */
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
    document.getElementById('alertProductsPendingBtn')?.addEventListener('click', () => document.querySelector('[data-tab="products"]')?.click());
    
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
        const [ordersSnap, reviewsSnap, productsSnap] = await Promise.allSettled([
            getCountFromServer(query(collection(db, "orders"), where("status", "==", "pending"))),
            getCountFromServer(query(collection(db, "reviews"), where("status", "==", "pending"))),
            getCountFromServer(query(collection(db, "products"), where("status", "==", "pending_admin_approval")))
        ]);

        const pendingOrdersCount = ordersSnap.value?.data().count || 0;
        const pendingReviewsCount = reviewsSnap.value?.data().count || 0;
        const pendingProductsCount = productsSnap.value?.data().count || 0;

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
        const btnP = document.getElementById('alertProductsPendingBtn');
        const btnSO = document.getElementById('alertStockOutBtn');
        const btnSL = document.getElementById('alertStockLowBtn');
        let hasAlerts = false;

        if (btnO) {
            if (pendingOrdersCount > 0) {
                document.getElementById('alertOrdersCount').textContent = pendingOrdersCount;
                btnO.style.display = 'inline-flex';
                hasAlerts = true;
            } else btnO.style.display = 'none';
        }
        if (btnR) {
            if (pendingReviewsCount > 0) {
                document.getElementById('alertReviewsCount').textContent = pendingReviewsCount;
                btnR.style.display = 'inline-flex';
                hasAlerts = true;
            } else btnR.style.display = 'none';
        }
        if (btnP) {
            if (pendingProductsCount > 0) {
                document.getElementById('alertProductsPendingCount').textContent = pendingProductsCount;
                btnP.style.display = 'inline-flex';
                hasAlerts = true;
            } else btnP.style.display = 'none';
        }
        if (btnSO) {
            if (stockOutNames.length > 0) {
                document.getElementById('alertStockOutCount').textContent = stockOutNames.length;
                const tip = document.getElementById('alertStockOutTooltip');
                if (tip) tip.textContent = formatTooltipList(stockOutNames);
                btnSO.style.display = 'inline-flex';
                hasAlerts = true;
            } else btnSO.style.display = 'none';
        }
        if (btnSL) {
            if (stockLowNames.length > 0) {
                document.getElementById('alertStockLowCount').textContent = stockLowNames.length;
                const tip = document.getElementById('alertStockLowTooltip');
                if (tip) tip.textContent = formatTooltipList(stockLowNames);
                btnSL.style.display = 'inline-flex';
                hasAlerts = true;
            } else btnSL.style.display = 'none';
        }

        banner.style.display = hasAlerts ? 'block' : 'none';
    } catch (e) {
        console.warn('[admin] refreshAdminAlerts :', e);
    }
}

/* ============================================================
   CHART REVENUS
   ============================================================ */
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
            const ordersSnap = await getDocs(query(collection(db, "orders"), limit(500)));
            orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        }

        const buckets = {};
        for (let i = 0; i < period; i++) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
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
            data: {
                labels,
                datasets: [{
                    label: 'CA (Livré)',
                    data: revenueData,
                    borderColor: '#a57b2e',
                    backgroundColor: 'rgba(165, 123, 46, 0.12)',
                    fill: true,
                    tension: 0.3
                }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    } catch (e) {
        console.error('[admin] renderRevenueChart :', e);
    }
}

/* ============================================================
   FINANCES - CHARGEMENT
   ============================================================ */
async function loadPurchases() {
    try {
        const snap = await getDocs(query(collection(db, "purchases"), orderBy("date", "desc"), limit(500)));
        cachedPurchases = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
    } catch (err) {
        try {
            const snap = await getDocs(query(collection(db, "purchases"), limit(500)));
            cachedPurchases = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
            cachedPurchases.sort((a, b) => safeDate(b.date) - safeDate(a.date));
        } catch (err2) {
            cachedPurchases = [];
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
            const snap = await getDocs(query(collection(db, "expenses"), limit(500)));
            cachedExpenses = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
            cachedExpenses.sort((a, b) => safeDate(b.date) - safeDate(a.date));
        } catch (err2) {
            cachedExpenses = [];
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
            const snap = await getDocs(query(collection(db, "transactions"), limit(500)));
            cachedTransactions = snap.docs.map(d => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }));
            cachedTransactions.sort((a, b) => safeDate(b.date) - safeDate(a.date));
        } catch (err2) {
            cachedTransactions = [];
        }
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

    kpis.innerHTML = '<div class="admin-loading">Calcul...</div>';
    waterfall.innerHTML = '<div class="admin-loading">Calcul...</div>';

    try {
        if (cachedProducts.length >= 500) {
            console.warn(
                '[admin] cachedProducts limité à 500 - les COGS peuvent être sous-estimés ' +
                'pour les produits > 500. Augmenter la limite de loadProducts si nécessaire.'
            );
        }

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
            const t = d.data();
            if (!isInRange(toDate(t.date), start, end)) return;
            if (t.type === 'income') extraIncome += Number(t.amount) || 0;
            else otherExpenses += Number(t.amount) || 0;
        });

        const grossProfit = revenue - cogs;
        const netProfit = grossProfit - shippingCost - adSpend - otherExpenses + extraIncome;
        const margin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

        kpis.innerHTML = `
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--success);">${formatMAD(revenue)}</span><span class="stat-label">Chiffre d'affaires</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(cogs)}</span><span class="stat-label">COGS</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(shippingCost)}</span><span class="stat-label">Frais livraison</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(adSpend)}</span><span class="stat-label">Publicité</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--danger);">${formatMAD(otherExpenses)}</span><span class="stat-label">Autres dépenses</span></div>
            <div class="admin-stat-card"><span class="stat-value" style="color:var(--info);">${formatMAD(extraIncome)}</span><span class="stat-label">Autres revenus</span></div>
            <div class="admin-stat-card" style="border-color:var(--gold);"><span class="stat-value" style="color:var(--gold);">${formatMAD(netProfit)}</span><span class="stat-label">Bénéfice NET</span></div>
            <div class="admin-stat-card"><span class="stat-value">${margin.toFixed(1)}%</span><span class="stat-label">Marge nette</span></div>
        `;

        waterfall.innerHTML = `<table class="acc-table" style="width:100%;">
            <tr><td>Chiffre d'affaires</td><td style="text-align:right;color:var(--success);font-weight:700;">${formatMAD(revenue)}</td></tr>
            <tr><td>COGS</td><td style="text-align:right;color:var(--danger);">-${formatMAD(cogs)}</td></tr>
            <tr style="font-weight:700;background:rgba(0,0,0,0.02);"><td>Marge Brute</td><td style="text-align:right;">${formatMAD(grossProfit)}</td></tr>
            <tr><td>Livraison</td><td style="text-align:right;color:var(--danger);">-${formatMAD(shippingCost)}</td></tr>
            <tr><td>Pub</td><td style="text-align:right;color:var(--danger);">-${formatMAD(adSpend)}</td></tr>
            <tr><td>Autres dép.</td><td style="text-align:right;color:var(--danger);">-${formatMAD(otherExpenses)}</td></tr>
            <tr><td>Autres rev.</td><td style="text-align:right;color:var(--info);">+${formatMAD(extraIncome)}</td></tr>
            <tr style="font-weight:800;background:var(--bg-surface);border-top:2px solid var(--gold);"><td>Bénéfice NET</td><td style="text-align:right;color:var(--gold);">${formatMAD(netProfit)}</td></tr>
        </table>`;

        await renderRevenueChart(currentChartPeriod, ordersSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
        console.error('[admin] refreshAccOverview :', e);
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

/* ============================================================
   ACHATS / DÉPENSES / TRANSACTIONS — CRUD
   ============================================================ */
async function saveNewPurchase() {
    const productId = document.getElementById('purProductId').value;
    const qty = parseInt(document.getElementById('purQty').value);
    const unitPrice = parseFloat(document.getElementById('purUnitPrice').value);
    const shippingCost = parseFloat(document.getElementById('purShippingCost').value) || 0;
    const supplier = document.getElementById('purSupplier').value.trim();
    const dateVal = document.getElementById('purDate').value;
    const note = document.getElementById('purNote').value.trim();

    if (!productId) { showToast('Sélectionnez un produit'); return; }
    if (!qty || qty < 1) { showToast('Quantité invalide'); return; }
    if (isNaN(unitPrice) || unitPrice < 0) { showToast('Prix invalide'); return; }
    if (!dateVal) { showToast('Date invalide'); return; }

    const btn = document.getElementById('addPurchaseBtn');
    btn.disabled = true;
    btn.textContent = '...';

    try {
        const totalCost = (qty * unitPrice) + shippingCost;
        const product = cachedProducts.find(p => p.id === productId);

        await addDoc(collection(db, "purchases"), {
            productId,
            productName: product?.nameFr || 'Inconnu',
            quantity: qty, unitPrice, shippingCost, totalCost, supplier,
            date: Timestamp.fromDate(new Date(dateVal)),
            note,
            createdAt: Timestamp.now()
        });

        if (product) {
            await updateDoc(doc(db, "products", productId), {
                stock: increment(qty),
                purchasePrice: unitPrice,
                updatedAt: Timestamp.now()
            });
        }

        showToast('Achat enregistré et stock mis à jour');
        document.getElementById('purQty').value = '';
        document.getElementById('purUnitPrice').value = '';
        document.getElementById('purShippingCost').value = '0';
        document.getElementById('purNote').value = '';

        await loadPurchases();
        await loadProducts(true);
        await renderPurchasesList();
    } catch (e) {
        console.error('[admin] saveNewPurchase :', e);
        showToast(e.message || 'Erreur');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enregistrer l\'achat';
    }
}

async function renderPurchasesList() {
    const container = document.getElementById('purchasesList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement...</div>`;

    await loadPurchases();
    if (cachedPurchases.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucun achat enregistré.</div>`;
        return;
    }

    let html = `<table class="acc-table"><thead><tr><th>Date</th><th>Produit</th><th>Qté</th><th>Prix Unit.</th><th>Livraison</th><th>Total</th><th>Fournisseur</th></tr></thead><tbody>`;
    cachedPurchases.forEach(p => {
        html += `<tr><td>${p.date ? p.date.toLocaleDateString('fr-FR') : '—'}</td><td><strong>${escapeHTML(p.productName)}</strong></td><td>${p.quantity}</td><td>${formatMAD(p.unitPrice)}</td><td>${formatMAD(p.shippingCost)}</td><td style="font-weight:700;color:var(--danger);">${formatMAD(p.totalCost)}</td><td>${escapeHTML(p.supplier || '—')}</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

async function saveNewExpense() {
    const category = document.getElementById('expCategory').value;
    const amount = parseFloat(document.getElementById('expAmount').value);
    const dateVal = document.getElementById('expDate').value;
    const description = document.getElementById('expDescription').value.trim();

    if (isNaN(amount) || amount <= 0) { showToast('Montant invalide'); return; }
    if (!dateVal) { showToast('Date invalide'); return; }
    if (!description) { showToast('Description requise'); return; }

    const btn = document.getElementById('addExpenseBtn');
    btn.disabled = true;
    btn.textContent = '...';

    try {
        await addDoc(collection(db, "expenses"), {
            category, amount, description,
            date: Timestamp.fromDate(new Date(dateVal)),
            createdAt: Timestamp.now()
        });
        showToast('Dépense enregistrée');
        document.getElementById('expAmount').value = '';
        document.getElementById('expDescription').value = '';
        await loadExpenses();
        await renderExpensesList();
    } catch (e) {
        console.error('[admin] saveNewExpense :', e);
        showToast(e.message || 'Erreur');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enregistrer la dépense';
    }
}

async function renderExpensesList() {
    const container = document.getElementById('expensesList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement...</div>`;

    await loadExpenses();
    if (cachedExpenses.length === 0) {
        container.innerHTML = `<div class="admin-empty">Aucune dépense enregistrée.</div>`;
        return;
    }

    let html = `<table class="acc-table"><thead><tr><th>Date</th><th>Catégorie</th><th>Description</th><th>Montant</th></tr></thead><tbody>`;
    cachedExpenses.forEach(e => {
        html += `<tr><td>${e.date ? e.date.toLocaleDateString('fr-FR') : '—'}</td><td>${escapeHTML(e.category)}</td><td>${escapeHTML(e.description)}</td><td style="font-weight:700;color:var(--danger);">${formatMAD(e.amount)}</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

async function saveNewTransaction() {
    const type = document.getElementById('transType').value;
    const amount = parseFloat(document.getElementById('transAmount').value);
    const dateVal = document.getElementById('transDate').value;
    const description = document.getElementById('transDescription').value.trim();

    if (isNaN(amount) || amount <= 0) { showToast('Montant invalide'); return; }
    if (!dateVal) { showToast('Date invalide'); return; }
    if (!description) { showToast('Description requise'); return; }

    const btn = document.getElementById('addTransactionBtn');
    btn.disabled = true;
    btn.textContent = '...';

    try {
        await addDoc(collection(db, "transactions"), {
            type, amount, description,
            date: Timestamp.fromDate(new Date(dateVal)),
            createdAt: Timestamp.now()
        });
        showToast('Transaction enregistrée');
        document.getElementById('transAmount').value = '';
        document.getElementById('transDescription').value = '';
        await loadTransactions();
        await renderTransactionsList();
    } catch (e) {
        console.error('[admin] saveNewTransaction :', e);
        showToast(e.message || 'Erreur');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enregistrer';
    }
}

async function renderTransactionsList() {
    const container = document.getElementById('transactionsList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement...</div>`;

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
        html += `<tr><td>${t.date ? t.date.toLocaleDateString('fr-FR') : '—'}</td><td><span style="color:${isIncome ? 'var(--success)' : 'var(--danger)'};font-weight:700;">${isIncome ? 'Revenu' : 'Dépense'}</span></td><td>${escapeHTML(t.description)}</td><td style="font-weight:700;color:${isIncome ? 'var(--success)' : 'var(--danger)'};">${isIncome ? '+' : '-'} ${formatMAD(t.amount)}</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}
/* ============================================================
   PARTIE 3/3 — Rapports, exports, simulateur, vendeurs,
                 payouts, tools, events, init finale, log final
   Version 12.2.0
   ============================================================ */

/* ============================================================
   RAPPORTS
   ============================================================ */
async function generateReport() {
    const startVal = document.getElementById('reportStart').value;
    const endVal = document.getElementById('reportEnd').value;
    const container = document.getElementById('reportContent');

    if (!startVal || !endVal) { showToast('Sélectionnez une période'); return; }
    if (!container) return;

    container.innerHTML = `<div class="admin-loading">Génération du rapport...</div>`;

    try {
        const start = new Date(startVal);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endVal);
        end.setHours(23, 59, 59, 999);

        const REPORT_LIMIT = 5000;
        const [ordersSnap, expensesSnap, purchasesSnap] = await Promise.all([
            getDocs(query(collection(db, "orders"), where("createdAt", ">=", Timestamp.fromDate(start)), where("createdAt", "<=", Timestamp.fromDate(end)), limit(REPORT_LIMIT))),
            getDocs(query(collection(db, "expenses"), where("date", ">=", Timestamp.fromDate(start)), where("date", "<=", Timestamp.fromDate(end)), limit(REPORT_LIMIT))),
            getDocs(query(collection(db, "purchases"), where("date", ">=", Timestamp.fromDate(start)), where("date", "<=", Timestamp.fromDate(end)), limit(REPORT_LIMIT)))
        ]);

        let revenue = 0, ordersCount = 0;
        ordersSnap.forEach(d => {
            const o = d.data();
            if (normalizeOrderStatus(o.status) === 'delivered') {
                revenue += Number(o.total) || 0;
                ordersCount++;
            }
        });

        let expenses = 0;
        expensesSnap.forEach(d => { expenses += Number(d.data().amount) || 0; });

        let purchases = 0;
        purchasesSnap.forEach(d => { purchases += Number(d.data().totalCost) || 0; });

        const net = revenue - expenses - purchases;
        const margin = revenue > 0 ? (net / revenue) * 100 : 0;

        container.innerHTML = `<div class="admin-form" style="margin-top:1rem;"><h3>Rapport du ${start.toLocaleDateString('fr-FR')} au ${end.toLocaleDateString('fr-FR')}</h3><table class="acc-table" style="margin-top:1rem;"><tr><td>Commandes livrées</td><td style="text-align:right;font-weight:700;">${ordersCount}</td></tr><tr><td>Chiffre d'affaires</td><td style="text-align:right;color:var(--success);font-weight:700;">${formatMAD(revenue)}</td></tr><tr><td>Dépenses</td><td style="text-align:right;color:var(--danger);">-${formatMAD(expenses)}</td></tr><tr><td>Achats</td><td style="text-align:right;color:var(--danger);">-${formatMAD(purchases)}</td></tr><tr style="font-weight:800;background:var(--bg-surface);border-top:2px solid var(--gold);"><td>Résultat NET</td><td style="text-align:right;color:${net >= 0 ? 'var(--success)' : 'var(--danger)'};">${formatMAD(net)}</td></tr><tr><td>Marge nette</td><td style="text-align:right;">${margin.toFixed(1)}%</td></tr></table></div>`;
    } catch (e) {
        console.error('[admin] generateReport :', e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">${e.message}</div>`;
    }
}

/* ============================================================
   EXPORTS CSV
   ============================================================ */
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
    if (!table) { showToast('Générez d\'abord un rapport'); return; }
    let csv = "";
    table.querySelectorAll('tr').forEach(row => {
        const cols = Array.from(row.querySelectorAll('td, th')).map(c => `"${c.innerText.replace(/"/g, '""')}"`).join(',');
        csv += cols + "\n";
    });
    downloadCSV(csv, `rapport_${new Date().toISOString().split('T')[0]}.csv`);
    showToast('Export CSV généré');
}

async function exportOrdersCSV() {
    try {
        showToast('Chargement des commandes...');
        const snap = await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(5000)));
        let csv = "ID,Date,Nom,Telephone,Ville,Adresse,Statut,Total\n";
        snap.forEach(d => {
            const o = d.data();
            const date = toDate(o.createdAt)?.toLocaleDateString('fr-FR') || '';
            const addr = o.deliveryAddress || {};
            csv += `"${d.id.slice(0,8).toUpperCase()}","${date}","${addr.name||''}","${addr.phone||''}","${addr.city||''}","${addr.address||''}","${o.status}","${o.total}"\n`;
        });
        downloadCSV(csv, `commandes_${new Date().toISOString().split('T')[0]}.csv`);
        showToast('Export CSV généré');
    } catch (e) {
        console.error('[admin] exportOrdersCSV :', e);
        showToast(e.message || 'Erreur');
    }
}

async function exportProductsCSV() {
    try {
        showToast('Chargement...');
        const snap = await getDocs(query(collection(db, "products"), limit(5000)));
        let csv = "Nom,SKU,Slug,Categorie,Prix,Base_Price,Cout_Achat,Stock\n";
        snap.forEach(d => {
            const p = d.data();
            csv += `"${p.nameFr||''}","${p.sku||''}","${p.slug||''}","${p.category||''}","${p.price||0}","${p.basePrice||p.price||0}","${p.purchasePrice||0}","${p.stock||0}"\n`;
        });
        downloadCSV(csv, `inventaire_${new Date().toISOString().split('T')[0]}.csv`);
        showToast('Export CSV généré');
    } catch (e) {
        console.error('[admin] exportProductsCSV :', e);
        showToast(e.message || 'Erreur');
    }
}

/* ============================================================
   SIMULATEUR
   ============================================================ */
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
        html += `<label style="display:flex;align-items:center;gap:0.6rem;padding:0.5rem;border-bottom:1px solid var(--border);cursor:pointer;"><input type="checkbox" class="fin-product-checkbox" value="${p.id}" data-buy="${buyPrice}" data-sale="${salePrice}" data-stock="${stock}" style="width:auto;margin:0;"><div style="flex:1;"><strong style="font-size:0.85rem;color:var(--text);">${escapeHTML(name)}</strong><div style="font-size:0.75rem;color:var(--text-muted);">Achat: ${buyPrice} MAD · Vente: ${salePrice} MAD · Stock: ${stock}</div></div></label>`;
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
    if (selected.length === 0) { showToast('Sélectionnez au moins un produit'); return; }

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
    if (netProfit < 0) recHtml = `<div style="background:var(--danger-bg);border:1px solid var(--danger);padding:1rem;border-radius:var(--radius-sm);color:var(--danger);margin-bottom:1rem;"><strong>Attention :</strong> Votre budget pub dépasse votre profit brut.</div>`;
    else if (globalRoi < 50) recHtml = `<div style="background:var(--warning-bg);border:1px solid var(--warning);padding:1rem;border-radius:var(--radius-sm);color:var(--warning);margin-bottom:1rem;"><strong>Conseil :</strong> ROI de ${globalRoi.toFixed(1)}%. Objectif : 100%+</div>`;
    else recHtml = `<div style="background:var(--success-bg);border:1px solid var(--success);padding:1rem;border-radius:var(--radius-sm);color:var(--success);margin-bottom:1rem;"><strong>Excellente rentabilité :</strong> ROI de ${globalRoi.toFixed(1)}%.</div>`;
    document.getElementById('finRecommendations').innerHTML = recHtml;

    const tbody = document.getElementById('financesTableBody');
    let rows = '';
    results.forEach(r => {
        const p = cachedProducts.find(pp => pp.id === r.id);
        const name = p ? (p.nameFr || p.nameEn) : 'Inconnu';
        const verdict = r.marginNetUnit > 0 ? 'Rentable' : 'Non rentable';
        rows += `<tr><td>${escapeHTML(name)}</td><td style="text-align:center;">${r.buy} MAD</td><td style="text-align:center;">${r.sale + 5} MAD</td><td style="text-align:center;font-weight:700;color:${r.marginNetUnit>0?'var(--success)':'var(--danger)'};">${r.marginNetUnit.toFixed(2)} MAD</td><td style="text-align:center;">${r.cpaMax.toFixed(2)} MAD</td><td style="text-align:center;">${r.stock}</td><td style="text-align:center;font-weight:700;">${r.profitTotal.toFixed(2)} MAD</td><td style="text-align:center;">${r.roi.toFixed(1)}%</td><td style="text-align:center;">${verdict}</td></tr>`;
    });
    tbody.innerHTML = rows;
}

/* ============================================================
   VENDEURS (marketplace)
   ============================================================ */
async function loadVendors() {
    const container = document.getElementById('adminVendorsList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement des vendeurs...</div>`;

    try {
        const q = query(collection(db, "users"), where("role", "==", "vendor"), limit(500));
        const snap = await getDocs(q);
        cachedVendors = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        cachedVendors.sort((a, b) => {
            const sa = a.vendorInfo?.status || 'pending';
            const sb = b.vendorInfo?.status || 'pending';
            const oa = VENDOR_STATUS_ORDER[sa] ?? 99;
            const ob = VENDOR_STATUS_ORDER[sb] ?? 99;
            if (oa !== ob) return oa - ob;
            return (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0);
        });
        renderVendorsList(cachedVendors);
    } catch (e) {
        console.error('[admin] loadVendors :', e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur de chargement.</div>`;
    }
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
        const shippingMethod = v.vendorInfo?.shippingMethod === 'dropoff' ? 'Drop-off' : 'Fulfillment';
        const createdAt = toDate(v.createdAt)?.toLocaleDateString('fr-FR') || '—';
        const contractStatus = v.vendorInfo?.contractStatus || 'pending';
        const contractAccepted = contractStatus === 'accepted';
        const delayCount = Number(v.vendorInfo?.delayCount) || 0;

        let statusBadge = '';
        if (status === 'pending') statusBadge = `<span style="background:var(--warning-bg);color:var(--warning);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">En attente</span>`;
        else if (status === 'approved') statusBadge = `<span style="background:var(--success-bg);color:var(--success);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">Approuvé</span>`;
        else if (status === 'rejected') statusBadge = `<span style="background:var(--danger-bg);color:var(--danger);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">Rejeté</span>`;
        else if (status === 'suspended') statusBadge = `<span style="background:var(--danger-bg);color:var(--danger);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">Suspendu</span>`;

        const contractBadge = contractAccepted
            ? `<span style="background:var(--success-bg);color:var(--success);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.7rem;font-weight:700;">Contrat signé</span>`
            : `<span style="background:var(--warning-bg);color:var(--warning);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.7rem;font-weight:700;">Non signé</span>`;

        const delayBadge = delayCount > 0
            ? `<span style="background:var(--danger);color:#fff;padding:0.2rem 0.6rem;border-radius:30px;font-size:0.7rem;font-weight:700;">${delayCount} retard${delayCount > 1 ? 's' : ''}</span>`
            : '';

        let actionsHtml = '';
        if (status === 'pending') {
            const approveDisabled = contractAccepted ? '' : 'disabled title="Contrat non signé"';
            const approveStyle = contractAccepted ? '' : 'opacity:0.5;cursor:not-allowed;';
            actionsHtml = `
                <button class="admin-btn-approve" data-action="vendor-approve" data-id="${v.id}" ${approveDisabled} style="${approveStyle}">Approuver</button>
                <button class="admin-btn-icon admin-btn-danger" data-action="vendor-reject" data-id="${v.id}">Rejeter</button>
            `;
        } else if (status === 'approved') {
            actionsHtml = `<button class="admin-btn-icon admin-btn-danger" data-action="vendor-suspend" data-id="${v.id}">Suspendre</button>`;
        } else {
            const approveDisabled = contractAccepted ? '' : 'disabled';
            const approveStyle = contractAccepted ? '' : 'opacity:0.5;cursor:not-allowed;';
            actionsHtml = `<button class="admin-btn-approve" data-action="vendor-approve" data-id="${v.id}" ${approveDisabled} style="${approveStyle}">Réactiver</button>`;
        }

        html += `
            <div class="admin-list-item" style="flex-direction:column;align-items:stretch;padding:1rem;">
                <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.5rem;">
                    <div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;">
                        <strong style="color:var(--gold);font-size:1rem;">${shopName}</strong>
                        ${statusBadge}${contractBadge}${delayBadge}
                    </div>
                    <div style="font-size:0.8rem;color:var(--text-dim);">Inscrit le ${createdAt}</div>
                </div>
                <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.3rem;">
                    ${email} · ${phone} · ${city} · ${iceCin}<br>
                    Mode : <strong>${shippingMethod}</strong>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:0.5rem;flex-wrap:wrap;margin-top:0.5rem;">
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
    container.querySelectorAll('[data-action="vendor-reject"]').forEach(btn => {
        btn.addEventListener('click', () => handleVendorAction(btn.dataset.id, VENDOR_STATUS.REJECTED));
    });
    container.querySelectorAll('[data-action="vendor-suspend"]').forEach(btn => {
        btn.addEventListener('click', () => handleVendorAction(btn.dataset.id, VENDOR_STATUS.SUSPENDED));
    });
}

async function handleVendorAction(vendorId, newStatus) {
    const labels = { approved: 'approuver', rejected: 'rejeter', suspended: 'suspendre' };
    const confirmed = await confirmAction(`Voulez-vous vraiment ${labels[newStatus]} ce vendeur ?`, {
        title: 'Confirmation',
        confirmText: 'Oui',
        cancelText: 'Annuler',
        variant: newStatus === 'approved' ? 'primary' : 'danger'
    });
    if (!confirmed) return;

    try {
        const vendorDoc = await getDoc(doc(db, 'users', vendorId));
        if (!vendorDoc.exists()) throw new Error('Utilisateur vendeur introuvable.');
        const vendorData = vendorDoc.data();

        if (newStatus === VENDOR_STATUS.APPROVED) {
            if ((vendorData.vendorInfo?.contractStatus || 'pending') !== 'accepted') {
                throw new Error('Contrat non signé. Approbation refusée.');
            }
        }

        await runTransaction(db, async (tx) => {
            const userRef = doc(db, 'users', vendorId);
            const userSnap = await tx.get(userRef);
            if (!userSnap.exists()) throw new Error('Utilisateur vendeur introuvable.');

            const data = userSnap.data();
            const vendorInfo = data.vendorInfo || {};

            const userUpdate = {
                'vendorInfo.status': newStatus,
                'vendorInfo.updatedAt': serverTimestamp()
            };
            if (newStatus === VENDOR_STATUS.APPROVED) {
                userUpdate['vendorInfo.contractStatus'] = CONTRACT_STATUS.ACCEPTED;
                if (vendorInfo.currentContractId) {
                    userUpdate['vendorInfo.currentContractId'] = vendorInfo.currentContractId;
                }
            }
            tx.update(userRef, userUpdate);

            const publicRef = doc(db, 'vendorsPublic', vendorId);
            const shopName = vendorInfo.shopName || data.name || 'Boutique';
            const city = vendorInfo.city || '';
            tx.set(publicRef, {
                vendorId: vendorId,
                shopName: String(shopName).slice(0, 60),
                status: newStatus,
                city: String(city).slice(0, 80),
                updatedAt: serverTimestamp()
            }, { merge: true });
        });

        const notifMessages = {
            approved: { title: 'Compte vendeur approuvé', msg: 'Votre compte vendeur a été approuvé. Vous pouvez publier vos produits.' },
            rejected: { title: 'Inscription refusée', msg: 'Votre inscription a été refusée. Contactez le support.' },
            suspended: { title: 'Compte suspendu', msg: 'Votre compte a été suspendu. Contactez le support.' }
        };
        const n = notifMessages[newStatus];
        if (n) {
            try {
                await addDoc(collection(db, 'notifications'), {
                    userId: vendorId,
                    type: 'vendor_' + newStatus,
                    title: n.title,
                    message: n.msg,
                    read: false,
                    createdAt: Timestamp.now()
                });
            } catch (e) { /* non bloquant */ }
        }

        const verb = newStatus === VENDOR_STATUS.APPROVED ? 'approuvé'
            : newStatus === VENDOR_STATUS.REJECTED ? 'rejeté' : 'suspendu';
        showToast('Vendeur ' + verb);
        await loadVendors();
    } catch (e) {
        console.error('[admin] handleVendorAction :', e);
        showToast(e.message || 'Erreur');
    }
}

/* ============================================================
   RETRAITS / PAYOUTS
   ============================================================ */
async function loadPayouts() {
    const container = document.getElementById('payoutsList');
    if (!container) return;
    container.innerHTML = `<div class="admin-loading">Chargement des demandes...</div>`;

    try {
        const q = query(collection(db, "payout_requests"), orderBy("requestedAt", "desc"), limit(200));
        const snap = await getDocs(q);
        cachedPayouts = snap.docs.map(d => ({
            id: d.id,
            ...d.data(),
            requestedAt: toDate(d.data().requestedAt)
        }));
        cachedPayouts.sort((a, b) => (b.requestedAt?.getTime() || 0) - (a.requestedAt?.getTime() || 0));
        renderPayoutsList(cachedPayouts);
    } catch (e) {
        console.error('[admin] loadPayouts :', e);
        container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur de chargement.</div>`;
    }
}

function renderPayoutsList(payouts) {
    const container = document.getElementById('payoutsList');
    if (!container) return;

    const releaseBanner = `
        <div style="background:rgba(46,204,113,0.08);border:1px solid var(--success);border-radius:var(--radius-sm);padding:0.8rem 1rem;margin-bottom:1rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">
            <div style="font-size:0.85rem;"><strong>Fonds échus</strong> : débloque les gains dont la période d'attente (7j vendeur / 15j Smart) est terminée.</div>
            <button id="releaseDueFundsBtn" class="admin-btn-primary" style="padding:0.4rem 1rem;font-size:0.8rem;white-space:nowrap;">Débloquer les fonds échus</button>
        </div>
    `;

    if (payouts.length === 0) {
        container.innerHTML = releaseBanner + `<div class="admin-empty">Aucune demande de retrait.</div>`;
        attachReleaseDueFundsListener();
        return;
    }

    let html = releaseBanner;
    payouts.forEach(p => {
        const vendorName = p.vendorName ? escapeHTML(p.vendorName) : (p.vendorId ? `Vendeur ${String(p.vendorId).slice(0, 8)}...` : 'Inconnu');
        const amount = Number(p.amount) || 0;
        const method = escapeHTML(p.method || 'Wafacash');
        const account = escapeHTML(p.account || p.phone || '');
        const status = p.status || 'pending';
        const date = p.requestedAt ? p.requestedAt.toLocaleDateString('fr-FR') : '—';

        let statusBadge = '';
        if (status === 'pending') statusBadge = `<span style="background:var(--warning-bg);color:var(--warning);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">En attente</span>`;
        else if (status === 'paid') statusBadge = `<span style="background:var(--success-bg);color:var(--success);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">Payé</span>`;
        else if (status === 'rejected') statusBadge = `<span style="background:var(--danger-bg);color:var(--danger);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">Rejeté</span>`;
        else if (status === 'cancelled') statusBadge = `<span style="background:var(--bg-surface);color:var(--text-muted);padding:0.2rem 0.6rem;border-radius:30px;font-size:0.75rem;font-weight:700;">Annulé</span>`;

        let actionsHtml = '';
        if (status === 'pending') {
            actionsHtml = `
                <button class="admin-btn-approve" data-action="payout-pay" data-id="${p.id}">Marquer payé</button>
                <button class="admin-btn-icon admin-btn-danger" data-action="payout-reject" data-id="${p.id}">Rejeter</button>
            `;
        }

        html += `
            <div class="admin-list-item" style="flex-direction:column;align-items:stretch;padding:1rem;">
                <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.5rem;">
                    <div><strong style="color:var(--gold);font-size:1rem;">${formatMAD(amount)}</strong><span style="margin-left:0.5rem;">${statusBadge}</span></div>
                    <div style="font-size:0.8rem;color:var(--text-dim);">Demandé le ${date}</div>
                </div>
                <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem;">
                    <strong>${vendorName}</strong> · <code>${account}</code> · ${method}
                </div>
                <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:0.5rem;">${actionsHtml}</div>
            </div>
        `;
    });
    container.innerHTML = html;

    container.querySelectorAll('[data-action="payout-pay"]').forEach(btn => {
        btn.addEventListener('click', () => handlePayoutPaid(btn.dataset.id));
    });
    container.querySelectorAll('[data-action="payout-reject"]').forEach(btn => {
        btn.addEventListener('click', () => handlePayoutReject(btn.dataset.id));
    });
    attachReleaseDueFundsListener();
}

function attachReleaseDueFundsListener() {
    const btn = document.getElementById('releaseDueFundsBtn');
    if (!btn || btn._listenerAttached) return;
    btn._listenerAttached = true;
    btn.addEventListener('click', handleReleaseDueFunds);
}

async function handleReleaseDueFunds() {
    const btn = document.getElementById('releaseDueFundsBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Déblocage...'; }

    try {
        if (typeof releaseDueVendorFunds !== 'function') {
            throw new Error('Fonction releaseDueVendorFunds introuvable.');
        }
        const result = await releaseDueVendorFunds({ batchSize: 400, dryRun: false });

        if (result.errors && result.errors.length > 0) {
            showToast(`${result.transactionsReleased} débloquées, ${result.errors.length} erreur(s). Voir console.`, 6000);
        } else if (result.transactionsReleased === 0) {
            showToast('Aucun fond à débloquer pour le moment.');
        } else {
            showToast(`${result.transactionsReleased} tx débloquée(s) · ${result.vendorsProcessed} vendeur(s) · ${formatMAD(result.totalReleased)}`, 5000);
        }
        await loadPayouts();
    } catch (e) {
        console.error('[admin] handleReleaseDueFunds :', e);
        showToast(e.message || 'Erreur');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Débloquer les fonds échus';
            btn._listenerAttached = true;
        }
    }
}

async function handlePayoutPaid(payoutId) {
    const confirmed = await confirmAction('Confirmez-vous avoir effectué ce virement ?', {
        title: 'Confirmer le virement',
        confirmText: 'Oui, payé',
        cancelText: 'Annuler',
        variant: 'primary'
    });
    if (!confirmed) return;

    let paidVendorId = null;
    let paidAmount = 0;

    try {
        await runTransaction(db, async (transaction) => {
            const payoutRef = doc(db, 'payout_requests', payoutId);
            const payoutSnap = await transaction.get(payoutRef);
            if (!payoutSnap.exists()) throw new Error('Demande introuvable');

            const payoutData = payoutSnap.data();
            if (payoutData.status !== 'pending') throw new Error('Statut inattendu : ' + payoutData.status);

            const amount = Number(payoutData.amount) || 0;
            const vendorId = payoutData.vendorId;
            if (!vendorId || amount <= 0) throw new Error('Données de retrait invalides');

            paidVendorId = vendorId;
            paidAmount = amount;

            const walletRef = doc(db, 'wallets', vendorId);
            const walletSnap = await transaction.get(walletRef);
            if (!walletSnap.exists()) throw new Error('Wallet introuvable');

            const wallet = walletSnap.data();
            if (Number(wallet.availableBalance) < amount) {
                throw new Error('Solde insuffisant : disponible ' + formatMAD(wallet.availableBalance) + ', demandé ' + formatMAD(amount) + '.');
            }

            transaction.update(walletRef, {
                availableBalance: increment(-amount),
                totalWithdrawn: increment(amount),
                lastUpdated: Timestamp.now()
            });
            transaction.update(payoutRef, {
                status: 'paid',
                paidAt: Timestamp.now(),
                paidBy: currentAdmin?.uid || 'admin'
            });

            const txRef = doc(collection(db, 'wallet_transactions'));
            transaction.set(txRef, {
                vendorId: vendorId,
                type: 'payout',
                amount: -amount,
                status: 'released',
                payoutRequestId: payoutId,
                description: 'Retrait payé (admin) - ' + (payoutData.method || 'Wafacash'),
                createdAt: Timestamp.now(),
                releasedAt: Timestamp.now()
            });
        });

        if (paidVendorId) {
            try {
                await addDoc(collection(db, 'notifications'), {
                    userId: paidVendorId,
                    type: 'payout_paid',
                    title: 'Retrait payé',
                    message: 'Votre retrait de ' + formatMAD(paidAmount) + ' a été payé.',
                    read: false,
                    createdAt: Timestamp.now(),
                    payoutId: payoutId
                });
            } catch (e) { /* non bloquant */ }
        }

        showToast('Retrait marqué comme payé !');
        await loadPayouts();
    } catch (e) {
        console.error('[admin] handlePayoutPaid :', e);
        showToast(e.message || 'Erreur');
    }
}

async function handlePayoutReject(payoutId) {
    const confirmed = await confirmAction('Rejeter cette demande de retrait ?', {
        title: 'Rejeter',
        confirmText: 'Rejeter',
        cancelText: 'Annuler',
        variant: 'danger'
    });
    if (!confirmed) return;

    try {
        const payoutRef = doc(db, 'payout_requests', payoutId);
        const payoutSnap = await getDoc(payoutRef);
        if (!payoutSnap.exists()) { showToast('Demande introuvable'); return; }

        const payoutData = payoutSnap.data();
        await updateDoc(payoutRef, {
            status: 'rejected',
            rejectedAt: Timestamp.now(),
            rejectedBy: currentAdmin?.uid || 'admin'
        });

        if (payoutData.vendorId) {
            try {
                await addDoc(collection(db, 'notifications'), {
                    userId: payoutData.vendorId,
                    type: 'payout_rejected',
                    title: 'Retrait rejeté',
                    message: 'Votre demande de retrait de ' + formatMAD(payoutData.amount) + ' a été rejetée.',
                    read: false,
                    createdAt: Timestamp.now(),
                    payoutId: payoutId
                });
            } catch (e) { /* non bloquant */ }
        }
        showToast('Demande rejetée');
        await loadPayouts();
    } catch (e) {
        console.error('[admin] handlePayoutReject :', e);
        showToast('Erreur : ' + (e.message || 'inconnue'));
    }
}

/* ============================================================
   OUTILS - MIGRATIONS
   ============================================================ */
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
    if (btn) btn.disabled = true;
    if (!auth.currentUser) { log('Login requis', true); if (btn) btn.disabled = false; return; }

    let cities;
    try {
        const res = await fetch('/villes.json');
        cities = await res.json();
        log(`${cities.length} villes chargées`);
    } catch (e) {
        log(e.message, true);
        if (btn) btn.disabled = false;
        return;
    }

    const existingSnap = await getDocs(collection(db, "cities"));
    if (!existingSnap.empty) {
        const confirmed = await confirmAction(
            `La collection "cities" contient ${existingSnap.size} documents. Ils seront SUPPRIMÉS et remplacés. Continuer ?`,
            { title: 'Migration villes', confirmText: 'Remplacer', cancelText: 'Annuler', variant: 'danger' }
        );
        if (!confirmed) { if (btn) btn.disabled = false; return; }
        log('Suppression des anciennes villes...');
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
            log(`${processed}/${cities.length}`);
        } catch (e) {
            log(`batch ${i} : ${e.message}`, true);
            if (btn) btn.disabled = false;
            return;
        }
    }

    log(`Migration OK - ${cities.length} villes`);
    if (btn) { btn.disabled = false; btn.textContent = 'Terminé'; }
    loadCollectionsStatus();
    loadStats();
    showToast('Villes migrées');
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
    if (btn) btn.disabled = true;
    if (!auth.currentUser) { log('Login requis', true); if (btn) btn.disabled = false; return; }

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
                log(`${p.nameFr || docSnap.id} : ${oldCat} -> ${newCat}`);
                if (batchCount === 400) {
                    await batch.commit();
                    log(`Lot de 400 produits sauvegardé...`);
                    batchCount = 0;
                    batch = writeBatch(db);
                }
            }
        }
        if (batchCount > 0) await batch.commit();

        if (updatedCount === 0) log(`Aucun produit à migrer.`);
        else {
            log(`Migration terminée ! ${updatedCount} produit(s) mis à jour.`);
            showToast(`${updatedCount} produits migrés`);
        }
    } catch (e) {
        log(`Erreur : ${e.message}`, true);
    } finally {
        if (btn) btn.disabled = false;
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
    if (btn) btn.disabled = true;
    log('Recherche des produits sans SKU...');

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
                log(`${p.nameFr || docSnap.id} -> ${newSku}`);
                if (batchCount === 400) {
                    await batch.commit();
                    batchCount = 0;
                    batch = writeBatch(db);
                }
            }
        }
        if (batchCount > 0) await batch.commit();

        if (updatedCount === 0) log(`Tous les produits ont déjà un SKU.`);
        else {
            log(`${updatedCount} produit(s) mis à jour.`);
            showToast(`${updatedCount} SKU générés`);
            await loadProducts(true);
        }
    } catch (e) {
        log(`Erreur : ${e.message}`, true);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function handleMigrateProductStatus() {
    const btn = document.getElementById('migrateProductsStatusBtn');
    const logEl = document.getElementById('productStatusMigrationLog');

    if (!btn) {
        showToast('Bouton "Migration statut Produits" absent du HTML');
        return;
    }

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
    log('Analyse des produits...');

    try {
        const snap = await getDocs(collection(db, "products"));
        let updatedCount = 0;
        let skippedVendorCount = 0;
        let alreadyHadStatusCount = 0;
        let batch = writeBatch(db);
        let batchCount = 0;

        for (const docSnap of snap.docs) {
            const p = docSnap.data();

            const isVendor = p.vendorId && p.vendorId !== 'smartswi9a';
            if (isVendor) {
                skippedVendorCount++;
                continue;
            }

            if (p.status) {
                alreadyHadStatusCount++;
                continue;
            }

            batch.update(docSnap.ref, { status: 'approved' });
            updatedCount++;
            batchCount++;
            log(`OK ${p.nameFr || docSnap.id} -> approuvé (Smart)`);

            if (batchCount === 400) {
                await batch.commit();
                log(`Lot de 400 produits sauvegardé...`);
                batchCount = 0;
                batch = writeBatch(db);
            }
        }

        if (batchCount > 0) await batch.commit();

        log(`--- Résumé ---`);
        log(`Produits Smart migrés : ${updatedCount}`);
        log(`Produits déjà avec status (ignorés) : ${alreadyHadStatusCount}`);
        log(`Produits vendeurs (ignorés - status manuel) : ${skippedVendorCount}`);

        if (updatedCount === 0 && skippedVendorCount === 0 && alreadyHadStatusCount === 0) {
            log(`Aucun produit à migrer.`);
        } else {
            log(`Migration terminée !`);
            showToast(`${updatedCount} produit(s) Smart approuvés (${skippedVendorCount} vendeurs ignorés)`);
            await loadProducts(true);
        }
    } catch (e) {
        log(`Erreur : ${e.message}`, true);
    } finally {
        btn.disabled = false;
    }
}

async function loadCollectionsStatus() {
    const cols = ['products', 'orders', 'users', 'reviews', 'cities', 'blog', 'coupons'];
    const ids = {
        products: 'countProducts',
        orders: 'countOrders',
        users: 'countUsers',
        reviews: 'countReviews',
        cities: 'countCities',
        blog: 'countBlog',
        coupons: 'countCoupons'
    };

    for (const col of cols) {
        const el = document.getElementById(ids[col]);
        if (el) el.textContent = '...';
    }
    for (const col of cols) {
        const el = document.getElementById(ids[col]);
        if (!el) continue;
        try {
            const snap = await getCountFromServer(collection(db, col));
            el.textContent = `${snap.data().count}`;
            el.style.color = snap.data().count > 0 ? 'var(--success)' : 'var(--text-muted)';
        } catch (e) {
            el.textContent = 'X';
            el.style.color = 'var(--danger)';
        }
    }
}

/* ============================================================
   ÉVÉNEMENTS FINAUX
   ============================================================ */
function attachAllRemainingEvents() {
    attachProductFormEvents();

    document.getElementById('productSearchAdmin')?.addEventListener('input', () => {
        tempStockFilter = null;
        productsCurrentPage = 1;
        filterProductsList();
    });
    document.getElementById('productCategoryFilter')?.addEventListener('change', () => {
        tempStockFilter = null;
        productsCurrentPage = 1;
        filterProductsList();
    });

    document.getElementById('userSearchAdmin')?.addEventListener('input', filterUsersList);
    document.querySelectorAll('[data-signup-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-signup-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filterUsersList();
        });
    });

    document.getElementById('vendorSearchAdmin')?.addEventListener('input', () => {
        const s = (document.getElementById('vendorSearchAdmin')?.value || '').toLowerCase();
        renderVendorsList(cachedVendors.filter(v =>
            (v.vendorInfo?.shopName || v.name || '').toLowerCase().includes(s) ||
            (v.email || '').toLowerCase().includes(s)
        ));
    });
    document.querySelectorAll('[data-vendor-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-vendor-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const f = btn.dataset.vendorFilter;
            renderVendorsList(f === 'all' ? cachedVendors : cachedVendors.filter(v => (v.vendorInfo?.status || 'pending') === f));
        });
    });

    document.getElementById('payoutSearchAdmin')?.addEventListener('input', () => {
        const s = (document.getElementById('payoutSearchAdmin')?.value || '').toLowerCase();
        renderPayoutsList(cachedPayouts.filter(p =>
            (p.vendorName || '').toLowerCase().includes(s) ||
            (p.account || p.phone || '').toLowerCase().includes(s)
        ));
    });
    document.querySelectorAll('[data-payout-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-payout-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const f = btn.dataset.payoutFilter;
            renderPayoutsList(f === 'all' ? cachedPayouts : cachedPayouts.filter(p => (p.status || 'pending') === f));
        });
    });

    document.getElementById('blogSearchAdmin')?.addEventListener('input', () => {
        blogCurrentPage = 1;
        filterBlogList();
    });

    document.getElementById('couponSearchAdmin')?.addEventListener('input', filterCouponsList);

    const livoSearchEl = _getId('livoSearchAdmin', 'speedafSearchAdmin');
    if (livoSearchEl) livoSearchEl.addEventListener('input', renderLivoList);
    const livoFilterEl = _getId('livoStatusFilter', 'speedafStatusFilter');
    if (livoFilterEl) livoFilterEl.addEventListener('change', renderLivoList);
    const syncAllBtn = _getId('syncAllLivoBtn', 'syncAllSpeedafBtn');
    if (syncAllBtn) syncAllBtn.addEventListener('click', handleSyncAllLivo);

    const pickupBtn = _getId('pickupLivoBtn', 'pickupSpeedafBtn');
    if (pickupBtn) {
        pickupBtn.addEventListener('click', () => {
            const pickupDateEl = _getId('pickupDate');
            if (pickupDateEl) pickupDateEl.valueAsDate = new Date();
            _getId('pickupModal')?.classList.add('open');
        });
    }
    const closePickupBtn = _getId('closePickupModalBtn');
    if (closePickupBtn) {
        closePickupBtn.addEventListener('click', () => _getId('pickupModal')?.classList.remove('open'));
    }
    const confirmPickupBtn = _getId('confirmPickupBtn');
    if (confirmPickupBtn) confirmPickupBtn.addEventListener('click', handleConfirmPickup);

    document.getElementById('migrateCitiesBtn')?.addEventListener('click', handleMigrateCities);
    document.getElementById('migrateLegacyCategoriesBtn')?.addEventListener('click', handleMigrateLegacyCategories);
    document.getElementById('migrateSkuBtn')?.addEventListener('click', handleMigrateSku);
    document.getElementById('migrateProductsStatusBtn')?.addEventListener('click', handleMigrateProductStatus);
    document.getElementById('refreshCollectionsBtn')?.addEventListener('click', loadCollectionsStatus);

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

    attachBlogFormEvents();
    attachCouponFormEvents();
}

/* ============================================================
   DÉMARRAGE
   ============================================================ */
initAdmin();

/* ============================================================
   LOG FINAL
   ============================================================ */
console.log('[admin] v12.2.0 chargé (Approbation rapide produits + fix upgrade)');