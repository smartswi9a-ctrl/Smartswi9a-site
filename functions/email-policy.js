/* ============================================================
   functions/email-policy.js — POLITIQUE EMAIL (PURE, TESTABLE)
   ------------------------------------------------------------
   Mode économie stricte : 5 emails automatiques au total.
     VENDEUR (4) : ramassage approuvé, marchandise reçue,
                   nouvelle commande, suspension.
     CLIENT  (1) : confirmation initiale de commande.
   ADMIN : aucun email, jamais (push + in-app uniquement).
   Aucune dépendance : importable par les tests unitaires.
   ============================================================ */

const SELLER_TYPES = Object.freeze([
  'seller_pickup_approved',
  'seller_warehouse_received',
  'seller_new_order',
  'seller_suspended'
]);

const CLIENT_TYPES = Object.freeze(['client_order_confirmation']);

/** Vrai uniquement pour les 5 emails autorisés. */
function shouldSendEmail(role, type) {
  const r = String(role || '').toLowerCase();
  const t = String(type || '');
  if (r === 'admin') return false;
  if (r === 'seller' || r === 'vendor') return SELLER_TYPES.includes(t);
  if (r === 'client' || r === 'user') return CLIENT_TYPES.includes(t);
  return false;
}

/** Mois calendaire à l'heure du Maroc : 'YYYY-MM'.
 *  Offset explicite UTC+1 (règle permanente depuis 2018, hors Ramadan) :
 *  Intl/ICU varie selon les plateformes (CI Ubuntu vs Windows), donc on ne
 *  dépend plus du tzdata pour un calcul aussi critique que le quota. */
function monthKey(date = new Date()) {
  const shifted = new Date(date.getTime() + 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

module.exports = { SELLER_TYPES, CLIENT_TYPES, shouldSendEmail, monthKey };
