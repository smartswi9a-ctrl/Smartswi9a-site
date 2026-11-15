/* ============================================================
   js/grouped-pickup.js
   RAMASSAGE GROUPÉ LIVO — PRÉDICAT D'ÉLIGIBILITÉ (PR 8.4)
   ------------------------------------------------------------
   Un seul endroit décide qu'une commande est ramassable par un
   ramassage groupé Livo de l'entrepôt Smart Swika.

   Avant PR 8.4, js/admin.js ne filtrait que `status === confirmed`
   et `!livoPickupId` : les commandes drop-off (colis chez le
   vendeur) et les commandes multi-vendeurs étaient proposées au
   ramassage entrepôt, ce qui envoyait Livo chercher des colis qui
   n'étaient pas sur place.

   Ce module est volontairement PUR (aucun DOM) afin de pouvoir
   être exécuté tel quel par :
     - js/admin.js (compteur + bouton + modale)
     - js/orders.js (garde de transition)
     - scripts/backfill-grouped-pickup-eligible.cjs (via vm)
     - tests/grouped-pickup.test.cjs (via vm)
   Une divergence entre le runtime, le backfill et les tests est
   donc structurellement impossible.

   CONTRAT DE SORTIE : evaluateGroupedPickupOrder() ne jette jamais.
   Toute donnée manquante ou illisible produit `eligible: false`
   avec un motif explicite (fail-closed) : une lecture Firestore en
   erreur ne doit jamais laisser passer une commande.
   ============================================================ */

import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase.js";

/* ============================================================
   CONSTANTES MÉTIER
   ============================================================ */

/** Mode produit qui implique que le colis est physiquement à l'entrepôt. */
export const WAREHOUSE_DELIVERY_MODE = 'smartswika_warehouse';

/** Mode logistique vendeur qui implique que la Plateforme prépare le colis. */
export const REQUIRED_VENDOR_SHIPPING_METHOD = 'fulfillment';

/** Statut vendeur exigé pour qu'un colis soit pris en charge par la Plateforme. */
export const REQUIRED_VENDOR_STATUS = 'approved';

/**
 * Statuts de paiement INCOMPATIBLES avec un ramassage Livo.
 *
 * Smart Swika encaisse en COD (paiement à la livraison) : les commandes
 * naissent `unpaid` (functions/index.js, createCustomerOrder) et ne
 * passent `paid` qu'à la transition `delivered` (js/orders.js,
 * updateOrderStatus). Exiger `paymentStatus === 'paid'` avant le
 * ramassage viderait donc la liste des candidates par construction.
 *
 * On refuse uniquement les états qui signalent un remboursement ou un
 * échec de paiement explicite. Tout le reste est accepté, y compris
 * un `paymentStatus` absent (commandes historiques).
 */
export const INCOMPATIBLE_PAYMENT_STATUSES = new Set([
    'refunded',
    'refund',
    'cancelled_payment',
    'failed'
]);

/** Motifs de rejet (stables : journalisés par le backfill et les tests). */
export const PICKUP_REJECT = {
    NOT_CONFIRMED: 'not_confirmed',
    ALREADY_PICKED_UP: 'already_pickup_requested',
    NO_ITEMS: 'no_items',
    MULTI_VENDOR: 'multi_vendor',
    NO_VENDOR: 'no_vendor',
    VENDOR_NOT_APPROVED: 'vendor_not_approved',
    VENDOR_NOT_FULFILLMENT: 'vendor_not_fulfillment',
    VENDOR_UNREADABLE: 'vendor_unreadable',
    PRODUCT_MISSING: 'product_missing',
    PRODUCT_NOT_WAREHOUSE: 'product_not_warehouse',
    PRODUCT_UNREADABLE: 'product_unreadable',
    PAYMENT_INCOMPATIBLE: 'payment_incompatible',
    EMPTY_QUANTITY: 'empty_quantity'
};

/* ============================================================
   HELPERS PURS
   ============================================================ */

/**
 * Lignes d'article d'une commande.
 * Structure canonique : order.items[] = { productId, quantity, ... }
 * `order.products` n'existe pas sur les commandes créées par
 * functions/index.js — conservé en fallback défensif (cf. admin.js,
 * countOrderArticles).
 * @param {object} order
 * @returns {object[]}
 */
export function getOrderLines(order) {
    if (!order || typeof order !== 'object') return [];
    if (Array.isArray(order.items)) return order.items;
    if (Array.isArray(order.products)) return order.products;
    return [];
}

/**
 * Identifiants vendeurs distincts d'une commande, hors Plateforme.
 * `smartswi9a` désigne le catalogue historique Smart Swika lui-même :
 * ce n'est pas un vendeur tiers, il est ignoré du calcul (les produits
 * du catalogue plateforme restent filtrés par delivery_mode).
 * @param {object} order
 * @returns {string[]}
 */
export function getOrderVendorIds(order) {
    const ids = new Set();
    for (const line of getOrderLines(order)) {
        const raw = line && line.vendorId != null ? String(line.vendorId).trim() : '';
        if (!raw) continue;
        if (raw === 'smartswi9a') continue;
        ids.add(raw);
    }
    return Array.from(ids);
}

/**
 * Identifiants produits distincts d'une commande.
 * @param {object} order
 * @returns {string[]}
 */
export function getOrderProductIds(order) {
    const ids = new Set();
    for (const line of getOrderLines(order)) {
        const raw = line && line.productId != null ? String(line.productId).trim() : '';
        if (!raw) continue;
        ids.add(raw);
    }
    return Array.from(ids);
}

/**
 * Nombre total d'articles (somme des quantités valides), identique à
 * countOrderArticles() de js/admin.js.
 * @param {object} order
 * @returns {number}
 */
export function countGroupedPickupArticles(order) {
    return getOrderLines(order).reduce((sum, line) => {
        const qty = Math.floor(Number(line && line.quantity));
        return sum + (Number.isFinite(qty) && qty > 0 ? qty : 0);
    }, 0);
}

/* ============================================================
   PRÉDICAT PRINCIPAL — ÉLIGIBILITÉ D'UNE COMMANDE
   ============================================================ */

/**
 * Évalue si une commande peut entrer dans un ramassage groupé Livo
 * de l'entrepôt Smart Swika.
 *
 * Règles (toutes obligatoires) :
 *   1. status === 'confirmed'
 *   2. livoPickupId absent (pas déjà rattachée à un ramassage)
 *   3. au moins une ligne d'article
 *   4. vendorIds.length <= 1 (hors Plateforme) — pas de panier multi-vendeurs
 *   5. le vendeur unique est approved ET shippingMethod === 'fulfillment'
 *   6. TOUS les produits ont delivery_mode === 'smartswika_warehouse'
 *   7. paymentStatus compatible COD (cf. INCOMPATIBLE_PAYMENT_STATUSES)
 *   8. au moins un article (somme des quantités > 0)
 *
 * Le contexte évite tout I/O : il est construit une seule fois par
 * lot de commandes (cf. createGroupedPickupContext) afin de ne lire
 * chaque vendeur et chaque produit qu'une seule fois.
 *
 * @param {object} order Commande Firestore ({ id, ...data })
 * @param {{vendors?: Map<string, object>, products?: Map<string, object>}} ctx
 * @returns {{ eligible: boolean, reasons: string[], vendorIds: string[], productIds: string[], articles: number }}
 */
export function evaluateGroupedPickupOrder(order, ctx = {}) {
    const vendors = ctx.vendors instanceof Map ? ctx.vendors : new Map();
    const products = ctx.products instanceof Map ? ctx.products : new Map();

    const result = {
        eligible: false,
        reasons: [],
        vendorIds: [],
        productIds: [],
        articles: 0
    };

    if (!order || typeof order !== 'object') {
        result.reasons.push(PICKUP_REJECT.NO_ITEMS);
        return result;
    }

    result.vendorIds = getOrderVendorIds(order);
    result.productIds = getOrderProductIds(order);
    result.articles = countGroupedPickupArticles(order);

    /* Règle 1 — statut. */
    if (String(order.status || '').trim() !== 'confirmed') {
        result.reasons.push(PICKUP_REJECT.NOT_CONFIRMED);
    }

    /* Règle 2 — pas déjà rattachée à un ramassage. */
    if (order.livoPickupId) {
        result.reasons.push(PICKUP_REJECT.ALREADY_PICKED_UP);
    }

    /* Règle 3 — des articles. */
    const lines = getOrderLines(order);
    if (lines.length === 0) {
        result.reasons.push(PICKUP_REJECT.NO_ITEMS);
    }

    /* Règle 4 — vendeur unique (hors Plateforme). */
    if (result.vendorIds.length > 1) {
        result.reasons.push(PICKUP_REJECT.MULTI_VENDOR);
    }

    /* Règle 5 — vendeur approved + fulfillment.
       Cas particulier : commande 100 % catalogue plateforme
       (vendorIds vide) → aucune exigence vendeur, seul delivery_mode
       des produits décide (règle 6). */
    for (const vendorId of result.vendorIds) {
        const entry = vendors.get(vendorId);
        if (!entry) {
            result.reasons.push(`${PICKUP_REJECT.VENDOR_UNREADABLE}:${vendorId}`);
            continue;
        }
        if (!entry.exists) {
            result.reasons.push(`${PICKUP_REJECT.VENDOR_UNREADABLE}:${vendorId}`);
            continue;
        }
        const info = entry.vendorInfo || {};
        if (String(info.status || '') !== REQUIRED_VENDOR_STATUS) {
            result.reasons.push(`${PICKUP_REJECT.VENDOR_NOT_APPROVED}:${vendorId}`);
        }
        if (String(info.shippingMethod || '') !== REQUIRED_VENDOR_SHIPPING_METHOD) {
            result.reasons.push(`${PICKUP_REJECT.VENDOR_NOT_FULFILLMENT}:${vendorId}`);
        }
    }

    /* Règle 6 — 100 % entrepôt. */
    for (const productId of result.productIds) {
        const entry = products.get(productId);
        if (!entry) {
            result.reasons.push(`${PICKUP_REJECT.PRODUCT_UNREADABLE}:${productId}`);
            continue;
        }
        if (!entry.exists) {
            result.reasons.push(`${PICKUP_REJECT.PRODUCT_MISSING}:${productId}`);
            continue;
        }
        if (String(entry.delivery_mode || '') !== WAREHOUSE_DELIVERY_MODE) {
            result.reasons.push(`${PICKUP_REJECT.PRODUCT_NOT_WAREHOUSE}:${productId}`);
        }
    }

    /* Règle 7 — paiement compatible COD. */
    const paymentStatus = String(order.paymentStatus || '').trim().toLowerCase();
    if (paymentStatus && INCOMPATIBLE_PAYMENT_STATUSES.has(paymentStatus)) {
        result.reasons.push(`${PICKUP_REJECT.PAYMENT_INCOMPATIBLE}:${paymentStatus}`);
    }

    /* Règle 8 — au moins un article réellement comptable. */
    if (result.articles < 1) {
        result.reasons.push(PICKUP_REJECT.EMPTY_QUANTITY);
    }

    result.eligible = result.reasons.length === 0;
    return result;
}

/* ============================================================
   CONTEXTE DE LOT (lectures Firestore dédoublonnées + cache TTL)
   ============================================================ */

/**
 * TTL du contexte de lot. Sert UNIQUEMENT à l'affichage passif
 * (compteur « X colis en attente »). La décision irréversible
 * (requestGroupedPickup) recalcule toujours sans cache via
 * { bypassCache: true }.
 *
 * RISQUE RÉSIDUEL DOCUMENTÉ : il n'existe aucun onSnapshot
 * d'invalidation. Un changement de delivery_mode ou de
 * shippingMethod effectué hors application (console Firebase, script)
 * peut laisser le compteur faux pendant 30 s maximum. La décision de
 * ramassage n'est jamais prise sur ce cache.
 */
export const GROUPED_PICKUP_CONTEXT_TTL_MS = 30000;

let _contextPromise = null;
let _contextLoadedAt = 0;

/**
 * Invalide le cache de contexte. Appelé par :
 *   - saveProduct (admin.js) après un changement de delivery_mode
 *   - vendor-dashboard.js après un changement de delivery_mode
 *   - requestGroupedPickup après un ramassage créé
 * @returns {void}
 */
export function invalidateGroupedPickupCache() {
    _contextPromise = null;
    _contextLoadedAt = 0;
}

/**
 * Charge (et met en cache) les vendeurs et produits nécessaires pour
 * évaluer un lot de commandes. Une seule lecture Firestore par
 * identifiant distinct, quel que soit le nombre de commandes.
 *
 * @param {object[]} orders
 * @param {{bypassCache?: boolean}} [options]
 * @returns {Promise<{vendors: Map<string,object>, products: Map<string,object>}>}
 */
export async function createGroupedPickupContext(orders, options = {}) {
    const bypassCache = options.bypassCache === true;
    const now = Date.now();

    if (!bypassCache && _contextPromise && (now - _contextLoadedAt) < GROUPED_PICKUP_CONTEXT_TTL_MS) {
        return _contextPromise;
    }

    const list = Array.isArray(orders) ? orders : [];
    const vendorIds = new Set();
    const productIds = new Set();
    for (const order of list) {
        for (const id of getOrderVendorIds(order)) vendorIds.add(id);
        for (const id of getOrderProductIds(order)) productIds.add(id);
    }

    const load = async (collectionName, ids, mapper) => {
        const map = new Map();
        // Lecture séquentielle par paquets : limite la pression Firestore
        // et garde l'ordre déterministe pour les logs.
        const CHUNK = 20;
        const arr = Array.from(ids);
        for (let i = 0; i < arr.length; i += CHUNK) {
            const slice = arr.slice(i, i + CHUNK);
            const snaps = await Promise.all(slice.map(id =>
                getDoc(doc(db, collectionName, id)).catch(() => null)
            ));
            snaps.forEach((snap, index) => {
                const id = slice[index];
                // Une lecture en échec est enregistrée comme non lisible :
                // le prédicat rejettera la commande (fail-closed).
                if (!snap) {
                    map.set(id, { exists: false, unreadable: true });
                    return;
                }
                map.set(id, mapper(snap));
            });
        }
        return map;
    };

    const promise = (async () => {
        const [vendors, products] = await Promise.all([
            load('users', vendorIds, snap => ({
                exists: snap.exists(),
                vendorInfo: snap.exists() ? (snap.data().vendorInfo || {}) : {}
            })),
            load('products', productIds, snap => ({
                exists: snap.exists(),
                delivery_mode: snap.exists() ? snap.data().delivery_mode : null
            }))
        ]);
        return { vendors, products };
    })();

    if (!bypassCache) {
        _contextPromise = promise;
        _contextLoadedAt = now;
    }

    return promise;
}

/**
 * Récupère les commandes éligibles d'un lot déjà chargé.
 * @param {object[]} orders
 * @param {{bypassCache?: boolean}} [options]
 * @returns {Promise<Array<{order: object, evaluation: object}>>}
 */
export async function filterGroupedPickupCandidates(orders, options = {}) {
    const list = Array.isArray(orders) ? orders : [];
    if (list.length === 0) return [];
    const ctx = await createGroupedPickupContext(list, options);
    const out = [];
    for (const order of list) {
        const evaluation = evaluateGroupedPickupOrder(order, ctx);
        if (evaluation.eligible) out.push({ order, evaluation });
    }
    return out;
}

/* ============================================================
   MODALE DE CONFIRMATION NOMINATIVE
   ============================================================ */

/**
 * Échappement HTML local : ce module peut être exécuté dans un
 * contexte vm (backfill/tests) où js/utils.js n'est pas chargeable.
 * @param {*} value
 * @returns {string}
 */
function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[ch]);
}

/**
 * Rend le HTML de la liste nominative des commandes candidates.
 * Fonction pure, testable sans DOM.
 *
 * @param {Array<{order: object, evaluation: object}>} candidates
 * @returns {string}
 */
export function renderGroupedPickupCandidateList(candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    if (list.length === 0) {
        return '<p style="text-align:center;color:var(--text-muted);">Aucune commande éligible.</p>';
    }
    const rows = list.map(({ order, evaluation }) => {
        const shortId = String(order.id || '').slice(0, 8).toUpperCase();
        const name = order.deliveryAddress?.name || 'Client inconnu';
        const city = order.deliveryAddress?.cityFr
            || order.deliveryAddress?.city
            || order.deliveryAddress?.cityAr
            || '—';
        const articles = evaluation?.articles ?? countGroupedPickupArticles(order);
        const total = Number(order.total) || 0;
        return `<li style="display:flex;justify-content:space-between;gap:0.6rem;align-items:baseline;padding:0.45rem 0;border-bottom:1px dashed var(--border);font-size:0.82rem;">
            <span style="min-width:0;">
                <strong style="color:var(--gold);">#${esc(shortId)}</strong>
                <span style="color:var(--text);">${esc(name)}</span>
                <span style="color:var(--text-muted);">· ${esc(city)}</span>
            </span>
            <span style="white-space:nowrap;color:var(--text-muted);">${articles} art. · ${total} MAD</span>
        </li>`;
    }).join('');
    return `<ul style="list-style:none;margin:0;padding:0;max-height:240px;overflow-y:auto;">${rows}</ul>`;
}

/**
 * Affiche la modale de confirmation nominative du ramassage groupé.
 * Remplace confirmAction() pour ce point précis : confirmAction()
 * échappe tout le message via escapeHTML (js/ui-core.js:207) et ne
 * peut donc pas rendre une liste structurée.
 *
 * La modale est construite ici, injectée dans le DOM, puis retirée.
 * Elle respecte le contrat de confirmAction : résout toujours un
 * booléen, jamais de rejet.
 *
 * @param {Array<{order: object, evaluation: object}>} candidates
 * @param {{totalArticles: number, container?: HTMLElement}} options
 * @returns {Promise<boolean>}
 */
export function showGroupedPickupConfirm(candidates, options = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    const totalArticles = Number(options.totalArticles)
        || list.reduce((sum, c) => sum + (c?.evaluation?.articles ?? countGroupedPickupArticles(c?.order)), 0);
    const host = options.container || (typeof document !== 'undefined' ? document.body : null);

    if (!host) {
        // Contexte sans DOM (tests, backfill) : refus explicite plutôt
        // que d'envoyer un ramassage sans confirmation visuelle.
        return Promise.resolve(false);
    }

    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay open';
        overlay.style.zIndex = '20000';
        overlay.setAttribute('role', 'alertdialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'groupedPickupConfirmTitle');

        overlay.innerHTML = `<div class="modal" style="max-width:560px;text-align:left;padding:1.6rem;">
            <div style="font-size:2rem;margin-bottom:0.4rem;line-height:1;">🚚</div>
            <h3 id="groupedPickupConfirmTitle" style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:0.4rem;font-size:1.1rem;">
                Ramassage groupé Livo
            </h3>
            <p style="font-size:0.9rem;color:var(--text);margin-bottom:0.8rem;line-height:1.5;">
                ${list.length} commande(s) · ${totalArticles} colis à enlever à l'entrepôt Smart Swika.
            </p>
            <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.5rem 0.8rem;margin-bottom:1.2rem;background:var(--bg-surface);">
                ${renderGroupedPickupCandidateList(list)}
            </div>
            <div style="display:flex;gap:0.5rem;justify-content:flex-end;flex-wrap:wrap;">
                <button type="button" class="gpc-cancel" style="min-width:110px;padding:0.65rem 1.1rem;background:transparent;border:1px solid var(--border);color:var(--text-muted);border-radius:30px;font-weight:600;cursor:pointer;font-size:0.88rem;">Annuler</button>
                <button type="button" class="gpc-confirm" style="min-width:150px;padding:0.65rem 1.1rem;background:linear-gradient(135deg,var(--gold),#7d5a1d);color:#fff;border:none;border-radius:30px;font-weight:700;cursor:pointer;font-size:0.88rem;">Créer le ramassage</button>
            </div>
        </div>`;

        host.appendChild(overlay);

        const previousFocus = typeof document !== 'undefined' ? document.activeElement : null;
        let settled = false;
        const cleanup = (value) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey);
            try { overlay.remove(); } catch (e) { /* ignore */ }
            try { previousFocus?.focus?.(); } catch (e) { /* ignore */ }
            resolve(value);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
            else if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
        };

        overlay.querySelector('.gpc-cancel')?.addEventListener('click', () => cleanup(false));
        overlay.querySelector('.gpc-confirm')?.addEventListener('click', () => cleanup(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
        document.addEventListener('keydown', onKey);

        setTimeout(() => {
            try { overlay.querySelector('.gpc-confirm')?.focus(); } catch (e) { /* ignore */ }
        }, 80);
    });
}
