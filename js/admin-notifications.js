/* ============================================================
   js/admin-notifications.js
   ONGLET « CAMPAGNES & NOTIFICATIONS »
   ------------------------------------------------------------
   • Quota EmailJS mensuel (config/emailjs_usage) en temps réel.
   • Cycle de diffusion vendeurs 10:1 (config/notifications_rotation).
   • Bouton « Forcer la diffusion » (config/notifications_command).
   • Création de campagne push (+ EmailJS optionnel, décochée).
   Chargé à la demande par js/admin.js (import dynamique).
   ============================================================ */

import { auth, db } from './firebase.js';
import {
    doc, getDoc, setDoc, addDoc, collection, serverTimestamp, onSnapshot
} from 'firebase/firestore';
import { showToast } from './ui-core.js';
import { escapeHTML } from './utils.js';

const USAGE_LIMIT_FALLBACK = 200;
let unsubscribeUsage = null;
let unsubscribeRotation = null;
let unsubscribeCampaign = null;
let listenersBound = false;

function quotaBox() {
    return document.getElementById('emailQuotaBox');
}

function rotationBox() {
    return document.getElementById('rotationBox');
}

function renderQuota(data) {
    const box = quotaBox();
    if (!box) return;
    const limit = Number((data && data.limit) || USAGE_LIMIT_FALLBACK);
    const count = Number((data && data.count) || 0);
    const month = String((data && data.month) || '—');
    const left = Math.max(0, limit - count);
    const pct = limit > 0 ? Math.min(100, Math.round((count / limit) * 100)) : 0;
    const color = pct >= 90 ? '#e74c3c' : pct >= 70 ? '#e67e22' : '#2ecc71';
    box.innerHTML = `
        <strong>Emails EmailJS envoyés ce mois-ci : ${count} / ${limit}</strong>
        <div style="margin:0.5rem 0;height:8px;border-radius:6px;background:#2a2a2a;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${color};"></div>
        </div>
        <span style="font-size:0.82rem;color:#9a9a9a;">Mois ${escapeHTML(month)} · ${left} email(s) restant(s) · Reset automatique le 1er.</span>`;
}

function renderRotation(data) {
    const box = rotationBox();
    if (!box) return;
    const premium = Number((data && data.premiumCount) || 0);
    const queue = Array.isArray(data && data.lowPriceQueue) ? data.lowPriceQueue : [];
    const cycles = Number((data && data.cycles) || 0);
    const queueHtml = queue.length
        ? queue
              .slice(0, 6)
              .map(
                  (item) =>
                      `<li style="margin:0.15rem 0;">${escapeHTML(String((item && item.productId) || '—'))} — ${Number((item && item.price) || 0)} MAD</li>`
              )
              .join('')
        : '<li style="color:#7a7a7a;">File vide</li>';
    box.innerHTML = `
        <div>Cycle diffusion vendeurs : <strong>${premium} / 10</strong> produits &gt; 500 MAD avant le prochain produit ≤ 500 MAD
        (<strong>${queue.length}</strong> en file d'attente).</div>
        <div style="font-size:0.82rem;color:#9a9a9a;margin-top:0.35rem;">Cycles terminés : ${cycles}</div>
        <ul style="margin:0.5rem 0 0 1rem;padding:0;font-size:0.82rem;color:#cfcfcf;">${queueHtml}</ul>`;
}

async function loadOnce() {
    try {
        const snap = await getDoc(doc(db, 'config', 'emailjs_usage'));
        renderQuota(snap.exists() ? snap.data() : null);
    } catch (error) {
        renderQuota(null);
    }
    try {
        const snap = await getDoc(doc(db, 'config', 'notifications_rotation'));
        renderRotation(snap.exists() ? snap.data() : null);
    } catch (error) {
        renderRotation(null);
    }
}

async function handleForceBroadcast() {
    const input = document.getElementById('forceProductIdInput');
    const button = document.getElementById('forceBroadcastBtn');
    const productId = String((input && input.value) || '').trim();
    if (!productId) {
        showToast('Renseignez l’ID du produit à diffuser.', 4000);
        return;
    }
    if (button) button.disabled = true;
    try {
        await setDoc(
            doc(db, 'config', 'notifications_command'),
            { forceProductId: productId, requestedAt: serverTimestamp(), requestedBy: auth.currentUser?.uid || '' },
            { merge: true }
        );
        showToast('Diffusion demandée — envoi en cours.', 4000);
        if (input) input.value = '';
    } catch (error) {
        console.error('[admin-notifications] force :', error);
        showToast('Impossible de forcer la diffusion.', 5000);
    } finally {
        if (button) button.disabled = false;
    }
}

async function handleSendCampaign() {
    const title = String(document.getElementById('campaignTitle')?.value || '').trim();
    const body = String(document.getElementById('campaignBody')?.value || '').trim();
    const targetUrl = String(document.getElementById('campaignTargetUrl')?.value || '').trim() || '/';
    const segment = document.getElementById('campaignSegment')?.value || 'clients';
    const channelSelect = document.getElementById('campaignChannel')?.value || 'push';
    const sendEmail = document.getElementById('campaignSendEmail')?.checked === true;
    const log = document.getElementById('campaignLogBox');
    const button = document.getElementById('campaignSendBtn');

    if (title.length < 3) {
        showToast('Titre trop court (3 caractères minimum).', 4000);
        return;
    }
    if (!body) {
        showToast('Le message est obligatoire.', 4000);
        return;
    }
    if (button) button.disabled = true;
    if (log) log.textContent = 'Envoi en cours…';
    try {
        const ref = await addDoc(collection(db, 'campaigns'), {
            title: title.slice(0, 120),
            body: body.slice(0, 1000),
            targetUrl,
            segment,
            channel: sendEmail ? 'both' : channelSelect,
            sendEmail,
            type: 'campaign',
            status: 'pending',
            createdBy: auth.currentUser?.uid || '',
            createdAt: serverTimestamp()
        });
        if (log) log.textContent = 'Campagne créée — diffusion en cours…';
        if (unsubscribeCampaign) unsubscribeCampaign();
        unsubscribeCampaign = onSnapshot(
            doc(db, 'campaigns', ref.id),
            (snap) => {
                const data = snap.data() || {};
                if (data.status !== 'sent' || !log) return;
                log.textContent = `✅ Push : ${data.pushSent || 0} · EmailJS : ${data.emailSent || 0}${
                    data.emailReason ? ' (' + data.emailReason + ')' : ''
                }`;
            },
            () => undefined
        );
        document.getElementById('campaignTitle').value = '';
        document.getElementById('campaignBody').value = '';
        showToast('Campagne envoyée.', 4000);
    } catch (error) {
        console.error('[admin-notifications] campagne :', error);
        if (log) log.textContent = 'Erreur : campagne non envoyée.';
        showToast('Impossible d’envoyer la campagne.', 5000);
    } finally {
        if (button) button.disabled = false;
    }
}

/** Point d'entrée appelé par js/admin.js à l'ouverture de l'onglet. */
export async function initNotificationsTab() {
    if (!document.getElementById('rotationBox')) return;
    if (!listenersBound) {
        listenersBound = true;
        document.getElementById('forceBroadcastBtn')?.addEventListener('click', handleForceBroadcast);
        document.getElementById('campaignSendBtn')?.addEventListener('click', handleSendCampaign);
    }
    await loadOnce();
    if (!unsubscribeUsage) {
        unsubscribeUsage = onSnapshot(
            doc(db, 'config', 'emailjs_usage'),
            (snap) => renderQuota(snap.exists() ? snap.data() : null),
            () => undefined
        );
    }
    if (!unsubscribeRotation) {
        unsubscribeRotation = onSnapshot(
            doc(db, 'config', 'notifications_rotation'),
            (snap) => renderRotation(snap.exists() ? snap.data() : null),
            () => undefined
        );
    }
}
