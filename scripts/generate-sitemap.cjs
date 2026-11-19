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

// Protection contre les unhandled rejections (ex: crash de google-auth-library)
process.on("unhandledRejection", (reason, promise) => {
  console.warn("[sitemap] Unhandled Rejection ignoree :", reason);
});

// ---------------------------------------------------------------------------
// Pages statiques publiques (hors pages noindex / privees)
// ---------------------------------------------------------------------------
const STATIC_PAGES = [
  { loc: "/", changefreq: "daily", priority: "1.0" },
  { loc: "/koulchi", changefreq: "daily", priority: "0.9" },
  /* /boutique est VOLONTAIREMENT absent : cette page est parametree
     (/boutique?v=<uid vendeur>) et affiche "Boutique introuvable" sans
     parametre. Les boutiques vendeurs sont decouvertes par liens et
     desindexees en cas d erreur (boutique.js -> robots noindex).
     Audit fonctionnel 2026-11-19. */
  { loc: "/blog", changefreq: "daily", priority: "0.8" },
  /* Audit 2026-11-18 : une seule URL par page, sans extension
     (cleanUrls: true dans firebase.json).
       - "/villes" renvoyait 404 en production ;
       - "/villesmaroc.html" renvoyait 308 vers /villesmaroc.
     Les deux ont ete retires : seule /villesmaroc est listee.
     "/inscription-vendeur.html" est en noindex : une page noindex
     ne doit jamais figurer dans le sitemap, elle est donc retiree. */
  { loc: "/villesmaroc", changefreq: "monthly", priority: "0.7" },
  { loc: "/cgu-acheteur", changefreq: "yearly", priority: "0.3" },
  { loc: "/cgu-vendeur", changefreq: "yearly", priority: "0.3" },
  { loc: "/contrat-vendeur", changefreq: "yearly", priority: "0.3" },
  { loc: "/politique-confidentialite", changefreq: "yearly", priority: "0.3" },
];

function parseArgs(argv) {
  const opts = { dryRun: false, out: DEFAULT_OUT };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toDate(value) {
  try {
    if (!value) return null;
    if (typeof value === "object" && typeof value.toDate === "function") return value.toDate();
    if (value instanceof Date) return value;
    if (typeof value === "object" && typeof value.seconds === "number") return new Date(value.seconds * 1000);
    if (typeof value === "number") return new Date(value);
    if (typeof value === "string") {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d;
    }
  } catch (_) {}
  return null;
}

function isoDate(d) {
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function escapeXml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
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
  const head = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'].join("\n");
  const body = entries.map(buildEntry).join("\n");
  return head + "\n" + body + "\n</urlset>\n";
}

// ---------------------------------------------------------------------------
// Firestore (API v14 modulaire)
// ---------------------------------------------------------------------------
async function fetchProductEntries() {
  let initializeApp, getApps, cert, applicationDefault;
  let getFirestore;

  try {
    const appMod = require("firebase-admin/app");
    const firestoreMod = require("firebase-admin/firestore");
    initializeApp = appMod.initializeApp;
    getApps = appMod.getApps;
    cert = appMod.cert;
    applicationDefault = appMod.applicationDefault;
    getFirestore = firestoreMod.getFirestore;
  } catch (e) {
    throw new Error("firebase-admin introuvable ou version incompatible (v14 requise).");
  }

  let app;
  if (getApps().length === 0) {
    const initOpts = { projectId: PROJECT_ID };
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (saPath && fs.existsSync(saPath)) {
      try {
        initOpts.credential = cert(JSON.parse(fs.readFileSync(saPath, "utf8")));
      } catch (e) {
        throw new Error("Service account illisible : " + saPath + " (" + e.message + ")");
      }
    } else {
      // FIX : Au lieu de laisser applicationDefault() planter en arrière-plan,
      // on vérifie si on est dans un environnement qui supporte l'ADC.
      if (!process.env.K_SERVICE && !process.env.FUNCTION_TARGET && !process.env.GCP_PROJECT) {
        throw new Error("Credentials introuvables. Definissez FIREBASE_SERVICE_ACCOUNT ou GOOGLE_APPLICATION_CREDENTIALS.");
      }
      initOpts.credential = applicationDefault();
    }
    app = initializeApp(initOpts);
  } else {
    app = getApps()[0];
  }

  const db = getFirestore(app);

  // Timeout pour éviter de bloquer le script indéfiniment si le réseau Firestore ne répond pas
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout Firestore (10s)")), 10000)
  );

  const snap = await Promise.race([
    db.collection("products").where("status", "==", "approved").get(),
    timeoutPromise
  ]);

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