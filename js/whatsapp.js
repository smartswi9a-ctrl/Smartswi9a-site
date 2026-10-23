// js/whatsapp.js
// ============================================================
// COMMANDE VIA WHATSAPP - SMART SWI9A
// Version 2.1.0 — Marketplace (IDs vendeurs Number/String)
// ============================================================

import { CONFIG } from "./config.js";
import { t, getProductName, getLang, escapeHTML } from "./utils.js";
import { getProducts } from "./store.js";

// ============================================================
// CONSTANTE : Limite WhatsApp (URL)
// ============================================================
const WHATSAPP_MAX_LENGTH = 4096;

// ============================================================
// NORMALISATION D'ID PRODUIT
// - "42" (chaîne numérique) → 42 (Number)
// - "abc123" (auto-ID Firestore vendeur) → "abc123" (String)
// - null/undefined/"" → null
// Identique à products.js / cart.js / panier.js / reviews.js
// ============================================================
function normalizeProductId(id) {
    if (id == null || id === '') return null;
    const n = Number(id);
    return Number.isFinite(n) && String(n) === String(id) ? n : String(id);
}

// ============================================================
// ✅ M17.1 : Troncature propre du message
// ============================================================
function truncateMessage(msg) {
    if (!msg || msg.length <= WHATSAPP_MAX_LENGTH) return msg;
    const cut = msg.substring(0, WHATSAPP_MAX_LENGTH - 50);
    const lastNewline = cut.lastIndexOf('\n');
    const lastSpace = cut.lastIndexOf(' ');
    const breakpoint = Math.max(lastNewline, lastSpace);
    return (breakpoint > WHATSAPP_MAX_LENGTH * 0.8
        ? cut.substring(0, breakpoint)
        : cut) + '\n\n... (message tronqué)';
}

// ============================================================
// ✅ M17.3 : OUVRIR WHATSAPP + TOAST
// ============================================================
async function openWhatsAppWithToast(message, successMsg = null) {
    const phone = String(CONFIG.SHOP.WHATSAPP_NUMBER).replace(/\D/g, '');
    const safeMessage = truncateMessage(message);
    const encoded = encodeURIComponent(safeMessage);
    const url = `https://wa.me/${phone}?text=${encoded}`;

    const win = window.open(url, '_blank', 'noopener,noreferrer');

    if (!win || win.closed || typeof win.closed === 'undefined') {
        console.warn('⚠️ Popup bloquée, fallback même onglet');
        window.location.href = url;
        return false;
    }

    try {
        const { showToast } = await import("./ui-core.js");
        showToast(successMsg || '📱 WhatsApp ouvert — envoyez le message !', 2500);
    } catch (e) {
        console.warn('⚠️ Toast non affiché :', e);
    }

    return true;
}

// ============================================================
// FORMATER UNE VARIANTE (label lisible)
// ============================================================
function formatVariantLabel(variant) {
    if (!variant) return '';
    const parts = [variant.size, variant.color].filter(Boolean);
    return parts.length > 0 ? parts.join(' / ') : '';
}

// ============================================================
// ✅ I17.1 : COMMANDER UN PRODUIT VIA WHATSAPP (avec variant)
// ============================================================
export async function orderViaWhatsApp(productId, variant = null) {
    const pid = normalizeProductId(productId);
    if (pid == null) {
        try {
            const { showToast } = await import("./ui-core.js");
            showToast('❌ ' + t('productNotFound'));
        } catch (e) { /* ignore */ }
        return;
    }

    const products = getProducts();
    // Comparaison par String (patch W1)
    const product = products.find(p => String(p.id) === String(pid));

    if (!product) {
        console.warn('⚠️ Produit introuvable :', productId);
        try {
            const { showToast } = await import("./ui-core.js");
            showToast('❌ ' + t('productNotFound'));
        } catch (e) { /* ignore */ }
        return;
    }

    const name = getProductName(product);

    const price = variant && Number(variant.price) > 0
        ? Number(variant.price)
        : Number(product.price) || 0;

    const oldPrice = !variant && Number(product.oldPrice) > price
        ? Number(product.oldPrice)
        : 0;

    const isPromo = oldPrice > price;

    const url = `${CONFIG.SHOP.URL}/produit?slug=${encodeURIComponent(product.slug || '')}`;

    const variantLabel = formatVariantLabel(variant);

    let msg = `🛒 *${t('waNewOrder')}*\n\n`;
    msg += `📦 *${t('waProduct')} :* ${name}\n`;

    if (variantLabel) {
        msg += `🎨 ${t('comboSize') || 'Taille/Couleur'} : *${variantLabel}*\n`;
    }

    msg += `💰 *${t('waPrice')} :* ${price} ${t('currency')}`;
    if (isPromo) {
        msg += ` (${t('waInstead')} ${oldPrice} ${t('currency')})`;
    }
    msg += `\n🔗 ${url}\n\n`;
    msg += `👤 ${t('waName')} : \n`;
    msg += `📞 ${t('waPhone')} : \n`;
    msg += `📍 ${t('waAddress')} : \n`;
    msg += `🏙️ ${t('waCity')} : \n\n`;
    msg += `${t('waThanks')}`;

    await openWhatsAppWithToast(msg, '📱 WhatsApp ouvert — complétez vos infos !');
}

// ============================================================
// ✅ SUPPORT CLIENT (chat direct)
// ============================================================
export async function contactSupport(message = '') {
    const defaultMsg = message || `${t('emailHello')} — ${t('navAbout')} Smart Swi9a.`;
    await openWhatsAppWithToast(defaultMsg, '💬 Support WhatsApp ouvert');
}

// ============================================================
// PARTAGER UN PRODUIT (sans numéro spécifique)
// ============================================================
export function shareProductOnWhatsApp(productId) {
    const pid = normalizeProductId(productId);
    if (pid == null) return;

    const products = getProducts();
    // Comparaison par String (patch W2)
    const product = products.find(p => String(p.id) === String(pid));
    if (!product) return;

    const name = getProductName(product);
    const price = Number(product.price) || 0;
    const url = `${CONFIG.SHOP.URL}/produit?slug=${encodeURIComponent(product.slug || '')}`;

    const msg = `👋 ${t('waProduct')} Smart Swi9a :\n\n` +
        `📦 *${name}*\n` +
        `💰 ${price} ${t('currency')}\n` +
        `🔗 ${url}\n\n` +
        `${t('btnPrimary')} 🎉`;

    const safeMessage = truncateMessage(msg);
    const encoded = encodeURIComponent(safeMessage);
    const shareUrl = `https://wa.me/?text=${encoded}`;

    const win = window.open(shareUrl, '_blank', 'noopener,noreferrer');
    if (!win || win.closed) {
        window.location.href = shareUrl;
    }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ whatsapp.js chargé — v2.1.0 (Marketplace + IDs vendeurs)');