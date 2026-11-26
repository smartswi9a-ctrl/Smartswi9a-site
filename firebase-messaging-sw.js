/* ============================================================
   firebase-messaging-sw.js — SERVICE WORKER UNIFIÉ SMARTswika
   ------------------------------------------------------------
   Un seul SW pour :
     - le cache PWA (HTML réseau-d'abord, assets cache-d'abord) ;
     - les notifications push FCM en arrière-plan (navigateur ou
       application fermés) ;
     - le clic sur notification (focus ou ouverture de targetUrl) ;
     - la demande de suppression du badge d'icône.
   Messages serveur : DATA-ONLY (titre/corps/url/type) → affichage
   maîtrisé ici (aucun doublon avec le SDK).
   ============================================================ */

importScripts('https://www.gstatic.com/firebasejs/11.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.0/firebase-messaging-compat.js');

const SW_VERSION = 'sw-2026-11-26-v12';
const CACHE_NAME = 'smartswika-' + SW_VERSION;
const PRECACHE = [
  '/',
  '/manifest.json',
  '/assets/pwa-192.png',
  '/assets/pwa-512.png',
  '/assets/logo-64.png'
];

firebase.initializeApp({
  apiKey: 'AIzaSyBhULwDxPBRqjywsSD_0ny41Bmt968ofSA',
  authDomain: 'smartswi9a-31063.firebaseapp.com',
  projectId: 'smartswi9a-31063',
  storageBucket: 'smartswi9a-31063.firebasestorage.app',
  messagingSenderId: '933677210664',
  appId: '1:933677210664:web:1ee39f36dfa0806656e91d'
});

/* ------------------------------------------------------------
   CACHE PWA
   ------------------------------------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('smartswika-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  /* Navigation : réseau d'abord, cache en secours (mode hors-ligne). */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  /* Assets statiques : cache d'abord. */
  if (/\.(?:css|js|mjs|png|jpg|jpeg|webp|svg|gif|ico|woff2?)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => {
        if (hit) return hit;
        return fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        });
      })
    );
  }
});

/* ------------------------------------------------------------
   NOTIFICATIONS PUSH FCM (arrière-plan)
   ------------------------------------------------------------ */

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  /* Depuis l'ajout du bloc natif `notification` (haute priorité), le
     navigateur affiche lui-même la bannière : on ne double pas. */
  if (payload && payload.notification && (payload.notification.title || payload.notification.body)) {
    return;
  }

  const data = payload.data || {};
  const title = data.title || 'Smartswika';
  const body = data.body || '';
  const targetUrl = data.targetUrl || data.click_action || '/';

  return self.registration.showNotification(title, {
    body,
    icon: '/assets/pwa-192.png',
    badge: '/assets/pwa-192.png',
    tag: data.tag || data.type || 'smartswika',
    renotify: true,
    requireInteraction: false,
    data: { url: targetUrl, type: data.type || '' }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target =
    (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      });
      for (const client of allClients) {
        if ('focus' in client) {
          client.postMessage({ type: 'CLEAR_APP_BADGE' });
          if ('navigate' in client) {
            try {
              await client.navigate(target);
            } catch (error) {
              /* navigation refusée : on garde le focus */
            }
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })()
  );
});

/* ------------------------------------------------------------
   MESSAGES DEPUIS LA PAGE
   ------------------------------------------------------------ */

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
