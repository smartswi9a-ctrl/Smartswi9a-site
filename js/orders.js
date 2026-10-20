// js/orders.js
// ============================================================
// GESTION DES COMMANDES - SMART SWI9A
// Version 4.0.1 — Fix critique : annulation PENDING restaure stock
// ============================================================
// CHANGEMENTS v4.0.1 :
// ✅ FIX CRITIQUE — updateOrderStatus(CANCELLED) depuis PENDING
//    restaure désormais le stock (car createOrder déduit dès la
//    création avec stockDeducted: true)
//    Avant : [CONFIRMED, SHIPPING, DELIVERED] seulement → PENDING exclu
//    Après : [PENDING, CONFIRMED, SHIPPING, DELIVERED]
// ✅ (Repris v4.0.0) — C6.1→C6.4, I6.1→I6.6, M6.1→M6.10
// ============================================================
// Dépend de : config, utils, firebase, auth, cart, ui-core, notifications
// ============================================================

import {
    collection, doc, getDocs, getDoc, updateDoc, deleteDoc,
    query, where, orderBy, limit, startAfter, Timestamp,
    runTransaction, writeBatch, increment
} from "firebase/firestore";
import { db } from "./firebase.js";
import {
    CONFIG, ORDER_STATUS, NOTIFICATION_TYPES, normalizeOrderStatus,
    canReturnOrder, getReturnedQuantities, isFullReturn
} from "./config.js";
import {
    t, escapeHTML, formatDateTime,
    getOrderStatusEmoji, getOrderStatusLabel, getOrderStatusColor,
    getOrderTimelineSteps,
    isOrderCancellable, getTimeRemainingForCancellation, formatTimeRemaining,
    toDate, getCityName, getLang,
    getReturnBadgeText
} from "./utils.js";
import { getCurrentUser } from "./auth.js";
import { showToast, confirmAction } from "./ui-core.js";
import { cancelOrder, loadUserOrders } from "./cart.js";

// ============================================================
// CACHE AVIS UTILISATEUR
// ============================================================
let userReviewedProductIds = new Set();
const orderReviewStatusCache = new Map();

// ============================================================
// CACHES ADMIN
// ============================================================
let userOrdersCache = [];
let adminOrdersCache = [];
let currentStatusFilter = 'all';
const ADMIN_PAGE_SIZE = 20;
let adminLastVisible = null;
let adminHasMore = true;
let adminLoading = false;

// ============================================================
// CACHE LANGUE UTILISATEUR (I6.2 + M6.1)
// ============================================================
const _userLangCache = new Map();

// ⚠️ SÉCURITÉ : La clé EmailJS est publique (visible via DevTools).
// Protection recommandée : rate limiting via Cloud Functions.
// ⚠️⚠️ NE JAMAIS MODIFIER CES 3 VALEURS — CONTRAINTE ABSOLUE ⚠️⚠️
const EMAILJS = {
    SERVICE_ID: 'service_gder468',
    TEMPLATE_ID: 'template_6tp1n35',
    PUBLIC_KEY: '47Wn3We2YOdAoSN2g'
};

// ============================================================
// CHARGEMENT DYNAMIQUE EMAILJS
// ============================================================
let emailjsSDK = null;
async function getEmailJS() {
    if (emailjsSDK) return emailjsSDK;
    try {
        const mod = await import('https://cdn.jsdelivr.net/npm/@emailjs/browser@4/+esm');
        emailjsSDK = mod.default || mod;
        emailjsSDK.init({ publicKey: EMAILJS.PUBLIC_KEY });
        return emailjsSDK;
    } catch (e) {
        console.error('❌ Erreur chargement EmailJS :', e);
        return null;
    }
}

// ============================================================
// ✅ M6.10 — Envoyer un email avec retry
// ============================================================
async function sendEmailViaEmailJS(toEmail, toName, subject, htmlContent, textContent, maxAttempts = 2) {
    if (!toEmail || !toEmail.includes('@')) return { success: false, error: 'invalid_email' };

    const emailjs = await getEmailJS();
    if (!emailjs) return { success: false, error: 'sdk_not_loaded' };

    const templateParams = {
        to_email: toEmail,
        to_name: toName || toEmail.split('@')[0],
        subject,
        html_content: htmlContent,
        text_content: textContent
    };

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await emailjs.send(EMAILJS.SERVICE_ID, EMAILJS.TEMPLATE_ID, templateParams);
            return { success: true, response };
        } catch (e) {
            lastError = e;
            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
    }
    console.error('❌ Email échoué après retries :', lastError);
    return { success: false, error: lastError?.message || lastError?.text || 'unknown' };
}

// ============================================================
// ✅ I6.2 — Langue du client (cache Map + order.userLang)
// ============================================================
async function getUserLangById(userId) {
    if (!userId) return getLang() || 'fr';
    if (_userLangCache.has(userId)) return _userLangCache.get(userId);
    try {
        const snap = await getDoc(doc(db, "users", userId));
        const lang = snap.exists()
            ? (snap.data().lang || snap.data().preferredLang || snap.data().signupLang || 'fr')
            : 'fr';
        const normalized = ['ar', 'en', 'fr'].includes(lang) ? lang : 'fr';
        _userLangCache.set(userId, normalized);
        return normalized;
    } catch (e) {
        return 'fr';
    }
}

async function getUserLangForOrder(order) {
    if (order?.userLang) return order.userLang;
    return await getUserLangById(order?.userId);
}

// ============================================================
// LABELS INVOICE (factorisés, 3 langues)
// ============================================================
const INVOICE_LABELS = {
    fr: {
        invoice: 'FACTURE', issuedOn: 'Émise le', billedTo: 'FACTURÉ À',
        items: 'ARTICLES', product: 'Produit', qty: 'Qté', unitPrice: 'Prix unit.',
        lineTotal: 'Total', subtotal: 'Sous-total', volumeDiscount: 'Réduction volume',
        couponDiscount: 'Code promo', delivery: 'Livraison', total: 'TOTAL',
        paymentMethod: 'Mode de paiement', cod: 'Paiement à la livraison', paid: 'Payé',
        thanks: 'Merci pour votre confiance !', question: 'Pour toute question, contactez-nous :',
        shopName: 'SMART SWI9A',
        footer: 'Cet email tient lieu de facture. Aucune signature requise.'
    },
    ar: {
        invoice: 'فاتورة', issuedOn: 'صدرت في', billedTo: 'فاتورة إلى',
        items: 'المنتجات', product: 'المنتج', qty: 'الكمية', unitPrice: 'سعر الوحدة',
        lineTotal: 'الإجمالي', subtotal: 'المجموع الفرعي', volumeDiscount: 'خصم الكمية',
        couponDiscount: 'كود الخصم', delivery: 'التوصيل', total: 'الإجمالي',
        paymentMethod: 'طريقة الدفع', cod: 'الدفع عند الاستلام', paid: 'مدفوع',
        thanks: 'شكراً على ثقتكم!', question: 'لأي استفسار، تواصلوا معنا:',
        shopName: 'سمارت سويقة',
        footer: 'هذا البريد بمثابة فاتورة. لا حاجة لتوقيع.'
    },
    en: {
        invoice: 'INVOICE', issuedOn: 'Issued on', billedTo: 'BILLED TO',
        items: 'ITEMS', product: 'Product', qty: 'Qty', unitPrice: 'Unit price',
        lineTotal: 'Total', subtotal: 'Subtotal', volumeDiscount: 'Volume discount',
        couponDiscount: 'Coupon code', delivery: 'Delivery', total: 'TOTAL',
        paymentMethod: 'Payment method', cod: 'Cash on delivery', paid: 'Paid',
        thanks: 'Thank you for your trust!', question: 'For any question, contact us:',
        shopName: 'SMART SWI9A',
        footer: 'This email serves as an invoice. No signature required.'
    }
};

// ============================================================
// LABELS ORDER EMAIL (factorisés, 3 langues)
// ============================================================
const ORDER_TITLES = {
    fr: { pending_client: 'Commande reçue', pending_admin: 'Nouvelle commande', confirmed: 'Commande confirmée', shipping: 'Commande en route', delivered: 'Commande livrée', returned: 'Retour enregistré', cancelled: 'Commande annulée' },
    ar: { pending_client: 'تم استلام الطلب', pending_admin: 'طلب جديد', confirmed: 'تم تأكيد الطلب', shipping: 'الطلب في الطريق', delivered: 'تم تسليم الطلب', returned: 'تم تسجيل الإرجاع', cancelled: 'تم إلغاء الطلب' },
    en: { pending_client: 'Order received', pending_admin: 'New order', confirmed: 'Order confirmed', shipping: 'Order shipping', delivered: 'Order delivered', returned: 'Return recorded', cancelled: 'Order cancelled' }
};

const ORDER_SUBJECTS = {
    fr: {
        pending_client: (id) => `📦 Commande reçue #${id} | Smart Swi9a`,
        pending_admin: (id) => `🔔 Nouvelle commande #${id}`,
        confirmed: (id) => `✅ Commande confirmée #${id} | Smart Swi9a`,
        shipping: (id) => `🚚 Commande en route #${id} | Smart Swi9a`,
        delivered_client: (id) => `🧾 Votre facture INV-${id} | Smart Swi9a`,
        delivered_admin: (id) => `🧾 Facture INV-${id} — Commande livrée`,
        returned_client: (id) => `↩️ Retour enregistré #${id} | Smart Swi9a`,
        returned_admin: (id) => `↩️ Retour commande #${id}`,
        cancelled: (id) => `❌ Commande annulée #${id} | Smart Swi9a`
    },
    ar: {
        pending_client: (id) => `📦 تم استلام طلبك #${id} | سمارت سويقة`,
        pending_admin: (id) => `🔔 طلب جديد #${id}`,
        confirmed: (id) => `✅ تم تأكيد طلبك #${id} | سمارت سويقة`,
        shipping: (id) => `🚚 طلبك في الطريق #${id} | سمارت سويقة`,
        delivered_client: (id) => `🧾 فاتورتك INV-${id} | سمارت سويقة`,
        delivered_admin: (id) => `🧾 فاتورة INV-${id} — تم التسليم`,
        returned_client: (id) => `↩️ تم تسجيل الإرجاع #${id} | سمارت سويقة`,
        returned_admin: (id) => `↩️ إرجاع #${id}`,
        cancelled: (id) => `❌ تم إلغاء طلبك #${id} | سمارت سويقة`
    },
    en: {
        pending_client: (id) => `📦 Order received #${id} | Smart Swi9a`,
        pending_admin: (id) => `🔔 New order #${id}`,
        confirmed: (id) => `✅ Order confirmed #${id} | Smart Swi9a`,
        shipping: (id) => `🚚 Order shipping #${id} | Smart Swi9a`,
        delivered_client: (id) => `🧾 Your invoice INV-${id} | Smart Swi9a`,
        delivered_admin: (id) => `🧾 Invoice INV-${id} — Delivered`,
        returned_client: (id) => `↩️ Return recorded #${id} | Smart Swi9a`,
        returned_admin: (id) => `↩️ Return #${id}`,
        cancelled: (id) => `❌ Order cancelled #${id} | Smart Swi9a`
    }
};

// ============================================================
// ✅ M6.6 — buildOrderEmailSubject (avec guard)
// ============================================================
function buildOrderEmailSubject(status, recipient, orderId, lang = 'fr') {
    const shortId = String(orderId || '').slice(0, 8).toUpperCase() || 'N/A';
    const subjects = ORDER_SUBJECTS[lang] || ORDER_SUBJECTS.fr;

    const key = `${status}_${recipient}`;
    if (subjects[key]) return subjects[key](shortId);
    if (subjects[status]) return subjects[status](shortId);

    return `Smart Swi9a #${shortId}`;
}

// ============================================================
// HELPERS ITEMS
// ============================================================
function getItemsHtml(order, align = 'left', isRtl = false) {
    return (order.items || []).slice(0, 10).map(item => {
        const name = escapeHTML(item.name || 'Produit');
        const qty = Number(item.quantity) || 1;
        const price = Number(item.price) || 0;
        const variantText = item.variant
            ? `<br><span style="font-size:12px;color:#a57b2e;">(${escapeHTML([item.variant.size, item.variant.color].filter(Boolean).join(' - '))})</span>`
            : '';
        return `
            <tr>
                <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;text-align:${align};">${name} × ${qty}${variantText}</td>
                <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;text-align:${isRtl ? 'left' : 'right'};color:#a57b2e;font-weight:bold;">${price * qty} MAD</td>
            </tr>
        `;
    }).join('');
}

function getItemsText(order) {
    return (order.items || []).map(item => {
        const qty = Number(item.quantity) || 1;
        const price = Number(item.price) || 0;
        const v = item.variant ? ` (${[item.variant.size, item.variant.color].filter(Boolean).join('-')})` : '';
        return `  • ${item.name}${v} (x${qty}) : ${price * qty} MAD`;
    }).join('\n');
}

// ============================================================
// HELPERS INVOICE
// ============================================================
function getInvoiceNumber(order) {
    return 'INV-' + String(order.id || '').slice(0, 8).toUpperCase();
}

function buildInvoiceSubject(order, recipient, lang = 'fr') {
    const shortId = String(order.id || '').slice(0, 8).toUpperCase() || 'N/A';
    const subjects = ORDER_SUBJECTS[lang] || ORDER_SUBJECTS.fr;
    const key = `delivered_${recipient}`;
    return (subjects[key] || subjects.delivered_client)(shortId);
}

// ============================================================
// EMAIL TEXTE — ORDER + INVOICE
// ============================================================
function buildOrderEmailText(order, status, recipient, lang = 'fr') {
    const l = INVOICE_LABELS[lang] || INVOICE_LABELS.fr;
    const shortId = String(order.id || '').slice(0, 8).toUpperCase() || 'N/A';
    const name = order.deliveryAddress?.name || '—';
    const city = getCityName({
        name: order.deliveryAddress?.cityAr || order.deliveryAddress?.city,
        nameFr: order.deliveryAddress?.cityFr,
        nameAr: order.deliveryAddress?.cityAr
    });

    const greetings = { fr: 'Bonjour', ar: 'مرحباً', en: 'Hello' };
    const team = { fr: "L'équipe Smart Swi9a", ar: "فريق سمارت سويقة", en: "Smart Swi9a team" };

    const msgs = {
        fr: {
            pending_client: `Merci pour votre commande #${shortId} ! Nous la traitons rapidement.`,
            pending_admin: `Nouvelle commande de ${name}.`,
            confirmed: `Bonne nouvelle ! Votre commande #${shortId} est confirmée.`,
            shipping: `Votre colis #${shortId} est en route !`,
            returned: `Le retour de votre commande #${shortId} a été enregistré.`,
            cancelled: `Votre commande #${shortId} a été annulée.`
        },
        ar: {
            pending_client: `شكراً على طلبك #${shortId}! نحن نعالجه بسرعة.`,
            pending_admin: `طلب جديد من ${name}.`,
            confirmed: `خبر سار! طلبك #${shortId} مؤكد.`,
            shipping: `طلبك #${shortId} في الطريق!`,
            returned: `لقد سجلنا إرجاع طلبك #${shortId}.`,
            cancelled: `تم إلغاء طلبك #${shortId}.`
        },
        en: {
            pending_client: `Thank you for your order #${shortId}! We're processing it.`,
            pending_admin: `New order from ${name}.`,
            confirmed: `Great news! Your order #${shortId} is confirmed.`,
            shipping: `Your order #${shortId} is on its way!`,
            returned: `We recorded the return of your order #${shortId}.`,
            cancelled: `Your order #${shortId} has been cancelled.`
        }
    };

    const langMsgs = msgs[lang] || msgs.fr;
    const msgKey = `${status}_${recipient}`;
    const message = langMsgs[msgKey] || langMsgs[status] || '';

    let text = `${greetings[lang]} ${name},\n\n${message}\n\n`;
    text += `Articles :\n${getItemsText(order)}\n\n`;
    text += `Total : ${order.total || 0} MAD\nVille : ${city}\n\n${team[lang]}\nhttps://smartswi9a.top`;
    return text;
}

function buildInvoiceText(order, recipient, lang = 'fr') {
    const l = INVOICE_LABELS[lang] || INVOICE_LABELS.fr;
    const invoiceNum = getInvoiceNumber(order);
    const orderDate = toDate(order.createdAt);
    const invoiceDate = orderDate ? orderDate.toLocaleDateString(lang === 'ar' ? 'ar-MA' : (lang === 'en' ? 'en-GB' : 'fr-FR')) : '—';
    const city = getCityName({
        name: order.deliveryAddress?.cityAr || order.deliveryAddress?.city,
        nameFr: order.deliveryAddress?.cityFr,
        nameAr: order.deliveryAddress?.cityAr
    });

    const lines = [
        '════════════════════════════════════════',
        `  ${l.invoice} ${invoiceNum}`,
        `  ${l.issuedOn} ${invoiceDate}`,
        '════════════════════════════════════════',
        '',
        l.shopName,
        '📞 +212 6 56 61 33 03',
        '📧 smartswi9a@gmail.com',
        '🌐 smartswi9a.top',
        '',
        '────────────────────────────────────────',
        `👤 ${order.deliveryAddress?.name || '—'}`,
        order.deliveryAddress?.phone ? `📞 ${order.deliveryAddress.phone}` : '',
        order.deliveryAddress?.address ? `📍 ${order.deliveryAddress.address}` : '',
        `🏙️ ${city}`,
        '',
        `📋 ${l.items} :`,
        getItemsText(order),
        '',
        `${l.subtotal} : ${order.subtotal || 0} MAD`,
        Number(order.discount) > 0 ? `${l.volumeDiscount} : -${order.discount} MAD` : '',
        Number(order.couponDiscount) > 0 ? `${l.couponDiscount} ${order.couponCode} : -${order.couponDiscount} MAD` : '',
        `${l.delivery} : ${order.deliveryFee || 0} MAD`,
        `${l.total} : ${order.total || 0} MAD`,
        '',
        `✅ ${l.cod} — ${l.paid}`,
        '',
        l.thanks,
        '',
        l.shopName + ' 🇲🇦'
    ].filter(Boolean);

    return lines.join('\n');
}

// ============================================================
// EMAIL HTML — ORDER (template unique + labels)
// ============================================================
function buildOrderEmailHtml(order, status, recipient, lang = 'fr') {
    const shortId = String(order.id || '').slice(0, 8).toUpperCase() || 'N/A';
    const name = escapeHTML(order.deliveryAddress?.name || '—');
    const city = escapeHTML(getCityName({
        name: order.deliveryAddress?.cityAr || order.deliveryAddress?.city,
        nameFr: order.deliveryAddress?.cityFr,
        nameAr: order.deliveryAddress?.cityAr
    }));
    const isRtl = lang === 'ar';
    const align = isRtl ? 'right' : 'left';
    const dir = isRtl ? 'rtl' : 'ltr';

    const emojis = { pending: '📦', confirmed: '✅', shipping: '🚚', delivered: '🎉', returned: '↩️', cancelled: '❌' };
    const titles = ORDER_TITLES[lang] || ORDER_TITLES.fr;
    const titleKey = `${status}_${recipient}`;
    const title = titles[titleKey] || titles[status] || status;

    const msgs = {
        fr: {
            pending_client: `Merci pour votre commande <strong>#${shortId}</strong> ! Nous la traitons rapidement.`,
            pending_admin: `Vous avez reçu une nouvelle commande de <strong>${name}</strong>.`,
            confirmed: `Bonne nouvelle ! Votre commande <strong>#${shortId}</strong> est confirmée.`,
            shipping: `Votre colis <strong>#${shortId}</strong> est en route !`,
            delivered: `Votre commande <strong>#${shortId}</strong> est livrée ! Merci pour votre confiance.`,
            returned: `Nous avons enregistré le retour de votre commande <strong>#${shortId}</strong>.`,
            cancelled: `Votre commande <strong>#${shortId}</strong> a été annulée.`
        },
        ar: {
            pending_client: `شكراً على طلبك <strong>#${shortId}</strong>! نحن نعالجه بسرعة.`,
            pending_admin: `لقد استلمت طلباً جديداً من <strong>${name}</strong>.`,
            confirmed: `خبر سار! طلبك <strong>#${shortId}</strong> مؤكد.`,
            shipping: `طلبك <strong>#${shortId}</strong> في الطريق!`,
            delivered: `تم تسليم طلبك <strong>#${shortId}</strong>!`,
            returned: `لقد سجلنا إرجاع طلبك <strong>#${shortId}</strong>.`,
            cancelled: `تم إلغاء طلبك <strong>#${shortId}</strong>.`
        },
        en: {
            pending_client: `Thank you for your order <strong>#${shortId}</strong>! We're processing it.`,
            pending_admin: `You received a new order from <strong>${name}</strong>.`,
            confirmed: `Great news! Your order <strong>#${shortId}</strong> is confirmed.`,
            shipping: `Your order <strong>#${shortId}</strong> is on its way!`,
            delivered: `Your order <strong>#${shortId}</strong> has been delivered!`,
            returned: `We recorded the return of your order <strong>#${shortId}</strong>.`,
            cancelled: `Your order <strong>#${shortId}</strong> has been cancelled.`
        }
    };
    const langMsgs = msgs[lang] || msgs.fr;
    const message = langMsgs[titleKey] || langMsgs[status] || '';

    const labels = {
        fr: { order: 'Commande', name: 'Nom', city: 'Ville', total: 'Total' },
        ar: { order: 'الطلب', name: 'الاسم', city: 'المدينة', total: 'الإجمالي' },
        en: { order: 'Order', name: 'Name', city: 'City', total: 'Total' }
    };
    const l = labels[lang] || labels.fr;

    const itemsHtml = getItemsHtml(order, align, isRtl);
    const itemsBlock = (order.items && order.items.length > 0)
        ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:15px 0;border-collapse:collapse;">${itemsHtml}</table>`
        : '';

    return `
        <div dir="${dir}" style="text-align:${align};direction:${dir};">
            <h2 style="margin:0 0 15px;color:#a57b2e;font-size:20px;font-family:Georgia,serif;">${emojis[status] || '📦'} ${title}</h2>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#333;">${message}</p>
            <div style="background:#fafafa;border-radius:8px;padding:15px;margin:20px 0;font-size:14px;">
                <div style="padding:4px 0;"><strong>${l.order} :</strong> #${shortId}</div>
                <div style="padding:4px 0;"><strong>${l.name} :</strong> ${name}</div>
                <div style="padding:4px 0;"><strong>${l.city} :</strong> ${city}</div>
            </div>
            ${itemsBlock}
            <div style="background:#a57b2e;color:#ffffff;padding:12px 15px;border-radius:8px;text-align:center;margin:20px 0;">
                <strong style="font-size:16px;">${l.total} : ${order.total || 0} MAD</strong>
            </div>
        </div>
    `;
}

// ============================================================
// EMAIL HTML — INVOICE (template unique + labels)
// ============================================================
function buildInvoiceHtml(order, recipient, lang = 'fr') {
    const l = INVOICE_LABELS[lang] || INVOICE_LABELS.fr;
    const isRtl = lang === 'ar';
    const align = isRtl ? 'right' : 'left';
    const dir = isRtl ? 'rtl' : 'ltr';
    const invoiceNum = getInvoiceNumber(order);
    const orderDate = toDate(order.createdAt);
    const invoiceDate = orderDate ? orderDate.toLocaleDateString(isRtl ? 'ar-MA' : (lang === 'en' ? 'en-GB' : 'fr-FR')) : '—';

    const clientName = escapeHTML(order.deliveryAddress?.name || '—');
    const clientPhone = escapeHTML(order.deliveryAddress?.phone || '');
    const clientAddress = escapeHTML(order.deliveryAddress?.address || '');
    const clientCity = escapeHTML(getCityName({
        name: order.deliveryAddress?.cityAr || order.deliveryAddress?.city,
        nameFr: order.deliveryAddress?.cityFr,
        nameAr: order.deliveryAddress?.cityAr
    }));
    const clientEmail = escapeHTML(order.deliveryAddress?.email || order.userEmail || '');

    const itemsHtml = (order.items || []).map(item => {
        const name = escapeHTML(item.name || 'Produit');
        const variantText = item.variant
            ? `<br><span style="font-size:11px;color:#a57b2e;">(${escapeHTML([item.variant.size, item.variant.color].filter(Boolean).join(' - '))})</span>`
            : '';
        const qty = Number(item.quantity) || 1;
        const price = Number(item.price) || 0;
        return `
            <tr>
                <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#1a1a2e;text-align:${align};">${name}${variantText}</td>
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

    const totalsRows = [];
    totalsRows.push(`<tr><td style="padding:6px 8px;font-size:13px;color:#5c5c5c;text-align:${align};">${l.subtotal}</td><td style="padding:6px 8px;font-size:13px;color:#1a1a2e;font-weight:600;text-align:${isRtl ? 'left' : 'right'};">${subtotal} MAD</td></tr>`);
    if (volumeDiscount > 0) totalsRows.push(`<tr><td style="padding:6px 8px;font-size:13px;color:#2ecc71;text-align:${align};">🎉 ${l.volumeDiscount}</td><td style="padding:6px 8px;font-size:13px;color:#2ecc71;font-weight:600;text-align:${isRtl ? 'left' : 'right'};">−${volumeDiscount} MAD</td></tr>`);
    if (couponDiscount > 0 && couponCode) totalsRows.push(`<tr><td style="padding:6px 8px;font-size:13px;color:#2ecc71;text-align:${align};">🎟️ ${l.couponDiscount} <strong style="color:#a57b2e;">${couponCode}</strong></td><td style="padding:6px 8px;font-size:13px;color:#2ecc71;font-weight:600;text-align:${isRtl ? 'left' : 'right'};">−${couponDiscount} MAD</td></tr>`);
    totalsRows.push(`<tr><td style="padding:6px 8px;font-size:13px;color:#5c5c5c;text-align:${align};">🚚 ${l.delivery}</td><td style="padding:6px 8px;font-size:13px;color:#1a1a2e;font-weight:600;text-align:${isRtl ? 'left' : 'right'};">${deliveryFee} MAD</td></tr>`);

    return `
<!DOCTYPE html>
<html dir="${dir}" lang="${lang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${l.invoice} ${invoiceNum}</title></head>
<body style="margin:0;padding:0;background:#f8f6f2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;direction:${dir};">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f6f2;padding:20px 0;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:600px;width:100%;">
    <tr><td style="background:linear-gradient(135deg,#a57b2e 0%,#7d5a1d 100%);padding:24px 30px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="text-align:${align};vertical-align:middle;">
                <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:2px;">${l.shopName}</div>
                <div style="font-size:12px;color:rgba(255,255,255,0.85);margin-top:4px;">Gadgets & Smart Home au Maroc</div>
            </td>
            <td style="text-align:${isRtl ? 'left' : 'right'};vertical-align:middle;">
                <div style="font-size:11px;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:1px;">${l.invoice}</div>
                <div style="font-size:18px;font-weight:800;color:#ffffff;font-family:'Courier New',monospace;margin-top:4px;">${invoiceNum}</div>
                <div style="font-size:11px;color:rgba(255,255,255,0.85);margin-top:6px;">${l.issuedOn} ${invoiceDate}</div>
            </td>
        </tr></table>
    </td></tr>
    <tr><td style="padding:24px 30px 12px;">
        <div style="font-size:11px;color:#a57b2e;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;text-align:${align};">${l.billedTo}</div>
        <div style="font-size:15px;font-weight:700;color:#1a1a2e;margin-bottom:4px;">${clientName}</div>
        ${clientPhone ? `<div style="font-size:13px;color:#5c5c5c;margin-bottom:2px;">📞 ${clientPhone}</div>` : ''}
        ${clientAddress ? `<div style="font-size:13px;color:#5c5c5c;margin-bottom:2px;">📍 ${clientAddress}</div>` : ''}
        ${clientCity ? `<div style="font-size:13px;color:#5c5c5c;margin-bottom:2px;">🏙️ ${clientCity}</div>` : ''}
        ${clientEmail ? `<div style="font-size:13px;color:#5c5c5c;">✉️ ${clientEmail}</div>` : ''}
    </td></tr>
    <tr><td style="padding:12px 30px;">
        <div style="font-size:11px;color:#a57b2e;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;text-align:${align};">${l.items}</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #f0f0f0;border-radius:8px;overflow:hidden;">
            <thead><tr style="background:#faf8f3;">
                <th style="padding:10px 8px;font-size:11px;color:#5c5c5c;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;text-align:${align};">${l.product}</th>
                <th style="padding:10px 8px;font-size:11px;color:#5c5c5c;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;text-align:center;">${l.qty}</th>
                <th style="padding:10px 8px;font-size:11px;color:#5c5c5c;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;text-align:${isRtl ? 'left' : 'right'};">${l.unitPrice}</th>
                <th style="padding:10px 8px;font-size:11px;color:#5c5c5c;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;text-align:${isRtl ? 'left' : 'right'};">${l.lineTotal}</th>
            </tr></thead>
            <tbody>${itemsHtml}</tbody>
        </table>
    </td></tr>
    <tr><td style="padding:12px 30px 20px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:320px;margin-${isRtl ? 'right' : 'left'}:auto;">
            ${totalsRows.join('')}
            <tr><td colspan="2" style="padding:4px 8px;"><div style="height:1px;background:#f0f0f0;"></div></td></tr>
            <tr><td style="padding:12px 8px 8px;font-size:15px;color:#1a1a2e;font-weight:800;text-align:${align};">${l.total}</td><td style="padding:12px 8px 8px;font-size:18px;color:#a57b2e;font-weight:800;text-align:${isRtl ? 'left' : 'right'};">${total} MAD</td></tr>
        </table>
    </td></tr>
    <tr><td style="padding:0 30px 20px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8f8f0;border-left:4px solid #2ecc71;border-radius:6px;"><tr>
            <td style="padding:12px 16px;text-align:${align};">
                <div style="font-size:11px;color:#2ecc71;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${l.paymentMethod}</div>
                <div style="font-size:14px;color:#1a1a2e;font-weight:700;">✅ ${l.cod} — ${l.paid}</div>
            </td>
        </tr></table>
    </td></tr>
    <tr><td style="padding:0 30px 24px;text-align:${align};">
        <p style="margin:0 0 12px;font-size:14px;color:#1a1a2e;font-weight:700;">${l.thanks}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#5c5c5c;">${l.question}</p>
        <p style="margin:0;font-size:13px;color:#5c5c5c;line-height:1.8;">
            📞 <a href="https://wa.me/212656613303" style="color:#a57b2e;text-decoration:none;font-weight:600;">+212 6 56 61 33 03</a><br>
            📧 <a href="mailto:smartswi9a@gmail.com" style="color:#a57b2e;text-decoration:none;font-weight:600;">smartswi9a@gmail.com</a><br>
            🌐 <a href="https://smartswi9a.top" style="color:#a57b2e;text-decoration:none;font-weight:600;">smartswi9a.top</a>
        </p>
    </td></tr>
    <tr><td style="background:#faf8f3;padding:16px 30px;text-align:center;border-top:1px solid #f0f0f0;">
        <div style="font-size:11px;color:#9a9a9a;line-height:1.6;">${l.footer}</div>
        <div style="font-size:10px;color:#b5b5b5;margin-top:6px;">© ${new Date().getFullYear()} ${l.shopName} 🇲🇦</div>
    </td></tr>
</table>
</td></tr></table>
</body>
</html>
    `;
}

// ============================================================
// ✅ M6.7 — Envoyer l'email (utilise CONFIG.ORDERS.EMAIL_ON_STATUS)
// ============================================================
export async function sendOrderEmail(order, status, recipient) {
    const emailConfig = CONFIG.ORDERS.EMAIL_ON_STATUS;
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

    const lang = recipient === 'client' ? await getUserLangForOrder(order) : 'fr';

    if (status === 'delivered') {
        return await sendEmailViaEmailJS(
            toEmail, toName,
            buildInvoiceSubject(order, recipient, lang),
            buildInvoiceHtml(order, recipient, lang),
            buildInvoiceText(order, recipient, lang)
        );
    }

    return await sendEmailViaEmailJS(
        toEmail, toName,
        buildOrderEmailSubject(status, recipient, order.id, lang),
        buildOrderEmailHtml(order, status, recipient, lang),
        buildOrderEmailText(order, status, recipient, lang)
    );
}

// ============================================================
// CACHE AVIS DÉJÀ DÉPOSÉS
// ============================================================
async function loadUserReviewedProducts(force = false) {
    const user = getCurrentUser();
    if (!user || !user.uid) { userReviewedProductIds = new Set(); return userReviewedProductIds; }
    if (!force && userReviewedProductIds.size > 0) return userReviewedProductIds;
    try {
        const q = query(collection(db, "reviews"), where("userId", "==", user.uid));
        const snap = await getDocs(q);
        const set = new Set();
        snap.forEach(d => {
            const r = d.data();
            if (r.productId !== undefined && r.productId !== null) set.add(String(r.productId));
        });
        userReviewedProductIds = set;
        return set;
    } catch (e) { return new Set(); }
}

function computeReviewStatusForOrder(order) {
    if (!order) return null;
    if (normalizeOrderStatus(order.status) !== 'delivered') return null;
    const statuses = {};
    (order.items || []).forEach(item => {
        const pid = String(item.productId);
        statuses[pid] = userReviewedProductIds.has(pid) ? 'reviewed' : 'pending';
    });
    return statuses;
}

function getPendingReviewCountForOrder(orderId) {
    const statuses = orderReviewStatusCache.get(orderId);
    if (!statuses) return 0;
    return Object.values(statuses).filter(s => s === 'pending').length;
}

function getTotalPendingReviews() {
    let total = 0;
    orderReviewStatusCache.forEach((statuses) => {
        total += Object.values(statuses).filter(s => s === 'pending').length;
    });
    return total;
}

export function invalidateReviewCache() {
    userReviewedProductIds = new Set();
    orderReviewStatusCache.clear();
}

// ============================================================
// HELPERS STOCK (utilisés par deleteOrderCompletely + applyPartialReturn)
// ============================================================
async function restoreStockForOrder(orderId) {
    if (!orderId) return { success: false, error: 'NO_ORDER_ID' };
    try {
        const result = await runTransaction(db, async (transaction) => {
            const orderRef = doc(db, "orders", orderId);
            const orderSnap = await transaction.get(orderRef);
            if (!orderSnap.exists()) throw new Error('Commande introuvable');
            const order = { id: orderId, ...orderSnap.data() };
            if (order.stockDeducted !== true) return { nothingToRestore: true };
            if (!order.items || order.items.length === 0) throw new Error('NO_ITEMS');

            const productRefs = order.items.map(item => doc(db, "products", String(item.productId)));
            const productSnaps = await Promise.all(productRefs.map(ref => transaction.get(ref)));

            productSnaps.forEach((snap, i) => {
                if (!snap.exists()) return;
                const pData = snap.data();
                const qty = Number(order.items[i].quantity) || 0;
                const itemVariant = order.items[i].variant;

                if (itemVariant) {
                    const variants = [...(pData.variants || [])];
                    const idx = variants.findIndex(v =>
                        (v.size || '') === (itemVariant.size || '') &&
                        (v.color || '') === (itemVariant.color || '')
                    );
                    if (idx > -1) {
                        variants[idx].stock = (Number(variants[idx].stock) || 0) + qty;
                        const newStock = variants.reduce((s, v) => s + (Number(v.stock) || 0), 0);
                        transaction.update(productRefs[i], {
                            variants, stock: newStock,
                            salesCount: Math.max(0, (Number(pData.salesCount) || 0) - qty)
                        });
                    }
                } else {
                    transaction.update(productRefs[i], {
                        stock: (Number(pData.stock) || 0) + qty,
                        salesCount: Math.max(0, (Number(pData.salesCount) || 0) - qty)
                    });
                }
            });

            transaction.update(orderRef, { stockDeducted: false, stockRestoredAt: Timestamp.now() });
            return { success: true };
        });

        if (result.nothingToRestore) return { success: true, nothingToRestore: true };
        document.dispatchEvent(new CustomEvent('order-stock-changed'));
        return { success: true };
    } catch (e) {
        console.error('❌ Erreur restoreStockForOrder :', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// APPLIQUER UN RETOUR PARTIEL
// ============================================================
async function applyPartialReturn(order, newReturnQuantities, reason = '') {
    if (!order || !order.items || order.items.length === 0) return { success: false, error: 'NO_ITEMS' };

    const existingReturns = getReturnedQuantities(order);
    const deltas = {};
    const newTotals = {};

    for (const item of order.items) {
        const pid = String(item.productId);
        const qtyOrdered = Number(item.quantity) || 0;
        const qtyAlreadyReturned = existingReturns[pid] || 0;
        const qtyNewTotal = Math.max(0, Math.min(qtyOrdered, Number(newReturnQuantities[pid]) || 0));
        deltas[pid] = qtyNewTotal - qtyAlreadyReturned;
        newTotals[pid] = qtyNewTotal;
    }

    const hasChange = Object.values(deltas).some(d => d !== 0);
    if (!hasChange) return { success: true, nothingChanged: true };

    try {
        await runTransaction(db, async (transaction) => {
            const productRefs = order.items.map(item => doc(db, "products", String(item.productId)));
            const productSnaps = await Promise.all(productRefs.map(ref => transaction.get(ref)));

            productSnaps.forEach((snap, i) => {
                if (!snap.exists()) return;
                const pid = String(order.items[i].productId);
                const delta = deltas[pid] || 0;
                if (delta === 0) return;

                const pData = snap.data();
                const itemVariant = order.items[i].variant;

                if (itemVariant) {
                    const variants = [...(pData.variants || [])];
                    const idx = variants.findIndex(v =>
                        (v.size || '') === (itemVariant.size || '') &&
                        (v.color || '') === (itemVariant.color || '')
                    );
                    if (idx > -1) {
                        variants[idx].stock = Math.max(0, (Number(variants[idx].stock) || 0) + delta);
                        const newStock = variants.reduce((s, v) => s + (Number(v.stock) || 0), 0);
                        transaction.update(productRefs[i], {
                            variants, stock: newStock,
                            salesCount: Math.max(0, (Number(pData.salesCount) || 0) - delta)
                        });
                    }
                } else {
                    transaction.update(productRefs[i], {
                        stock: (Number(pData.stock) || 0) + delta,
                        salesCount: Math.max(0, (Number(pData.salesCount) || 0) - delta)
                    });
                }
            });

            const returnsHistory = Array.isArray(order.returns) ? [...order.returns] : [];
            returnsHistory.push({
                returnedAt: Timestamp.now(),
                reason: String(reason || '').trim().slice(0, 500),
                items: order.items.map(item => {
                    const pid = String(item.productId);
                    return {
                        productId: item.productId,
                        variant: item.variant || null,
                        name: item.name || '',
                        quantityOrdered: Number(item.quantity) || 0,
                        quantityReturnedPreviously: existingReturns[pid] || 0,
                        quantityReturnedNow: newTotals[pid] || 0,
                        delta: deltas[pid] || 0
                    };
                }).filter(x => x.delta !== 0 || x.quantityReturnedNow > 0)
            });

            const isFull = order.items.every(item => {
                const pid = String(item.productId);
                return (newTotals[pid] || 0) >= (Number(item.quantity) || 0);
            });

            const orderRef = doc(db, "orders", order.id);
            transaction.update(orderRef, {
                returns: returnsHistory,
                status: ORDER_STATUS.RETURNED,
                stockDeducted: !isFull,
                returnedAt: Timestamp.now(),
                updatedAt: Timestamp.now()
            });
        });

        document.dispatchEvent(new CustomEvent('order-stock-changed'));
        return { success: true };
    } catch (e) {
        console.error('❌ Erreur applyPartialReturn :', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// RENDU CLIENT — COMMANDES
// ============================================================
export async function renderUserOrders(containerId = 'tabContent') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">⏳ ${t('loadingOrders')}</div>`;

    try {
        userOrdersCache = await loadUserOrders();
        await loadUserReviewedProducts();
        orderReviewStatusCache.clear();
        userOrdersCache.forEach(order => {
            const statuses = computeReviewStatusForOrder(order);
            if (statuses) orderReviewStatusCache.set(order.id, statuses);
        });

        if (userOrdersCache.length === 0) {
            container.innerHTML = `<div style="text-align:center;padding:2rem 1rem;color:var(--text-muted);"><div style="font-size:3rem;margin-bottom:1rem;">📦</div><p>${t('noOrders')}</p></div>`;
            return;
        }

        const pendingReviews = getTotalPendingReviews();

        let html = `
            ${pendingReviews > 0 ? `
                <div class="review-reminder-banner" style="background:linear-gradient(135deg,rgba(165,123,46,0.12),rgba(165,123,46,0.04));border:1px solid var(--border-gold);border-radius:var(--radius-md);padding:0.9rem 1rem;margin-bottom:1rem;display:flex;align-items:center;gap:0.7rem;flex-wrap:wrap;">
                    <span style="font-size:1.6rem;">⭐</span>
                    <div style="flex:1;min-width:0;font-size:0.88rem;line-height:1.4;"><strong style="color:var(--gold);">Vous avez ${pendingReviews} avis à donner !</strong><br><span style="color:var(--text-muted);font-size:0.8rem;">Partagez votre expérience sur vos produits livrés.</span></div>
                </div>
            ` : ''}
            <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1rem;">
                <button class="filter-btn ${currentStatusFilter === 'all' ? 'active' : ''}" data-order-filter="all">${t('filterAll')} (${userOrdersCache.length})</button>
                <button class="filter-btn ${currentStatusFilter === 'pending' ? 'active' : ''}" data-order-filter="pending">⏳ ${t('orderStatusPending')} (${userOrdersCache.filter(o => normalizeOrderStatus(o.status) === 'pending').length})</button>
                <button class="filter-btn ${currentStatusFilter === 'confirmed' ? 'active' : ''}" data-order-filter="confirmed">✅ ${t('orderStatusConfirmed')} (${userOrdersCache.filter(o => normalizeOrderStatus(o.status) === 'confirmed').length})</button>
                <button class="filter-btn ${currentStatusFilter === 'shipping' ? 'active' : ''}" data-order-filter="shipping">🚚 ${t('orderStatusShipping')} (${userOrdersCache.filter(o => normalizeOrderStatus(o.status) === 'shipping').length})</button>
                <button class="filter-btn ${currentStatusFilter === 'delivered' ? 'active' : ''}" data-order-filter="delivered">📦 ${t('orderStatusDelivered')} (${userOrdersCache.filter(o => normalizeOrderStatus(o.status) === 'delivered').length})${pendingReviews > 0 ? ` <span style="background:var(--danger);color:#fff;font-size:0.65rem;padding:0.05rem 0.4rem;border-radius:30px;margin-left:0.2rem;">⭐${pendingReviews}</span>` : ''}</button>
                <button class="filter-btn ${currentStatusFilter === 'returned' ? 'active' : ''}" data-order-filter="returned">↩️ ${t('orderStatusReturned')} (${userOrdersCache.filter(o => normalizeOrderStatus(o.status) === 'returned').length})</button>
                <button class="filter-btn ${currentStatusFilter === 'cancelled' ? 'active' : ''}" data-order-filter="cancelled">❌ ${t('orderStatusCancelled')} (${userOrdersCache.filter(o => normalizeOrderStatus(o.status) === 'cancelled').length})</button>
            </div>
            <div id="ordersList"></div>
        `;
        container.innerHTML = html;

        container.querySelectorAll('[data-order-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                currentStatusFilter = btn.dataset.orderFilter;
                renderOrdersList();
                container.querySelectorAll('[data-order-filter]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        renderOrdersList();
    } catch (e) {
        console.error('Erreur rendu commandes :', e);
        container.innerHTML = `<div style="text-align:center;color:var(--danger);padding:1rem;">${t('loadingError')}</div>`;
    }
}

function renderOrdersList() {
    const list = document.getElementById('ordersList');
    if (!list) return;
    let filtered = userOrdersCache;
    if (currentStatusFilter !== 'all') {
        filtered = userOrdersCache.filter(o => normalizeOrderStatus(o.status) === currentStatusFilter);
    }
    if (filtered.length === 0) {
        list.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted);">${t('noOrders')}</div>`;
        return;
    }
    let html = '';
    filtered.forEach(order => { html += renderOrderCard(order); });
    list.innerHTML = html;
    attachOrderEvents();
}

function renderOrderTimeline(status) {
    const steps = getOrderTimelineSteps(status);
    let html = '<div class="order-timeline">';
    steps.forEach(step => {
        const classes = ['order-timeline-step'];
        if (step.done && !step.current) classes.push('done');
        if (step.current) classes.push('current');
        html += `<div class="${classes.join(' ')}"><div class="order-timeline-dot">${step.emoji}</div><div class="order-timeline-label">${t(step.label)}</div></div>`;
    });
    html += '</div>';
    return html;
}

function renderOrderCard(order) {
    const status = normalizeOrderStatus(order.status);
    const emoji = getOrderStatusEmoji(status);
    const statusLabel = getOrderStatusLabel(status);
    const statusColor = getOrderStatusColor(status);
    const date = formatDateTime(order.createdAt);
    const orderIdShort = order.id.slice(0, 8).toUpperCase();
    const itemCount = order.items?.length || 0;
    const total = order.total || 0;
    const cancellable = isOrderCancellable(order);
    const remaining = getTimeRemainingForCancellation(order);
    const remainingText = remaining ? formatTimeRemaining(remaining) : '';
    const showTimeline = status !== 'cancelled';
    const returnBadge = getReturnBadgeText(order);
    const returnBadgeHtml = returnBadge ? `<div style="margin-top:0.4rem;"><span style="background:rgba(155,89,182,0.15);color:#9b59b6;border:1px solid #9b59b6;font-size:0.7rem;font-weight:700;padding:0.2rem 0.6rem;border-radius:30px;">${returnBadge}</span></div>` : '';

    const reviewStatuses = orderReviewStatusCache.get(order.id) || {};
    const pendingCount = getPendingReviewCountForOrder(order.id);
    const allReviewed = status === 'delivered' && Object.keys(reviewStatuses).length > 0 && pendingCount === 0;

    const itemsPreviewHtml = (order.items || []).slice(0, 3).map(item => {
        const pid = String(item.productId);
        const reviewState = reviewStatuses[pid];
        let badge = '';
        if (reviewState === 'reviewed') badge = '<span title="Avis déposé">✅</span>';
        else if (reviewState === 'pending') badge = '<span title="Avis à donner">⭐</span>';
        const variantText = item.variant ? ` (${escapeHTML([item.variant.size, item.variant.color].filter(Boolean).join(' - '))})` : '';
        return `<div style="font-size:0.8rem;color:var(--text-muted);line-height:1.5;">• ${escapeHTML(item.name || 'Produit')}${variantText}${badge}</div>`;
    }).join('');

    let reviewActionHtml = '';
    if (status === 'delivered') {
        if (pendingCount > 0) reviewActionHtml = `<button class="order-review-btn" data-action="order:review" data-order-id="${order.id}">⭐ ${t('leaveReview')} (${pendingCount})</button>`;
        else if (allReviewed) reviewActionHtml = `<span class="order-all-reviewed">✅ ${t('reviewAlreadyExists') || 'Avis déposé'}</span>`;
    }

    return `
        <div class="order-card" data-order-id="${order.id}">
            <div class="order-card-header">
                <div class="order-card-id">📦 ${t('order')} #${orderIdShort}</div>
                <div class="order-card-date">📅 ${date}</div>
            </div>
            <div class="order-card-body">
                <div><span class="order-status-badge order-status-${status}" style="color:${statusColor};">${emoji} ${statusLabel}</span></div>
                ${showTimeline ? renderOrderTimeline(status) : ''}
                <div>💰 <strong>${total} ${t('currency')}</strong></div>
                <div>🛒 ${itemCount} ${t('items')}</div>
                ${itemsPreviewHtml ? `<div style="margin-top:0.3rem;padding:0.4rem 0.6rem;background:var(--bg-surface);border-radius:var(--radius-sm);">${itemsPreviewHtml}</div>` : ''}
                ${returnBadgeHtml}
                ${cancellable ? `<div class="order-cancellable-timer">⏱️ ${t('orderCancellableIn').replace('{time}', remainingText)}</div>` : ''}
            </div>
            <div class="order-card-actions">
                <button class="order-details-btn" data-action="order:details" data-order-id="${order.id}">👁️ ${t('orderDetails')}</button>
                ${cancellable ? `<button class="order-cancel-btn" data-action="order:cancel" data-order-id="${order.id}">❌ ${t('orderCancel')}</button>` : ''}
                ${reviewActionHtml}
            </div>
        </div>
    `;
}

function attachOrderEvents() {
    document.querySelectorAll('[data-action="order:details"]').forEach(btn => {
        btn.addEventListener('click', () => openOrderDetails(btn.dataset.orderId, false));
    });

    document.querySelectorAll('[data-action="order:cancel"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.orderId;
            const confirmed = await confirmAction(t('confirmCancelOrderMsg'), {
                title: t('confirmCancelOrderTitle'), confirmText: t('confirmCancelOrderYes'),
                cancelText: t('confirmCancelOrderNo'), variant: 'danger'
            });
            if (!confirmed) return;
            btn.disabled = true;
            btn.textContent = '⏳...';
            const result = await cancelOrder(orderId);
            if (result.success) {
                showToast('✅ ' + t('orderCancelled'));
                await renderUserOrders();
            } else {
                showToast('❌ ' + (result.error || t('error')));
                btn.disabled = false;
                btn.textContent = '❌ ' + t('orderCancel');
            }
        });
    });

    document.querySelectorAll('[data-action="order:review"]').forEach(btn => {
        btn.addEventListener('click', async () => { await openQuickReviewModal(btn.dataset.orderId); });
    });

    startCancellationTimers();
}

let timers = [];
function startCancellationTimers() {
    timers.forEach(t => clearInterval(t));
    timers = [];
    document.querySelectorAll('.order-cancellable-timer').forEach(el => {
        const card = el.closest('.order-card');
        const orderId = card?.dataset?.orderId;
        if (!orderId) return;
        const timer = setInterval(() => {
            const order = userOrdersCache.find(o => o.id === orderId);
            if (!order) { clearInterval(timer); return; }
            const remaining = getTimeRemainingForCancellation(order);
            if (remaining) {
                el.innerHTML = `⏱️ ${t('orderCancellableIn').replace('{time}', formatTimeRemaining(remaining))}`;
            } else {
                el.remove();
                const cancelBtn = card.querySelector('[data-action="order:cancel"]');
                if (cancelBtn) cancelBtn.remove();
                clearInterval(timer);
            }
        }, 60000);
        timers.push(timer);
    });
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => { timers.forEach(t => clearInterval(t)); timers = []; });
}

// ============================================================
// MODALE D'AVIS INLINE
// ============================================================
export async function openQuickReviewModal(orderId) {
    const order = userOrdersCache.find(o => o.id === orderId);
    if (!order) { showToast('❌ ' + t('loadError')); return; }

    const reviewStatuses = orderReviewStatusCache.get(orderId) || {};
    const pendingItems = (order.items || []).filter(item => reviewStatuses[String(item.productId)] === 'pending');
    if (pendingItems.length === 0) { showToast('✅ ' + (t('reviewAlreadyExists') || 'Tous les produits ont déjà été notés')); return; }

    document.getElementById('quickReviewModal')?.remove();

    const productsHtml = pendingItems.map((item, idx) => {
        const pid = String(item.productId);
        const name = escapeHTML(item.name || `Produit #${pid}`);
        const variantText = item.variant ? ` (${escapeHTML([item.variant.size, item.variant.color].filter(Boolean).join(' - '))})` : '';
        return `<label class="quick-review-product-item" style="display:flex;align-items:center;gap:0.6rem;padding:0.7rem 0.9rem;background:var(--bg-surface);border:2px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;transition:all var(--transition-fast);margin-bottom:0.5rem;"><input type="radio" name="quickReviewProduct" value="${pid}" ${idx === 0 ? 'checked' : ''} style="width:auto;margin:0;flex-shrink:0;"><span style="flex:1;min-width:0;font-size:0.88rem;font-weight:600;color:var(--text);">${name}${variantText}</span><span style="font-size:0.72rem;color:var(--text-muted);">×${item.quantity || 1}</span></label>`;
    }).join('');

    const modalHtml = `
        <div class="modal-overlay open" id="quickReviewModal" style="z-index:2300;">
            <div class="modal" style="max-width:520px;">
                <button class="modal-close" id="closeQuickReviewBtn">✕</button>
                <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:0.3rem;font-size:1.3rem;">⭐ ${t('leaveReview')}</h2>
                <p style="text-align:center;font-size:0.8rem;color:var(--text-muted);margin-bottom:1.2rem;">${t('order')} <strong>#${order.id.slice(0, 8).toUpperCase()}</strong></p>
                <label style="display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.4rem;font-weight:600;">📦 ${t('product')}</label>
                <div id="quickReviewProductList" style="max-height:180px;overflow-y:auto;margin-bottom:0.8rem;">${productsHtml}</div>
                <label style="display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.2rem;font-weight:600;text-align:center;">${t('reviews')} *</label>
                <div class="review-modal-stars" id="quickReviewStars"><span class="star" data-star="1">★</span><span class="star" data-star="2">★</span><span class="star" data-star="3">★</span><span class="star" data-star="4">★</span><span class="star" data-star="5">★</span></div>
                <label style="display:block;font-size:0.82rem;color:var(--text-muted);margin-bottom:0.3rem;">${t('reviewTitle')}</label>
                <input type="text" id="quickReviewTitle" maxlength="80" placeholder="${t('reviewTitle')}" style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text);font-family:inherit;font-size:0.88rem;margin-bottom:0.6rem;">
                <label style="display:block;font-size:0.82rem;color:var(--text-muted);margin-bottom:0.3rem;">${t('reviewComment')} *</label>
                <textarea id="quickReviewComment" rows="3" maxlength="500" placeholder="${t('reviewComment')}" style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text);font-family:inherit;font-size:0.88rem;resize:vertical;min-height:70px;margin-bottom:0.6rem;"></textarea>
                <label style="display:block;font-size:0.82rem;color:var(--text-muted);margin-bottom:0.3rem;">${t('reviewPhotos')} (${t('optional') || 'optionnel'}, max 5)</label>
                <input type="file" id="quickReviewPhotos" accept="image/*" multiple style="margin-bottom:0.8rem;color:var(--text);font-size:0.85rem;">
                <div id="quickReviewMsg" style="font-size:0.85rem;margin-bottom:0.8rem;min-height:1.2em;text-align:center;font-weight:600;"></div>
                <div style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;">
                    <button id="quickReviewCancelBtn" style="min-width:110px;padding:0.7rem 1.2rem;background:transparent;border:1px solid var(--border);color:var(--text-muted);border-radius:30px;font-weight:600;cursor:pointer;font-size:0.9rem;">${t('cancel') || 'Annuler'}</button>
                    <button id="quickReviewSubmitBtn" style="min-width:150px;padding:0.7rem 1.2rem;background:linear-gradient(135deg,var(--gold),#7d5a1d);color:#fff;border:none;border-radius:30px;font-weight:700;cursor:pointer;font-size:0.9rem;">📤 ${t('reviewSubmit')}</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = document.getElementById('quickReviewModal');
    const stars = modal.querySelectorAll('.star');
    const msgEl = document.getElementById('quickReviewMsg');
    const submitBtn = document.getElementById('quickReviewSubmitBtn');
    const photoInput = document.getElementById('quickReviewPhotos');
    let selectedRating = 0;

    const closeModal = () => modal?.remove();
    document.getElementById('closeQuickReviewBtn').addEventListener('click', closeModal);
    document.getElementById('quickReviewCancelBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    modal.querySelectorAll('.quick-review-product-item').forEach(label => {
        const radio = label.querySelector('input[type="radio"]');
        const updateStyle = () => {
            modal.querySelectorAll('.quick-review-product-item').forEach(l => { l.style.borderColor = 'var(--border)'; l.style.background = 'var(--bg-surface)'; });
            if (radio.checked) { label.style.borderColor = 'var(--gold)'; label.style.background = 'rgba(165,123,46,0.06)'; }
        };
        radio.addEventListener('change', updateStyle);
        if (radio.checked) { label.style.borderColor = 'var(--gold)'; label.style.background = 'rgba(165,123,46,0.06)'; }
    });

    stars.forEach(star => {
        star.addEventListener('click', () => {
            selectedRating = parseInt(star.dataset.star);
            stars.forEach(s => { s.classList.toggle('active', parseInt(s.dataset.star) <= selectedRating); });
        });
    });

    submitBtn.addEventListener('click', async () => {
        const selectedProductRadio = modal.querySelector('input[name="quickReviewProduct"]:checked');
        if (!selectedProductRadio) { msgEl.textContent = '⚠️ Sélectionnez un produit'; msgEl.style.color = 'var(--danger)'; return; }

        const productId = selectedProductRadio.value;
        const title = document.getElementById('quickReviewTitle').value.trim();
        const comment = document.getElementById('quickReviewComment').value.trim();
        const photoFiles = photoInput.files ? Array.from(photoInput.files).slice(0, 5) : [];

        if (selectedRating < 1) { msgEl.textContent = '⚠️ ' + t('reviews'); msgEl.style.color = 'var(--danger)'; return; }
        if (!comment) { msgEl.textContent = '⚠️ ' + t('reviewComment'); msgEl.style.color = 'var(--danger)'; return; }

        submitBtn.disabled = true;
        const originalText = submitBtn.textContent;
        submitBtn.textContent = '⏳ ' + t('loading');
        msgEl.textContent = '';

        try {
            const { createReview } = await import("./reviews.js");
            await createReview(Number(productId), { rating: selectedRating, title, comment, photoFiles });

            showToast('✅ ' + (t('reviewThanks') || 'Merci pour votre avis !'));
            userReviewedProductIds.add(String(productId));
            if (orderReviewStatusCache.has(orderId)) { orderReviewStatusCache.get(orderId)[String(productId)] = 'reviewed'; }
            const remaining = getPendingReviewCountForOrder(orderId);
            if (remaining === 0) {
                try {
                    const { deleteReviewRequestForOrder } = await import("./notifications.js");
                    await deleteReviewRequestForOrder(orderId);
                } catch (e) {}
            }

            document.dispatchEvent(new CustomEvent('review-submitted', { detail: { orderId, productId } }));
            closeModal();
            await renderUserOrders();
        } catch (e) {
            console.error('Erreur envoi avis :', e);
            msgEl.textContent = '❌ ' + (e.message || t('error'));
            msgEl.style.color = 'var(--danger)';
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    });

    setTimeout(() => stars[0]?.focus(), 100);
}

// ============================================================
// MODAL DÉTAILS COMMANDE
// ============================================================
export async function openOrderDetails(orderId, isAdmin = false) {
    const cache = isAdmin ? adminOrdersCache : userOrdersCache;
    let order = cache.find(o => o.id === orderId);
    if (!order) {
        try {
            const snap = await getDoc(doc(db, "orders", orderId));
            if (snap.exists()) { const data = snap.data(); order = { id: snap.id, ...data, createdAt: toDate(data.createdAt) }; }
        } catch (e) { console.error('Erreur chargement commande :', e); return; }
    }
    if (!order) { showToast('❌ ' + t('loadError')); return; }

    document.getElementById('orderDetailsModal')?.remove();

    const status = normalizeOrderStatus(order.status);
    const emoji = getOrderStatusEmoji(status);
    const statusLabel = getOrderStatusLabel(status);
    const statusColor = getOrderStatusColor(status);
    const date = formatDateTime(order.createdAt);
    const orderIdShort = order.id.slice(0, 8).toUpperCase();
    const cityDisplay = getCityName({ name: order.deliveryAddress?.cityAr || order.deliveryAddress?.city, nameFr: order.deliveryAddress?.cityFr, nameAr: order.deliveryAddress?.cityAr });
    const returnedQtys = getReturnedQuantities(order);
    const reviewStatuses = orderReviewStatusCache.get(order.id) || {};
    const pendingReviewCount = getPendingReviewCountForOrder(order.id);

    const itemsHtml = (order.items || []).map(item => {
        const pid = String(item.productId);
        const name = escapeHTML(item.name || `Produit #${item.productId}`);
        const variantText = item.variant ? ` <span style="font-size:0.8rem;color:var(--gold);">(${escapeHTML([item.variant.size, item.variant.color].filter(Boolean).join(' - '))})</span>` : '';
        const price = Number(item.price) || 0;
        const qty = Number(item.quantity) || 1;
        const qtyReturned = returnedQtys[pid] || 0;
        const returnInfo = qtyReturned > 0 ? `<div style="font-size:0.75rem;color:#9b59b6;font-weight:600;margin-top:0.2rem;">↩️ Retourné : ${qtyReturned}/${qty}</div>` : '';

        const reviewState = reviewStatuses[pid];
        let reviewInfo = '';
        if (reviewState === 'reviewed') reviewInfo = `<span style="margin-left:0.3rem;background:var(--success-bg);color:var(--success);padding:0.1rem 0.4rem;border-radius:30px;font-size:0.7rem;font-weight:700;">✅ ${t('reviewPublished') || 'Avis déposé'}</span>`;
        else if (reviewState === 'pending') reviewInfo = `<span style="margin-left:0.3rem;background:var(--warning-bg);color:var(--warning);padding:0.1rem 0.4rem;border-radius:30px;font-size:0.7rem;font-weight:700;">⭐ ${t('leaveReview') || 'À noter'}</span>`;

        return `<div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border);"><div><div style="font-weight:600;font-size:0.9rem;">${name}${variantText}${reviewInfo}</div><div style="font-size:0.8rem;color:var(--text-muted);">x${qty}</div>${returnInfo}</div><div style="color:var(--gold);font-weight:600;">${price * qty} ${t('currency')}</div></div>`;
    }).join('');

    const showTimeline = status !== 'cancelled';
    const returnBadge = getReturnBadgeText(order);
    const returnBadgeHtml = returnBadge ? `<div style="margin-bottom:0.8rem;"><span style="background:rgba(155,89,182,0.15);color:#9b59b6;border:1px solid #9b59b6;font-size:0.75rem;font-weight:700;padding:0.25rem 0.7rem;border-radius:30px;">${returnBadge}</span></div>` : '';
    const couponLine = (Number(order.couponDiscount) > 0 && order.couponCode) ? `<div style="display:flex;justify-content:space-between;font-size:0.85rem;color:var(--success);margin-bottom:0.3rem;"><span>🎟️ ${escapeHTML(order.couponCode)}</span><span>-${order.couponDiscount} ${t('currency')}</span></div>` : '';

    const modalHtml = `
        <div class="modal-overlay open" id="orderDetailsModal">
            <div class="modal" style="max-width:550px;">
                <button class="modal-close" id="closeOrderDetailsBtn">✕</button>
                <h2 style="font-family:var(--font-secondary);color:var(--gold);text-align:center;margin-bottom:1rem;">📦 ${t('order')} #${orderIdShort}</h2>
                <div style="margin-bottom:1rem;"><span class="order-status-badge order-status-${status}" style="color:${statusColor};">${emoji} ${statusLabel}</span></div>
                ${returnBadgeHtml}
                ${showTimeline ? renderOrderTimeline(status) : ''}
                <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.8rem;margin-bottom:1rem;">
                    <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.3rem;">📅 <strong>${t('orderDate')} :</strong> ${date}</div>
                    <div style="font-size:0.85rem;color:var(--text-muted);">💳 <strong>${t('orderPaymentStatus')} :</strong> ${order.paymentStatus === 'paid' ? '✅ ' + t('orderPaymentPaid') : '⏳ ' + t('orderPaymentUnpaid')}</div>
                </div>
                <h4 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:0.5rem;">🏠 ${t('orderDeliveryAddress')}</h4>
                <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.8rem;margin-bottom:1rem;font-size:0.85rem;">
                    <div><strong>${escapeHTML(order.deliveryAddress?.name || '')}</strong></div>
                    <div>📞 ${escapeHTML(order.deliveryAddress?.phone || '')}</div>
                    <div>📍 ${escapeHTML(order.deliveryAddress?.address || '')}</div>
                    <div>🏙️ ${escapeHTML(cityDisplay)}</div>
                    ${order.deliveryAddress?.email ? `<div>✉️ ${escapeHTML(order.deliveryAddress.email)}</div>` : ''}
                </div>
                <h4 style="font-family:var(--font-secondary);color:var(--gold);margin-bottom:0.5rem;">🛒 ${t('orderArticles')}</h4>
                <div style="margin-bottom:1rem;">${itemsHtml}</div>
                <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.8rem;">
                    <div style="display:flex;justify-content:space-between;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.3rem;"><span>${t('cartSubtotalLabel')}</span><span>${order.subtotal || 0} ${t('currency')}</span></div>
                    ${order.discount > 0 ? `<div style="display:flex;justify-content:space-between;font-size:0.85rem;color:var(--success);margin-bottom:0.3rem;"><span>${t('discountLabel')}</span><span>-${order.discount} ${t('currency')}</span></div>` : ''}
                    ${couponLine}
                    <div style="display:flex;justify-content:space-between;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.3rem;"><span>${t('cartDeliveryLabel')}</span><span>${order.deliveryFee || 0} ${t('currency')}</span></div>
                    <div style="display:flex;justify-content:space-between;font-size:1.05rem;font-weight:700;color:var(--text);margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--border);"><span>${t('cartTotalLabel')}</span><span style="color:var(--gold);">${order.total || 0} ${t('currency')}</span></div>
                </div>
                ${status === 'delivered' && pendingReviewCount > 0 ? `<button id="orderDetailsReviewBtn" style="width:100%;margin-top:1rem;padding:0.8rem;background:linear-gradient(135deg,var(--gold),#7d5a1d);color:#fff;border:none;border-radius:50px;font-weight:700;cursor:pointer;font-size:0.9rem;">⭐ ${t('leaveReview')} (${pendingReviewCount})</button>` : ''}
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const closeModal = () => { document.getElementById('orderDetailsModal')?.remove(); };
    document.getElementById('closeOrderDetailsBtn').addEventListener('click', closeModal);
    document.getElementById('orderDetailsModal').addEventListener('click', (e) => { if (e.target.id === 'orderDetailsModal') closeModal(); });
    const escHandler = (e) => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);

    const detailsReviewBtn = document.getElementById('orderDetailsReviewBtn');
    if (detailsReviewBtn) detailsReviewBtn.addEventListener('click', async () => { closeModal(); await openQuickReviewModal(order.id); });
}

// ============================================================
// MODAL "GÉRER LE RETOUR"
// ============================================================
export async function openReturnModal(orderId) {
    let order;
    try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (!snap.exists()) { showToast('❌ ' + t('loadError')); return; }
        order = { id: snap.id, ...snap.data() };
    } catch (e) { showToast('❌ ' + t('loadError')); return; }
    if (!canReturnOrder(order)) { showToast('⚠️ ' + (t('returnNotAllowed') || 'Retour impossible')); return; }

    document.getElementById('returnModal')?.remove();
    const returnedQtys = getReturnedQuantities(order);
    const orderIdShort = order.id.slice(0, 8).toUpperCase();

    const itemsHtml = (order.items || []).map(item => {
        const pid = String(item.productId);
        const qtyOrdered = Number(item.quantity) || 0;
        const qtyAlready = returnedQtys[pid] || 0;
        const qtyRemaining = Math.max(0, qtyOrdered - qtyAlready);
        const name = escapeHTML(item.name || `Produit #${item.productId}`);
        const variantText = item.variant ? ` (${escapeHTML([item.variant.size, item.variant.color].filter(Boolean).join(' - '))})` : '';
        const alreadyInfo = qtyAlready > 0 ? `<div style="font-size:0.72rem;color:#9b59b6;font-weight:600;margin-top:0.3rem;">↩️ Déjà retourné : ${qtyAlready}/${qtyOrdered}</div>` : '';

        return `
            <div class="return-item-row" data-product-id="${pid}">
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:600;font-size:0.9rem;word-break:break-word;">${name}${variantText}</div>
                    <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.15rem;">Commandé : <strong>${qtyOrdered}</strong>${qtyAlready > 0 ? ` · Déjà retourné : <strong>${qtyAlready}</strong>` : ''} · Restant : <strong>${qtyRemaining}</strong></div>
                    ${alreadyInfo}
                </div>
                <div style="flex-shrink:0;">
                    <label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:0.15rem;">Retourner</label>
                    <input type="number" class="return-qty-input" data-product-id="${pid}" min="0" max="${qtyOrdered}" value="${qtyAlready}" step="1" style="width:80px;padding:0.4rem;border:1px solid var(--border-gold);border-radius:8px;background:var(--bg-surface);color:var(--text);text-align:center;font-weight:700;">
                </div>
            </div>
        `;
    }).join('');

    const modalHtml = `
        <div class="modal-overlay open" id="returnModal" style="z-index:2100;">
            <div class="modal" style="max-width:550px;">
                <button class="modal-close" id="closeReturnModalBtn">✕</button>
                <h2 style="font-family:var(--font-secondary);color:#9b59b6;text-align:center;margin-bottom:0.5rem;">↩️ ${t('returnModalTitle') || 'Gérer le retour'}</h2>
                <p style="text-align:center;font-size:0.85rem;color:var(--text-muted);margin-bottom:1.2rem;">${t('order')} <strong>#${orderIdShort}</strong></p>
                <div style="background:rgba(155,89,182,0.08);border:1px solid rgba(155,89,182,0.3);border-radius:var(--radius-sm);padding:0.7rem 0.9rem;margin-bottom:1rem;font-size:0.8rem;color:var(--text-muted);">💡 ${t('returnModalHint') || 'Indiquez le nombre d\'unités retournées.'}</div>
                <div id="returnItemsList" style="display:flex;flex-direction:column;gap:0.8rem;margin-bottom:1rem;">${itemsHtml}</div>
                <label style="display:block;font-size:0.8rem;color:var(--text-muted);margin-bottom:0.3rem;">💬 ${t('returnReasonLabel') || 'Raison du retour (optionnel)'}</label>
                <textarea id="returnReasonInput" rows="2" placeholder="${t('returnReasonPlaceholder') || 'Ex : Produit défectueux...'}" style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text);font-family:inherit;font-size:0.85rem;resize:vertical;min-height:50px;margin-bottom:1rem;"></textarea>
                <div style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;">
                    <button id="cancelReturnBtn" style="min-width:110px;padding:0.7rem 1.2rem;background:transparent;border:1px solid var(--border);color:var(--text-muted);border-radius:30px;font-weight:600;cursor:pointer;font-size:0.9rem;">${t('cancel') || 'Annuler'}</button>
                    <button id="confirmReturnBtn" style="min-width:130px;padding:0.7rem 1.2rem;background:linear-gradient(135deg,#9b59b6,#6c3483);color:#fff;border:none;border-radius:30px;font-weight:700;cursor:pointer;font-size:0.9rem;">✅ ${t('returnModalConfirm') || 'Valider le retour'}</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('returnModal');
    const closeModal = () => { modal?.remove(); };
    document.getElementById('closeReturnModalBtn').addEventListener('click', closeModal);
    document.getElementById('cancelReturnBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    modal.querySelectorAll('.return-qty-input').forEach(input => {
        input.addEventListener('input', () => {
            let val = parseInt(input.value) || 0;
            const min = parseInt(input.min) || 0;
            const max = parseInt(input.max) || 0;
            if (val < min) val = min;
            if (val > max) val = max;
            input.value = val;
        });
    });

    document.getElementById('confirmReturnBtn').addEventListener('click', async () => {
        const newQuantities = {};
        modal.querySelectorAll('.return-qty-input').forEach(input => { newQuantities[input.dataset.productId] = parseInt(input.value) || 0; });
        const reason = document.getElementById('returnReasonInput').value.trim();

        const existingQtys = getReturnedQuantities(order);
        let hasChange = false;
        for (const pid in newQuantities) { if ((existingQtys[pid] || 0) !== newQuantities[pid]) { hasChange = true; break; } }
        if (!hasChange) { showToast('⚠️ ' + (t('returnNoChange') || 'Aucune modification')); return; }

        const btn = document.getElementById('confirmReturnBtn');
        btn.disabled = true;
        btn.textContent = '⏳ ' + (t('loading') || 'Chargement...');

        const result = await applyPartialReturn(order, newQuantities, reason);

        if (result.success) {
            if (result.nothingChanged) {
                showToast('ℹ️ ' + (t('returnNoChange') || 'Aucune modification'));
            } else {
                showToast('✅ ' + (t('returnSuccess') || 'Retour enregistré'));
                try {
                    const freshSnap = await getDoc(doc(db, "orders", order.id));
                    if (freshSnap.exists()) {
                        const freshOrder = { id: freshSnap.id, ...freshSnap.data() };
                        await sendOrderEmail(freshOrder, 'returned', 'client');
                        await sendOrderEmail(freshOrder, 'returned', 'admin');
                    }
                } catch (e) {}

                if (order.userId) {
                    try {
                        const { createNotification } = await import("./notifications.js");
                        await createNotification(
                            order.userId,
                            NOTIFICATION_TYPES.ORDER_RETURNED,
                            t('notificationOrderReturned') || '↩️ Retour enregistré',
                            (t('notificationOrderReturnedMsg') || 'Votre retour sur la commande #{id} a été enregistré.').replace('{id}', orderIdShort),
                            { orderId: order.id }
                        );
                    } catch (e) {}
                }
            }
            closeModal();
            if (typeof window._adminRefreshOrders === 'function') await window._adminRefreshOrders();
        } else {
            showToast('❌ ' + (result.error || t('error')));
            btn.disabled = false;
            btn.textContent = '✅ ' + (t('returnModalConfirm') || 'Valider le retour');
        }
    });

    setTimeout(() => { const firstInput = modal.querySelector('.return-qty-input'); if (firstInput) firstInput.focus(); }, 100);
}

// ============================================================
// ✅ C6.1 + C6.2 — UPDATE ORDER STATUS (transaction atomique)
// ------------------------------------------------------------
// Toute la logique métier (stock + coupon + status) dans UNE transaction.
// Emails post-transaction (non-bloquants, ne peuvent pas rollback).
//
// ✅ FIX v4.0.1 :
//   Avant : needRestoreStock excluait PENDING → stock perdu si on
//           annulait une commande pending (car createOrder déduit
//           dès la création avec stockDeducted: true).
//   Après : needRestoreStock inclut PENDING → stock restauré.
// ============================================================
export async function updateOrderStatus(orderId, newStatus) {
    const normalizedStatus = normalizeOrderStatus(newStatus);

    // Cas spécial RETURNED : ouvrir la modale
    if (normalizedStatus === ORDER_STATUS.RETURNED) {
        await openReturnModal(orderId);
        return { success: true, openedModal: true };
    }

    let emailOrder = null;
    let emailStatus = null;

    try {
        await runTransaction(db, async (transaction) => {
            // ===== READS =====
            const orderRef = doc(db, "orders", orderId);
            const orderSnap = await transaction.get(orderRef);
            if (!orderSnap.exists()) throw new Error('Commande introuvable');

            const order = { id: orderId, ...orderSnap.data() };
            const previousStatus = normalizeOrderStatus(order.status);
            emailOrder = order;
            emailStatus = normalizedStatus;

            // Décisions
            const needDeductStock = normalizedStatus === ORDER_STATUS.CONFIRMED
                && previousStatus === ORDER_STATUS.PENDING
                && order.stockDeducted !== true;

            // ✅ FIX v4.0.1 : inclut PENDING (stock déduit dès la création)
            const needRestoreStock = normalizedStatus === ORDER_STATUS.CANCELLED
                && [
                    ORDER_STATUS.PENDING,
                    ORDER_STATUS.CONFIRMED,
                    ORDER_STATUS.SHIPPING,
                    ORDER_STATUS.DELIVERED
                ].includes(previousStatus)
                && order.stockDeducted === true;

            const needRestoreCoupon = normalizedStatus === ORDER_STATUS.CANCELLED
                && order.couponId
                && order.couponRestored !== true;

            // Lecture des produits (si nécessaire)
            let productRefs = [];
            let productSnaps = [];
            if ((needDeductStock || needRestoreStock) && order.items?.length > 0) {
                productRefs = order.items.map(item => doc(db, "products", String(item.productId)));
                productSnaps = await Promise.all(productRefs.map(ref => transaction.get(ref)));
            }

            // Lecture du coupon (si nécessaire)
            let couponRef = null;
            let couponSnap = null;
            let couponUseRef = null;
            if (needRestoreCoupon) {
                couponRef = doc(db, "coupons", order.couponId);
                couponSnap = await transaction.get(couponRef);
                couponUseRef = doc(db, "coupon_uses", `${order.couponId}_${order.userId}`);
            }

            // ===== WRITES =====

            // 1. Déduction stock (legacy orders uniquement)
            if (needDeductStock) {
                productSnaps.forEach((snap, i) => {
                    if (!snap.exists()) return;
                    const pData = snap.data();
                    const qty = Number(order.items[i].quantity) || 0;
                    const itemVariant = order.items[i].variant;

                    if (itemVariant && Array.isArray(pData.variants)) {
                        const variants = [...pData.variants];
                        const idx = variants.findIndex(v =>
                            (v.size || '') === (itemVariant.size || '') &&
                            (v.color || '') === (itemVariant.color || '')
                        );
                        if (idx > -1) {
                            variants[idx].stock = Math.max(0, Number(variants[idx].stock) - qty);
                            const newStock = variants.reduce((s, v) => s + (Number(v.stock) || 0), 0);
                            transaction.update(productRefs[i], {
                                variants, stock: newStock,
                                salesCount: (Number(pData.salesCount) || 0) + qty
                            });
                        }
                    } else {
                        transaction.update(productRefs[i], {
                            stock: Math.max(0, (Number(pData.stock) || 0) - qty),
                            salesCount: (Number(pData.salesCount) || 0) + qty
                        });
                    }
                });
            }

            // 2. Restauration stock (annulation — inclut maintenant PENDING)
            if (needRestoreStock) {
                productSnaps.forEach((snap, i) => {
                    if (!snap.exists()) return;
                    const pData = snap.data();
                    const qty = Number(order.items[i].quantity) || 0;
                    const itemVariant = order.items[i].variant;

                    if (itemVariant && Array.isArray(pData.variants)) {
                        const variants = [...pData.variants];
                        const idx = variants.findIndex(v =>
                            (v.size || '') === (itemVariant.size || '') &&
                            (v.color || '') === (itemVariant.color || '')
                        );
                        if (idx > -1) {
                            variants[idx].stock = (Number(variants[idx].stock) || 0) + qty;
                            const newStock = variants.reduce((s, v) => s + (Number(v.stock) || 0), 0);
                            transaction.update(productRefs[i], {
                                variants, stock: newStock,
                                salesCount: Math.max(0, (Number(pData.salesCount) || 0) - qty)
                            });
                        }
                    } else {
                        transaction.update(productRefs[i], {
                            stock: (Number(pData.stock) || 0) + qty,
                            salesCount: Math.max(0, (Number(pData.salesCount) || 0) - qty)
                        });
                    }
                });
            }

            // 3. Restauration coupon
            if (needRestoreCoupon && couponSnap && couponSnap.exists()) {
                transaction.update(couponRef, { usedCount: increment(-1) });
                transaction.delete(couponUseRef);
            }

            // 4. Update order
            const updateData = {
                status: normalizedStatus,
                updatedAt: Timestamp.now()
            };
            if (needDeductStock) updateData.stockDeducted = true;
            if (needRestoreStock) updateData.stockDeducted = false;
            if (needRestoreCoupon) updateData.couponRestored = true;
            transaction.update(orderRef, updateData);
        });

        // ===== POST-TRANSACTION (non-critique) =====

        // Emails
        if (emailOrder && ['confirmed', 'shipping', 'delivered', 'cancelled'].includes(emailStatus)) {
            try {
                await sendOrderEmail(emailOrder, emailStatus, 'client');
                await sendOrderEmail(emailOrder, emailStatus, 'admin');
            } catch (e) {
                console.warn('⚠️ Email post-transaction échoué :', e);
            }
        }

        // Notification review_request (livraison)
        if (emailStatus === ORDER_STATUS.DELIVERED && emailOrder?.userId) {
            try {
                const { createNotification } = await import("./notifications.js");
                await createNotification(
                    emailOrder.userId,
                    NOTIFICATION_TYPES.REVIEW_REQUEST,
                    '⭐ Laissez un avis sur votre commande',
                    `Votre commande #${orderId.slice(0, 8).toUpperCase()} est livrée ! Partagez votre expérience.`,
                    { orderId, persistent: true }
                );
            } catch (e) {}
        }

        // ✅ I6.4 : pas de 'pending' (créé à la commande dans cart.js)
        const notifMap = {
            confirmed: { type: 'order_confirmed', title: t('notificationOrderConfirmed'), message: t('notificationOrderConfirmedMsg').replace('{id}', orderId.slice(0, 8).toUpperCase()) },
            shipping:  { type: 'order_shipping',  title: t('notificationOrderShipping'),  message: t('notificationOrderShippingMsg').replace('{id}', orderId.slice(0, 8).toUpperCase()) },
            delivered: { type: 'order_delivered', title: t('notificationOrderDelivered'), message: t('notificationOrderDeliveredMsg').replace('{id}', orderId.slice(0, 8).toUpperCase()) },
            cancelled: { type: 'order_cancelled', title: t('notificationOrderCancelled'), message: t('notificationOrderCancelledMsg').replace('{id}', orderId.slice(0, 8).toUpperCase()) }
        };

        const notifData = notifMap[emailStatus];
        if (notifData && emailOrder?.userId) {
            try {
                const { createNotification } = await import("./notifications.js");
                await createNotification(emailOrder.userId, notifData.type, notifData.title, notifData.message, { orderId });
            } catch (e) {}
        }

        document.dispatchEvent(new CustomEvent('order-stock-changed'));
        return { success: true };

    } catch (e) {
        console.error('❌ Erreur update statut :', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// ✅ C6.3 — DELETE ORDER COMPLETELY (nettoyage orphelins)
// ============================================================
export async function deleteOrderCompletely(orderId) {
    try {
        const orderSnap = await getDoc(doc(db, "orders", orderId));
        if (!orderSnap.exists()) return { success: false, error: 'not_found' };

        const order = { id: orderId, ...orderSnap.data() };
        const status = normalizeOrderStatus(order.status);

        // 1. Restaurer stock si nécessaire
        if (order.stockDeducted === true && ![ORDER_STATUS.CANCELLED, ORDER_STATUS.RETURNED].includes(status)) {
            const r = await restoreStockForOrder(orderId);
            if (!r.success) console.warn('⚠️ Échec restauration stock, on continue :', r.error);
        }

        // 2. Restaurer coupon + supprimer notifs + order (batch atomique)
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

        console.log('✅ Commande supprimée complètement :', orderId);
        return { success: true };

    } catch (e) {
        console.error('❌ Erreur deleteOrderCompletely :', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// ✅ M6.6 — RENVOYER LA FACTURE (3 cas)
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

        const [clientResult, adminResult] = await Promise.allSettled([
            sendOrderEmail(order, 'delivered', 'client'),
            sendOrderEmail(order, 'delivered', 'admin')
        ]);

        const clientOk = clientResult.status === 'fulfilled' && clientResult.value?.success === true;
        const adminOk = adminResult.status === 'fulfilled' && adminResult.value?.success === true;

        if (clientOk && adminOk) {
            showToast(`✅ Facture ${getInvoiceNumber(order)} envoyée (client + admin)`);
            return { success: true, clientOk: true, adminOk: true };
        }
        if (clientOk) {
            showToast(`⚠️ Facture client envoyée, admin en échec`);
            return { success: true, clientOk: true, adminOk: false, partial: true };
        }
        if (adminOk) {
            showToast(`⚠️ Facture admin envoyée, client en échec`);
            return { success: true, clientOk: false, adminOk: true, partial: true };
        }

        showToast('❌ Échec de l\'envoi de la facture');
        return { success: false, error: 'send_failed' };

    } catch (e) {
        console.error('❌ Erreur resendInvoice :', e);
        showToast('❌ ' + (e.message || t('error')));
        return { success: false, error: e.message };
    }
}

// ============================================================
// ADMIN : CHARGER LES COMMANDES (paginées)
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
        adminOrdersCache = [...adminOrdersCache, ...newOrders];
        return { orders: adminOrdersCache, hasMore: adminHasMore };
    } catch (e) {
        console.error('❌ Erreur chargement commandes admin :', e);
        return { orders: adminOrdersCache, hasMore: false };
    } finally {
        adminLoading = false;
    }
}

// ============================================================
// ✅ I6.1 + I6.5 + M6.9 — RENDRE LES COMMANDES ADMIN
// ============================================================
export async function renderAdminOrders(containerId = 'adminOrdersList') {
    const container = document.getElementById(containerId);
    if (!container) return;

    // ✅ M6.9 : bouton "Rafraîchir" (une seule fois, hors du container)
    if (!document.querySelector('.admin-orders-refresh-btn')) {
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'admin-btn-secondary admin-orders-refresh-btn';
        refreshBtn.style.cssText = 'display:inline-flex;align-items:center;gap:0.4rem;margin-bottom:0.8rem;font-size:0.8rem;padding:0.4rem 0.9rem;';
        refreshBtn.innerHTML = '🔄 Rafraîchir la liste';
        refreshBtn.addEventListener('click', async () => {
            resetAdminOrdersCache();
            await renderAdminOrders(containerId);
        });
        container.insertAdjacentElement('beforebegin', refreshBtn);
    }

    const isFirstLoad = adminOrdersCache.length === 0;
    if (isFirstLoad) container.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--text-muted);">⏳ ${t('loadingOrders')}</div>`;

    try {
        // ✅ I6.1 : utiliser le cache (pas de re-fetch)
        let orders = adminOrdersCache;
        let hasMore = adminHasMore;
        if (isFirstLoad) {
            const result = await loadAllOrders(true);
            orders = result.orders;
            hasMore = result.hasMore;
        }

        if (orders.length === 0) {
            container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:2rem;">${t('noOrders')}</p>`;
            return;
        }

        let html = '';
        orders.forEach(order => {
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

            const stockBadge = order.stockDeducted === true
                ? `<span style="font-size:0.7rem;color:var(--success);font-weight:700;">📦 Stock déduit</span>`
                : `<span style="font-size:0.7rem;color:var(--warning);font-weight:700;">⏳ Stock non déduit</span>`;
            const returnBadge = getReturnBadgeText(order);
            const returnBadgeHtml = returnBadge ? ` · <span style="font-size:0.7rem;color:#9b59b6;font-weight:700;">${returnBadge}</span>` : '';
            const showReturnBtn = canReturnOrder(order);
            const returnBtnHtml = showReturnBtn
                ? `<button class="btn-return" data-action="admin:return-order" data-id="${order.id}" style="padding:0.3rem 0.8rem;border-radius:30px;background:#9b59b6;color:white;border:none;cursor:pointer;font-weight:600;font-size:0.8rem;">↩️ Retour</button>`
                : '';
            const invoiceBtnHtml = status === 'delivered'
                ? `<button class="btn-invoice" data-action="admin:resend-invoice" data-id="${order.id}" style="padding:0.3rem 0.8rem;border-radius:30px;background:linear-gradient(135deg,var(--gold),#7d5a1d);color:white;border:none;cursor:pointer;font-weight:600;font-size:0.8rem;" title="Renvoyer la facture">🧾 Facture</button>`
                : '';
            const couponBadge = (Number(order.couponDiscount) > 0 && order.couponCode)
                ? `<br><span style="font-size:0.7rem;color:var(--success);font-weight:700;">🎟️ ${escapeHTML(order.couponCode)} (−${order.couponDiscount} MAD)</span>`
                : '';

            // ✅ I6.5 : échapper chaque item AVANT le join
            const itemsSummary = (order.items || []).map(i => {
                const name = escapeHTML(i.name || '');
                const v = i.variant
                    ? ` (${escapeHTML([i.variant.size, i.variant.color].filter(Boolean).join('-'))})`
                    : '';
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

        if (hasMore) html += `<div style="text-align:center;padding:1rem;"><button id="adminLoadMoreOrdersBtn" class="admin-btn-primary" style="margin:0 auto;">⬇️ ${t('loadingOrders')}</button></div>`;
        else if (orders.length >= ADMIN_PAGE_SIZE) html += `<div style="text-align:center;padding:1rem;font-size:0.8rem;color:var(--text-dim);">✓ ${t('success')}</div>`;

        container.innerHTML = html;

        // Listeners
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
                            // ✅ I6.1 : pas de re-fetch
                            await renderAdminOrders(containerId);
                        } else {
                            showToast('❌ ' + result.error);
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
                const confirmed = await confirmAction(
                    t('confirmDeleteOrderMsg').replace('{id}', orderId.slice(0, 8).toUpperCase()),
                    { title: t('confirmDeleteOrderTitle'), confirmText: t('confirmDeleteYes'), cancelText: t('confirmDeleteNo'), variant: 'danger' }
                );
                if (!confirmed) return;
                btn.disabled = true;
                const result = await deleteOrderCompletely(orderId);
                if (result.success) {
                    showToast('✅ ' + t('delete'));
                    adminOrdersCache = adminOrdersCache.filter(o => o.id !== orderId);
                    await renderAdminOrders(containerId);
                } else {
                    showToast('❌ ' + (result.error || t('error')));
                    btn.disabled = false;
                }
            });
        });

        const loadMoreBtn = document.getElementById('adminLoadMoreOrdersBtn');
        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', async () => {
                loadMoreBtn.disabled = true;
                loadMoreBtn.textContent = '⏳ ' + t('loading');
                await renderAdminOrders(containerId);
            });
        }
    } catch (e) {
        console.error(e);
        container.innerHTML = `<p style="color:var(--danger);">${t('loadingError')}</p>`;
    }
}

// ============================================================
// ADMIN : Reset du cache
// ============================================================
export function resetAdminOrdersCache() {
    adminOrdersCache = [];
    adminLastVisible = null;
    adminHasMore = true;
    adminLoading = false;
}

// ============================================================
// ADMIN : Refresh global (utilisé par openReturnModal)
// ============================================================
if (typeof window !== 'undefined') {
    window._adminRefreshOrders = async () => {
        resetAdminOrdersCache();
        await renderAdminOrders('adminOrdersList');
    };
}

// ============================================================
// ✅ M6.1 — Invalidation du cache langue au logout
// ============================================================
if (typeof document !== 'undefined') {
    document.addEventListener('auth-updated', (e) => {
        if (!e.detail?.user) {
            _userLangCache.clear();
            console.log('🧹 Cache userLang vidé (logout)');
        }
    });
}

// ============================================================
// LOG
// ============================================================
console.log('✅ orders.js chargé — v4.0.1 (fix annulation PENDING restaure stock)');