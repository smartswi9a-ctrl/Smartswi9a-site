/* ============================================================
   js/smart-widgets.js — NOUVEAUTÉS PRODUIT (audit 2026-11-20)
   ------------------------------------------------------------
   Quatre modules ADDITIFS, sans modification des templates :
     1. Live Glass      : halo qui suit le curseur sur les cartes
     2. Comparateur     : jusqu'à 3 produits, barre flottante + tableau
     3. Barre Koulchi   : palier dynamique (« 2/3 → −5 % »)
     4. Quiz gadget     : « Trouve ton gadget en 30 s » depuis le hero

   RÈGLES D'INTÉGRATION :
     - chaque module est isolé dans un try/catch : une erreur ici ne
       peut jamais casser le catalogue, le panier ni le checkout ;
     - aucun innerHTML avec des données Firestore : textContent only ;
     - aucun appel réseau supplémentaire (produits déjà en mémoire).
   ============================================================ */

import { getCart, getProducts } from "./store.js";
import {
  getLang,
  getProductName,
  getProductImageUrl,
  getFallbackImage,
} from "./utils.js";
import {
  KOULCHI_MIN_ITEMS,
  getKoulchiPercent,
  getNextKoulchiTier,
  getKoulchiCatalog,
} from "./koulchi.js";
import { addToCart } from "./cart.js";

/* Libellés locaux : évite de toucher la parité stricte de translations.js. */
const M = {
  fr: {
    compare: "Comparer", compareTitle: "Comparateur",
    compareEmpty: "Ajoutez au moins 2 produits à comparer.",
    compareClear: "Vider", compareGo: "Comparer",
    name: "Produit", price: "Prix", rating: "Note", stock: "Stock",
    inStock: "En stock", outStock: "Épuisé", close: "Fermer",
    added: "Ajouté au comparateur", removed: "Retiré du comparateur",
    max3: "3 produits maximum",
    koulchiNext: "Ajoutez {n} article(s) pour −{p} %",
    koulchiMax: "Palier maximum atteint : −{p} %",
    koulchiTitle: "Koulchi dialk",
    addPack: "Ajouter au panier",
    quizBtn: "Trouve ton gadget en 30 s", quizTitle: "Trouve ton gadget",
    quizSub: "4 questions, 30 secondes, des propositions concrètes.",
    next: "Suivant", restart: "Recommencer", results: "Nos recommandations",
    addCart: "Voir le produit",
    noResult: "Aucun produit ne correspond. Élargissez le budget.",
    q1: "Quel usage ?", q1a: "Maison connectée", q1b: "Audio / écouteurs",
    q1c: "Montres connectées", q1d: "Accessoires tech",
    q2: "Votre budget ?", q2a: "Moins de 200 MAD", q2b: "200 – 500 MAD",
    q2c: "500 – 1 000 MAD", q2d: "Plus de 1 000 MAD",
    q3: "Votre priorité ?", q3a: "Le prix", q3b: "La qualité", q3c: "La nouveauté",
    q4: "Votre niveau tech ?", q4a: "Débutant", q4b: "Confirmé",
  },
  ar: {
    compare: "مقارنة", compareTitle: "المقارنة",
    compareEmpty: "أضف منتجين على الأقل للمقارنة.",
    compareClear: "إفراغ", compareGo: "قارن",
    name: "المنتج", price: "الثمن", rating: "التقييم", stock: "المخزون",
    inStock: "متوفر", outStock: "غير متوفر", close: "إغلاق",
    added: "تمت الإضافة للمقارنة", removed: "تمت الإزالة من المقارنة",
    max3: "3 منتجات كحد أقصى",
    koulchiNext: "أضف {n} منتج(ات) للحصول على −{p} %",
    koulchiMax: "أقصى تخفيض تم بلوغه: −{p} %",
    koulchiTitle: "كولشي ديالك",
    addPack: "أضف إلى السلة",
    quizBtn: "اعرف الجهاز المناسب في 30 ثانية", quizTitle: "اعرف جهازك",
    quizSub: "4 أسئلة، 30 ثانية، اقتراحات عملية.",
    next: "التالي", restart: "إعادة", results: "اقتراحاتنا",
    addCart: "عرض المنتج",
    noResult: "لا يوجد منتج مطابق. وسّع الميزانية.",
    q1: "ما هو الاستعمال؟", q1a: "المنزل الذكي", q1b: "الصوت والسماعات",
    q1c: "الساعات الذكية", q1d: "إكسسوارات تقنية",
    q2: "ما هي ميزانيتك؟", q2a: "أقل من 200 درهم", q2b: "200 – 500 درهم",
    q2c: "500 – 1000 درهم", q2d: "أكثر من 1000 درهم",
    q3: "ما هي أولويتك؟", q3a: "الثمن", q3b: "الجودة", q3c: "الجديد",
    q4: "مستواك التقني؟", q4a: "مبتدئ", q4b: "متقدم",
  },
  en: {
    compare: "Compare", compareTitle: "Compare products",
    compareEmpty: "Add at least 2 products to compare.",
    compareClear: "Clear", compareGo: "Compare",
    name: "Product", price: "Price", rating: "Rating", stock: "Stock",
    inStock: "In stock", outStock: "Out of stock", close: "Close",
    added: "Added to compare", removed: "Removed from compare",
    max3: "3 products maximum",
    koulchiNext: "Add {n} item(s) for −{p}%",
    koulchiMax: "Max tier reached: −{p}%",
    koulchiTitle: "Koulchi dialk",
    addPack: "Add to cart",
    quizBtn: "Find your gadget in 30s", quizTitle: "Find your gadget",
    quizSub: "4 questions, 30 seconds, concrete picks.",
    next: "Next", restart: "Restart", results: "Our recommendations",
    addCart: "View product",
    noResult: "No product matches. Try a wider budget.",
    q1: "What for?", q1a: "Smart home", q1b: "Audio / earbuds",
    q1c: "Smartwatches", q1d: "Tech accessories",
    q2: "Your budget?", q2a: "Under 200 MAD", q2b: "200 – 500 MAD",
    q2c: "500 – 1,000 MAD", q2d: "Over 1,000 MAD",
    q3: "Your priority?", q3a: "Price", q3b: "Quality", q3c: "Newest",
    q4: "Your tech level?", q4a: "Beginner", q4b: "Advanced",
  },
};

/** @returns {object} libellés de la langue courante */
function m() {
  return M[getLang()] || M.fr;
}

const COMPARE_KEY = "swi9a_compare";
const COMPARE_MAX = 3;
const STYLE_ID = "smart-widgets-css";

/* ============================================================
   STYLES (injectés une seule fois)
   ============================================================ */
function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.product-card { isolation: isolate; }
.product-card::before {
  content: ""; position: absolute; inset: -1px; border-radius: inherit;
  pointer-events: none; opacity: 0; z-index: 0; transition: opacity .3s ease;
  background: radial-gradient(320px circle at var(--mx, 50%) var(--my, 50%),
              rgba(216, 178, 95, .22), transparent 62%);
}
.product-card:hover::before, .product-card:focus-within::before { opacity: 1; }
@media (hover: none) { .product-card::before { display: none; } }

.cmp-btn {
  position: absolute; bottom: .4rem; inset-inline-start: .4rem; z-index: 3;
  display: inline-flex; align-items: center; gap: .2rem;
  min-height: 30px; padding: .15rem .45rem; border-radius: 999px;
  border: 1px solid var(--border-gold, rgba(180,130,40,.25));
  background: rgba(255,255,255,.92); color: var(--gold-text, #6f5219);
  font-size: .68rem; font-weight: 700; cursor: pointer;
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
}
.cmp-btn.is-on { background: var(--gold, #8a6a24); color: #fff; border-color: transparent; }
@media (max-width: 480px) { .cmp-btn { min-height: 32px; font-size: .72rem; } }

#cmpBar {
  position: fixed; inset-inline: 12px; bottom: 12px; z-index: 9500;
  display: none; align-items: center; gap: .6rem; flex-wrap: wrap;
  padding: .6rem .8rem; border-radius: 14px;
  background: rgba(26, 26, 46, .96); color: #fff;
  box-shadow: 0 10px 30px rgba(0,0,0,.35); font-size: .85rem;
}
#cmpBar.is-open { display: flex; }
#cmpBar .cmp-count { font-weight: 800; color: var(--gold-light, #c99f3e); }
#cmpBar button {
  min-height: 38px; padding: .35rem .8rem; border-radius: 999px; border: 0;
  font-weight: 700; cursor: pointer; font-size: .82rem;
}
#cmpBar .cmp-go { background: var(--gold, #8a6a24); color: #fff; }
#cmpBar .cmp-clear { background: rgba(255,255,255,.14); color: #fff; }

#cmpModal {
  position: fixed; inset: 0; z-index: 9600; display: none;
  align-items: center; justify-content: center; padding: 1rem;
  background: rgba(10, 10, 16, .6);
}
#cmpModal.is-open { display: flex; }
#cmpModal .cmp-sheet {
  width: min(920px, 100%); max-height: 86vh; overflow: auto;
  background: var(--bg-surface, #fff); color: var(--text, #1a1a2e);
  border-radius: 18px; padding: 1rem;
}
#cmpModal table { width: 100%; border-collapse: collapse; font-size: .85rem; }
#cmpModal th, #cmpModal td {
  padding: .55rem .45rem; border-bottom: 1px solid var(--border, rgba(0,0,0,.08));
  text-align: center; vertical-align: middle;
}
#cmpModal th:first-child, #cmpModal td:first-child { text-align: start; font-weight: 700; }
#cmpModal img { width: 72px; height: 72px; object-fit: cover; border-radius: 10px; }
#cmpModal .cmp-actions { display: flex; justify-content: space-between; gap: .5rem; margin-top: .8rem; }
#cmpModal button {
  min-height: 42px; padding: .45rem 1rem; border-radius: 999px; border: 0;
  cursor: pointer; font-weight: 700;
}
#cmpModal .cmp-close { background: var(--bg, #f8f6f2); color: var(--text, #1a1a2e); }

#koulchiPill {
  position: fixed; z-index: 9400; display: none;
  inset-inline-end: 14px; bottom: 84px;
  max-width: 240px; padding: .55rem .7rem; border-radius: 14px;
  background: rgba(26, 26, 46, .95); color: #fff;
  font-size: .78rem; line-height: 1.35;
  box-shadow: 0 8px 24px rgba(0,0,0,.28);
}
#koulchiPill.is-open { display: block; }
#koulchiPill strong { color: var(--gold-light, #c99f3e); }
#koulchiPill .kbar {
  height: 5px; margin-top: .35rem; border-radius: 999px;
  background: rgba(255,255,255,.18); overflow: hidden;
}
#koulchiPill .kbar > i {
  display: block; height: 100%; width: 0;
  background: linear-gradient(90deg, var(--gold, #8a6a24), var(--gold-light, #c99f3e));
  transition: width .4s ease;
}
#koulchiPill .ksug {
  margin-top: .5rem; padding-top: .45rem;
  border-top: 1px solid rgba(255,255,255,.14);
}
#koulchiPill .ksug button {
  width: 100%; min-height: 36px; padding: .3rem .45rem;
  border-radius: 10px; border: 1px solid rgba(255,255,255,.25);
  background: rgba(255,255,255,.12); color: #fff;
  font-size: .74rem; font-weight: 700; cursor: pointer; text-align: start;
}
#koulchiPill .ksug button:hover { background: rgba(255,255,255,.2); }

#quizModal {
  position: fixed; inset: 0; z-index: 9700; display: none;
  align-items: center; justify-content: center; padding: 1rem;
  background: rgba(10, 10, 16, .62);
}
#quizModal.is-open { display: flex; }
#quizModal .quiz-sheet {
  width: min(560px, 100%); max-height: 88vh; overflow: auto;
  background: var(--bg-surface, #fff); color: var(--text, #1a1a2e);
  border-radius: 18px; padding: 1.1rem;
}
#quizModal h3 { margin: 0 0 .2rem; font-family: var(--font-secondary, Georgia, serif); color: var(--gold-text, #6f5219); }
#quizModal .quiz-sub { font-size: .82rem; color: var(--text-muted, #5c5c5c); margin-bottom: .8rem; }
#quizModal .quiz-q { font-weight: 800; margin: .9rem 0 .4rem; }
#quizModal .quiz-opt {
  display: block; width: 100%; text-align: start; margin-bottom: .35rem;
  min-height: 44px; padding: .5rem .7rem; border-radius: 10px;
  border: 1px solid var(--border, rgba(0,0,0,.08));
  background: var(--bg, #f8f6f2); color: inherit; cursor: pointer; font-size: .88rem;
}
#quizModal .quiz-opt.is-on { border-color: var(--gold, #8a6a24); background: rgba(138,106,36,.12); font-weight: 700; }
#quizModal .quiz-nav { display: flex; justify-content: space-between; gap: .5rem; margin-top: .8rem; }
#quizModal .quiz-nav button {
  min-height: 44px; padding: .45rem 1rem; border-radius: 999px; border: 0;
  font-weight: 700; cursor: pointer;
}
#quizModal .quiz-next { background: var(--gold, #8a6a24); color: #fff; }
#quizModal .quiz-next[disabled] { opacity: .45; cursor: not-allowed; }
#quizModal .quiz-close { background: var(--bg, #f8f6f2); color: inherit; }
#quizModal .quiz-result { display: flex; gap: .6rem; align-items: center; padding: .5rem 0; border-bottom: 1px solid var(--border, rgba(0,0,0,.08)); }
#quizModal .quiz-result img { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; }
#quizModal .quiz-result a { color: var(--gold-text, #6f5219); font-weight: 800; text-decoration: none; font-size: .85rem; }
`;
  document.head.appendChild(style);
}


/* ============================================================
   1. LIVE GLASS — halo qui suit le curseur
   ============================================================ */
function attachLiveGlass(root = document) {
  root.querySelectorAll(".product-card").forEach((card) => {
    if (card.dataset.liveGlass === "1") return;
    card.dataset.liveGlass = "1";
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  });
}

/* ============================================================
   2. COMPARATEUR VISUEL
   ============================================================ */
function readCompare() {
  try {
    const raw = JSON.parse(localStorage.getItem(COMPARE_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter(Boolean).slice(0, COMPARE_MAX) : [];
  } catch (e) {
    return [];
  }
}

function writeCompare(ids) {
  try {
    localStorage.setItem(COMPARE_KEY, JSON.stringify(ids.slice(0, COMPARE_MAX)));
  } catch (e) {
    /* stockage indisponible : non bloquant */
  }
}

function productById(id) {
  return (getProducts() || []).find((p) => String(p.id) === String(id)) || null;
}

function compareBar() {
  let bar = document.getElementById("cmpBar");
  if (bar) return bar;
  bar = document.createElement("div");
  bar.id = "cmpBar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", m().compareTitle);
  document.body.appendChild(bar);
  return bar;
}

function renderCompareBar() {
  const bar = compareBar();
  const ids = readCompare();
  bar.textContent = "";
  if (ids.length === 0) {
    bar.classList.remove("is-open");
    return;
  }
  const count = document.createElement("span");
  count.className = "cmp-count";
  count.textContent = String(ids.length);

  const label = document.createElement("span");
  label.textContent = m().compareTitle;

  const go = document.createElement("button");
  go.type = "button";
  go.className = "cmp-go";
  go.textContent = m().compareGo;
  go.disabled = ids.length < 2;
  go.addEventListener("click", openCompareModal);

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "cmp-clear";
  clear.textContent = m().compareClear;
  clear.addEventListener("click", () => {
    writeCompare([]);
    document.querySelectorAll(".cmp-btn.is-on").forEach((b) => b.classList.remove("is-on"));
    renderCompareBar();
  });

  bar.append(count, label, go, clear);
  bar.classList.add("is-open");
}

/**
 * Ajoute/retire un produit du comparateur.
 * @returns {boolean|null} true=ajouté, false=retiré, null=limite atteinte
 */
function toggleCompare(productId) {
  const id = String(productId);
  const ids = readCompare();
  const index = ids.indexOf(id);
  if (index >= 0) {
    ids.splice(index, 1);
    writeCompare(ids);
    renderCompareBar();
    return false;
  }
  if (ids.length >= COMPARE_MAX) return null;
  ids.push(id);
  writeCompare(ids);
  renderCompareBar();
  return true;
}


function openCompareModal() {
  const products = readCompare().map(productById).filter(Boolean);
  const sheet = m();
  let modal = document.getElementById("cmpModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "cmpModal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.remove("is-open");
    });
  }
  modal.textContent = "";

  const box = document.createElement("div");
  box.className = "cmp-sheet";
  const title = document.createElement("h3");
  title.textContent = sheet.compareTitle;
  box.appendChild(title);

  if (products.length < 2) {
    const p = document.createElement("p");
    p.textContent = sheet.compareEmpty;
    box.appendChild(p);
  } else {
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    const first = document.createElement("th");
    first.textContent = sheet.name;
    hr.appendChild(first);

    products.forEach((product) => {
      const th = document.createElement("th");
      const img = document.createElement("img");
      img.src = getProductImageUrl(product) || getFallbackImage(getProductName(product));
      img.alt = "";
      img.loading = "lazy";
      th.appendChild(img);
      const name = document.createElement("div");
      name.textContent = getProductName(product);
      name.style.fontWeight = "600";
      name.style.fontSize = ".78rem";
      th.appendChild(name);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const rows = [
      [sheet.price, (p) => `${Number(p.price) || 0} MAD`],
      [sheet.rating, (p) => (p.ratingAvg ? `${p.ratingAvg} / 5 (${p.ratingCount || 0})` : "—")],
      [sheet.stock, (p) => ((Number(p.stock) || 0) > 0 ? sheet.inStock : sheet.outStock)],
    ];
    const tbody = document.createElement("tbody");
    rows.forEach(([label, value]) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = label;
      tr.appendChild(th);
      products.forEach((p) => {
        const td = document.createElement("td");
        td.textContent = value(p);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
  }

  const actions = document.createElement("div");
  actions.className = "cmp-actions";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "cmp-clear";
  clear.textContent = sheet.compareClear;
  clear.style.background = "rgba(0,0,0,.06)";
  clear.style.color = "inherit";
  clear.addEventListener("click", () => {
    writeCompare([]);
    document.querySelectorAll(".cmp-btn.is-on").forEach((b) => b.classList.remove("is-on"));
    renderCompareBar();
    modal.classList.remove("is-open");
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "cmp-close";
  close.textContent = sheet.close;
  close.addEventListener("click", () => modal.classList.remove("is-open"));
  actions.append(clear, close);
  box.appendChild(actions);

  modal.appendChild(box);
  modal.classList.add("is-open");
}

function attachCompareButtons(root = document) {
  const ids = readCompare();
  root.querySelectorAll(".product-card").forEach((card) => {
    const holder = card.querySelector(".product-img");
    const id = card.dataset.id;
    if (!holder || !id || holder.querySelector(".cmp-btn")) return;
    const on = ids.includes(String(id));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `cmp-btn${on ? " is-on" : ""}`;
    btn.textContent = `⇄ ${m().compare}`;
    btn.dataset.id = String(id);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const result = toggleCompare(id);
      if (result === null) {
        btn.title = m().max3;
        return;
      }
      btn.classList.toggle("is-on", result);
      btn.setAttribute("aria-pressed", result ? "true" : "false");
      compareBar().setAttribute("aria-live", "polite");
    });
    holder.appendChild(btn);
  });
}


/* ============================================================
   3. BARRE KOULCHI DYNAMIQUE
   ============================================================ */
function cartItemCount() {
  const cart = getCart();
  if (!Array.isArray(cart)) return 0;
  return cart.reduce((sum, line) => sum + (Number(line && line.quantity) || 0), 0);
}

/**
 * Suggère UN produit pour compléter le pack Koulchi.
 * Priorité : même catégorie qu'un article déjà au panier (cohérence du pack),
 * puis meilleure note, puis prix de groupe le plus bas.
 * @returns {object|null}
 */
function suggestPackProduct() {
  const products = getProducts() || [];
  const catalog = getKoulchiCatalog(products);
  if (!catalog.length) return null;

  const cart = Array.isArray(getCart()) ? getCart() : [];
  const inCart = new Set(cart.map((l) => String((l && (l.productId || l.id)) || "")));
  const cartCategories = new Set(
    cart
      .map((l) => {
        const pid = String((l && (l.productId || l.id)) || "");
        const p = products.find((x) => String(x.id) === pid);
        return p ? String(p.category || "") : "";
      })
      .filter(Boolean)
  );

  const candidates = catalog.filter(
    (p) => !inCart.has(String(p.id)) && (Number(p.stock) || 0) > 0
  );
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const sa = cartCategories.has(String(a.category || "")) ? 1 : 0;
    const sb = cartCategories.has(String(b.category || "")) ? 1 : 0;
    if (sa !== sb) return sb - sa;
    const ra = Number(a.ratingAvg) || 0;
    const rb = Number(b.ratingAvg) || 0;
    if (ra !== rb) return rb - ra;
    return (Number(a.koulchiPrice) || 0) - (Number(b.koulchiPrice) || 0);
  });
  return candidates[0];
}

function renderKoulchiPill() {
  const count = cartItemCount();
  let pill = document.getElementById("koulchiPill");
  if (!pill) {
    pill = document.createElement("div");
    pill.id = "koulchiPill";
    pill.setAttribute("role", "status");
    pill.setAttribute("aria-live", "polite");
    document.body.appendChild(pill);
  }
  if (count <= 0) {
    pill.classList.remove("is-open");
    return;
  }

  const percent = getKoulchiPercent(count);
  const next = getNextKoulchiTier(count);
  const sheet = m();
  const MAX_PERCENT = 15;

  pill.textContent = "";
  const title = document.createElement("strong");
  title.textContent = sheet.koulchiTitle;

  const line = document.createElement("div");
  line.textContent = next
    ? sheet.koulchiNext.replace("{n}", String(next.missing)).replace("{p}", String(next.percent))
    : sheet.koulchiMax.replace("{p}", String(MAX_PERCENT));

  const bar = document.createElement("div");
  bar.className = "kbar";
  const fill = document.createElement("i");
  if (percent > 0) {
    fill.style.width = "100%";
  } else {
    const target = next ? count + next.missing : Math.max(count, KOULCHI_MIN_ITEMS);
    fill.style.width = `${Math.min(100, Math.round((count / Math.max(target, 1)) * 100))}%`;
  }
  bar.appendChild(fill);

  pill.append(title, line, bar);

  /* Suggestion de pack : seulement s'il reste un palier à atteindre.
     addToCart() gère lui-même le cas « non connecté » (compte obligatoire). */
  if (next) {
    const suggestion = suggestPackProduct();
    if (suggestion) {
      const wrap = document.createElement("div");
      wrap.className = "ksug";
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      const unit = Number(suggestion.koulchiPrice) || Number(suggestion.price) || 0;
      addBtn.textContent = `+ ${getProductName(suggestion)} · ${unit} MAD`;
      addBtn.title = sheet.addPack;
      addBtn.addEventListener("click", () => {
        addToCart(suggestion.id);
      });
      wrap.appendChild(addBtn);
      pill.appendChild(wrap);
    }
  }

  pill.classList.add("is-open");
}

/* ============================================================
   4. QUIZ « TROUVE TON GADGET »
   ============================================================ */
const QUIZ_KEYWORDS = {
  home: ["smart", "maison", "home", "domot", "plug", "led", "lampe", "camera"],
  audio: ["audio", "ecouteur", "écouteur", "casque", "speaker", "enceinte", "earbud"],
  watch: ["montre", "watch", "bracelet", "band", "smartwatch"],
  accessories: ["accessoire", "charge", "cable", "câble", "support", "power", "hub"],
};

function openQuiz() {
  const products = getProducts() || [];
  const sheet = m();
  const answers = { usage: null, budget: null, priority: null, level: null };
  let step = 0;

  let modal = document.getElementById("quizModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "quizModal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.remove("is-open");
    });
  }
  modal.textContent = "";

  const box = document.createElement("div");
  box.className = "quiz-sheet";
  modal.appendChild(box);

  const title = document.createElement("h3");
  title.textContent = sheet.quizTitle;
  const sub = document.createElement("p");
  sub.className = "quiz-sub";
  sub.textContent = sheet.quizSub;
  const body = document.createElement("div");
  box.append(title, sub, body);

  const nav = document.createElement("div");
  nav.className = "quiz-nav";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "quiz-close";
  closeBtn.textContent = sheet.close;
  closeBtn.addEventListener("click", () => modal.classList.remove("is-open"));
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "quiz-next";
  nextBtn.textContent = sheet.next;
  nextBtn.disabled = true;
  nav.append(closeBtn, nextBtn);
  box.appendChild(nav);

  function questionBlock(label, options, key) {
    const q = document.createElement("div");
    q.className = "quiz-q";
    q.textContent = label;
    body.appendChild(q);
    options.forEach(([value, text]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quiz-opt";
      btn.textContent = text;
      btn.addEventListener("click", () => {
        answers[key] = value;
        q.querySelectorAll(".quiz-opt").forEach((b) => b.classList.remove("is-on"));
        btn.classList.add("is-on");
        nextBtn.disabled = false;
      });
      body.appendChild(btn);
    });
  }


  function renderResults() {
    body.textContent = "";
    nextBtn.style.display = "none";
    const h = document.createElement("div");
    h.className = "quiz-q";
    h.textContent = sheet.results;
    body.appendChild(h);

    const budget = Number(answers.budget) || 99999;
    const words = QUIZ_KEYWORDS[answers.usage] || [];
    const scored = products
      .map((p) => {
        const hay = `${p.category || ""} ${p.nameFr || ""} ${p.nameEn || ""} ${p.nameAr || ""}`.toLowerCase();
        let score = 0;
        if (words.some((w) => hay.indexOf(w) !== -1)) score += 40;
        const price = Number(p.price) || 0;
        if (price > 0 && price <= budget) score += 25;
        score += Math.min(20, (Number(p.ratingAvg) || 0) * 5);
        if ((Number(p.stock) || 0) > 0) score += 5;
        if (answers.priority === "price") score -= price / 500;
        if (answers.priority === "quality") score += (Number(p.ratingAvg) || 0) * 2;
        return { p, score, price };
      })
      .filter((x) => x.score > 0 && x.price > 0 && x.price <= budget)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (scored.length === 0) {
      const p = document.createElement("p");
      p.textContent = sheet.noResult;
      body.appendChild(p);
    } else {
      scored.forEach(({ p, price }) => {
        const row = document.createElement("div");
        row.className = "quiz-result";
        const img = document.createElement("img");
        img.src = getProductImageUrl(p) || getFallbackImage(getProductName(p));
        img.alt = "";
        img.loading = "lazy";
        const meta = document.createElement("div");
        const name = document.createElement("div");
        name.textContent = getProductName(p);
        name.style.fontWeight = "700";
        name.style.fontSize = ".85rem";
        const priceEl = document.createElement("div");
        priceEl.textContent = `${price} MAD`;
        priceEl.style.fontSize = ".8rem";
        priceEl.style.color = "var(--text-muted, #5c5c5c)";
        const link = document.createElement("a");
        link.href = `/produit?slug=${encodeURIComponent(p.slug || "")}`;
        link.textContent = sheet.addCart;
        meta.append(name, priceEl, link);
        row.append(img, meta);
        body.appendChild(row);
      });
    }

    const again = document.createElement("button");
    again.type = "button";
    again.className = "quiz-next";
    again.textContent = sheet.restart;
    again.addEventListener("click", () => {
      step = 0;
      answers.usage = null;
      answers.budget = null;
      answers.priority = null;
      answers.level = null;
      nextBtn.style.display = "";
      renderStep();
    });
    body.appendChild(again);
  }

  function renderStep() {
    body.textContent = "";
    nextBtn.disabled = true;
    if (step === 0) {
      questionBlock(sheet.q1, [
        ["home", sheet.q1a], ["audio", sheet.q1b],
        ["watch", sheet.q1c], ["accessories", sheet.q1d],
      ], "usage");
    } else if (step === 1) {
      questionBlock(sheet.q2, [
        ["200", sheet.q2a], ["500", sheet.q2b],
        ["1000", sheet.q2c], ["99999", sheet.q2d],
      ], "budget");
    } else if (step === 2) {
      questionBlock(sheet.q3, [
        ["price", sheet.q3a], ["quality", sheet.q3b], ["new", sheet.q3c],
      ], "priority");
    } else if (step === 3) {
      questionBlock(sheet.q4, [["beginner", sheet.q4a], ["advanced", sheet.q4b]], "level");
    } else {
      renderResults();
    }
  }

  nextBtn.addEventListener("click", () => {
    if (step < 4) {
      step += 1;
      renderStep();
    }
  });

  renderStep();
  modal.classList.add("is-open");
}

function injectQuizButton() {
  const path = window.location.pathname;
  const isHome = path === "/" || path.endsWith("/index.html") || path === "";
  if (!isHome) return;
  const actions = document.querySelector(".hero-actions");
  if (!actions || actions.querySelector(".quiz-trigger")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-ghost quiz-trigger";
  btn.textContent = `🧭 ${m().quizBtn}`;
  btn.addEventListener("click", openQuiz);
  actions.appendChild(btn);
}

/* ============================================================
   INITIALISATION (idempotente, fail-safe)
   ============================================================ */
function refresh() {
  try { attachLiveGlass(); } catch (e) { /* non bloquant */ }
  try { attachCompareButtons(); } catch (e) { /* non bloquant */ }
  try { renderCompareBar(); } catch (e) { /* non bloquant */ }
  try { renderKoulchiPill(); } catch (e) { /* non bloquant */ }
}

let _initDone = false;

/**
 * Point d'entrée unique appelé par js/app.js.
 * @returns {void}
 */
export function initSmartWidgets() {
  if (typeof document === "undefined" || _initDone) return;
  _initDone = true;

  try { ensureStyles(); } catch (e) { /* non bloquant */ }
  try { injectQuizButton(); } catch (e) { /* non bloquant */ }

  refresh();

  /* Le catalogue est re-rendu (filtres, tri, pagination) : on recâble
     les nouveaux nœuds sans toucher au code de rendu. */
  const grid = document.getElementById("productsGrid");
  if (grid && typeof MutationObserver === "function") {
    const observer = new MutationObserver(() => refresh());
    observer.observe(grid, { childList: true });
  }

  document.addEventListener("cart-updated", () => {
    try { renderKoulchiPill(); } catch (e) { /* non bloquant */ }
  });

  document.addEventListener("lang-changed", () => {
    document.querySelectorAll(".cmp-btn").forEach((b) => b.remove());
    ["cmpBar", "koulchiPill", "quizModal"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    document.querySelectorAll(".quiz-trigger").forEach((b) => b.remove());
    try { injectQuizButton(); } catch (e) { /* non bloquant */ }
    refresh();
  });
}

export default initSmartWidgets;

