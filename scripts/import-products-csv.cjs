#!/usr/bin/env node
/**
 * import-products-csv.cjs — IMPORT DU CATALOGUE (audit 2026-11-20)
 * ---------------------------------------------------------------------------
 * La collection `products` est vide : aucune vente n'est possible. Ce script
 * importe un catalogue CSV dans Firestore avec validation stricte.
 *
 * Usage :
 *   node scripts/import-products-csv.cjs scripts/products-template.csv --dry-run
 *   node scripts/import-products-csv.cjs mon-catalogue.csv
 *   node scripts/import-products-csv.cjs mon-catalogue.csv --update   (upsert)
 *
 * Credentials (hors --dry-run) : ADC ou GOOGLE_APPLICATION_CREDENTIALS.
 *
 * COLONNES (séparateur , ou ; — auto-détecté)
 *   name_fr*        Nom français
 *   price*          Prix de vente (MAD)
 *   category*       Catégorie (ex. Smart Home, Audio, Montres)
 *   koulchi_price*  Prix de groupe, STRICTEMENT < price (règle Firestore)
 *   stock*          Entier >= 0
 *   sku*            6 caractères minimum, unique
 *   name_en, name_ar, desc_fr, desc_en, desc_ar, img, old_price, slug, vendor_id
 *
 * Sécurité :
 *   - `status` est forcé à 'approved' (jamais lu depuis le CSV) ;
 *   - aucun champ réservé (salesCount, ratingAvg, ratingCount) n'est écrit ;
 *   - les lignes invalides sont REJETÉES et listées, jamais corrigées en silence.
 * ---------------------------------------------------------------------------
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ID = "smartswi9a-31063";
const BATCH_SIZE = 400;
const REQUIRED = ["name_fr", "price", "category", "koulchi_price", "stock", "sku"];

const argv = process.argv.slice(2);
const csvPath = argv.find((a) => !a.startsWith("--"));
const DRY_RUN = argv.includes("--dry-run");
const UPSERT = argv.includes("--update");

process.on("unhandledRejection", (r) => console.warn("[import] Unhandled:", r));

/* --------------------------------------------- CSV */
/** Parse un CSV en gérant guillemets, virgules et retours à la ligne. */
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstLine = clean.slice(0, clean.indexOf("\n") === -1 ? clean.length : clean.indexOf("\n"));
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";

  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === sep) { row.push(cell); cell = ""; continue; }
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += c;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }

  const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  return rows
    .filter((r) => r.some((v) => String(v).trim() !== ""))
    .map((r) => {
      const obj = {};
      header.forEach((key, i) => { obj[key] = (r[i] ?? "").trim(); });
      return obj;
    });
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

/* --------------------------------------------- validation */
/**
 * Valide une ligne et retourne l'objet Firestore ou une erreur.
 * @returns {{doc?: object, error?: string}}
 */
function validateRow(row, index, seenSku, seenSlug) {
  for (const col of REQUIRED) {
    if (!row[col]) return { error: `colonne obligatoire vide : ${col}` };
  }

  const price = Number(String(row.price).replace(",", "."));
  const koulchi = Number(String(row.koulchi_price).replace(",", "."));
  const stock = Number(row.stock);
  const sku = String(row.sku).toUpperCase();

  if (!Number.isFinite(price) || price <= 0) return { error: `price invalide (${row.price})` };
  if (!Number.isFinite(koulchi) || koulchi <= 0) return { error: `koulchi_price invalide (${row.koulchi_price})` };
  if (koulchi >= price) return { error: `koulchi_price (${koulchi}) doit être < price (${price})` };
  if (!Number.isInteger(stock) || stock < 0) return { error: `stock invalide (${row.stock})` };
  if (sku.length < 6) return { error: `sku trop court (${sku})` };
  if (seenSku.has(sku)) return { error: `sku dupliqué dans le fichier (${sku})` };

  const slug = slugify(row.slug || row.name_fr);
  if (!slug) return { error: "slug impossible à générer" };
  if (seenSlug.has(slug)) return { error: `slug dupliqué dans le fichier (${slug})` };

  const doc = {
    nameFr: row.name_fr,
    nameEn: row.name_en || row.name_fr,
    nameAr: row.name_ar || row.name_fr,
    descFr: row.desc_fr || "",
    descEn: row.desc_en || row.desc_fr || "",
    descAr: row.desc_ar || "",
    price,
    koulchiPrice: koulchi,
    stock,
    sku,
    category: row.category,
    slug,
    img: row.img || "",
    status: "approved",
    vendorId: row.vendor_id || null,
    source: "csv-import",
  };

  if (row.old_price) {
    const oldPrice = Number(String(row.old_price).replace(",", "."));
    if (Number.isFinite(oldPrice) && oldPrice > price) doc.oldPrice = oldPrice;
  }

  seenSku.add(sku);
  seenSlug.add(slug);
  return { doc, rowIndex: index + 2 };
}

/* Les exports sont déclarés en fin de fichier (CLI + testabilité). */

/* --------------------------------------------- CLI */
async function main() {
  if (!csvPath) {
    console.error("Usage : node scripts/import-products-csv.cjs <fichier.csv> [--dry-run] [--update]");
    process.exit(2);
  }
  const abs = path.resolve(csvPath);
  if (!fs.existsSync(abs)) {
    console.error("Fichier introuvable :", abs);
    process.exit(2);
  }

  const rows = parseCsv(fs.readFileSync(abs, "utf8"));
  console.log(`[import] ${rows.length} ligne(s) lue(s) dans ${path.basename(abs)}`);

  const seenSku = new Set();
  const seenSlug = new Set();
  const valid = [];
  const errors = [];

  rows.forEach((row, i) => {
    const result = validateRow(row, i, seenSku, seenSlug);
    if (result.error) errors.push(`ligne ${result.rowIndex || i + 2} : ${result.error}`);
    else valid.push({ doc: result.doc, sku: result.doc.sku });
  });

  console.log(`[import] ${valid.length} valide(s), ${errors.length} rejetée(s)`);
  if (errors.length) {
    errors.slice(0, 30).forEach((e) => console.error("  ✗ " + e));
    if (errors.length > 30) console.error(`  … et ${errors.length - 30} autre(s)`);
  }

  if (DRY_RUN) {
    console.log("[import] --dry-run : aucune écriture Firestore effectuée.");
    console.log(JSON.stringify(valid.slice(0, 2).map((v) => v.doc), null, 2));
    process.exit(errors.length ? 1 : 0);
  }

  if (valid.length === 0) {
    console.error("[import] Aucune ligne valide : rien à écrire.");
    process.exit(1);
  }

  const { initializeApp, applicationDefault } = require("firebase-admin/app");
  const { getFirestore, FieldValue } = require("firebase-admin/firestore");
  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore();

  /* Index des fiches existantes (une seule lecture, pas une par ligne). */
  const existing = await db.collection("products").limit(5000).get();
  const bySku = new Map();
  const bySlug = new Map();
  existing.forEach((doc) => {
    if (doc.get("sku")) bySku.set(String(doc.get("sku")).toUpperCase(), doc.ref);
    if (doc.get("slug")) bySlug.set(String(doc.get("slug")), doc.ref);
  });
  console.log(`[import] ${existing.size} fiche(s) déjà en base`);

  let created = 0;
  let updated = 0;
  let batch = db.batch();
  let pending = 0;

  for (const { doc, sku } of valid) {
    const ref = bySku.get(sku) || bySlug.get(doc.slug);
    if (ref && UPSERT) {
      batch.set(ref, { ...doc, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      updated += 1;
      pending += 1;
    } else if (ref) {
      console.warn(`[import] ignoré (existe déjà) : ${sku} — utilisez --update pour écraser`);
      continue;
    } else {
      batch.set(db.collection("products").doc(), {
        ...doc,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      created += 1;
      pending += 1;
    }
    if (pending >= BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
      console.log(`[import] lot validé (${created + updated} traités)`);
    }
  }

  if (pending > 0) await batch.commit();
  console.log(`[import] TERMINÉ : ${created} créé(s), ${updated} mis à jour.`);
  console.log("[import] Vérifiez ensuite : node scripts/migrate-products-approved.cjs --dry-run");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[import] ÉCHEC :", e && (e.message || e));
    process.exit(1);
  });
}

module.exports = { parseCsv, validateRow, slugify, main };

