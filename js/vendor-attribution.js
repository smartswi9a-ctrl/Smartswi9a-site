/* ============================================================ js/vendor-attribution.js ATTRIBUTION VENDEUR - SMART SWI9A Version 9.0.0 - Lot 6/30 : dédup fetch, statut honnête, doc CHANGEMENTS v9.0.0 : - B-VA-1 (P1) : déduplication des fetch en cours via _pendingFetch (Map<uid, Promise>). Empêche N appels Firestore pour le même vendor si preloadVendorsForProducts() est appelée plusieurs fois en parallèle. - X2 (P2) : _resolveOwner() local remplace getProductOwner() pour rendre explicite le cas vendorId === '' (traité comme Smart). - B-VA-2 (P2) : getProductVendorLabelSync retourne status:'unknown' (au lieu de 'approved') quand product.vendorName est présent mais que le cache ne connaît pas le vendeur. Plus honnête, comportement aval identique. - JSDoc sur tous les exports. - Documentation : limitation "pas de TTL" et "pas d'invalidation à la déconnexion" (données publiques, risque limité à une session). - Bump version 1.1.0 -> 9.0.0. RAPPEL ARCHITECTURAL : - Ce module lit UNIQUEMENT vendorsPublic/{uid} (données publiques non sensibles : shopName, status). - Fallback users/{uid} réservé au vendeur propriétaire du compte courant (permet de voir son propre nom avant écriture de vendorsPublic par l'admin). - Les champs PII (email, phone, iceCin, city, adresse complète) ne sont JAMAIS lus ici. ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import {
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  limit,
} from "firebase/firestore";
import { db, auth } from "./firebase.js";

/* ============================================================ ÉTAT ============================================================ _vendorCache : Map<uid, { shopName, status }> Cache mémoire, vit pendant la durée de la page (session). Pas de TTL : un rechargement de page le vide. Pas d'invalidation sur suspension d'un vendeur : impact limité à la session courante (données publiques, non PII). _pendingFetch : Map<uid, Promise> Déduplication des fetch en cours. Si deux appels demandent le même uid simultanément, un seul getDoc est fait. ============================================================ */
const _vendorCache = new Map();
const _pendingFetch = new Map();
let _allVendorsPreloaded = false;

const GENERIC_SHOP_NAME = "Boutique";
const SMART_NAME = "Smart Swi9a";
const SMART_OWNER_ID = "smartswi9a";

/* ============================================================ HELPERS INTERNES ============================================================ */

/** * Récupère l'UID de l'utilisateur Firebase courant (ou null). * Utilisé pour le fallback users/{uid} réservé au propriétaire. * @returns {string|null} */
function _currentUid() {
  try {
    return auth?.currentUser?.uid || null;
  } catch (_) {
    return null;
  }
}

/** * Résout le propriétaire d'un produit. * Équivalent local de getProductOwner() de config.js, mais traite * explicitement le cas vendorId === '' (chaîne vide) : retourne * 'smartswi9a' au lieu de "" (bug silencieux X2). * @param {Object|null} product * @returns {string|null} */
function _resolveOwner(product) {
  if (!product) return null;
  const vid = product.vendorId;
  if (typeof vid === "string") {
    const trimmed = vid.trim();
    return trimmed.length > 0 ? trimmed : SMART_OWNER_ID;
  }
  return vid || SMART_OWNER_ID;
}

/** * Charge (best-effort) un vendeur dans le cache, avec dédup des * fetch en cours. * * Priorité : * 1. vendorsPublic/{uid} — collection publique non sensible. * 2. users/{uid} — SEULEMENT si c'est notre propre profil * (permission-denied attendu pour les * autres users, non loggé). * * @param {string} uid * @returns {Promise<void>} */
async function _fetchVendorIntoCache(uid) {
  if (!uid || uid === SMART_OWNER_ID) return;
  if (_vendorCache.has(uid)) return;

  /* B-VA-1 : si un fetch est déjà en cours pour ce uid, on attend le même Promise au lieu d'en lancer un nouveau. */
  if (_pendingFetch.has(uid)) {
    return _pendingFetch.get(uid);
  }

  const promise = (async () => {
    /* 1. vendorsPublic */
    try {
      const snap = await getDoc(doc(db, "vendorsPublic", uid));
      if (snap.exists()) {
        const data = snap.data();
        _vendorCache.set(uid, {
          shopName: data.shopName || GENERIC_SHOP_NAME,
          status: data.status || "pending",
        });
        return;
      }
    } catch (e) {
      if (e?.code !== "permission-denied") {
        console.warn(
          "[vendor-attribution] vendorsPublic/" + uid + " :",
          e?.code || e
        );
      }
    }

    /* 2. Fallback users/{ownUid} */
    if (_currentUid() === uid) {
      try {
        const snap = await getDoc(doc(db, "users", uid));
        if (snap.exists()) {
          const data = snap.data();
          if (data && data.vendorInfo && data.vendorInfo.shopName) {
            _vendorCache.set(uid, {
              shopName: data.vendorInfo.shopName,
              status: data.vendorInfo.status || "pending",
            });
          }
        }
      } catch (e) {
        if (e?.code !== "permission-denied") {
          console.warn(
            "[vendor-attribution] users/" + uid + " (own) :",
            e?.code || e
          );
        }
      }
    }
  })();

  _pendingFetch.set(uid, promise);
  try {
    await promise;
  } finally {
    _pendingFetch.delete(uid);
  }
}

/* ============================================================ PRÉCHARGEMENT ============================================================ */

/** * ⚠️ DÉPRÉCIÉ — préférez preloadVendorsForProducts(products). * Précharge jusqu'à 200 vendeurs depuis vendorsPublic. * * Conservé pour compatibilité ; les appelants existants continuent * de fonctionner sans modification. En cas d'échec réseau, retourne * false (retry possible). * * @returns {Promise<boolean>} true si le préchargement a réussi. */
export async function preloadVendorNames() {
  if (_allVendorsPreloaded) return true;
  try {
    const q = query(collection(db, "vendorsPublic"), limit(200));
    const snap = await getDocs(q);
    snap.forEach((d) => {
      const data = d.data();
      _vendorCache.set(d.id, {
        shopName: data.shopName || GENERIC_SHOP_NAME,
        status: data.status || "pending",
      });
    });
    _allVendorsPreloaded = true;
    return true;
  } catch (e) {
    console.warn(
      "[vendor-attribution] Préchargement vendorsPublic échoué:",
      e?.code || e
    );
    return false;
  }
}

/** * Précharge UNIQUEMENT les vendeurs des produits passés en argument. * À appeler depuis products.js / boutique.js / product-detail.js / ui.js * après avoir chargé la liste de produits affichés. * * Seuls les produits sans `vendorName` déjà présent déclenchent une * lecture. Aucune donnée sensible n'est lue (vendorsPublic/{uid} * uniquement). * * @param {Array<Object>} products * @returns {Promise<void>} */
export async function preloadVendorsForProducts(products) {
  if (!Array.isArray(products) || !products.length) return;

  const uids = new Set();
  for (const p of products) {
    if (!p) continue;
    if (p.vendorName) continue; // label déjà porté par le produit
    const owner = _resolveOwner(p);
    if (!owner || owner === SMART_OWNER_ID) continue;
    if (_vendorCache.has(owner)) continue;
    uids.add(owner);
  }

  if (!uids.size) return;
  await Promise.all([...uids].map((uid) => _fetchVendorIntoCache(uid)));
}

/* ============================================================ LABEL — VERSION SYNCHRONE (cache uniquement) ============================================================ */

/** * Version synchrone, à utiliser dans les boucles de rendu. * Ne fait AUCUN appel réseau. Résout dans l'ordre : * 1. `product.vendorName` (porté par le produit — cas idéal) * 2. `_vendorCache` (préchargé via preloadVendorsForProducts) * 3. Fallback générique (« Boutique » / statut `unknown`) * * B-VA-2 : quand `product.vendorName` est présent mais que le cache * ne connaît pas le vendeur, on retourne `status: 'unknown'` (au lieu * de 'approved' auparavant). Cela évite de mentir sur un statut qu'on * ne connaît pas. Le comportement aval est identique : 'unknown' n'est * jamais filtré comme 'suspended' ou 'rejected'. * * @param {Object|null} product * @returns {{ name: string, type: 'smart'|'vendor', status?: string }} */
export function getProductVendorLabelSync(product) {
  if (!product) return { name: SMART_NAME, type: "smart" };

  if (
    product.vendorName &&
    product.vendorId &&
    product.vendorId !== SMART_OWNER_ID
  ) {
    const owner = product.vendorId;
    const cached = _vendorCache.get(owner);
    return {
      name: product.vendorName,
      type: "vendor",
      /* B-VA-2 : 'unknown' plutôt que 'approved' — honnête. */
      status: cached?.status || "unknown",
    };
  }

  const owner = _resolveOwner(product);
  if (!owner || owner === SMART_OWNER_ID) {
    return { name: SMART_NAME, type: "smart" };
  }

  const cached = _vendorCache.get(owner);
  return {
    name: cached?.shopName || GENERIC_SHOP_NAME,
    type: "vendor",
    status: cached?.status || "unknown",
  };
}

/* ============================================================ LABEL — VERSION ASYNCHRONE (résolution à la demande) ============================================================ */

/** * Version asynchrone : tente de résoudre le nom du vendeur si le * cache ne le connaît pas encore. À utiliser lorsqu'on affiche UN * SEUL produit (page détail, order item) ou lorsqu'on veut le statut * frais. * * @param {Object} product * @returns {Promise<{ name: string, type: 'smart'|'vendor', status?: string }>} */
export async function getProductVendorLabel(product) {
  const syncResult = getProductVendorLabelSync(product);

  /* Produit Smart Swi9a : rien à chercher. */
  if (syncResult.type === "smart") return syncResult;
  /* Cache déjà rempli avec un vrai nom : pas d'appel réseau. */
  if (syncResult.name && syncResult.name !== GENERIC_SHOP_NAME)
    return syncResult;

  const owner = _resolveOwner(product);
  if (!owner || owner === SMART_OWNER_ID) return syncResult;

  await _fetchVendorIntoCache(owner);
  return getProductVendorLabelSync(product);
}

/* ============================================================ RESET ============================================================ */

/** * Réinitialise complètement le cache. * Utilisé principalement pour les tests ou après un changement de * compte utilisateur. Les données étant publiques (shopName, status), * un reset n'est pas nécessaire à la déconnexion. */
export function resetVendorCache() {
  _vendorCache.clear();
  _pendingFetch.clear();
  _allVendorsPreloaded = false;
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ vendor-attribution.js chargé - v9.0.0 (Lot 6 : dédup fetch + statut honnête)"
);