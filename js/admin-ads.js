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
import { db } from "./firebase.js";
import { adminT, getAdminLang } from "./admin-ui.js";
import { escapeHTML } from "./utils.js";

/* ============================================================
   ÉTAT
   ============================================================ */

const PERIODS = ["7", "30", "month", "all"];
const SOURCE_VALUES = ["tiktok", "meta", "google", "whatsapp", "direct", "other"];
const CHANNEL_ORDER = ["tiktok", "meta", "direct", "other"];
const SPEND_SUFFIX = { 7: "7", 30: "30", month: "Month", all: "All" };

let currentPeriod = "7";
let adsConfig = {};
let cachedOrders = [];
let cachedEvents = [];
let cachedProducts = [];
let chartInstance = null;
let initialized = false;
let loading = false;
let lastStats = null;
let saveStatusTimer = null;

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
  if (channel === "tiktok") return adminT("adsChannelTiktok");
  if (channel === "meta") return adminT("adsChannelMeta");
  if (channel === "direct") return adminT("adsChannelDirect");
  return adminT("adsChannelOther");
}

function sourceLabel(source) {
  if (source === "tiktok") return adminT("adsChannelTiktok");
  if (source === "meta") return adminT("adsChannelMeta");
  if (source === "direct") return adminT("adsChannelDirect");
  if (source === "google") return "Google";
  if (source === "whatsapp") return "WhatsApp";
  return adminT("adsChannelOther");
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
  cachedOrders = snap.docs
    .map((d) => ({ id: d.id, ...d.data(), __date: toDate(d.data().createdAt) }))
    .filter((order) => inRange(order.__date, range));
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

async function loadAll() {
  if (loading) return;
  loading = true;
  const range = periodRange(currentPeriod);
  try {
    await Promise.all([loadConfig(), loadProducts()]);
    await Promise.all([loadOrders(range), loadEvents(range)]);
    lastStats = computeStats();
    renderKpi(lastStats);
    renderChart(lastStats);
    renderTable(lastStats);
    renderSpendInputs();
  } catch (error) {
    console.error("[admin-ads] chargement impossible :", error);
    const status = document.getElementById("adsConfigStatus");
    if (status) {
      status.textContent = adminT("adsSaveError");
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
      campaign: adminT("adsAllCampaigns"),
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
    `${adminT("adsKpiDelivery")} : \u2066${fmtNumber(stats.deliveryRate, 1)} %\u2069`
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
          label: adminT("adsChartCreated"),
          data: orderedData,
          backgroundColor: "rgba(180, 131, 62, 0.85)",
          borderColor: "#B4833E",
          borderWidth: 1,
          borderRadius: 6,
          maxBarThickness: 42,
        },
        {
          label: adminT("adsChartDelivered"),
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
      adminT("adsNoData")
    )}</td></tr>`;
    cards.innerHTML = `<div class="ads-empty">${escapeHTML(adminT("adsNoData"))}</div>`;
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
        [adminT("adsColViews"), isChannel ? fmtNumber(row.views) : "—"],
        [adminT("adsColAddCart"), isChannel ? fmtNumber(row.addToCart) : "—"],
        [adminT("adsColOrders"), fmtNumber(row.created)],
        [adminT("adsColDelivered"), fmtNumber(row.delivered)],
        [
          adminT("adsColDeliveryRate"),
          row.created > 0 ? `\u2066${fmtNumber(row.deliveryRate, 1)} %\u2069` : "—",
        ],
        [adminT("adsColRevenue"), money(row.revenue)],
        [adminT("adsColNet"), money(row.net)],
        [adminT("adsColSpend"), money(row.spend)],
        [adminT("adsColRoas"), row.roas == null ? "—" : `\u2066${fmtNumber(row.roas, 2)}x\u2069`],
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
   CONFIGURATION PIXELS & BUDGETS
   ============================================================ */

function periodLabel(period) {
  if (period === "30") return adminT("adsPeriod30");
  if (period === "month") return adminT("adsPeriodMonth");
  if (period === "all") return adminT("adsPeriodAll");
  return adminT("adsPeriod7");
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
  setValue("adsSpendMeta", adsConfig[`spendMeta${suffix}`] ?? "");
  setValue("adsSpendTiktok", adsConfig[`spendTiktok${suffix}`] ?? "");
  setValue("adsSpendOther", adsConfig[`spendOther${suffix}`] ?? "");
  const hint = document.getElementById("adsSpendPeriodHint");
  if (hint) {
    hint.textContent = `${adminT("adsSpendPeriod")} : ${periodLabel(currentPeriod)} — ${adminT(
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
    setConfigStatus(adminT("adsSaveError"), true);
    return;
  }
  if (tiktokPixelId && tiktokPixelId.length < 6) {
    setConfigStatus(adminT("adsSaveError"), true);
    return;
  }

  const suffix = SPEND_SUFFIX[currentPeriod] || "7";
  const payload = {
    metaPixelId,
    tiktokPixelId,
    [`spendMeta${suffix}`]: readAmount("adsSpendMeta"),
    [`spendTiktok${suffix}`]: readAmount("adsSpendTiktok"),
    [`spendOther${suffix}`]: readAmount("adsSpendOther"),
    updatedAt: serverTimestamp(),
  };

  if (button) button.disabled = true;
  try {
    /* Document privé : IDs + budgets (admin uniquement). */
    await setDoc(doc(db, "config", "ads"), payload, { merge: true });
    /* Miroir public : SEULS les IDs pixels (jamais les budgets). */
    await setDoc(
      doc(db, "config", "ads_public"),
      { metaPixelId, tiktokPixelId, updatedAt: serverTimestamp() },
      { merge: true }
    );
    adsConfig = { ...adsConfig, ...payload };
    setConfigStatus(adminT("adsSaved"), false);
    if (lastStats) {
      lastStats = computeStats();
      renderKpi(lastStats);
      renderChart(lastStats);
      renderTable(lastStats);
    }
  } catch (error) {
    console.error("[admin-ads] enregistrement impossible :", error);
    setConfigStatus(adminT("adsSaveError"), true);
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
    status.textContent = ok ? adminT("adsUtmCopied") : adminT("adsUtmCopyError");
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

  /* La langue admin est appliquée par admin-ui.js : on redessine les
     libellés dynamiques sans relire Firestore. */
  document.addEventListener("admin-lang-changed", () => {
    if (!initialized) return;
    const hint = document.getElementById("adsSpendPeriodHint");
    if (hint) {
      hint.textContent = `${adminT("adsSpendPeriod")} : ${periodLabel(
        currentPeriod
      )} — ${adminT("adsConfigPeriodHint")}`;
    }
    if (lastStats) {
      renderKpi(lastStats);
      renderChart(lastStats);
      renderTable(lastStats);
    }
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
  };
}

console.log("✅ admin-ads.js chargé - v1.0.0 (Suivi Pubs TikTok & Meta)");
