/**
 * notify-new-product-rule.cjs
 * ATTENTION : NE PAS EXÉCUTER en production sans validation explicite.
 * Lancer d'abord avec --dry-run pour vérifier la liste des destinataires.
 *
 * Objet : notifier tous les vendeurs de la nouvelle règle "produits neufs uniquement"
 * (Article 8 bis des CGU Vendeur / Contrat Vendeur).
 *
 * Usage :
 *   node scripts/notify-new-product-rule.cjs            # dry-run (défaut) : aucune écriture
 *   node scripts/notify-new-product-rule.cjs --dry-run  # idem, explicite
 *   node scripts/notify-new-product-rule.cjs --apply    # écrit réellement les notifications
 *
 * Prérequis : credentials Firebase Admin.
 *   - GOOGLE_APPLICATION_CREDENTIALS=/chemin/serviceAccount.json
 *   - ou environnement Google par défaut (applicationDefault()).
 *
 * Note : les Security Rules Firestore interdisent la création de notifications
 * côté client (allow create: if isAdmin()). Ce script, exécuté avec le SDK admin,
 * contourne ces règles.
 */

"use strict";

const admin = require("firebase-admin");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DRY_RUN = !APPLY;

const BATCH_LIMIT = 500;

const NOTIFICATION_TYPE = "product_rule_reminder";
const NOTIFICATION_TITLE = "Rappel : produits neufs uniquement";
const NOTIFICATION_MESSAGE =
    "Rappel : seuls les produits neufs sont autorisés sur Smart Swika. Les produits d'occasion sont interdits.";

function log(...a) {
    console.log(...a);
}

async function main() {
    log("=====================================================");
    log(" notify-new-product-rule.cjs");
    log(" Mode : " + (APPLY ? "APPLY (écriture réelle)" : "DRY-RUN (aucune écriture)"));
    log("=====================================================");

    /* ---------- Garde-fou credentials ---------- */
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_CONFIG) {
        log("");
        log("[ATTENTION] Aucune credential explicite détectée.");
        log("  Définissez GOOGLE_APPLICATION_CREDENTIALS=/chemin/serviceAccount.json");
        log("  (ou une identité Google par défaut valide).");
        log("  Tentative d'initialisation avec applicationDefault()...");
    }

    try {
        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.applicationDefault()
            });
        }
    } catch (err) {
        console.error("");
        console.error("[ERREUR FATALE] Impossible d'initialiser firebase-admin :");
        console.error("  " + (err && err.message ? err.message : err));
        console.error("  Aucune credential valide. Arrêt.");
        process.exit(1);
    }

    const db = admin.firestore();

    /* ---------- Récupération des vendeurs ---------- */
    log("");
    log("Recherche des vendeurs : collection 'users' où role === 'vendor' ...");

    let snap;
    try {
        snap = await db.collection("users").where("role", "==", "vendor").get();
    } catch (err) {
        console.error("");
        console.error("[ERREUR FATALE] Lecture Firestore impossible :");
        console.error("  " + (err && err.message ? err.message : err));
        process.exit(1);
    }

    const vendors = [];
    snap.forEach((docu) => {
        const d = docu.data() || {};
        if (d.role !== "vendor") return;
        vendors.push({
            uid: docu.id,
            email: d.email || null,
            shopName: d.shopName || d.storeName || d.boutique || null,
            name: d.name || d.fullName || null
        });
    });

    log("");
    log("Vendeurs trouvés : " + vendors.length);

    if (vendors.length === 0) {
        log("Aucun vendeur : rien à faire.");
        return;
    }

    log("");
    log("Liste des destinataires :");
    log("-----------------------------------------------------");
    vendors.forEach((v, i) => {
        const label = v.shopName || v.name || "(sans nom)";
        const mail = v.email || "(sans email)";
        log(
            "  " + String(i + 1).padStart(3, " ") + ". " +
            v.uid + "  |  " + mail + "  |  " + label
        );
    });
    log("-----------------------------------------------------");

    if (DRY_RUN) {
        log("");
        log("[DRY-RUN] Aucune écriture effectuée.");
        log("Pour écrire réellement : node scripts/notify-new-product-rule.cjs --apply");
        return;
    }

    /* ---------- Écriture réelle par lots ---------- */
    log("");
    log("[APPLY] Création des notifications par lots de " + BATCH_LIMIT + " ...");

    let created = 0;
    let batchCount = 0;

    for (let i = 0; i < vendors.length; i += BATCH_LIMIT) {
        const slice = vendors.slice(i, i + BATCH_LIMIT);
        const batch = db.batch();
        batchCount += 1;

        slice.forEach((v) => {
            const ref = db.collection("notifications").doc();
            batch.set(ref, {
                userId: v.uid,
                type: NOTIFICATION_TYPE,
                title: NOTIFICATION_TITLE,
                message: NOTIFICATION_MESSAGE,
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        try {
            await batch.commit();
        } catch (err) {
            console.error("");
            console.error("[ERREUR FATALE] Échec du batch n°" + batchCount + " :");
            console.error("  " + (err && err.message ? err.message : err));
            console.error("  Notifications créées avant l'échec : " + created);
            process.exit(1);
        }

        created += slice.length;
        log("  Batch " + batchCount + " : +" + slice.length + " (total " + created + "/" + vendors.length + ")");
    }

    log("");
    log("=====================================================");
    log(" TERMINÉ — notifications créées : " + created + " / " + vendors.length);
    log("=====================================================");
}

main().catch((err) => {
    console.error("");
    console.error("[ERREUR FATALE] " + (err && err.message ? err.message : err));
    process.exit(1);
});
