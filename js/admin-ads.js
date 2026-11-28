/* ============================================================
   js/admin-ads.js — ONGLET « 📊 SUIVI PUBS TIKTOK & META »
   ------------------------------------------------------------
   Responsabilités :
     1. Configuration des pixels Meta / TikTok et des budgets par
        période (7 j, 30 j, mois, tout) dans Firestore `config/ads`.
        Un miroir public `config/ads_public` ne contient QUE les IDs
        pixels (la vitrine n'a jamais accès aux budgets).
     2. 4 cartes KPI animées par admin-ui.js :
        commandes créées / livrées + taux COD, CA LIVRÉ, bénéfice
        NET LIVRÉ (coût produit + frais Livo), ROAS réel.
     3. Graphique Chart.js : CA commandé vs CA livré par canal
        (TikTok, Meta, Organique/Direct, Autres).
     4. Tableau par source & campagne + version cartes empilées en
        mobile (390 px), tableau complet à partir de 768 px.
     5. Générateur de lien UTM copiable en un clic.

   Sources de données :
     - orders        : total, deliveryFee, status, items, attribution
     - products      : purchasePrice (coût produit)
     - ad_events_daily : vues / paniers / checkouts / achats (anonymes)
     - config/ads    : IDs pixels + budgets par période
   Aucune API publicitaire payante : le ROAS est calculé à partir
   des dépenses saisies manuellement par l'admin.
   ============================================================ */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { getApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";
import {
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
} from "firebase/storage";
import { db, storage } from "./firebase.js";
import { adminT, getAdminLang } from "./admin-ui.js?v=drawer2027e";
import { escapeHTML } from "./utils.js";
import { showToast } from "./ui-core.js";

/* ============================================================
   ÉTAT
   ============================================================ */

const PERIODS = ["7", "30", "month", "all"];
const SOURCE_VALUES = ["tiktok", "meta", "google", "whatsapp", "direct", "other"];
const CHANNEL_ORDER = ["tiktok", "meta", "direct", "other"];
const SPEND_SUFFIX = { 7: "7", 30: "30", month: "Month", all: "All" };

let currentPeriod = "7";
let adsConfig = {};
let adsSecrets = {};
let cachedOrders = [];
let cachedAllOrders = [];
let cachedEvents = [];
let cachedProducts = [];
let cachedViews = [];
let cachedCampaigns = [];
let chartInstance = null;
let functionsInstance = null;
let initialized = false;
let loading = false;
let launching = false;
let lastStats = null;
let saveStatusTimer = null;

const OFFICIAL_VENDOR_IDS = new Set([
  "smartswi9a",
  "smartswika",
  "platform",
  "smartswi9a-31063",
]);
const ADS_MANAGER_META = "https://adsmanager.facebook.com/adsmanager/manage/campaigns";
const ADS_MANAGER_TIKTOK = "https://ads.tiktok.com/i18n/dashboard";
const CAROUSEL_MIN_PRODUCTS = 3;
const CAROUSEL_MAX_PRODUCTS = 20;
const CAROUSEL_TOP_COUNT = 10;
const CAROUSEL_DEFAULT_COPY = {
  fr: "Découvrez nos meilleurs gadgets connectés au Maroc 🇲🇦 — Paiement à la livraison 24-72h + Garantie 15 jours !",
  en: "Discover our best connected gadgets in Morocco 🇲🇦 — Cash on Delivery 24-72h + 15-day warranty!",
  ar: "اكتشف أفضل الأجهزة المتصلة في المغرب 🇲🇦 — الدفع عند الاستلام خلال 24-72 ساعة + ضمان 15 يومًا!",
};
let carouselDraft = null;
let editorState = null;
let editorPreviewTab = "facebook";
let editorReplaceIndex = -1;
let editorReplaceCardIndex = -1;
const adminTranslate = adminT;

/* Aucune cle ads* brute ne doit etre rendue dans les cartes dynamiques. */
function adsT(key) {
  const value = adminTranslate(key);
  return value === key ? "" : value;
}

/* ============================================================
   HELPERS
   ============================================================ */

/**
 * Formatage numérique compatible count-up (admin-ui.js) :
 *   - séparateur de milliers = espace (FR / EN / AR) ;
 *   - séparateur décimal = virgule (FR / AR) ou point (EN).
 * Un groupement par virgule (« 5,385 ») ou par point arabe
 * (« 5.385 ») serait interprété comme un nombre décimal par le
 * compteur animé : on impose donc l'espace, compris par parseCount.
 */
function fmtNumber(value, decimals = 0) {
  const num = Number(value) || 0;
  const rounded = decimals
    ? Number(num.toFixed(decimals))
    : Math.round(num);
  const fixed = decimals ? rounded.toFixed(decimals) : String(rounded);
  const negative = fixed.startsWith("-");
  const unsigned = negative ? fixed.slice(1) : fixed;
  const parts = unsigned.split(".");
  const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const decimalSeparator = getAdminLang() === "en" ? "." : ",";
  const fraction = parts[1] ? decimalSeparator + parts[1] : "";
  return (negative ? "-" : "") + grouped + fraction;
}

function fmtMad(value, decimals = 0) {
  /* Isolation bidi : en arabe (RTL), « 3 135 MAD » ne doit jamais
     s'afficher « MAD 3.135 ». LRI/PDI force le segment en LTR. */
  return `\u2066${fmtNumber(value, decimals)} MAD\u2069`;
}

function pct(part, total, decimals = 1) {
  const p = Number(part) || 0;
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return Math.round((p / t) * 100 * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") {
    try {
      return value.toDate();
    } catch (e) {
      return null;
    }
  }
  if (typeof value === "number") return new Date(value);
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  return null;
}

function dayKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function normalizeStatus(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isDelivered(order) {
  const status = normalizeStatus(order && order.status);
  return status === "delivered" || status === "livree" || status === "livre";
}

function isNegativeCodStatus(order) {
  const status = normalizeStatus(order && order.status);
  return status === "returned" || status === "cancelled" || status === "canceled";
}

function orderSource(order) {
  const source = order && order.attribution ? String(order.attribution.source || "") : "";
  return SOURCE_VALUES.includes(source) ? source : "direct";
}

function orderCampaign(order) {
  const campaign = order && order.attribution ? order.attribution.campaign : "";
  return String(campaign || "").trim().slice(0, 120);
}

function channelOfSource(source) {
  if (source === "tiktok") return "tiktok";
  if (source === "meta") return "meta";
  if (source === "direct") return "direct";
  return "other";
}

function channelLabel(channel) {
  if (channel === "tiktok") return adsT("adsChannelTiktok");
  if (channel === "meta") return adsT("adsChannelMeta");
  if (channel === "direct") return adsT("adsChannelDirect");
  return adsT("adsChannelOther");
}

function sourceLabel(source) {
  if (source === "tiktok") return adsT("adsChannelTiktok");
  if (source === "meta") return adsT("adsChannelMeta");
  if (source === "direct") return adsT("adsChannelDirect");
  if (source === "google") return "Google";
  if (source === "whatsapp") return "WhatsApp";
  return adsT("adsChannelOther");
}

function periodRange(period) {
  if (period === "all") return null;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  if (period === "7") start.setDate(start.getDate() - 6);
  else if (period === "30") start.setDate(start.getDate() - 29);
  else if (period === "month") start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

function inRange(date, range) {
  if (!range) return true;
  if (!date) return false;
  return date >= range.start && date <= range.end;
}

function spendForSource(source) {
  const suffix = SPEND_SUFFIX[currentPeriod] || "7";
  const channel = channelOfSource(source);
  if (channel === "tiktok") return Number(adsConfig[`spendTiktok${suffix}`]) || 0;
  if (channel === "meta") return Number(adsConfig[`spendMeta${suffix}`]) || 0;
  if (channel === "other") return Number(adsConfig[`spendOther${suffix}`]) || 0;
  return 0;
}

function totalSpend() {
  const suffix = SPEND_SUFFIX[currentPeriod] || "7";
  return (
    (Number(adsConfig[`spendMeta${suffix}`]) || 0) +
    (Number(adsConfig[`spendTiktok${suffix}`]) || 0) +
    (Number(adsConfig[`spendOther${suffix}`]) || 0)
  );
}

function productCost(productId) {
  const product = cachedProducts.find((p) => String(p.id) === String(productId));
  return product ? Number(product.purchasePrice) || 0 : 0;
}

function orderCogs(order) {
  let cogs = 0;
  for (const item of Array.isArray(order && order.items) ? order.items : []) {
    if (!item) continue;
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    cogs += productCost(item.productId) * qty;
  }
  return cogs;
}

/* ============================================================
   CHARGEMENT DES DONNÉES
   ============================================================ */

async function loadProducts() {
  if (cachedProducts.length) return;
  const snap = await getDocs(query(collection(db, "products"), limit(500)));
  cachedProducts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadOrders(range) {
  const snap = await getDocs(
    query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(2000))
  );
  const orders = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
    __date: toDate(d.data().createdAt),
  }));
  cachedAllOrders = orders;
  cachedOrders = orders.filter((order) => inRange(order.__date, range));
}

async function loadEvents(range) {
  const snap = await getDocs(
    query(collection(db, "ad_events_daily"), orderBy("date", "desc"), limit(2000))
  );
  const startKey = range ? dayKeyOf(range.start) : "";
  cachedEvents = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((event) => {
      const key = String(event.date || "");
      if (!startKey) return true;
      return key >= startKey;
    });
}

async function loadConfig() {
  const snap = await getDoc(doc(db, "config", "ads"));
  adsConfig = snap.exists() ? snap.data() || {} : {};
}

async function loadSecrets() {
  try {
    const snap = await getDoc(doc(db, "config", "ads_secrets"));
    adsSecrets = snap.exists() ? snap.data() || {} : {};
  } catch (error) {
    console.warn("[admin-ads] secrets illisibles :", error && error.code);
    adsSecrets = {};
  }
}

async function loadProductViews() {
  const snap = await getDocs(
    query(collection(db, "product_views"), orderBy("viewCount", "desc"), limit(2000))
  );
  cachedViews = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadCampaigns() {
  const snap = await getDocs(
    query(collection(db, "ad_campaigns"), orderBy("createdAt", "desc"), limit(500))
  );
  cachedCampaigns = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
    __date: toDate(d.data().createdAt),
  }));
}

async function loadAll() {
  if (loading) return;
  loading = true;
  const range = periodRange(currentPeriod);
  try {
    await Promise.all([loadConfig(), loadProducts(), loadSecrets()]);
    await Promise.all([
      loadOrders(range),
      loadEvents(range),
      loadProductViews(),
      loadCampaigns(),
    ]);
    lastStats = computeStats();
    renderKpi(lastStats);
    renderChart(lastStats);
    renderTable(lastStats);
    renderSpendInputs();
    renderSuggestions();
    renderCampaigns();
  } catch (error) {
    console.error("[admin-ads] chargement impossible :", error);
    const status = document.getElementById("adsConfigStatus");
    if (status) {
      status.textContent = adsT("adsSaveError");
      status.classList.add("is-error");
    }
  } finally {
    loading = false;
  }
}

/* ============================================================
   AGRÉGATION
   ============================================================ */

function computeStats() {
  const campaigns = new Map(); /* `${source}::${campaign}` -> ligne */
  const channels = new Map(); /* tiktok|meta|direct|other -> totaux */
  let created = 0;
  let delivered = 0;
  let revenue = 0;
  let cogs = 0;
  let shipping = 0;

  const ensureChannel = (channel) => {
    if (!channels.has(channel)) {
      channels.set(channel, {
        channel,
        created: 0,
        delivered: 0,
        revenue: 0,
        cogs: 0,
        shipping: 0,
      });
    }
    return channels.get(channel);
  };

  CHANNEL_ORDER.forEach(ensureChannel);

  for (const order of cachedOrders) {
    const source = orderSource(order);
    const campaign = orderCampaign(order);
    const channel = channelOfSource(source);
    const key = `${source}::${campaign}`;
    if (!campaigns.has(key)) {
      campaigns.set(key, {
        source,
        channel,
        campaign,
        created: 0,
        delivered: 0,
        revenue: 0,
        cogs: 0,
        shipping: 0,
      });
    }
    const row = campaigns.get(key);
    const ch = ensureChannel(channel);
    const total = Number(order.total) || 0;
    const orderCogsValue = orderCogs(order);
    const orderShipping = Number(order.deliveryFee) || 0;

    row.created += 1;
    ch.created += 1;
    created += 1;

    if (isDelivered(order)) {
      row.delivered += 1;
      row.revenue += total;
      row.cogs += orderCogsValue;
      row.shipping += orderShipping;
      ch.delivered += 1;
      ch.revenue += total;
      ch.cogs += orderCogsValue;
      ch.shipping += orderShipping;
      delivered += 1;
      revenue += total;
      cogs += orderCogsValue;
      shipping += orderShipping;
    }
  }

  const eventsByChannel = new Map();
  const ensureEventChannel = (channel) => {
    if (!eventsByChannel.has(channel)) {
      eventsByChannel.set(channel, {
        viewContent: 0,
        addToCart: 0,
        initiateCheckout: 0,
        purchase: 0,
      });
    }
    return eventsByChannel.get(channel);
  };
  CHANNEL_ORDER.forEach(ensureEventChannel);

  for (const event of cachedEvents) {
    const source = SOURCE_VALUES.includes(event.source) ? event.source : "direct";
    const bucket = ensureEventChannel(channelOfSource(source));
    bucket.viewContent += Number(event.viewContent) || 0;
    bucket.addToCart += Number(event.addToCart) || 0;
    bucket.initiateCheckout += Number(event.initiateCheckout) || 0;
    bucket.purchase += Number(event.purchase) || 0;
  }

  const spendSuffix = SPEND_SUFFIX[currentPeriod] || "7";
  const spendTotal =
    (Number(adsConfig[`spendMeta${spendSuffix}`]) || 0) +
    (Number(adsConfig[`spendTiktok${spendSuffix}`]) || 0) +
    (Number(adsConfig[`spendOther${spendSuffix}`]) || 0);

  const channelRows = CHANNEL_ORDER.map((channel) => {
    const ch = channels.get(channel) || {
      created: 0,
      delivered: 0,
      revenue: 0,
      cogs: 0,
      shipping: 0,
    };
    const ev = eventsByChannel.get(channel) || { viewContent: 0, addToCart: 0 };
    const net = ch.revenue - ch.cogs - ch.shipping;
    let spend = 0;
    if (channel === "tiktok") {
      spend = Number(adsConfig[`spendTiktok${spendSuffix}`]) || 0;
    } else if (channel === "meta") {
      spend = Number(adsConfig[`spendMeta${spendSuffix}`]) || 0;
    } else if (channel === "other") {
      spend = Number(adsConfig[`spendOther${spendSuffix}`]) || 0;
    }
    return {
      type: "channel",
      channel,
      label: channelLabel(channel),
      campaign: adsT("adsAllCampaigns"),
      views: ev.viewContent,
      addToCart: ev.addToCart,
      created: ch.created,
      delivered: ch.delivered,
      deliveryRate: pct(ch.delivered, ch.created),
      revenue: ch.revenue,
      net,
      spend,
      roas: spend > 0 ? ch.revenue / spend : null,
    };
  });

  const campaignRows = Array.from(campaigns.values())
    .map((row) => {
      const channelTotal = channels.get(row.channel) || { revenue: 0 };
      const parent = channelRows.find((r) => r.channel === row.channel);
      const channelSpend = parent ? parent.spend : 0;
      /* Dépense du canal répartie au prorata du CA livré : les
         campagnes sans livraison portent 0 (ROAS non calculable). */
      const share = channelTotal.revenue > 0 ? row.revenue / channelTotal.revenue : 0;
      const spend = channelSpend * share;
      const net = row.revenue - row.cogs - row.shipping;
      return {
        type: "campaign",
        channel: row.channel,
        label: sourceLabel(row.source),
        campaign: row.campaign,
        views: null,
        addToCart: null,
        created: row.created,
        delivered: row.delivered,
        deliveryRate: pct(row.delivered, row.created),
        revenue: row.revenue,
        net,
        spend,
        roas: spend > 0 ? row.revenue / spend : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.created - a.created);

  const rows = [];
  for (const channel of CHANNEL_ORDER) {
    const channelRow = channelRows.find((r) => r.channel === channel);
    if (!channelRow) continue;
    const hasData =
      channelRow.created > 0 ||
      channelRow.views > 0 ||
      channelRow.addToCart > 0 ||
      channelRow.spend > 0;
    if (!hasData) continue;
    rows.push(channelRow);
    campaignRows
      .filter((row) => row.channel === channel && row.campaign)
      .forEach((row) => rows.push(row));
  }

  return {
    created,
    delivered,
    deliveryRate: pct(delivered, created),
    revenue,
    net: revenue - cogs - shipping,
    spend: spendTotal,
    roas: spendTotal > 0 ? revenue / spendTotal : null,
    channelRows,
    rows,
  };
}

/* ============================================================
   RENDU — KPI & GRAPHIQUE
   ============================================================ */

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderKpi(stats) {
  /* Isolation bidi : « créées / livrées » ne doit pas s'inverser en AR. */
  setText(
    "adsKpiOrders",
    `\u2066${fmtNumber(stats.created)} / ${fmtNumber(stats.delivered)}\u2069`
  );
  setText(
    "adsKpiDelivery",
    `${adsT("adsKpiDelivery")} : \u2066${fmtNumber(stats.deliveryRate, 1)} %\u2069`
  );
  setText("adsKpiRevenue", fmtMad(stats.revenue));
  setText("adsKpiNet", fmtMad(stats.net));
  setText(
    "adsKpiRoas",
    stats.roas == null ? "—" : `${fmtNumber(stats.roas, 2)}x`
  );
}

function renderChart(stats) {
  const canvas = document.getElementById("adsChannelChart");
  if (!canvas || typeof window.Chart !== "function") return;
  const labels = CHANNEL_ORDER.map(channelLabel);
  /* Le CA commandé n'est pas stocké par canal : on le reconstitue
     depuis les commandes créées (total), y compris non livrées. */
  const orderedByChannel = {};
  CHANNEL_ORDER.forEach((channel) => {
    orderedByChannel[channel] = 0;
  });
  for (const order of cachedOrders) {
    const channel = channelOfSource(orderSource(order));
    orderedByChannel[channel] = (orderedByChannel[channel] || 0) + (Number(order.total) || 0);
  }
  const orderedData = CHANNEL_ORDER.map((channel) => Math.round(orderedByChannel[channel] || 0));
  const deliveredData = CHANNEL_ORDER.map((channel) => {
    const row = stats.channelRows.find((r) => r.channel === channel);
    return row ? Math.round(row.revenue) : 0;
  });

  if (chartInstance && typeof chartInstance.destroy === "function") {
    chartInstance.destroy();
  }
  chartInstance = new window.Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: adsT("adsChartCreated"),
          data: orderedData,
          backgroundColor: "rgba(180, 131, 62, 0.85)",
          borderColor: "#B4833E",
          borderWidth: 1,
          borderRadius: 6,
          maxBarThickness: 42,
        },
        {
          label: adsT("adsChartDelivered"),
          data: deliveredData,
          backgroundColor: "rgba(46, 125, 91, 0.85)",
          borderColor: "#2E7D5B",
          borderWidth: 1,
          borderRadius: 6,
          maxBarThickness: 42,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label(context) {
              const value = Number(context.parsed.y) || 0;
              return `${context.dataset.label}: ${fmtMad(value)}`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback(value) {
              return fmtNumber(value);
            },
          },
        },
      },
    },
  });
}

/* ============================================================
   RENDU — TABLEAU (desktop/tablette) & CARTES (mobile 390 px)
   ============================================================ */

function money(value) {
  const num = Number(value) || 0;
  return fmtMad(num, Math.abs(num % 1) > 0.001 ? 2 : 0);
}

function roasCell(row) {
  if (row.roas == null) return "—";
  return `<span class="ads-roas">\u2066${fmtNumber(row.roas, 2)}x\u2069</span>`;
}

function renderTable(stats) {
  const tbody = document.getElementById("adsTableBody");
  const cards = document.getElementById("adsCards");
  if (!tbody || !cards) return;

  if (!stats.rows.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="ads-empty">${escapeHTML(
      adsT("adsNoData")
    )}</td></tr>`;
    cards.innerHTML = `<div class="ads-empty">${escapeHTML(adsT("adsNoData"))}</div>`;
    return;
  }

  tbody.innerHTML = stats.rows
    .map((row) => {
      const isChannel = row.type === "channel";
      return `<tr class="${isChannel ? "ads-channel-row" : "ads-campaign-row"}">
        <td>${escapeHTML(row.label)}</td>
        <td>${escapeHTML(row.campaign)}</td>
        <td>${isChannel ? fmtNumber(row.views) : "—"}</td>
        <td>${isChannel ? fmtNumber(row.addToCart) : "—"}</td>
        <td>${fmtNumber(row.created)}</td>
        <td>${fmtNumber(row.delivered)}</td>
        <td>${row.created > 0 ? `\u2066${fmtNumber(row.deliveryRate, 1)} %\u2069` : "—"}</td>
        <td>${money(row.revenue)}</td>
        <td>${money(row.net)}</td>
        <td>${money(row.spend)}</td>
        <td>${roasCell(row)}</td>
      </tr>`;
    })
    .join("");

  cards.innerHTML = stats.rows
    .map((row) => {
      const isChannel = row.type === "channel";
      const items = [
        [adsT("adsColViews"), isChannel ? fmtNumber(row.views) : "—"],
        [adsT("adsColAddCart"), isChannel ? fmtNumber(row.addToCart) : "—"],
        [adsT("adsColOrders"), fmtNumber(row.created)],
        [adsT("adsColDelivered"), fmtNumber(row.delivered)],
        [
          adsT("adsColDeliveryRate"),
          row.created > 0 ? `\u2066${fmtNumber(row.deliveryRate, 1)} %\u2069` : "—",
        ],
        [adsT("adsColRevenue"), money(row.revenue)],
        [adsT("adsColNet"), money(row.net)],
        [adsT("adsColSpend"), money(row.spend)],
        [adsT("adsColRoas"), row.roas == null ? "—" : `\u2066${fmtNumber(row.roas, 2)}x\u2069`],
      ];
      return `<article class="ads-card">
        <div class="ads-card-head">
          <span>${escapeHTML(row.label)}</span>
          <span>${row.roas == null ? "—" : `\u2066${fmtNumber(row.roas, 2)}x\u2069`}</span>
        </div>
        <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem;">${escapeHTML(
          row.campaign
        )}</div>
        <div class="ads-card-grid">
          ${items
            .map(
              ([label, value]) =>
                `<div><span>${escapeHTML(label)}</span><strong>${value}</strong></div>`
            )
            .join("")}
        </div>
      </article>`;
    })
    .join("");
}

/* ============================================================
   MOTEUR IA — SCORING COD & CAMPAGNES SUGGÉRÉES
   ============================================================ */

function isOfficialProduct(product) {
  if (!product) return false;
  const vendorId = String(product.vendorId || "").trim();
  if (!vendorId) return true;
  if (OFFICIAL_VENDOR_IDS.has(vendorId)) return true;
  return product.isSmartswikaOfficial === true && vendorId === "smartswi9a";
}

function officialProducts() {
  return cachedProducts.filter(
    (product) =>
      product.status === "approved" &&
      Number(product.stock) > 0 &&
      isOfficialProduct(product)
  );
}

function averageLivoFee() {
  const delivered = cachedAllOrders.filter(isDelivered);
  const fees = delivered
    .map((order) => Number(order.deliveryFee))
    .filter((fee) => Number.isFinite(fee) && fee > 0);
  if (!fees.length) return 30;
  return Math.round(fees.reduce((sum, fee) => sum + fee, 0) / fees.length);
}

function productOrderStats(productId) {
  let total = 0;
  let delivered = 0;
  let closed = 0;
  for (const order of cachedAllOrders) {
    const items = Array.isArray(order.items) ? order.items : [];
    const hasProduct = items.some(
      (item) => item && String(item.productId) === String(productId)
    );
    if (!hasProduct) continue;
    total += 1;
    if (isDelivered(order)) {
      delivered += 1;
      closed += 1;
    } else if (isNegativeCodStatus(order)) {
      closed += 1;
    }
  }
  return {
    total,
    delivered,
    closed,
    deliveryRate: closed > 0 ? delivered / closed : 0.6,
  };
}

function productViewCount(productId) {
  return cachedViews
    .filter((view) => String(view.productId) === String(productId))
    .reduce((sum, view) => sum + (Number(view.viewCount) || 0), 0);
}

function suggestedDailyBudget(margin) {
  if (!(margin > 0)) return 50;
  const raw = Math.round((margin * 0.6) / 10) * 10;
  return Math.max(30, Math.min(300, raw || 50));
}

function suggestedChannel(score, margin, views) {
  if (score >= 75 && margin >= 80) return "both";
  if (views >= 100 || margin < 60) return "tiktok";
  return "meta";
}

function suggestedBadge(score, margin) {
  if (score >= 80) return { key: "adsBadgeWinning", emoji: "🔥" };
  if (margin >= 100) return { key: "adsBadgeHighMargin", emoji: "💎" };
  return { key: "adsBadgeStrong", emoji: "📈" };
}

function buildAdCopy(product, price) {
  const nameFr = product.nameFr || product.nameEn || product.nameAr || "Produit";
  const nameEn = product.nameEn || nameFr;
  const nameAr = product.nameAr || nameFr;
  const priceText = fmtNumber(price);
  return {
    fr: `🔥 ${nameFr} à ${priceText} MAD seulement !\n✅ Paiement à la livraison 24-72h partout au Maroc\n👉 Commandez maintenant`,
    en: `🔥 ${nameEn} for only ${priceText} MAD!\n✅ Cash on Delivery 24-72h across Morocco\n👉 Order now`,
    ar: `🔥 ${nameAr} بسعر ${priceText} درهم فقط!\n✅ الدفع عند الاستلام خلال 24-72 ساعة في كل المغرب\n👉 اطلب الآن`,
  };
}

function buildDestinationUrl(productId, source) {
  const safeId = String(productId).replace(/[^A-Za-z0-9_-]/g, "");
  const safeSource = source === "meta" ? "meta" : "tiktok";
  return `https://www.smartswika.ma/produit.html?id=${encodeURIComponent(
    safeId
  )}&utm_source=${safeSource}&utm_medium=paid_social&utm_campaign=auto_${safeId}`;
}

function buildSuggestion(product, livoFee) {
  const price = Number(product.price) || 0;
  const purchase = Number(product.purchasePrice) || 0;
  const margin = Math.max(0, price - purchase - livoFee);
  const orders = productOrderStats(product.id);
  const views = productViewCount(product.id);
  const marginScore = Math.min(40, Math.max(0, (margin / 150) * 40));
  const interestScore = Math.min(
    30,
    (views / 100) * 20 + Math.min(10, orders.total * 2)
  );
  const codScore = Math.min(30, Math.max(0, orders.deliveryRate * 30));
  const score = Math.round(marginScore + interestScore + codScore);
  const channel = suggestedChannel(score, margin, views);
  const badge = suggestedBadge(score, margin);
  const copy = buildAdCopy(product, price);
  const source = channel === "meta" ? "meta" : "tiktok";
  return {
    product,
    price,
    margin,
    views,
    orders,
    score,
    channel,
    badge,
    budget: suggestedDailyBudget(margin),
    copy,
    destinationUrl: buildDestinationUrl(product.id, source),
  };
}

function suggestionChannelLabel(channel) {
  if (channel === "meta") return adsT("adsChannelMeta");
  if (channel === "tiktok") return adsT("adsChannelTiktok");
  return adsT("adsChannelBoth");
}

function productDisplayName(product) {
  if (!product) return "";
  const lang = getAdminLang();
  if (lang === "ar") {
    return product.nameAr || product.nameFr || product.nameEn || "";
  }
  if (lang === "en") {
    return product.nameEn || product.nameFr || product.nameAr || "";
  }
  return product.nameFr || product.nameEn || product.nameAr || "";
}

function adsFunctions() {
  if (!functionsInstance) {
    functionsInstance = getFunctions(getApp(), "europe-west1");
  }
  return functionsInstance;
}

async function callAdsFunction(name, data) {
  const callable = httpsCallable(adsFunctions(), name);
  const result = await callable(data || {});
  return result.data;
}

function platformIsConfigured(platform) {
  const metaReady = Boolean(adsSecrets.metaAccessToken && adsSecrets.metaAdAccountId);
  const tiktokReady = Boolean(
    adsSecrets.tiktokAccessToken && adsSecrets.tiktokAdvertiserId
  );
  if (platform === "meta") return metaReady;
  if (platform === "tiktok") return tiktokReady;
  return metaReady && tiktokReady;
}

function budgetEditorValues(source) {
  const data = source || {};
  const rate = Number(data.usdMadRate || data.rate) > 0 ? Number(data.usdMadRate || data.rate) : 10;
  const durationDays = Number(data.durationDays) || 0;
  const totalBudgetMad = Number(data.totalBudgetMad) || 0;
  const totalBudgetUsd =
    Number(data.totalBudgetUsd) > 0
      ? Number(data.totalBudgetUsd)
      : totalBudgetMad > 0
      ? totalBudgetMad / rate
      : 20;
  const mode = data.budgetMode || (durationDays > 0 ? "total" : "daily");
  return {
    mode,
    daily: Number(data.dailyBudgetMad) || Number(data.budget) || 50,
    total: totalBudgetUsd,
    currency: data.currency
      ? String(data.currency).toUpperCase() === "MAD"
        ? "MAD"
        : "USD"
      : mode === "total"
      ? "USD"
      : "MAD",
    days: durationDays || 5,
    rate,
  };
}

function budgetEditorHtml(values) {
  const v = budgetEditorValues(values);
  return `<div class="ads-budget-editor" data-budget-editor>
    <label>${escapeHTML(adsT("adsBudgetMode"))}
      <select data-budget-mode>
        <option value="daily" ${v.mode === "daily" ? "selected" : ""}>${escapeHTML(
          adsT("adsBudgetDaily")
        )}</option>
        <option value="total" ${v.mode === "total" ? "selected" : ""}>${escapeHTML(
          adsT("adsBudgetTotalMode")
        )}</option>
      </select>
    </label>
    <label data-budget-daily-field>${escapeHTML(adsT("adsBudgetDailyAmount"))}
      <input type="number" min="20" max="5000" step="1" data-budget-daily value="${v.daily}">
    </label>
    <label data-budget-total-field>${escapeHTML(adsT("adsBudgetTotalAmount"))}
      <input type="number" min="1" max="100000" step="0.01" data-budget-total value="${v.total}">
    </label>
    <label data-budget-total-field>${escapeHTML(adsT("adsBudgetCurrency"))}
      <select data-budget-currency>
        <option value="USD" ${v.currency === "USD" ? "selected" : ""}>USD ($)</option>
        <option value="MAD" ${v.currency === "MAD" ? "selected" : ""}>MAD</option>
      </select>
    </label>
    <label data-budget-total-field>${escapeHTML(adsT("adsBudgetDuration"))}
      <input type="number" min="1" max="365" step="1" data-budget-days value="${v.days}">
    </label>
    <label data-budget-total-field>${escapeHTML(adsT("adsBudgetRate"))}
      <input type="number" min="1" max="100" step="0.1" data-budget-rate value="${v.rate}">
    </label>
    <p class="ads-budget-summary" data-budget-summary></p>
  </div>`;
}

function readBudgetEditor(root) {
  if (!root) return budgetEditorValues({});
  return {
    mode: root.querySelector("[data-budget-mode]")?.value || "daily",
    daily: Number(root.querySelector("[data-budget-daily]")?.value) || 20,
    total: Number(root.querySelector("[data-budget-total]")?.value) || 20,
    currency: root.querySelector("[data-budget-currency]")?.value || "USD",
    days: Math.max(1, Math.round(Number(root.querySelector("[data-budget-days]")?.value) || 1)),
    rate: Number(root.querySelector("[data-budget-rate]")?.value) || 10,
  };
}

function computeBudget(values) {
  const rate = Number(values.rate) > 0 ? Number(values.rate) : 10;
  const days = Math.max(1, Math.round(Number(values.days) || 1));
  const totalNative = Number(values.total) || 0;
  const totalMad =
    values.currency === "USD" ? totalNative * rate : totalNative;
  let dailyMad;
  let dailyNative;
  if (values.mode === "total") {
    dailyMad = totalMad / days;
    dailyNative =
      values.currency === "USD" ? totalNative / days : totalMad / days;
    return {
      mode: "total",
      days,
      rate,
      totalNative,
      totalMad,
      dailyMad,
      dailyNative,
      currency: values.currency,
    };
  }
  dailyMad = Number(values.daily) || 0;
  dailyNative = values.currency === "USD" ? dailyMad / rate : dailyMad;
  return {
    mode: "daily",
    days: 1,
    rate,
    totalNative: dailyNative,
    totalMad: dailyMad,
    dailyNative,
    dailyMad,
    currency: values.currency,
  };
}

function budgetSummaryText(values) {
  const b = computeBudget(values);
  const symbol = b.currency === "USD" ? "$" : "MAD";
  if (b.mode === "daily") {
    return adsT("adsBudgetDailySummary")
      .replaceAll("{daily}", fmtNumber(b.dailyNative, 2))
      .replaceAll("{symbol}", symbol)
      .replaceAll("{dailyMad}", fmtNumber(b.dailyMad, 2));
  }
  return `${adsT("adsBudgetSummary")
    .replaceAll("{total}", fmtNumber(b.totalNative, 2))
    .replaceAll("{symbol}", symbol)
    .replaceAll("{totalMad}", fmtNumber(b.totalMad, 2))
    .replaceAll("{days}", String(b.days))
    .replaceAll("{daily}", fmtNumber(b.dailyNative, 2))
    .replaceAll("{dailyMad}", fmtNumber(b.dailyMad, 2))} ${adsT(
    "adsBudgetStop"
  ).replaceAll("{days}", String(b.days))}`;
}

function updateBudgetEditor(root) {
  if (!root) return;
  const values = readBudgetEditor(root);
  const isTotal = values.mode === "total";
  root.classList.toggle("is-total", isTotal);
  root.querySelectorAll("[data-budget-daily-field]").forEach((el) => {
    el.hidden = isTotal;
  });
  root.querySelectorAll("[data-budget-total-field]").forEach((el) => {
    el.hidden = !isTotal;
  });
  const summary = root.querySelector("[data-budget-summary]");
  if (summary) summary.textContent = budgetSummaryText(values);
}

function bindBudgetEditor(root, onChange) {
  if (!root) return;
  root.querySelectorAll("input, select").forEach((input) => {
    input.addEventListener("input", () => {
      updateBudgetEditor(root);
      if (onChange) onChange(readBudgetEditor(root));
    });
    input.addEventListener("change", () => {
      updateBudgetEditor(root);
      if (onChange) onChange(readBudgetEditor(root));
    });
  });
  updateBudgetEditor(root);
}

function budgetPayload(values) {
  const b = computeBudget(values);
  return {
    dailyBudgetMad: Math.round(b.dailyMad * 100) / 100,
    durationDays: b.mode === "total" ? b.days : 0,
    totalBudgetMad: Math.round(b.totalMad * 100) / 100,
    totalBudgetUsd: Math.round((b.totalMad / b.rate) * 100) / 100,
    currency: b.currency,
    usdMadRate: b.rate,
  };
}

function editorCtaOptions() {
  return [
    { key: "order", label: adsT("adsEditorCtaOrder") },
    { key: "offer", label: adsT("adsEditorCtaOffer") },
    { key: "shop", label: adsT("adsEditorCtaShop") },
    { key: "arabic", label: adsT("adsEditorCtaArabic") },
  ];
}

function editorMediaFromProduct(product) {
  const url = product.img || (product.gallery || [])[0] || "/assets/logo-64.png";
  return { type: "image", url, posterUrl: "" };
}

function editorInitialState(options) {
  const campaign = options.campaign || null;
  const kind = options.kind || (campaign && campaign.type === "carousel" ? "carousel" : "suggestion");
  if (campaign) {
    const media =
      Array.isArray(campaign.customMedia) && campaign.customMedia.length
        ? campaign.customMedia
        : (Array.isArray(campaign.customImages) ? campaign.customImages : [])
            .filter(Boolean)
            .map((url) => ({ type: "image", url, posterUrl: "" }));
    const fallbackProduct = cachedProducts.find(
      (product) => String(product.id) === String(campaign.productId)
    );
    const fallbackMedia = fallbackProduct ? [editorMediaFromProduct(fallbackProduct)] : [];
    return {
      kind: campaign.type === "carousel" ? "carousel" : "suggestion",
      campaignId: campaign.id,
      status: campaign.status || "DRAFT",
      platform: campaign.platform === "tiktok" ? "tiktok" : campaign.platform === "both" ? "both" : "meta",
      campaignName: campaign.campaignName || adsT("adsEditorDefaultCampaignName"),
      adCopy: { ...CAROUSEL_DEFAULT_COPY, ...(campaign.adCopy || {}) },
      headline: campaign.headline || campaign.productTitle || "",
      description: campaign.description || "",
      ctaLabel: campaign.ctaLabel || adsT("adsEditorCtaOrder"),
      media: media.length ? media : fallbackMedia,
      carouselCards: Array.isArray(campaign.carouselCards) ? campaign.carouselCards.slice() : [],
      budget: budgetEditorValues(campaign),
      startPaused: String(campaign.status || "").toUpperCase() !== "ACTIVE",
      productId: campaign.productId || "",
      productIds: Array.isArray(campaign.productIds) ? campaign.productIds.slice() : [],
      destinationUrl: campaign.destinationUrl || "",
      original: null,
    };
  }

  if (kind === "carousel") {
    const products = carouselSelectedProducts();
    const chosen = products.length >= CAROUSEL_MIN_PRODUCTS
      ? products
      : topCarouselProducts().slice(0, CAROUSEL_TOP_COUNT);
    const draft = ensureCarouselDraft();
    const budgetRoot = options.card?.querySelector("[data-budget-editor]");
    return {
      kind,
      campaignId: null,
      status: "NEW",
      platform: draft.channel || "both",
      campaignName: draft.campaignName || adsT("adsCarouselDefaultName"),
      adCopy: { ...CAROUSEL_DEFAULT_COPY, ...(draft.copies || {}) },
      headline: adsT("adsEditorCarouselHeadline"),
      description: adsT("adsEditorDefaultDescription"),
      ctaLabel: adsT("adsEditorCtaOrder"),
      media: chosen.map((item) => editorMediaFromProduct(item.product)),
      carouselCards: chosen.map((item) => ({
        productId: String(item.product.id),
        title: productDisplayName(item.product),
        priceMad: money(Number(item.product.price) || 0),
        text: "",
        imageUrl: item.product.img || (item.product.gallery || [])[0] || "",
        mediaType: "image",
        mediaUrl: item.product.img || (item.product.gallery || [])[0] || "",
        posterUrl: "",
      })),
      budget: budgetRoot ? readBudgetEditor(budgetRoot) : budgetEditorValues(draft),
      startPaused: draft.startPaused !== false,
      productId: chosen[0] ? String(chosen[0].product.id) : "",
      productIds: chosen.map((item) => String(item.product.id)),
      destinationUrl: "",
      original: null,
    };
  }

  const product = cachedProducts.find(
    (item) => String(item.id) === String(options.productId)
  );
  if (!product) return null;
  const suggestion = buildSuggestion(product, averageLivoFee());
  const budgetRoot = options.card?.querySelector("[data-budget-editor]");
  return {
    kind: "suggestion",
    campaignId: null,
    status: "NEW",
    platform: options.card?.querySelector("[data-suggestion-channel]")?.value || suggestion.channel,
    campaignName: `Smartswika ${productDisplayName(product)}`,
    adCopy: { ...suggestion.copy },
    headline: productDisplayName(product),
    description: adsT("adsEditorDefaultDescription"),
    ctaLabel: adsT("adsEditorCtaOrder"),
    media: [editorMediaFromProduct(product)],
    carouselCards: [],
    budget: budgetRoot ? readBudgetEditor(budgetRoot) : budgetEditorValues({
      dailyBudgetMad: suggestion.budget,
    }),
    startPaused: options.card
      ? Boolean(options.card.querySelector("[data-suggestion-paused]")?.checked)
      : true,
    productId: String(product.id),
    productIds: [String(product.id)],
    destinationUrl: suggestion.destinationUrl,
    original: null,
  };
}

function editorModalHtml() {
  const state = editorState;
  const ctaOptions = editorCtaOptions();
  const existing = state.campaignId && String(state.status).toUpperCase() !== "DRAFT";
  return `<div class="ads-editor-modal" id="adsEditorModal" role="dialog" aria-modal="true" aria-labelledby="adsEditorTitle">
    <div class="ads-editor-dialog">
      <header class="ads-editor-header">
        <div>
          <h3 id="adsEditorTitle">👁️ ${escapeHTML(adsT("adsEditorTitle"))}</h3>
          <p>${escapeHTML(adsT("adsEditorSubtitle"))}</p>
        </div>
        <button type="button" class="ads-editor-close" data-editor-close aria-label="${escapeHTML(
          adsT("adsEditorClose")
        )}">✕</button>
      </header>
      <div class="ads-editor-grid">
        <div class="ads-editor-form">
          <h4>${escapeHTML(adsT("adsEditorTexts"))}</h4>
          <label>${escapeHTML(adsT("adsEditorCampaignName"))}
            <input type="text" data-editor-name maxlength="120" value="${escapeHTML(
              state.campaignName
            )}">
          </label>
          <label>${escapeHTML(adsT("adsEditorChannel"))}
            <select data-editor-platform>
              <option value="meta" ${state.platform === "meta" ? "selected" : ""}>${escapeHTML(
                adsT("adsChannelMeta")
              )}</option>
              <option value="tiktok" ${
                state.platform === "tiktok" ? "selected" : ""
              }>${escapeHTML(adsT("adsChannelTiktok"))}</option>
              <option value="both" ${state.platform === "both" ? "selected" : ""}>${escapeHTML(
                adsT("adsChannelBoth")
              )}</option>
            </select>
          </label>
          ${["fr", "en", "ar"]
            .map(
              (lang) => `<label>${escapeHTML(adsT("adsEditorMainCopy"))} ${lang.toUpperCase()}
                <textarea data-editor-copy="${lang}" rows="3" dir="${
                lang === "ar" ? "rtl" : "ltr"
              }">${escapeHTML(state.adCopy[lang] || CAROUSEL_DEFAULT_COPY[lang])}</textarea>
              </label>`
            )
            .join("")}
          <div class="ads-editor-quick">
            <button type="button" class="admin-btn-secondary" data-insert-text="cash">🇲🇦 ${escapeHTML(
              adsT("adsEditorQuickCash")
            )}</button>
            <button type="button" class="admin-btn-secondary" data-insert-text="delivery">🚚 ${escapeHTML(
              adsT("adsEditorQuickDelivery")
            )}</button>
            <button type="button" class="admin-btn-secondary" data-insert-text="warranty">🛡️ ${escapeHTML(
              adsT("adsEditorQuickWarranty")
            )}</button>
          </div>
          <label>${escapeHTML(adsT("adsEditorHeadline"))}
            <input type="text" data-editor-headline maxlength="120" value="${escapeHTML(
              state.headline
            )}">
          </label>
          <label>${escapeHTML(adsT("adsEditorDescription"))}
            <textarea data-editor-description rows="2" maxlength="300">${escapeHTML(
              state.description
            )}</textarea>
          </label>
          <label>${escapeHTML(adsT("adsEditorCta"))}
            <select data-editor-cta>
              ${ctaOptions
                .map(
                  (option) =>
                    `<option value="${escapeHTML(option.label)}" ${
                      state.ctaLabel === option.label ? "selected" : ""
                    }>${escapeHTML(option.label)}</option>`
                )
                .join("")}
            </select>
          </label>
          <div class="ads-editor-text-actions">
            <button type="button" class="admin-btn-secondary" data-editor-clear>🗑️ ${escapeHTML(
              adsT("adsEditorClearText")
            )}</button>
            <button type="button" class="admin-btn-secondary" data-editor-reset>✨ ${escapeHTML(
              adsT("adsEditorResetAi")
            )}</button>
          </div>
          <h4>${escapeHTML(adsT("adsEditorMedia"))}</h4>
          <div class="ads-editor-media" data-editor-media></div>
          <div class="ads-editor-media-tools">
            <button type="button" class="admin-btn-secondary" data-media-add="image">➕ ${escapeHTML(
              adsT("adsEditorAddPhoto")
            )}</button>
            <button type="button" class="admin-btn-secondary" data-media-add="video">🎬 ${escapeHTML(
              adsT("adsEditorAddVideo")
            )}</button>
          </div>
          <div class="ads-editor-url-row">
            <input type="url" data-media-url placeholder="${escapeHTML(
              adsT("adsEditorImageUrl")
            )}">
            <button type="button" class="admin-btn-secondary" data-media-url-add>${escapeHTML(
              adsT("adsEditorAddUrl")
            )}</button>
          </div>
          <div class="ads-editor-product-gallery" data-editor-product-gallery></div>
          <input type="file" accept="image/jpeg,image/png,image/webp" data-media-file="image" hidden>
          <input type="file" accept="video/mp4,video/webm,video/quicktime" data-media-file="video" hidden>
          <progress data-media-progress max="100" value="0" hidden></progress>
          <div data-editor-card-list></div>
          <h4>${escapeHTML(adsT("adsEditorBudget"))}</h4>
          ${budgetEditorHtml(state.budget)}
          <label class="ads-check">
            <input type="checkbox" data-editor-paused ${
              state.startPaused ? "checked" : ""
            }>
            ${escapeHTML(adsT("adsEditorPaused"))}
          </label>
        </div>
        <div class="ads-editor-preview">
          <div class="ads-preview-tabs">
            <button type="button" class="is-active" data-preview-tab="facebook">Facebook</button>
            <button type="button" data-preview-tab="instagram">Instagram</button>
            <button type="button" data-preview-tab="tiktok">TikTok</button>
          </div>
          <div class="ads-phone" data-editor-preview></div>
        </div>
      </div>
      <footer class="ads-editor-footer">
        <span class="ads-status" data-editor-status role="status" aria-live="polite"></span>
        <button type="button" class="admin-btn-secondary" data-editor-save>💾 ${escapeHTML(
          adsT("adsEditorSaveDraft")
        )}</button>
        <button type="button" class="admin-btn-primary" data-editor-launch>${
          existing
            ? "💾 " + escapeHTML(adsT("adsEditorSaveChanges"))
            : "🚀 " + escapeHTML(adsT("adsEditorConfirmLaunch"))
        }</button>
      </footer>
    </div>
  </div>`;
}

function openCreativeEditor(options) {
  const state = editorInitialState(options || {});
  if (!state) return;
  state.original = JSON.parse(JSON.stringify({ ...state, original: null }));
  editorState = state;
  editorPreviewTab = "facebook";
  editorReplaceIndex = -1;
  document.getElementById("adsEditorModal")?.remove();
  document.body.insertAdjacentHTML("beforeend", editorModalHtml());
  bindEditorEvents();
  renderEditorMedia();
  renderEditorCards();
  renderEditorPreview();
  updateBudgetEditor(document.querySelector("#adsEditorModal [data-budget-editor]"));
}

function absoluteMediaUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https:\/\//i.test(value)) return value;
  return `https://www.smartswika.ma${value.startsWith("/") ? "" : "/"}${value}`;
}

function mediaForServer(list) {
  return (Array.isArray(list) ? list : []).map((item) => ({
    ...item,
    url: absoluteMediaUrl(item.url),
    posterUrl: absoluteMediaUrl(item.posterUrl),
  }));
}

function editorMediaPreview(media) {
  if (!media) return `<div class="ads-editor-media-empty">${escapeHTML(adsT("adsEditorNoMedia"))}</div>`;
  if (media.type === "video") {
    return `<video src="${escapeHTML(media.url)}" controls muted loop playsinline poster="${escapeHTML(
      media.posterUrl || ""
    )}"></video>`;
  }
  return `<img src="${escapeHTML(media.url)}" alt="" loading="lazy">`;
}

function renderEditorMedia() {
  const container = document.querySelector("#adsEditorModal [data-editor-media]");
  if (!container || !editorState) return;
  container.innerHTML = editorState.media.length
    ? editorState.media
        .map(
          (media, index) => `<div class="ads-editor-media-item${
            index === 0 ? " is-primary" : ""
          }">
            <div class="ads-editor-thumb">${editorMediaPreview(media)}</div>
            <span class="ads-media-kind">${
              media.type === "video" ? "🎬 " + escapeHTML(adsT("adsEditorVideo")) : "🖼️ " + escapeHTML(adsT("adsEditorImage"))
            }</span>
            ${index === 0 ? `<span class="ads-media-primary">⭐ ${escapeHTML(adsT("adsEditorPrimary"))}</span>` : ""}
            <div class="ads-editor-media-actions">
              <button type="button" data-media-action="primary" data-media-index="${index}">⭐</button>
              <button type="button" data-media-action="replace" data-media-index="${index}">🔄 ${escapeHTML(
                adsT("adsEditorReplace")
              )}</button>
              <button type="button" data-media-action="delete" data-media-index="${index}">🗑️</button>
            </div>
          </div>`
        )
        .join("")
    : `<div class="ads-editor-media-empty">${escapeHTML(adsT("adsEditorNoMedia"))}</div>`;

  const gallery = document.querySelector("#adsEditorModal [data-editor-product-gallery]");
  if (gallery) {
    const urls = new Set();
    (editorState.productIds || []).forEach((id) => {
      const product = cachedProducts.find((item) => String(item.id) === String(id));
      if (!product) return;
      [product.img, ...(Array.isArray(product.gallery) ? product.gallery : [])]
        .filter(Boolean)
        .forEach((url) => urls.add(url));
    });
    gallery.innerHTML = urls.size
      ? [...urls]
          .map(
            (url) =>
              `<button type="button" data-gallery-url="${escapeHTML(url)}"><img src="${escapeHTML(
                url
              )}" alt=""></button>`
          )
          .join("")
      : "";
  }
}

function renderEditorCards() {
  const container = document.querySelector("#adsEditorModal [data-editor-card-list]");
  if (!container || !editorState) return;
  if (editorState.kind !== "carousel") {
    container.innerHTML = "";
    return;
  }
  const cards = editorState.carouselCards || [];
  container.innerHTML = `<h4>${escapeHTML(adsT("adsEditorCarouselCards"))}</h4>
    <div class="ads-editor-cards">${
      cards.length
        ? cards
            .map(
              (card, index) => `<div class="ads-editor-card" data-editor-card="${index}">
                <div class="ads-editor-thumb">${editorMediaPreview({
                  type: card.mediaType === "video" ? "video" : "image",
                  url: card.mediaUrl || card.imageUrl,
                  posterUrl: card.posterUrl,
                })}</div>
                <label>${escapeHTML(adsT("adsEditorCardTitle"))}
                  <input type="text" data-card-field="title" data-card-index="${index}" value="${escapeHTML(
                    card.title || ""
                  )}">
                </label>
                <label>${escapeHTML(adsT("adsEditorCardPrice"))}
                  <input type="text" data-card-field="priceMad" data-card-index="${index}" value="${escapeHTML(
                    card.priceMad || ""
                  )}">
                </label>
                <label>${escapeHTML(adsT("adsEditorCardText"))}
                  <textarea rows="2" data-card-field="text" data-card-index="${index}">${escapeHTML(
                    card.text || ""
                  )}</textarea>
                </label>
                <label>${escapeHTML(adsT("adsEditorImageUrl"))}
                  <input type="url" data-card-field="mediaUrl" data-card-index="${index}" value="${escapeHTML(
                    card.mediaUrl || card.imageUrl || ""
                  )}">
                </label>
                <div class="ads-editor-card-actions">
                  <button type="button" data-card-replace="${index}">🔄 ${escapeHTML(
                    adsT("adsEditorReplace")
                  )}</button>
                  <button type="button" data-card-primary="${index}">⭐ ${escapeHTML(
                    adsT("adsEditorSetPrimary")
                  )}</button>
                  <button type="button" data-card-remove="${index}">🗑️ ${escapeHTML(
                    adsT("adsEditorRemoveCard")
                  )}</button>
                </div>
              </div>`
            )
            .join("")
        : `<div class="ads-editor-media-empty">${escapeHTML(adsT("adsEditorNoCards"))}</div>`
    }</div>`;
}

function editorPreviewCards() {
  return (editorState.carouselCards || []).length
    ? `<div class="ads-preview-carousel">${editorState.carouselCards
        .map(
          (card) => `<div class="ads-preview-card">
            <div class="ads-preview-card-media">${
              card.mediaType === "video"
                ? `<video src="${escapeHTML(card.mediaUrl || "")}" muted playsinline poster="${escapeHTML(
                    card.posterUrl || ""
                  )}"></video>`
                : `<img src="${escapeHTML(card.mediaUrl || card.imageUrl || "")}" alt="" loading="lazy">`
            }</div>
            <strong>${escapeHTML(card.title || "")}</strong>
            <span>${escapeHTML(card.priceMad || "")}</span>
            ${card.text ? `<small>${escapeHTML(card.text)}</small>` : ""}
          </div>`
        )
        .join("")}</div>`
    : editorMediaPreview((editorState.media || [])[0]);
}

function editorIsArabic(text) {
  return /[\u0600-\u06FF]/.test(String(text || ""));
}

function editorPriceLabel(state) {
  const source = state || editorState;
  if (!source) return "";
  if (source.kind === "carousel") {
    const first = (source.carouselCards || [])[0];
    if (first && first.priceMad) {
      return String(first.priceMad).replace(/[\u2066-\u2069]/g, "").trim();
    }
  }
  const product = cachedProducts.find(
    (item) => String(item.id) === String(source.productId)
  );
  const value = product ? Number(product.price) : NaN;
  return Number.isFinite(value) && value > 0 ? money(value) : "";
}

function renderEditorPreview() {
  if (!editorState) return;
  const container = document.querySelector("#adsEditorModal [data-editor-preview]");
  if (!container) return;
  const lang = getAdminLang();
  const copy = editorState.adCopy[lang] || editorState.adCopy.fr || "";
  const media = (editorState.media || [])[0];
  const hasVideo = media && media.type === "video";
  const mediaHtml = hasVideo
    ? `<video class="ads-preview-video" src="${escapeHTML(
        media.url
      )}" controls muted loop playsinline poster="${escapeHTML(media.posterUrl || "")}"></video>`
    : "";
  const cardsHtml = editorState.kind === "carousel" ? editorPreviewCards() : "";
  const imageHtml =
    !hasVideo && editorState.kind !== "carousel"
      ? `<div class="ads-preview-image">${editorMediaPreview(media)}</div>`
      : "";
  const cta = editorState.ctaLabel || adsT("adsEditorCtaOrder");
  const headline = editorState.headline || "";
  const price = editorPriceLabel();
  /* RTL automatique des que l accroche contient de l arabe. */
  const copyDir = editorIsArabic(copy) ? ' dir="rtl"' : "";
  const avatar = "/assets/favicon-32.png";
  const priceHtml = price ? `<p class="ads-preview-price">${escapeHTML(price)}</p>` : "";

  if (editorPreviewTab === "instagram") {
    const mediaBlock = cardsHtml || mediaHtml || imageHtml;
    container.innerHTML = `<div class="ads-phone-instagram">
      <div class="ads-preview-top"><span class="ads-preview-avatar"><img src="${avatar}" alt=""></span><div><strong>@smartswi9a</strong><small>${escapeHTML(
        adsT("adsEditorSponsored")
      )}</small></div><span class="ads-preview-more">•••</span></div>
      <div class="ads-preview-media ads-preview-media--square">${mediaBlock}</div>
      <div class="ads-preview-ig-actions"><span>${escapeHTML(cta)} ›</span></div>
      <div class="ads-preview-body ads-preview-body--ig"${copyDir}>
        <p class="ads-preview-copy">${escapeHTML(copy)}</p>
        <strong class="ads-preview-account">@smartswi9a</strong>
        ${priceHtml}
      </div>
    </div>`;
    return;
  }

  if (editorPreviewTab === "tiktok") {
    /* Bloc sombre statique : @smartswi9a n est plus jamais pose sur la photo blanche. */
    const mediaBlock = hasVideo ? mediaHtml : cardsHtml || imageHtml;
    container.innerHTML = `<div class="ads-phone-tiktok">
      <div class="ads-preview-tiktok-media">${mediaBlock}</div>
      <div class="ads-preview-tiktok-info"${copyDir}>
        <div class="ads-preview-tiktok-account"><strong>@smartswi9a</strong><span class="ads-preview-badge">${escapeHTML(
          adsT("adsEditorSponsored")
        )}</span></div>
        <p class="ads-preview-tiktok-copy">${escapeHTML(copy)}</p>
        <div class="ads-preview-tiktok-product"><strong>${escapeHTML(headline)}</strong>${
      price ? `<span>${escapeHTML(price)}</span>` : ""
    }</div>
        <button type="button" class="ads-preview-cta">${escapeHTML(cta)}</button>
      </div>
    </div>`;
    return;
  }

  container.innerHTML = `<div class="ads-phone-facebook">
    <div class="ads-preview-top"><span class="ads-preview-avatar"><img src="${avatar}" alt=""></span><div><strong>Smartswi9a</strong><small>${escapeHTML(
      adsT("adsEditorSponsored")
    )} · 🌍</small></div><span class="ads-preview-more">•••</span></div>
    <div class="ads-preview-body"${copyDir}><p class="ads-preview-copy">${escapeHTML(copy)}</p></div>
    <div class="ads-preview-media ads-preview-media--square">${mediaHtml || cardsHtml || imageHtml}</div>
    <div class="ads-preview-link">
      <div>
        <small class="ads-preview-domain">SMARTSWIKA.MA</small>
        <strong class="ads-preview-title">${escapeHTML(headline)}</strong>
        ${priceHtml}
      </div>
      <button type="button" class="ads-preview-cta">${escapeHTML(cta)}</button>
    </div>
  </div>`;
}

function editorSafeName(name) {
  return String(name || "media")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 40) || "media";
}

function compressEditorImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      const max = 1400;
      const scale = Math.min(1, max / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("webp_failed"))),
        "image/webp",
        0.82
      );
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("image_decode_failed"));
    };
    image.src = objectUrl;
  });
}

function captureEditorVideoPoster(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = objectUrl;
    const cleanup = () => URL.revokeObjectURL(objectUrl);
    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(0.2, Number(video.duration) || 0.2);
      } catch (e) {
        cleanup();
        resolve(null);
      }
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 720;
        canvas.height = video.videoHeight || 1280;
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          cleanup();
          resolve(blob);
        }, "image/webp", 0.8);
      } catch (e) {
        cleanup();
        resolve(null);
      }
    };
    video.onerror = () => {
      cleanup();
      resolve(null);
    };
  });
}

function uploadEditorBlob(blob, path, contentType, progressEl) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(storageRef(storage, path), blob, {
      contentType,
    });
    if (progressEl) progressEl.hidden = false;
    task.on(
      "state_changed",
      (snapshot) => {
        if (progressEl) {
          progressEl.value = snapshot.totalBytes
            ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
            : 0;
        }
      },
      reject,
      async () => {
        try {
          resolve(await getDownloadURL(task.snapshot.ref));
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}

async function uploadEditorFile(file, type, replaceIndex) {
  if (!file || !editorState) return;
  const status = document.querySelector("#adsEditorModal [data-editor-status]");
  const progress = document.querySelector("#adsEditorModal [data-media-progress]");
  const setStatus = (message, error) => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-error", Boolean(error));
  };
  try {
    if (type === "image" && file.size > 10 * 1024 * 1024) {
      setStatus(adsT("adsEditorImageTooLarge"), true);
      return;
    }
    if (type === "video" && file.size > 100 * 1024 * 1024) {
      setStatus(adsT("adsEditorVideoTooLarge"), true);
      return;
    }
    setStatus(adsT("adsEditorUploading"), false);
    let url = "";
    let posterUrl = "";
    if (type === "video") {
      const poster = await captureEditorVideoPoster(file);
      const extension = (file.name.split(".").pop() || "mp4").toLowerCase();
      const path = `ads_creatives/videos/${Date.now()}_${editorSafeName(file.name)}.${extension}`;
      url = await uploadEditorBlob(file, path, file.type || "video/mp4", progress);
      if (poster) {
        posterUrl = await uploadEditorBlob(
          poster,
          `ads_creatives/videos/${Date.now()}_${editorSafeName(file.name)}_poster.webp`,
          "image/webp",
          null
        );
      }
    } else {
      const webp = await compressEditorImage(file);
      url = await uploadEditorBlob(
        webp,
        `ads_creatives/${Date.now()}_${editorSafeName(file.name)}.webp`,
        "image/webp",
        progress
      );
    }
    const media = { type, url, posterUrl };
    if (replaceIndex >= 0 && editorState.media[replaceIndex]) {
      if (
        editorReplaceCardIndex >= 0 &&
        editorState.carouselCards[editorReplaceCardIndex]
      ) {
        const card = editorState.carouselCards[editorReplaceCardIndex];
        card.mediaType = type;
        card.mediaUrl = url;
        card.posterUrl = posterUrl;
        card.imageUrl = type === "image" ? url : card.imageUrl;
      } else {
        editorState.media[replaceIndex] = media;
      }
    } else if (editorReplaceCardIndex >= 0 && editorState.carouselCards[editorReplaceCardIndex]) {
      const card = editorState.carouselCards[editorReplaceCardIndex];
      card.mediaType = type;
      card.mediaUrl = url;
      card.posterUrl = posterUrl;
      card.imageUrl = type === "image" ? url : card.imageUrl;
    } else {
      editorState.media.push(media);
    }
    editorReplaceIndex = -1;
    editorReplaceCardIndex = -1;
    if (progress) progress.hidden = true;
    setStatus(adsT("adsEditorUploadDone"), false);
    renderEditorMedia();
    renderEditorCards();
    renderEditorPreview();
  } catch (error) {
    if (progress) progress.hidden = true;
    setStatus(`${adsT("adsEditorUploadError")} ${String((error && error.message) || "").slice(0, 120)}`, true);
  }
}

function editorBudgetValues() {
  const root = document.querySelector("#adsEditorModal [data-budget-editor]");
  const values = readBudgetEditor(root);
  editorState.budget = values;
  return values;
}

function editorPayload() {
  const budget = budgetPayload(editorBudgetValues());
  const media = editorState.media || [];
  return {
    type: editorState.kind === "carousel" ? "carousel" : "suggestion",
    platform: editorState.platform,
    productId: editorState.productId,
    productIds:
      editorState.kind === "carousel"
        ? (editorState.carouselCards || []).map((card) => card.productId)
        : editorState.productIds,
    productTitle:
      editorState.kind === "carousel"
        ? `${(editorState.carouselCards || []).length} produits Smartswika`
        : editorState.headline,
    destinationUrl: editorState.destinationUrl || "",
    campaignName: editorState.campaignName,
    adCopy: editorState.adCopy,
    headline: editorState.headline,
    description: editorState.description,
    ctaLabel: editorState.ctaLabel,
    customMedia: mediaForServer(media),
    customImages: mediaForServer(media)
      .filter((item) => item.type === "image")
      .map((item) => item.url),
    carouselCards: (editorState.carouselCards || []).map((card) => ({
      ...card,
      imageUrl: absoluteMediaUrl(card.imageUrl),
      mediaUrl: absoluteMediaUrl(card.mediaUrl || card.imageUrl),
      posterUrl: absoluteMediaUrl(card.posterUrl),
    })),
    startPaused: editorState.startPaused,
    ...budget,
  };
}

function setEditorStatus(message, isError) {
  const status = document.querySelector("#adsEditorModal [data-editor-status]");
  if (!status) return;
  status.textContent = message || "";
  status.classList.toggle("is-error", Boolean(isError));
}

async function saveEditorDraft() {
  if (!editorState) return;
  const button = document.querySelector("#adsEditorModal [data-editor-save]");
  if (button) button.disabled = true;
  setEditorStatus(adsT("adsEditorSaving"), false);
  try {
    const result = await callAdsFunction("updateAdCampaignSettings", {
      campaignDocId: editorState.campaignId || null,
      ...editorPayload(),
    });
    if (result.campaignDocId) editorState.campaignId = result.campaignDocId;
    if (result.status) editorState.status = result.status;
    setEditorStatus(adsT("adsEditorDraftSaved"), false);
    await loadCampaigns();
    renderCampaigns();
  } catch (error) {
    setEditorStatus(`${adsT("adsEditorSaveError")} ${String((error && error.message) || "").slice(0, 160)}`, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveEditorChanges() {
  if (!editorState || !editorState.campaignId) return;
  const button = document.querySelector("#adsEditorModal [data-editor-launch]");
  if (button) button.disabled = true;
  setEditorStatus(adsT("adsEditorSaving"), false);
  try {
    await callAdsFunction("updateAdCampaignSettings", {
      campaignDocId: editorState.campaignId,
      ...editorPayload(),
    });
    setEditorStatus(adsT("adsEditorSaved"), false);
    await loadCampaigns();
    renderCampaigns();
    setTimeout(closeCreativeEditor, 500);
  } catch (error) {
    setEditorStatus(`${adsT("adsEditorSaveError")} ${String((error && error.message) || "").slice(0, 160)}`, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function closeCreativeEditor() {
  document.getElementById("adsEditorModal")?.remove();
  editorState = null;
  editorReplaceIndex = -1;
  editorReplaceCardIndex = -1;
}

async function launchEditorCampaign() {
  if (!editorState) return;
  const button = document.querySelector("#adsEditorModal [data-editor-launch]");
  if (button) button.disabled = true;
  const payload = editorPayload();
  setEditorStatus(adsT("adsEditorLaunching"), false);
  try {
    if (editorState.kind === "carousel") {
      if ((editorState.carouselCards || []).length < CAROUSEL_MIN_PRODUCTS) {
        throw new Error(adsT("adsCarouselMinError"));
      }
      const productIds = editorState.carouselCards.map((card) => card.productId);
      const result = await callAdsFunction("launchMultiProductCarouselCampaign", {
        platform: editorState.platform,
        productIds,
        campaignName: editorState.campaignName,
        adCopy: editorState.adCopy,
        headline: editorState.headline,
        description: editorState.description,
        ctaLabel: editorState.ctaLabel,
        customMedia: payload.customMedia,
        carouselCards: payload.carouselCards,
        startPaused: editorState.startPaused,
        language: getAdminLang(),
        ...budgetPayload(editorBudgetValues()),
      });
      setEditorStatus(
        result.mode === "prepared" ? adsT("adsCarouselPrepared") : adsT("adsEditorLaunched"),
        false
      );
    } else {
      const result = await callAdsFunction("launchSuggestedAdCampaign", {
        platform: editorState.platform,
        productId: editorState.productId,
        campaignName: editorState.campaignName,
        adCopy: editorState.adCopy,
        headline: editorState.headline,
        description: editorState.description,
        ctaLabel: editorState.ctaLabel,
        customMedia: payload.customMedia,
        destinationUrl: editorState.destinationUrl,
        startPaused: editorState.startPaused,
        language: getAdminLang(),
        ...budgetPayload(editorBudgetValues()),
      });
      setEditorStatus(
        result.mode === "prepared" ? adsT("adsPreparedMode") : adsT("adsEditorLaunched"),
        false
      );
    }
    await loadCampaigns();
    renderCampaigns();
    setTimeout(closeCreativeEditor, 900);
  } catch (error) {
    setEditorStatus(`${adsT("adsEditorLaunchError")} ${String((error && error.message) || "").slice(0, 180)}`, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function bindEditorEvents() {
  const modal = document.getElementById("adsEditorModal");
  if (!modal || !editorState) return;
  const setCopy = (lang, value) => {
    editorState.adCopy[lang] = value;
    renderEditorPreview();
  };
  modal.addEventListener("click", async (event) => {
    if (event.target === modal) return closeCreativeEditor();
    if (event.target.closest("[data-editor-close]")) return closeCreativeEditor();
    const tab = event.target.closest("[data-preview-tab]");
    if (tab) {
      editorPreviewTab = tab.dataset.previewTab;
      modal.querySelectorAll("[data-preview-tab]").forEach((button) => {
        button.classList.toggle("is-active", button === tab);
      });
      renderEditorPreview();
      return;
    }
    if (event.target.closest("[data-editor-save]")) return saveEditorDraft();
    if (event.target.closest("[data-editor-launch]")) {
      if (editorState.campaignId && String(editorState.status).toUpperCase() !== "DRAFT") {
        return saveEditorChanges();
      }
      return launchEditorCampaign();
    }
    const insert = event.target.closest("[data-insert-text]");
    if (insert) {
      const key = insert.dataset.insertText;
      const label =
        key === "cash"
          ? adsT("adsEditorQuickCash")
          : key === "delivery"
          ? adsT("adsEditorQuickDelivery")
          : adsT("adsEditorQuickWarranty");
      const lang = getAdminLang();
      const current = editorState.adCopy[lang] || "";
      editorState.adCopy[lang] = current ? `${current}\n${label}` : label;
      const textarea = modal.querySelector(`[data-editor-copy="${lang}"]`);
      if (textarea) textarea.value = editorState.adCopy[lang];
      renderEditorPreview();
      return;
    }
    if (event.target.closest("[data-editor-clear]")) {
      editorState.description = "";
      const description = modal.querySelector("[data-editor-description]");
      if (description) description.value = "";
      renderEditorPreview();
      return;
    }
    if (event.target.closest("[data-editor-reset]")) {
      const original = editorState.original || {};
      editorState.adCopy = { ...CAROUSEL_DEFAULT_COPY, ...(original.adCopy || {}) };
      editorState.headline = original.headline || adsT("adsEditorDefaultHeadline");
      editorState.description = original.description || adsT("adsEditorDefaultDescription");
      modal.querySelectorAll("[data-editor-copy]").forEach((textarea) => {
        textarea.value = editorState.adCopy[textarea.dataset.editorCopy];
      });
      const headline = modal.querySelector("[data-editor-headline]");
      const description = modal.querySelector("[data-editor-description]");
      if (headline) headline.value = editorState.headline;
      if (description) description.value = editorState.description;
      renderEditorPreview();
      return;
    }
    const add = event.target.closest("[data-media-add]");
    if (add) {
      editorReplaceIndex = -1;
      editorReplaceCardIndex = -1;
      modal.querySelector(`[data-media-file="${add.dataset.mediaAdd}"]`)?.click();
      return;
    }
    if (event.target.closest("[data-media-url-add]")) {
      const input = modal.querySelector("[data-media-url]");
      const url = String(input?.value || "").trim();
      if (!/^https:\/\//i.test(url)) {
        setEditorStatus(adsT("adsEditorUrlError"), true);
        return;
      }
      const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(url);
      editorState.media.push({ type: isVideo ? "video" : "image", url, posterUrl: "" });
      if (input) input.value = "";
      renderEditorMedia();
      renderEditorPreview();
      return;
    }
    const gallery = event.target.closest("[data-gallery-url]");
    if (gallery) {
      editorState.media.push({
        type: "image",
        url: gallery.dataset.galleryUrl,
        posterUrl: "",
      });
      renderEditorMedia();
      renderEditorPreview();
      return;
    }

    const mediaAction = event.target.closest("[data-media-action]");
    if (mediaAction) {
      const index = Number(mediaAction.dataset.mediaIndex);
      const action = mediaAction.dataset.mediaAction;
      if (action === "primary" && editorState.media[index]) {
        const [item] = editorState.media.splice(index, 1);
        editorState.media.unshift(item);
      } else if (action === "delete") {
        editorState.media.splice(index, 1);
      } else if (action === "replace" && editorState.media[index]) {
        editorReplaceIndex = index;
        editorReplaceCardIndex = -1;
        modal
          .querySelector(
            `[data-media-file="${editorState.media[index].type === "video" ? "video" : "image"}"]`
          )
          ?.click();
        return;
      }
      renderEditorMedia();
      renderEditorPreview();
      return;
    }
    const cardReplace = event.target.closest("[data-card-replace]");
    if (cardReplace) {
      editorReplaceCardIndex = Number(cardReplace.dataset.cardReplace);
      editorReplaceIndex = -1;
      const card = editorState.carouselCards[editorReplaceCardIndex];
      modal
        .querySelector(`[data-media-file="${card?.mediaType === "video" ? "video" : "image"}"]`)
        ?.click();
      return;
    }
    const cardPrimary = event.target.closest("[data-card-primary]");
    if (cardPrimary) {
      const index = Number(cardPrimary.dataset.cardPrimary);
      const [card] = editorState.carouselCards.splice(index, 1);
      editorState.carouselCards.unshift(card);
      renderEditorCards();
      renderEditorPreview();
      return;
    }
    const cardRemove = event.target.closest("[data-card-remove]");
    if (cardRemove) {
      const index = Number(cardRemove.dataset.cardRemove);
      const [removed] = editorState.carouselCards.splice(index, 1);
      if (removed) {
        editorState.productIds = (editorState.productIds || []).filter(
          (id) => String(id) !== String(removed.productId)
        );
      }
      renderEditorCards();
      renderEditorPreview();
    }
  });

  const bindInput = (selector, handler) => {
    modal.querySelectorAll(selector).forEach((input) => {
      input.addEventListener("input", () => handler(input, input.value));
      input.addEventListener("change", () => handler(input, input.value));
    });
  };
  bindInput("[data-editor-name]", (_, value) => (editorState.campaignName = value));
  bindInput("[data-editor-platform]", (_, value) => (editorState.platform = value));
  bindInput("[data-editor-copy]", (input, value) => setCopy(input.dataset.editorCopy, value));
  bindInput("[data-editor-headline]", (_, value) => (editorState.headline = value));
  bindInput("[data-editor-description]", (_, value) => (editorState.description = value));
  bindInput("[data-editor-cta]", (_, value) => (editorState.ctaLabel = value));
  bindInput("[data-editor-paused]", (input) => {
    editorState.startPaused = Boolean(input.checked);
  });
  bindInput("[data-card-field]", (input, value) => {
    const card = editorState.carouselCards[Number(input.dataset.cardIndex)];
    if (!card) return;
    card[input.dataset.cardField] = value;
    if (input.dataset.cardField === "mediaUrl") {
      card.imageUrl = value;
      card.mediaType = /\.(mp4|webm|mov)(\?|$)/i.test(value) ? "video" : "image";
    }
    renderEditorPreview();
  });
  bindBudgetEditor(modal.querySelector("[data-budget-editor]"), (values) => {
    editorState.budget = values;
  });
  modal.querySelectorAll("[data-media-file]").forEach((input) => {
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      await uploadEditorFile(
        file,
        input.dataset.mediaFile === "video" ? "video" : "image",
        editorReplaceIndex
      );
      input.value = "";
    });
  });
}


function carouselDefaults() {
  return {
    selected: new Set(),
    campaignName: adsT("adsCarouselDefaultName"),
    nameTouched: false,
    budgetMode: "daily",
    dailyBudgetMad: 80,
    totalBudgetUsd: 20,
    currency: "MAD",
    durationDays: 5,
    usdMadRate: 10,
    channel: "both",
    startPaused: true,
    copies: { ...CAROUSEL_DEFAULT_COPY },
  };
}

function ensureCarouselDraft() {
  if (!carouselDraft) carouselDraft = carouselDefaults();
  if (!carouselDraft.selected) carouselDraft.selected = new Set();
  if (!carouselDraft.copies) carouselDraft.copies = { ...CAROUSEL_DEFAULT_COPY };
  return carouselDraft;
}

function captureCarouselDraft() {
  const card = document.querySelector("[data-carousel-builder]");
  if (!card || !card.querySelector("[data-carousel-check]")) return;
  const draft = ensureCarouselDraft();
  const selected = new Set(
    [...card.querySelectorAll("[data-carousel-check]:checked")].map(
      (input) => input.dataset.carouselCheck
    )
  );
  draft.selected = selected;
  const name = card.querySelector("[data-carousel-name]");
  const budget = card.querySelector("[data-budget-editor]");
  const channel = card.querySelector("[data-carousel-channel]");
  const paused = card.querySelector("[data-carousel-paused]");
  if (name) draft.campaignName = name.value;
  if (budget) {
    const values = readBudgetEditor(budget);
    draft.budgetMode = values.mode;
    draft.dailyBudgetMad = values.daily;
    draft.totalBudgetUsd = values.total;
    draft.currency = values.currency;
    draft.durationDays = values.days;
    draft.usdMadRate = values.rate;
  }
  if (channel) draft.channel = channel.value;
  if (paused) draft.startPaused = Boolean(paused.checked);
  card.querySelectorAll("[data-carousel-copy]").forEach((textarea) => {
    const lang = textarea.dataset.carouselCopy;
    if (lang) draft.copies[lang] = textarea.value;
  });
}

function carouselSelectedProducts() {
  const draft = ensureCarouselDraft();
  const livoFee = averageLivoFee();
  const available = new Map(
    officialProducts().map((product) => [String(product.id), product])
  );
  const ids = draft.selected instanceof Set ? [...draft.selected] : [];
  return ids
    .map((id) => available.get(String(id)))
    .filter(Boolean)
    .map((product) => buildSuggestion(product, livoFee));
}

function topCarouselProducts() {
  const livoFee = averageLivoFee();
  return officialProducts()
    .map((product) => buildSuggestion(product, livoFee))
    .sort((a, b) => b.score - a.score || b.margin - a.margin);
}

function carouselCampaignUrl(productId, source, campaignName) {
  const safeId = String(productId).replace(/[^A-Za-z0-9_-]/g, "");
  const slug = slugifyCampaign(campaignName) || "smartswika-selection";
  const safeSource = source === "meta" ? "meta" : "tiktok";
  return `https://www.smartswika.ma/produit.html?id=${encodeURIComponent(
    safeId
  )}&utm_source=${safeSource}&utm_medium=paid_social&utm_campaign=carousel_${encodeURIComponent(
    slug
  )}&utm_content=${encodeURIComponent(safeId)}`;
}

function carouselPreviewHtml(scoredProducts) {
  const draft = ensureCarouselDraft();
  const selected = scoredProducts.filter((item) =>
    draft.selected.has(String(item.product.id))
  );
  if (!selected.length) {
    return `<div class="ads-carousel-empty">${escapeHTML(
      adsT("adsCarouselPreviewEmpty")
    )}</div>`;
  }
  return selected
    .map((item) => {
      const product = item.product;
      const source = draft.channel === "meta" ? "meta" : "tiktok";
      const url = carouselCampaignUrl(product.id, source, draft.campaignName);
      return `<a class="ads-carousel-card" href="${escapeHTML(
        url
      )}" target="_blank" rel="noopener" title="${escapeHTML(url)}">
        <img src="${escapeHTML(
          product.img || (product.gallery || [])[0] || "/assets/logo-64.png"
        )}" alt="" width="120" height="120" loading="lazy">
        <strong>${escapeHTML(productDisplayName(product) || "—")}</strong>
        <span>${money(Number(product.price) || 0)}</span>
      </a>`;
    })
    .join("");
}

function renderCarouselBuilder(scoredProducts) {
  if (scoredProducts.length < CAROUSEL_MIN_PRODUCTS) {
    return `<article class="ads-carousel-builder" data-carousel-builder>
      <div class="ads-guide">
        <span class="ads-guide-ico" aria-hidden="true">🎠</span>
        <h4>${escapeHTML(adsT("adsCarouselGuideTitle"))}</h4>
        <p>${escapeHTML(adsT("adsCarouselGuideDesc"))}</p>
        <button type="button" class="admin-btn-secondary" data-ads-goto-products>
          ${escapeHTML(adsT("adsSuggestionsGoProducts"))}
        </button>
      </div>
    </article>`;
  }
  const draft = ensureCarouselDraft();
  if (!draft.nameTouched) draft.campaignName = adsT("adsCarouselDefaultName");
  const availableIds = new Set(scoredProducts.map((item) => String(item.product.id)));
  draft.selected = new Set(
    [...draft.selected].filter((id) => availableIds.has(String(id)))
  );
  const selectedCount = draft.selected.size;
  const counter = adsT("adsCarouselCount").replace("{count}", String(selectedCount));
  const chips = scoredProducts
    .map((item) => {
      const product = item.product;
      const id = String(product.id);
      const checked = draft.selected.has(id);
      return `<label class="ads-carousel-chip${
        checked ? " is-selected" : ""
      }" data-carousel-chip="${escapeHTML(id)}">
        <input type="checkbox" data-carousel-check="${escapeHTML(id)}" ${
        checked ? "checked" : ""
      }>
        <img src="${escapeHTML(
          product.img || (product.gallery || [])[0] || "/assets/logo-64.png"
        )}" alt="" width="44" height="44" loading="lazy">
        <span class="ads-carousel-chip-name">${escapeHTML(
          productDisplayName(product) || "—"
        )}</span>
        <small>${item.score}/100 · ${money(Number(product.price) || 0)}</small>
      </label>`;
    })
    .join("");
  const copyField = (lang) => `<label>${escapeHTML(
    adsT("adsCarouselCopyLabel")
  )} ${lang.toUpperCase()}
    <textarea data-carousel-copy="${lang}" rows="3" dir="${
    lang === "ar" ? "rtl" : "ltr"
  }">${escapeHTML(draft.copies[lang] || CAROUSEL_DEFAULT_COPY[lang])}</textarea>
  </label>`;
  return `<article class="ads-carousel-builder" data-carousel-builder>
    <div class="ads-carousel-head">
      <div>
        <h4>🎠 ${escapeHTML(adsT("adsCarouselTitle"))}</h4>
        <p>${escapeHTML(adsT("adsCarouselSubtitle"))}</p>
      </div>
      <span class="ads-carousel-counter" data-carousel-counter>${escapeHTML(counter)}</span>
    </div>
    <div class="ads-carousel-tools">
      <button type="button" class="admin-btn-secondary" data-carousel-top10>
        ✨ ${escapeHTML(adsT("adsCarouselAutoTop10"))}
      </button>
      <button type="button" class="admin-btn-secondary" data-carousel-clear>
        ${escapeHTML(adsT("adsCarouselClear"))}
      </button>
      <span class="ads-carousel-min" data-carousel-min>${
        selectedCount < CAROUSEL_MIN_PRODUCTS
          ? escapeHTML(adsT("adsCarouselMinRequired"))
          : ""
      }</span>
    </div>
    <div class="ads-carousel-products" role="group" aria-label="${escapeHTML(
      adsT("adsCarouselSelectProducts")
    )}">
      ${chips}
    </div>
    <div class="ads-carousel-fields">
      <label>${escapeHTML(adsT("adsCarouselCampaignName"))}
        <input type="text" data-carousel-name maxlength="120" value="${escapeHTML(
          draft.campaignName || adsT("adsCarouselDefaultName")
        )}">
      </label>
      <div class="ads-carousel-budget">${budgetEditorHtml({
        budgetMode: draft.budgetMode,
        dailyBudgetMad: draft.dailyBudgetMad,
        totalBudgetUsd: draft.totalBudgetUsd,
        currency: draft.currency,
        durationDays: draft.durationDays,
        usdMadRate: draft.usdMadRate,
      })}</div>
      <label>${escapeHTML(adsT("adsCarouselChannel"))}
        <select data-carousel-channel>
          <option value="meta" ${draft.channel === "meta" ? "selected" : ""}>${escapeHTML(
            adsT("adsChannelMeta")
          )}</option>
          <option value="tiktok" ${
            draft.channel === "tiktok" ? "selected" : ""
          }>${escapeHTML(adsT("adsChannelTiktok"))}</option>
          <option value="both" ${draft.channel === "both" ? "selected" : ""}>${escapeHTML(
            adsT("adsChannelBoth")
          )}</option>
        </select>
      </label>
      <label class="ads-check">
        <input type="checkbox" data-carousel-paused ${
          draft.startPaused ? "checked" : ""
        }>
        ${escapeHTML(adsT("adsCarouselPaused"))}
      </label>
    </div>
    <div class="ads-carousel-copies">
      ${["fr", "en", "ar"].map(copyField).join("")}
    </div>
    <div class="ads-carousel-preview-wrap">
      <h5>${escapeHTML(adsT("adsCarouselPreview"))}</h5>
      <div class="ads-carousel-preview" data-carousel-preview>${carouselPreviewHtml(
        scoredProducts
      )}</div>
      <p class="ads-hint">${escapeHTML(adsT("adsCarouselMetaHint"))}</p>
    </div>
    <div class="ads-suggestion-actions">
      <button type="button" class="admin-btn-primary" data-open-carousel-editor>
        👁️ ${escapeHTML(adsT("adsEditorButton"))}
      </button>
      <button type="button" class="admin-btn-secondary" data-carousel-launch ${
        selectedCount < CAROUSEL_MIN_PRODUCTS ? "disabled" : ""
      }>
        🚀 ${escapeHTML(adsT("adsCarouselLaunch"))}
      </button>
      <span class="ads-status" data-carousel-status role="status" aria-live="polite"></span>
    </div>
  </article>`;
}

function updateCarouselUi(card) {
  if (!card) return;
  const draft = ensureCarouselDraft();
  const checkboxes = [...card.querySelectorAll("[data-carousel-check]")];
  const available = new Set(checkboxes.map((input) => input.dataset.carouselCheck));
  draft.selected = new Set([...draft.selected].filter((id) => available.has(id)));
  checkboxes.forEach((input) => {
    const id = input.dataset.carouselCheck;
    input.checked = draft.selected.has(id);
    input.disabled =
      !draft.selected.has(id) && draft.selected.size >= CAROUSEL_MAX_PRODUCTS;
    input.closest("[data-carousel-chip]")?.classList.toggle(
      "is-selected",
      input.checked
    );
  });
  const count = draft.selected.size;
  const counter = card.querySelector("[data-carousel-counter]");
  if (counter) {
    counter.textContent = adsT("adsCarouselCount").replace("{count}", String(count));
    counter.classList.toggle("is-error", count < CAROUSEL_MIN_PRODUCTS);
  }
  const min = card.querySelector("[data-carousel-min]");
  if (min) {
    min.textContent =
      count < CAROUSEL_MIN_PRODUCTS ? adsT("adsCarouselMinRequired") : "";
  }
  const launch = card.querySelector("[data-carousel-launch]");
  if (launch) launch.disabled = count < CAROUSEL_MIN_PRODUCTS;
  const preview = card.querySelector("[data-carousel-preview]");
  if (preview) preview.innerHTML = carouselPreviewHtml(topCarouselProducts());
}

function bindCarouselEvents(container) {
  const card = container.querySelector("[data-carousel-builder]");
  if (!card) return;
  card.querySelector("[data-ads-goto-products]")?.addEventListener("click", () => {
    document.querySelector('#adminTabs button[data-tab="products"]')?.click();
  });
  if (!card.querySelector("[data-carousel-check]")) return;
  const draft = ensureCarouselDraft();
  card.querySelectorAll("[data-carousel-check]").forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.dataset.carouselCheck;
      if (input.checked) {
        if (draft.selected.size >= CAROUSEL_MAX_PRODUCTS) {
          input.checked = false;
          return;
        }
        draft.selected.add(id);
      } else {
        draft.selected.delete(id);
      }
      updateCarouselUi(card);
    });
  });
  card.querySelector("[data-carousel-top10]")?.addEventListener("click", () => {
    draft.selected = new Set(
      topCarouselProducts()
        .slice(0, CAROUSEL_TOP_COUNT)
        .map((item) => String(item.product.id))
    );
    updateCarouselUi(card);
  });
  card.querySelector("[data-carousel-clear]")?.addEventListener("click", () => {
    draft.selected.clear();
    updateCarouselUi(card);
  });
  card.querySelector("[data-carousel-name]")?.addEventListener("input", (event) => {
    draft.campaignName = event.target.value;
    draft.nameTouched = true;
    updateCarouselUi(card);
  });
  bindBudgetEditor(card.querySelector("[data-budget-editor]"), (values) => {
    draft.budgetMode = values.mode;
    draft.dailyBudgetMad = values.daily;
    draft.totalBudgetUsd = values.total;
    draft.currency = values.currency;
    draft.durationDays = values.days;
    draft.usdMadRate = values.rate;
  });
  card.querySelector("[data-carousel-channel]")?.addEventListener("change", (event) => {
    draft.channel = event.target.value;
    updateCarouselUi(card);
  });
  card.querySelector("[data-carousel-paused]")?.addEventListener("change", (event) => {
    draft.startPaused = Boolean(event.target.checked);
  });
  card.querySelectorAll("[data-carousel-copy]").forEach((textarea) => {
    textarea.addEventListener("input", () => {
      draft.copies[textarea.dataset.carouselCopy] = textarea.value;
    });
  });
  card.querySelector("[data-carousel-launch]")?.addEventListener("click", () => {
    launchCarouselCampaign(card);
  });
  card.querySelector("[data-open-carousel-editor]")?.addEventListener("click", () => {
    openCreativeEditor({ kind: "carousel", card });
  });
  updateCarouselUi(card);
}

function setCarouselStatus(card, message, isError) {
  const status = card.querySelector("[data-carousel-status]");
  if (!status) return;
  status.textContent = message || "";
  status.classList.toggle("is-error", Boolean(isError));
}

async function launchCarouselCampaign(card) {
  if (launching) return;
  const draft = ensureCarouselDraft();
  const available = new Set(
    topCarouselProducts().map((item) => String(item.product.id))
  );
  const productIds = [...draft.selected].filter((id) => available.has(String(id)));
  if (productIds.length < CAROUSEL_MIN_PRODUCTS) {
    setCarouselStatus(card, adsT("adsCarouselMinError"), true);
    return;
  }
  if (productIds.length > CAROUSEL_MAX_PRODUCTS) {
    setCarouselStatus(card, adsT("adsCarouselMaxError"), true);
    return;
  }
  const campaignName =
    String(draft.campaignName || "").trim() || adsT("adsCarouselDefaultName");
  const budgetData = budgetPayload(
    readBudgetEditor(card.querySelector("[data-budget-editor]"))
  );
  const budget = budgetData.dailyBudgetMad;
  const channel = draft.channel || "both";
  const startPaused = draft.startPaused !== false;
  const adCopy = {
    fr: draft.copies.fr || CAROUSEL_DEFAULT_COPY.fr,
    en: draft.copies.en || CAROUSEL_DEFAULT_COPY.en,
    ar: draft.copies.ar || CAROUSEL_DEFAULT_COPY.ar,
  };
  const language = getAdminLang();
  const button = card.querySelector("[data-carousel-launch]");
  const needsMetaPage = channel !== "tiktok" && !adsSecrets.metaPageId;
  const willFallback = !platformIsConfigured(channel) || needsMetaPage;
  const popup = willFallback ? window.open("about:blank", "smartswika_ads_manager") : null;
  launching = true;
  if (button) button.disabled = true;
  setCarouselStatus(card, adsT("adsCarouselLaunching"), false);
  try {
    const result = await callAdsFunction("launchMultiProductCarouselCampaign", {
      platform: channel,
      productIds,
      campaignName,
      dailyBudgetMad: budget,
      adCopy,
      startPaused,
      language,
      ...budgetData,
    });
    if (result.mode === "prepared") {
      const copyPayload = `${adCopy[language] || adCopy.fr}\n${(
        result.productUrls || []
      ).join("\n")}`;
      await copyText(copyPayload);
      if (popup && result.adsManagerUrl) popup.location.href = result.adsManagerUrl;
      else if (result.adsManagerUrl) window.open(result.adsManagerUrl, "_blank", "noopener");
      setCarouselStatus(card, adsT("adsCarouselPrepared"), false);
    } else {
      if (popup) popup.close();
      setCarouselStatus(
        card,
        result.mode === "partial" ? adsT("adsLaunchedPartial") : adsT("adsCarouselLaunched"),
        false
      );
      await loadCampaigns();
      renderCampaigns();
    }
  } catch (error) {
    if (popup) popup.close();
    console.error("[admin-ads] carrousel impossible :", error);
    setCarouselStatus(
      card,
      `${adsT("adsCarouselError")} ${String((error && error.message) || "").slice(0, 180)}`,
      true
    );
  } finally {
    launching = false;
    if (button) button.disabled = draft.selected.size < CAROUSEL_MIN_PRODUCTS;
  }
}




function renderSuggestions() {
  const container = document.getElementById("adsSuggestions");
  if (!container) return;
  captureCarouselDraft();
  const livoFee = averageLivoFee();
  const scoredProducts = officialProducts()
    .map((product) => buildSuggestion(product, livoFee))
    .sort((a, b) => b.score - a.score || b.margin - a.margin);
  const suggestions = scoredProducts.slice(0, 5);
  const carouselHtml = renderCarouselBuilder(scoredProducts);

  if (!suggestions.length) {
    container.innerHTML = carouselHtml;
    bindCarouselEvents(container);
    return;
  }

  const lang = getAdminLang();
  container.innerHTML = carouselHtml + suggestions
    .map((suggestion) => {
      const product = suggestion.product;
      const name = productDisplayName(product) || "—";
      const image = product.img || (product.gallery || [])[0] || "/assets/logo-64.png";
      return `<article class="ads-suggestion" data-suggestion-product="${escapeHTML(
        String(product.id)
      )}">
        <div class="ads-suggestion-head">
          <div class="ads-suggestion-score">
            <strong>${suggestion.score}<small>/100</small></strong>
            <span class="ads-badge">${suggestion.badge.emoji} ${escapeHTML(
              adsT(suggestion.badge.key)
            )}</span>
          </div>
          <span class="ads-channel-pill">${escapeHTML(
            suggestionChannelLabel(suggestion.channel)
          )}</span>
        </div>
        <div class="ads-suggestion-product">
          <img src="${escapeHTML(image)}" alt="" width="56" height="56" loading="lazy">
          <div>
            <h4>${escapeHTML(name)}</h4>
            <div class="ads-suggestion-metrics">
              <span>${escapeHTML(adsT("adsMetricMargin"))} <strong>${money(
                suggestion.margin
              )}</strong></span>
              <span>${escapeHTML(adsT("adsMetricViews"))} <strong>${fmtNumber(
                suggestion.views
              )}</strong></span>
              <span>${escapeHTML(adsT("adsMetricCod"))} <strong>${fmtNumber(
                suggestion.orders.deliveryRate * 100,
                1
              )} %</strong></span>
            </div>
          </div>
        </div>
        <div class="ads-suggestion-controls">
          <label>${escapeHTML(adsT("adsSuggestionChannel"))}
            <select data-suggestion-channel>
              <option value="meta" ${suggestion.channel === "meta" ? "selected" : ""}>${escapeHTML(
                adsT("adsChannelMeta")
              )}</option>
              <option value="tiktok" ${
                suggestion.channel === "tiktok" ? "selected" : ""
              }>${escapeHTML(adsT("adsChannelTiktok"))}</option>
              <option value="both" ${suggestion.channel === "both" ? "selected" : ""}>${escapeHTML(
                adsT("adsChannelBoth")
              )}</option>
            </select>
          </label>
          <div class="ads-suggestion-budget">${budgetEditorHtml({
            dailyBudgetMad: suggestion.budget,
          })}</div>
          <label class="ads-check">
            <input type="checkbox" data-suggestion-paused checked>
            ${escapeHTML(adsT("adsSuggestionPaused"))}
          </label>
        </div>
        <label class="ads-copy-label">${escapeHTML(adsT("adsSuggestionCopy"))}
          <textarea data-suggestion-copy rows="4">${escapeHTML(
            suggestion.copy[lang] || suggestion.copy.fr
          )}</textarea>
        </label>
        <code class="ads-destination">${escapeHTML(suggestion.destinationUrl)}</code>
        <div class="ads-suggestion-actions">
          <button type="button" class="admin-btn-primary" data-open-editor="suggestion">
            👁️ ${escapeHTML(adsT("adsEditorButton"))}
          </button>
          <button type="button" class="admin-btn-secondary" data-launch-suggestion>
            🚀 ${escapeHTML(adsT("adsLaunchNow"))}
          </button>
          <span class="ads-status" data-suggestion-status role="status" aria-live="polite"></span>
        </div>
      </article>`;
    })
    .join("");

  container.querySelectorAll("[data-launch-suggestion]").forEach((button) => {
    button.addEventListener("click", () => {
      const card = button.closest("[data-suggestion-product]");
      if (card) launchSuggestedCampaign(card);
    });
  });
  container.querySelectorAll("[data-open-editor]").forEach((button) => {
    button.addEventListener("click", () => {
      const card = button.closest("[data-suggestion-product]");
      if (!card) return;
      openCreativeEditor({
        kind: button.dataset.openEditor,
        productId: card.dataset.suggestionProduct,
        card,
      });
    });
  });
  container.querySelectorAll("[data-budget-editor]").forEach((editor) => {
    if (editor.closest("[data-carousel-builder]")) return;
    bindBudgetEditor(editor);
  });
  bindCarouselEvents(container);
}

function setSuggestionStatus(card, message, isError) {
  const status = card.querySelector("[data-suggestion-status]");
  if (!status) return;
  status.textContent = message || "";
  status.classList.toggle("is-error", Boolean(isError));
}

async function launchSuggestedCampaign(card) {
  if (launching) return;
  const productId = card.dataset.suggestionProduct;
  const product = cachedProducts.find((item) => String(item.id) === String(productId));
  if (!product) return;
  const channel = card.querySelector("[data-suggestion-channel]")?.value || "meta";
  const budgetData = budgetPayload(
    readBudgetEditor(card.querySelector("[data-budget-editor]"))
  );
  const budget = budgetData.dailyBudgetMad;
  const startPaused = Boolean(card.querySelector("[data-suggestion-paused]")?.checked);
  const editedCopy = card.querySelector("[data-suggestion-copy]")?.value || "";
  const base = buildSuggestion(product, averageLivoFee());
  const lang = getAdminLang();
  base.copy[lang] = editedCopy;
  const destinationUrl = buildDestinationUrl(
    product.id,
    channel === "meta" ? "meta" : "tiktok"
  );
  const button = card.querySelector("[data-launch-suggestion]");
  const willFallback = !platformIsConfigured(channel);
  const popup = willFallback ? window.open("about:blank", "smartswika_ads_manager") : null;
  launching = true;
  if (button) button.disabled = true;
  setSuggestionStatus(card, adsT("adsLaunching"), false);
  try {
    const result = await callAdsFunction("launchSuggestedAdCampaign", {
      platform: channel,
      productId: product.id,
      campaignName: `Smartswika ${product.nameFr || product.id} ${channel}`.slice(0, 120),
      dailyBudgetMad: budget,
      adCopy: base.copy,
      destinationUrl,
      startPaused,
      ...budgetData,
    });
    if (result.mode === "prepared") {
      const copyPayload = `${editedCopy}\n${destinationUrl}`;
      await copyText(copyPayload);
      if (popup && result.adsManagerUrl) {
        popup.location.href = result.adsManagerUrl;
      } else if (result.adsManagerUrl) {
        window.open(result.adsManagerUrl, "_blank", "noopener");
      }
      setSuggestionStatus(card, adsT("adsPreparedMode"), false);
    } else {
      if (popup) popup.close();
      setSuggestionStatus(
        card,
        result.mode === "partial" ? adsT("adsLaunchedPartial") : adsT("adsLaunched"),
        false
      );
      await loadCampaigns();
      renderCampaigns();
    }
  } catch (error) {
    if (popup) popup.close();
    console.error("[admin-ads] lancement impossible :", error);
    setSuggestionStatus(
      card,
      `${adsT("adsLaunchError")} ${String((error && error.message) || "").slice(0, 160)}`,
      true
    );
  } finally {
    launching = false;
    if (button) button.disabled = false;
  }
}

function campaignOrders(campaign) {
  const productIds =
    Array.isArray(campaign.productIds) && campaign.productIds.length
      ? campaign.productIds.map(String)
      : campaign.productId
      ? [String(campaign.productId)]
      : [];
  const utmCampaign =
    String(campaign.utmCampaign || "").trim() ||
    (productIds.length === 1 ? `auto_${productIds[0]}` : "");
  const attributed = utmCampaign
    ? cachedAllOrders.filter(
        (order) =>
          String((order.attribution && order.attribution.campaign) || "") ===
          utmCampaign
      )
    : [];
  if (attributed.length) return attributed;
  const since = campaign.__date ? campaign.__date.getTime() : 0;
  return cachedAllOrders.filter((order) => {
    const items = Array.isArray(order.items) ? order.items : [];
    const matchesProduct = items.some(
      (item) => item && productIds.includes(String(item.productId))
    );
    if (!matchesProduct) return false;
    if (!since) return true;
    return order.__date && order.__date.getTime() >= since;
  });
}

function campaignStats(campaign) {
  const orders = campaignOrders(campaign);
  const delivered = orders.filter(isDelivered).length;
  const negative = orders.filter(isNegativeCodStatus).length;
  const total = orders.length;
  const closed = delivered + negative;
  const rate = closed > 0 ? (delivered / closed) * 100 : 0;
  const active = String(campaign.status || "").toUpperCase() === "ACTIVE";
  return {
    total,
    delivered,
    rate,
    alert: active && total > 10 && rate < 45,
  };
}

function campaignStatusLabel(status) {
  const value = String(status || "").toUpperCase();
  if (value === "DRAFT") return adsT("adsStatusDraft");
  return value === "ACTIVE" ? adsT("adsStatusActive") : adsT("adsStatusPaused");
}

function renderCampaigns() {
  const container = document.getElementById("adsCampaigns");
  if (!container) return;
  if (!cachedCampaigns.length) {
    container.innerHTML = `<div class="ads-guide">
      <span class="ads-guide-ico" aria-hidden="true">📡</span>
      <h4>${escapeHTML(adsT("adsCampaignsEmptyTitle"))}</h4>
      <p>${escapeHTML(adsT("adsCampaignsEmptyDesc"))}</p>
    </div>`;
    return;
  }

  container.innerHTML = cachedCampaigns
    .map((campaign) => {
      const stats = campaignStats(campaign);
      const statusUpper = String(campaign.status || "").toUpperCase();
      const active = statusUpper === "ACTIVE";
      const nextAction = active ? "PAUSED" : "ACTIVE";
      /* Suppression autorisee uniquement hors diffusion (DRAFT / PAUSED). */
      const canDelete = statusUpper === "DRAFT" || statusUpper === "PAUSED";
      const platformLabel =
        campaign.platform === "tiktok"
          ? adsT("adsChannelTiktok")
          : adsT("adsChannelMeta");
      const isCarousel = campaign.type === "carousel";
      const isDraft = statusUpper === "DRAFT";
      const carouselCount = Number(campaign.productCount) ||
        (Array.isArray(campaign.productIds) ? campaign.productIds.length : 0);
      const linkedProduct = cachedProducts.find(
        (product) => String(product.id) === String(campaign.productId)
      );
      const media = Array.isArray(campaign.customMedia) && campaign.customMedia.length
        ? campaign.customMedia[0]
        : (Array.isArray(campaign.customImages) && campaign.customImages[0])
        ? { type: "image", url: campaign.customImages[0], posterUrl: "" }
        : linkedProduct
        ? editorMediaFromProduct(linkedProduct)
        : null;
      const hasVideo = Array.isArray(campaign.customMedia) &&
        campaign.customMedia.some((item) => item.type === "video");
      const endsAt = campaign.endsAt ? toDate(campaign.endsAt) : null;
      const daysLeft = endsAt && endsAt.getTime
        ? Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86400000))
        : null;
      const totalBudget = Number(campaign.totalBudgetUsd) > 0
        ? `${fmtNumber(campaign.totalBudgetUsd, 2)} $ / ${fmtNumber(campaign.durationDays || 1)}j`
        : Number(campaign.totalBudgetMad) > 0
        ? `${money(campaign.totalBudgetMad)} / ${fmtNumber(campaign.durationDays || 1)}j`
        : "";
      const displayTitle = isCarousel
        ? campaign.campaignName ||
          `${adsT("adsCarouselTypeBadge")} · ${carouselCount} ${adsT(
            "adsCarouselProductsShort"
          )}`
        : productDisplayName(linkedProduct) ||
          campaign.productTitle ||
          campaign.productId ||
          "—";
      return `<article class="ads-campaign-card" data-campaign-id="${escapeHTML(
        campaign.id
      )}">
        <div class="ads-campaign-head">
          <div class="ads-campaign-summary">
            <span class="ads-campaign-thumb">${
              media
                ? editorMediaPreview(media)
                : `<span class="ads-campaign-thumb-empty">🎯</span>`
            }${hasVideo ? `<span class="ads-video-badge">🎬 ${escapeHTML(adsT("adsCampaignVideoBadge"))}</span>` : ""}</span>
            <div>
              <strong>${escapeHTML(displayTitle)}</strong>
              <div class="ads-campaign-meta">
                <span class="ads-channel-pill">${escapeHTML(platformLabel)}</span>
                <span class="ads-carousel-pill">${isCarousel ? "🎠" : "🔥"} ${escapeHTML(
                  isCarousel ? adsT("adsCarouselTypeBadge") : adsT("adsCampaignTypeProduct")
                )}${isCarousel ? ` · ${fmtNumber(carouselCount)} ${escapeHTML(adsT("adsCarouselProductsShort"))}` : ""}</span>
                <span class="ads-campaign-status ${
                  active ? "is-active" : isDraft ? "is-draft" : "is-paused"
                }">${escapeHTML(campaignStatusLabel(campaign.status))}</span>
                ${
                  String(campaign.autoPausedReason || "") === "stock_zero"
                    ? `<span class="ads-campaign-status is-auto-paused" title="${escapeHTML(
                        adsT("adsAutoPausedStockZeroHint") || ""
                      )}">⏸️ ${escapeHTML(adsT("adsAutoPausedStockZero") || "Pause auto (Stock 0)")}</span>`
                    : ""
                }
                <span>${escapeHTML(adsT("adsCampaignBudget"))} : ${money(
                  campaign.dailyBudgetMad
                )}/j${totalBudget ? ` · ${escapeHTML(totalBudget)}` : ""}${
                  daysLeft !== null ? ` · ${escapeHTML(adsT("adsCampaignDaysLeft"))} ${daysLeft}j` : ""
                }</span>
              </div>
            </div>
          </div>
          <div class="ads-campaign-actions">
            <button type="button" class="admin-btn-secondary" data-preview-campaign="${escapeHTML(
              campaign.id
            )}">👁️ ${escapeHTML(adsT("adsCampaignPreview"))}</button>
            <button type="button" class="admin-btn-secondary" data-edit-campaign="${escapeHTML(
              campaign.id
            )}">✏️ ${escapeHTML(adsT("adsCampaignEdit"))}</button>
            ${
              canDelete
                ? `<button type="button" class="admin-btn-secondary ads-btn-danger" data-delete-campaign="${escapeHTML(
                    campaign.id
                  )}">🗑️ ${escapeHTML(adsT("adsCampaignDelete") || "Supprimer")}</button>`
                : ""
            }
            ${
              isDraft
                ? ""
                : `<button type="button" class="admin-btn-secondary" data-toggle-campaign="${escapeHTML(
                    campaign.id
                  )}" data-toggle-action="${nextAction}">
                    ${active ? "⏸️ " + escapeHTML(adsT("adsPause")) : "▶️ " + escapeHTML(adsT("adsActivate"))}
                  </button>`
            }
          </div>
        </div>
        <div class="ads-campaign-stats">
          <div><span>${escapeHTML(adsT("adsCampaignOrders"))}</span><strong>${fmtNumber(
            stats.total
          )}</strong></div>
          <div><span>${escapeHTML(adsT("adsCampaignDelivered"))}</span><strong>${fmtNumber(
            stats.delivered
          )}</strong></div>
          <div><span>${escapeHTML(adsT("adsCampaignCod"))}</span><strong>${fmtNumber(
            stats.rate,
            1
          )} %</strong></div>
          <div><span>${escapeHTML(adsT("adsCampaignExternal"))}</span><strong>${escapeHTML(
            String(campaign.externalCampaignId || "—")
          )}</strong></div>
        </div>
        ${stats.alert ? `<div class="ads-cod-alert">⚠️ ${escapeHTML(
          adsT("adsCodAlert")
        )}</div>` : ""}
      </article>`;
    })
    .join("");

  container.querySelectorAll("[data-toggle-campaign]").forEach((button) => {
    button.addEventListener("click", () => {
      toggleCampaignStatus(
        button.dataset.toggleCampaign,
        button.dataset.toggleAction,
        button
      );
    });
  });
  container.querySelectorAll("[data-preview-campaign], [data-edit-campaign]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.previewCampaign || button.dataset.editCampaign;
      const campaign = cachedCampaigns.find((item) => String(item.id) === String(id));
      if (!campaign) return;
      openCreativeEditor({ kind: campaign.type === "carousel" ? "carousel" : "suggestion", campaign });
    });
  });
  container.querySelectorAll("[data-delete-campaign]").forEach((button) => {
    button.addEventListener("click", () => {
      deleteCampaign(button.dataset.deleteCampaign, button);
    });
  });
}

/**
 * Supprime une campagne/brouillon partout : Firestore + Meta/TikTok Ads Manager.
 * Refuse les campagnes ACTIVE (il faut d'abord les mettre en pause).
 */
async function deleteCampaign(campaignDocId, button) {
  if (!campaignDocId) return;
  const campaign = cachedCampaigns.find((item) => String(item.id) === String(campaignDocId));
  const status = String((campaign && campaign.status) || "").toUpperCase();
  if (status === "ACTIVE") {
    showToast(
      adsT("adsDeleteActiveBlocked") ||
        "Mettez la campagne en pause avant de la supprimer."
    );
    return;
  }
  const confirmed = window.confirm(
    "Supprimer définitivement cette campagne/brouillon sur Smartswika ET sur Meta / TikTok Ads Manager ?"
  );
  if (!confirmed) return;
  const originalLabel = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "⏳";
  }
  try {
    const result = await callAdsFunction("deleteAdCampaignEverywhere", {
      docId: campaignDocId,
      platform: campaign ? campaign.platform : undefined,
      externalCampaignId: campaign ? campaign.externalCampaignId : undefined,
    });
    cachedCampaigns = cachedCampaigns.filter(
      (item) => String(item.id) !== String(campaignDocId)
    );
    document
      .querySelector(
        `.ads-campaign-card[data-campaign-id="${String(campaignDocId).replace(/"/g, "")}"]`
      )
      ?.remove();
    renderCampaigns();
    showToast(
      result && result.alreadyGone
        ? "Campagne supprimée sur Smartswika (déjà absente de Meta/TikTok)"
        : "Campagne supprimée sur Smartswika et Meta/TikTok"
    );
  } catch (error) {
    console.error("[admin-ads] suppression impossible :", error);
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || "🗑️ Supprimer";
    }
    showToast(
      String(
        (error && error.message) ||
          adsT("adsDeleteError") ||
          "Suppression impossible."
      )
    );
  }
}

async function toggleCampaignStatus(campaignDocId, action, button) {
  if (!campaignDocId || !action) return;
  if (button) button.disabled = true;
  try {
    await callAdsFunction("toggleAdCampaignStatus", {
      campaignDocId,
      action,
    });
    await loadCampaigns();
    renderCampaigns();
  } catch (error) {
    console.error("[admin-ads] changement de statut impossible :", error);
    if (button) button.disabled = false;
    window.alert(String((error && error.message) || adsT("adsSaveError")));
  }
}

async function copyCatalogFeedUrl() {
  const url = "https://www.smartswika.ma/feed/products.xml";
  const ok = await copyText(url);
  const status = document.getElementById("adsFeedStatus");
  if (status) {
    status.textContent = ok ? adsT("adsFeedCopied") : adsT("adsUtmCopyError");
    status.classList.toggle("is-error", !ok);
    setTimeout(() => {
      status.textContent = "";
      status.classList.remove("is-error");
    }, 3500);
  }
}

async function testAdConnection(platform, button) {
  if (button) button.disabled = true;
  const status = document.getElementById(
    platform === "meta" ? "adsMetaTestStatus" : "adsTiktokTestStatus"
  );
  if (status) {
    status.textContent = adsT("adsTesting");
    status.classList.remove("is-error");
  }
  try {
    const result = await callAdsFunction("testAdPlatformConnection", { platform });
    if (!result.configured) {
      if (status) status.textContent = adsT("adsNotConfigured");
      return;
    }
    if (status) {
      status.textContent = `${result.accountName || result.platform} · ${
        result.status || ""
      } ${result.currency || ""}`.trim();
    }
  } catch (error) {
    if (status) {
      status.textContent = `${adsT("adsConnectionError")} ${String(
        (error && error.message) || ""
      ).slice(0, 140)}`;
      status.classList.add("is-error");
    }
  } finally {
    if (button) button.disabled = false;
  }
}

/* __ADS_CONFIG_FIELDS__ */





/* ============================================================
   CONFIGURATION PIXELS & BUDGETS
   ============================================================ */

function periodLabel(period) {
  if (period === "30") return adsT("adsPeriod30");
  if (period === "month") return adsT("adsPeriodMonth");
  if (period === "all") return adsT("adsPeriodAll");
  return adsT("adsPeriod7");
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value == null ? "" : String(value);
}

function readAmount(id) {
  const raw = Number(document.getElementById(id)?.value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.round(raw * 100) / 100;
}

function renderSpendInputs() {
  const suffix = SPEND_SUFFIX[currentPeriod] || "7";
  setValue("adsMetaPixelId", adsConfig.metaPixelId || "");
  setValue("adsTiktokPixelId", adsConfig.tiktokPixelId || "");
  setValue("adsMetaDomainVerification", adsConfig.metaDomainVerification || "");
  setValue("adsSpendMeta", adsConfig[`spendMeta${suffix}`] ?? "");
  setValue("adsSpendTiktok", adsConfig[`spendTiktok${suffix}`] ?? "");
  setValue("adsSpendOther", adsConfig[`spendOther${suffix}`] ?? "");
  setValue("adsMetaAdAccountId", adsSecrets.metaAdAccountId || "");
  setValue("adsMetaPageId", adsSecrets.metaPageId || "");
  setValue("adsTiktokAdvertiserId", adsSecrets.tiktokAdvertiserId || "");
  setValue("adsMetaAccessToken", "");
  setValue("adsTiktokAccessToken", "");
  const metaToken = document.getElementById("adsMetaAccessToken");
  const tiktokToken = document.getElementById("adsTiktokAccessToken");
  if (metaToken) {
    metaToken.placeholder = adsSecrets.metaAccessToken
      ? "•••••••••••• (conservé)"
      : "EAAB...";
  }
  if (tiktokToken) {
    tiktokToken.placeholder = adsSecrets.tiktokAccessToken
      ? "•••••••••••• (conservé)"
      : "TikTok access token";
  }
  const hint = document.getElementById("adsSpendPeriodHint");
  if (hint) {
    hint.textContent = `${adsT("adsSpendPeriod")} : ${periodLabel(currentPeriod)} — ${adsT(
      "adsConfigPeriodHint"
    )}`;
  }
}

function setConfigStatus(message, isError) {
  const status = document.getElementById("adsConfigStatus");
  if (!status) return;
  status.textContent = message || "";
  status.classList.toggle("is-error", Boolean(isError));
  if (saveStatusTimer) clearTimeout(saveStatusTimer);
  if (message) {
    saveStatusTimer = setTimeout(() => {
      status.textContent = "";
      status.classList.remove("is-error");
    }, 4000);
  }
}

async function saveAdsConfig() {
  const button = document.getElementById("adsSaveConfig");
  const metaPixelId = String(document.getElementById("adsMetaPixelId")?.value || "")
    .replace(/[^0-9]/g, "")
    .slice(0, 32);
  const tiktokPixelId = String(document.getElementById("adsTiktokPixelId")?.value || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 40);

  if (metaPixelId && metaPixelId.length < 6) {
    setConfigStatus(adsT("adsSaveError"), true);
    return;
  }
  if (tiktokPixelId && tiktokPixelId.length < 6) {
    setConfigStatus(adsT("adsSaveError"), true);
    return;
  }

  const suffix = SPEND_SUFFIX[currentPeriod] || "7";
  const metaDomainVerification = String(
    document.getElementById("adsMetaDomainVerification")?.value || ""
  )
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 200);
  const payload = {
    metaPixelId,
    tiktokPixelId,
    metaDomainVerification,
    [`spendMeta${suffix}`]: readAmount("adsSpendMeta"),
    [`spendTiktok${suffix}`]: readAmount("adsSpendTiktok"),
    [`spendOther${suffix}`]: readAmount("adsSpendOther"),
    updatedAt: serverTimestamp(),
  };
  const secretValue = (id) =>
    String(document.getElementById(id)?.value || "").trim();
  const metaToken = secretValue("adsMetaAccessToken").slice(0, 4096);
  const tiktokToken = secretValue("adsTiktokAccessToken").slice(0, 4096);
  const secretsPayload = {
    metaAdAccountId: secretValue("adsMetaAdAccountId").slice(0, 64),
    metaPageId: secretValue("adsMetaPageId").slice(0, 64),
    tiktokAdvertiserId: secretValue("adsTiktokAdvertiserId").slice(0, 64),
    updatedAt: serverTimestamp(),
  };
  if (metaToken) secretsPayload.metaAccessToken = metaToken;
  if (tiktokToken) secretsPayload.tiktokAccessToken = tiktokToken;

  if (button) button.disabled = true;
  try {
    /* Document privé : IDs + budgets + domaine (admin uniquement). */
    await setDoc(doc(db, "config", "ads"), payload, { merge: true });
    /* Miroir public : IDs pixels + verification de domaine. */
    await setDoc(
      doc(db, "config", "ads_public"),
      { metaPixelId, tiktokPixelId, metaDomainVerification, updatedAt: serverTimestamp() },
      { merge: true }
    );
    /* Secrets API : jamais dans le document public. */
    await setDoc(doc(db, "config", "ads_secrets"), secretsPayload, { merge: true });
    adsConfig = { ...adsConfig, ...payload };
    adsSecrets = {
      ...adsSecrets,
      ...secretsPayload,
      metaAccessToken: metaToken || adsSecrets.metaAccessToken || "",
      tiktokAccessToken: tiktokToken || adsSecrets.tiktokAccessToken || "",
    };
    setConfigStatus(adsT("adsSaved"), false);
    if (lastStats) {
      lastStats = computeStats();
      renderKpi(lastStats);
      renderChart(lastStats);
      renderTable(lastStats);
    }
    renderSuggestions();
  } catch (error) {
    console.error("[admin-ads] enregistrement impossible :", error);
    setConfigStatus(adsT("adsSaveError"), true);
  } finally {
    if (button) button.disabled = false;
  }
}

/* ============================================================
   GÉNÉRATEUR DE LIEN UTM
   ============================================================ */

function slugifyCampaign(value) {
  return String(value == null ? "" : value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Lien prêt à coller dans les pubs. Source : tiktok ou meta.
 * @param {string} channel
 * @param {string} campaign
 * @returns {string}
 */
export function buildUtmUrl(channel, campaign) {
  const raw = String(channel || "").trim().toLowerCase();
  const source = raw === "meta" || raw === "facebook" || raw === "instagram"
    ? "meta"
    : raw === "google"
    ? "google"
    : raw === "whatsapp"
    ? "whatsapp"
    : "tiktok";
  const medium = source === "whatsapp" ? "social" : "paid_social";
  const slug = slugifyCampaign(campaign) || "campagne";
  return `https://www.smartswika.ma/?utm_source=${source}&utm_medium=${medium}&utm_campaign=${encodeURIComponent(
    slug
  )}`;
}

function updateUtmPreview() {
  const channel = document.getElementById("adsUtmChannel")?.value || "tiktok";
  const campaign = document.getElementById("adsUtmCampaign")?.value || "";
  const url = buildUtmUrl(channel, campaign);
  const preview = document.getElementById("adsUtmPreview");
  if (preview) preview.textContent = url;
  return url;
}

async function copyText(value) {
  const text = String(value || "");
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      /* repli ci-dessous */
    }
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "readonly");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

async function copyUtmLink() {
  const url = updateUtmPreview();
  const ok = await copyText(url);
  const status = document.getElementById("adsUtmStatus");
  if (status) {
    status.textContent = ok ? adsT("adsUtmCopied") : adsT("adsUtmCopyError");
    status.classList.toggle("is-error", !ok);
    setTimeout(() => {
      status.textContent = "";
      status.classList.remove("is-error");
    }, 3500);
  }
  return ok;
}

/* ============================================================
   ÉVÉNEMENTS & INITIALISATION
   ============================================================ */

function bindEvents() {
  document.querySelectorAll("[data-ads-period]").forEach((button) => {
    button.addEventListener("click", () => {
      const period = String(button.dataset.adsPeriod || "7");
      if (!PERIODS.includes(period) || period === currentPeriod) return;
      currentPeriod = period;
      document.querySelectorAll("[data-ads-period]").forEach((btn) => {
        const active = btn === button;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
      loadAll();
    });
  });

  document.getElementById("adsSaveConfig")?.addEventListener("click", saveAdsConfig);
  document.getElementById("adsUtmToggle")?.addEventListener("click", () => {
    const panel = document.getElementById("adsUtmPanel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) updateUtmPreview();
  });
  document.getElementById("adsUtmCopy")?.addEventListener("click", copyUtmLink);
  document.getElementById("adsUtmChannel")?.addEventListener("change", updateUtmPreview);
  document.getElementById("adsUtmCampaign")?.addEventListener("input", updateUtmPreview);
  document.getElementById("adsFeedCopy")?.addEventListener("click", copyCatalogFeedUrl);
  const metaTest = document.getElementById("adsTestMeta");
  const tiktokTest = document.getElementById("adsTestTiktok");
  metaTest?.addEventListener("click", () => testAdConnection("meta", metaTest));
  tiktokTest?.addEventListener("click", () => testAdConnection("tiktok", tiktokTest));

  /* La langue admin est appliquée par admin-ui.js : on redessine les
     libellés dynamiques sans relire Firestore. */
  document.addEventListener("admin-lang-changed", () => {
    if (!initialized) return;
    const hint = document.getElementById("adsSpendPeriodHint");
    if (hint) {
      hint.textContent = `${adsT("adsSpendPeriod")} : ${periodLabel(
        currentPeriod
      )} — ${adsT("adsConfigPeriodHint")}`;
    }
    if (lastStats) {
      renderKpi(lastStats);
      renderChart(lastStats);
      renderTable(lastStats);
    }
    renderSuggestions();
    renderCampaigns();
    updateUtmPreview();
  });
}

/**
 * Point d'entrée appelé par js/admin.js à l'ouverture de l'onglet.
 * Idempotent : recharge les données à chaque ouverture (données
 * potentiellement modifiées depuis le dernier passage).
 */
export async function initAdsTab() {
  if (!initialized) {
    initialized = true;
    bindEvents();
  }
  await loadAll();
}

/* API de diagnostic (console admin). */
if (typeof window !== "undefined") {
  window.__adminAds = {
    reload: () => loadAll(),
    buildUtmUrl,
    period: () => currentPeriod,
    computeBudget,
    budgetPayload,
    openCreativeEditor,
  };
}

console.log("✅ admin-ads.js chargé - v1.1.0 (Suivi Pubs + Automatisation campagnes)");
