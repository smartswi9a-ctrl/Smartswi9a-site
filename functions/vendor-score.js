/**
 * functions/vendor-score.js — « COD SCORE » VENDEUR (audit 2026-11-20)
 * ---------------------------------------------------------------------------
 * MODULE AUTONOME, NON CÂBLÉ PAR DÉFAUT.
 *
 * Il n'est PAS importé par functions/index.js : tant que vous ne
 * l'activez pas, aucun déploiement ne change de comportement. C'est
 * volontaire — un score calculé sur des données incomplètes serait
 * trompeur pour les acheteurs.
 *
 * ── ACTIVATION (2 étapes, ~1 min) ──────────────────────────────────────────
 * 1. Dans functions/index.js, tout en bas :
 *      const { registerVendorScore } = require('./vendor-score');
 *      registerVendorScore({ db, FieldValue });
 * 2. firebase deploy --only functions
 *
 * ── MODÈLE ÉCRIT ───────────────────────────────────────────────────────────
 *   vendorsPublic/{uid}.codScore       : 0..100 (affichable publiquement)
 *   vendorsPublic/{uid}.deliveryRate   : 0..1
 *   vendorsPublic/{uid}.returnRate     : 0..1
 *   vendorsPublic/{uid}.scoreSample    : nb de commandes analysées
 *   vendorsPublic/{uid}.scoreComputedAt
 *
 * `vendorsPublic` est déjà `allow write: if false` côté règles : seule
 * l'Admin SDK écrit. Aucune falsification possible par un vendeur.
 *
 * ── BARÈME ────────────────────────────────────────────────────────────────
 *   40 % taux de livraison (livrées / livrées + retournées)
 *   20 % taux de retour (1 - retournées / total)
 *   25 % délai de dépôt (neutre tant que la donnée n'est pas branchée)
 *   15 % note moyenne produits
 * ---------------------------------------------------------------------------
 */

"use strict";

const SCORE_SAMPLE_LIMIT = 500;
const MIN_SAMPLE_FOR_PUBLIC_SCORE = 10;

/**
 * Calcule un score 0..100 à partir des compteurs d'un vendeur.
 * @param {{delivered:number, returned:number, total:number, avgDropoffHours:number|null, ratingAvg:number|null}} stats
 * @returns {number}
 */
function computeScore(stats) {
  const delivered = Math.max(0, Number(stats.delivered) || 0);
  const returned = Math.max(0, Number(stats.returned) || 0);
  const terminal = delivered + returned;

  const deliveryRate = terminal > 0 ? delivered / terminal : 0;
  const returnRate = terminal > 0 ? returned / terminal : 0;

  let dropoffScore = 0.5; /* neutre si aucune donnée */
  if (Number.isFinite(stats.avgDropoffHours)) {
    const h = Math.max(0, Number(stats.avgDropoffHours));
    dropoffScore = h <= 24 ? 1 : h >= 96 ? 0 : 1 - (h - 24) / 72;
  }

  const rating = Number.isFinite(stats.ratingAvg)
    ? Math.min(1, Math.max(0, Number(stats.ratingAvg) / 5))
    : 0.6;

  const score = 100 * (0.4 * deliveryRate + 0.2 * (1 - returnRate) + 0.25 * dropoffScore + 0.15 * rating);
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* Les exports sont déclarés en fin de fichier. */

/**
 * Enregistre la Cloud Function planifiée. À appeler depuis index.js
 * quand vous décidez d'activer le score.
 * @param {{db: any, FieldValue: any}} deps
 * @returns {Function} fonction déployable
 */
function registerVendorScore({ db, FieldValue }) {
  const { onSchedule } = require("firebase-functions/v2/scheduler");

  return onSchedule(
    {
      schedule: "0 3 * * *",
      timeZone: "Africa/Casablanca",
      region: "europe-west1",
      timeoutSeconds: 540,
      memory: "256MiB",
      retryCount: 0,
    },
    async () => {
      const vendorsSnap = await db
        .collection("users")
        .where("role", "==", "vendor")
        .limit(500)
        .get();

      let updated = 0;
      let skipped = 0;

      for (const vendorDoc of vendorsSnap.docs) {
        const uid = vendorDoc.id;
        try {
          /* Index déjà présent : orders(vendorIds CONTAINS, createdAt DESC). */
          const ordersSnap = await db
            .collection("orders")
            .where("vendorIds", "array-contains", uid)
            .orderBy("createdAt", "desc")
            .limit(SCORE_SAMPLE_LIMIT)
            .get();

          let delivered = 0;
          let returned = 0;
          let total = 0;

          ordersSnap.forEach((doc) => {
            const status = String(doc.get("status") || "").toLowerCase();
            if (!status || status === "cancelled" || status === "canceled") return;
            total += 1;
            if (status === "delivered") delivered += 1;
            if (status === "returned") returned += 1;
          });

          if (total < MIN_SAMPLE_FOR_PUBLIC_SCORE) {
            skipped += 1;
            continue;
          }

          const productsSnap = await db
            .collection("products")
            .where("vendorId", "==", uid)
            .where("status", "==", "approved")
            .limit(200)
            .get();

          let ratingSum = 0;
          let ratingCount = 0;
          productsSnap.forEach((p) => {
            const avg = Number(p.get("ratingAvg"));
            const count = Number(p.get("ratingCount")) || 0;
            if (Number.isFinite(avg) && count > 0) {
              ratingSum += avg * count;
              ratingCount += count;
            }
          });

          const score = computeScore({
            delivered,
            returned,
            total,
            avgDropoffHours: null, /* à brancher sur vendor_pickup_requests */
            ratingAvg: ratingCount > 0 ? ratingSum / ratingCount : null,
          });

          await db.collection("vendorsPublic").doc(uid).set(
            {
              codScore: score,
              deliveryRate: Math.round((delivered / total) * 1000) / 1000,
              returnRate: Math.round((returned / total) * 1000) / 1000,
              scoreSample: total,
              scoreComputedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          updated += 1;
        } catch (e) {
          console.error("[vendor-score] échec vendeur", uid, e && e.message);
        }
      }

      console.log(
        `[vendor-score] ${updated} score(s) mis à jour, ${skipped} ignoré(s) (< ${MIN_SAMPLE_FOR_PUBLIC_SCORE} commandes).`
      );
    }
  );
}

module.exports = { registerVendorScore, computeScore };

