// js/ui-core.js
// ============================================================
// UI CORE - SMART SWI9A
// Version 1.1.0 — Toast, focus trap, modales, confirmAction
// ============================================================
// Module "bas niveau" SANS dépendances métier.
// Rôle : casser les cycles d'imports entre ui.js / cart.js / auth.js / orders.js
// Fournit : toast, focus trap, modales, confirmAction.
// ============================================================

// ============================================================
// TOAST
// ============================================================
let toastTimeout = null;

export function showToast(msg, duration = 2500) {
    const toast = document.getElementById('cartToast');
    if (!toast) {
        console.warn('⚠️ Élément #cartToast introuvable');
        return;
    }
    toast.textContent = msg;
    toast.classList.add('show');

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
        toastTimeout = null;
    }, duration);
}

// ============================================================
// FOCUS TRAP (accessibilité modales)
// ============================================================
let focusTrapListener = null;
let focusTrapElement = null;

export function trapFocus(modalElement) {
    if (!modalElement) return;
    releaseFocusTrap();

    const focusable = modalElement.querySelectorAll(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    const listener = (e) => {
        if (e.key === 'Tab') {
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    };

    modalElement.addEventListener('keydown', listener);
    focusTrapListener = listener;
    focusTrapElement = modalElement;

    setTimeout(() => {
        try { first.focus(); } catch (e) { /* ignore */ }
    }, 100);
}

export function releaseFocusTrap() {
    if (focusTrapListener && focusTrapElement) {
        focusTrapElement.removeEventListener('keydown', focusTrapListener);
        focusTrapListener = null;
        focusTrapElement = null;
    }
}

// ============================================================
// HELPERS MODALES (ouverture / fermeture générique)
// ============================================================
export function openModal(modalElement, options = {}) {
    if (!modalElement) return;
    modalElement.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (options.trapFocus !== false) {
        trapFocus(modalElement);
    }
}

export function closeModal(modalElement) {
    if (!modalElement) return;
    modalElement.classList.remove('open');
    document.body.style.overflow = '';
    releaseFocusTrap();
}

// ============================================================
// CONFIRMATION PERSONNALISÉE (modal custom premium)
// ============================================================
// Remplace window.confirm() par un modal cohérent avec le design.
// ⚠️ ASYNC — utiliser avec await : if (await confirmAction('...')) { ... }
// ============================================================
let activeConfirmModal = null;

export function confirmAction(message, options = {}) {
    // Si un modal de confirmation est déjà ouvert, on le ferme
    if (activeConfirmModal) {
        try { activeConfirmModal.remove(); } catch (e) { /* ignore */ }
        activeConfirmModal = null;
        releaseFocusTrap();
    }

    const {
        title = '⚠️ Confirmation',
        confirmText = 'Confirmer',
        cancelText = 'Annuler',
        variant = 'danger' // 'danger' | 'primary' | 'info'
    } = options;

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay open';
        overlay.style.zIndex = '20000';
        overlay.setAttribute('role', 'alertdialog');
        overlay.setAttribute('aria-modal', 'true');

        const confirmBg = {
            danger: 'linear-gradient(135deg, var(--danger), #7d241a)',
            primary: 'linear-gradient(135deg, var(--gold), #7d5a1d)',
            info: 'linear-gradient(135deg, var(--info), #2874a6)'
        }[variant] || 'linear-gradient(135deg, var(--danger), #7d241a)';

        const confirmColor = '#ffffff';

        overlay.innerHTML = `
            <div class="modal" style="max-width:420px;text-align:center;padding:1.8rem;">
                <div style="font-size:2.5rem;margin-bottom:0.6rem;line-height:1;">${title.match(/^[^\s]+/)?.[0] || '⚠️'}</div>
                <h3 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:0.8rem;font-size:1.15rem;">
                    ${title.replace(/^[^\s]+\s?/, '') || 'Confirmation'}
                </h3>
                <p style="font-size:0.95rem;color:var(--text);margin-bottom:1.5rem;line-height:1.5;word-break:break-word;">
                    ${message}
                </p>
                <div style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;">
                    <button type="button" class="confirm-cancel-btn"
                        style="min-width:110px;padding:0.7rem 1.2rem;background:transparent;border:1px solid var(--border);color:var(--text-muted);border-radius:30px;font-weight:600;cursor:pointer;font-size:0.9rem;transition:all 0.2s;">
                        ${cancelText}
                    </button>
                    <button type="button" class="confirm-ok-btn"
                        style="min-width:110px;padding:0.7rem 1.2rem;background:${confirmBg};color:${confirmColor};border:none;border-radius:30px;font-weight:700;cursor:pointer;font-size:0.9rem;transition:all 0.2s;">
                        ${confirmText}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        activeConfirmModal = overlay;

        const modalEl = overlay.querySelector('.modal');
        const cancelBtn = overlay.querySelector('.confirm-cancel-btn');
        const okBtn = overlay.querySelector('.confirm-ok-btn');

        cancelBtn.addEventListener('mouseenter', () => {
            cancelBtn.style.borderColor = 'var(--gold)';
            cancelBtn.style.color = 'var(--gold)';
        });
        cancelBtn.addEventListener('mouseleave', () => {
            cancelBtn.style.borderColor = 'var(--border)';
            cancelBtn.style.color = 'var(--text-muted)';
        });
        okBtn.addEventListener('mouseenter', () => {
            okBtn.style.transform = 'scale(1.03)';
            okBtn.style.boxShadow = 'var(--shadow-gold)';
        });
        okBtn.addEventListener('mouseleave', () => {
            okBtn.style.transform = 'scale(1)';
            okBtn.style.boxShadow = 'none';
        });

        const cleanup = (result) => {
            document.removeEventListener('keydown', keyHandler);
            try { overlay.remove(); } catch (e) { /* ignore */ }
            if (activeConfirmModal === overlay) activeConfirmModal = null;
            releaseFocusTrap();
            resolve(result);
        };

        cancelBtn.addEventListener('click', () => cleanup(false));
        okBtn.addEventListener('click', () => cleanup(true));

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup(false);
        });

        const keyHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                cleanup(false);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                cleanup(true);
            }
        };
        document.addEventListener('keydown', keyHandler);

        trapFocus(modalEl);

        setTimeout(() => {
            try { okBtn.focus(); } catch (e) { /* ignore */ }
        }, 100);
    });
}

// ============================================================
// SCROLL VERS UN ÉLÉMENT
// ============================================================
export function scrollToElement(element, offset = 80) {
    if (!element) return;
    const top = element.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
}

export function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================
// HELPERS FORMULAIRES
// ============================================================
export function getInputValue(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

export function setInputValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
}

export function clearInputs(ids) {
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

// ============================================================
// DÉLÉGATION D'ÉVÉNEMENTS (helper)
// ============================================================
export function on(root, eventType, selector, handler) {
    if (!root) return;
    root.addEventListener(eventType, (e) => {
        const target = e.target.closest(selector);
        if (target && root.contains(target)) {
            handler.call(target, e, target);
        }
    });
}

// ============================================================
// Ouverture de l'image en grand (lightbox)
// ============================================================
export function openImageLightbox(imageUrl) {
    if (!imageUrl) return;

    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 30000;
        background: rgba(0,0,0,0.92);
        display: flex; align-items: center; justify-content: center;
        padding: 1rem; cursor: zoom-out;
    `;
    overlay.innerHTML = `
        <img src="${imageUrl}" alt="Image agrandie"
             style="max-width:95%; max-height:95%; object-fit:contain; border-radius:8px; box-shadow: 0 20px 60px rgba(0,0,0,0.6);">
        <button style="position:absolute;top:1rem;right:1rem;background:var(--bg-card);border:1px solid var(--border);width:44px;height:44px;border-radius:50%;color:var(--text);font-size:1.4rem;cursor:pointer;">✕</button>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.tagName === 'BUTTON') close();
    });
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
}

// ============================================================
// Copier dans le presse-papiers
// ============================================================
export async function copyToClipboard(text) {
    try {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
            showToast('📋 Copié !');
            return true;
        }
        // Fallback pour vieux navigateurs
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('📋 Copié !');
        return true;
    } catch (e) {
        console.warn('⚠️ Copie impossible :', e);
        return false;
    }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ ui-core.js chargé — toast, modales, lightbox, clipboard');