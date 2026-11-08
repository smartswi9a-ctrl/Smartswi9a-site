/* ============================================================ js/whatsapp.js COMMANDE VIA WHATSAPP - SMARTSWIKA Version 9.0.0 - Lot 16/30 : normalisation téléphone + guards CHANGEMENTS v9.0.0 : - B-WHA-1 (P2) : normalizeWhatsAppPhone() défensive. Si CONFIG.SHOP.WHATSAPP_NUMBER est au format local '0656613303' (10 chiffres commençant par 0), il est converti en '212656613303'. Empêche le cassage du lien wa.me si la config change de format. - B-WHA-2 (P3) : imports getLang et escapeHTML retirés (jamais utilisés). - B-WHA-3 (P3) : message d'erreur plus explicite si le catalogue n'est pas encore chargé (products = []). - JSDoc sur les 3 exports publics. - Bump version 2.1.0 -> 9.0.0. RAPPEL TECHNIQUE : WhatsApp limite le texte à 4096 caractères (côté texte décodé). truncateMessage coupe proprement au dernier espace ou saut de ligne pour éviter de tronquer un mot. L'URL wa.me n'est PAS limitée par encodeURIComponent (le texte est décodé par WhatsApp). ALERTE 1 : plus aucun commentaire de ligne (//) en début de ligne utile. Tout est en bloc. ============================================================ */

import { CONFIG } from "./config.js";
import { t, getProductName } from "./utils.js";
import { getProducts } from "./store.js";

/* ============================================================ CONSTANTE : Limite WhatsApp (texte décodé) ============================================================ */
const WHATSAPP_MAX_LENGTH = 4096;

/* ============================================================ NORMALISATION D'ID PRODUIT ============================================================ - "42" (chaîne numérique) -> 42 (Number) - "abc123" (auto-ID Firestore vendeur) -> "abc123" (String) - null/undefined/"" -> null Doit rester IDENTIQUE à products.js / cart.js / panier.js / reviews.js. ============================================================ */
function normalizeProductId(id) {
  if (id == null || id === "") return null;
  const n = Number(id);
  return Number.isFinite(n) && String(n) === String(id) ? n : String(id);
}

/* ============================================================ NORMALISATION NUMÉRO WHATSAPP (B-WHA-1) ============================================================ WhatsApp attend le format international sans '+', ex : 212656613303 (Maroc) On accepte en entrée : - '212656613303' -> inchangé - '+212656613303' -> '212656613303' - '00212656613303' -> '212656613303' - '0656613303' -> '212656613303' (format local MA) La règle de conversion ne s'applique QUE si le numéro commence par 0 et fait 10 chiffres (format local marocain). ============================================================ */
function normalizeWhatsAppPhone(raw) {
  let cleaned = String(raw || "").replace(/\D/g, "");
  if (cleaned.startsWith("00212")) {
    cleaned = cleaned.substring(2);
  }
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    cleaned = "212" + cleaned.substring(1);
  }
  return cleaned;
}

/* ============================================================ TRONCATURE PROPRE (WHATSAPP_MAX_LENGTH) ============================================================ Si le message dépasse la limite, on coupe au dernier saut de ligne / espace de la zone autorisée pour éviter de tronquer un mot ou une URL en plein milieu. ============================================================ */
function truncateMessage(msg) {
  if (!msg || msg.length <= WHATSAPP_MAX_LENGTH) return msg;
  const cut = msg.substring(0, WHATSAPP_MAX_LENGTH - 50);
  const lastNewline = cut.lastIndexOf("\n");
  const lastSpace = cut.lastIndexOf(" ");
  const breakpoint = Math.max(lastNewline, lastSpace);
  return (
    (breakpoint > WHATSAPP_MAX_LENGTH * 0.8
      ? cut.substring(0, breakpoint)
      : cut) + "\n\n... (message tronqué)"
  );
}

/* ============================================================ OUVERTURE WHATSAPP + TOAST ============================================================ Ouvre wa.me dans un nouvel onglet avec fallback même onglet si le navigateur bloque la popup. Affiche un toast de succès après ouverture. ============================================================ */
async function openWhatsAppWithToast(message, successMsg = null) {
  const phone = normalizeWhatsAppPhone(CONFIG.SHOP.WHATSAPP_NUMBER);
  if (!phone) {
    console.error("CONFIG.SHOP.WHATSAPP_NUMBER invalide (vide)");
    return false;
  }
  const safeMessage = truncateMessage(message);
  const encoded = encodeURIComponent(safeMessage);
  const url = `https://wa.me/${phone}?text=${encoded}`;

  const win = window.open(url, "_blank", "noopener,noreferrer");

  if (!win || win.closed) {
    /* Popup bloquée : on bascule sur l'onglet courant. C'est acceptable pour une commande WhatsApp (l'utilisateur est déjà en train de finaliser l'action). */
    console.warn("Popup bloquée, fallback même onglet");
    window.location.href = url;
    return false;
  }

  try {
    const { showToast } = await import("./ui-core.js");
    showToast(successMsg || "WhatsApp ouvert - envoyez le message !", 2500);
  } catch (e) {
    /* Non bloquant si ui-core indisponible. */
    console.warn("Toast non affiché :", e);
  }

  return true;
}

/* ============================================================ HELPERS VARIANTE ============================================================ */
function formatVariantLabel(variant) {
  if (!variant) return "";
  const parts = [variant.size, variant.color].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "";
}

/* ============================================================ COMMANDER UN PRODUIT VIA WHATSAPP ============================================================ */

/** * Ouvre WhatsApp avec un message pré-rempli pour commander un * produit (avec variante optionnelle). * * @param {number|string} productId * @param {{ size?: string, color?: string, price?: number } | null} [variant=null] * @returns {Promise<void>} */
export async function orderViaWhatsApp(productId, variant = null) {
  const pid = normalizeProductId(productId);
  if (pid == null) {
    try {
      const { showToast } = await import("./ui-core.js");
      showToast(t("productNotFound"));
    } catch (e) {
      /* ignore */
    }
    return;
  }

  const products = getProducts();
  /* B-WHA-3 : message plus explicite si le catalogue n'est pas encore chargé. */
  if (!products || products.length === 0) {
    console.warn("Catalogue non chargé");
    try {
      const { showToast } = await import("./ui-core.js");
      showToast("Patientez, le catalogue se charge encore...");
    } catch (e) {
      /* ignore */
    }
    return;
  }

  const product = products.find((p) => String(p.id) === String(pid));

  if (!product) {
    console.warn("Produit introuvable :", productId);
    try {
      const { showToast } = await import("./ui-core.js");
      showToast(t("productNotFound"));
    } catch (e) {
      /* ignore */
    }
    return;
  }

  const name = getProductName(product);

  const price =
    variant && Number(variant.price) > 0
      ? Number(variant.price)
      : Number(product.price) || 0;

  const oldPrice =
    !variant && Number(product.oldPrice) > price ? Number(product.oldPrice) : 0;

  const isPromo = oldPrice > price;

  const url = `${CONFIG.SHOP.URL}/produit?slug=${encodeURIComponent( product.slug || "" )}`;

  const variantLabel = formatVariantLabel(variant);

  let msg = `*${t("waNewOrder")}*\n\n`;
  msg += `*${t("waProduct")} :* ${name}\n`;

  if (variantLabel) {
    msg += `${t("comboSize") || "Taille/Couleur"} : *${variantLabel}*\n`;
  }

  msg += `*${t("waPrice")} :* ${price} ${t("currency")}`;
  if (isPromo) {
    msg += ` (${t("waInstead")} ${oldPrice} ${t("currency")})`;
  }
  msg += `\n${url}\n\n`;
  msg += `${t("waName")} : \n`;
  msg += `${t("waPhone")} : \n`;
  msg += `${t("waAddress")} : \n`;
  msg += `${t("waCity")} : \n\n`;
  msg += `${t("waThanks")}`;

  await openWhatsAppWithToast(msg, "WhatsApp ouvert - complétez vos infos !");
}

/* ============================================================ SUPPORT CLIENT (chat direct) ============================================================ */

/** * Ouvre WhatsApp avec un message de support (ou personnalisé). * @param {string} [message=''] * @returns {Promise<void>} */
export async function contactSupport(message = "") {
  const defaultMsg =
    message || `${t("emailHello")} - ${t("navAbout")} Smartswika.`;
  await openWhatsAppWithToast(defaultMsg, "Support WhatsApp ouvert");
}

/* ============================================================ PARTAGER UN PRODUIT (sans numéro spécifique) ============================================================ */

/** * Ouvre le sélecteur de contacts WhatsApp pour partager un produit. * Utilise wa.me/?text= (pas de numéro destinataire = choix du contact). * @param {number|string} productId * @returns {void} */
export function shareProductOnWhatsApp(productId) {
  const pid = normalizeProductId(productId);
  if (pid == null) return;

  const products = getProducts();
  const product = products.find((p) => String(p.id) === String(pid));
  if (!product) return;

  const name = getProductName(product);
  const price = Number(product.price) || 0;
  const url = `${CONFIG.SHOP.URL}/produit?slug=${encodeURIComponent( product.slug || "" )}`;

  const msg =
    `${t("waProduct")} Smartswika :\n\n` +
    `*${name}*\n` +
    `${price} ${t("currency")}\n` +
    `${url}\n\n` +
    `${t("btnPrimary")}`;

  const safeMessage = truncateMessage(msg);
  const encoded = encodeURIComponent(safeMessage);
  const shareUrl = `https://wa.me/?text=${encoded}`;

  const win = window.open(shareUrl, "_blank", "noopener,noreferrer");
  if (!win || win.closed) {
    window.location.href = shareUrl;
  }
}

/* ============================================================ LOG ============================================================ */
console.log(
  "✅ whatsapp.js chargé - v9.0.0 (Lot 16 : normalize phone + guards)"
);