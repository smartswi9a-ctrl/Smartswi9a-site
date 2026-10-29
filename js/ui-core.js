/* ============================================================ js/ui-core.js UI CORE - SMART SWI9A Version 9.1.0 - Lot 51 : showToast auto-suffisante CHANGEMENTS v9.1.0 : - B-UI-4 (P0) : showToast() crée dynamiquement l'élément #cartToast s'il est absent du DOM, avec role="status" et aria-live="polite". Injecte les styles critiques une seule fois via une balise <style>. Corrige définitivement le bug des toasts invisibles sur les pages sans #cartToast (inscription-vendeur.html, vendor/dashboard.html, etc.). - Aucun changement de signature : showToast(msg, duration) reste identique. - Aucun autre export modifié. CHANGEMENTS v9.0.0 (rappel) : - confirmAction() : résolution de la promesse précédente, timeout de sécurité 120s. - openImageLightbox() : cleanup listener keydown. AUCUNE modification de signature : rétrocompatible 100 %. Module "bas niveau" SANS dépendances métier. Rôle : casser les cycles d'imports entre ui.js / cart.js / auth.js / orders.js. Fournit : toast, focus trap, modales, confirmAction, lightbox. ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import { escapeHTML } from "./utils.js";

/* ============================================================ TOAST (v9.1.0 : auto-suffisant) ============================================================ Affiche un message court en bas de l'écran. - Si #cartToast existe déjà dans le DOM (page avec HTML dédié), on l'utilise tel quel. - Sinon, on le crée à la volée et on injecte les styles nécessaires une seule fois. Cela garantit que TOUS les messages (succès, erreur, validation) sont visibles, même sur les pages qui n'ont pas prévu le conteneur. Un seul toast à la fois : un nouveau toast remplace le précédent. ============================================================ */
let toastTimeout = null;
let _toastStylesInjected = false;

/** * Injecte une seule fois les styles CSS critiques du toast. * Indépendant de style.css : le toast reste visible même si la * feuille de style principale échoue à charger. * @returns {void} */
function _injectToastStyles() {
  if (_toastStylesInjected) return;
  if (typeof document === "undefined" || !document.head) return;
  _toastStylesInjected = true;

  const style = document.createElement("style");
  style.id = "cart-toast-styles";
  style.textContent = ` #cartToast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px); background: #1a1a2e; color: #ffffff; padding: 12px 24px; border-radius: 30px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 0.9rem; font-weight: 600; line-height: 1.4; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); z-index: 99999; opacity: 0; visibility: hidden; transition: opacity 0.25s ease, transform 0.25s ease, visibility 0.25s; width: max-content !important; min-width: 0 !important; max-width: min(90vw, 420px) !important; height: auto !important; min-height: 0 !important; max-height: 35vh !important; overflow: hidden !important; box-sizing: border-box !important; white-space: normal !important; text-align: center; pointer-events: none; word-break: break-word; } #cartToast.show { opacity: 1; visibility: visible; transform: translateX(-50%) translateY(0); } `;
  document.head.appendChild(style);
}

/** * S'assure que l'élément #cartToast existe dans le DOM. * Le crée si absent, avec les attributs d'accessibilité requis. * @returns {HTMLElement|null} */
function _ensureToastElement() {
  if (typeof document === "undefined") return null;

  let toast = document.getElementById("cartToast");
  if (toast) {
    _injectToastStyles();
    return toast;
  }

  if (!document.body) return null;

  _injectToastStyles();

  toast = document.createElement("div");
  toast.id = "cartToast";
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.setAttribute("aria-atomic", "true");
  document.body.appendChild(toast);
  return toast;
}

/** * Affiche un toast (notification éphémère). * Crée automatiquement le conteneur #cartToast si absent du DOM. * @param {string} msg - Message à afficher. * @param {number} [duration=2500] - Durée d'affichage en ms. * @returns {void} */
export function showToast(msg, duration = 2500) {
  const toast = _ensureToastElement();
  if (!toast) {
    console.warn(
      "[ui-core] showToast : impossible de créer #cartToast (body absent ?). Message :",
      msg
    );
    return;
  }

  if (!document.body.contains(toast)) {
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        () => showToast(msg, duration),
        { once: true }
      );
      return;
    }
  }

  toast.textContent = msg;
  toast.classList.add("show");

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove("show");
    toastTimeout = null;
  }, duration);
}

/* ============================================================ FOCUS TRAP (accessibilité modales) ============================================================ */
let focusTrapListener = null;
let focusTrapElement = null;

/** * Piège le focus clavier dans `modalElement`. * @param {HTMLElement} modalElement */
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
    if (e.key === "Tab") {
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  modalElement.addEventListener("keydown", listener);
  focusTrapListener = listener;
  focusTrapElement = modalElement;

  setTimeout(() => {
    try {
      first.focus();
    } catch (e) {
      /* ignore */
    }
  }, 100);
}

/** * Libère le focus trap actif (s'il y en a un). */
export function releaseFocusTrap() {
  if (focusTrapListener && focusTrapElement) {
    focusTrapElement.removeEventListener("keydown", focusTrapListener);
    focusTrapListener = null;
    focusTrapElement = null;
  }
}

/* ============================================================ HELPERS MODALES ============================================================ */

/** * Ouvre une modale. * @param {HTMLElement} modalElement * @param {Object} [options] */
export function openModal(modalElement, options = {}) {
  if (!modalElement) return;
  modalElement.classList.add("open");
  document.body.style.overflow = "hidden";
  if (options.trapFocus !== false) {
    trapFocus(modalElement);
  }
}

/** * Ferme une modale. * @param {HTMLElement} modalElement */
export function closeModal(modalElement) {
  if (!modalElement) return;
  modalElement.classList.remove("open");
  document.body.style.overflow = "";
  releaseFocusTrap();
}

/* ============================================================ CONFIRMATION PERSONNALISÉE ============================================================ */
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
    try {
      activeConfirmModal.remove();
    } catch (e) {
      /* ignore */
    }
    activeConfirmModal = null;
  }
  releaseFocusTrap();
  if (activeConfirmResolver) {
    const resolver = activeConfirmResolver;
    activeConfirmResolver = null;
    resolver(result);
  }
}

/** * Affiche une modale de confirmation et retourne une promesse. * @param {string} message * @param {Object} [options] * @returns {Promise<boolean>} */
export function confirmAction(message, options = {}) {
  if (activeConfirmResolver) {
    _cleanupActiveConfirm(false);
  }

  const {
    title = "⚠️ Confirmation",
    confirmText = "Confirmer",
    cancelText = "Annuler",
    variant = "danger",
  } = options;

  return new Promise((resolve) => {
    activeConfirmResolver = resolve;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay open";
    overlay.style.zIndex = "20000";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");

    const confirmBg =
      {
        danger: "linear-gradient(135deg, var(--danger), #7d241a)",
        primary: "linear-gradient(135deg, var(--gold), #7d5a1d)",
        info: "linear-gradient(135deg, var(--info), #2874a6)",
      }[variant] || "linear-gradient(135deg, var(--danger), #7d241a)";

    const confirmColor = "#ffffff";

    const safeMessage = escapeHTML(message);
    const safeConfirmText = escapeHTML(confirmText);
    const safeCancelText = escapeHTML(cancelText);

    const titleEmojiMatch = title.match(/^[^\s]+/);
    const titleEmoji = titleEmojiMatch ? titleEmojiMatch[0] : "⚠️";
    const titleText = title.replace(/^[^\s]+\s?/, "") || "Confirmation";
    const safeTitleText = escapeHTML(titleText);

    overlay.innerHTML = ` <div class="modal" style="max-width:420px;text-align:center;padding:1.8rem;"> <div style="font-size:2.5rem;margin-bottom:0.6rem;line-height:1;">${titleEmoji}</div> <h3 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:0.8rem;font-size:1.15rem;"> ${safeTitleText} </h3> <p style="font-size:0.95rem;color:var(--text);margin-bottom:1.5rem;line-height:1.5;word-break:break-word;"> ${safeMessage} </p> <div style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;"> <button type="button" class="confirm-cancel-btn" style="min-width:110px;padding:0.7rem 1.2rem;background:transparent;border:1px solid var(--border);color:var(--text-muted);border-radius:30px;font-weight:600;cursor:pointer;font-size:0.9rem;transition:all 0.2s;"> ${safeCancelText} </button> <button type="button" class="confirm-ok-btn" style="min-width:110px;padding:0.7rem 1.2rem;background:${confirmBg};color:${confirmColor};border:none;border-radius:30px;font-weight:700;cursor:pointer;font-size:0.9rem;transition:all 0.2s;"> ${safeConfirmText} </button> </div> </div> `;

    document.body.appendChild(overlay);
    activeConfirmModal = overlay;

    const modalEl = overlay.querySelector(".modal");
    const cancelBtn = overlay.querySelector(".confirm-cancel-btn");
    const okBtn = overlay.querySelector(".confirm-ok-btn");

    cancelBtn.addEventListener("mouseenter", () => {
      cancelBtn.style.borderColor = "var(--gold)";
      cancelBtn.style.color = "var(--gold)";
    });
    cancelBtn.addEventListener("mouseleave", () => {
      cancelBtn.style.borderColor = "var(--border)";
      cancelBtn.style.color = "var(--text-muted)";
    });
    okBtn.addEventListener("mouseenter", () => {
      okBtn.style.transform = "scale(1.03)";
      okBtn.style.boxShadow = "var(--shadow-gold)";
    });
    okBtn.addEventListener("mouseleave", () => {
      okBtn.style.transform = "scale(1)";
      okBtn.style.boxShadow = "none";
    });

    const cleanup = (result) => {
      document.removeEventListener("keydown", keyHandler);
      _cleanupActiveConfirm(result);
    };

    cancelBtn.addEventListener("click", () => cleanup(false));
    okBtn.addEventListener("click", () => cleanup(true));

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(false);
    });

    const keyHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        cleanup(true);
      }
    };
    document.addEventListener("keydown", keyHandler);

    trapFocus(modalEl);

    setTimeout(() => {
      try {
        okBtn.focus();
      } catch (e) {
        /* ignore */
      }
    }, 100);

    if (activeConfirmTimeout) clearTimeout(activeConfirmTimeout);
    activeConfirmTimeout = setTimeout(() => {
      console.warn("confirmAction : timeout atteint, résolution par false");
      _cleanupActiveConfirm(false);
    }, CONFIRM_TIMEOUT_MS);
  });
}

/* ============================================================ SCROLL VERS UN ÉLÉMENT ============================================================ */

/** * Scroll vers un élément avec un offset. * @param {HTMLElement} element * @param {number} [offset=80] */
export function scrollToElement(element, offset = 80) {
  if (!element) return;
  const top = element.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top, behavior: "smooth" });
}

/** * Scroll fluide vers le haut de la page. */
export function scrollToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ============================================================ HELPERS FORMULAIRES ============================================================ */

/** * Lit la valeur trimée d'un input par id. * @param {string} id * @returns {string} */
export function getInputValue(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

/** * Définit la valeur d'un input par id. * @param {string} id * @param {string} value */
export function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

/** * Vide les inputs listés. * @param {string[]} ids */
export function clearInputs(ids) {
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
}

/* ============================================================ DÉLÉGATION D'ÉVÉNEMENTS ============================================================ */

/** * Attache un listener délégué sur un conteneur. * @param {HTMLElement} root * @param {string} eventType * @param {string} selector * @param {(e: Event, target: HTMLElement) => void} handler */
export function on(root, eventType, selector, handler) {
  if (!root) return;
  root.addEventListener(eventType, (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) {
      handler.call(target, e, target);
    }
  });
}

/* ============================================================ LIGHTBOX IMAGE ============================================================ */

/** * Ouvre une image en plein écran avec fond noir. * @param {string} imageUrl */
export function openImageLightbox(imageUrl) {
  if (!imageUrl) return;

  const overlay = document.createElement("div");
  overlay.style.cssText = ` position: fixed; inset: 0; z-index: 30000; background: rgba(0,0,0,0.92); display: flex; align-items: center; justify-content: center; padding: 1rem; cursor: zoom-out; `;

  const safeUrl = escapeHTML(imageUrl);

  overlay.innerHTML = ` <img src="${safeUrl}" alt="Image agrandie" style="max-width:95%; max-height:95%; object-fit:contain; border-radius:8px; box-shadow: 0 20px 60px rgba(0,0,0,0.6);"> <button style="position:absolute;top:1rem;right:1rem;background:var(--bg-card);border:1px solid var(--border);width:44px;height:44px;border-radius:50%;color:var(--text);font-size:1.4rem;cursor:pointer;">✕</button> `;
  document.body.appendChild(overlay);

  const escHandler = (e) => {
    if (e.key === "Escape") close();
  };

  const close = () => {
    document.removeEventListener("keydown", escHandler);
    if (overlay.parentNode) overlay.remove();
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.tagName === "BUTTON") close();
  });
  document.addEventListener("keydown", escHandler);
}

/* ============================================================ COPIER DANS LE PRESSE-PAPIERS ============================================================ */

/** * Copie du texte dans le presse-papiers. * @param {string} text * @returns {Promise<boolean>} */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      showToast("Copié !");
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    showToast("Copié !");
    return true;
  } catch (e) {
    console.warn("Copie impossible :", e);
    return false;
  }
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ ui-core.js chargé - v9.1.0 (Lot 51 : showToast auto-suffisante)"
);