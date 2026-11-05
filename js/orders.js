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
    text += `\nTotal: ${order.total || 0} MAD\nCity: ${city}\n\n${team[lang]}\nhttps://smartswika.ma`;
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
/* ============================================================
   UPDATE ORDER STATUS (public)
   ============================================================ */

/**
 * Met à jour le statut d'une commande (transaction Firestore).
 * Gère les transitions retour, annulation, livraison, et déclenche
 * les actions Livo / emails / notifications appropriées.
 * NOTE : Le crédit/débit du Wallet est géré par le trigger serveur
 *        onOrderStatusChanged (Cloud Function).
 *
 * @param {string} orderId
 * @param {string} newStatus - ORDER_STATUS.*
 * @returns {Promise<{ success: boolean, openedModal?: boolean, error?: string }>}
 */
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
        let previousStatusFinal = null;

        await runTransaction(db, async (transaction) => {
            const orderSnap = await transaction.get(orderRef);
            if (!orderSnap.exists()) throw new Error('Commande introuvable');

            const order = { id: orderId, ...orderSnap.data() };
            order.items = consolidateStockItems(order.items);
            const previousStatus = normalizeOrderStatus(order.status);
            previousStatusFinal = previousStatus;
            orderForEmail = order;
            emailStatus = normalizedStatus;

            if (!Object.values(ORDER_STATUS).includes(normalizedStatus)) throw new Error('Statut invalide');

            // N'autoriser que le cycle métier prévu. Sans cette vérification,
            // une commande pending pourrait être marquée livrée directement
            // et déclencher un crédit vendeur sans expédition réelle.
            const allowedTransitions = {
                [ORDER_STATUS.PENDING]: [ORDER_STATUS.CONFIRMED, ORDER_STATUS.CANCELLED],
                [ORDER_STATUS.CONFIRMED]: [ORDER_STATUS.SHIPPING, ORDER_STATUS.CANCELLED],
                [ORDER_STATUS.SHIPPING]: [ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED],
                [ORDER_STATUS.DELIVERED]: [],
                [ORDER_STATUS.RETURNED]: [],
                [ORDER_STATUS.CANCELLED]: []
            };
            if (!(allowedTransitions[previousStatus] || []).includes(normalizedStatus)) {
                throw new Error(`Transition de commande interdite : ${previousStatus} → ${normalizedStatus}.`);
            }

            let productSnaps = [];
            let productRefs = [];

            if (normalizedStatus === ORDER_STATUS.CONFIRMED && previousStatus === ORDER_STATUS.PENDING && order.stockDeducted !== true) {
                productRefs = [...new Set(order.items.map(i => String(i.productId)))].map(productId => doc(db, "products", productId));
                productSnaps = await Promise.all(productRefs.map(r => transaction.get(r)));
            }

            if (normalizedStatus === ORDER_STATUS.CANCELLED && [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED, ORDER_STATUS.SHIPPING].includes(previousStatus) && order.stockDeducted === true) {
                productRefs = [...new Set(order.items.map(i => String(i.productId)))].map(productId => doc(db, "products", productId));
                productSnaps = await Promise.all(productRefs.map(r => transaction.get(r)));
            }

            // Lire le coupon avant toute écriture de stock dans la transaction.
            let couponSnap = null;
            if (normalizedStatus === ORDER_STATUS.CANCELLED && order.couponId && !order.couponRestored) {
                couponSnap = await transaction.get(doc(db, "coupons", order.couponId));
            }

            if (normalizedStatus === ORDER_STATUS.CONFIRMED && previousStatus === ORDER_STATUS.PENDING && order.stockDeducted !== true) {
                await deductStockInTransaction(transaction, order, productSnaps, productRefs);
                order.stockDeducted = true;
            }

            if (normalizedStatus === ORDER_STATUS.CANCELLED && [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED, ORDER_STATUS.SHIPPING].includes(previousStatus) && order.stockDeducted === true) {
                await restoreStockInTransaction(transaction, order, productSnaps, productRefs);
                order.stockDeducted = false;
            }

            if (normalizedStatus === ORDER_STATUS.CANCELLED && order.couponId && !order.couponRestored) {
                const couponRef = doc(db, "coupons", order.couponId);
                const couponUseRef = doc(db, "coupon_uses", `${order.couponId}_${order.userId}`);
                if (couponSnap?.exists() && Number(couponSnap.data().usedCount) > 0) {
                    transaction.update(couponRef, { usedCount: increment(-1) });
                }
                transaction.delete(couponUseRef);
                order.couponRestored = true;
            }

            const updatePayload = {
                status: normalizedStatus,
                updatedAt: Timestamp.now(),
                stockDeducted: order.stockDeducted,
                couponRestored: order.couponRestored || false
            };

            if (normalizedStatus === ORDER_STATUS.DELIVERED) {
                updatePayload.paymentStatus = 'paid';
                updatePayload.paidAt = Timestamp.now();
            }

            transaction.update(orderRef, updatePayload);
        });

        /* NOTE : Le crédit/débit du wallet vendeur est géré par le trigger
           serveur onOrderStatusChanged (Cloud Function). */

        /* Création Livo lors du passage à CONFIRMED. */
        if (normalizedStatus === ORDER_STATUS.CONFIRMED && orderForEmail) {
            const trackingId = orderForEmail.livoTracking || orderForEmail.speedafTracking;
            if (!trackingId) {
                const livoResult = await sendToLivoAPI(orderForEmail);
                if (livoResult.success && livoResult.trackingNumber) {
                    await updateDoc(orderRef, {
                        status: ORDER_STATUS.SHIPPING,
                        livoTracking: livoResult.trackingNumber,
                        livoLabelUrl: livoResult.labelUrl || null,
                        livoSyncedAt: Timestamp.now()
                    });
                    emailStatus = ORDER_STATUS.SHIPPING;
                    orderForEmail.status = ORDER_STATUS.SHIPPING;
                    orderForEmail.livoTracking = livoResult.trackingNumber;
                    showToast(`Colis créé chez Livo (Suivi: ${livoResult.trackingNumber})`);
                } else {
                    showToast(`Livo a refusé la commande : ${livoResult.error}`, 4000);
                }
            }
        }

        /* Annulation Livo lors du passage à CANCELLED. */
        if (normalizedStatus === ORDER_STATUS.CANCELLED && orderForEmail) {
            const trackingId = orderForEmail.livoTracking || orderForEmail.speedafTracking;
            if (trackingId) {
                const cancelled = await cancelLivoShipment(trackingId);
                if (cancelled) showToast('Colis annulé chez Livo');
            }
        }

        if (emailStatus && ['confirmed', 'shipping', 'delivered', 'cancelled'].includes(emailStatus)) {
            try {
                await sendOrderEmail(orderForEmail, emailStatus, 'client');
                await sendOrderEmail(orderForEmail, emailStatus, 'admin');
            } catch (e) {
                console.warn('Email échoué (non bloquant):', e);
            }
        }

        if (normalizedStatus === ORDER_STATUS.DELIVERED && orderForEmail.userId) {
            try {
                const { createNotification } = await import("./notifications.js");
                const shortId = orderId.slice(0, 8).toUpperCase();

                await createNotification(
                    orderForEmail.userId,
                    NOTIFICATION_TYPES.ORDER_DELIVERED || 'order_delivered',
                    (t('notificationOrderDelivered') || 'Commande livrée'),
                    (t('notificationOrderDeliveredMsg') || 'Votre commande #{id} est livrée !').replace('{id}', shortId),
                    { orderId }
                );

                await createNotification(
                    orderForEmail.userId,
                    'review_request',
                    'Laissez un avis',
                    `Votre commande #${shortId} est livrée ! Partagez votre expérience.`,
                    { orderId, persistent: true }
                );
            } catch (e) {
                console.warn('Notification delivered échouée :', e);
            }
        }

        return { success: true };
    } catch (e) {
        console.error('Erreur update statut :', e);
        return { success: false, error: e.message };
    }
}

/* ============================================================
   STOCK HELPERS (transaction)
   ============================================================ */
function returnVariantKey(item) {
    const variant = item?.variant || null;
    return JSON.stringify([String(item?.productId ?? ''), variant?.size || '', variant?.color || '']);
}

function getReturnedQuantitiesByVariant(order) {
    const result = {};
    for (const entry of (Array.isArray(order?.returns) ? order.returns : [])) {
        for (const item of (Array.isArray(entry?.items) ? entry.items : [])) {
            if (item?.productId == null) continue;
            const key = returnVariantKey(item);
            result[key] = (result[key] || 0) + Math.max(0, Number(item.delta) || 0);
        }
    }
    return result;
}

function consolidateStockItems(items) {
    const merged = new Map();
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!item || item.productId == null) continue;
        const variant = item.variant || null;
        const key = JSON.stringify([String(item.productId), variant?.size || '', variant?.color || '']);
        const quantity = Math.floor(Number(item.quantity));
        if (!Number.isFinite(quantity) || quantity < 1) continue;
        const existing = merged.get(key);
        if (existing) existing.quantity += quantity;
        else merged.set(key, { ...item, variant, quantity });
    }
    return Array.from(merged.values());
}

async function deductStockInTransaction(transaction, order, productSnaps, productRefs) {
    productSnaps.forEach((snap, i) => {
        const productId = productRefs[i].id;
        if (!snap.exists()) throw new Error(`Produit ${productId} introuvable`);
        const pData = snap.data();
        const productItems = order.items.filter(item => String(item.productId) === productId);
        if (!productItems.length) return;
        const variants = Array.isArray(pData.variants) ? pData.variants.map(v => ({ ...v })) : [];
        let simpleStock = Number(pData.stock) || 0;
        let hasVariantItems = false, hasSimpleItems = false, totalQty = 0;
        for (const item of productItems) {
            const qty = Number(item.quantity);
            if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Quantité invalide pour ${pData.nameFr || productId}`);
            totalQty += qty;
            if (item.variant) {
                hasVariantItems = true;
                const idx = variants.findIndex(v => String(v.size || '') === String(item.variant.size || '') && String(v.color || '') === String(item.variant.color || ''));
                if (idx < 0) throw new Error(`Variante introuvable pour ${pData.nameFr || productId}`);
                const available = Number(variants[idx].stock);
                if (!Number.isFinite(available) || available < qty) throw new Error(`Stock insuffisant pour ${pData.nameFr || 'ce produit'}`);
                variants[idx].stock = available - qty;
            } else {
                hasSimpleItems = true;
                if (simpleStock < qty) throw new Error(`Stock insuffisant pour ${pData.nameFr || 'ce produit'}`);
                simpleStock -= qty;
            }
        }
        if (hasVariantItems && hasSimpleItems) throw new Error(`Structure de stock incohérente pour ${productId}`);
        const updateData = { salesCount: (Number(pData.salesCount) || 0) + totalQty, lastOrderId: order.id, updatedAt: Timestamp.now() };
        if (hasVariantItems) {
            updateData.variants = variants;
            updateData.stock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
        } else updateData.stock = simpleStock;
        transaction.update(productRefs[i], updateData);
    });
}

async function restoreStockInTransaction(transaction, order, productSnaps, productRefs) {
    productSnaps.forEach((snap, i) => {
        const productId = productRefs[i].id;
        if (!snap.exists()) throw new Error(`Produit ${productId} introuvable : restitution du stock impossible.`);
        const pData = snap.data();
        const productItems = order.items.filter(item => String(item.productId) === productId);
        if (!productItems.length) return;
        const variants = Array.isArray(pData.variants) ? pData.variants.map(v => ({ ...v })) : [];
        let simpleStock = Number(pData.stock) || 0;
        let hasVariantItems = false, hasSimpleItems = false, totalQty = 0;
        for (const item of productItems) {
            const qty = Number(item.quantity);
            if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Quantité invalide pour ${productId}`);
            totalQty += qty;
            if (item.variant) {
                hasVariantItems = true;
                const idx = variants.findIndex(v => String(v.size || '') === String(item.variant.size || '') && String(v.color || '') === String(item.variant.color || ''));
                if (idx < 0) throw new Error(`Variante introuvable pour ${productId} : restitution du stock impossible.`);
                const currentStock = Number(variants[idx].stock);
                if (!Number.isFinite(currentStock) || currentStock < 0) throw new Error(`Stock de variante invalide pour ${productId}`);
                variants[idx].stock = currentStock + qty;
            } else {
                hasSimpleItems = true;
                simpleStock += qty;
            }
        }
        if (hasVariantItems && hasSimpleItems) throw new Error(`Structure de stock incohérente pour ${productId}`);
        const updateData = { salesCount: Math.max(0, (Number(pData.salesCount) || 0) - totalQty), lastOrderId: order.id, updatedAt: Timestamp.now() };
        if (hasVariantItems) {
            updateData.variants = variants;
            updateData.stock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
        } else updateData.stock = simpleStock;
        transaction.update(productRefs[i], updateData);
    });
}

/* ============================================================
   SUPPRESSION COMPLÈTE
   ============================================================ */
export async function deleteOrderCompletely(orderId) {
    const orderSnap = await getDoc(doc(db, "orders", orderId));
    if (!orderSnap.exists()) return { success: false };
    const order = { id: orderId, ...orderSnap.data() };
    order.items = consolidateStockItems(order.items);
    const currentStatus = normalizeOrderStatus(order.status);

    // Ne jamais supprimer une commande ayant un historique de livraison,
    // de retour ou d'écriture financière. Seules les commandes annulées,
    // dont le stock a déjà été restitué, peuvent être supprimées.
    if (
        currentStatus !== ORDER_STATUS.CANCELLED ||
        order.stockDeducted === true ||
        (Array.isArray(order.returns) && order.returns.length > 0) ||
        Object.keys(order.vendorCredits || {}).length > 0 ||
        Object.keys(order.vendorDebits || {}).length > 0
    ) {
        throw new Error("Suppression refusée : seules les commandes annulées sans retour ni mouvement financier peuvent être supprimées.");
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

/* ============================================================
   RELEASE DES FONDS ÉCHUS (Appel API serveur)
   ============================================================ */

/**
 * Débloque les fonds échus en appelant la Cloud Function sécurisée.
 * Le serveur transfère pendingBalance -> availableBalance.
 * NOTE : L'appel direct depuis un client (vendor-dashboard, etc.) est
 * réservé à l'admin. Cette fonction est utilisée dans admin.js via
 * fetch('/api/releaseDueFunds', ...).
 */
export async function releaseDueVendorFunds(options = {}) {
    try {
        const user = auth.currentUser;
        if (!user) throw new Error("Session expirée.");
        const idToken = await user.getIdToken(true);

        const response = await fetch('/api/releaseDueFunds', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({ batchSize: options.batchSize || 400 })
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) {
            throw new Error(result.message || "Erreur lors du déblocage des fonds.");
        }

        return result;
    } catch (e) {
        console.error('releaseDueVendorFunds:', e);
        return { success: false, errors: [{ global: e.message }] };
    }
}

/* ============================================================
   BASCULER LE STATUT DE PAIEMENT (admin)
   ============================================================ */
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
        console.error('updatePaymentStatus:', e);
        return { success: false, error: e.message };
    }
}

/* ============================================================
   ADMIN : RENDRE LES COMMANDES
   ============================================================ */
export async function renderAdminOrders(containerId = 'ordersList') {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (adminOrdersCache.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">${t('loadingOrders')}</div>`;
        const { orders, hasMore } = await loadAllOrders(true);
        adminOrdersCache = orders;
        adminHasMore = hasMore;
    }

    if (adminOrdersCache.length === 0) {
        container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:2rem;">${t('noOrders')}</p>`;
        return;
    }

    let html = `<div style="display:flex; justify-content:flex-end; margin-bottom:1rem;">
        <button id="refreshAdminOrdersBtn" class="admin-btn-secondary" style="font-size:0.8rem;">Rafraîchir</button>
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
            ? `<span style="font-size:0.7rem;color:var(--success);font-weight:700;">Stock déduit</span>`
            : `<span style="font-size:0.7rem;color:var(--warning);font-weight:700;">Stock non déduit</span>`;

        const isPaid = order.paymentStatus === 'paid';
        const paymentBtnStyle = isPaid
            ? 'background:rgba(46,204,113,0.15);color:var(--success);border:1px solid var(--success);'
            : 'background:rgba(230,126,34,0.15);color:var(--warning);border:1px solid var(--warning);';
        const paymentBtnLabel = isPaid ? 'Payé' : 'Non payé';
        const paymentBtnHtml = `
            <button class="admin-btn-payment" data-action="toggle-payment" data-id="${order.id}"
                style="padding:0.35rem 0.8rem;border-radius:30px;font-size:0.75rem;font-weight:700;cursor:pointer;${paymentBtnStyle}">
                ${paymentBtnLabel}
            </button>
        `;

        const vendorCount = Array.isArray(order.vendorIds) ? order.vendorIds.length : 0;
        const vendorBadge = vendorCount > 0
            ? `<span style="background:#3498db;color:#fff;font-size:0.65rem;padding:0.15rem 0.4rem;border-radius:30px;margin-left:0.3rem;font-weight:700;">${vendorCount} vendeur${vendorCount > 1 ? 's' : ''}</span>`
            : '';

        const trackingId = order.livoTracking || order.speedafTracking;
        const labelUrl = order.livoLabelUrl || order.speedafLabelUrl;

        let livoHtml = '';
        if (trackingId) {
            livoHtml = `<div style="margin-top:0.5rem; padding:0.5rem; background:rgba(165,123,46,0.05); border:1px solid var(--border-gold); border-radius:var(--radius-sm); font-size:0.8rem;">
                <strong>Livo:</strong> <code>${escapeHTML(trackingId)}</code>
                ${labelUrl ? `<a href="${escapeHTML(labelUrl)}" target="_blank" style="margin-left:0.5rem; color:var(--gold); font-weight:700;">Étiquette</a>` : ''}
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
                        <strong style="color:var(--gold);">#${orderIdShort}</strong>${testBadge}${vendorBadge} ${emoji} - ${date}<br>
                        <small>${escapeHTML(order.deliveryAddress?.name || '—')} - ${escapeHTML(order.deliveryAddress?.phone || '')} - ${escapeHTML(cityDisplay)}</small><br>
                        <small><strong>${itemsSummary}</strong></small><br>
                        <small>${itemCount} ${t('items')} - ${order.total || 0} ${t('currency')} - ${stockBadge}</small>
                    </div>
                </div>
                ${livoHtml}
                <div style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center; margin-top:0.5rem;">
                    <select class="status-select" data-order-id="${order.id}" data-field="status" style="padding:0.3rem 0.6rem;border-radius:30px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text);">
                        <option value="pending" ${status === 'pending' ? 'selected' : ''}>${t('orderStatusPending')}</option>
                        <option value="confirmed" ${status === 'confirmed' ? 'selected' : ''}>${t('orderStatusConfirmed')}</option>
                        <option value="shipping" ${status === 'shipping' ? 'selected' : ''}>${t('orderStatusShipping')}</option>
                        <option value="delivered" ${status === 'delivered' ? 'selected' : ''}>${t('orderStatusDelivered')}</option>
                        <option value="returned" ${status === 'returned' ? 'selected' : ''}>${t('orderStatusReturned')}</option>
                        <option value="cancelled" ${status === 'cancelled' ? 'selected' : ''}>${t('orderStatusCancelled')}</option>
                    </select>
                    ${paymentBtnHtml}
                    ${trackingId ? `<button class="admin-btn-secondary" data-action="admin:sync-livo" data-id="${order.id}" style="font-size:0.75rem; padding:0.3rem 0.6rem;">Sync Livo</button>` : ''}
                    <button class="btn-danger" data-action="admin:delete-order" data-id="${order.id}" style="padding:0.3rem 0.8rem;border-radius:30px;background:var(--danger);color:white;border:none;cursor:pointer;margin-left:auto;">Supprimer</button>
                </div>
            </div>
        `;
    });

    if (adminHasMore) {
        html += `<div style="text-align:center;padding:1rem;"><button id="adminLoadMoreOrdersBtn" class="admin-btn-primary" style="margin:0 auto;">Charger plus</button></div>`;
    }

    container.innerHTML = html;

    document.getElementById('refreshAdminOrdersBtn')?.addEventListener('click', async (e) => {
        e.target.textContent = '...';
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
                        showToast(t('success'));
                        adminOrdersCache = [];
                        await renderAdminOrders(containerId);
                    } else {
                        showToast(result.error);
                        await renderAdminOrders(containerId);
                    }
                }
            } catch (e) {
                showToast(e.message);
            } finally {
                select.disabled = false;
            }
        });
    });

    container.querySelectorAll('[data-action="toggle-payment"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.id;
            const order = adminOrdersCache.find(o => o.id === orderId);
            if (!order) return;

            const currentPaid = order.paymentStatus === 'paid';
            const newStatus = currentPaid ? 'unpaid' : 'paid';

            btn.disabled = true;
            const originalLabel = btn.innerHTML;
            btn.innerHTML = '...';

            const res = await updatePaymentStatus(orderId, newStatus);
            if (res.success) {
                showToast(`Paiement : ${newStatus === 'paid' ? 'Payé' : 'Non payé'}`);
                const idx = adminOrdersCache.findIndex(o => o.id === orderId);
                if (idx > -1) adminOrdersCache[idx].paymentStatus = newStatus;
                await renderAdminOrders(containerId);
            } else {
                showToast(res.error);
                btn.disabled = false;
                btn.innerHTML = originalLabel;
            }
        });
    });

    container.querySelectorAll('[data-action="admin:sync-livo"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.id;
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '...';
            const res = await syncLivoStatus(orderId);
            if (res.success) {
                if (res.updated) {
                    showToast(`Statut mis à jour : ${res.newStatus}`);
                    adminOrdersCache = [];
                    await renderAdminOrders(containerId);
                } else {
                    showToast(`Statut Livo : ${res.currentStatus}`);
                }
            } else {
                showToast(`Erreur: ${res.error}`);
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
                showToast(t('delete'));
                adminOrdersCache = adminOrdersCache.filter(o => o.id !== orderId);
                await renderAdminOrders(containerId);
            } catch (e) {
                showToast(e.message);
                btn.disabled = false;
            }
        });
    });

    const loadMoreBtn = document.getElementById('adminLoadMoreOrdersBtn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', async () => {
            loadMoreBtn.disabled = true;
            loadMoreBtn.textContent = t('loading');
            const { orders, hasMore } = await loadAllOrders(false);
            adminOrdersCache = [...adminOrdersCache, ...orders];
            adminHasMore = hasMore;
            await renderAdminOrders(containerId);
        });
    }
}

/* ============================================================
   CACHES & PAGINATION
   ============================================================ */
let adminOrdersCache = [];
const ADMIN_PAGE_SIZE = 20;
let adminLastVisible = null;
let adminHasMore = true;
let adminLoading = false;

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
        console.error('Erreur chargement commandes admin :', e);
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

/* ============================================================
   RETOURS & AVIS
   ============================================================ */
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
        } catch (e) { /* ignore */ }
    }
    return { deleted, unverified };
}

/* ============================================================
   MODALE RETOUR
   ============================================================ */
export async function openReturnModal(orderId) {
    try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (!snap.exists()) return showToast('Commande introuvable');
        const order = { id: snap.id, ...snap.data() };
        const items = order.items || [];

        const alreadyReturnedMap = getReturnedQuantitiesByVariant(order);

        const modalHtml = `
            <div class="modal-overlay open" id="returnModal" style="z-index:2500;">
                <div class="modal" style="max-width:600px;">
                    <button class="modal-close" id="closeReturnModalBtn">✕</button>
                    <h2 style="color:var(--gold);text-align:center;margin-bottom:0.5rem;">Gérer le retour</h2>
                    <p style="font-size:0.85rem;color:var(--text-muted);text-align:center;margin-bottom:1rem;">Commande #${orderId.slice(0,8).toUpperCase()}</p>
                    <div style="display:flex;flex-direction:column;gap:0.8rem;margin-bottom:1.5rem;">
                        ${items.map((item, index) => {
                            const alreadyRet = alreadyReturnedMap[returnVariantKey(item)] || 0;
                            const maxReturnable = Math.max(0, (Number(item.quantity) || 0) - alreadyRet);
                            const disabled = maxReturnable === 0 ? 'disabled' : '';
                            const hint = alreadyRet > 0
                                ? `<div style="font-size:0.72rem;color:var(--warning);margin-top:0.2rem;">Déjà retourné : ${alreadyRet} / ${item.quantity}</div>`
                                : '';
                            return `
                                <div class="return-item-row">
                                    <div style="flex:1;">
                                        <strong>${escapeHTML(item.name)}</strong>
                                        <div style="font-size:0.75rem;color:var(--text-muted);">Commandé : ${item.quantity}</div>
                                        ${hint}
                                    </div>
                                    <div>
                                        <label style="font-size:0.75rem;color:var(--text-muted);">Qté retournée</label>
                                        <input type="number" class="return-qty-input" data-index="${index}" min="0" max="${maxReturnable}" value="0" ${disabled}>
                                    </div>
                                </div>
                            `;
                        }).join('')}
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
            let hasErrors = false;

            inputs.forEach((input, index) => {
                const qty = parseInt(input.value) || 0;
                if (qty > 0) {
                    const maxAllowed = parseInt(input.getAttribute('max')) || 0;
                    if (qty > maxAllowed) {
                        showToast(`Quantité invalide pour ${items[index].name} (max ${maxAllowed})`);
                        hasErrors = true;
                        return;
                    }
                    returns.push({ productId: items[index].productId, variant: items[index].variant || null, quantity: qty });
                    hasChanges = true;
                }
            });

            if (hasErrors) return;
            if (!hasChanges) { showToast('Aucune quantité à retourner'); return; }

            const btn = document.getElementById('confirmReturnBtn');
            btn.disabled = true; btn.textContent = '...';

            try {
                await processReturnTransaction(order, returns);
                const allReturns = [...(Array.isArray(order.returns) ? order.returns : []), { date: new Date(), items: returns.map(r => ({ productId: r.productId, variant: r.variant, delta: r.quantity })) }];
                let reviewSync = { deleted: 0, unverified: 0 };
                try { reviewSync = await syncReviewsWithOrderReturn(order, allReturns); } catch (e) { /* ignore */ }

                let toastMsg = 'Retour enregistré, stock mis à jour';
                if (reviewSync.deleted > 0) toastMsg += ` - ${reviewSync.deleted} avis supprimé(s)`;
                if (reviewSync.unverified > 0) toastMsg += ` - ${reviewSync.unverified} badge(s) retiré(s)`;
                showToast(toastMsg, 4000);
                closeModal();
                if (typeof resetAdminOrdersCache === 'function') resetAdminOrdersCache();
                if (typeof renderAdminOrders === 'function') renderAdminOrders('adminOrdersList');
            } catch (err) {
                showToast(err.message);
                btn.disabled = false; btn.textContent = 'Valider le retour';
            }
        });
    } catch (e) {
        console.error(e);
        showToast('Erreur lors de l\'ouverture du retour');
    }
}

async function processReturnTransaction(order, returnsToProcess) {
    if (!Array.isArray(returnsToProcess) || returnsToProcess.length === 0) {
        throw new Error("Aucun article valide à retourner.");
    }
    for (const item of returnsToProcess) {
        if (!item || item.productId == null || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0) {
            throw new Error("Article ou quantité de retour invalide.");
        }
    }
    returnsToProcess = consolidateStockItems(returnsToProcess);
    if (returnsToProcess.length === 0) throw new Error("Aucun article valide à retourner.");

    await runTransaction(db, async (transaction) => {
        const orderRef = doc(db, "orders", order.id);
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists()) throw new Error("Commande introuvable");
        const currentOrder = orderSnap.data();
        const currentStatus = normalizeOrderStatus(currentOrder.status);

        // Une commande annulée a déjà restitué son stock : accepter un retour
        // dessus créditerait artificiellement le stock une seconde fois.
        // Le retour n'est possible que si le stock de cette commande est encore
        // considéré comme déduit.
        if (!['delivered', 'returned'].includes(currentStatus) || currentOrder.stockDeducted !== true) {
            throw new Error("Impossible d'enregistrer un retour : la commande doit être livrée et son stock doit toujours être déduit.");
        }

        const alreadyReturnedMap = getReturnedQuantitiesByVariant(currentOrder);
        returnsToProcess.forEach(r => {
            const alreadyRet = alreadyReturnedMap[returnVariantKey(r)] || 0;
            const item = (currentOrder.items || []).find(i => returnVariantKey(i) === returnVariantKey(r));
            if (!item) throw new Error(`Produit ${r.productId} introuvable dans la commande`);
            const remaining = Math.max(0, (Number(item.quantity) || 0) - alreadyRet);
            if (r.quantity > remaining) {
                throw new Error(`Retour excessif pour ${item.name} : ${r.quantity} demandé, ${remaining} max.`);
            }
        });

        const currentReturns = currentOrder.returns || [];
        const productIds = [...new Set(returnsToProcess.map(r => String(r.productId)))];
        const productRefs = productIds.map(productId => doc(db, "products", productId));
        const productSnaps = await Promise.all(productRefs.map(ref => transaction.get(ref)));

        productSnaps.forEach((snap, i) => {
            if (!snap.exists()) {
                throw new Error(`Produit ${productIds[i]} introuvable : retour annulé pour éviter une incohérence de stock.`);
            }
            const pData = snap.data();
            const productId = productIds[i];
            const productReturns = returnsToProcess.filter(r => String(r.productId) === productId);
            const updateData = {
                salesCount: Math.max(0, (Number(pData.salesCount) || 0) - productReturns.reduce((sum, r) => sum + r.quantity, 0)),
                lastOrderId: order.id,
                updatedAt: Timestamp.now()
            };
            const variants = Array.isArray(pData.variants) ? pData.variants.map(v => ({ ...v })) : [];
            let variantStockChanged = false;
            let simpleStockChanged = false;
            for (const r of productReturns) {
                if (r.variant) {
                    variantStockChanged = true;
                    const vIdx = variants.findIndex(v => String(v.size || '') === String(r.variant.size || '') && String(v.color || '') === String(r.variant.color || ''));
                    if (vIdx < 0) throw new Error(`Variante introuvable pour le produit ${productId}`);
                    const currentVariantStock = Number(variants[vIdx].stock);
                    if (!Number.isFinite(currentVariantStock) || currentVariantStock < 0) throw new Error(`Stock de variante invalide pour le produit ${productId}`);
                    variants[vIdx].stock = currentVariantStock + r.quantity;
                } else {
                    simpleStockChanged = true;
                }
            }
            if (variantStockChanged && simpleStockChanged) {
                throw new Error(`Structure de stock incohérente pour le produit ${productId} : variantes et stock simple mélangés.`);
            }
            if (variantStockChanged) {
                updateData.variants = variants;
                updateData.stock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
            } else {
                const currentSimpleStock = Number(pData.stock);
                if (!Number.isFinite(currentSimpleStock) || currentSimpleStock < 0) throw new Error(`Stock simple invalide pour le produit ${productId}`);
                updateData.stock = currentSimpleStock + productReturns.reduce((sum, r) => sum + r.quantity, 0);
            }
            transaction.update(productRefs[i], updateData);
        });

        const newReturnEntry = { date: Timestamp.now(), items: returnsToProcess.map(r => ({ productId: r.productId, variant: r.variant, delta: r.quantity })) };
        transaction.update(orderRef, { returns: [...currentReturns, newReturnEntry], status: ORDER_STATUS.RETURNED, updatedAt: Timestamp.now() });
    });
}

/* ============================================================
   SYNC AUTOMATIQUE EN ARRIÈRE-PLAN (Throttle 5 min)
   ============================================================ */
const AUTO_SYNC_THROTTLE_MS = 5 * 60 * 1000;
const AUTO_SYNC_STORAGE_PREFIX = 'swi9a_sync_';

let _autoSyncInProgress = false;

function _isAdminUser() {
    try {
        const u = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
        if (!u) return false;
        if (u.role === 'admin') return true;
        if (u.userData && u.userData.role === 'admin') return true;
        return false;
    } catch (e) {
        return false;
    }
}

export async function autoSyncActiveOrders(orders, onComplete = null) {
    if (isTestMode()) {
        console.log('[TEST] autoSyncActiveOrders désactivé en mode test');
        return;
    }

    if (!_isAdminUser()) {
        console.log('autoSyncActiveOrders : réservé aux admins (skip côté client)');
        return;
    }

    if (_autoSyncInProgress) {
        console.log('Auto-sync déjà en cours - skip');
        return;
    }

    if (typeof localStorage === 'undefined') return;

    const now = Date.now();

    const ordersToSync = (orders || []).filter(order => {
        const status = normalizeOrderStatus(order.status);
        const trackingId = order.livoTracking || order.speedafTracking;
        const hasTracking = !!trackingId;
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
        console.log('Auto-sync : aucune commande éligible');
        return;
    }

    _autoSyncInProgress = true;
    console.log(`Auto-sync : ${ordersToSync.length} commande(s) à vérifier`);

    let updatedCount = 0;

    for (const order of ordersToSync) {
        try {
            localStorage.setItem(AUTO_SYNC_STORAGE_PREFIX + order.id, String(Date.now()));
        } catch (e) { /* ignore */ }

        try {
            const result = await syncLivoStatus(order.id);
            if (result.success && result.updated) {
                updatedCount++;
                console.log(`Cmd ${order.id.slice(0, 8)} -> ${result.newStatus}`);
            }
        } catch (e) {
            console.warn(`Auto-sync ${order.id.slice(0, 8)} :`, e?.message || e);
        }
    }

    _autoSyncInProgress = false;

    if (updatedCount > 0) {
        showToast(`${updatedCount} commande(s) mise(s) à jour`, 3000);
        if (typeof onComplete === 'function') {
            try { onComplete(updatedCount); } catch (e) { /* ignore */ }
        }
    }

    console.log(`Auto-sync terminé : ${updatedCount}/${ordersToSync.length} mise(s) à jour`);
}

/* ============================================================
   CLIENT : AFFICHER LES COMMANDES
   ============================================================ */
export async function renderUserOrders(containerId = 'tabContent') {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">${t('loadingOrders')}</div>`;
    try {
        const orders = await loadUserOrders();
        if (!orders || orders.length === 0) {
            container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted);">${t('noOrders')}</div>`;
            return;
        }

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
                       <span style="font-size:0.75rem;color:var(--gold);font-weight:600;">${t('orderCancellableIn').replace('{time}', timeRemaining)}</span>
                       <button class="order-cancel-btn" data-order-id="${order.id}">${t('orderCancel')}</button>
                   </div>`
                : '';

            const trackingId = order.livoTracking || order.speedafTracking;
            const trackingBtnHtml = trackingId
                ? `<span style="display:inline-flex; align-items:center; gap:0.3rem; padding:0.4rem 1rem; background:rgba(165,123,46,0.1); color:var(--gold); border:1px solid var(--gold); border-radius:30px; font-weight:700; font-size:0.8rem;">
                       Suivi: ${escapeHTML(trackingId)}
                   </span>`
                : '';

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
                        <div><strong>${order.items?.length || 0}</strong> ${t('items')} - <strong>${order.total || 0} ${t('currency')}</strong></div>
                        <div style="font-size:0.8rem;color:var(--text-muted);">${escapeHTML(order.deliveryAddress?.city || '')}</div>
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
                btn.textContent = '...';
                const res = await cancelOrder(orderId);
                if (res.success) {
                    showToast(t('orderCancelled'));
                    await renderUserOrders(containerId);
                } else {
                    showToast(res.error);
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

/* ============================================================
   MODALE DÉTAILS CLIENT
   ============================================================ */
export async function openOrderDetails(orderId, isAdmin = false) {
    try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (!snap.exists()) return showToast('Commande introuvable');
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
            return `<div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px dashed var(--border);font-size:0.85rem;"><span>${escapeHTML(item.name)}${escapeHTML(v)} x ${item.quantity}</span><strong style="color:var(--gold);">${item.price * item.quantity} MAD</strong></div>`;
        }).join('');

        const trackingId = order.livoTracking || order.speedafTracking;
        let trackingHtml = '';
        if (trackingId) {
            trackingHtml = `<div style="background:rgba(165,123,46,0.1);padding:1rem;border-radius:var(--radius-sm);margin-bottom:1rem;font-size:0.85rem;border:1px solid var(--border-gold);"><h4 style="margin-bottom:0.5rem;color:var(--gold);font-size:0.95rem;">Livraison Livo</h4><div><strong>N° de suivi :</strong> ${escapeHTML(trackingId)}</div></div>`;
        }

        let html = `
            <div class="modal-overlay open" id="orderDetailsModal" style="z-index:2500;">
                <div class="modal" style="max-width:600px;padding:1.5rem;">
                    <button class="modal-close" id="closeOrderDetailsBtn">✕</button>
                    <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:1rem;">#${orderId.slice(0,8).toUpperCase()}</h2>
                    <div class="order-timeline" style="margin:1rem 0;">${timelineHtml}</div>
                    ${trackingHtml}
                    <div style="background:var(--bg-surface);padding:1rem;border-radius:var(--radius-sm);margin-bottom:1rem;">
                        <h4 style="margin-bottom:0.5rem;color:var(--text);font-size:0.95rem;">${t('orderArticles')}</h4>
                        ${itemsHtml}
                        <div style="display:flex;justify-content:space-between;margin-top:0.8rem;font-weight:800;color:var(--text);"><span>${t('orderTotal')}</span><span style="color:var(--gold);">${order.total || 0} MAD</span></div>
                    </div>
                    <div style="background:var(--bg-surface);padding:1rem;border-radius:var(--radius-sm);margin-bottom:1rem;font-size:0.85rem;">
                        <h4 style="margin-bottom:0.5rem;color:var(--text);font-size:0.95rem;">${t('orderDeliveryAddress')}</h4>
                        <div><strong>${escapeHTML(order.deliveryAddress?.name || '')}</strong></div>
                        <div>${escapeHTML(order.deliveryAddress?.phone || '')}</div>
                        <div>${escapeHTML(order.deliveryAddress?.address || '')}</div>
                        <div>${escapeHTML(order.deliveryAddress?.city || '')}</div>
                        ${order.deliveryAddress?.note ? `<div style="margin-top:0.5rem;padding:0.5rem;background:rgba(165,123,46,0.08);border-radius:8px;font-style:italic;">${escapeHTML(order.deliveryAddress.note)}</div>` : ''}
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
        showToast(t('error'));
    }
}

/* ============================================================
   LOG FINAL
   ============================================================ */
console.log('✅ orders.js chargé - v11.1.0 (Wallet côté serveur, imports nettoyés)');