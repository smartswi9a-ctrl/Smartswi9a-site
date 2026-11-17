/* ============================================================
   js/admin-flash.js
   PANNEAU ADMIN — ONGLET VENTES FLASH
   ============================================================
   Gere la creation et l edition des ventes flash depuis l admin.

   Ce module est SEPARE de admin.js (5 139 lignes) pour ne pas
   aggraver le monolithe : premier pas du decoupage demande au point 8
   de l audit du 2026-11-16.

   SECURITE (cote client ; les regles Firestore priment) :
     - seul un admin plateforme peut ecrire ici ;
     - `soldCount` n est JAMAIS ecrit par le client : pose a 0 a la
       creation, seul le serveur l incremente ;
     - le prix remise est recalcule cote serveur a la commande.
   ============================================================ */

import { db, auth } from "./firebase.js";
import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc,
  query, where, limit, serverTimestamp
} from "firebase/firestore";
import { escapeHTML, toDate } from "./utils.js";
import { showToast, confirmAction } from "./ui-core.js";
import { invalidateFlashSalesCache } from "./flash-sales.js";

const MAX_FLASH_LIST = 100;
const MAX_PICKER_PRODUCTS = 500;

let _productsCache = null;
let _selectedProductIds = new Set();

/* ---------------- Utilitaires dates ---------------- */

function toLocalInputValue(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : toDate(date);
  if (!d) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(v) {
  const d = toDate(v);
  return d ? d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
}

/* ---------------- Chargement des produits ---------------- */

async function loadProductsForPicker() {
  if (_productsCache) return _productsCache;
  const q = query(collection(db, "products"), where("status", "==", "approved"), limit(MAX_PICKER_PRODUCTS));
  const snap = await getDocs(q);
  _productsCache = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      name: String(data.nameFr || data.nameEn || "Produit"),
      price: Number(data.price) || 0,
      vendorId: String(data.vendorId || "smartswi9a")
    };
  });
  return _productsCache;
}

/* ---------------- Rendu du selecteur de produits ---------------- */

function updateSelectedCount() {
  const el = document.getElementById("fSelectedCount");
  if (el) el.textContent = `(${_selectedProductIds.size} sélectionné${_selectedProductIds.size > 1 ? "s" : ""})`;
}

function renderProductPicker(filter = "") {
  const container = document.getElementById("fProductPicker");
  if (!container) return;
  const list = _productsCache || [];
  if (list.length === 0) {
    container.innerHTML = `<div class="admin-empty">Aucun produit approuvé. Créez d'abord des produits.</div>`;
    return;
  }

  const needle = filter.trim().toLowerCase();
  const filtered = needle ? list.filter((p) => p.name.toLowerCase().includes(needle)) : list;

  if (filtered.length === 0) {
    container.innerHTML = `<div class="admin-empty">Aucun produit ne correspond à « ${escapeHTML(filter)} ».</div>`;
    return;
  }

  container.innerHTML = filtered.map((p) => {
    const checked = _selectedProductIds.has(p.id) ? "checked" : "";
    return `<label style="display:flex;align-items:center;gap:0.6rem;padding:0.35rem 0.25rem;cursor:pointer;">
      <input type="checkbox" data-flash-product="${escapeHTML(p.id)}" ${checked}>
      <span style="flex:1;">${escapeHTML(p.name)}</span>
      <span style="color:var(--gold);font-size:0.8rem;white-space:nowrap;">${p.price} MAD</span>
    </label>`;
  }).join("");

  container.querySelectorAll("[data-flash-product]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-flash-product");
      if (e.target.checked) _selectedProductIds.add(id);
      else _selectedProductIds.delete(id);
      updateSelectedCount();
    });
  });
}

/* ---------------- Formulaire ---------------- */

export function resetFlashForm() {
  _selectedProductIds = new Set();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set("fEditId", "");
  set("fTitle", "");
  set("fDiscountType", "percent");
  set("fDiscountValue", "20");
  set("fStatus", "draft");
  set("fMaxQuantity", "0");
  set("fProductSearch", "");
  set("fStartsAt", toLocalInputValue(new Date()));
  set("fEndsAt", toLocalInputValue(new Date(Date.now() + 24 * 3600 * 1000)));

  const title = document.getElementById("flashFormTitle");
  if (title) title.textContent = "⚡ Créer une vente flash";

  renderProductPicker();
  updateSelectedCount();
}

function fillFlashForm(sale) {
  _selectedProductIds = new Set((sale.productIds || []).map(String));
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set("fEditId", sale.id);
  set("fTitle", sale.title || "");
  set("fDiscountType", sale.discountType || "percent");
  set("fDiscountValue", String(sale.discountValue || ""));
  set("fStatus", sale.status || "draft");
  set("fMaxQuantity", sale.maxQuantity != null ? String(sale.maxQuantity) : "0");
  set("fStartsAt", toLocalInputValue(toDate(sale.startsAt)));
  set("fEndsAt", toLocalInputValue(toDate(sale.endsAt)));

  const title = document.getElementById("flashFormTitle");
  if (title) title.textContent = "✏️ Modifier la vente flash";

  renderProductPicker();
  updateSelectedCount();
  document.getElementById("tab-flash")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------------- Enregistrement ---------------- */

async function saveFlashSale() {
  const btn = document.getElementById("fSaveBtn");
  const editId = document.getElementById("fEditId")?.value || "";
  const title = (document.getElementById("fTitle")?.value || "").trim();
  const discountType = document.getElementById("fDiscountType")?.value || "percent";
  const discountValue = Number(document.getElementById("fDiscountValue")?.value || 0);
  const status = document.getElementById("fStatus")?.value || "draft";
  const maxQuantityRaw = Number(document.getElementById("fMaxQuantity")?.value || 0);
  const startsAt = fromLocalInputValue(document.getElementById("fStartsAt")?.value);
  const endsAt = fromLocalInputValue(document.getElementById("fEndsAt")?.value);

  /* Validations client (les regles Firestore revalident de toute facon). */
  if (!title || title.length < 3) { showToast("Le titre doit faire au moins 3 caractères.", 5000); return; }
  if (!Number.isFinite(discountValue) || discountValue <= 0) { showToast("La valeur de remise doit être positive.", 5000); return; }
  if (discountType === "percent" && discountValue > 90) { showToast("Une remise en pourcentage ne peut pas dépasser 90 %.", 5000); return; }
  if (_selectedProductIds.size === 0) { showToast("Sélectionnez au moins un produit.", 5000); return; }
  if (!startsAt || !endsAt) { showToast("Les dates de début et de fin sont obligatoires.", 5000); return; }
  if (endsAt.getTime() <= startsAt.getTime()) { showToast("La date de fin doit être après la date de début.", 5000); return; }

  if (btn) { btn.disabled = true; btn.textContent = "⏳ Enregistrement..."; }

  try {
    const user = auth.currentUser;
    if (!user) throw new Error("Session administrateur expirée.");

    const payload = {
      title,
      slug: title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "vente-flash",
      productIds: [..._selectedProductIds],
      discountType,
      discountValue: Math.round(discountValue),
      startsAt,
      endsAt,
      scope: "platform",
      vendorId: null,
      maxQuantity: maxQuantityRaw > 0 ? Math.round(maxQuantityRaw) : null,
      status,
      updatedAt: serverTimestamp()
    };

    if (editId) {
      /* soldCount n est PAS touche a l edition : compteur serveur. */
      await updateDoc(doc(db, "flash_sales", editId), payload);
      showToast("Vente flash mise à jour.", 5000);
    } else {
      await addDoc(collection(db, "flash_sales"), {
        ...payload,
        soldCount: 0,
        createdAt: serverTimestamp(),
        createdBy: user.uid
      });
      showToast("Vente flash créée.", 5000);
    }

    invalidateFlashSalesCache();
    resetFlashForm();
    await renderFlashList();
  } catch (e) {
    console.error("[admin-flash] enregistrement impossible :", e);
    showToast("Échec : " + (e?.message || "erreur inconnue"), 6000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "💾 Enregistrer"; }
  }
}

/* ---------------- Liste des ventes ---------------- */

function flashStatusBadge(sale) {
  const now = Date.now();
  const start = toDate(sale.startsAt);
  const end = toDate(sale.endsAt);
  if (sale.status !== "active") {
    return sale.status === "draft"
      ? `<span style="color:var(--text-muted);">📝 Brouillon</span>`
      : `<span style="color:var(--text-muted);">⏹️ Terminée</span>`;
  }
  if (start && now < start.getTime()) return `<span style="color:#eab308;">⏳ Programmée</span>`;
  if (end && now > end.getTime()) return `<span style="color:var(--text-muted);">⏹️ Échue</span>`;
  if (sale.maxQuantity != null && Number(sale.soldCount || 0) >= Number(sale.maxQuantity)) {
    return `<span style="color:#f97316;">🔒 Épuisée</span>`;
  }
  return `<span style="color:#22c55e;">🟢 En cours</span>`;
}

export async function renderFlashList() {
  const container = document.getElementById("adminFlashList");
  if (!container) return;
  container.innerHTML = `<div class="admin-loading">⏳ Chargement des ventes flash...</div>`;

  try {
    const snap = await getDocs(query(collection(db, "flash_sales"), limit(MAX_FLASH_LIST)));
    const sales = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (sales.length === 0) {
      container.innerHTML = `<div class="admin-empty">Aucune vente flash. Créez-en une ci-dessus.</div>`;
      return;
    }

    sales.sort((a, b) => {
      const da = toDate(a.createdAt)?.getTime() || 0;
      const dbv = toDate(b.createdAt)?.getTime() || 0;
      return dbv - da;
    });

    container.innerHTML = sales.map((s) => {
      const typeLabel = s.discountType === "percent" ? `-${s.discountValue}%` : `-${s.discountValue} MAD`;
      const count = Array.isArray(s.productIds) ? s.productIds.length : 0;
      const quota = s.maxQuantity != null ? `${s.soldCount || 0}/${s.maxQuantity}` : `${s.soldCount || 0} vendu(s)`;
      return `<div class="admin-card" style="margin-bottom:0.75rem;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
          <div style="flex:1;min-width:220px;">
            <div style="font-weight:600;font-size:1.02rem;">${escapeHTML(s.title || "Sans titre")}
              <span style="color:var(--gold);margin-left:0.5rem;">${escapeHTML(typeLabel)}</span>
            </div>
            <div style="font-size:0.82rem;color:var(--text-muted);margin-top:0.3rem;">
              ${flashStatusBadge(s)} · ${count} produit(s) · ${escapeHTML(quota)}
            </div>
            <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.2rem;">
              📅 ${fmtDate(s.startsAt)} → ${fmtDate(s.endsAt)}
            </div>
          </div>
          <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
            <button class="admin-btn-secondary" data-flash-edit="${escapeHTML(s.id)}" style="margin:0;">✏️ Modifier</button>
            <button class="admin-btn-secondary" data-flash-toggle="${escapeHTML(s.id)}" style="margin:0;">${s.status === "active" ? "⏸️ Désactiver" : "▶️ Activer"}</button>
            <button class="admin-btn-secondary" data-flash-del="${escapeHTML(s.id)}" style="margin:0;color:var(--danger);">🗑️</button>
          </div>
        </div>
      </div>`;
    }).join("");

    /* Actions */
    container.querySelectorAll("[data-flash-edit]").forEach((b) => {
      b.addEventListener("click", () => {
        const sale = sales.find((x) => x.id === b.getAttribute("data-flash-edit"));
        if (sale) fillFlashForm(sale);
      });
    });

    container.querySelectorAll("[data-flash-toggle]").forEach((b) => {
      b.addEventListener("click", async () => {
        const id = b.getAttribute("data-flash-toggle");
        const sale = sales.find((x) => x.id === id);
        if (!sale) return;
        b.disabled = true;
        try {
          await updateDoc(doc(db, "flash_sales", id), {
            status: sale.status === "active" ? "draft" : "active",
            updatedAt: serverTimestamp()
          });
          invalidateFlashSalesCache();
          showToast(sale.status === "active" ? "Vente flash désactivée." : "Vente flash activée.", 4000);
          await renderFlashList();
        } catch (e) {
          console.error("[admin-flash] bascule statut :", e);
          showToast("Échec du changement de statut.", 5000);
          b.disabled = false;
        }
      });
    });

    container.querySelectorAll("[data-flash-del]").forEach((b) => {
      b.addEventListener("click", async () => {
        const id = b.getAttribute("data-flash-del");
        const sale = sales.find((x) => x.id === id);
        const ok = await confirmAction(
          `Supprimer définitivement « ${sale?.title || "cette vente"} » ? Les prix normaux seront rétablis.`,
          { title: "Supprimer la vente flash", confirmText: "Supprimer", cancelText: "Annuler", variant: "danger" }
        );
        if (!ok) return;
        b.disabled = true;
        try {
          await deleteDoc(doc(db, "flash_sales", id));
          invalidateFlashSalesCache();
          showToast("Vente flash supprimée.", 4000);
          await renderFlashList();
        } catch (e) {
          console.error("[admin-flash] suppression :", e);
          showToast("Échec de la suppression.", 5000);
          b.disabled = false;
        }
      });
    });
  } catch (e) {
    console.error("[admin-flash] liste impossible :", e);
    container.innerHTML = `<div class="admin-empty" style="color:var(--danger);">Erreur de chargement : ${escapeHTML(e?.message || "")}</div>`;
  }
}

/* ---------------- Initialisation de l onglet ---------------- */

let _flashInitDone = false;

/**
 * A brancher au clic sur l onglet « Ventes Flash ».
 * Idempotent : les listeners ne sont poses qu une seule fois.
 * @returns {Promise<void>}
 */
export async function initFlashTab() {
  const container = document.getElementById("tab-flash");
  if (!container) return;

  if (!_flashInitDone) {
    _flashInitDone = true;

    document.getElementById("fSaveBtn")?.addEventListener("click", saveFlashSale);
    document.getElementById("fResetBtn")?.addEventListener("click", resetFlashForm);

    const search = document.getElementById("fProductSearch");
    if (search) search.addEventListener("input", (e) => renderProductPicker(e.target.value));

    _productsCache = null;
    try {
      await loadProductsForPicker();
    } catch (e) {
      console.warn("[admin-flash] produits indisponibles :", e?.message);
      _productsCache = [];
    }
    resetFlashForm();
  }

  await renderFlashList();
}


