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

const fs = require("fs");
const path = require("path");
const { initializeApp, cert, getApps, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DRY_RUN = !APPLY;

const BATCH_LIMIT = 500;

const NOTIFICATION_TYPE = "product_rule_reminder";
const NOTIFICATION_TITLE = "Rappel : produits neufs uniquement";
const NOTIFICATION_MESSAGE =
    "Rappel : seuls les produits neufs sont autorisés sur Smart Swika. Les produits d'occasion sont interdits.";

// Préfixe d'un private_key_id connu comme compromis : toute credential qui
// commence par ce préfixe doit être refusée.
const KNOWN_COMPROMISED_PRIVATE_KEY_PREFIX = "b11ac7658f";

function log(...a) {
    console.log(...a);
}

/* ------------------------------------------------------------------ */
/* Diagnostic d'erreur détaillé                                        */
/* ------------------------------------------------------------------ */

function printError(err, indent) {
    const pad = indent || "";
    const nextPad = pad + "  ";

    if (err === undefined || err === null) {
        console.error(pad + "[ERREUR] valeur d'erreur vide (null/undefined)");
        return;
    }
    if (typeof err !== "object") {
        console.error(pad + "[ERREUR] " + String(err));
        return;
    }

    let printedField = false;
    const field = (label, value) => {
        if (value === undefined || value === null || value === "") return;
        printedField = true;
        console.error(nextPad + label + " : " + String(value));
    };

    console.error(pad + "[ERREUR]");

    field("name", err.name);
    field("message", err.message);
    field("code", err.code);
    field("status", err.status);
    field("details", err.details);
    field("reason", err.reason);
    field("path", err.path);
    field("syscall", err.syscall);
    field("errno", err.errno);

    if (err.errorInfo) {
        field("errorInfo", JSON.stringify(err.errorInfo));
    }

    if (Array.isArray(err.errors) && err.errors.length > 0) {
        printedField = true;
        console.error(nextPad + "errors[] (" + err.errors.length + ") :");
        err.errors.forEach((e, i) => {
            if (e && typeof e === "object") {
                console.error(nextPad + "  [" + i + "] " +
                    (e.code || e.status || e.reason ? (e.code || e.status || e.reason) + " — " : "") +
                    (e.message || JSON.stringify(e)));
                if (e.details) console.error(nextPad + "      details : " + JSON.stringify(e.details));
            } else {
                console.error(nextPad + "  [" + i + "] " + String(e));
            }
        });
    }

    if (Array.isArray(err.requireStack) && err.requireStack.length > 0) {
        printedField = true;
        console.error(nextPad + "requireStack[] :");
        err.requireStack.forEach((p) => console.error(nextPad + "  - " + p));
    }

    if (err.stack) {
        printedField = true;
        console.error(nextPad + "stack (20 premières lignes) :");
        String(err.stack)
            .split("\n")
            .slice(0, 20)
            .forEach((l) => console.error(nextPad + "  " + l));
    }

    // Cause chaînée (Node >= 16)
    if (err.cause) {
        printedField = true;
        console.error(nextPad + "-- cause --");
        printError(err.cause, nextPad);
    }

    // Fallback : aucune information utile extraite
    if (!printedField) {
        console.error(nextPad + "Aucun champ standard exploitable — dump complet :");
        console.dir(err, { depth: 3 });
    }
}

/* ------------------------------------------------------------------ */
/* Pré-vol credentials                                                 */
/* ------------------------------------------------------------------ */

function preflightCredentials() {
    const rawPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (!rawPath) {
        log("");
        log("[INFO] GOOGLE_APPLICATION_CREDENTIALS non défini.");
        log("       Tentative avec applicationDefault().");
        return null;
    }

    log("");
    log("[CREDENTIALS] GOOGLE_APPLICATION_CREDENTIALS = " + rawPath);

    const resolved = path.resolve(rawPath);

    if (!fs.existsSync(resolved)) {
        throw new Error(
            "Fichier de credentials introuvable : " + resolved +
            " (chemin résolu depuis GOOGLE_APPLICATION_CREDENTIALS)"
        );
    }

    let raw;
    try {
        raw = fs.readFileSync(resolved, "utf8");
    } catch (e) {
        throw new Error("Impossible de lire le fichier de credentials " + resolved +
            " : " + (e && e.message ? e.message : String(e)));
    }

    let sa;
    try {
        sa = JSON.parse(raw);
    } catch (e) {
        throw new Error("Fichier de credentials invalide (JSON.parse) " + resolved +
            " : " + (e && e.message ? e.message : String(e)));
    }

    if (!sa || typeof sa !== "object") {
        throw new Error("Fichier de credentials : contenu non-objet après parsing.");
    }

    if (sa.type !== "service_account") {
        throw new Error(
            'type attendu "service_account", reçu "' + String(sa.type) + '".'
        );
    }

    const required = ["project_id", "private_key", "client_email", "private_key_id"];
    const missing = required.filter((k) => !sa[k]);
    if (missing.length > 0) {
        throw new Error("Champs requis manquants dans le service account : " + missing.join(", "));
    }

    // --- Détection de clé compromise (comparaison correcte) ---
    const privateKeyId = String(sa.private_key_id);
    const pkPrefix = privateKeyId.slice(0, 12); // uniquement pour l'affichage

    log("[CREDENTIALS] project_id     : " + sa.project_id);
    log("[CREDENTIALS] client_email   : " + sa.client_email);
    log("[CREDENTIALS] private_key_id : " + pkPrefix + "…");

    if (privateKeyId.startsWith(KNOWN_COMPROMISED_PRIVATE_KEY_PREFIX)) {
        throw new Error(
            "Clé de service account compromise détectée (private_key_id commence par " +
            KNOWN_COMPROMISED_PRIVATE_KEY_PREFIX + "). " +
            "Révoquez cette clé dans Google Cloud Console et générez-en une nouvelle avant de relancer."
        );
    }

    return sa;
}

/* ------------------------------------------------------------------ */
/* Handlers globaux                                                    */
/* ------------------------------------------------------------------ */

process.on("unhandledRejection", (reason) => {
    console.error("");
    console.error("[ERREUR FATALE] Promesse rejetée non gérée :");
    printError(reason, "  ");
    process.exitCode = 1;
});

process.on("uncaughtException", (err) => {
    console.error("");
    console.error("[ERREUR FATALE] Exception non capturée :");
    printError(err, "  ");
    process.exitCode = 1;
});

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
    log("=====================================================");
    log(" notify-new-product-rule.cjs");
    log(" Mode : " + (APPLY ? "APPLY (écriture réelle)" : "DRY-RUN (aucune écriture)"));
    log("=====================================================");

    /* ---------- Pré-vol credentials ---------- */
    let serviceAccount = null;
    try {
        serviceAccount = preflightCredentials();
    } catch (err) {
        console.error("");
        console.error("[ERREUR FATALE] Pré-vol credentials échoué :");
        printError(err, "  ");
        process.exitCode = 1;
        return;
    }

    /* ---------- Initialisation firebase-admin ---------- */
    try {
        if (getApps().length === 0) {
            if (serviceAccount) {
                initializeApp({
                    credential: cert(serviceAccount),
                    projectId: serviceAccount.project_id
                });
            } else {
                initializeApp({
                    credential: applicationDefault()
                });
            }
        }
        log("[INIT] firebase-admin initialisé.");
    } catch (err) {
        console.error("");
        console.error("[ERREUR FATALE] Impossible d'initialiser firebase-admin :");
        printError(err, "  ");
        process.exitCode = 1;
        return;
    }

    const db = getFirestore();

    /* ---------- Récupération des vendeurs ---------- */
    log("");
    log("Recherche des vendeurs : collection 'users' où role === 'vendor' ...");

    let snap;
    try {
        snap = await db.collection("users").where("role", "==", "vendor").get();
    } catch (err) {
        console.error("");
        console.error("[ERREUR FATALE] Lecture Firestore impossible :");
        printError(err, "  ");
        process.exitCode = 1;
        return;
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
                createdAt: FieldValue.serverTimestamp()
            });
        });

        try {
            await batch.commit();
        } catch (err) {
            console.error("");
            console.error("[ERREUR FATALE] Échec du batch n°" + batchCount + " :");
            printError(err, "  ");
            console.error("  Notifications créées avant l'échec : " + created);
            process.exitCode = 1;
            return;
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
    console.error("[ERREUR FATALE] Exception remontée depuis main() :");
    printError(err, "  ");
    process.exitCode = 1;
});
