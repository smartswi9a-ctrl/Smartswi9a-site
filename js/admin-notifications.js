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
/* Doit rester aligné sur functions/emails.js → PROMO_QUOTA_LIMIT. */
const PROMO_QUOTA_LIMIT = 180;
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
    /* Plafond promotionnel (reciblage) : 180 / 200 → au-delà, push gratuit. */
    const promoCap = Math.min(limit, PROMO_QUOTA_LIMIT);
    const promoLeft = Math.max(0, promoCap - count);
    const promoPct = promoCap > 0 ? Math.min(100, Math.round((count / promoCap) * 100)) : 0;
    box.innerHTML = `
        <strong>Emails EmailJS envoyés ce mois-ci : ${count} / ${limit}</strong>
        <div style="margin:0.5rem 0;height:8px;border-radius:6px;background:#2a2a2a;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${color};"></div>
        </div>
        <div style="margin:0 0 0.45rem;height:5px;border-radius:4px;background:#2a2a2a;overflow:hidden;">
            <div style="width:${promoPct}%;height:100%;background:${promoPct >= 100 ? '#e74c3c' : '#d4af37'};"></div>
        </div>
        <span style="font-size:0.82rem;color:#9a9a9a;">Mois ${escapeHTML(month)} · ${left} email(s) restant(s) sur le quota global · Reset automatique le 1er.</span>
        <div style="margin-top:0.35rem;font-size:0.82rem;color:${promoLeft === 0 ? '#e74c3c' : '#c9c9c9'};">
            ⚠️ <strong>180 max promo</strong> : ${promoCap} emails promotionnels par mois maximum
            (${promoLeft} restant(s)). Au-delà, les baisses de prix passent <strong>uniquement en push gratuit</strong>.
        </div>`;
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

/** Encart de diagnostic push (état réel de CET appareil). */
async function renderPushDiag() {
    const box = document.getElementById('pushDiagState');
    const allowBtn = document.getElementById('pushAllowBtn');
    const testBtn = document.getElementById('pushTestBtn');
    if (!box) return;

    const getStatus = window.smartswikaPushStatus;
    if (typeof getStatus !== 'function') {
        box.textContent = '⚠️ Module push indisponible sur cette page.';
        return;
    }

    let status = null;
    try {
        status = await getStatus();
    } catch (error) {
        status = null;
    }
    if (!status) {
        box.textContent = '⚠️ Impossible de lire l’état du push sur cet appareil.';
        return;
    }

    const platformLabel = status.platform === 'pwa_installed' ? 'Application PWA' : 'Navigateur';
    if (allowBtn) allowBtn.style.display = 'none';
    if (testBtn) testBtn.style.display = 'none';

    if (status.permission === 'granted' && status.token) {
        box.innerHTML = `✅ <strong>Push actif sur cet appareil</strong> — ${platformLabel} · token <code>${escapeHTML(
            status.tokenHead
        )}…</code>`;
        if (testBtn) testBtn.style.display = '';
        return;
    }
    if (status.permission === 'granted') {
        box.innerHTML = '⏳ Autorisation accordée — enregistrement du token en cours…';
        window.setTimeout(renderPushDiag, 2500);
        return;
    }
    if (status.permission === 'default') {
        box.innerHTML =
            '⚠️ <strong>En attente d’autorisation</strong> — les alertes s’activent automatiquement au prochain clic sur le site, ou immédiatement avec le bouton ci-dessous.';
        if (allowBtn) allowBtn.style.display = '';
        return;
    }
    if (status.iosNeedsInstall) {
        box.innerHTML =
            '📱 Sur iPhone / iPad : installez d’abord l’application (<strong>Partager → Sur l’écran d’accueil</strong>), puis ouvrez-la — le push s’active au premier toucher.';
        return;
    }
    if (status.permission === 'denied') {
        box.innerHTML =
            '🚫 <strong>Notifications bloquées</strong> pour ce site. Réactivez-les via le cadenas 🔒 de la barre d’adresse, puis rechargez la page.';
        return;
    }
    box.innerHTML = '⚠️ Push non pris en charge par ce navigateur.';
}

async function handlePushAllow() {
    const log = document.getElementById('pushDiagLog');
    const button = document.getElementById('pushAllowBtn');
    if (button) button.disabled = true;
    try {
        const result = await window.smartswikaEnablePush({ silent: false });
        if (log) {
            log.textContent = result && result.ok ? '✅ Autorisation accordée.' : '⚠️ Autorisation non accordée.';
        }
    } finally {
        if (button) button.disabled = false;
        await renderPushDiag();
    }
}

async function handlePushTest() {
    const log = document.getElementById('pushDiagLog');
    const button = document.getElementById('pushTestBtn');
    if (button) button.disabled = true;
    if (log) log.textContent = 'Envoi du push de test…';
    try {
        const result = await window.smartswikaSendTestPush();
        if (log) {
            log.textContent =
                result && result.ok
                    ? '✅ Notification test envoyée — vérifiez votre écran (verrouillé ou en arrière-plan).'
                    : `⚠️ Échec de l’envoi (${escapeHTML(String((result && result.error) || 'inconnu'))}).`;
        }
        showToast(result && result.ok ? 'Push de test envoyé.' : 'Échec du push de test.', 4000);
    } catch (error) {
        if (log) log.textContent = '⚠️ Erreur réseau pendant l’envoi du test.';
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
        document.getElementById('pushAllowBtn')?.addEventListener('click', handlePushAllow);
        document.getElementById('pushTestBtn')?.addEventListener('click', handlePushTest);
        document.addEventListener('smartswika:push-token', () => {
            renderPushDiag();
        });
    }
    await loadOnce();
    await renderPushDiag();
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
