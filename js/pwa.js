/* ============================================================
   js/pwa.js — INSTALLATION PWA, SERVICE WORKER & BADGES
   ------------------------------------------------------------
   - Enregistre le Service Worker unifié (cache + FCM).
   - Bandeau « Installer l'application Smartswika » :
       · Android/Chrome/Edge → invite native beforeinstallprompt ;
       · iPhone/Safari → guide « Partager → Sur l'écran d'accueil ».
   - Expose getSwRegistration() pour FCM et getPlatform().
   - Ne bloque jamais le contenu : bandeau refermable (14 jours).
   ============================================================ */

const SW_URL = '/firebase-messaging-sw.js';
const DISMISS_KEY = 'smartswika:pwa-dismissed-until';
const DISMISS_DAYS = 14;

let swRegistration = null;
let deferredPrompt = null;
let bannerEl = null;

/** Vrai si l'app tourne en mode installé (standalone). */
export function isStandalone() {
  try {
    return (
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true
    );
  } catch (error) {
    return false;
  }
}

/** 'pwa_installed' ou 'web_browser' (champ platform de fcm_tokens). */
export function getPlatform() {
  return isStandalone() ? 'pwa_installed' : 'web_browser';
}

/** Enregistrement SW partagé avec FCM. */
export function getSwRegistration() {
  return swRegistration;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isDismissed() {
  try {
    return Date.now() < Number(localStorage.getItem(DISMISS_KEY) || 0);
  } catch (error) {
    return false;
  }
}

function dismissBanner() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 86400000));
  } catch (error) {
    /* stockage indisponible : masqué pour la session */
  }
  hideBanner();
}

function hideBanner() {
  if (!bannerEl) return;
  const node = bannerEl;
  bannerEl = null;
  node.classList.remove('is-visible');
  setTimeout(() => node.remove(), 250);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register(SW_URL, { scope: '/' });
    return swRegistration;
  } catch (error) {
    console.warn('[pwa] service worker indisponible :', error && error.message);
    return null;
  }
}

function buildBanner() {
  const el = document.createElement('aside');
  el.className = 'pwa-install';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Installer l’application Smartswika');
  el.innerHTML = `
    <img class="pwa-install__icon" src="/assets/pwa-192.png" alt="" width="44" height="44">
    <div class="pwa-install__text">
      <strong>Installer l’application Smartswika</strong>
      <span class="pwa-install__sub">Accès rapide, plein écran et notifications.</span>
    </div>
    <div class="pwa-install__actions">
      <button type="button" class="pwa-install__cta" data-pwa-action="install">Installer</button>
      <button type="button" class="pwa-install__ghost" data-pwa-action="close" aria-label="Fermer">✕</button>
    </div>
  `;
  return el;
}

function showBanner(mode) {
  if (bannerEl || isStandalone() || isDismissed()) return;
  bannerEl = buildBanner();
  const cta = bannerEl.querySelector('[data-pwa-action="install"]');
  const sub = bannerEl.querySelector('.pwa-install__sub');

  if (mode === 'ios') {
    cta.textContent = 'Comment installer ?';
    sub.textContent = 'Appuyez sur Partager puis « Sur l’écran d’accueil ».';
  } else if (mode === 'manual') {
    cta.textContent = 'Comment installer ?';
    sub.textContent = 'Menu du navigateur → « Installer l’application ».';
  }

  cta.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try {
        const choice = await deferredPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') hideBanner();
      } catch (error) {
        /* ignoré */
      }
      deferredPrompt = null;
      return;
    }
    sub.textContent = isIOS()
      ? 'Appuyez sur Partager puis « Sur l’écran d’accueil ».'
      : 'Menu ⋮ du navigateur → « Installer l’application ».';
  });

  bannerEl.querySelector('[data-pwa-action="close"]').addEventListener('click', dismissBanner);
  document.body.appendChild(bannerEl);
  requestAnimationFrame(() => bannerEl && bannerEl.classList.add('is-visible'));
}

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    showBanner('prompt');
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideBanner();
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + 365 * 86400000));
    } catch (error) {
      /* ignoré */
    }
  });

  if (isIOS() && !isStandalone()) {
    setTimeout(() => showBanner('ios'), 2500);
  }
}

/**
 * Ajoute un bouton « Activer les alertes » au bandeau d'installation.
 * Appelé par push.js quand la permission est encore à demander.
 * @param {Function} onClick
 */
export function showPushCta(onClick) {
  if (isStandalone() && isDismissed()) return;
  if (!bannerEl) {
    if (isStandalone() || isDismissed()) return;
    showBanner(isIOS() ? 'ios' : 'manual');
  }
  if (!bannerEl) return;
  if (bannerEl.querySelector('[data-pwa-action="push"]')) return;

  const actions = bannerEl.querySelector('.pwa-install__actions');
  if (!actions) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pwa-install__cta pwa-install__cta--push';
  btn.dataset.pwaAction = 'push';
  btn.textContent = 'Activer les alertes';
  btn.addEventListener('click', onClick);
  actions.insertBefore(btn, actions.firstChild);
}

/** Initialisation (idempotente). */
export async function initPWA() {
  if (typeof window === 'undefined') return;
  if (window._pwaInitialized) return;
  window._pwaInitialized = true;

  if (isStandalone()) document.documentElement.setAttribute('data-pwa', 'installed');

  await registerServiceWorker();
  setupInstallPrompt();

  /* Le SW demande la suppression du badge quand une notif est ouverte. */
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'CLEAR_APP_BADGE' && navigator.clearAppBadge) {
        navigator.clearAppBadge();
      }
    });
  }
}

export default initPWA;
