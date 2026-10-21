// js/orders.js
// ============================================================
// GESTION DES COMMANDES - SMART SWI9A
// Version 4.0.0 — Transactions Atomiques, Restauration Coupon
// ============================================================

import {
    collection, doc, getDocs, getDoc, updateDoc, deleteDoc,
    query, where, orderBy, limit, startAfter, Timestamp,
    runTransaction, writeBatch, increment
} from "firebase/firestore";
import { db } from "./firebase.js";
import {
    CONFIG, ORDER_STATUS, normalizeOrderStatus, NOTIFICATION_TYPES,
    canReturnOrder, getReturnedQuantities, isFullReturn
} from "./config.js";
import {
    t, escapeHTML, formatDateTime,
    getOrderStatusEmoji, getOrderStatusLabel, getOrderStatusColor,
    getOrderTimelineSteps,
    isOrderCancellable, getTimeRemainingForCancellation, formatTimeRemaining,
    toDate, getCityName, getLang, getReturnBadgeText
} from "./utils.js";
import { getCurrentUser } from "./auth.js";
import { showToast, confirmAction } from "./ui-core.js";
import { cancelOrder, loadUserOrders } from "./cart.js";

// ============================================================
// CACHE
// ============================================================
let userReviewedProductIds = new Set();
const orderReviewStatusCache = new Map();
const _userLangCache = new Map(); // ✅ Cache pour éviter les requêtes N+1

// ============================================================
// CONFIGURATION EMAILJS
// ============================================================
const EMAILJS = {
    SERVICE_ID: 'service_gder468',
    TEMPLATE_ID: 'template_6tp1n35',
    PUBLIC_KEY: '47Wn3We2YOdAoSN2g'
};
// ⚠️ SÉCURITÉ : La clé EmailJS est publique (visible via DevTools).
// Protection recommandée : rate limiting via Cloud Functions.

// ============================================================
// HELPER : Chargement dynamique du SDK EmailJS
// ============================================================
let emailjsSDK = null;
async function getEmailJS() {
    if (emailjsSDK) return emailjsSDK;
    try {
        const mod = await import('https://cdn.jsdelivr.net/npm/@emailjs/browser@4/+esm');
        emailjsSDK = mod.default || mod;
        emailjsSDK.init({ publicKey: EMAILJS.PUBLIC_KEY });
        console.log('✅ EmailJS SDK chargé');
        return emailjsSDK;
    } catch (e) {
        console.error('❌ Erreur chargement EmailJS :', e);
        return null;
    }
}

async function sendEmailViaEmailJS(toEmail, toName, subject, htmlContent, textContent) {
    if (!toEmail || !toEmail.includes('@')) return { success: false, error: 'invalid_email' };
    try {
        const emailjs = await getEmailJS();
        if (!emailjs) return { success: false, error: 'sdk_not_loaded' };
        const templateParams = {
            to_email: toEmail, to_name: toName || toEmail.split('@')[0],
            subject: subject, html_content: htmlContent, text_content: textContent
        };
        const response = await emailjs.send(EMAILJS.SERVICE_ID, EMAILJS.TEMPLATE_ID, templateParams);
        return { success: true, response };
    } catch (e) {
        console.error('❌ Erreur envoi email :', e);
        return { success: false, error: e.message || e.text || 'unknown' };
    }
}

// ============================================================
// HELPERS EMAIL / LANGUE
// ============================================================
async function getUserLangById(userId) {
    if (!userId) return getLang() || 'fr';
    if (_userLangCache.has(userId)) return _userLangCache.get(userId);
    try {
        const snap = await getDoc(doc(db, "users", userId));
        if (snap.exists()) {
            const u = snap.data();
            const l = u.lang || u.preferredLang || u.signupLang;
            if (l === 'ar' || l === 'en' || l === 'fr') {
                _userLangCache.set(userId, l);
                return l;
            }
        }
    } catch (e) {}
    _userLangCache.set(userId, 'fr');
    return 'fr';
}

function buildOrderEmailSubject(status, recipient, orderId, lang = 'fr') {
    const shortId = String(orderId).slice(0, 8).toUpperCase();
    const subjects = {
        fr: {
            pending:   { client: `📦 Commande reçue #${shortId} | Smart Swi9a`, admin: `🔔 Nouvelle commande #${shortId}` },
            confirmed: { client: `✅ Commande confirmée #${shortId} | Smart Swi9a`, admin: null },
            shipping:  { client: `🚚 Commande en route #${shortId} | Smart Swi9a`, admin: null },
            delivered: { client: `📦 Commande livrée #${shortId} | Smart Swi9a`, admin: `✅ Commande livrée #${shortId}` },
            returned:  { client: `↩️ Retour enregistré #${shortId} | Smart Swi9a`, admin: `↩️ Retour commande #${shortId}` },
            cancelled: { client: `❌ Commande annulée #${shortId} | Smart Swi9a`, admin: null }
        },
        ar: {
            pending:   { client: `📦 تم استلام طلبك #${shortId} | سمارت سويقة`, admin: `🔔 طلب جديد #${shortId}` },
            confirmed: { client: `✅ تم تأكيد طلبك #${shortId} | سمارت سويقة`, admin: null },
            shipping:  { client: `🚚 طلبك في الطريق #${shortId} | سمارت سويقة`, admin: null },
            delivered: { client: `📦 تم تسليم طلبك #${shortId} | سمارت سويقة`, admin: `✅ تم التسليم #${shortId}` },
            returned:  { client: `↩️ تم تسجيل الإرجاع #${shortId} | سمارت سويقة`, admin: `↩️ إرجاع #${shortId}` },
            cancelled: { client: `❌ تم إلغاء طلبك #${shortId} | سمارت سويقة`, admin: null }
        },
        en: {
            pending:   { client: `📦 Order received #${shortId} | Smart Swi9a`, admin: `🔔 New order #${shortId}` },
            confirmed: { client: `✅ Order confirmed #${shortId} | Smart Swi9a`, admin: null },
            shipping:  { client: `🚚 Order shipping #${shortId} | Smart Swi9a`, admin: null },
            delivered: { client: `📦 Order delivered #${shortId} | Smart Swi9a`, admin: `✅ Order delivered #${shortId}` },
            returned:  { client: `↩️ Return recorded #${shortId} | Smart Swi9a`, admin: `↩️ Return #${shortId}` },
            cancelled: { client: `❌ Order cancelled #${shortId} | Smart Swi9a`, admin: null }
        }
    };
    const langSet = subjects[lang] || subjects.fr;
    const entry = langSet[status] || langSet.pending;
    return entry[recipient] || `Smart Swi9a #${shortId}`;
}

function buildOrderEmailText(order, status, recipient, lang = 'fr') {
    const shortId = String(order.id).slice(0, 8).toUpperCase();
    const name = order.deliveryAddress?.name || '—';
    const city = getCityName({ name: order.deliveryAddress?.cityAr || order.deliveryAddress?.city, nameFr: order.deliveryAddress?.cityFr, nameAr: order.deliveryAddress?.cityAr });
    
    const greetings = { fr: 'Bonjour', ar: 'مرحباً', en: 'Hello' };
    const thanks = { fr: `Merci pour votre commande #${shortId} !`, ar: `شكراً على طلبك #${shortId}!`, en: `Thank you for your order #${shortId}!` };
    const confirmed = { fr: `Bonne nouvelle ! Votre commande #${shortId} est confirmée.`, ar: `خبر سار! طلبك #${shortId} مؤكد.`, en: `Good news! Your order #${shortId} is confirmed.` };
    const shipping = { fr: `Votre colis #${shortId} est en route !`, ar: `طلبك #${shortId} في الطريق!`, en: `Your order #${shortId} is on its way!` };
    const delivered = { fr: `Votre commande #${shortId} est livrée !`, ar: `تم تسليم طلبك #${shortId}!`, en: `Your order #${shortId} has been delivered!` };
    const returned = { fr: `Le retour de votre commande #${shortId} a été enregistré.`, ar: `لقد سجلنا إرجاع طلبك #${shortId}.`, en: `Your order #${shortId} return has been recorded.` };
    const cancelled = { fr: `Votre commande #${shortId} a été annulée.`, ar: `تم إلغاء طلبك #${shortId}.`, en: `Your order #${shortId} has been cancelled.` };
    const team = { fr: "L'équipe Smart Swi9a", ar: "فريق سمارت سويقة", en: "Smart Swi9a team" };
    
    const map = { pending: thanks, confirmed, shipping, delivered, returned, cancelled };
    const message = map[status]?.[lang] || thanks[lang];
    
    let text = `${greetings[lang]} ${name},\n\n${message}\n\n`;
    text += `Articles :\n`;
    (order.items || []).forEach(item => {
        const variantText = item.variant ? ` (${[item.variant.size, item.variant.color].filter(Boolean).join(' - ')})` : '';
        text += `- ${item.name}${variantText} × ${item.quantity} : ${(item.price * item.quantity)} MAD\n`;
    });
    text += `\nTotal: ${order.total || 0} MAD\nCity: ${city}\n\n${team[lang]}\nhttps://smartswi9a.top`;
    return text;
}

function getItemsHtml(order, align = 'left') {
    return (order.items || []).slice(0, 10).map(item => {
        const itemName = escapeHTML(item.name || 'Produit');
        const qty = Number(item.quantity) || 1;
        const price = Number(item.price) || 0;
        const variantText = item.variant ? `<br><span style="font-size:12px;color:#a57b2e;">(${[item.variant.size, item.variant.color].filter(Boolean).join(' - ')})</span>` : '';
        return `
            <tr>
                <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;text-align:${align};">
                    ${itemName} × ${qty}${variantText}
                </td>
                <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;text-align:${align === 'left' ? 'right' : 'left'};color:#a57b2e;font-weight:bold;">
                    ${price * qty} MAD
                </td>
            </tr>
        `;
    }).join('');
}

function buildOrderEmailHtml(order, status, recipient, lang = 'fr') {
    const shortId = String(order.id).slice(0, 8).toUpperCase();
    const name = order.deliveryAddress?.name || '—';
    const city = getCityName({ name: order.deliveryAddress?.cityAr || order.deliveryAddress?.city, nameFr: order.deliveryAddress?.cityFr, nameAr: order.deliveryAddress?.cityAr });
    
    const emojis = { pending: '📦', confirmed: '✅', shipping: '🚚', delivered: '🎉', returned: '↩️', cancelled: '❌' };
    const titles = {
        fr: { pending: recipient === 'admin' ? 'Nouvelle commande' : 'Commande reçue', confirmed: 'Commande confirmée', shipping: 'Commande en route', delivered: 'Commande livrée', returned: 'Retour enregistré', cancelled: 'Commande annulée' },
        ar: { pending: recipient === 'admin' ? 'طلب جديد' : 'تم استلام الطلب', confirmed: 'تم تأكيد الطلب', shipping: 'الطلب في الطريق', delivered: 'تم تسليم الطلب', returned: 'تم تسجيل الإرجاع', cancelled: 'تم إلغاء الطلب' },
        en: { pending: recipient === 'admin' ? 'New order' : 'Order received', confirmed: 'Order confirmed', shipping: 'Order shipping', delivered: 'Order delivered', returned: 'Return recorded', cancelled: 'Order cancelled' }
    };
    const messages = {
        fr: { pending: recipient === 'admin' ? `Nouvelle commande de <strong>${escapeHTML(name)}</strong>.` : `Merci pour votre commande #${shortId} !`, confirmed: `Bonne nouvelle ! Votre commande #${shortId} est confirmée.`, shipping: `Votre colis #${shortId} est en route !`, delivered: `Votre commande #${shortId} est livrée !`, returned: `Nous avons enregistré le retour de votre commande #${shortId}.`, cancelled: `Votre commande #${shortId} a été annulée.` },
        ar: { pending: recipient === 'admin' ? `طلب جديد من <strong>${escapeHTML(name)}</strong>.` : `شكراً على طلبك #${shortId}!`, confirmed: `خبر سار! طلبك #${shortId} مؤكد.`, shipping: `طلبك #${shortId} في الطريق!`, delivered: `تم تسليم طلبك #${shortId}!`, returned: `لقد سجلنا إرجاع طلبك #${shortId}.`, cancelled: `تم إلغاء طلبك #${shortId}.` },
        en: { pending: recipient === 'admin' ? `New order from <strong>${escapeHTML(name)}</strong>.` : `Thank you for your order #${shortId}!`, confirmed: `Great news! Your order #${shortId} is confirmed.`, shipping: `Your order #${shortId} is on its way!`, delivered: `Your order #${shortId} has been delivered!`, returned: `We recorded the return of your order #${shortId}.`, cancelled: `Your order #${shortId} has been cancelled.` }
    };
    const labels = {
        fr: { order: 'Commande', name: 'Nom', city: 'Ville', total: 'Total' },
        ar: { order: 'الطلب', name: 'الاسم', city: 'المدينة', total: 'الإجمالي' },
        en: { order: 'Order', name: 'Name', city: 'City', total: 'Total' }
    };
    const t_ = titles[lang] || titles.fr;
    const m_ = messages[lang] || messages.fr;
    const l_ = labels[lang] || labels.fr;
    const isRtl = lang === 'ar';
    const align = isRtl ? 'right' : 'left';
    const itemsHtml = getItemsHtml(order, align);

    return `
        <div style="text-align:${align};direction:${isRtl ? 'rtl' : 'ltr'};">
            <h2 style="margin:0 0 15px;color:#a57b2e;font-size:20px;font-family:Georgia,serif;">${emojis[status] || '📦'} ${t_[status] || t_.pending}</h2>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#333;">${m_[status] || m_.pending}</p>
            <div style="background:#fafafa;border-radius:8px;padding:15px;margin:20px 0;font-size:14px;">
                <div style="padding:4px 0;"><strong>${l_.order} :</strong> #${shortId}</div>
                <div style="padding:4px 0;"><strong>${l_.name} :</strong> ${escapeHTML(name)}</div>
                <div style="padding:4px 0;"><strong>${l_.city} :</strong> ${escapeHTML(city)}</div>
            </div>
            ${order.items && order.items.length > 0 ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:15px 0;border-collapse:collapse;">${itemsHtml}</table>` : ''}
            <div style="background:#a57b2e;color:#ffffff;padding:12px 15px;border-radius:8px;text-align:center;margin:20px 0;">
                <strong style="font-size:16px;">${l_.total} : ${order.total || 0} MAD</strong>
            </div>
        </div>
    `;
}

// ============================================================
// FACTURE HTML (Reste inchangé)
// ============================================================
function getInvoiceNumber(order) { return 'INV-' + String(order.id || '').slice(0, 8).toUpperCase(); }

function buildInvoiceSubject(order, recipient, lang = 'fr') {
    const invoiceNum = getInvoiceNumber(order);
    const subjects = {
        fr: { client: `🧾 Votre facture ${invoiceNum} | Smart Swi9a`, admin: `🧾 Facture ${invoiceNum} — Commande livrée` },
        ar: { client: `🧾 فاتورتك ${invoiceNum} | سمارت سويقة`, admin: `🧾 فاتورة ${invoiceNum} — تم التسليم` },
        en: { client: `🧾 Your invoice ${invoiceNum} | Smart Swi9a`, admin: `🧾 Invoice ${invoiceNum} — Delivered` }
    };
    return (subjects[lang] || subjects.fr)[recipient] || subjects.fr.client;
}

function buildInvoiceHtml(order, recipient, lang = 'fr') {
    const isRtl = lang === 'ar';
    const align = isRtl ? 'right' : 'left';
    const dir = isRtl ? 'rtl' : 'ltr';
    const invoiceNum = getInvoiceNumber(order);
    const orderDate = toDate(order.createdAt);
    const invoiceDate = orderDate ? orderDate.toLocaleDateString(isRtl ? 'ar-MA' : (lang === 'en' ? 'en-GB' : 'fr-FR')) : '—';

    const labels = {
        fr: { invoice: 'FACTURE', issuedOn: 'Émise le', billedTo: 'FACTURÉ À', items: 'ARTICLES', product: 'Produit', qty: 'Qté', unitPrice: 'Prix unit.', lineTotal: 'Total', subtotal: 'Sous-total', volumeDiscount: 'Réduction volume', couponDiscount: 'Code promo', delivery: 'Livraison', total: 'TOTAL', paymentMethod: 'Mode de paiement', cod: 'Paiement à la livraison', paid: 'Payé', thanks: 'Merci pour votre confiance !', question: 'Pour toute question, contactez-nous :', shopName: 'SMART SWI9A', footer: 'Cet email tient lieu de facture. Aucune signature requise.' },
        ar: { invoice: 'فاتورة', issuedOn: 'صدرت في', billedTo: 'فاتورة إلى', items: 'المنتجات', product: 'المنتج', qty: 'الكمية', unitPrice: 'سعر الوحدة', lineTotal: 'الإجمالي', subtotal: 'المجموع الفرعي', volumeDiscount: 'خصم الكمية', couponDiscount: 'كود الخصم', delivery: 'التوصيل', total: 'الإجمالي', paymentMethod: 'طريقة الدفع', cod: 'الدفع عند الاستلام', paid: 'مدفوع', thanks: 'شكراً على ثقتكم!', question: 'لأي استفسار، تواصلوا معنا:', shopName: 'سمارت سويقة', footer: 'هذا البريد بمثابة فاتورة. لا حاجة لتوقيع.' },
        en: { invoice: 'INVOICE', issuedOn: 'Issued on', billedTo: 'BILLED TO', items: 'ITEMS', product: 'Product', qty: 'Qty', unitPrice: 'Unit price', lineTotal: 'Total', subtotal: 'Subtotal', volumeDiscount: 'Volume discount', couponDiscount: 'Coupon code', delivery: 'Delivery', total: 'TOTAL', paymentMethod: 'Payment method', cod: 'Cash on delivery', paid: 'Paid', thanks: 'Thank you for your trust!', question: 'For any question, contact us:', shopName: 'SMART SWI9A', footer: 'This email serves as an invoice. No signature required.' }
    };
    const l = labels[lang] || labels.fr;
    
    const clientName = escapeHTML(order.deliveryAddress?.name || '—');
    const clientPhone = escapeHTML(order.deliveryAddress?.phone || '');
    const clientAddress = escapeHTML(order.deliveryAddress?.address || '');
    const clientCity = escapeHTML(getCityName({ name: order.deliveryAddress?.cityAr || order.deliveryAddress?.city, nameFr: order.deliveryAddress?.cityFr, nameAr: order.deliveryAddress?.cityAr }));
    const clientEmail = escapeHTML(order.deliveryAddress?.email || order.userEmail || '');

    const itemsHtml = (order.items || []).map(item => {
        const itemName = escapeHTML(item.name || 'Produit');
        const variantText = item.variant ? `<br><span style="font-size:11px;color:#a57b2e;">(${[item.variant.size, item.variant.color].filter(Boolean).join(' - ')})</span>` : '';
        const qty = Number(item.quantity) || 1;
        const price = Number(item.price) || 0;
        return `
            <tr>
                <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#1a1a2e;text-align:${align};">${itemName}${variantText}</td>
                <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#5c5c5c;text-align:center;">${qty}</td>
                <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#5c5c5c;text-align:${isRtl ? 'left' : 'right'};">${price} MAD</td>
                <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#a57b2e;font-weight:700;text-align:${isRtl ? 'left' : 'right'};">${price * qty} MAD</td>
            </tr>
        `;
    }).join('');

    const subtotal = Number(order.subtotal) || 0;
    const volumeDiscount = Number(order.discount) || 0;
    const couponDiscount = Number(order.couponDiscount) || 0;
    const couponCode = order.couponCode ? escapeHTML(order.couponCode) : '';
    const deliveryFee = Number(order.deliveryFee) || 0;
    const total = Number(order.total) || 0;

    const rowsTotals = [];
    rowsTotals.push(`<tr><td style="padding:6px 8px;font-size:13px;color:#5c5c5c;text-align:${align};">${l.subtotal}</td><td style="padding:6px 8px;font-size:13px;color:#1a1a2e;font-weight:600;text-align:${isRtl ? 'left' : 'right'};">${subtotal} MAD</td></tr>`);
    if (volumeDiscount > 0) rowsTotals.push(`<tr><td style="padding:6px 8px;font-size:13px;color:#2ecc71;text-align:${align};">🎉 ${l.volumeDiscount}</td><td style="padding:6px 8px;font-size:13px;color:#2ecc71;font-weight:600;text-align:${isRtl ? 'left' : 'right'};">−${volumeDiscount} MAD</td></tr>`);
    if (couponDiscount > 0 && couponCode) rowsTotals.push(`<tr><td style="padding:6px 8px;font-size:13px;color:#2ecc71;text-align:${align};">🎟️ ${l.couponDiscount} <strong style="color:#a57b2e;">${couponCode}</strong></td><td style="padding:6px 8px;font-size:13px;color:#2ecc71;font-weight:600;text-align:${isRtl ? 'left' : 'right'};">−${couponDiscount} MAD</td></tr>`);
    rowsTotals.push(`<tr><td style="padding:6px 8px;font-size:13px;color:#5c5c5c;text-align:${align};">🚚 ${l.delivery}</td><td style="padding:6px 8px;font-size:13px;color:#1a1a2e;font-weight:600;text-align:${isRtl ? 'left' : 'right'};">${deliveryFee} MAD</td></tr>`);

    return `
<!DOCTYPE html>
<html dir="${dir}" lang="${lang}">
<head><meta charset="UTF-8"><title>${l.invoice} ${invoiceNum}</title></head>
<body style="margin:0;padding:0;background:#f8f6f2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;direction:${dir};">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f6f2;padding:20px 0;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:600px;width:100%;">
    <tr><td style="background:linear-gradient(135deg,#a57b2e 0%,#7d5a1d 100%);padding:24px 30px;"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="text-align:${align};"><div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:2px;">${l.shopName}</div></td><td style="text-align:${isRtl ? 'left' : 'right'};"><div style="font-size:11px;color:rgba(255,255,255,0.85);">${l.invoice}</div><div style="font-size:18px;font-weight:800;color:#ffffff;font-family:'Courier New',monospace;">${invoiceNum}</div></td></tr></table></td></tr>
    <tr><td style="padding:24px 30px 12px;"><table width="100%"><tr><td style="text-align:${align};"><div style="font-size:11px;color:#a57b2e;font-weight:700;margin-bottom:8px;">${l.billedTo}</div><div style="font-size:15px;font-weight:700;color:#1a1a2e;">${clientName}</div>${clientPhone ? `<div style="font-size:13px;color:#5c5c5c;">📞 ${clientPhone}</div>` : ''}${clientAddress ? `<div style="font-size:13px;color:#5c5c5c;">📍 ${clientAddress}</div>` : ''}${clientCity ? `<div style="font-size:13px;color:#5c5c5c;">🏙️ ${clientCity}</div>` : ''}${clientEmail ? `<div style="font-size:13px;color:#5c5c5c;">✉️ ${clientEmail}</div>` : ''}</td></tr></table></td></tr>
    <tr><td style="padding:12px 30px;"><div style="font-size:11px;color:#a57b2e;font-weight:700;margin-bottom:8px;text-align:${align};">${l.items}</div><table width="100%" style="border:1px solid #f0f0f0;border-radius:8px;overflow:hidden;"><thead><tr style="background:#faf8f3;"><th style="padding:10px;text-align:${align};">${l.product}</th><th style="padding:10px;text-align:center;">${l.qty}</th><th style="padding:10px;text-align:${isRtl ? 'left' : 'right'};">${l.unitPrice}</th><th style="padding:10px;text-align:${isRtl ? 'left' : 'right'};">${l.lineTotal}</th></tr></thead><tbody>${itemsHtml}</tbody></table></td></tr>
    <tr><td style="padding:12px 30px 20px;"><table width="100%" style="max-width:320px;margin-${isRtl ? 'right' : 'left'}:auto;">${rowsTotals.join('')}<tr><td colspan="2" style="padding:4px 8px;"><div style="height:1px;background:#f0f0f0;"></div></td></tr><tr><td style="padding:12px 8px 8px;font-size:15px;font-weight:800;text-align:${align};">${l.total}</td><td style="padding:12px 8px 8px;font-size:18px;color:#a57b2e;font-weight:800;text-align:${isRtl ? 'left' : 'right'};">${total} MAD</td></tr></table></td></tr>
    <tr><td style="padding:0 30px 20px;"><table width="100%" style="background:#e8f8f0;border-left:4px solid #2ecc71;border-radius:6px;"><tr><td style="padding:12px 16px;text-align:${align};"><div style="font-size:11px;color:#2ecc71;font-weight:700;">${l.paymentMethod}</div><div style="font-size:14px;color:#1a1a2e;font-weight:700;">✅ ${l.cod} — ${l.paid}</div></td></tr></table></td></tr>
    <tr><td style="background:#faf8f3;padding:16px 30px;text-align:center;border-top:1px solid #f0f0f0;"><div style="font-size:11px;color:#9a9a9a;line-height:1.6;">${l.footer}</div><div style="font-size:10px;color:#b5b5b5;margin-top:6px;">© ${new Date().getFullYear()} ${l.shopName} 🇲🇦</div></td></tr>
</table>
</td></tr></table>
</body>
</html>
    `;
}

function buildInvoiceText(order, recipient, lang = 'fr') {
    const invoiceNum = getInvoiceNumber(order);
    const orderDate = toDate(order.createdAt);
    const invoiceDate = orderDate ? orderDate.toLocaleDateString(lang === 'ar' ? 'ar-MA' : (lang === 'en' ? 'en-GB' : 'fr-FR')) : '—';
    const isAr = lang === 'ar';
    const lines = [];
    lines.push('════════════════════════════════════════');
    lines.push(`  ${isAr ? 'فاتورة' : 'FACTURE'} ${invoiceNum}`);
    lines.push(`  ${isAr ? 'صدرت في' : 'Émise le'} ${invoiceDate}`);
    lines.push('════════════════════════════════════════');
    lines.push('');
    lines.push(`SMART SWI9A`);
    lines.push(`📞 +212 6 56 61 33 03`);
    lines.push(`📧 smartswi9a@gmail.com`);
    lines.push('');
    lines.push('────────────────────────────────────────');
    lines.push(`👤 ${isAr ? 'العميل' : 'Client'} : ${order.deliveryAddress?.name || '—'}`);
    lines.push('');
    lines.push(`${isAr ? 'المنتجات' : 'ARTICLES'} :`);
    (order.items || []).forEach(item => {
        const qty = Number(item.quantity) || 1;
        const price = Number(item.price) || 0;
        const v = item.variant ? ` (${[item.variant.size, item.variant.color].filter(Boolean).join('-')})` : '';
        lines.push(`  • ${item.name}${v} (x${qty}) : ${price * qty} MAD`);
    });
    lines.push('');
    lines.push(`Sous-total : ${order.subtotal || 0} MAD`);
    if (Number(order.discount) > 0) lines.push(`Réduction : -${order.discount} MAD`);
    if (Number(order.couponDiscount) > 0) lines.push(`Code ${order.couponCode} : -${order.couponDiscount} MAD`);
    lines.push(`Livraison : ${order.deliveryFee || 0} MAD`);
    lines.push(`TOTAL : ${order.total || 0} MAD`);
    lines.push('');
    lines.push(`✅ ${isAr ? 'الدفع عند الاستلام' : 'Paiement à la livraison'} — PAYÉ`);
    lines.push('');
    lines.push(isAr ? 'شكراً على ثقتكم!' : 'Merci pour votre confiance !');
    lines.push('');
    lines.push('SMART SWI9A 🇲🇦');
    return lines.join('\n');
}

// ============================================================
// HELPER : Envoyer l'email complet (client ou admin)
// ============================================================
export async function sendOrderEmail(order, status, recipient) {
    const emailConfig = {
        pending:   { client: true,  admin: true  },
        confirmed: { client: true,  admin: false },
        shipping:  { client: true,  admin: false },
        delivered: { client: true,  admin: true  },
        returned:  { client: true,  admin: true  },
        cancelled: { client: true,  admin: false }
    };
    if (!emailConfig[status]?.[recipient]) return { skipped: true };

    let toEmail, toName;
    if (recipient === 'admin') {
        toEmail = CONFIG.SHOP.EMAIL;
        toName = 'Smart Swi9a Admin';
    } else {
        toEmail = order.deliveryAddress?.email || order.userEmail;
        toName = order.deliveryAddress?.name || 'Client';
    }
    if (!toEmail || !toEmail.includes('@')) return { skipped: true, reason: 'no_email' };

    const lang = recipient === 'client' ? await getUserLangById(order.userId) : 'fr';

    if (status === 'delivered') {
        const subject = buildInvoiceSubject(order, recipient, lang);
        const html = buildInvoiceHtml(order, recipient, lang);
        const text = buildInvoiceText(order, recipient, lang);
        return await sendEmailViaEmailJS(toEmail, toName, subject, html, text);
    }

    const subject = buildOrderEmailSubject(status, recipient, order.id, lang);
    const html = buildOrderEmailHtml(order, status, recipient, lang);
    const text = buildOrderEmailText(order, status, recipient, lang);
    return await sendEmailViaEmailJS(toEmail, toName, subject, html, text);
}

// ============================================================
// CACHES
// ============================================================
let userOrdersCache = [];
let adminOrdersCache = [];
let currentStatusFilter = 'all';
const ADMIN_PAGE_SIZE = 20;
let adminLastVisible = null;
let adminHasMore = true;
let adminLoading = false;

// ============================================================
// HELPER : Décrémenter le stock (Transaction)
// ============================================================
async function deductStockInTransaction(transaction, order, productSnaps, productRefs) {
    productSnaps.forEach((snap, i) => {
        if (!snap.exists()) throw new Error(`Produit introuvable`);
        const pData = snap.data();
        const qty = Number(order.items[i].quantity) || 0;
        const itemVariant = order.items[i].variant;
        
        let availableStock = 0;
        if (itemVariant) {
            const v = (pData.variants || []).find(v => (v.size || '') === (itemVariant.size || '') && (v.color || '') === (itemVariant.color || ''));
            availableStock = v ? Number(v.stock) : 0;
        } else {
            availableStock = Number(pData.stock) || 0;
        }

        if (availableStock < qty) throw new Error(`Stock insuffisant pour ${pData.nameFr || 'ce produit'}`);

        let updateData = { salesCount: (Number(pData.salesCount) || 0) + qty };
        
        if (itemVariant) {
            const variants = [...(pData.variants || [])];
            const idx = variants.findIndex(v => (v.size || '') === (itemVariant.size || '') && (v.color || '') === (itemVariant.color || ''));
            if (idx > -1) {
                variants[idx].stock = Math.max(0, Number(variants[idx].stock) - qty);
                updateData.variants = variants;
                updateData.stock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
            }
        } else {
            updateData.stock = Math.max(0, (Number(pData.stock) || 0) - qty);
        }
        transaction.update(productRefs[i], updateData);
    });
}

// ============================================================
// HELPER : Restaurer le stock (Transaction)
// ============================================================
async function restoreStockInTransaction(transaction, order, productSnaps, productRefs) {
    productSnaps.forEach((snap, i) => {
        if (!snap.exists()) return;
        const pData = snap.data();
        const qty = Number(order.items[i].quantity) || 0;
        const itemVariant = order.items[i].variant;
        let updateData = { salesCount: Math.max(0, (Number(pData.salesCount) || 0) - qty) };
        
        if (itemVariant) {
            const variants = [...(pData.variants || [])];
            const idx = variants.findIndex(v => (v.size || '') === (itemVariant.size || '') && (v.color || '') === (itemVariant.color || ''));
            if (idx > -1) {
                variants[idx].stock = (Number(variants[idx].stock) || 0) + qty;
                updateData.variants = variants;
                updateData.stock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
            }
        } else {
            updateData.stock = (Number(pData.stock) || 0) + qty;
        }
        transaction.update(productRefs[i], updateData);
    });
}

// ============================================================
// UPDATE ORDER STATUS (ATOMIQUE)
// ============================================================
export async function updateOrderStatus(orderId, newStatus) {
    try {
        const orderRef = doc(db, "orders", orderId);
        const normalizedStatus = normalizeOrderStatus(newStatus);
        
        if (normalizedStatus === ORDER_STATUS.RETURNED) {
            await openReturnModal(orderId);
            return { success: true, openedModal: true };
        }
        
        let orderForEmail = null;
        let emailStatus = null;
        
        await runTransaction(db, async (transaction) => {
            const orderSnap = await transaction.get(orderRef);
            if (!orderSnap.exists()) throw new Error('Commande introuvable');
            
            const order = { id: orderId, ...orderSnap.data() };
            const previousStatus = normalizeOrderStatus(order.status);
            orderForEmail = order;
            emailStatus = normalizedStatus;
            
            if (!Object.values(ORDER_STATUS).includes(normalizedStatus)) throw new Error('Statut invalide');
            
            // --- GESTION DU STOCK ET DU COUPON ---
            if (normalizedStatus === ORDER_STATUS.CONFIRMED && previousStatus === ORDER_STATUS.PENDING && order.stockDeducted !== true) {
                const productRefs = order.items.map(i => doc(db, "products", String(i.productId)));
                const productSnaps = await Promise.all(productRefs.map(r => transaction.get(r)));
                await deductStockInTransaction(transaction, order, productSnaps, productRefs);
                order.stockDeducted = true;
            }
            
            if (normalizedStatus === ORDER_STATUS.CANCELLED && [ORDER_STATUS.CONFIRMED, ORDER_STATUS.SHIPPING].includes(previousStatus) && order.stockDeducted === true) {
                const productRefs = order.items.map(i => doc(db, "products", String(i.productId)));
                const productSnaps = await Promise.all(productRefs.map(r => transaction.get(r)));
                await restoreStockInTransaction(transaction, order, productSnaps, productRefs);
                order.stockDeducted = false;
            }
            
            // --- RESTAURATION DU COUPON À L'ANNULATION ---
            if (normalizedStatus === ORDER_STATUS.CANCELLED && order.couponId && !order.couponRestored) {
                const couponRef = doc(db, "coupons", order.couponId);
                const couponUseRef = doc(db, "coupon_uses", `${order.couponId}_${order.userId}`);
                transaction.update(couponRef, { usedCount: increment(-1) });
                transaction.delete(couponUseRef);
                order.couponRestored = true;
            }
            
            // --- UPDATE FINAL ---
            const updatePayload = {
                status: normalizedStatus,
                updatedAt: Timestamp.now(),
                stockDeducted: order.stockDeducted,
                couponRestored: order.couponRestored || false
            };
            transaction.update(orderRef, updatePayload);
        });
        
        // --- EMAILS POST-TRANSACTION ---
        if (emailStatus && ['confirmed', 'shipping', 'delivered', 'cancelled'].includes(emailStatus)) {
            try {
                await sendOrderEmail(orderForEmail, emailStatus, 'client');
                await sendOrderEmail(orderForEmail, emailStatus, 'admin');
            } catch (e) {
                console.warn('⚠️ Email échoué (non bloquant):', e);
            }
        }
        
        // --- NOTIFICATIONS ---
        if (normalizedStatus === ORDER_STATUS.DELIVERED && orderForEmail.userId) {
            try {
                const { createNotification } = await import("./notifications.js");
                await createNotification(orderForEmail.userId, NOTIFICATION_TYPES.REVIEW_REQUEST || 'review_request', '⭐ Laissez un avis', `Votre commande #${orderId.slice(0, 8).toUpperCase()} est livrée !`, { orderId, persistent: true });
            } catch (e) {}
        }
        
        return { success: true };
    } catch (e) {
        console.error('❌ Erreur update statut :', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// SUPPRESSION COMPLETE DE LA COMMANDE
// ============================================================
async function deleteOrderCompletely(orderId) {
    const orderSnap = await getDoc(doc(db, "orders", orderId));
    if (!orderSnap.exists()) return { success: false };
    const order = { id: orderId, ...orderSnap.data() };
    
    // 1. Restaurer le stock via transaction
    if (order.stockDeducted === true && ![ORDER_STATUS.CANCELLED, ORDER_STATUS.RETURNED].includes(normalizeOrderStatus(order.status))) {
        await runTransaction(db, async (transaction) => {
            const productRefs = order.items.map(i => doc(db, "products", String(i.productId)));
            const productSnaps = await Promise.all(productRefs.map(r => transaction.get(r)));
            await restoreStockInTransaction(transaction, order, productSnaps, productRefs);
        });
    }
    
    // 2. Nettoyer le reste via batch
    const batch = writeBatch(db);
    
    if (order.couponId && !order.couponRestored) {
        batch.update(doc(db, "coupons", order.couponId), { usedCount: increment(-1) });
        batch.delete(doc(db, "coupon_uses", `${order.couponId}_${order.userId}`));
    }
    
    const notifQ = query(collection(db, "notifications"), where("orderId", "==", orderId));
    const notifSnap = await getDocs(notifQ);
    notifSnap.forEach(d => batch.delete(d.ref));
    
    batch.delete(doc(db, "orders", orderId));
    await batch.commit();
    
    return { success: true };
}

// ============================================================
// ADMIN : RENDRE LES COMMANDES (Optimisé)
// ============================================================
export async function renderAdminOrders(containerId = 'ordersList') {
    const container = document.getElementById(containerId);
    if (!container) return;

    // ✅ On ne fetch QUE si le cache est vide
    if (adminOrdersCache.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">⏳ ${t('loadingOrders')}</div>`;
        const { orders, hasMore } = await loadAllOrders(true);
        adminOrdersCache = orders;
        adminHasMore = hasMore;
    }

    if (adminOrdersCache.length === 0) {
        container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:2rem;">${t('noOrders')}</p>`;
        return;
    }
    
    let html = `<div style="display:flex; justify-content:flex-end; margin-bottom:1rem;">
        <button id="refreshAdminOrdersBtn" class="admin-btn-secondary" style="font-size:0.8rem;">🔄 Rafraîchir</button>
    </div>`;

    adminOrdersCache.forEach(order => {
        const status = normalizeOrderStatus(order.status);
        const emoji = getOrderStatusEmoji(status);
        const date = formatDateTime(order.createdAt);
        const orderIdShort = order.id.slice(0, 8).toUpperCase();
        const itemCount = order.items?.length || 0;
        const cityDisplay = getCityName({ name: order.deliveryAddress?.cityAr || order.deliveryAddress?.city, nameFr: order.deliveryAddress?.cityFr, nameAr: order.deliveryAddress?.cityAr });
        
        const stockBadge = order.stockDeducted === true ? `<span style="font-size:0.7rem;color:var(--success);font-weight:700;">📦 Stock déduit</span>` : `<span style="font-size:0.7rem;color:var(--warning);font-weight:700;">⏳ Stock non déduit</span>`;
        const returnBadge = getReturnBadgeText(order);
        const returnBadgeHtml = returnBadge ? ` · <span style="font-size:0.7rem;color:#9b59b6;font-weight:700;">${returnBadge}</span>` : '';
        const showReturnBtn = canReturnOrder(order);
        const returnBtnHtml = showReturnBtn ? `<button class="btn-return" data-action="admin:return-order" data-id="${order.id}" style="padding:0.3rem 0.8rem;border-radius:30px;background:#9b59b6;color:white;border:none;cursor:pointer;font-weight:600;font-size:0.8rem;">↩️ Retour</button>` : '';
        const invoiceBtnHtml = status === 'delivered' ? `<button class="btn-invoice" data-action="admin:resend-invoice" data-id="${order.id}" style="padding:0.3rem 0.8rem;border-radius:30px;background:linear-gradient(135deg,var(--gold),#7d5a1d);color:white;border:none;cursor:pointer;font-weight:600;font-size:0.8rem;" title="Renvoyer la facture">🧾 Facture</button>` : '';
        const couponBadge = (Number(order.couponDiscount) > 0 && order.couponCode) ? `<br><span style="font-size:0.7rem;color:var(--success);font-weight:700;">🎟️ ${escapeHTML(order.couponCode)} (−${order.couponDiscount} MAD)</span>` : '';

        // ✅ Correction du double-escape
        const itemsSummary = (order.items || []).map(i => {
            const name = escapeHTML(i.name || '');
            const v = i.variant ? ` (${escapeHTML([i.variant.size, i.variant.color].filter(Boolean).join('-'))})` : '';
            return `${name}${v} x${i.quantity}`;
        }).join(', ');

        html += `
            <div class="admin-order-item" style="flex-direction:column;align-items:stretch;padding:0.8rem;border-bottom:1px solid var(--border);">
                <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.6rem;">
                    <div>
                        <strong style="color:var(--gold);">#${orderIdShort}</strong> ${emoji} — ${date}<br>
                        <small>👤 ${escapeHTML(order.deliveryAddress?.name || '—')} · 📞 ${escapeHTML(order.deliveryAddress?.phone || '')} · 🏙️ ${escapeHTML(cityDisplay)}</small><br>
                        <small>🛒 <strong>${itemsSummary}</strong></small><br>
                        <small>${itemCount} ${t('items')} · 💰 ${order.total || 0} ${t('currency')} · ${stockBadge}${returnBadgeHtml}${couponBadge}</small>
                    </div>
                </div>
                <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
                    <select class="status-select" data-order-id="${order.id}" data-field="status" style="padding:0.3rem 0.6rem;border-radius:30px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text);">
                        <option value="pending" ${status === 'pending' ? 'selected' : ''}>⏳ ${t('orderStatusPending')}</option>
                        <option value="confirmed" ${status === 'confirmed' ? 'selected' : ''}>✅ ${t('orderStatusConfirmed')}</option>
                        <option value="shipping" ${status === 'shipping' ? 'selected' : ''}>🚚 ${t('orderStatusShipping')}</option>
                        <option value="delivered" ${status === 'delivered' ? 'selected' : ''}>📦 ${t('orderStatusDelivered')}</option>
                        <option value="returned" ${status === 'returned' ? 'selected' : ''}>↩️ ${t('orderStatusReturned')}</option>
                        <option value="cancelled" ${status === 'cancelled' ? 'selected' : ''}>❌ ${t('orderStatusCancelled')}</option>
                    </select>
                    <select class="status-select" data-order-id="${order.id}" data-field="paymentStatus" style="padding:0.3rem 0.6rem;border-radius:30px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text);">
                        <option value="unpaid" ${order.paymentStatus === 'unpaid' ? 'selected' : ''}>💳 ${t('orderPaymentUnpaid')}</option>
                        <option value="paid" ${order.paymentStatus === 'paid' ? 'selected' : ''}>💵 ${t('orderPaymentPaid')}</option>
                    </select>
                    ${invoiceBtnHtml}
                    ${returnBtnHtml}
                    <button class="btn-danger" data-action="admin:delete-order" data-id="${order.id}" style="padding:0.3rem 0.8rem;border-radius:30px;background:var(--danger);color:white;border:none;cursor:pointer;">🗑️</button>
                </div>
            </div>
        `;
    });

    if (adminHasMore) {
        html += `<div style="text-align:center;padding:1rem;"><button id="adminLoadMoreOrdersBtn" class="admin-btn-primary" style="margin:0 auto;">⬇️ Charger plus</button></div>`;
    } else if (adminOrdersCache.length >= ADMIN_PAGE_SIZE) {
        html += `<div style="text-align:center;padding:1rem;font-size:0.8rem;color:var(--text-dim);">✓ Toutes les commandes sont chargées</div>`;
    }
    
    container.innerHTML = html;

    // Attacher les événements
    document.getElementById('refreshAdminOrdersBtn')?.addEventListener('click', async (e) => {
        const btn = e.target;
        btn.textContent = '⏳...';
        adminOrdersCache = []; // Reset
        await renderAdminOrders(containerId);
    });

    container.querySelectorAll('.status-select').forEach(select => {
        select.addEventListener('change', async () => {
            const orderId = select.dataset.orderId;
            const field = select.dataset.field;
            const value = select.value;
            select.disabled = true;
            try {
                if (field === 'status') {
                    const result = await updateOrderStatus(orderId, value);
                    if (result.success) {
                        showToast('✅ ' + t('success'));
                        const cached = adminOrdersCache.find(o => o.id === orderId);
                        if (cached) cached.status = value;
                        await renderAdminOrders(containerId);
                    } else {
                        showToast('❌ ' + result.error);
                        await renderAdminOrders(containerId);
                    }
                } else {
                    await updateDoc(doc(db, "orders", orderId), { [field]: value, updatedAt: Timestamp.now() });
                    const cached = adminOrdersCache.find(o => o.id === orderId);
                    if (cached) cached[field] = value;
                    showToast('✅ ' + t('success'));
                }
            } catch (e) {
                console.error(e);
                showToast('❌ ' + e.message);
            } finally {
                select.disabled = false;
            }
        });
    });

    container.querySelectorAll('[data-action="admin:resend-invoice"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.id;
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '⏳...';
            try { await resendInvoice(orderId); } finally { btn.disabled = false; btn.innerHTML = originalText; }
        });
    });

    container.querySelectorAll('[data-action="admin:return-order"]').forEach(btn => {
        btn.addEventListener('click', async () => { await openReturnModal(btn.dataset.id); });
    });

    container.querySelectorAll('[data-action="admin:delete-order"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.id;
            const confirmed = await confirmAction(t('confirmDeleteOrderMsg').replace('{id}', orderId.slice(0, 8).toUpperCase()), { title: t('confirmDeleteOrderTitle'), confirmText: t('confirmDeleteYes'), cancelText: t('confirmDeleteNo'), variant: 'danger' });
            if (!confirmed) return;
            btn.disabled = true;
            try {
                await deleteOrderCompletely(orderId);
                showToast('✅ ' + t('delete'));
                adminOrdersCache = adminOrdersCache.filter(o => o.id !== orderId);
                await renderAdminOrders(containerId);
            } catch (e) {
                showToast('❌ ' + e.message);
                btn.disabled = false;
            }
        });
    });

    const loadMoreBtn = document.getElementById('adminLoadMoreOrdersBtn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', async () => {
            loadMoreBtn.disabled = true;
            loadMoreBtn.textContent = '⏳ ' + t('loading');
            const { orders, hasMore } = await loadAllOrders(false);
            adminOrdersCache = [...adminOrdersCache, ...orders];
            adminHasMore = hasMore;
            await renderAdminOrders(containerId);
        });
    }
}

// ============================================================
// RENVOYER LA FACTURE
// ============================================================
export async function resendInvoice(orderId) {
    try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (!snap.exists()) { showToast('❌ ' + t('loadError')); return { success: false, error: 'not_found' }; }
        const order = { id: snap.id, ...snap.data() };
        if (normalizeOrderStatus(order.status) !== 'delivered') {
            showToast('⚠️ La facture ne peut être renvoyée que pour une commande livrée');
            return { success: false, error: 'not_delivered' };
        }
        showToast('⏳ Envoi de la facture...');
        const [clientResult, adminResult] = await Promise.allSettled([sendOrderEmail(order, 'delivered', 'client'), sendOrderEmail(order, 'delivered', 'admin')]);
        const clientOk = clientResult.status === 'fulfilled' && clientResult.value?.success;
        const adminOk = adminResult.status === 'fulfilled' && adminResult.value?.success;
        
        if (clientOk && adminOk) {
            showToast(`✅ Facture ${getInvoiceNumber(order)} envoyée au client et à l'admin`);
            return { success: true, clientOk: true, adminOk: true };
        }
        if (clientOk || adminOk) {
            showToast(`⚠️ Facture partiellement envoyée (client: ${clientOk ? '✅' : '❌'}, admin: ${adminOk ? '✅' : '❌'})`);
            return { success: true, clientOk, adminOk, partial: true };
        }
        showToast('❌ Échec de l\'envoi de la facture');
        return { success: false, error: 'send_failed' };
    } catch (e) {
        showToast('❌ ' + (e.message || t('error')));
        return { success: false, error: e.message };
    }
}

// ============================================================
// CHARGER LES COMMANDES (Pagination Admin)
// ============================================================
export async function loadAllOrders(reset = false) {
    if (reset) { adminLastVisible = null; adminHasMore = true; adminOrdersCache = []; }
    if (adminLoading || !adminHasMore) return { orders: adminOrdersCache, hasMore: adminHasMore };
    adminLoading = true;
    try {
        const constraints = [orderBy("createdAt", "desc"), limit(ADMIN_PAGE_SIZE)];
        if (adminLastVisible) constraints.push(startAfter(adminLastVisible));
        const q = query(collection(db, "orders"), ...constraints);
        const snapshot = await getDocs(q);
        adminLastVisible = snapshot.docs[snapshot.docs.length - 1] || null;
        adminHasMore = snapshot.docs.length === ADMIN_PAGE_SIZE;
        const newOrders = snapshot.docs.map(d => {
            const data = d.data();
            return { id: d.id, ...data, createdAt: toDate(data.createdAt) };
        });
        return { orders: newOrders, hasMore: adminHasMore };
    } catch (e) {
        console.error('❌ Erreur chargement commandes admin :', e);
        return { orders: [], hasMore: false };
    } finally {
        adminLoading = false;
    }
}

export function resetAdminOrdersCache() {
    adminOrdersCache = [];
    adminLastVisible = null;
    adminHasMore = true;
    adminLoading = false;
}

// ============================================================
// AUTRES FONCTIONS (Rendus, Modales, Retours, etc. - inchangées)
// ============================================================
// ... (Je garde tout le reste du fichier tel quel pour ne pas le casser) ...