/* ============================================================ js/notifications.js NOTIFICATIONS CLIENT - SMART SWI9A Version 9.0.0 - Lot 11/30 : corrections P1 (double modal, double fetch) CHANGEMENTS v9.0.0 : - B-NOTIF-1 (P1) : markAllAsRead handler ne rouvre plus le panel ; à la place, re-render du contenu + retrait du bouton "tout lire". openNotificationsPanel() retire toute modale existante avant en créer une nouvelle (défense en profondeur). - B-NOTIF-2 (P1) : _lastLoadedUserId pour éviter le double loadNotifications() au démarrage (initNotificationBell + listener auth-updated). Un seul fetch par uid. - B-NOTIF-3 (P1) : deleteReviewRequestForOrder utilise une query 1 clause (userId) + filtre client-side, car l'index composite (userId + orderId + type) n'existe pas en Firestore. - B-NOTIF-4 (P2) : getNotificationIcon enrichi (vendor_*, payout_*, fulfillment_*). - B-NOTIF-5 (P2) : guard _notificationsLoading pour éviter les fetch concurrents. - JSDoc sur tous les exports publics. - Bump version 2.0.0 -> 9.0.0. LIMITATION CONNUE (à traiter au Lot 13 - reviews.js) : deleteReviewRequestForOrder() n'est branchée NULLE PART actuellement. Les notifications review_request persistent jusqu'à suppression de la commande via admin. À brancher dans reviews.js:createReview() quand l'orderId sera disponible. ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import {
  collection,
  query,
  where,
  getDocs,
  doc,
  updateDoc,
  deleteDoc,
  Timestamp,
  writeBatch,
  addDoc,
  orderBy,
  limit,
} from "firebase/firestore";
import { db } from "./firebase.js";
import { NOTIFICATION_TYPES } from "./config.js";
import { t, escapeHTML, formatDateTime, toDate } from "./utils.js";
import { getCurrentUser } from "./auth.js";
import { showToast, trapFocus, releaseFocusTrap } from "./ui-core.js";

/* ============================================================ ÉTAT LOCAL ============================================================ */
let notificationsCache = [];
let unreadCount = 0;

/* B-NOTIF-2 : tracker le dernier userId chargé pour éviter le double fetch au démarrage (initNotificationBell + auth-updated). */
let _lastLoadedUserId = null;

/* B-NOTIF-5 : guard pour éviter les fetch concurrents. */
let _notificationsLoading = false;

const REVIEW_REQUEST_TYPE = "review_request";

/* ============================================================ LISTENER AUTH-UPDATED (module-level) ============================================================ Reset au logout. Recharge au login (si uid a changé). ============================================================ */
if (typeof document !== "undefined") {
  document.addEventListener("auth-updated", async (e) => {
    const user = e.detail?.user;
    if (!user) {
      notificationsCache = [];
      unreadCount = 0;
      _lastLoadedUserId = null;
      updateNotificationBadge();
    } else if (user.uid !== _lastLoadedUserId) {
      /* B-NOTIF-2 : ne pas recharger si le même utilisateur est déjà chargé. Évite le double fetch init. */
      _lastLoadedUserId = user.uid;
      await loadNotifications();
      updateNotificationBadge();
    }
  });
}

/* ============================================================ CHARGEMENT DES NOTIFICATIONS ============================================================ */

/** * Charge les 50 dernières notifications de l'utilisateur courant. * Limite à 50 pour économiser le quota Firestore. * * @returns {Promise<Array>} liste des notifications. */
export async function loadNotifications() {
  const user = getCurrentUser();
  if (!user) {
    notificationsCache = [];
    unreadCount = 0;
    updateNotificationBadge();
    return [];
  }

  /* B-NOTIF-5 : si un fetch est déjà en cours pour le même uid, on retourne le cache courant (l'appelant se fiera à l'event auth-updated ou au prochain appel pour le résultat frais). */
  if (_notificationsLoading) {
    return notificationsCache;
  }

  _notificationsLoading = true;
  try {
    const q = query(
      collection(db, "notifications"),
      where("userId", "==", user.uid),
      orderBy("createdAt", "desc"),
      limit(50)
    );
    const snapshot = await getDocs(q);

    notificationsCache = snapshot.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        createdAt: toDate(data.createdAt),
      };
    });

    /* Ne compter QUE les non-lus qui ne sont PAS des review_request. */
    unreadCount = notificationsCache.filter(
      (n) => !n.read && !isReviewRequest(n)
    ).length;
    updateNotificationBadge();
    return notificationsCache;
  } catch (e) {
    console.error("Erreur chargement notifications :", e);
    return [];
  } finally {
    _notificationsLoading = false;
  }
}

/* ============================================================ BADGE ============================================================ */

/** * Met à jour le badge visuel et la visibilité de la cloche. * - Affiche/masque la cloche selon login. * - Compte : non-lus (hors review_request) + tous les review_request. * - Couleur : or si uniquement des review_request, rouge sinon. * @returns {void} */
export function updateNotificationBadge() {
  const badge = document.getElementById("notificationBadge");
  const bell = document.getElementById("notificationBell");

  if (bell) {
    const user = getCurrentUser();
    bell.style.display = user ? "flex" : "none";
  }

  if (!badge) return;

  const pendingReviews = notificationsCache.filter((n) =>
    isReviewRequest(n)
  ).length;
  const totalBadge = unreadCount + pendingReviews;

  if (totalBadge > 0) {
    badge.textContent = totalBadge > 9 ? "9+" : totalBadge;
    badge.style.display = "flex";

    if (unreadCount === 0 && pendingReviews > 0) {
      badge.style.background = "var(--gold)";
    } else {
      badge.style.background = "var(--danger)";
    }
  } else {
    badge.style.display = "none";
  }
}

/* ============================================================ ICÔNE SELON LE TYPE ============================================================ */
function getNotificationIcon(type) {
  const icons = {
    [NOTIFICATION_TYPES.ORDER_CREATED]: "🛒",
    [NOTIFICATION_TYPES.ORDER_CONFIRMED]: "✅",
    [NOTIFICATION_TYPES.ORDER_SHIPPING]: "🚚",
    [NOTIFICATION_TYPES.ORDER_DELIVERED]: "📦",
    [NOTIFICATION_TYPES.ORDER_RETURNED]: "↩️",
    [NOTIFICATION_TYPES.ORDER_CANCELLED]: "❌",
    [NOTIFICATION_TYPES.REVIEW_APPROVED]: "⭐",
    [NOTIFICATION_TYPES.WALLET_UNLOCKED]: "💰",
    [NOTIFICATION_TYPES.PAYOUT_APPROVED]: "💸",
    [NOTIFICATION_TYPES.PAYOUT_PAID]: "💸",
    [NOTIFICATION_TYPES.PAYOUT_REJECTED]: "💸",
    [NOTIFICATION_TYPES.VENDOR_OVERDUE]: "⏰",
    [NOTIFICATION_TYPES.VENDOR_SUSPENDED]: "🚫",
    [NOTIFICATION_TYPES.FULFILLMENT_APPROVED]: "📥",
    [NOTIFICATION_TYPES.FULFILLMENT_REJECTED]: "📥",
    [NOTIFICATION_TYPES.FULFILLMENT_LABEL_READY]: "🏷️",
    [NOTIFICATION_TYPES.FULFILLMENT_RECEIVED]: "📥",
    [NOTIFICATION_TYPES.FULFILLMENT_DEPLETED]: "🪫",
    [NOTIFICATION_TYPES.FULFILLMENT_OVERDUE]: "⏰",
    [NOTIFICATION_TYPES.STORAGE_FEE_CHARGED]: "🏬",
    /* Types créés par admin.js mais pas dans NOTIFICATION_TYPES. */
    vendor_approved: "✅",
    vendor_rejected: "❌",
    vendor_suspended: "🚫",
    payout_paid: "💸",
    payout_rejected: "❌",
    [REVIEW_REQUEST_TYPE]: "⭐",
  };
  return icons[type] || "🔔";
}

function isReviewRequest(notif) {
  return notif && notif.type === REVIEW_REQUEST_TYPE;
}

/* ============================================================ PANNEAU DES NOTIFICATIONS ============================================================ */

/** * Ouvre le panneau modal des notifications (charge puis rend). * Ferme toute modale existante d'abord (B-NOTIF-1). * @returns {Promise<void>} */
export async function openNotificationsPanel() {
  const user = getCurrentUser();
  if (!user) {
    showToast("🔒 " + t("loginRequired"));
    return;
  }

  /* B-NOTIF-1 : retirer toute modale existante avant création. */
  const existing = document.getElementById("notificationsPanel");
  if (existing) existing.remove();

  await loadNotifications();

  const panel = document.createElement("div");
  panel.id = "notificationsPanel";
  panel.className = "modal-overlay open";
  panel.style.zIndex = "2500";
  panel.innerHTML = ` <div class="modal" style="max-width:500px;"> <button class="modal-close" id="closeNotificationsBtn">✕</button> <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:1rem;"> ${t("notifications")} </h2> <div id="notificationsContent" style="max-height:60vh;overflow-y:auto;"></div> ${ notificationsCache.filter((n) => !n.read && !isReviewRequest(n)) .length > 0 ? ` <button id="markAllReadBtn" class="btn-secondary" style="width:100%;margin-top:1rem;justify-content:center;"> ✅ ${t("markAllRead")} </button> ` : "" } </div> `;
  document.body.appendChild(panel);

  renderNotificationsContent();

  const modalEl = panel.querySelector(".modal");
  trapFocus(modalEl);

  const closePanel = () => {
    releaseFocusTrap();
    panel.remove();
    document.removeEventListener("keydown", escHandler);
  };

  const escHandler = (e) => {
    if (e.key === "Escape") closePanel();
  };
  document.addEventListener("keydown", escHandler);

  document
    .getElementById("closeNotificationsBtn")
    .addEventListener("click", closePanel);
  panel.addEventListener("click", (e) => {
    if (e.target === panel) closePanel();
  });

  const markAllBtn = document.getElementById("markAllReadBtn");
  if (markAllBtn) {
    markAllBtn.addEventListener("click", async () => {
      await markAllAsRead();
      /* B-NOTIF-1 : ne PAS rouvrir le panel. Re-render in-place. */
      renderNotificationsContent();
      markAllBtn.remove();
      showToast(t("markAllRead"));
    });
  }
}

/* ============================================================ RENDU DU CONTENU ============================================================ */
function renderNotificationsContent() {
  const container = document.getElementById("notificationsContent");
  if (!container) return;

  if (notificationsCache.length === 0) {
    container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted);"><div style="font-size:3rem;margin-bottom:0.5rem;">🔕</div><p>${t( "noNotifications" )}</p></div>`;
    return;
  }

  /* Review_request en premier, puis tri par date DESC. */
  const sorted = [...notificationsCache].sort((a, b) => {
    const aIsReview = isReviewRequest(a);
    const bIsReview = isReviewRequest(b);
    if (aIsReview && !bIsReview) return -1;
    if (!aIsReview && bIsReview) return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  let html = "";
  sorted.forEach((notif) => {
    const icon = getNotificationIcon(notif.type);
    const isUnread = !notif.read;
    const reviewReq = isReviewRequest(notif);
    const date = formatDateTime(notif.createdAt);
    const safeId = escapeHTML(notif.id);

    const borderStyle = reviewReq
      ? "border:2px solid var(--gold);background:linear-gradient(135deg,rgba(165,123,46,0.08),rgba(165,123,46,0.02));"
      : "";

    const deleteBtnHtml = reviewReq
      ? `<span style="font-size:0.65rem;background:var(--gold);color:#fff;padding:0.15rem 0.5rem;border-radius:30px;font-weight:700;white-space:nowrap;">⭐ À faire</span>`
      : `<button class="notif-delete-btn" data-notif-id="${safeId}" title="Supprimer" style="background:transparent;border:none;color:var(--text-dim);cursor:pointer;font-size:1rem;">✕</button>`;

    html += ` <div class="notification-item ${isUnread ? "unread" : ""} ${ reviewReq ? "review-request" : "" }" data-notif-id="${safeId}" style="${borderStyle}"> <div class="notification-icon">${icon}</div> <div class="notification-content"> <div class="notification-title">${escapeHTML( notif.title || "" )}</div> <div class="notification-message">${escapeHTML( notif.message || "" )}</div> <div class="notification-date">${date}</div> </div> ${deleteBtnHtml} </div> `;
  });
  container.innerHTML = html;

  container.querySelectorAll(".notification-item").forEach((item) => {
    item.addEventListener("click", async (e) => {
      if (e.target.closest(".notif-delete-btn")) return;
      const notifId = item.dataset.notifId;
      const notif = notificationsCache.find((n) => n.id === notifId);
      if (notif) await handleNotificationClick(notif);
    });
  });

  container.querySelectorAll(".notif-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteNotification(btn.dataset.notifId);
      renderNotificationsContent();
    });
  });
}

/* ============================================================ CLIC SUR UNE NOTIFICATION ============================================================ */
async function handleNotificationClick(notif) {
  const reviewReq = isReviewRequest(notif);

  /* Marquer comme lu UNIQUEMENT si non-review-request et non-lu. */
  if (!notif.read && !reviewReq) {
    await markAsRead(notif.id);
    notif.read = true;
    unreadCount = Math.max(0, unreadCount - 1);
    updateNotificationBadge();
  }

  /* Fermer le panel. */
  const panel = document.getElementById("notificationsPanel");
  if (panel) {
    releaseFocusTrap();
    panel.remove();
  }

  /* Navigation. */
  if (reviewReq && notif.orderId) {
    document.dispatchEvent(
      new CustomEvent("open-account-orders", {
        detail: { orderId: notif.orderId, filter: "delivered" },
      })
    );
    return;
  }

  if (notif.orderId) {
    document.dispatchEvent(
      new CustomEvent("open-account-orders", {
        detail: { orderId: notif.orderId },
      })
    );
  } else if (notif.type === NOTIFICATION_TYPES.REVIEW_APPROVED) {
    if (notif.productSlug)
      window.location.href = `/produit?slug=${encodeURIComponent( notif.productSlug )}`;
    else showToast(t("productNotFound"));
  }
}

/* ============================================================ MARQUER LUE / TOUT LIRE / SUPPRIMER ============================================================ */

/** * Marque une notification comme lue (Firestore + cache). * @param {string} notifId * @returns {Promise<void>} */
export async function markAsRead(notifId) {
  try {
    await updateDoc(doc(db, "notifications", notifId), { read: true });
    const notif = notificationsCache.find((n) => n.id === notifId);
    if (notif) notif.read = true;
  } catch (e) {
    if (e.code === "permission-denied") showToast(t("error"));
  }
}

/** * Marque toutes les notifications non-lues (hors review_request) comme lues. * @returns {Promise<void>} */
export async function markAllAsRead() {
  const user = getCurrentUser();
  if (!user) return;
  try {
    const batch = writeBatch(db);
    notificationsCache.forEach((notif) => {
      if (!notif.read && !isReviewRequest(notif)) {
        batch.update(doc(db, "notifications", notif.id), { read: true });
        notif.read = true;
      }
    });
    await batch.commit();
    unreadCount = notificationsCache.filter(
      (n) => !n.read && !isReviewRequest(n)
    ).length;
    updateNotificationBadge();
  } catch (e) {
    console.error(e);
  }
}

/** * Supprime une notification. Bloqué pour les review_request * (qui ne peuvent être retirées qu'en déposant l'avis ou en * supprimant la commande via admin). * @param {string} notifId * @returns {Promise<void>} */
export async function deleteNotification(notifId) {
  try {
    const notif = notificationsCache.find((n) => n.id === notifId);
    if (notif && isReviewRequest(notif)) {
      showToast("Déposez d'abord votre avis");
      return;
    }
    await deleteDoc(doc(db, "notifications", notifId));
    if (notif && !notif.read) {
      unreadCount = Math.max(0, unreadCount - 1);
      updateNotificationBadge();
    }
    notificationsCache = notificationsCache.filter((n) => n.id !== notifId);
    showToast(t("delete"));
  } catch (e) {
    console.error(e);
  }
}

/* ============================================================ CRÉER / SUPPRIMER (Admin & Système) ============================================================ */

/** * Crée une notification Firestore. * @param {string} userId * @param {string} type * @param {string} title * @param {string} message * @param {Object} [extra={}] - champs additionnels (orderId, productSlug, etc.). * @returns {Promise<boolean>} */
export async function createNotification( userId, type, title, message, extra = {} ) {
  try {
    await addDoc(collection(db, "notifications"), {
      userId,
      type,
      title,
      message,
      read: false,
      createdAt: Timestamp.now(),
      ...extra,
    });
    return true;
  } catch (e) {
    return false;
  }
}

/** * Supprime les notifications review_request liées à une commande. * * B-NOTIF-3 : utilise une query 1 clause (userId) + filtre client-side * pour éviter un index composite (userId + orderId + type) non présent * dans firestore.indexes.json. * * LIMITATION : cette fonction n'est appelée NULLE PART actuellement. * À brancher dans reviews.js:createReview() quand l'orderId sera * disponible (Lot 13). * * @param {string} orderId * @returns {Promise<void>} */
export async function deleteReviewRequestForOrder(orderId) {
  const user = getCurrentUser();
  if (!user || !orderId) return;
  try {
    const q = query(
      collection(db, "notifications"),
      where("userId", "==", user.uid),
      limit(100)
    );
    const snap = await getDocs(q);
    const toDelete = snap.docs.filter((d) => {
      const data = d.data();
      return data.type === REVIEW_REQUEST_TYPE && data.orderId === orderId;
    });
    if (toDelete.length === 0) return;
    await Promise.allSettled(toDelete.map((d) => deleteDoc(d.ref)));
    notificationsCache = notificationsCache.filter(
      (n) => !(n.type === REVIEW_REQUEST_TYPE && n.orderId === orderId)
    );
    updateNotificationBadge();
  } catch (e) {
    console.warn("deleteReviewRequestForOrder :", e);
  }
}

/* ============================================================ CLOCHE DE NOTIFICATION ============================================================ */

/** * Injecte le bouton cloche dans la navbar (idempotent). * @returns {void} */
export function injectNotificationBell() {
  const navRight = document.querySelector(".nav-right");
  if (!navRight || document.getElementById("notificationBell")) return;

  const bell = document.createElement("button");
  bell.id = "notificationBell";
  bell.className = "notification-bell";
  bell.setAttribute("aria-label", "Notifications");
  bell.style.display = "none";
  bell.innerHTML = `🔔<span class="notification-badge" id="notificationBadge" style="display:none;">0</span>`;

  const accountBtn = document.getElementById("accountBtn");
  if (accountBtn && accountBtn.parentNode)
    accountBtn.parentNode.insertBefore(bell, accountBtn);
  else navRight.appendChild(bell);
}

/** * Initialise la cloche : injection + listeners + affichage. * B-NOTIF-2 : ne charge PAS les notifications ici (le listener * auth-updated le fait). Évite le double fetch au démarrage. * @returns {void} */
export function initNotificationBell() {
  injectNotificationBell();
  const bell = document.getElementById("notificationBell");
  if (!bell) return;

  const user = getCurrentUser();
  bell.style.display = user ? "flex" : "none";

  if (!bell._initialized) {
    bell.addEventListener("click", openNotificationsPanel);
    bell._initialized = true;
  }
}

/* ============================================================ LISTENER REVIEW-SUBMITTED ============================================================ Après qu'un avis a été déposé, on recharge les notifications (au cas où la notif review_request ait été supprimée côté reviews.js une fois branché). Ne supprime pas la notif directement (voir deleteReviewRequestForOrder). ============================================================ */
if (typeof document !== "undefined") {
  document.addEventListener("review-submitted", async () => {
    const user = getCurrentUser();
    if (!user) return;
    await loadNotifications();
    updateNotificationBadge();
  });
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ notifications.js chargé - v9.0.0 (Lot 11 : double modal + double fetch corrigés)"
);