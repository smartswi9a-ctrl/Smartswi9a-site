/* ============================================================
   js/vendor-flash.js
   DASHBOARD VENDEUR — ONGLET VENTES FLASH
   ============================================================
   Un vendeur cree ses propres ventes flash, SANS validation admin
   (decision produit 2026-11-16).

   GARDE-FOUS
     - le vendeur ne selectionne que SES produits ;
     - `scope` est force a 'vendor' et `vendorId` a son uid ;
     - `status` est force a 'active' : pas de brouillon cote vendeur,
       la vente prend effet immediatement ;
     - `soldCount` n est jamais ecrit par le client (compteur serveur) ;
     - les regles Firestore revalident tout cela (source de verite).

   Le prix remise est recalcule cote serveur a la commande : un vendeur
   ne peut pas vendre a un prix different de celui qu il a declare, et
   un client ne peut pas forger de prix.
   ============================================================ */

import { db, auth } from "./firebase.js";
import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc,
  query, where, limit, serverTimestamp
} from "firebase/firestore";
import { escapeHTML, toDate } from "./utils.js";
import { invalidateFlashSalesCache } from "./flash-sales.js";

const MAX_VENDOR_FLASH = 50;
const MAX_VENDOR_PRODUCTS = 300;

/* Compteur d erreurs de formulaire affiche dans la zone dediee. */
function setMsg(elId, text, isError = true) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "var(--danger, #d9534f)" : "#22c55e";
}

function toLocalInputValue(date) {
  const d = date instanceof Date ? date : toDate(date);
  if (!d) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

let _vfProducts = null;
let _vfSelected = new Set();
let _vfReady = false;

/* ---------------- Produits du vendeur ---------------- */

async function loadVendorProducts() {
  if (_vfProducts) return _vfProducts;
  const uid = auth.currentUser?.uid;
  if (!uid) { _vfProducts = []; return _vfProducts; }

  const q = query(
    collection(db, "products"),
    where("vendorId", "==", uid),
    where("status", "==", "approved"),
    limit(MAX_VENDOR_PRODUCTS)
  );
  const snap = await getDocs(q);
  _vfProducts = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      name: String(data.nameFr || data.nameEn || "Produit"),
      price: Number(data.price) || 0
    };
  });
  return _vfProducts;
}

function renderVendorPicker(filter = "") {
  const box = document.getElementById("vfProductPicker");
  if (!box) return;
  const list = _vfProducts || [];
  if (list.length === 0) {
    box.innerHTML = `<div style="padding:1rem;text-align:center;color:var(--text-muted);">
      Aucun produit approuvé. Ajoutez et faites approuver des produits avant de lancer une vente flash.</div>`;
    return;
  }
  const needle = filter.trim().toLowerCase();
  const filtered = needle ? list.filter((p) => p.name.toLowerCase().includes(needle)) : list;
  if (filtered.length === 0) {
    box.innerHTML = `<div style="padding:1rem;text-align:center;color:var(--text-muted);">Aucun produit ne correspond.</div>`;
    return;
  }
  box.innerHTML = filtered.map((p) => {
    const checked = _vfSelected.has(p.id) ? "checked" : "";
    return `<label style="display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0.25rem;cursor:pointer;">
      <input type="checkbox" data-vf-product="${escapeHTML(p.id)}" ${checked}>
      <span style="flex:1;">${escapeHTML(p.name)}</span>
      <span style="color:var(--gold);font-size:0.8rem;white-space:nowrap;">${p.price} MAD</span>
    </label>`;
  }).join("");
  box.querySelectorAll("[data-vf-product]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-vf-product");
      if (e.target.checked) _vfSelected.add(id); else _vfSelected.delete(id);
      const c = document.getElementById("vfSelectedCount");
      if (c) c.textContent = `(${_vfSelected.size} sélectionné${_vfSelected.size > 1 ? "s" : ""})`;
    });
  });
}

/* ---------------- Rendu principal de l onglet ---------------- */

export async function renderVendorFlash(container) {
  if (!container) return;
  const uid = auth.currentUser?.uid;
  if (!uid) {
    container.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--text-muted);">Connexion requise.</div>`;
    return;
  }

  container.innerHTML = `
    <div style="background:var(--card-bg,#fff);border:1px solid var(--border);border-radius:12px;padding:1.25rem;margin-bottom:1.5rem;">
      <h3 style="margin:0 0 0.25rem;font-family:var(--font-secondary);color:var(--gold);">⚡ Créer une vente flash</h3>
      <p style="margin:0 0 1rem;font-size:0.85rem;color:var(--text-muted);">
        La remise s'applique immédiatement sur vos produits sélectionnés, jusqu'à la date de fin.
        Vous pouvez l'arrêter à tout moment.
      </p>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.75rem;">
        <div>
          <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:0.3rem;">Titre *</label>
          <input type="text" id="vfTitle" maxlength="80" placeholder="Ex. Promo week-end -25%" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:8px;">
        </div>
        <div>
          <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:0.3rem;">Remise *</label>
          <select id="vfDiscountType" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:8px;">
            <option value="percent">Pourcentage (%)</option>
            <option value="fixed">Montant fixe (MAD)</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:0.3rem;">Valeur *</label>
          <input type="number" id="vfDiscountValue" min="1" step="1" value="20" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:8px;">
        </div>
        <div>
          <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:0.3rem;">Limite de ventes</label>
          <input type="number" id="vfMaxQuantity" min="0" step="1" value="0" placeholder="0 = illimité" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:8px;">
        </div>
        <div>
          <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:0.3rem;">Début *</label>
          <input type="datetime-local" id="vfStartsAt" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:8px;">
        </div>
        <div>
          <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:0.3rem;">Fin *</label>
          <input type="datetime-local" id="vfEndsAt" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:8px;">
        </div>
      </div>

      <div style="margin-top:1rem;">
        <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:0.3rem;">
          Produits concernés * <span id="vfSelectedCount" style="color:var(--gold);">(0 sélectionné)</span>
        </label>
        <input type="text" id="vfProductSearch" placeholder="🔍 Filtrer mes produits..." style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:8px;margin-bottom:0.4rem;">
        <div id="vfProductPicker" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:0.5rem;">
          <div style="text-align:center;color:var(--text-muted);">⏳ Chargement...</div>
        </div>
      </div>

      <div id="vfMsg" style="margin-top:0.75rem;font-size:0.85rem;"></div>

      <div style="display:flex;gap:0.6rem;margin-top:1rem;flex-wrap:wrap;">
        <button id="vfSaveBtn" type="button" style="background:var(--gold);color:#fff;border:none;padding:0.6rem 1.2rem;border-radius:8px;font-weight:600;cursor:pointer;">🚀 Lancer la vente flash</button>
        <button id="vfResetBtn" type="button" style="background:transparent;border:1px solid var(--border);padding:0.6rem 1.2rem;border-radius:8px;cursor:pointer;">↺ Réinitialiser</button>
      </div>
    </div>

    <h3 style="font-family:var(--font-secondary);color:var(--gold);margin:0 0 0.75rem;">Mes ventes flash</h3>
    <div id="vfList"><div style="text-align:center;color:var(--text-muted);">⏳ Chargement...</div></div>
  `;

  /* Valeurs par defaut : maintenant -> +24h */
  const sv = document.getElementById("vfStartsAt");
  if (sv) sv.value = toLocalInputValue(new Date());
  const ev = document.getElementById("vfEndsAt");
  if (ev) ev.value = toLocalInputValue(new Date(Date.now() + 24 * 3600 * 1000));

  try {
    await loadVendorProducts();
  } catch (e) {
    console.warn("[vendor-flash] produits :", e?.message);
    _vfProducts = [];
  }
  renderVendorPicker();

  if (!_vfReady) {
    _vfReady = true;
    document.getElementById("vfSaveBtn")?.addEventListener("click", saveVendorFlash);
    document.getElementById("vfResetBtn")?.addEventListener("click", () => renderVendorFlash(container));
    document.getElementById("vfProductSearch")?.addEventListener("input", (e) => renderVendorPicker(e.target.value));
  }

  await renderVendorFlashList();
}

/* ---------------- Enregistrement ---------------- */

async function saveVendorFlash() {
  const uid = auth.currentUser?.uid;
  if (!uid) { setMsg("vfMsg", "Connexion requise."); return; }

  const title = (document.getElementById("vfTitle")?.value || "").trim();
  const discountType = document.getElementById("vfDiscountType")?.value || "percent";
  const discountValue = Number(document.getElementById("vfDiscountValue")?.value || 0);
  const maxQty = Number(document.getElementById("vfMaxQuantity")?.value || 0);
  const startsAt = fromLocalInputValue(document.getElementById("vfStartsAt")?.value);
  const endsAt = fromLocalInputValue(document.getElementById("vfEndsAt")?.value);

  if (title.length < 3) { setMsg("vfMsg", "Le titre doit faire au moins 3 caractères."); return; }
  if (!Number.isFinite(discountValue) || discountValue <= 0) { setMsg("vfMsg", "La valeur de remise doit être positive."); return; }
  if (discountType === "percent" && discountValue > 90) { setMsg("vfMsg", "Une remise en pourcentage ne peut pas dépasser 90 %."); return; }
  if (_vfSelected.size === 0) { setMsg("vfMsg", "Sélectionnez au moins un de vos produits."); return; }
  if (!startsAt || !endsAt) { setMsg("vfMsg", "Les dates de début et de fin sont obligatoires."); return; }
  if (endsAt.getTime() <= startsAt.getTime()) { setMsg("vfMsg", "La date de fin doit être après la date de début."); return; }

  const btn = document.getElementById("vfSaveBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Lancement..."; }

  try {
    await addDoc(collection(db, "flash_sales"), {
      title,
      slug: title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "vente-flash",
      productIds: [..._vfSelected],
      discountType,
      discountValue: Math.round(discountValue),
      startsAt,
      endsAt,
      /* Forces cote client ; les regles Firestore revalident. */
      scope: "vendor",
      vendorId: uid,
      maxQuantity: maxQty > 0 ? Math.round(maxQty) : null,
      status: "active",
      soldCount: 0,
      createdAt: serverTimestamp(),
      createdBy: uid,
      updatedAt: serverTimestamp()
    });

    invalidateFlashSalesCache();
    setMsg("vfMsg", "✅ Vente flash lancée : la remise est active dès maintenant.", false);
    _vfSelected = new Set();
    document.getElementById("vfTitle").value = "";
    const c = document.getElementById("vfSelectedCount");
    if (c) c.textContent = "(0 sélectionné)";
    renderVendorPicker();
    await renderVendorFlashList();
  } catch (e) {
    console.error("[vendor-flash] creation :", e);
    setMsg("vfMsg", "Échec : " + (e?.message || "erreur inconnue"));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🚀 Lancer la vente flash"; }
  }
}

/* ---------------- Liste des ventes du vendeur ---------------- */

export async function renderVendorFlashList() {
  const box = document.getElementById("vfList");
  if (!box) return;
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  try {
    const q = query(collection(db, "flash_sales"), where("vendorId", "==", uid), limit(MAX_VENDOR_FLASH));
    const snap = await getDocs(q);
    const sales = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (sales.length === 0) {
      box.innerHTML = `<div style="padding:1.5rem;text-align:center;color:var(--text-muted);border:1px dashed var(--border);border-radius:10px;">
        Aucune vente flash. Créez-en une ci-dessus.</div>`;
      return;
    }

    sales.sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));

    const now = Date.now();
    box.innerHTML = sales.map((s) => {
      const start = toDate(s.startsAt);
      const end = toDate(s.endsAt);
      let label = "⏹️ Terminée";
      let color = "var(--text-muted)";
      if (s.status === "active") {
        if (start && now < start.getTime()) { label = "⏳ Programmée"; color = "#eab308"; }
        else if (end && now > end.getTime()) { label = "⏹️ Échue"; color = "var(--text-muted)"; }
        else if (s.maxQuantity != null && Number(s.soldCount || 0) >= Number(s.maxQuantity)) { label = "🔒 Épuisée"; color = "#f97316"; }
        else { label = "🟢 En cours"; color = "#22c55e"; }
      }
      const typeLabel = s.discountType === "percent" ? `-${s.discountValue}%` : `-${s.discountValue} MAD`;
      const nProducts = Array.isArray(s.productIds) ? s.productIds.length : 0;
      const quota = s.maxQuantity != null ? `${s.soldCount || 0}/${s.maxQuantity}` : `${s.soldCount || 0} vendu(s)`;
      return `<div style="border:1px solid var(--border);border-radius:10px;padding:0.9rem;margin-bottom:0.6rem;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div style="font-weight:600;">${escapeHTML(s.title || "Sans titre")}
            <span style="color:var(--gold);margin-left:0.4rem;">${escapeHTML(typeLabel)}</span>
          </div>
          <div style="font-size:0.8rem;margin-top:0.25rem;">
            <span style="color:${color};font-weight:600;">${label}</span>
            · ${nProducts} produit(s) · ${escapeHTML(quota)}
          </div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.15rem;">
            📅 ${start ? start.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—"}
            → ${end ? end.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—"}
          </div>
        </div>
        <div style="display:flex;gap:0.4rem;align-items:flex-start;">
          <button type="button" data-vf-toggle="${escapeHTML(s.id)}" style="border:1px solid var(--border);background:transparent;padding:0.4rem 0.8rem;border-radius:8px;cursor:pointer;font-size:0.82rem;">
            ${s.status === "active" ? "⏸️ Arrêter" : "▶️ Relancer"}
          </button>
          <button type="button" data-vf-del="${escapeHTML(s.id)}" style="border:1px solid var(--danger,#d9534f);color:var(--danger,#d9534f);background:transparent;padding:0.4rem 0.7rem;border-radius:8px;cursor:pointer;font-size:0.82rem;">🗑️</button>
        </div>
      </div>`;
    }).join("");

    box.querySelectorAll("[data-vf-toggle]").forEach((b) => {
      b.addEventListener("click", async () => {
        const id = b.getAttribute("data-vf-toggle");
        const sale = sales.find((x) => x.id === id);
        if (!sale) return;
        b.disabled = true;
        try {
          await updateDoc(doc(db, "flash_sales", id), {
            status: sale.status === "active" ? "draft" : "active",
            updatedAt: serverTimestamp()
          });
          invalidateFlashSalesCache();
          await renderVendorFlashList();
        } catch (e) {
          console.error("[vendor-flash] bascule :", e);
          setMsg("vfMsg", "Impossible de changer le statut.");
          b.disabled = false;
        }
      });
    });

    box.querySelectorAll("[data-vf-del]").forEach((b) => {
      b.addEventListener("click", async () => {
        const id = b.getAttribute("data-vf-del");
        const sale = sales.find((x) => x.id === id);
        if (!confirm(`Supprimer « ${sale?.title || "cette vente"} » ? Les prix normaux seront rétablis.`)) return;
        b.disabled = true;
        try {
          await deleteDoc(doc(db, "flash_sales", id));
          invalidateFlashSalesCache();
          await renderVendorFlashList();
        } catch (e) {
          console.error("[vendor-flash] suppression :", e);
          setMsg("vfMsg", "Impossible de supprimer.");
          b.disabled = false;
        }
      });
    });
  } catch (e) {
    console.error("[vendor-flash] liste :", e);
    box.innerHTML = `<div style="color:var(--text-muted);">Erreur de chargement des ventes flash.</div>`;
  }
}



