/* ============================================================
   js/orders.js
   Gestion des commandes - Smart Swi9a
   Version 11.1.0 - Nettoyage des imports (audit)
   ============================================================ */

import {
    collection, doc, getDocs, getDoc, updateDoc,
    query, where, orderBy, limit, startAfter, Timestamp,
    runTransaction, writeBatch, increment, addDoc
} from "firebase/firestore";
import { db, auth } from "./firebase.js";
import {
    CONFIG, ORDER_STATUS, normalizeOrderStatus, NOTIFICATION_TYPES,
    isTestMode, APP_MODE,
    mapLivoStatusToSmart
} from "./config.js";
import {
    t, escapeHTML, formatDateTime,
    getOrderStatusEmoji,
    getOrderTimelineSteps,
    isOrderCancellable, getTimeRemainingForCancellation, formatTimeRemaining,
    toDate, getCityName, getLang,
    cleanMoroccanPhone, formatLivoDate
} from "./utils.js";
import { getCurrentUser } from "./auth.js";
import { showToast, confirmAction } from "./ui-core.js";
import { cancelOrder, loadUserOrders } from "./cart.js";

/* ============================================================
   CONFIGURATION LIVO (via Worker Cloudflare livo-proxy)
   ============================================================ */
const LIVO_API_CONFIG = {
    BASE_URL: CONFIG.LOGISTICS.PROXY_WORKER_URL,
    ENDPOINTS: {
        CREATE: '/create-order',
        CANCEL: '/cancel-order',
        TRACK:  '/track',
        PICKUP: '/create-pickup'
    }
};

/* ============================================================
   AUTHENTIFICATION DU PROXY LIVO
   ============================================================ */
async function getLivoRequestHeaders(extra = {}) {
    const user = auth.currentUser;
    if (!user) throw new Error('Vous devez être connecté pour utiliser Livo.');
    const token = await user.getIdToken();
    if (!token) throw new Error('Impossible de vérifier la session. Reconnectez-vous.');
    return { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...extra };
}

/* ============================================================
   CONFIGURATION EMAILJS
   ============================================================ */
const EMAILJS = {
    SERVICE_ID: 'service_gder468',
    TEMPLATE_ID: 'template_6tp1n35',
    PUBLIC_KEY: '47Wn3We2YOdAoSN2g'
};

/* ============================================================
   HELPERS EMAILJS
   ============================================================ */
let emailjsSDK = null;

async function getEmailJS() {
    if (emailjsSDK) return emailjsSDK;
    try {
        const mod = await import('https://cdn.jsdelivr.net/npm/@emailjs/browser@4/+esm');
        emailjsSDK = mod.default || mod;
        emailjsSDK.init({ publicKey: EMAILJS.PUBLIC_KEY });
        console.log('EmailJS SDK chargé');
        return emailjsSDK;
    } catch (e) {
        console.error('Erreur chargement EmailJS :', e);
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
        console.error('Erreur envoi email :', e);
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
    } catch (e) { /* ignore */ }
    return 'fr';
}

/* ============================================================
   BUILDERS EMAIL (SUJETS)
   ============================================================ */
function buildOrderEmailSubject(status, recipient, orderId, lang = 'fr') {
    const shortId = String(orderId).slice(0, 8).toUpperCase();
    const subjects = {
        fr: {
            pending:   { client: `Commande reçue #${shortId} | Smart Swi9a`, admin: `Nouvelle commande #${shortId}` },
            confirmed: { client: `Commande confirmée #${shortId} | Smart Swi9a`, admin: null },
            shipping:  { client: `Commande en route #${shortId} | Smart Swi9a`, admin: null },
            delivered: { client: `Commande livrée #${shortId} | Smart Swi9a`, admin: `Commande livrée #${shortId}` },
            returned:  { client: `Retour enregistré #${shortId} | Smart Swi9a`, admin: `Retour commande #${shortId}` },
            cancelled: { client: `Commande annulée #${shortId} | Smart Swi9a`, admin: null }
        },
        ar: {
            pending:   { client: `تم استلام طلبك #${shortId} | سمارت سويقة`, admin: `طلب جديد #${shortId}` },
            confirmed: { client: `تم تأكيد طلبك #${shortId} | سمارت سويقة`, admin: null },
            shipping:  { client: `طلبك في الطريق #${shortId} | سمارت سويقة`, admin: null },
            delivered: { client: `تم تسليم طلبك #${shortId} | سمارت سويقة`, admin: `تم التسليم #${shortId}` },
            returned:  { client: `تم تسجيل الإرجاع #${shortId} | سمارت سويقة`, admin: `إرجاع #${shortId}` },
            cancelled: { client: `تم إلغاء طلبك #${shortId} | سمارت سويقة`, admin: null }
        },
        en: {
            pending:   { client: `Order received #${shortId} | Smart Swi9a`, admin: `New order #${shortId}` },
            confirmed: { client: `Order confirmed #${shortId} | Smart Swi9a`, admin: null },
            shipping:  { client: `Order shipping #${shortId} | Smart Swi9a`, admin: null },
            delivered: { client: `Order delivered #${shortId} | Smart Swi9a`, admin: `Order delivered #${shortId}` },
            returned:  { client: `Return recorded #${shortId} | Smart Swi9a`, admin: `Return #${shortId}` },
            cancelled: { client: `Order cancelled #${shortId} | Smart Swi9a`, admin: null }
        }
    };
    const langSet = subjects[lang] || subjects.fr;
    const entry = langSet[status] || langSet.pending;
    return entry[recipient] || `Smart Swi9a #${shortId}`;
}

/* ============================================================
   BUILDERS EMAIL (TEXTE BRUT)
   ============================================================ */
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
        text += `- ${item.name}${variantText} x ${item.quantity} : ${(item.price * item.quantity)} MAD\n`;
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
        return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;text-align:${align};">${itemName} x ${qty}${variantText}</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;text-align:${align === 'left' ? 'right' : 'left'};color:#a57b2e;font-weight:bold;">${price * qty} MAD</td></tr>`;
    }).join('');
}

/* ============================================================
   BUILDERS EMAIL (HTML)
   ============================================================ */
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

/* ============================================================
   FACTURES (builders)
   ============================================================ */
function getInvoiceNumber(order) { return 'INV-' + String(order.id || '').slice(0, 8).toUpperCase(); }

function buildInvoiceSubject(order, recipient, lang = 'fr') {
    const invoiceNum = getInvoiceNumber(order);
    const subjects = {
        fr: { client: `Votre facture ${invoiceNum} | Smart Swi9a`, admin: `Facture ${invoiceNum} - Commande livrée` },
        ar: { client: `فاتورتك ${invoiceNum} | سمارت سويقة`, admin: `فاتورة ${invoiceNum} - تم التسليم` },
        en: { client: `Your invoice ${invoiceNum} | Smart Swi9a`, admin: `Invoice ${invoiceNum} - Delivered` }
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
    if (volumeDiscount > 0) rowsTotals.push(`<tr><td style="padding:6px 8px;font-size:13px;color:#2ecc71;text-align:${align};">${l.volumeDiscount}</td><td style="padding:6px 8px;font-size:13px;color:#2ecc71;font-weight:600;text-align:${isRtl ? 'left' : 'right'};">−${volumeDiscount} MAD</td></tr>`);
    if (couponDiscount > 0 && couponCode) rowsTotals.push(`<tr><td style="padding:6px 8px;font-size:13px;color:#2ecc71;text-align:${align};">${l.couponDiscount} <strong style="color:#a57b2e;">${couponCode}</strong></td><td style="padding:6px 8px;font-size:13px;color:#2ecc71;font-weight:600;text-align:${isRtl ? 'left' : 'right'};">−${couponDiscount} MAD</td></tr>`);
    rowsTotals.push(`<tr><td style="padding:6px 8px;font-size:13px;color:#5c5c5c;text-align:${align};">${l.delivery}</td><td style="padding:6px 8px;font-size:13px;color:#1a1a2e;font-weight:600;text-align:${isRtl ? 'left' : 'right'};">${deliveryFee} MAD</td></tr>`);
    return `<!DOCTYPE html><html dir="${dir}" lang="${lang}"><head><meta charset="UTF-8"><title>${l.invoice} ${invoiceNum}</title></head><body style="margin:0;padding:0;background:#f8f6f2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;direction:${dir};"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f6f2;padding:20px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:600px;width:100%;"><tr><td style="background:linear-gradient(135deg,#a57b2e 0%,#7d5a1d 100%);padding:24px 30px;"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="text-align:${align};"><div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:2px;">${l.shopName}</div></td><td style="text-align:${isRtl ? 'left' : 'right'};"><div style="font-size:11px;color:rgba(255,255,255,0.85);">${l.invoice}</div><div style="font-size:18px;font-weight:800;color:#ffffff;font-family:'Courier New',monospace;">${invoiceNum}</div></td></tr></table></td></tr><tr><td style="padding:24px 30px 12px;"><table width="100%"><tr><td style="text-align:${align};"><div style="font-size:11px;color:#a57b2e;font-weight:700;margin-bottom:8px;">${l.billedTo}</div><div style="font-size:15px;font-weight:700;color:#1a1a2e;">${clientName}</div>${clientPhone ? `<div style="font-size:13px;color:#5c5c5c;">${clientPhone}</div>` : ''}${clientAddress ? `<div style="font-size:13px;color:#5c5c5c;">${clientAddress}</div>` : ''}${clientCity ? `<div style="font-size:13px;color:#5c5c5c;">${clientCity}</div>` : ''}${clientEmail ? `<div style="font-size:13px;color:#5c5c5c;">${clientEmail}</div>` : ''}</td></tr></table></td></tr><tr><td style="padding:12px 30px;"><div style="font-size:11px;color:#a57b2e;font-weight:700;margin-bottom:8px;text-align:${align};">${l.items}</div><table width="100%" style="border:1px solid #f0f0f0;border-radius:8px;overflow:hidden;"><thead><tr style="background:#faf8f3;"><th style="padding:10px;text-align:${align};">${l.product}</th><th style="padding:10px;text-align:center;">${l.qty}</th><th style="padding:10px;text-align:${isRtl ? 'left' : 'right'};">${l.unitPrice}</th><th style="padding:10px;text-align:${isRtl ? 'left' : 'right'};">${l.lineTotal}</th></tr></thead><tbody>${itemsHtml}</tbody></table></td></tr><tr><td style="padding:12px 30px 20px;"><table width="100%" style="max-width:320px;margin-${isRtl ? 'right' : 'left'}:auto;">${rowsTotals.join('')}<tr><td colspan="2" style="padding:4px 8px;"><div style="height:1px;background:#f0f0f0;"></div></td></tr><tr><td style="padding:12px 8px 8px;font-size:15px;font-weight:800;text-align:${align};">${l.total}</td><td style="padding:12px 8px 8px;font-size:18px;color:#a57b2e;font-weight:800;text-align:${isRtl ? 'left' : 'right'};">${total} MAD</td></tr></table></td></tr><tr><td style="padding:0 30px 20px;"><table width="100%" style="background:#e8f8f0;border-left:4px solid #2ecc71;border-radius:6px;"><tr><td style="padding:12px 16px;text-align:${align};"><div style="font-size:11px;color:#2ecc71;font-weight:700;">${l.paymentMethod}</div><div style="font-size:14px;color:#1a1a2e;font-weight:700;">${l.cod} — ${l.paid}</div></td></tr></table></td></tr><tr><td style="background:#faf8f3;padding:16px 30px;text-align:center;border-top:1px solid #f0f0f0;"><div style="font-size:11px;color:#9a9a9a;line-height:1.6;">${l.footer}</div><div style="font-size:10px;color:#b5b5b5;margin-top:6px;">© ${new Date().getFullYear()} ${l.shopName} 🇲🇦</div></td></tr></table></td></tr></table></body></html>`;
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
    lines.push(`+212 6 56 61 33 03`);
    lines.push(`smartswi9a@gmail.com`);
    lines.push('');
    lines.push('────────────────────────────────────────');
    lines.push(`${isAr ? 'العميل' : 'Client'} : ${order.deliveryAddress?.name || '—'}`);
    lines.push('');
    lines.push(`${isAr ? 'المنتجات' : 'ARTICLES'} :`);
    (order.items || []).forEach(item => {
        const qty = Number(item.quantity) || 1;
        const price = Number(item.price) || 0;
        const v = item.variant ? ` (${[item.variant.size, item.variant.color].filter(Boolean).join('-')})` : '';
        lines.push(`  - ${item.name}${v} (x${qty}) : ${price * qty} MAD`);
    });
    lines.push('');
    lines.push(`Sous-total : ${order.subtotal || 0} MAD`);
    if (Number(order.discount) > 0) lines.push(`Réduction : -${order.discount} MAD`);
    if (Number(order.couponDiscount) > 0) lines.push(`Code ${order.couponCode} : -${order.couponDiscount} MAD`);
    lines.push(`Livraison : ${order.deliveryFee || 0} MAD`);
    lines.push(`TOTAL : ${order.total || 0} MAD`);
    lines.push('');
    lines.push(`${isAr ? 'الدفع عند الاستلام' : 'Paiement à la livraison'} - PAYÉ`);
    lines.push('');
    lines.push(isAr ? 'شكراً على ثقتكم!' : 'Merci pour votre confiance !');
    lines.push('');
    lines.push('SMART SWI9A');
    return lines.join('\n');
}

/* ============================================================
   ENVOI EMAIL (public)
   ============================================================ */
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

/* ============================================================
   LIVO - CREATE ORDER (via Worker proxy)
   ============================================================ */
export async function sendToLivoAPI(order) {
    if (isTestMode()) {
        console.log('[TEST] sendToLivoAPI MOCK - aucun appel Livo');
        return { success: true, trackingNumber: 'TEST-' + Date.now(), labelUrl: null };
    }

    try {
        if (!order || !order.deliveryAddress) {
            throw new Error('Données de commande invalides');
        }
        const addr = order.deliveryAddress;

        const phone = cleanMoroccanPhone(addr.phone);
        if (!/^0[67]\d{8}$/.test(phone)) {
            throw new Error(`Téléphone destinataire invalide (${addr.phone}). Doit commencer par 06 ou 07.`);
        }

        const cityName = addr.cityFr || addr.city || 'Casablanca';

        const itemsWithLivoIds = [];
        for (const item of (order.items || [])) {
            const productSnap = await getDoc(doc(db, 'products', String(item.productId)));
            if (!productSnap.exists()) {
                throw new Error(`Produit ${item.productId} introuvable en base.`);
            }
            const productData = productSnap.data();
            const livoProductId = productData.livo_product_id;
            if (!livoProductId) {
                throw new Error(
                    `Produit "${productData.nameFr || item.name}" sans livo_product_id. ` +
                    `Créer le produit dans Livo UI puis renseigner le champ 'livo_product_id' dans Firestore.`
                );
            }
            itemsWithLivoIds.push({
                product_id: livoProductId,
                quantity: Number(item.quantity) || 1,
                refr: item.sku || String(item.productId)
            });
        }

        const payload = {
            cost: Number(order.total) || 0,
            target: {
                name: String(addr.name || 'Client').slice(0, 100),
                phone: phone,
                city: String(cityName).slice(0, 100),
                address: String(addr.address || 'Casablanca').slice(0, 500)
            },
            products: itemsWithLivoIds,
            desired_date: formatLivoDate(new Date()),
            openable: false,
            comment: 'Commande Smart Swi9a',
            status: 'pending',
            client_order_id: String(order.id).slice(0, 8).toUpperCase()
        };

        const response = await fetch(`${LIVO_API_CONFIG.BASE_URL}${LIVO_API_CONFIG.ENDPOINTS.CREATE}`, {
            method: 'POST',
            headers: await getLivoRequestHeaders(),
            body: JSON.stringify(payload)
        });

        const contentType = response.headers.get("content-type");
        let data;

        if (contentType && contentType.includes("application/json")) {
            data = await response.json();
        } else {
            const errorHtml = await response.text();
            console.error('Réponse non-JSON reçue (Worker/Livo) :', errorHtml.substring(0, 500));
            return {
                success: false,
                error: `Erreur serveur (${response.status}). Le Worker n'a pas pu joindre Livo.`
            };
        }

        if (!response.ok) {
            const message = data?.error || data?.message || `Erreur Worker/Livo HTTP ${response.status}`;
            return { success: false, error: String(message) };
        }

        console.log('Livo create response:', JSON.stringify(data, null, 2));

        const orderData = data?.data?.data || data?.data || null;
        const livoOrderId = orderData?._id || orderData?.order_id;

        if (data.success && livoOrderId) {
            return {
                success: true,
                trackingNumber: livoOrderId,
                labelUrl: null
            };
        }

        let errorMsg = 'Erreur inconnue';
        const errData = data?.data?.data || data?.data || data;
        if (errData?.fr_message) errorMsg = errData.fr_message;
        else if (errData?.en_message) errorMsg = errData.en_message;
        else if (errData?.error) errorMsg = errData.error;
        else if (data.error) errorMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);

        return { success: false, error: errorMsg };

    } catch (error) {
        console.error('Erreur Livo create:', error);
        return { success: false, error: error.message };
    }
}

/* ============================================================
   LIVO - CANCEL SHIPMENT (via Worker proxy)
   ============================================================ */
export async function cancelLivoShipment(livoOrderId) {
    if (isTestMode()) {
        console.log('[TEST] cancelLivoShipment MOCK');
        return true;
    }

    if (!livoOrderId) return false;
    try {
        const response = await fetch(`${LIVO_API_CONFIG.BASE_URL}${LIVO_API_CONFIG.ENDPOINTS.CANCEL}`, {
            method: 'POST',
            headers: await getLivoRequestHeaders(),
            body: JSON.stringify({
                id: livoOrderId,
                status: 'cancelled'
            })
        });

        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            return false;
        }

        const data = await response.json();
        return response.ok && data?.success === true;
    } catch (error) {
        console.error('Erreur Livo cancel:', error);
        return false;
    }
}

/* ============================================================
   LIVO - SYNC STATUS (via Worker proxy)
   ============================================================ */
export async function syncLivoStatus(orderId) {
    if (isTestMode()) {
        console.log('[TEST] syncLivoStatus MOCK');
        return { success: true, updated: false, currentStatus: "test_mode_no_sync" };
    }

    try {
        const orderRef = doc(db, "orders", orderId);
        const snap = await getDoc(orderRef);
        if (!snap.exists()) return { success: false, error: "Commande introuvable" };

        const order = snap.data();
        const trackingId = order.livoTracking || order.speedafTracking;
        if (!trackingId) return { success: false, error: "Aucun numéro de suivi Livo" };

        const response = await fetch(`${LIVO_API_CONFIG.BASE_URL}${LIVO_API_CONFIG.ENDPOINTS.TRACK}/${encodeURIComponent(trackingId)}`, {
            method: 'GET',
            headers: await getLivoRequestHeaders({ 'Accept': 'application/json' })
        });

        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            return { success: false, error: "Réponse invalide du serveur (non-JSON)" };
        }

        const data = await response.json();
        const livoOrder = data?.data?.data || data?.data || null;
        if (!livoOrder) {
            return { success: false, error: "Réponse Livo vide" };
        }

        const livoStatus = livoOrder.status;
        if (!livoStatus) {
            return { success: true, updated: false, currentStatus: "unknown" };
        }

        const mapped = mapLivoStatusToSmart(livoStatus);
        const newStatus = mapped.status;

        if (mapped.unknown) {
            console.warn(`syncLivoStatus: statut Livo inconnu "${livoStatus}" pour ${orderId}`);
        }

        const currentStatus = normalizeOrderStatus(order.status);
        if (currentStatus === newStatus) {
            return { success: true, updated: false, currentStatus: livoStatus };
        }

        const updResult = await updateOrderStatus(orderId, newStatus);
        if (!updResult.success) {
            return { success: false, error: updResult.error || 'Erreur updateOrderStatus' };
        }

        const extras = { livoStatusRaw: livoStatus };
        if (livoStatus === 'problem') extras.livoProblem = true;
        else if (order.livoProblem) extras.livoProblem = false;

        if (livoOrder.return_status) extras.livoReturnStatus = livoOrder.return_status;

        try { await updateDoc(orderRef, extras); } catch (e) { /* ignore */ }

        return { success: true, updated: true, newStatus, currentStatus: livoStatus };

    } catch (error) {
        console.error('syncLivoStatus:', error);
        return { success: false, error: error.message };
    }
}

/* ============================================================
   LIVO - CREATE PICKUP (via Worker proxy)
   ============================================================ */
export async function createLivoPickup(pickupData) {
    if (isTestMode()) {
        console.log('[TEST] createLivoPickup MOCK - aucun appel Livo');
        return { success: true, pickupId: 'TEST-PI-' + Date.now(), trackingId: 'TEST-PI-' + Date.now() };
    }

    try {
        if (!pickupData) throw new Error('pickupData requis');
        if (!pickupData.desired_date) throw new Error('Date de ramassage requise');

        const items = Array.isArray(pickupData.items) ? pickupData.items.filter(Boolean) : [];
        const products = Array.isArray(pickupData.products) ? pickupData.products.filter(p => p && p.product_id && p.quantity > 0) : [];

        if (items.length === 0 && products.length === 0) {
            throw new Error('Au moins un item ou un produit est requis pour un ramassage Livo.');
        }

        const payload = {
            items: items,
            products: products,
            desired_date: formatLivoDate(pickupData.desired_date),
            comment: String(pickupData.comment || 'Ramassage Smart Swi9a').slice(0, 200)
        };

        const response = await fetch(`${LIVO_API_CONFIG.BASE_URL}${LIVO_API_CONFIG.ENDPOINTS.PICKUP}`, {
            method: 'POST',
            headers: await getLivoRequestHeaders(),
            body: JSON.stringify(payload)
        });

        const contentType = response.headers.get("content-type");
        let data;

        if (contentType && contentType.includes("application/json")) {
            data = await response.json();
        } else {
            const errorHtml = await response.text();
            console.error('Réponse non-JSON reçue (Worker/Livo pickups) :', errorHtml.substring(0, 500));
            return {
                success: false,
                error: `Erreur serveur (${response.status}). Le Worker n'a pas pu créer le ramassage.`
            };
        }

        if (!response.ok) {
            const message = data?.error || data?.message || `Erreur Worker/Livo HTTP ${response.status}`;
            return { success: false, error: String(message) };
        }

        console.log('Livo pickup response:', JSON.stringify(data, null, 2));

        const pickupResult = data?.data?.data || data?.data || null;
        const pickupId = pickupResult?._id || pickupResult?.pickup_id;

        if (data.success && pickupId) {
            return {
                success: true,
                pickupId: pickupId,
                trackingId: pickupId
            };
        }

        let errorMsg = 'Erreur inconnue';
        const errData = data?.data?.data || data?.data || data;
        if (errData?.fr_message) errorMsg = errData.fr_message;
        else if (errData?.en_message) errorMsg = errData.en_message;
        else if (errData?.error) errorMsg = errData.error;
        else if (data.error) errorMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);

        return { success: false, error: errorMsg };

    } catch (error) {
        console.error('Erreur Livo createPickup:', error);
        return { success: false, error: error.message };
    }
}

export const syncSpeedafStatus = syncLivoStatus;