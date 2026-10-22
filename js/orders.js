// js/orders.js
// ============================================================
// GESTION DES COMMANDES - SMART SWI9A
// Version 6.0.0 — Timeline 4 étapes + Auto-Sync Speedaf
//                 + Auto-Pay COD + Bouton Payé/Non Payé
// ============================================================

import {
    collection, doc, getDocs, getDoc, updateDoc, deleteDoc,
    query, where, orderBy, limit, startAfter, Timestamp,
    runTransaction, writeBatch, increment
} from "firebase/firestore";
import { db } from "./firebase.js";
import {
    CONFIG, ORDER_STATUS, normalizeOrderStatus, NOTIFICATION_TYPES,
    canReturnOrder, getReturnedQuantities, isFullReturn,
    isTestMode, APP_MODE
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
// 🚀 CONFIGURATION SPEEDAF (Via Worker Cloudflare)
// ============================================================
const SPEEDAF_API_CONFIG = {
    BASE_URL: "https://speedaf-proxy.smartswi9a.workers.dev"
};

// ============================================================
// CONFIGURATION EMAILJS
// ============================================================
const EMAILJS = {
    SERVICE_ID: 'service_gder468',
    TEMPLATE_ID: 'template_6tp1n35',
    PUBLIC_KEY: '47Wn3We2YOdAoSN2g'
};

// ============================================================
// HELPERS EMAILJS
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

async function getUserLangById(userId) {
    if (!userId) return getLang() || 'fr';
    try {
        const snap = await getDoc(doc(db, "users", userId));
        if (snap.exists()) {
            const u = snap.data();
            const l = u.lang || u.preferredLang || u.signupLang;
            if (l === 'ar' || l === 'en' || l === 'fr') return l;
        }
    } catch (e) {}
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
    let text = `${greetings[lang]} ${name},\n\n${message}\n\nArticles :\n`;
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
        return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;text-align:${align};">${itemName} × ${qty}${variantText}</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;text-align:${align === 'left' ? 'right' : 'left'};color:#a57b2e;font-weight:bold;">${price * qty} MAD</td></tr>`;
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
        fr: { invoice: 'FACTURE', issuedOn: 'Émise le', billedTo: 'FACTURÉ À', items: 'ARTICLES', product: 'Produit', qty: 'Qté', unitPrice: 'Prix unit.', lineTotal: 'Total', subtotal: 'Sous-total', volumeDiscount: 'Réduction volume', couponDiscount: 'Code promo', delivery: 'Livraison', total: 'TOTAL', paymentMethod: 'Mode de paiement', cod: 'Paiement à la livraison', paid: 'Payé', shopName: 'SMART SWI9A', footer: 'Cet email tient lieu de facture. Aucune signature requise.' },
        ar: { invoice: 'فاتورة', issuedOn: 'صدرت في', billedTo: 'فاتورة إلى', items: 'المنتجات', product: 'المنتج', qty: 'الكمية', unitPrice: 'سعر الوحدة', lineTotal: 'الإجمالي', subtotal: 'المجموع الفرعي', volumeDiscount: 'خصم الكمية', couponDiscount: 'كود الخصم', delivery: 'التوصيل', total: 'الإجمالي', paymentMethod: 'طريقة الدفع', cod: 'الدفع عند الاستلام', paid: 'مدفوع', shopName: 'سمارت سويقة', footer: 'هذا البريد بمثابة فاتورة. لا حاجة لتوقيع.' },
        en: { invoice: 'INVOICE', issuedOn: 'Issued on', billedTo: 'BILLED TO', items: 'ITEMS', product: 'Product', qty: 'Qty', unitPrice: 'Unit price', lineTotal: 'Total', subtotal: 'Subtotal', volumeDiscount: 'Volume discount', couponDiscount: 'Coupon code', delivery: 'Delivery', total: 'TOTAL', paymentMethod: 'Payment method', cod: 'Cash on delivery', paid: 'Paid', shopName: 'SMART SWI9A', footer: 'This email serves as an invoice. No signature required.' }
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
        return `<tr><td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#1a1a2e;text-align:${align};">${itemName}${variantText}</td><td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#5c5c5c;text-align:center;">${qty}</td><td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#5c5c5c;text-align:${isRtl ? 'left' : 'right'};">${price} MAD</td><td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#a57b2e;font-weight:700;text-align:${isRtl ? 'left' : 'right'};">${price * qty} MAD</td></tr>`;
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
    return `<!DOCTYPE html><html dir="${dir}" lang="${lang}"><head><meta charset="UTF-8"><title>${l.invoice} ${invoiceNum}</title></head><body style="margin:0;padding:0;background:#f8f6f2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;direction:${dir};"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f6f2;padding:20px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:600px;width:100%;"><tr><td style="background:linear-gradient(135deg,#a57b2e 0%,#7d5a1d 100%);padding:24px 30px;"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="text-align:${align};"><div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:2px;">${l.shopName}</div></td><td style="text-align:${isRtl ? 'left' : 'right'};"><div style="font-size:11px;color:rgba(255,255,255,0.85);">${l.invoice}</div><div style="font-size:18px;font-weight:800;color:#ffffff;font-family:'Courier New',monospace;">${invoiceNum}</div></td></tr></table></td></tr><tr><td style="padding:24px 30px 12px;"><table width="100%"><tr><td style="text-align:${align};"><div style="font-size:11px;color:#a57b2e;font-weight:700;margin-bottom:8px;">${l.billedTo}</div><div style="font-size:15px;font-weight:700;color:#1a1a2e;">${clientName}</div>${clientPhone ? `<div style="font-size:13px;color:#5c5c5c;">📞 ${clientPhone}</div>` : ''}${clientAddress ? `<div style="font-size:13px;color:#5c5c5c;">📍 ${clientAddress}</div>` : ''}${clientCity ? `<div style="font-size:13px;color:#5c5c5c;">🏙️ ${clientCity}</div>` : ''}${clientEmail ? `<div style="font-size:13px;color:#5c5c5c;">✉️ ${clientEmail}</div>` : ''}</td></tr></table></td></tr><tr><td style="padding:12px 30px;"><div style="font-size:11px;color:#a57b2e;font-weight:700;margin-bottom:8px;text-align:${align};">${l.items}</div><table width="100%" style="border:1px solid #f0f0f0;border-radius:8px;overflow:hidden;"><thead><tr style="background:#faf8f3;"><th style="padding:10px;text-align:${align};">${l.product}</th><th style="padding:10px;text-align:center;">${l.qty}</th><th style="padding:10px;text-align:${isRtl ? 'left' : 'right'};">${l.unitPrice}</th><th style="padding:10px;text-align:${isRtl ? 'left' : 'right'};">${l.lineTotal}</th></tr></thead><tbody>${itemsHtml}</tbody></table></td></tr><tr><td style="padding:12px 30px 20px;"><table width="100%" style="max-width:320px;margin-${isRtl ? 'right' : 'left'}:auto;">${rowsTotals.join('')}<tr><td colspan="2" style="padding:4px 8px;"><div style="height:1px;background:#f0f0f0;"></div></td></tr><tr><td style="padding:12px 8px 8px;font-size:15px;font-weight:800;text-align:${align};">${l.total}</td><td style="padding:12px 8px 8px;font-size:18px;color:#a57b2e;font-weight:800;text-align:${isRtl ? 'left' : 'right'};">${total} MAD</td></tr></table></td></tr><tr><td style="padding:0 30px 20px;"><table width="100%" style="background:#e8f8f0;border-left:4px solid #2ecc71;border-radius:6px;"><tr><td style="padding:12px 16px;text-align:${align};"><div style="font-size:11px;color:#2ecc71;font-weight:700;">${l.paymentMethod}</div><div style="font-size:14px;color:#1a1a2e;font-weight:700;">✅ ${l.cod} — ${l.paid}</div></td></tr></table></td></tr><tr><td style="background:#faf8f3;padding:16px 30px;text-align:center;border-top:1px solid #f0f0f0;"><div style="font-size:11px;color:#9a9a9a;line-height:1.6;">${l.footer}</div><div style="font-size:10px;color:#b5b5b5;margin-top:6px;">© ${new Date().getFullYear()} ${l.shopName} 🇲🇦</div></td></tr></table></td></tr></table></body></html>`;
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
// 🚀 SPEEDAF — HELPERS
// ============================================================
function cleanMoroccanPhone(phone) {
    if (!phone) return '';
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('212')) cleaned = '0' + cleaned.substring(3);
    return cleaned;
}

// ============================================================
// 🚀 SPEEDAF — CREATE ORDER (Guard mode test)
// ⚠️ NE PAS MODIFIER : blInsure: "0", poids en KG, goodsType IT02
// ============================================================
export async function sendToSpeedafAPI(order) {
    // 🧪 MODE TEST : ZÉRO appel réseau
    if (isTestMode()) {
        console.log('🧪 [TEST] sendToSpeedafAPI MOCK — aucun appel Speedaf');
        return {
            success: true,
            trackingNumber: "TEST-" + Date.now(),
            labelUrl: null
        };
    }

    try {
        if (!order || !order.deliveryAddress) {
            throw new Error("Données de commande invalides");
        }
        const addr = order.deliveryAddress;

        // ✅ Calcul du poids total en KG
        let totalWeightGrams = 0;
        const itemList = (order.items || []).map(item => {
            const itemWeightGrams = Number(item.weight) || 500;
            totalWeightGrams += (itemWeightGrams * (Number(item.quantity) || 1));

            return {
                sku: String(item.productId || 'SKU'),
                goodsName: String(item.name || 'Produit').slice(0, 100),
                goodsQTY: Number(item.quantity) || 1,
                goodsValue: String(item.price || 0),
                currencyType: "MAD",
                goodsType: "IT02",
                goodsWeight: String((itemWeightGrams / 1000).toFixed(3)),
                goodsUrl: "",
                blInsure: "0",
                battery: "0"
            };
        });

        let parcelWeightKg = Number((totalWeightGrams / 1000).toFixed(3));
        if (parcelWeightKg <= 0) parcelWeightKg = 1;

        const cityName = addr.cityFr || addr.city || "Casablanca";

        const payload = {
            data: {
                customOrderNo: String(order.id).slice(0, 8).toUpperCase(),
                customerCode: "MA000025",
                platformSource: "Smart Swi9a",
                parcelType: "PT01",
                deliveryType: "DE01",
                transportType: "TT01",
                shipType: "ST01",
                payMethod: "PA02",
                isAllowOpen: "0",

                acceptName: String(addr.name || 'Client').slice(0, 100),
                acceptMobile: cleanMoroccanPhone(addr.phone),
                acceptEmail: addr.email || "client@smartswi9a.top",
                acceptAddress: String(addr.address || 'Casablanca').slice(0, 500),
                acceptCountryCode: "MA",
                acceptCountryName: "Morocco",
                acceptProvinceName: cityName,
                acceptCityName: cityName,
                acceptDistrictName: cityName,

                sendName: "Smart Swi9a",
                sendAddress: "Casablanca Smart Swi9a Warehouse",
                sendMobile: "0656613303",
                sendCountryCode: "MA",
                sendCountryName: "Morocco",
                sendProvinceName: "Casablanca",
                sendCityName: "Casablanca",
                sendDistrictName: "Casablanca",

                parcelWeight: String(parcelWeightKg),
                piece: 1,
                goodsQTY: order.items?.reduce((s, i) => s + Number(i.quantity || 0), 0) || 1,
                codFee: String(order.total),
                currencyType: "MAD",
                pickUpAging: "0",
                remark: "Commande Smart Swi9a",
                itemList: itemList
            }
        };

        const response = await fetch(`${SPEEDAF_API_CONFIG.BASE_URL}/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        console.log('📨 Speedaf create response:', JSON.stringify(data, null, 2));

        if (data.success && data.data && data.data.billCode) {
            return {
                success: true,
                trackingNumber: data.data.billCode,
                labelUrl: data.data.labelUrl || null
            };
        }

        let errorMsg = "Erreur inconnue";
        if (data.error) {
            if (typeof data.error === 'string') errorMsg = data.error;
            else if (data.error.message) errorMsg = data.error.message;
            else if (data.error.errorCode) errorMsg = "Code: " + data.error.errorCode;
            else errorMsg = JSON.stringify(data.error);
        } else if (data.errorCode) {
            errorMsg = "Code: " + data.errorCode;
        }

        return {
            success: false,
            error: errorMsg
        };

    } catch (error) {
        console.error("❌ Erreur Speedaf create:", error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// 🚀 SPEEDAF — CANCEL
// ============================================================
export async function cancelSpeedafShipment(trackingNumber) {
    if (isTestMode()) {
        console.log('🧪 [TEST] cancelSpeedafShipment MOCK');
        return true;
    }

    if (!trackingNumber) return false;
    try {
        const response = await fetch(`${SPEEDAF_API_CONFIG.BASE_URL}/cancel-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: [{
                    customerCode: "MA000025",
                    billCode: trackingNumber,
                    cancelReason: "Annulation client",
                    cancelBy: "Smart Swi9a"
                }]
            })
        });
        const data = await response.json();
        const cancelResult = data?.data?.[0];
        if (cancelResult && cancelResult.success === true) {
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

// ============================================================
// 🚀 SPEEDAF — SYNC STATUS
// ✅ NOUVEAU : délègue à updateOrderStatus (Auto-Pay activé)
// ============================================================
export async function syncSpeedafStatus(orderId) {
    if (isTestMode()) {
        console.log('🧪 [TEST] syncSpeedafStatus MOCK');
        return { success: true, updated: false, currentStatus: "test_mode_no_sync" };
    }

    try {
        const orderRef = doc(db, "orders", orderId);
        const snap = await getDoc(orderRef);
        if (!snap.exists()) return { success: false, error: "Commande introuvable" };

        const order = snap.data();
        if (!order.speedafTracking) return { success: false, error: "Aucun numéro de suivi" };

        const response = await fetch(`${SPEEDAF_API_CONFIG.BASE_URL}/track`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { mailNoList: [order.speedafTracking] } })
        });

        const data = await response.json();
        const tracks = data?.data?.[0]?.tracks || [];
        if (tracks.length === 0) {
            return { success: true, updated: false, currentStatus: "no_tracks" };
        }

        const latest = tracks[tracks.length - 1];
        const action = String(latest.action || "").trim();
        let newStatus = null;
        if (action === "5") newStatus = ORDER_STATUS.DELIVERED;
        else if (action === "-7" || action === "10" || action === "730") newStatus = ORDER_STATUS.RETURNED;
        else if (["1", "2", "3", "4"].includes(action)) newStatus = ORDER_STATUS.SHIPPING;

        if (!newStatus) {
            return { success: true, updated: false, currentStatus: latest.actionName || action };
        }

        const currentStatus = normalizeOrderStatus(order.status);
        if (currentStatus === newStatus) {
            return { success: true, updated: false, currentStatus: latest.actionName || action };
        }

        // ✅ Délègue à updateOrderStatus (qui gère auto-pay + email + notif)
        const updResult = await updateOrderStatus(orderId, newStatus);
        if (!updResult.success) {
            return { success: false, error: updResult.error || 'Erreur updateOrderStatus' };
        }

        return { success: true, updated: true, newStatus };

    } catch (error) {
        console.error('❌ syncSpeedafStatus:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// CACHES & PAGINATION
// ============================================================
let adminOrdersCache = [];
const ADMIN_PAGE_SIZE = 20;
let adminLastVisible = null;
let adminHasMore = true;
let adminLoading = false;

// ============================================================
// STOCK HELPERS
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
// UPDATE ORDER STATUS
// ✅ NOUVEAU : Auto-Pay COD sur delivered + double notification
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

            let productSnaps = [];
            let productRefs = [];

            if (normalizedStatus === ORDER_STATUS.CONFIRMED && previousStatus === ORDER_STATUS.PENDING && order.stockDeducted !== true) {
                productRefs = order.items.map(i => doc(db, "products", String(i.productId)));
                productSnaps = await Promise.all(productRefs.map(r => transaction.get(r)));
            }

            if (normalizedStatus === ORDER_STATUS.CANCELLED && [ORDER_STATUS.CONFIRMED, ORDER_STATUS.SHIPPING].includes(previousStatus) && order.stockDeducted === true) {
                productRefs = order.items.map(i => doc(db, "products", String(i.productId)));
                productSnaps = await Promise.all(productRefs.map(r => transaction.get(r)));
            }

            if (normalizedStatus === ORDER_STATUS.CONFIRMED && previousStatus === ORDER_STATUS.PENDING && order.stockDeducted !== true) {
                await deductStockInTransaction(transaction, order, productSnaps, productRefs);
                order.stockDeducted = true;
            }

            if (normalizedStatus === ORDER_STATUS.CANCELLED && [ORDER_STATUS.CONFIRMED, ORDER_STATUS.SHIPPING].includes(previousStatus) && order.stockDeducted === true) {
                await restoreStockInTransaction(transaction, order, productSnaps, productRefs);
                order.stockDeducted = false;
            }

            if (normalizedStatus === ORDER_STATUS.CANCELLED && order.couponId && !order.couponRestored) {
                const couponRef = doc(db, "coupons", order.couponId);
                const couponUseRef = doc(db, "coupon_uses", `${order.couponId}_${order.userId}`);
                transaction.update(couponRef, { usedCount: increment(-1) });
                transaction.delete(couponUseRef);
                order.couponRestored = true;
            }

            const updatePayload = {
                status: normalizedStatus,
                updatedAt: Timestamp.now(),
                stockDeducted: order.stockDeducted,
                couponRestored: order.couponRestored || false
            };

            // ✅ Auto-Pay COD quand livré
            if (normalizedStatus === ORDER_STATUS.DELIVERED) {
                updatePayload.paymentStatus = 'paid';
                updatePayload.paidAt = Timestamp.now();
            }

            transaction.update(orderRef, updatePayload);
        });

        if (normalizedStatus === ORDER_STATUS.CONFIRMED && orderForEmail) {
            if (!orderForEmail.speedafTracking) {
                const spdResult = await sendToSpeedafAPI(orderForEmail);
                if (spdResult.success && spdResult.trackingNumber) {
                    await updateDoc(orderRef, {
                        status: ORDER_STATUS.SHIPPING,
                        speedafTracking: spdResult.trackingNumber,
                        speedafLabelUrl: spdResult.labelUrl || null,
                        speedafSyncedAt: Timestamp.now()
                    });
                    emailStatus = ORDER_STATUS.SHIPPING;
                    orderForEmail.status = ORDER_STATUS.SHIPPING;
                    orderForEmail.speedafTracking = spdResult.trackingNumber;
                    showToast(`✅ Colis créé chez Speedaf (Suivi: ${spdResult.trackingNumber})`);
                } else {
                    showToast(`⚠️ Speedaf a refusé la commande : ${spdResult.error}`, 4000);
                }
            }
        }

        if (normalizedStatus === ORDER_STATUS.CANCELLED && orderForEmail?.speedafTracking) {
            const cancelled = await cancelSpeedafShipment(orderForEmail.speedafTracking);
            if (cancelled) showToast('✅ Colis annulé chez Speedaf');
        }

        if (emailStatus && ['confirmed', 'shipping', 'delivered', 'cancelled'].includes(emailStatus)) {
            try {
                await sendOrderEmail(orderForEmail, emailStatus, 'client');
                await sendOrderEmail(orderForEmail, emailStatus, 'admin');
            } catch (e) {
                console.warn('⚠️ Email échoué (non bloquant):', e);
            }
        }

        // ✅ Notifications livraison (delivered + review_request)
        if (normalizedStatus === ORDER_STATUS.DELIVERED && orderForEmail.userId) {
            try {
                const { createNotification } = await import("./notifications.js");
                const shortId = orderId.slice(0, 8).toUpperCase();

                await createNotification(
                    orderForEmail.userId,
                    NOTIFICATION_TYPES.ORDER_DELIVERED || 'order_delivered',
                    (t('notificationOrderDelivered') || '📦 Commande livrée'),
                    (t('notificationOrderDeliveredMsg') || 'Votre commande #{id} est livrée !').replace('{id}', shortId),
                    { orderId }
                );

                await createNotification(
                    orderForEmail.userId,
                    'review_request',
                    '⭐ Laissez un avis',
                    `Votre commande #${shortId} est livrée ! Partagez votre expérience.`,
                    { orderId, persistent: true }
                );
            } catch (e) {
                console.warn('⚠️ Notification delivered échouée :', e);
            }
        }

        return { success: true };
    } catch (e) {
        console.error('❌ Erreur update statut :', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// SUPPRESSION COMPLÈTE
// ============================================================
async function deleteOrderCompletely(orderId) {
    const orderSnap = await getDoc(doc(db, "orders", orderId));
    if (!orderSnap.exists()) return { success: false };
    const order = { id: orderId, ...orderSnap.data() };

    if (order.stockDeducted === true && ![ORDER_STATUS.CANCELLED, ORDER_STATUS.RETURNED].includes(normalizeOrderStatus(order.status))) {
        await runTransaction(db, async (transaction) => {
            const productRefs = order.items.map(i => doc(db, "products", String(i.productId)));
            const productSnaps = await Promise.all(productRefs.map(r => transaction.get(r)));
            await restoreStockInTransaction(transaction, order, productSnaps, productRefs);
        });
    }

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
// ✅ NOUVEAU : BASCULER LE STATUT DE PAIEMENT (admin)
// ============================================================
export async function updatePaymentStatus(orderId, newStatus) {
    try {
        const allowed = ['paid', 'unpaid'];
        const normalized = allowed.includes(newStatus) ? newStatus : 'unpaid';

        await updateDoc(doc(db, "orders", orderId), {
            paymentStatus: normalized,
            paidAt: normalized === 'paid' ? Timestamp.now() : null,
            updatedAt: Timestamp.now()
        });

        return { success: true, paymentStatus: normalized };
    } catch (e) {
        console.error('❌ updatePaymentStatus:', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// ADMIN : RENDRE LES COMMANDES
// ✅ NOUVEAU : Bouton Payé / Non Payé
// ============================================================
export async function renderAdminOrders(containerId = 'ordersList') {
    const container = document.getElementById(containerId);
    if (!container) return;

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
        const cityDisplay = getCityName({
            name: order.deliveryAddress?.cityAr || order.deliveryAddress?.city,
            nameFr: order.deliveryAddress?.cityFr,
            nameAr: order.deliveryAddress?.cityAr
        });
        const isTest = order._test === true;
        const testBadge = isTest
            ? `<span style="background:#dc3545;color:#fff;font-size:0.65rem;padding:0.15rem 0.4rem;border-radius:30px;margin-left:0.3rem;font-weight:700;">TEST</span>`
            : '';
        const stockBadge = order.stockDeducted === true
            ? `<span style="font-size:0.7rem;color:var(--success);font-weight:700;">📦 Stock déduit</span>`
            : `<span style="font-size:0.7rem;color:var(--warning);font-weight:700;">⏳ Stock non déduit</span>`;

        // ✅ Bouton paiement
        const isPaid = order.paymentStatus === 'paid';
        const paymentBtnStyle = isPaid
            ? 'background:rgba(46,204,113,0.15);color:var(--success);border:1px solid var(--success);'
            : 'background:rgba(230,126,34,0.15);color:var(--warning);border:1px solid var(--warning);';
        const paymentBtnLabel = isPaid ? '💳 Payé' : '💳 Non payé';
        const paymentBtnHtml = `
            <button class="admin-btn-payment" data-action="toggle-payment" data-id="${order.id}"
                style="padding:0.35rem 0.8rem;border-radius:30px;font-size:0.75rem;font-weight:700;cursor:pointer;${paymentBtnStyle}">
                ${paymentBtnLabel}
            </button>
        `;

        let speedafHtml = '';
        if (order.speedafTracking) {
            speedafHtml = `<div style="margin-top:0.5rem; padding:0.5rem; background:rgba(165,123,46,0.05); border:1px solid var(--border-gold); border-radius:var(--radius-sm); font-size:0.8rem;">
                <strong>🚀 Speedaf:</strong> <code>${escapeHTML(order.speedafTracking)}</code>
                ${order.speedafLabelUrl ? `<a href="${escapeHTML(order.speedafLabelUrl)}" target="_blank" style="margin-left:0.5rem; color:var(--gold); font-weight:700;">🖨️ Étiquette</a>` : ''}
            </div>`;
        }

        const itemsSummary = (order.items || []).map(i => {
            const name = escapeHTML(i.name || '');
            const v = i.variant ? ` (${escapeHTML([i.variant.size, i.variant.color].filter(Boolean).join('-'))})` : '';
            return `${name}${v} x${i.quantity}`;
        }).join(', ');

        html += `
            <div class="admin-order-item" style="flex-direction:column;align-items:stretch;padding:0.8rem;border-bottom:1px solid var(--border);${isTest ? 'border-left:4px solid #dc3545;background:rgba(220,53,69,0.03);' : ''}">
                <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.6rem;">
                    <div>
                        <strong style="color:var(--gold);">#${orderIdShort}</strong>${testBadge} ${emoji} — ${date}<br>
                        <small>👤 ${escapeHTML(order.deliveryAddress?.name || '—')} · 📞 ${escapeHTML(order.deliveryAddress?.phone || '')} · 🏙️ ${escapeHTML(cityDisplay)}</small><br>
                        <small>🛒 <strong>${itemsSummary}</strong></small><br>
                        <small>${itemCount} ${t('items')} · 💰 ${order.total || 0} ${t('currency')} · ${stockBadge}</small>
                    </div>
                </div>
                ${speedafHtml}
                <div style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center; margin-top:0.5rem;">
                    <select class="status-select" data-order-id="${order.id}" data-field="status" style="padding:0.3rem 0.6rem;border-radius:30px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text);">
                        <option value="pending" ${status === 'pending' ? 'selected' : ''}>⏳ ${t('orderStatusPending')}</option>
                        <option value="confirmed" ${status === 'confirmed' ? 'selected' : ''}>✅ ${t('orderStatusConfirmed')}</option>
                        <option value="shipping" ${status === 'shipping' ? 'selected' : ''}>🚚 ${t('orderStatusShipping')}</option>
                        <option value="delivered" ${status === 'delivered' ? 'selected' : ''}>📦 ${t('orderStatusDelivered')}</option>
                        <option value="returned" ${status === 'returned' ? 'selected' : ''}>↩️ ${t('orderStatusReturned')}</option>
                        <option value="cancelled" ${status === 'cancelled' ? 'selected' : ''}>❌ ${t('orderStatusCancelled')}</option>
                    </select>
                    ${paymentBtnHtml}
                    ${order.speedafTracking ? `<button class="admin-btn-secondary" data-action="admin:sync-speedaf" data-id="${order.id}" style="font-size:0.75rem; padding:0.3rem 0.6rem;">🔄 Sync Speedaf</button>` : ''}
                    <button class="btn-danger" data-action="admin:delete-order" data-id="${order.id}" style="padding:0.3rem 0.8rem;border-radius:30px;background:var(--danger);color:white;border:none;cursor:pointer;margin-left:auto;">🗑️</button>
                </div>
            </div>
        `;
    });

    if (adminHasMore) {
        html += `<div style="text-align:center;padding:1rem;"><button id="adminLoadMoreOrdersBtn" class="admin-btn-primary" style="margin:0 auto;">⬇️ Charger plus</button></div>`;
    }

    container.innerHTML = html;

    document.getElementById('refreshAdminOrdersBtn')?.addEventListener('click', async (e) => {
        e.target.textContent = '⏳...';
        adminOrdersCache = [];
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
                        adminOrdersCache = [];
                        await renderAdminOrders(containerId);
                    } else {
                        showToast('❌ ' + result.error);
                        await renderAdminOrders(containerId);
                    }
                }
            } catch (e) {
                showToast('❌ ' + e.message);
            } finally {
                select.disabled = false;
            }
        });
    });

    // ✅ Bouton Payé/Non Payé
    container.querySelectorAll('[data-action="toggle-payment"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.id;
            const order = adminOrdersCache.find(o => o.id === orderId);
            if (!order) return;

            const currentPaid = order.paymentStatus === 'paid';
            const newStatus = currentPaid ? 'unpaid' : 'paid';

            btn.disabled = true;
            const originalLabel = btn.innerHTML;
            btn.innerHTML = '⏳...';

            const res = await updatePaymentStatus(orderId, newStatus);
            if (res.success) {
                showToast(`✅ Paiement : ${newStatus === 'paid' ? 'Payé' : 'Non payé'}`);
                const idx = adminOrdersCache.findIndex(o => o.id === orderId);
                if (idx > -1) adminOrdersCache[idx].paymentStatus = newStatus;
                await renderAdminOrders(containerId);
            } else {
                showToast('❌ ' + res.error);
                btn.disabled = false;
                btn.innerHTML = originalLabel;
            }
        });
    });

    container.querySelectorAll('[data-action="admin:sync-speedaf"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.id;
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '⏳...';
            const res = await syncSpeedafStatus(orderId);
            if (res.success) {
                if (res.updated) {
                    showToast(`✅ Statut mis à jour : ${res.newStatus}`);
                    adminOrdersCache = [];
                    await renderAdminOrders(containerId);
                } else {
                    showToast(`ℹ️ Statut Speedaf : ${res.currentStatus}`);
                }
            } else {
                showToast(`❌ Erreur: ${res.error}`);
            }
            btn.disabled = false;
            btn.innerHTML = originalText;
        });
    });

    container.querySelectorAll('[data-action="admin:delete-order"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.id;
            const confirmed = await confirmAction(
                t('confirmDeleteOrderMsg').replace('{id}', orderId.slice(0, 8).toUpperCase()),
                { title: t('confirmDeleteOrderTitle'), confirmText: t('confirmDeleteYes'), cancelText: t('confirmDeleteNo'), variant: 'danger' }
            );
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
// RETOURS & AVIS
// ============================================================
async function syncReviewsWithOrderReturn(order, allReturns) {
    if (!order || !order.userId || !Array.isArray(order.items) || order.items.length === 0) {
        return { deleted: 0, unverified: 0 };
    }
    const returnedByProduct = {};
    (allReturns || []).forEach(ret => {
        if (!ret || !Array.isArray(ret.items)) return;
        ret.items.forEach(item => {
            if (!item || item.productId === undefined) return;
            const pid = String(item.productId);
            returnedByProduct[pid] = (returnedByProduct[pid] || 0) + (Number(item.delta) || 0);
        });
    });
    const orderedByProduct = {};
    order.items.forEach(item => {
        const pid = String(item.productId);
        orderedByProduct[pid] = (orderedByProduct[pid] || 0) + (Number(item.quantity) || 0);
    });
    let deleted = 0, unverified = 0;
    let reviewsModule;
    try {
        reviewsModule = await import("./reviews.js");
    } catch (e) {
        return { deleted: 0, unverified: 0 };
    }
    const { deleteReview } = reviewsModule;
    for (const pid of Object.keys(returnedByProduct)) {
        const returnedQty = returnedByProduct[pid] || 0;
        const orderedQty = orderedByProduct[pid] || 0;
        if (returnedQty <= 0 || orderedQty <= 0) continue;
        const reviewId = `review_${order.userId}_${pid}`;
        const reviewRef = doc(db, "reviews", reviewId);
        try {
            const reviewSnap = await getDoc(reviewRef);
            if (!reviewSnap.exists()) continue;
            const reviewData = reviewSnap.data();
            if (returnedQty >= orderedQty) {
                const result = await deleteReview(reviewId);
                if (result && result.success) deleted++;
            } else {
                if (reviewData.verifiedPurchase === true) {
                    await updateDoc(reviewRef, { verifiedPurchase: false });
                    unverified++;
                }
            }
        } catch (e) {}
    }
    return { deleted, unverified };
}

export async function openReturnModal(orderId) {
    try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (!snap.exists()) return showToast('❌ Commande introuvable');
        const order = { id: snap.id, ...snap.data() };
        const items = order.items || [];

        const modalHtml = `
            <div class="modal-overlay open" id="returnModal" style="z-index:2500;">
                <div class="modal" style="max-width:600px;">
                    <button class="modal-close" id="closeReturnModalBtn">✕</button>
                    <h2 style="color:var(--gold);text-align:center;margin-bottom:0.5rem;">↩️ Gérer le retour</h2>
                    <p style="font-size:0.85rem;color:var(--text-muted);text-align:center;margin-bottom:1rem;">Commande #${orderId.slice(0,8).toUpperCase()}</p>
                    <div style="display:flex;flex-direction:column;gap:0.8rem;margin-bottom:1.5rem;">
                        ${items.map((item, index) => `
                            <div class="return-item-row">
                                <div style="flex:1;">
                                    <strong>${escapeHTML(item.name)}</strong>
                                    <div style="font-size:0.75rem;color:var(--text-muted);">Commandé : ${item.quantity}</div>
                                </div>
                                <div>
                                    <label style="font-size:0.75rem;color:var(--text-muted);">Qté retournée</label>
                                    <input type="number" class="return-qty-input" data-index="${index}" min="0" max="${item.quantity}" value="0">
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    <div style="display:flex;gap:0.5rem;justify-content:center;">
                        <button id="cancelReturnBtn" class="btn-secondary">Annuler</button>
                        <button id="confirmReturnBtn" class="btn-primary" style="background:var(--return-color);border-color:var(--return-color);">Valider le retour</button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);
        const modal = document.getElementById('returnModal');
        const closeModal = () => modal.remove();
        document.getElementById('closeReturnModalBtn').addEventListener('click', closeModal);
        document.getElementById('cancelReturnBtn').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

        document.getElementById('confirmReturnBtn').addEventListener('click', async () => {
            const inputs = modal.querySelectorAll('.return-qty-input');
            const returns = [];
            let hasChanges = false;
            inputs.forEach((input, index) => {
                const qty = parseInt(input.value) || 0;
                if (qty > 0) {
                    returns.push({ productId: items[index].productId, variant: items[index].variant || null, quantity: qty });
                    hasChanges = true;
                }
            });
            if (!hasChanges) { showToast('⚠️ Aucune quantité à retourner'); return; }

            const btn = document.getElementById('confirmReturnBtn');
            btn.disabled = true; btn.textContent = '⏳...';

            try {
                await processReturnTransaction(order, returns);
                const allReturns = [...(Array.isArray(order.returns) ? order.returns : []), { date: new Date(), items: returns.map(r => ({ productId: r.productId, variant: r.variant, delta: r.quantity })) }];
                let reviewSync = { deleted: 0, unverified: 0 };
                try { reviewSync = await syncReviewsWithOrderReturn(order, allReturns); } catch (e) {}
                let toastMsg = '✅ Retour enregistré, stock mis à jour';
                if (reviewSync.deleted > 0) toastMsg += ` · ${reviewSync.deleted} avis supprimé(s)`;
                if (reviewSync.unverified > 0) toastMsg += ` · ${reviewSync.unverified} badge(s) retiré(s)`;
                showToast(toastMsg, 4000);
                closeModal();
                if (typeof resetAdminOrdersCache === 'function') resetAdminOrdersCache();
                if (typeof renderAdminOrders === 'function') renderAdminOrders('adminOrdersList');
            } catch (err) {
                showToast('❌ ' + err.message);
                btn.disabled = false; btn.textContent = 'Valider le retour';
            }
        });
    } catch (e) {
        console.error(e);
        showToast('❌ Erreur lors de l\'ouverture du retour');
    }
}

async function processReturnTransaction(order, returnsToProcess) {
    await runTransaction(db, async (transaction) => {
        const orderRef = doc(db, "orders", order.id);
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists()) throw new Error("Commande introuvable");
        const currentOrder = orderSnap.data();
        const currentReturns = currentOrder.returns || [];
        const productRefs = returnsToProcess.map(r => doc(db, "products", String(r.productId)));
        const productSnaps = await Promise.all(productRefs.map(ref => transaction.get(ref)));

        productSnaps.forEach((snap, i) => {
            if (!snap.exists()) return;
            const pData = snap.data();
            const r = returnsToProcess[i];
            let updateData = { salesCount: Math.max(0, (Number(pData.salesCount) || 0) - r.quantity) };
            if (r.variant) {
                const variants = [...(pData.variants || [])];
                const vIdx = variants.findIndex(v => (v.size||'') === (r.variant.size||'') && (v.color||'') === (r.variant.color||''));
                if (vIdx > -1) {
                    variants[vIdx].stock = (Number(variants[vIdx].stock) || 0) + r.quantity;
                    updateData.variants = variants;
                    updateData.stock = variants.reduce((sum, v) => sum + (Number(v.stock)||0), 0);
                }
            } else {
                updateData.stock = (Number(pData.stock) || 0) + r.quantity;
            }
            transaction.update(productRefs[i], updateData);
        });

        const newReturnEntry = { date: Timestamp.now(), items: returnsToProcess.map(r => ({ productId: r.productId, variant: r.variant, delta: r.quantity })) };
        transaction.update(orderRef, { returns: [...currentReturns, newReturnEntry], status: ORDER_STATUS.RETURNED, updatedAt: Timestamp.now() });
    });
}

// ============================================================
// ✅ NOUVEAU : SYNC AUTOMATIQUE EN ARRIÈRE-PLAN (Throttle 5 min)
// ============================================================
const AUTO_SYNC_THROTTLE_MS = 5 * 60 * 1000;
const AUTO_SYNC_STORAGE_PREFIX = 'swi9a_sync_';

let _autoSyncInProgress = false;

/**
 * Synchronise en arrière-plan les commandes actives avec Speedaf.
 * Throttle : 1 appel max par commande toutes les 5 minutes (via localStorage).
 *
 * @param {Array} orders - Liste des commandes à vérifier
 * @param {Function|null} onComplete - Callback appelé si ≥1 commande mise à jour
 */
export async function autoSyncActiveOrders(orders, onComplete = null) {
    if (isTestMode()) {
        console.log('🧪 [TEST] autoSyncActiveOrders désactivé en mode test');
        return;
    }

    if (_autoSyncInProgress) {
        console.log('⏸️ Auto-sync déjà en cours — skip');
        return;
    }

    if (typeof localStorage === 'undefined') return;

    const now = Date.now();

    const ordersToSync = (orders || []).filter(order => {
        const status = normalizeOrderStatus(order.status);
        const hasTracking = !!order.speedafTracking;
        const isActive = ['confirmed', 'shipping'].includes(status);
        if (!hasTracking || !isActive) return false;

        const key = AUTO_SYNC_STORAGE_PREFIX + order.id;
        let lastSync = 0;
        try {
            lastSync = parseInt(localStorage.getItem(key) || '0', 10) || 0;
        } catch (e) {
            return false;
        }
        if (now - lastSync < AUTO_SYNC_THROTTLE_MS) return false;
        return true;
    });

    if (ordersToSync.length === 0) {
        console.log('✅ Auto-sync : aucune commande éligible');
        return;
    }

    _autoSyncInProgress = true;
    console.log(`🔄 Auto-sync : ${ordersToSync.length} commande(s) à vérifier`);

    let updatedCount = 0;

    for (const order of ordersToSync) {
        try {
            localStorage.setItem(AUTO_SYNC_STORAGE_PREFIX + order.id, String(Date.now()));
        } catch (e) {}

        try {
            const result = await syncSpeedafStatus(order.id);
            if (result.success && result.updated) {
                updatedCount++;
                console.log(`✅ Cmd ${order.id.slice(0, 8)} → ${result.newStatus}`);
            }
        } catch (e) {
            console.warn(`⚠️ Auto-sync ${order.id.slice(0, 8)} :`, e?.message || e);
        }
    }

    _autoSyncInProgress = false;

    if (updatedCount > 0) {
        showToast(`🔄 ${updatedCount} commande(s) mise(s) à jour`, 3000);
        if (typeof onComplete === 'function') {
            try { onComplete(updatedCount); } catch (e) {}
        }
    }

    console.log(`✅ Auto-sync terminé : ${updatedCount}/${ordersToSync.length} mise(s) à jour`);
}

// ============================================================
// CLIENT : AFFICHER LES COMMANDES (avec timeline 4 étapes)
// ============================================================
export async function renderUserOrders(containerId = 'tabContent') {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">⏳ ${t('loadingOrders')}</div>`;
    try {
        const orders = await loadUserOrders();
        if (!orders || orders.length === 0) {
            container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted);">${t('noOrders')}</div>`;
            return;
        }

        // ✅ Auto-sync en arrière-plan (throttled) — re-render si updates
        autoSyncActiveOrders(orders, () => {
            const c = document.getElementById(containerId);
            if (c) renderUserOrders(containerId);
        });

        let html = '';
        orders.forEach(order => {
            const status = normalizeOrderStatus(order.status);
            const emoji = getOrderStatusEmoji(status);
            const date = formatDateTime(order.createdAt);
            const idShort = order.id.slice(0, 8).toUpperCase();
            const cancellable = isOrderCancellable(order);
            const timeRemaining = cancellable ? formatTimeRemaining(getTimeRemainingForCancellation(order)) : null;
            const isTest = order._test === true;
            const testBadge = isTest
                ? `<span style="background:#dc3545;color:#fff;font-size:0.6rem;padding:0.1rem 0.35rem;border-radius:30px;margin-left:0.3rem;font-weight:700;">TEST</span>`
                : '';

            const cancelBtnHtml = cancellable
                ? `<div style="margin-top:0.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.4rem;">
                       <span style="font-size:0.75rem;color:var(--gold);font-weight:600;">⏱️ ${t('orderCancellableIn').replace('{time}', timeRemaining)}</span>
                       <button class="order-cancel-btn" data-order-id="${order.id}">${t('orderCancel')}</button>
                   </div>`
                : '';

            const trackingBtnHtml = order.speedafTracking
                ? `<a href="https://www.speedaf.com/tracking?waybill=${encodeURIComponent(order.speedafTracking)}" target="_blank" rel="noopener noreferrer"
                       style="display:inline-flex; align-items:center; gap:0.3rem; padding:0.4rem 1rem; background:rgba(165,123,46,0.1); color:var(--gold); border:1px solid var(--gold); border-radius:30px; text-decoration:none; font-weight:700; font-size:0.8rem;">
                       🚚 Suivre mon colis
                   </a>`
                : '';

            // ✅ Timeline 4 étapes (done ✓, current emoji, future emoji)
            const timelineSteps = getOrderTimelineSteps(status);
            const timelineHtml = `
                <div class="order-timeline" style="margin:1rem 0; padding:0.8rem 0.3rem;">
                    ${timelineSteps.map(step => {
                        const isDone = step.done;
                        const isCurrent = step.current;
                        const dotContent = (isDone && !isCurrent) ? '✓' : step.emoji;
                        return `
                            <div class="order-timeline-step ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''} ${status === 'returned' ? 'returned' : ''}">
                                <div class="order-timeline-dot">${dotContent}</div>
                                <span class="order-timeline-label">${t(step.label)}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;

            html += `
                <div class="order-card">
                    <div class="order-card-header">
                        <span class="order-card-id">#${idShort}${testBadge} ${emoji}</span>
                        <span class="order-card-date">${date}</span>
                    </div>
                    ${timelineHtml}
                    <div class="order-card-body">
                        <div>🛒 <strong>${order.items?.length || 0}</strong> ${t('items')} - <strong>${order.total || 0} ${t('currency')}</strong></div>
                        <div style="font-size:0.8rem;color:var(--text-muted);">📍 ${escapeHTML(order.deliveryAddress?.city || '')}</div>
                    </div>
                    <div class="order-card-actions" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">
                        <button class="order-details-btn" data-order-id="${order.id}">${t('orderDetails')}</button>
                        ${trackingBtnHtml}
                    </div>
                    ${cancelBtnHtml}
                </div>
            `;
        });

        container.innerHTML = html;

        container.querySelectorAll('.order-details-btn').forEach(btn => {
            btn.addEventListener('click', () => openOrderDetails(btn.dataset.orderId, false));
        });

        container.querySelectorAll('.order-cancel-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const orderId = btn.dataset.orderId;
                const confirmed = await confirmAction(t('confirmCancelOrderMsg'), {
                    title: t('confirmCancelOrderTitle'),
                    confirmText: t('confirmCancelOrderYes'),
                    cancelText: t('confirmCancelOrderNo'),
                    variant: 'danger'
                });
                if (!confirmed) return;
                btn.disabled = true;
                btn.textContent = '⏳...';
                const res = await cancelOrder(orderId);
                if (res.success) {
                    showToast('✅ ' + t('orderCancelled'));
                    await renderUserOrders(containerId);
                } else {
                    showToast('❌ ' + res.error);
                    btn.disabled = false;
                    btn.textContent = t('orderCancel');
                }
            });
        });
    } catch (e) {
        console.error(e);
        container.innerHTML = `<div style="color:var(--danger);text-align:center;">${t('loadingError')}</div>`;
    }
}

// ============================================================
// MODALE DÉTAILS CLIENT
// ============================================================
export async function openOrderDetails(orderId, isAdmin = false) {
    try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (!snap.exists()) return showToast('❌ Commande introuvable');
        const order = { id: snap.id, ...snap.data() };
        const status = normalizeOrderStatus(order.status);
        const timelineSteps = getOrderTimelineSteps(status);
        const timelineHtml = timelineSteps.map(step => `
            <div class="order-timeline-step ${step.active ? 'done' : ''} ${step.current ? 'current' : ''} ${status === 'returned' ? 'returned' : ''}">
                <div class="order-timeline-dot">${step.emoji}</div>
                <span class="order-timeline-label">${t(step.label)}</span>
            </div>
        `).join('');
        const itemsHtml = (order.items || []).map(item => {
            const v = item.variant ? ` (${[item.variant.size, item.variant.color].filter(Boolean).join('-')})` : '';
            return `<div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px dashed var(--border);font-size:0.85rem;"><span>${escapeHTML(item.name)}${escapeHTML(v)} × ${item.quantity}</span><strong style="color:var(--gold);">${item.price * item.quantity} MAD</strong></div>`;
        }).join('');
        let trackingHtml = '';
        if (order.speedafTracking) {
            trackingHtml = `<div style="background:rgba(165,123,46,0.1);padding:1rem;border-radius:var(--radius-sm);margin-bottom:1rem;font-size:0.85rem;border:1px solid var(--border-gold);"><h4 style="margin-bottom:0.5rem;color:var(--gold);font-size:0.95rem;">🚚 Livraison Speedaf</h4><div><strong>N° de suivi :</strong> ${escapeHTML(order.speedafTracking)}</div><a href="https://www.speedaf.com/tracking?waybill=${order.speedafTracking}" target="_blank" style="display:inline-block; margin-top:0.5rem; color:var(--gold); font-weight:700; text-decoration:underline;">Suivre en temps réel →</a></div>`;
        }
        let html = `
            <div class="modal-overlay open" id="orderDetailsModal" style="z-index:2500;">
                <div class="modal" style="max-width:600px;padding:1.5rem;">
                    <button class="modal-close" id="closeOrderDetailsBtn">✕</button>
                    <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:1rem;">#${orderId.slice(0,8).toUpperCase()}</h2>
                    <div class="order-timeline" style="margin:1rem 0;">${timelineHtml}</div>
                    ${trackingHtml}
                    <div style="background:var(--bg-surface);padding:1rem;border-radius:var(--radius-sm);margin-bottom:1rem;">
                        <h4 style="margin-bottom:0.5rem;color:var(--text);font-size:0.95rem;">📦 ${t('orderArticles')}</h4>
                        ${itemsHtml}
                        <div style="display:flex;justify-content:space-between;margin-top:0.8rem;font-weight:800;color:var(--text);"><span>${t('orderTotal')}</span><span style="color:var(--gold);">${order.total || 0} MAD</span></div>
                    </div>
                    <div style="background:var(--bg-surface);padding:1rem;border-radius:var(--radius-sm);margin-bottom:1rem;font-size:0.85rem;">
                        <h4 style="margin-bottom:0.5rem;color:var(--text);font-size:0.95rem;">📍 ${t('orderDeliveryAddress')}</h4>
                        <div><strong>${escapeHTML(order.deliveryAddress?.name || '')}</strong></div>
                        <div>${escapeHTML(order.deliveryAddress?.phone || '')}</div>
                        <div>${escapeHTML(order.deliveryAddress?.address || '')}</div>
                        <div>${escapeHTML(order.deliveryAddress?.city || '')}</div>
                        ${order.deliveryAddress?.note ? `<div style="margin-top:0.5rem;padding:0.5rem;background:rgba(165,123,46,0.08);border-radius:8px;font-style:italic;">📝 ${escapeHTML(order.deliveryAddress.note)}</div>` : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', html);
        const modal = document.getElementById('orderDetailsModal');
        const closeModal = () => modal.remove();
        document.getElementById('closeOrderDetailsBtn').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    } catch (e) {
        console.error(e);
        showToast('❌ ' + t('error'));
    }
}

// ============================================================
// LOG
// ============================================================
console.log('✅ orders.js chargé — v6.0.0 (Timeline + Auto-Sync + Auto-Pay + Paiement)');