/* ============================================================
   functions/emails.js — EMAILJS, MODE ÉCONOMIE STRICTE
   ------------------------------------------------------------
   5 emails automatiques seulement :
     VENDEUR : ramassage approuvé, marchandise reçue à l'entrepôt,
               nouvelle commande vendeur, suspension de compte.
     CLIENT  : confirmation initiale de commande.
   ADMIN : AUCUN email — push + cloche in-app uniquement.
   Quota : config/emailjs_usage, 200 emails / mois calendaire
   Africa/Casablanca, remis à zéro automatiquement le 1er.
   ============================================================ */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

const db = getFirestore();

/* Identifiants EmailJS déjà utilisés par le site (js/orders.js). */
const EMAILJS = {
  SERVICE_ID: 'service_gder468',
  TEMPLATE_ID: 'template_6tp1n35',
  PUBLIC_KEY: '47Wn3We2YOdAoSN2g',
  ENDPOINT: 'https://api.emailjs.com/api/v1.0/email/send'
};

const QUOTA_LIMIT = 200;
/* Plafond promotionnel : au-delà de 180, tout bascule en push gratuit. */
const PROMO_QUOTA_LIMIT = 180;
const USAGE_PATH = 'config/emailjs_usage';
const LOGS = 'email_logs';
const SITE = 'https://smartswika.ma';
const BRAND = 'Smartswika';

/* Clé privée EmailJS (Account → Security → Private Key).
   Le compte est en « strict mode » : l'API refuse toute requête serveur
   sans clé privée (403 « API access in strict mode »).
   À définir dans functions/.env (non versionné) :
     EMAILJS_PRIVATE_KEY=xxxxxxxxxxxxxxxx
   Puis `firebase deploy --only functions`. */
function emailjsPrivateKey() {
  return String(process.env.EMAILJS_PRIVATE_KEY || '').trim();
}

/* Politique email (module pur, testé unitairement). */
const { SELLER_TYPES, CLIENT_TYPES, shouldSendEmail, monthKey } = require('./email-policy');

function mad(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2).replace(/\.00$/, '')} MAD` : '—';
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Jeton de désinscription (uid + HMAC tronqué). */
function unsubscribeToken(uid) {
  const secret = process.env.EMAILJS_UNSUB_SECRET || EMAILJS.PUBLIC_KEY;
  const sig = crypto.createHmac('sha256', secret).update(String(uid)).digest('hex').slice(0, 24);
  return `${Buffer.from(String(uid)).toString('base64url')}.${sig}`;
}

function verifyUnsubscribeToken(token) {
  const raw = String(token || '');
  const [encoded, sig] = raw.split('.');
  if (!encoded || !sig) return null;
  let uid = '';
  try {
    uid = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch (error) {
    return null;
  }
  const expected = unsubscribeToken(uid).split('.')[1];
  if (!uid || expected !== sig) return null;
  return uid;
}

function unsubscribeUrl(uid) {
  /* URL propre : Cloudflare Pages et Firebase redirigent *.html (308). */
  return `${SITE}/unsubscribe?t=${encodeURIComponent(unsubscribeToken(uid))}`;
}

/* ---------- Gabarit HTML (compatible clients mail) ---------- */

function layout({ title, intro, rows = [], cta, ctaUrl, footer, unsub }) {
  const rowsHtml = rows
    .map(
      (row) =>
        `<tr><td style="padding:6px 0;color:#6b6b6b;font-size:13px;">${esc(row[0])}</td>` +
        `<td style="padding:6px 0;color:#1a1a1a;font-size:13px;font-weight:600;text-align:right;">${esc(row[1])}</td></tr>`
    )
    .join('');
  const ctaHtml = cta
    ? `<p style="margin:22px 0 6px;"><a href="${esc(ctaUrl || SITE)}" style="background:#d4af37;color:#1a1a1a;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block;">${esc(cta)}</a></p>`
    : '';
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f8f6f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8f6f2;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:14px;padding:26px;border:1px solid #ece7dc;">
<tr><td>
<p style="margin:0 0 14px;font-size:15px;letter-spacing:2px;color:#d4af37;font-weight:800;">SMARTSWIKA</p>
<h1 style="margin:0 0 12px;font-size:21px;line-height:1.3;color:#1a1a1a;">${esc(title)}</h1>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#3a3a3a;">${intro}</p>
${rowsHtml ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #ece7dc;">${rowsHtml}</table>` : ''}
${ctaHtml}
<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#8a8a8a;">${footer || 'L’équipe Smartswika — Casablanca, Maroc.'}</p>
${unsub ? `<p style="margin:14px 0 0;font-size:11px;color:#a0a0a0;"><a href="${esc(unsub)}" style="color:#a0a0a0;">Se désinscrire des emails</a></p>` : ''}
</td></tr></table>
<p style="margin:16px 0 0;font-size:11px;color:#a0a0a0;">© ${new Date().getFullYear()} Smartswika.ma — Livraison 24-72h au Maroc.</p>
</td></tr></table></body></html>`;
}

/**
 * Construit le contenu d'un des 5 emails critiques.
 * @returns {{subject: string, html: string, text: string}|null}
 */
function buildEmail(type, data = {}, ctx = {}) {
  const name = String(data.name || '').split(' ')[0] || (data.role === 'seller' ? 'Cher vendeur' : 'Bonjour');
  const unsub = ctx.uid ? unsubscribeUrl(ctx.uid) : '';

  if (type === 'seller_pickup_approved') {
    const slot = data.slot ? `le ${data.slot}` : 'selon le créneau convenu';
    return {
      subject: '✅ Ramassage approuvé — déposez vos articles',
      html: layout({
        title: 'Votre ramassage est approuvé',
        intro: `${esc(name)}, votre demande de ramassage a été validée. Merci de déposer vos articles à l’entrepôt <strong>${esc(slot)}</strong>.`,
        rows: [
          ['Référence demande', data.requestId || '—'],
          ['Créneau', data.slot || 'À convenir avec l’équipe'],
          ['Entrepôt', 'Smart Swika — Casablanca'],
          ['Articles', data.summary || '—']
        ],
        cta: 'Voir mes demandes de ramassage',
        ctaUrl: `${SITE}/vendor/dashboard?tab=stock`,
        footer: 'Une fois les articles réceptionnés, nous vous préviendrons pour débloquer la création de vos produits.',
        unsub
      }),
      text: `Ramassage approuvé (${data.requestId || '—'}) — ${slot}. Entrepôt Smart Swika, Casablanca. Articles : ${data.summary || '—'}.`
    };
  }

  if (type === 'seller_warehouse_received') {
    const url = `${SITE}/vendor/dashboard?tab=products`;
    return {
      subject: '📦 Marchandise reçue — création de produits débloquée',
      html: layout({
        title: 'Vos articles sont à l’entrepôt',
        intro: `${esc(name)}, nous confirmons la réception de vos marchandises à l’entrepôt Smart Swika. Le formulaire d’ajout de produit est désormais <strong>débloqué</strong> pour ces articles.`,
        rows: [
          ['Demande de ramassage', data.requestId || '—'],
          ['Articles reçus', data.summary || '—'],
          ['Statut', 'Reçu à l’entrepôt ✅']
        ],
        cta: 'Ajouter mes produits',
        ctaUrl: url,
        footer: 'Publiez vos fiches dès maintenant : la validation admin prend en général moins de 24 h.',
        unsub
      }),
      text: `Marchandise reçue à l’entrepôt (${data.requestId || '—'}). Formulaire d’ajout de produit débloqué : ${url}`
    };
  }

  if (type === 'seller_new_order') {
    const lines = Array.isArray(data.lines) ? data.lines : [];
    const rows = lines.slice(0, 8).map((line) => [line.label, `${line.qty} × ${mad(line.price)}`]);
    rows.push(['Total vendeur', mad(data.vendorTotal)]);
    rows.push(['Client / ville', data.city || '—']);
    return {
      subject: `🛒 Nouvelle commande ${data.orderNumber || ''} — ${mad(data.vendorTotal)}`.trim(),
      html: layout({
        title: 'Nouvelle commande vendeur',
        intro: `${esc(name)}, vous avez reçu une nouvelle commande. Préparez les articles et déposez-les à l’entrepôt Smart Swika.`,
        rows: [['Commande', data.orderNumber || '—'], ...rows],
        cta: 'Voir la commande',
        ctaUrl: `${SITE}/vendor/dashboard?tab=orders&order=${encodeURIComponent(data.orderId || '')}`,
        footer: 'Le montant affiché est votre part vendeur (commission Smartswika de 7 % déjà déduite).',
        unsub
      }),
      text: `Nouvelle commande ${data.orderNumber || ''} — ${mad(data.vendorTotal)} (${lines.length} ligne(s)).`
    };
  }

  if (type === 'seller_suspended') {
    const typeLabel =
      data.suspensionType === 'permanent'
        ? 'Définitive'
        : `Temporaire${data.until ? ` jusqu’au ${data.until}` : ''}`;
    return {
      subject: `⛔ Compte vendeur suspendu (${typeLabel})`,
      html: layout({
        title: 'Suspension de votre compte vendeur',
        intro: `${esc(name)}, votre compte vendeur vient d’être suspendu. Voici les éléments transmis par l’équipe Smartswika.`,
        rows: [
          ['Type de suspension', typeLabel],
          ['Cause', data.cause || 'Non précisée'],
          ['Date', data.date || '—']
        ],
        cta: 'Contacter le support',
        ctaUrl: 'mailto:smartswi9a@gmail.com?subject=Suspension%20compte%20vendeur',
        footer: 'Vous pouvez répondre à cet email pour demander un réexamen de votre situation.',
        unsub
      }),
      text: `Compte suspendu (${typeLabel}). Cause : ${data.cause || 'non précisée'}.`
    };
  }

  if (type === 'client_order_confirmation') {
    const lines = Array.isArray(data.lines) ? data.lines : [];
    const rows = lines.slice(0, 8).map((line) => [line.label, `${line.qty} × ${mad(line.price)}`]);
    rows.push(['Livraison', data.city || '—']);
    rows.push(['Total à régler à la livraison', mad(data.total)]);
    return {
      subject: `✅ Commande ${data.orderNumber || ''} confirmée — ${mad(data.total)}`.trim(),
      html: layout({
        title: 'Merci pour votre commande',
        intro: `${esc(name)}, votre commande est bien enregistrée. Vous la réglerez <strong>en espèces à la livraison</strong> (24-72 h selon votre ville).`,
        rows: [['N° de commande', data.orderNumber || '—'], ...rows],
        cta: 'Suivre ma commande',
        ctaUrl: `${SITE}/?action=account&order=${encodeURIComponent(data.orderId || '')}`,
        footer: 'Les étapes suivantes (en route, livrée) vous sont notifiées dans l’application.',
        unsub
      }),
      text: `Commande ${data.orderNumber || ''} confirmée — ${mad(data.total)} à régler à la livraison (${data.city || '—'}).`
    };
  }

  return null;
}

/* ---------- Quota mensuel (config/emailjs_usage) ---------- */

async function reserveEmailSlot(count = 1, limit = QUOTA_LIMIT) {
  const month = monthKey();
  const cap = Number.isFinite(Number(limit)) ? Number(limit) : QUOTA_LIMIT;
  const ref = db.doc(USAGE_PATH);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() || {} : {};
      const sameMonth = String(data.month || '') === month;
      const used = sameMonth ? Number(data.count || 0) : 0;
      if (used + count > cap) {
        if (!sameMonth) {
          tx.set(
            ref,
            { month, count: 0, limit: QUOTA_LIMIT, resetAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
            { merge: true }
          );
        }
        return { ok: false, used, limit: cap, month, reason: 'quota_exceeded' };
      }
      tx.set(
        ref,
        {
          month,
          count: used + count,
          limit: QUOTA_LIMIT,
          ...(sameMonth ? {} : { resetAt: FieldValue.serverTimestamp() }),
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return { ok: true, used: used + count, limit: cap, month };
    });
  } catch (error) {
    console.warn('[emails] quota :', error.message);
    return { ok: false, used: 0, limit: cap, month, reason: 'quota_error' };
  }
}

/* ---------- Envoi via l'API REST EmailJS ---------- */

async function sendEmailJS({ to, name, subject, html, text }) {
  const privateKey = emailjsPrivateKey();
  if (!privateKey) throw new Error('emailjs_private_key_missing');
  const response = await fetch(EMAILJS.ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS.SERVICE_ID,
      template_id: EMAILJS.TEMPLATE_ID,
      user_id: EMAILJS.PUBLIC_KEY,
      accessToken: privateKey,
      template_params: {
        to_email: to,
        to_name: name || String(to).split('@')[0],
        subject,
        html_content: html,
        text_content: text || ''
      }
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`emailjs_${response.status}:${String(body).slice(0, 140)}`);
  return true;
}

async function logEmail(entry) {
  try {
    await db.collection(LOGS).add({ ...entry, createdAt: FieldValue.serverTimestamp() });
  } catch (error) {
    /* le journal ne doit jamais bloquer un envoi */
  }
}

/** Email + nom + préférence de désinscription d'un utilisateur. */
async function getUserContact(uid) {
  try {
    const snap = await db.collection('users').doc(String(uid)).get();
    if (!snap.exists) return { email: '', name: '', optOut: false };
    const data = snap.data() || {};
    const info = data.vendorInfo || {};
    return {
      email: String(data.email || info.email || '').trim(),
      name: String(info.shopName || data.name || data.displayName || '').trim(),
      optOut: data.emailOptOut === true
    };
  } catch (error) {
    return { email: '', name: '', optOut: false };
  }
}

/**
 * Envoie un des 5 emails critiques (gating + opt-out + quota).
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendCriticalEmail({ uid, role, type, data = {} }) {
  try {
    if (!uid || !shouldSendEmail(role, type)) {
      return { sent: false, reason: 'not_allowed' };
    }
    const contact = await getUserContact(uid);
    if (!contact.email || !contact.email.includes('@')) return { sent: false, reason: 'no_email' };
    if (contact.optOut) return { sent: false, reason: 'opt_out' };
    /* Pas de clé privée : on n'entame PAS le quota, on journalise. */
    if (!emailjsPrivateKey()) {
      await logEmail({ type, uid, to: contact.email, ok: false, reason: 'no_private_key' });
      return { sent: false, reason: 'no_private_key' };
    }

    const content = buildEmail(type, { ...data, name: contact.name || data.name, role }, { uid });
    if (!content) return { sent: false, reason: 'no_template' };

    const quota = await reserveEmailSlot(1);
    if (!quota.ok) {
      await logEmail({ type, uid, to: contact.email, ok: false, reason: quota.reason, month: quota.month });
      return { sent: false, reason: quota.reason };
    }

    await sendEmailJS({ to: contact.email, name: contact.name, ...content });
    await logEmail({ type, uid, to: contact.email, ok: true, month: quota.month });
    return { sent: true, used: quota.used, limit: quota.limit };
  } catch (error) {
    console.warn('[emails] sendCriticalEmail :', error.message);
    await logEmail({ type, uid, to: '', ok: false, reason: String(error.message).slice(0, 120) });
    return { sent: false, reason: 'send_error' };
  }
}

/** Email « digest » de reciblage (règles 5 / 6 / 9). */
function buildPromoDigestEmail({ uid, digest, client = {}, abandoned = false }) {
  const name = String(client.name || client.displayName || '').split(' ')[0] || 'Bonjour';
  const rows = (digest.lines || [])
    .slice(0, 10)
    .map((line) => [line.title, `${mad(line.seenPrice)} → ${mad(line.newPrice)}`]);
  if (Number(digest.totalDrop) > 0) rows.push(['Économie totale', mad(digest.totalDrop)]);
  const first = (digest.lines && digest.lines[0]) || {};
  return {
    subject: digest.title,
    html: layout({
      title: digest.title,
      intro: `${esc(name)}, vous avez consulté ${
        digest.count > 1 ? 'ces articles' : 'cet article'
      } : ${
        digest.count > 1 ? 'ils sont maintenant en promotion' : 'il est maintenant en promotion'
      }.`,
      rows,
      cta: abandoned ? 'Reprendre mon panier' : 'Voir le produit',
      ctaUrl: abandoned ? `${SITE}/panier` : `${SITE}/produit?slug=${encodeURIComponent(first.productId || '')}`,
      footer: 'Offre valable dans la limite des stocks disponibles. Paiement à la livraison au Maroc.',
      unsub: uid ? unsubscribeUrl(uid) : ''
    }),
    text: `${digest.title} — ${(digest.lines || [])
      .map((line) => `${line.title} : ${mad(line.seenPrice)} → ${mad(line.newPrice)}`)
      .join(' | ')}`
  };
}

/** Envoi du digest promotionnel (plafond 180/200). */
async function sendPromoDigestEmail({ uid, digest, client = {}, abandoned = false }) {
  try {
    const email = String(client.email || '').trim();
    if (!email || !email.includes('@')) return { sent: false, reason: 'no_email' };
    if (client.emailOptOut === true) return { sent: false, reason: 'opt_out' };
    if (!emailjsPrivateKey()) return { sent: false, reason: 'no_private_key' };
    if (!digest || !Array.isArray(digest.lines) || !digest.lines.length) {
      return { sent: false, reason: 'empty_digest' };
    }

    const quota = await reserveEmailSlot(1, PROMO_QUOTA_LIMIT);
    if (!quota.ok) {
      await logEmail({ type: 'promo_digest', uid, to: email, ok: false, reason: quota.reason, month: quota.month });
      return { sent: false, reason: quota.reason || 'quota_exceeded' };
    }

    const content = buildPromoDigestEmail({ uid, digest, client, abandoned });
    await sendEmailJS({ to: email, name: client.name || '', ...content });
    await logEmail({ type: 'promo_digest', uid, to: email, ok: true, month: quota.month });
    return { sent: true, used: quota.used, limit: quota.limit };
  } catch (error) {
    console.warn('[emails] sendPromoDigestEmail :', error.message);
    return { sent: false, reason: 'send_error' };
  }
}

const MAX_CAMPAIGN_EMAILS = 60;
const CAMPAIGN_DELAY_MS = 2500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Campagne optionnelle depuis l'admin : file d'attente espacée (2,5 s),
 * lien de désinscription obligatoire, jamais vers les admins.
 */
async function sendCampaignEmails(campaignId, campaign = {}) {
  if (campaign.sendEmail !== true) return { sent: 0, skipped: 0, reason: 'email_disabled' };
  if (!emailjsPrivateKey()) return { sent: 0, skipped: 0, reason: 'no_private_key' };
  const segment = String(campaign.segment || 'clients');
  if (segment === 'admins') return { sent: 0, skipped: 0, reason: 'admin_no_email' };

  const roles = segment === 'vendors' ? ['vendor'] : ['user', 'client'];
  let recipients = [];
  try {
    const snap = await db.collection('users').where('role', 'in', roles).limit(200).get();
    recipients = snap.docs.map((d) => ({ uid: d.id, ...(d.data() || {}) }));
  } catch (error) {
    console.warn('[emails] campagne destinataires :', error.message);
    return { sent: 0, skipped: 0, reason: 'query_error' };
  }

  let sent = 0;
  let skipped = 0;
  for (const user of recipients) {
    if (sent >= MAX_CAMPAIGN_EMAILS) break;
    const email = String(user.email || '').trim();
    if (!email || !email.includes('@') || user.emailOptOut === true) {
      skipped += 1;
      continue;
    }
    const content = layout({
      title: String(campaign.title || 'Smartswika').slice(0, 120),
      intro: esc(campaign.body || ''),
      cta: campaign.targetUrl ? 'Découvrir' : '',
      ctaUrl: campaign.targetUrl || SITE,
      footer: 'Vous recevez cet email car vous avez créé un compte sur smartswika.ma.',
      unsub: unsubscribeUrl(user.uid)
    });
    const quota = await reserveEmailSlot(1);
    if (!quota.ok) break;
    try {
      await sendEmailJS({
        to: email,
        name: user.name || '',
        subject: String(campaign.title || 'Smartswika').slice(0, 120),
        html: content,
        text: String(campaign.body || '')
      });
      sent += 1;
    } catch (error) {
      skipped += 1;
      console.warn('[emails] campagne :', error.message);
    }
    await sleep(CAMPAIGN_DELAY_MS);
  }
  await logEmail({ type: `campaign_${campaignId}`, uid: '', to: '', ok: true, reason: `sent:${sent}/skip:${skipped}` });
  return { sent, skipped };
}

module.exports = {
  EMAILJS,
  QUOTA_LIMIT,
  PROMO_QUOTA_LIMIT,
  USAGE_PATH,
  SELLER_TYPES,
  CLIENT_TYPES,
  shouldSendEmail,
  monthKey,
  mad,
  esc,
  buildEmail,
  layout,
  unsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  reserveEmailSlot,
  sendEmailJS,
  sendCriticalEmail,
  sendPromoDigestEmail,
  buildPromoDigestEmail,
  sendCampaignEmails,
  getUserContact,
  emailjsPrivateKey
};

