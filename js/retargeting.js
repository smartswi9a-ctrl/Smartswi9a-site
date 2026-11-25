/* ============================================================
   js/retargeting.js — SUIVI PASSIF DES VISITES PRODUIT
   ------------------------------------------------------------
   RÈGLE ABSOLUE : module 100 % isolé et passif.
   • Ne modifie AUCUNE variable, AUCUN localStorage, AUCUN tri,
     AUCUNE recommandation, AUCUN panier : il ne fait que LIRE.
   • Écrit uniquement dans product_views/{uid}_{productId}.
   • N'échoue jamais bruyamment : tout est encapsulé.
   Chargé uniquement par produit.html.
   ============================================================ */

import { auth, db } from './firebase.js';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, collection, query, where, limit, getDocs, serverTimestamp } from 'firebase/firestore';

const START_MS = Date.now();
const SESSION_FLAG = '__swi9a_retargeting_recorded__';

function isProductPage() {
    return /\/produit(\.html)?$/.test(window.location.pathname);
}

function searchParam(name) {
    try {
        return new URLSearchParams(window.location.search).get(name) || '';
    } catch (error) {
        return '';
    }
}

function readProductFromDom() {
    const titleEl = document.getElementById('productTitleEl');
    const priceEl = document.getElementById('productPrice');
    const imageEl = document.querySelector('.product-images img');
    const priceText = priceEl ? String(priceEl.textContent || '') : '';
    const price = Number(priceText.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
    return {
        title: titleEl ? String(titleEl.textContent || '').trim() : '',
        price,
        image: imageEl ? String(imageEl.getAttribute('src') || '') : ''
    };
}

/** Le produit est-il présent dans le panier ? (lecture seule) */
function isInStoredCart(productId) {
    try {
        const uid = auth.currentUser ? auth.currentUser.uid : '';
        const key = uid ? `swi9a_cart_${uid}` : 'swi9a_cart';
        const raw = window.localStorage.getItem(key);
        if (!raw) return false;
        const items = JSON.parse(raw);
        if (!Array.isArray(items)) return false;
        return items.some((item) => item && String(item.productId) === String(productId));
    } catch (error) {
        return false;
    }
}

async function resolveProductId() {
    const direct = searchParam('id') || searchParam('productId');
    if (direct) return String(direct);
    const slug = searchParam('slug');
    if (!slug) return '';
    try {
        const snap = await getDocs(query(collection(db, 'products'), where('slug', '==', slug), limit(1)));
        return snap.empty ? '' : snap.docs[0].id;
    } catch (error) {
        return '';
    }
}

async function recordView(productId) {
    const user = auth.currentUser;
    if (!user || !productId) return;
    if (window[SESSION_FLAG]) return;
    window[SESSION_FLAG] = true;

    const { title, price, image } = readProductFromDom();
    if (!title || !price) return;

    const ref = doc(db, 'product_views', `${user.uid}_${productId}`);
    let previous = null;
    try {
        const snap = await getDoc(ref);
        previous = snap.exists() ? snap.data() : null;
    } catch (error) {
        previous = null;
    }

    const viewCount = Number((previous && previous.viewCount) || 0) + 1;
    const dwellSeconds = Math.round((Date.now() - START_MS) / 1000);
    const seenPrice = Math.max(Number((previous && previous.seenPrice) || 0), price);

    try {
        await setDoc(
            ref,
            {
                uid: user.uid,
                productId,
                productTitle: title.slice(0, 120),
                productImage: image.slice(0, 400),
                seenPrice,
                viewCount,
                engaged: ((previous && previous.engaged) === true) || viewCount >= 2 || dwellSeconds >= 20,
                inAbandonedCart: ((previous && previous.inAbandonedCart) === true) || isInStoredCart(productId),
                promoEmailSent: (previous && previous.promoEmailSent) === true,
                lowStockAlertSent: (previous && previous.lowStockAlertSent) === true,
                lastViewedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            },
            { merge: true }
        );
    } catch (error) {
        /* quota, réseau, règles : jamais bloquant pour la navigation */
    }
}

async function start() {
    if (!isProductPage()) return;
    const productId = await resolveProductId();
    if (!productId) return;

    /* Enregistrement 1 fois par visite, sans bloquer le rendu. */
    const schedule = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
    schedule(() => {
        recordView(productId);
    });

    /* Marque l'intérêt (20 s) même si l'onglet reste ouvert. */
    window.setTimeout(() => recordView(productId), 21000);

    /* Sortie de page / onglet en arrière-plan : dernière chance. */
    const flush = () => recordView(productId);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
}

try {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    }
    onAuthStateChanged(auth, (user) => {
        if (user) start();
    });
} catch (error) {
    /* module optionnel : aucune conséquence sur la boutique */
}
