// js/whatsapp.js
// ============================================================
// COMMANDE VIA WHATSAPP - SMART SWI9A
// Version 1.2.1 — FIX : URLs cleanUrls (/produit au lieu de /produit.html)
// ============================================================
// Dépend de : config, utils, store, cart
// Génère et ouvre des liens WhatsApp avec messages pré-remplis
// ============================================================

import { CONFIG } from "./config.js";
import { t, getProductName, getLang } from "./utils.js";
import { getProducts, getCart } from "./store.js";
import {
    getCartSubtotal, getCartDiscount, getCartDeliveryFee,
    getCartTotal, getCartTotalItems
} from "./cart.js";

// ============================================================
// HELPERS INTERNES
// ============================================================
function openWhatsApp(message) {
    const phone = CONFIG.SHOP.WHATSAPP_NUMBER.replace(/\D/g, '');
    const encoded = encodeURIComponent(message);
    const url = `https://wa.me/${phone}?text=${encoded}`;
    window.open(url, '_blank', 'noopener,noreferrer');
}

// ============================================================
// COMMANDER UN SEUL PRODUIT VIA WHATSAPP — multilingue
// ============================================================
export function orderViaWhatsApp(productId) {
    const products = getProducts();
    const product = products.find(p => Number(p.id) === Number(productId));

    if (!product) {
        console.warn('⚠️ Produit introuvable :', productId);
        return;
    }

    const name = getProductName(product);
    const price = Number(product.price) || 0;
    const oldPrice = Number(product.oldPrice) || 0;
    const isPromo = oldPrice > price;
    // ✅ FIX v1.2.1 : cleanUrls → /produit (sans .html)
    const url = `${CONFIG.SHOP.URL}/produit?slug=${encodeURIComponent(product.slug || '')}`;

    let msg = `🛒 *${t('waNewOrder')}*\n\n`;
    msg += `📦 *${t('waProduct')} :* ${name}\n`;
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

    openWhatsApp(msg);
}

// ============================================================
// COMMANDER LE PANIER ENTIER VIA WHATSAPP — multilingue
// ============================================================
export function orderCartViaWhatsApp(deliveryInfo = {}) {
    const cart = getCart();
    if (!cart || cart.length === 0) return;

    const products = getProducts();
    const subtotal = getCartSubtotal();
    const discount = getCartDiscount();
    const totalItems = getCartTotalItems();
    const deliveryFee = getCartDeliveryFee();
    const total = getCartTotal();

    let msg = `🛒 *${t('waNewOrder')}*\n\n`;

    msg += `📋 *${t('waItems')} (${totalItems}) :*\n`;
    cart.forEach(item => {
        const p = products.find(pp => Number(pp.id) === item.productId);
        if (!p) return;
        const name = getProductName(p);
        const price = Number(p.price) || 0;
        msg += `  • ${name} (x${item.quantity}) — ${price * item.quantity} ${t('currency')}\n`;
    });
    msg += `\n`;

    msg += `💰 ${t('waSubtotal')} : ${subtotal} ${t('currency')}\n`;
    if (discount > 0) {
        msg += `🎁 ${t('waDiscount')} (-${CONFIG.SHOP.DISCOUNT_PERCENT}%) : -${discount} ${t('currency')}\n`;
    }
    msg += `🚚 ${t('waDelivery')} : ${deliveryFee > 0 ? deliveryFee + ' ' + t('currency') : '—'}\n`;
    msg += `💵 *${t('waTotal')} : ${total} ${t('currency')}*\n\n`;

    if (deliveryInfo.name) {
        msg += `📦 *${t('waDelivery')} :*\n`;
        msg += `👤 ${t('waName')} : ${deliveryInfo.name}\n`;
        if (deliveryInfo.phone) msg += `📞 ${t('waPhone')} : ${deliveryInfo.phone}\n`;
        if (deliveryInfo.address) msg += `📍 ${t('waAddress')} : ${deliveryInfo.address}\n`;
        if (deliveryInfo.city) msg += `🏙️ ${t('waCity')} : ${deliveryInfo.city}\n`;
        if (deliveryInfo.email) msg += `✉️ ${t('waEmail')} : ${deliveryInfo.email}\n`;
        msg += `\n`;
    }

    msg += `${t('waThanks')} 🎉`;
    openWhatsApp(msg);
}

// ============================================================
// SUPPORT CLIENT (chat direct) — multilingue
// ============================================================
export function contactSupport(message = '') {
    const defaultMsg = message || `${t('emailHello')} — ${t('navAbout')} Smart Swi9a.`;
    openWhatsApp(defaultMsg);
}

// ============================================================
// PARTAGER UN PRODUIT SUR WHATSAPP (sans numéro spécifique)
// ============================================================
export function shareProductOnWhatsApp(productId) {
    const products = getProducts();
    const product = products.find(p => Number(p.id) === Number(productId));
    if (!product) return;

    const name = getProductName(product);
    const price = Number(product.price) || 0;
    // ✅ FIX v1.2.1 : cleanUrls → /produit (sans .html)
    const url = `${CONFIG.SHOP.URL}/produit?slug=${encodeURIComponent(product.slug || '')}`;

    const msg = `👋 ${t('waProduct')} Smart Swi9a :\n\n` +
        `📦 *${name}*\n` +
        `💰 ${price} ${t('currency')}\n` +
        `🔗 ${url}\n\n` +
        `${t('btnPrimary')} 🎉`;

    const encoded = encodeURIComponent(msg);
    const shareUrl = `https://wa.me/?text=${encoded}`;
    window.open(shareUrl, '_blank', 'noopener,noreferrer');
}

// ============================================================
// LOG
// ============================================================
console.log('✅ whatsapp.js chargé — v1.2.1 (fix cleanUrls)');