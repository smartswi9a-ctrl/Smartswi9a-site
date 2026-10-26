/* ============================================================
   js/ui-core.js
   UI CORE - SMART SWI9A
   Version 9.0.0 - Lot 5/30 : corrections critiques confirmAction

   CHANGEMENTS v9.0.0 :
     - B-UI-1 (P1) : confirmAction() résout la promesse précédente
       avec false si une nouvelle confirmation démarre alors qu'une
       est en cours. Évite un await bloqué indéfiniment.
     - B-UI-2 (P1) : confirmAction() ajoute un timeout de sécurité
       (120s) qui résout la promesse si le modal est retiré du DOM
       sans passer par cleanup().
     - B-UI-3 (P2) : openImageLightbox() retire proprement le
       listener keydown dans TOUS les cas de fermeture (clic overlay,
       bouton, ESC).
     - JSDoc sur tous les exports publics.
     - Bump version 1.1.1 -> 9.0.0.

   AUCUNE modification de signature : rétrocompatible 100 %.

   Module "bas niveau" SANS dépendances métier.
   Rôle : casser les cycles d'imports entre ui.js / cart.js /
   auth.js / orders.js. Fournit : toast, focus trap, modales,
   confirmAction, lightbox.

   ALERTE 1 : plus aucun commentaire de ligne (//) en début de
   ligne utile. Tout est en bloc.
   ============================================================ */

import { escapeHTML } from "./utils.js";

/* ============================================================
   TOAST
   ============================================================
   Affiche un message court en haut de l'écran (élément #cartToast
   présent sur toutes les pages). Un seul toast à la fois :
   un nouveau toast remplace le précédent.
   ============================================================ */
let toastTimeout = null;

/**
 * Affiche un toast (notification éphémère).
 * @param {string} msg - Message à afficher.
 * @param {number} [duration=2500] - Durée d'affichage en ms.
 */
export function showToast(msg, duration = 2500) {
    const toast = document.getElementById('cartToast');
    if (!toast) {
        console.warn('Élément #cartToast introuvable');
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

/* ============================================================
   FOCUS TRAP (accessibilité modales)
   ============================================================
   Piège le focus clavier dans un conteneur (ex: modale) pour
   respecter WCAG 2.1 §2.4.3 (focus order). L'appelant DOIT appeler
   releaseFocusTrap() à la fermeture de la modale, sinon le listener
   reste attaché (fuite légère, pas bloquante).
   ============================================================ */
let focusTrapListener = null;
let focusTrapElement = null;

/**
 * Piège le focus clavier dans `modalElement`.
 * - Tab cycle entre les éléments focusables.
 * - Shift+Tab cycle en sens inverse.
 * - Focus automatique sur le premier élément focusable.
 *
 * Remplace tout focus trap précédent (releaseFocusTrap() implicite).
 *
 * @param {HTMLElement} modalElement - Conteneur (ex: .modal).
 */
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

/**
 * Libère le focus trap actif (s'il y en a un).
 * Idempotent.
 */
export function releaseFocusTrap() {
    if (focusTrapListener && focusTrapElement) {
        focusTrapElement.removeEventListener('keydown', focusTrapListener);
        focusTrapListener = null;
        focusTrapElement = null;
    }
}

/* ============================================================
   HELPERS MODALES (ouverture / fermeture générique)
   ============================================================ */

/**
 * Ouvre une modale (ajoute .open, bloque le scroll body, piège le focus).
 * @param {HTMLElement} modalElement
 * @param {Object} [options]
 * @param {boolean} [options.trapFocus=true] - Piéger le focus clavier.
 */
export function openModal(modalElement, options = {}) {
    if (!modalElement) return;
    modalElement.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (options.trapFocus !== false) {
        trapFocus(modalElement);
    }
}

/**
 * Ferme une modale (retire .open, restaure le scroll body, libère le focus).
 * @param {HTMLElement} modalElement
 */
export function closeModal(modalElement) {
    if (!modalElement) return;
    modalElement.classList.remove('open');
    document.body.style.overflow = '';
    releaseFocusTrap();
}

/* ============================================================
   CONFIRMATION PERSONNALISÉE (modal custom premium)
   ============================================================
   Remplace window.confirm() par un modal cohérent avec le design.

   SÉCURITÉ : toutes les valeurs injectées sont échappées via
   escapeHTML() pour empêcher le XSS si un appelant passe une
   chaîne utilisateur (ex: nom de produit dans le message).

   CYCLE DE VIE :
   - Un seul modal de confirmation à la fois.
   - Une nouvelle confirmAction() pendant qu'une autre est en cours
     résout l'ancienne avec false (B-UI-1).
   - Un timeout de sécurité (120s) résout la promesse si le modal
     est retiré du DOM par un autre code (B-UI-2).
   - La promesse est TOUJOURS résolue (jamais bloquée).
   ============================================================ */
let activeConfirmModal = null;
let activeConfirmResolver = null;
let activeConfirmTimeout = null;

const CONFIRM_TIMEOUT_MS = 120000;

function _cleanupActiveConfirm(result) {
    if (activeConfirmTimeout) {
        clearTimeout(activeConfirmTimeout);
        activeConfirmTimeout = null;
    }
    if (activeConfirmModal) {
        try { activeConfirmModal.remove(); } catch (e) { /* ignore */ }
        activeConfirmModal = null;
    }
    releaseFocusTrap();
    if (activeConfirmResolver) {
        const resolver = activeConfirmResolver;
        activeConfirmResolver = null;
        resolver(result);
    }
}

/**
 * Affiche une modale de confirmation et retourne une promesse.
 *
 * @param {string} message - Message principal (échappé).
 * @param {Object} [options]
 * @param {string} [options.title='⚠️ Confirmation'] - Titre (emoji + texte).
 * @param {string} [options.confirmText='Confirmer'] - Texte du bouton OK.
 * @param {string} [options.cancelText='Annuler'] - Texte du bouton Annuler.
 * @param {'danger'|'primary'|'info'} [options.variant='danger'] - Style du bouton OK.
 * @returns {Promise<boolean>} true si confirmé, false si annulé ou timeout.
 */
export function confirmAction(message, options = {}) {
    /* B-UI-1 : résoudre la promesse précédente avec false avant d'ouvrir
       une nouvelle confirmation. Sans ça, un appelant await bloquerait
       à vie. */
    if (activeConfirmResolver) {
        _cleanupActiveConfirm(false);
    }

    const {
        title = '⚠️ Confirmation',
        confirmText = 'Confirmer',
        cancelText = 'Annuler',
        variant = 'danger'
    } = options;

    return new Promise((resolve) => {
        activeConfirmResolver = resolve;

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

        /* SÉCURITÉ : Échappement de toutes les variables injectées. */
        const safeMessage = escapeHTML(message);
        const safeConfirmText = escapeHTML(confirmText);
        const safeCancelText = escapeHTML(cancelText);

        const titleEmojiMatch = title.match(/^[^\s]+/);
        const titleEmoji = titleEmojiMatch ? titleEmojiMatch[0] : '⚠️';
        const titleText = title.replace(/^[^\s]+\s?/, '') || 'Confirmation';
        const safeTitleText = escapeHTML(titleText);

        overlay.innerHTML = `
            <div class="modal" style="max-width:420px;text-align:center;padding:1.8rem;">
                <div style="font-size:2.5rem;margin-bottom:0.6rem;line-height:1;">${titleEmoji}</div>
                <h3 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:0.8rem;font-size:1.15rem;">
                    ${safeTitleText}
                </h3>
                <p style="font-size:0.95rem;color:var(--text);margin-bottom:1.5rem;line-height:1.5;word-break:break-word;">
                    ${safeMessage}
                </p>
                <div style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;">
                    <button type="button" class="confirm-cancel-btn"
                        style="min-width:110px;padding:0.7rem 1.2rem;background:transparent;border:1px solid var(--border);color:var(--text-muted);border-radius:30px;font-weight:600;cursor:pointer;font-size:0.9rem;transition:all 0.2s;">
                        ${safeCancelText}
                    </button>
                    <button type="button" class="confirm-ok-btn"
                        style="min-width:110px;padding:0.7rem 1.2rem;background:${confirmBg};color:${confirmColor};border:none;border-radius:30px;font-weight:700;cursor:pointer;font-size:0.9rem;transition:all 0.2s;">
                        ${safeConfirmText}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        activeConfirmModal = overlay;

        const modalEl = overlay.querySelector('.modal');
        const cancelBtn = overlay.querySelector('.confirm-cancel-btn');
        const okBtn = overlay.querySelector('.confirm-ok-btn');

        /* Effets visuels boutons (inchangés) */
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
            _cleanupActiveConfirm(result);
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

        /* B-UI-2 : timeout de sécurité. Si le modal est retiré du DOM
           sans passer par cleanup() (ex: autre code qui remove le parent),
           on résout avec false pour éviter un await bloqué. */
        if (activeConfirmTimeout) clearTimeout(activeConfirmTimeout);
        activeConfirmTimeout = setTimeout(() => {
            console.warn('confirmAction : timeout atteint, résolution par false');
            _cleanupActiveConfirm(false);
        }, CONFIRM_TIMEOUT_MS);
    });
}

/* ============================================================
   SCROLL VERS UN ÉLÉMENT
   ============================================================ */

/**
 * Scroll vers un élément avec un offset (utile pour la navbar fixed).
 * @param {HTMLElement} element
 * @param {number} [offset=80] - Marge en pixels.
 */
export function scrollToElement(element, offset = 80) {
    if (!element) return;
    const top = element.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
}

/**
 * Scroll fluide vers le haut de la page.
 */
export function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================
   HELPERS FORMULAIRES
   ============================================================ */

/**
 * Lit la valeur trimée d'un input par id.
 * @param {string} id
 * @returns {string}
 */
export function getInputValue(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

/**
 * Définit la valeur d'un input par id.
 * @param {string} id
 * @param {string} value
 */
export function setInputValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
}

/**
 * Vide les inputs listés.
 * @param {string[]} ids
 */
export function clearInputs(ids) {
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

/* ============================================================
   DÉLÉGATION D'ÉVÉNEMENTS (helper)
   ============================================================ */

/**
 * Attache un listener délégué sur un conteneur.
 * Le handler n'est appelé que si la cible correspond au sélecteur.
 * @param {HTMLElement} root
 * @param {string} eventType
 * @param {string} selector
 * @param {(e: Event, target: HTMLElement) => void} handler
 */
export function on(root, eventType, selector, handler) {
    if (!root) return;
    root.addEventListener(eventType, (e) => {
        const target = e.target.closest(selector);
        if (target && root.contains(target)) {
            handler.call(target, e, target);
        }
    });
}

/* ============================================================
   LIGHTBOX IMAGE (zoom plein écran)
   ============================================================
   B-UI-3 : le listener keydown est retiré dans TOUS les cas de
   fermeture (clic overlay, bouton, ESC). Avant, un clic fermait
   la lightbox mais laissait le listener attaché.
   ============================================================ */

/**
 * Ouvre une image en plein écran avec fond noir.
 * Fermeture : clic sur l'overlay, clic sur le bouton ✕, ou ESC.
 * @param {string} imageUrl
 */
export function openImageLightbox(imageUrl) {
    if (!imageUrl) return;

    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 30000;
        background: rgba(0,0,0,0.92);
        display: flex; align-items: center; justify-content: center;
        padding: 1rem; cursor: zoom-out;
    `;

    /* SÉCURITÉ : Échappement de l'URL (défense en profondeur). */
    const safeUrl = escapeHTML(imageUrl);

    overlay.innerHTML = `
        <img src="${safeUrl}" alt="Image agrandie"
             style="max-width:95%; max-height:95%; object-fit:contain; border-radius:8px; box-shadow: 0 20px 60px rgba(0,0,0,0.6);">
        <button style="position:absolute;top:1rem;right:1rem;background:var(--bg-card);border:1px solid var(--border);width:44px;height:44px;border-radius:50%;color:var(--text);font-size:1.4rem;cursor:pointer;">✕</button>
    `;
    document.body.appendChild(overlay);

    /* B-UI-3 : nettoyage centralisé, appelé dans TOUS les cas. */
    const escHandler = (e) => {
        if (e.key === 'Escape') close();
    };

    const close = () => {
        document.removeEventListener('keydown', escHandler);
        if (overlay.parentNode) overlay.remove();
    };

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.tagName === 'BUTTON') close();
    });
    document.addEventListener('keydown', escHandler);
}

/* ============================================================
   COPIER DANS LE PRESSE-PAPIERS
   ============================================================ */

/**
 * Copie du texte dans le presse-papiers.
 * Fallback automatique si navigator.clipboard indisponible
 * (navigateurs anciens, contexte HTTP non-sécurisé).
 * @param {string} text
 * @returns {Promise<boolean>} true si copié, false sinon.
 */
export async function copyToClipboard(text) {
    try {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
            showToast('Copié !');
            return true;
        }
        /* Fallback pour navigateurs anciens */
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('Copié !');
        return true;
    } catch (e) {
        console.warn('Copie impossible :', e);
        return false;
    }
}

/* ============================================================
   LOG
   ============================================================ */
console.log('✅ ui-core.js chargé - v9.0.0 (Lot 5 : confirmAction sécurisé + lightbox cleanup)');