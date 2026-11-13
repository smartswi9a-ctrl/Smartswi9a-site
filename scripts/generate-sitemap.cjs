#!/usr/bin/env node
/**
 * generate-sitemap.cjs
 * Genere sitemap.xml pour Smartswika (https://smartswika.ma).
 *
 * Sources :
 *  - STATIC_PAGES : pages publiques listees en dur (toujours presentes)
 *  - Firestore collection "products" ou status == "approved" (URL /produit?slug=<slug>)
 *
 * Usage :
 *   node scripts/generate-sitemap.cjs                 // ecrit ./sitemap.xml
 *   node scripts/generate-sitemap.cjs --dry-run       // affiche sans ecrire
 *   node scripts/generate-sitemap.cjs --out=chemin    // chemin de sortie alternatif
 *
 * Notes :
 *  - firebase-admin doit etre installe a la racine : npm i -D firebase-admin
 *  - Credentials via ADC (gcloud auth application-default login) ou
 *    GOOGLE_APPLICATION_CREDENTIALS=/chemin/serviceAccount.json
 *  - Si Firestore echoue (pas de credentials), le script continue avec les
 *    pages statiques et sort en code 1 (mode degrade signale).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SITE_URL = "https://smartswika.ma";
const PROJECT_ID = "smartswi9a-31063";
const DEFAULT_OUT = path.join(__dirname, "..", "sitemap.xml");

// ---------------------------------------------------------------------------
// Pages statiques publiques (hors pages noindex / privees)
// ---------------------------------------------------------------------------
const STATIC_PAGES = [
  { loc: "/", changefreq: "daily", priority: "1.0" },
  { loc: "/boutique", changefreq: "weekly", priority: "0.9" },
  { loc: "/blog", changefreq: "daily", priority: "0.8" },
  { loc: "/villes", changefreq: "monthly", priority: "0.7" },
  { loc: "/villesmaroc.html", changefreq: "monthly", priority: "0.7" },
  { loc: "/inscription-vendeur.html", changefreq: "monthly", priority: "0.6" },
  { loc: "/cgu-acheteur.html", changefreq: "yearly", priority: "0.3" },
  { loc: "/cgu-vendeur.html", changefreq: "yearly", priority: "0.3" },
  { loc: "/contrat-vendeur.html", changefreq: "yearly", priority: "0.3" },
  { loc: "/politique-confidentialite.html", changefreq: "yearly", priority: "0.3" },
];

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { dryRun: false, out: DEFAULT_OUT };
  for (const raw of argv.slice(2)) {
    if (raw === "--dry-run" || raw === "-n") {
      opts.dryRun = true;
    } else if (raw.startsWith("--out=")) {
      opts.out = path.resolve(process.cwd(), raw.slice("--out=".length));
    } else if (raw === "--out") {
      // ignore : on attend la forme --out=chemin
    } else if (raw === "--help" || raw === "-h") {
      console.log("Usage: node scripts/generate-sitemap.cjs [--dry-run] [--out=chemin]");
      process.exit(0);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toDate(value) {
  // Accepte Date, {toDate()}, timestamp ms, string ISO
  try {
    if (!value) return null;
    if (typeof value === "object" && typeof value.toDate === "function") {
      return value.toDate();
    }
    if (value instanceof Date) return value;
    if (typeof value === "object" && typeof value.seconds === "number") {
      return new Date(value.seconds * 1000);
    }
    if (typeof value === "number") return new Date(value);
    if (typeof value === "string") {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function isoDate(d) {
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildEntry(entry) {
  const lines = ["  <url>", "    <loc>" + escapeXml(SITE_URL + entry.loc) + "</loc>"];
  if (entry.lastmod) lines.push("    <lastmod>" + entry.lastmod + "</lastmod>");
  if (entry.changefreq) lines.push("    <changefreq>" + entry.changefreq + "</changefreq>");
  if (entry.priority) lines.push("    <priority>" + entry.priority + "</priority>");
  lines.push("  </url>");
  return lines.join("\n");
}

function renderSitemap(entries) {
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ].join("\n");
  const body = entries.map(buildEntry).join("\n");
  return head + "\n" + body + "\n</urlset>\n";
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------
async function fetchProductEntries() {
  let admin;
  try {
    admin = require("firebase-admin");
  } catch (e) {
    throw new Error(
      "firebase-admin introuvable a la racine du projet. Installez-le : npm i -D firebase-admin"
    );
  }

  if (!admin.apps.length) {
    const initOpts = { projectId: PROJECT_ID };
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (saPath && fs.existsSync(saPath)) {
      try {
        initOpts.credential = admin.credential.cert(JSON.parse(fs.readFileSync(saPath, "utf8")));
      } catch (e) {
        throw new Error("Service account illisible : " + saPath + " (" + e.message + ")");
      }
    } else {
      initOpts.credential = admin.credential.applicationDefault();
    }
    admin.initializeApp(initOpts);
  }

  const db = admin.firestore();
  const snap = await db.collection("products").where("status", "==", "approved").get();

  const entries = [];
  snap.forEach((doc) => {
    const p = doc.data() || {};
    const slug = typeof p.slug === "string" ? p.slug.trim() : "";
    if (!slug) return;
    const updated = toDate(p.updatedAt) || toDate(p.createdAt) || null;
    entries.push({
      loc: "/produit?slug=" + encodeURIComponent(slug),
      changefreq: "weekly",
      priority: "0.7",
      lastmod: isoDate(updated),
    });
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv);
  const today = isoDate(new Date());

  const staticEntries = STATIC_PAGES.map((p) => ({
    loc: p.loc,
    changefreq: p.changefreq,
    priority: p.priority,
    lastmod: p.lastmod || today,
  }));

  let productEntries = [];
  let degraded = false;

  try {
    productEntries = await fetchProductEntries();
    console.log("[sitemap] Firestore OK : " + productEntries.length + " produit(s) ajoute(s).");
  } catch (err) {
    degraded = true;
    console.warn("[sitemap] Firestore indisponible -> mode statique uniquement.");
    console.warn("[sitemap] Raison : " + (err && err.message ? err.message : String(err)));
  }

  // Deduplication par loc
  const seen = new Set();
  const entries = [];
  for (const e of staticEntries.concat(productEntries)) {
    if (!e || !e.loc || seen.has(e.loc)) continue;
    seen.add(e.loc);
    entries.push(e);
  }

  const xml = renderSitemap(entries);

  if (opts.dryRun) {
    console.log("[sitemap] DRY-RUN : " + entries.length + " URL(s), aucune ecriture.");
    console.log(xml);
  } else {
    fs.writeFileSync(opts.out, xml, "utf8");
    console.log("[sitemap] Ecrit : " + opts.out + " (" + entries.length + " URL(s)).");
  }

  if (degraded) process.exit(1);
}

main().catch((err) => {
  console.error("[sitemap] Echec : " + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
