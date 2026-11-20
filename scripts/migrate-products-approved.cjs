#!/usr/bin/env node
/**
 * migrate-products-approved.cjs
 * ---------------------------------------------------------------------------
 * AUDIT 2026-11-20 — Résout la contradiction « legacy sans status ».
 *
 * Contexte :
 *   - js/products.js charge `where("status","==","approved")`.
 *   - firestore.rules n'autorisait la lecture publique que si
 *     status == 'approved'.
 *   => Une fiche créée AVANT l'introduction de `status` n'était ni
 *      requêtée par le client, ni lisible par les règles. Elle
 *      disparaissait silencieusement de la boutique.
 *
 * Ce script :
 *   1. compte les fiches par état (approved / pending / sans status) ;
 *   2. marque les fiches SANS status comme `status: 'approved'` +
 *      `legacy: true` + `migratedAt` ;
 *   3. refuse de s'exécuter si la collection est vide (garde-fou).
 *
 * Usage :
 *   node scripts/migrate-products-approved.cjs --dry-run
 *   node scripts/migrate-products-approved.cjs
 *
 * Credentials : ADC (gcloud auth application-default login) ou
 *   GOOGLE_APPLICATION_CREDENTIALS=/chemin/serviceAccount.json
 * ---------------------------------------------------------------------------
 */

"use strict";

const PROJECT_ID = "smartswi9a-31063";
const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 400;

process.on("unhandledRejection", (reason) => {
  console.warn("[migrate-products] Unhandled Rejection ignorée :", reason);
});

function log(...args) {
  console.log("[migrate-products]", ...args);
}

async function main() {
  let initializeApp, applicationDefault, getFirestore, FieldValue;
  try {
    ({ initializeApp, applicationDefault } = require("firebase-admin/app"));
    ({ getFirestore, FieldValue } = require("firebase-admin/firestore"));
  } catch (e) {
    console.error(
      "firebase-admin est requis : npm i -D firebase-admin\n" + (e && e.message)
    );
    process.exit(2);
  }

  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore();

  const snap = await db.collection("products").get();
  log("Documents trouvés dans products :", snap.size);

  if (snap.size === 0) {
    console.warn(
      "Collection products VIDE. Rien à migrer : importer d'abord le " +
        "catalogue (sinon la boutique reste vide en production)."
    );
    process.exit(0);
  }

  const etats = { approved: 0, pending: 0, sansStatus: 0, autre: 0 };
  const aMigrer = [];

  snap.forEach((doc) => {
    const status = doc.get("status");
    if (status === "approved") etats.approved += 1;
    else if (!status) {
      etats.sansStatus += 1;
      aMigrer.push(doc);
    } else if (String(status).startsWith("pending")) etats.pending += 1;
    else etats.autre += 1;
  });

  log("Répartition :", etats);

  if (aMigrer.length === 0) {
    log("Aucune fiche sans status : rien à faire.");
    process.exit(0);
  }

  if (DRY_RUN) {
    log(
      `--dry-run : ${aMigrer.length} fiche(s) seraient marquées approved. ` +
        "Aucune écriture effectuée."
    );
    process.exit(0);
  }

  let batch = db.batch();
  let ecrits = 0;

  for (const doc of aMigrer) {
    batch.update(doc.ref, {
      status: "approved",
      legacy: true,
      migratedAt: FieldValue.serverTimestamp(),
    });
    ecrits += 1;
    if (ecrits % BATCH_SIZE === 0) {
      await batch.commit();
      log("Lot validé :", ecrits);
      batch = db.batch();
    }
  }

  await batch.commit();
  log(`Terminé. ${ecrits} fiche(s) marquées approved (legacy: true).`);
}

main().catch((e) => {
  console.error("[migrate-products] ÉCHEC :", e && (e.message || e));
  process.exit(1);
});
