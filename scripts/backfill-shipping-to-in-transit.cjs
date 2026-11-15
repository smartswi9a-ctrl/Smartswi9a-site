#!/usr/bin/env node
/**
 * backfill-shipping-to-in-transit.cjs
 *
 * PR 8.7 - Migration data de la dette 8.6 : backfill `shipping` -> `in_transit`.
 *
 * Probleme resolu
 *   La PR 8.6 (D2) a ajoute `'shipping': 'in_transit'` a STATUS_MIGRATION_MAP.
 *   normalizeOrderStatus() masque donc la valeur legacy a la LECTURE, mais la
 *   donnee Firestore reste `shipping` indefiniment. Ce script fait la vraie
 *   migration physique.
 *
 * SECURITE FINANCIERE (a lire avant d'executer)
 *   resolveCreditUnlockBase() (functions/index.js) ancre le deblocage vendeur
 *   sur trackingStartedAt, puis createdAt, puis updatedAt. Ce script N'ECRIT
 *   JAMAIS `updatedAt` : l'ancre de secours financiere est donc preservee a
 *   l'identique. Champs ecrits, et eux seuls :
 *     status       = 'in_transit'
 *     migratedAt   = <timestamp serveur>
 *     migratedFrom = 'shipping'
 *   (Option B de la PR 8.7 : tracabilite de la migration, updatedAt intact.)
 *
 *   Note : ce backfill ne declenche AUCUN credit vendeur. Le trigger
 *   onOrderStatusChanged ne credite que sur la transition vers `delivered`.
 *
 * GARANTIES
 *   - SIMULATION par defaut : aucune ecriture sans --apply.
 *   - Idempotent : un second --apply = 0 ecriture (la requete ne ramene plus
 *     que les documents encore en `shipping`).
 *   - Fail-soft : une erreur sur un document est signalee sans interrompre le
 *     reste du lot.
 *   - Aucun autre champ touche (jamais trackingStartedAt, jamais createdAt).
 *
 * USAGE
 *   node scripts/backfill-shipping-to-in-transit.cjs            # SIMULATION
 *   node scripts/backfill-shipping-to-in-transit.cjs --dry-run  # idem explicite
 *   node scripts/backfill-shipping-to-in-transit.cjs --apply    # ECRITURE
 *   node scripts/backfill-shipping-to-in-transit.cjs --limit=50 # plafonne
 *   node scripts/backfill-shipping-to-in-transit.cjs --key <chemin>
 *
 * PREREQUIS
 *   npm i -D firebase-admin
 *   Cle de service : C:/Users/hp/firebase-admin-key.json (ou --key <chemin>)
 */

'use strict';

const fs = require('fs');

const PROJECT_ID = 'smartswi9a-31063';
const COLLECTION = 'orders';
const DEFAULT_KEY = 'C:/Users/hp/firebase-admin-key.json';
const LEGACY_STATUS = 'shipping';
const TARGET_STATUS = 'in_transit';
const SOURCE_TAG = 'backfill-pr8.7';

/* Taille de page pour la pagination par curseur (pas d'offset : couteux et
   instable sur les gros volumes). */
const PAGE_SIZE = 200;

/* Taille de lot d'ecriture : compromis latence/atomicite. Un batch Firestore
   est plafonne a 500 operations par defaut ; 100 reste largement dessous et
   limite l'impact d'un echec sur le lot. */
const BATCH_SIZE = 100;

const KNOWN_FLAGS = new Set([
  '--apply', '--dry-run', '--help', '-h', '--key', '--limit'
]);

/* ============================================================
   ARGUMENTS
   ============================================================ */
function parseArgs(argv) {
  const opts = { apply: false, help: false, key: DEFAULT_KEY, limit: Infinity };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);

    if (!KNOWN_FLAGS.has(flag)) {
      console.error('Option inconnue : ' + raw);
      console.error('Options supportees : ' + Array.from(KNOWN_FLAGS).join(', '));
      process.exit(2);
    }

    if (flag === '--help' || flag === '-h') {
      opts.help = true;
    } else if (flag === '--apply') {
      opts.apply = true;
    } else if (flag === '--dry-run') {
      opts.apply = false;
    } else if (flag === '--key' || flag === '--limit') {
      let value;
      if (eq !== -1) {
        value = raw.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (!next || next.indexOf('--') === 0) {
          console.error(flag + ' attend une valeur');
          process.exit(2);
        }
        value = next;
        i += 1;
      }
      if (flag === '--key') {
        opts.key = value;
      } else {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          console.error('--limit attend un entier positif');
          process.exit(2);
        }
        opts.limit = Math.floor(n);
      }
    }
  }

  return opts;
}

function printHelp() {
  console.log('');
  console.log('backfill-shipping-to-in-transit.cjs - migration data dette 8.6 (PR 8.7)');
  console.log('');
  console.log('  node scripts/backfill-shipping-to-in-transit.cjs            # SIMULATION');
  console.log('  node scripts/backfill-shipping-to-in-transit.cjs --dry-run   # idem');
  console.log('  node scripts/backfill-shipping-to-in-transit.cjs --apply     # ECRITURE');
  console.log('  node scripts/backfill-shipping-to-in-transit.cjs --limit=50  # plafond');
  console.log('');
  console.log('Sans --apply, le script ne fait AUCUNE ecriture.');
  console.log('');
  console.log('Options :');
  console.log('  --apply           ECRITURE REELLE. Obligatoire pour ecrire.');
  console.log('  --dry-run         Force la simulation (redondant avec le defaut).');
  console.log('  --limit=N         Traite au plus N commandes.');
  console.log('  --key <chemin>    Fichier de cle de service (defaut : ' + DEFAULT_KEY + ')');
  console.log('  --help            Affiche cette aide.');
  console.log('');
  console.log('Ecrit UNIQUEMENT :');
  console.log('  status       = \'' + TARGET_STATUS + '\'');
  console.log('  migratedAt   = <timestamp serveur>');
  console.log('  migratedFrom = \'' + LEGACY_STATUS + '\'');
  console.log('');
  console.log('Ne touche JAMAIS updatedAt, createdAt ni trackingStartedAt :');
  console.log('resolveCreditUnlockBase() (functions/index.js) depend de ces dates.');
  console.log('');
}

/* ============================================================
   FIRESTORE
   ============================================================ */
function loadAdmin() {
  try {
    const appMod = require('firebase-admin/app');
    const fsMod = require('firebase-admin/firestore');
    return {
      initializeApp: appMod.initializeApp,
      getApps: appMod.getApps,
      cert: appMod.cert,
      getFirestore: fsMod.getFirestore,
      FieldValue: fsMod.FieldValue
    };
  } catch (_) {
    console.error('Le module firebase-admin (API modulaire) est absent.');
    console.error('Installer avec : npm install --save-dev firebase-admin');
    return null;
  }
}

function shortId(id) {
  return String(id || '').slice(0, 8);
}

/* ============================================================
   COLLECTE (pagination par curseur)
   ============================================================ */
/*
 * Lit toutes les commandes dont status === 'shipping'.
 *
 * - Query simple sur un seul champ : AUCUN index composite necessaire.
 *   Firestore cree automatiquement l'index mono-champ sur `status`.
 * - Pagination par curseur (startAfter) et non par offset : un offset oblige
 *   le serveur a relire tous les documents precedent, ce qui devient
 *   inutilisable sur un gros volume.
 * - Le curseur est le dernier document recu, pas un numero de page.
 */
async function collectShippingOrders(db, admin, limit) {
  const orders = [];
  let lastDoc = null;
  let truncated = false;

  for (;;) {
    let query = db
      .collection(COLLECTION)
      .where('status', '==', LEGACY_STATUS)
      .orderBy(admin.FieldPath ? admin.FieldPath.documentId() : '__name__')
      .limit(PAGE_SIZE);

    if (lastDoc) query = query.startAfter(lastDoc);

    const snap = await query.get();
    if (snap.empty) break;

    snap.forEach((docSnap) => {
      orders.push({ id: docSnap.id, ref: docSnap.ref, data: docSnap.data() || {} });
    });

    lastDoc = snap.docs[snap.docs.length - 1];

    if (orders.length >= limit) {
      truncated = true;
      break;
    }
    if (snap.size < PAGE_SIZE) break;
  }

  const kept = Number.isFinite(limit) ? orders.slice(0, limit) : orders;
  return { orders: kept, truncated: truncated || kept.length < orders.length, totalSeen: orders.length };
}

/* ============================================================
   ECRITURE (lots)
   ============================================================ */
/*
 * Choix : `batch` (commit transactionnel de lot) plutot que runTransaction.
 *
 * Justification :
 *  - Chaque document est migre independamment ; il n'y a aucune lecture
 *    conditionnelle a faire dans la transaction (on sait deja, par la requete,
 *    que le doc est en 'shipping' au moment de la lecture).
 *  - Un batch garantit l'atomicite par lot (tout ou rien par paquet de 100)
 *    sans imposer le cout d'une transaction par document.
 *  - runTransaction serait justifie si l'ecriture dependait d'une relecture
 *    concurrente ; ce n'est pas le cas, et une migration one-shot tolere un
 *    ecrasement idempotent.
 *
 * Le batch ne porte AUCUN `updatedAt`. Voir l'en-tete du fichier.
 */
function buildPatch(admin) {
  return {
    status: TARGET_STATUS,
    migratedAt: admin.FieldValue.serverTimestamp(),
    migratedFrom: LEGACY_STATUS
  };
}

async function applyBatches(db, admin, orders, writeErrors) {
  let written = 0;

  for (let start = 0; start < orders.length; start += BATCH_SIZE) {
    const slice = orders.slice(start, start + BATCH_SIZE);
    const batch = db.batch();

    slice.forEach((order) => {
      batch.update(order.ref, buildPatch(admin));
    });

    try {
      await batch.commit();
      written += slice.length;
      slice.forEach((order) => {
        console.log('  OK   ' + shortId(order.id) + ' :: ' + LEGACY_STATUS + ' -> ' + TARGET_STATUS);
      });
      console.log('Lot ecrit : ' + written + '/' + orders.length);
    } catch (batchErr) {
      /* Echec du lot entier (permissions, doc supprime entre temps...).
         On le signale et on continue : le reste de la migration ne doit pas
         etre bloque par un lot defectueux. On retente document par document
         pour isoler les coupables et sauver les autres. */
      console.error('  Lot en echec (' + shortId(slice[0].id) + '+...) : ' +
        (batchErr && batchErr.message ? batchErr.message : batchErr));

      for (const order of slice) {
        try {
          await order.ref.update(buildPatch(admin));
          written += 1;
          console.log('  OK   ' + shortId(order.id) + ' :: reprise unitaire ok');
        } catch (docErr) {
          writeErrors.push({
            id: order.id,
            message: docErr && docErr.message ? docErr.message : String(docErr)
          });
          console.error('  FAIL ' + shortId(order.id) + ' :: ' +
            (docErr && docErr.message ? docErr.message : docErr));
        }
      }
    }
  }

  return written;
}

/* ============================================================
   MAIN
   ============================================================ */
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return 0;
  }

  if (!fs.existsSync(opts.key)) {
    console.error('Fichier de cles introuvable : ' + opts.key);
    return 1;
  }

  const admin = loadAdmin();
  if (!admin) return 1;

  const serviceAccount = JSON.parse(fs.readFileSync(opts.key, 'utf8'));
  if (serviceAccount.project_id && serviceAccount.project_id !== PROJECT_ID) {
    console.error(
      'ATTENTION : le fichier de cles cible "' +
        serviceAccount.project_id +
        '" au lieu de "' +
        PROJECT_ID +
        '".'
    );
    return 1;
  }

  const app =
    admin.getApps().length > 0
      ? admin.getApps()[0]
      : admin.initializeApp({ credential: admin.cert(serviceAccount), projectId: PROJECT_ID });
  const db = admin.getFirestore(app);

  /* 1) Collecte : uniquement les documents encore en `shipping`. C'est ce qui
        rend le script idempotent : apres une migration, la requete ne ramene
        plus rien. */
  let collected;
  try {
    collected = await collectShippingOrders(db, admin, opts.limit);
  } catch (err) {
    console.error('Lecture Firestore en echec : ' + (err && err.message ? err.message : err));
    return 1;
  }

  const orders = collected.orders;

  /* 2) Comptage de controle : on relit le nombre d'ordres deja en in_transit
        pour le rapport. Une requete d'agregation evite de charger les docs. */
  let alreadyInTransit = 0;
  try {
    const agg = await db
      .collection(COLLECTION)
      .where('status', '==', TARGET_STATUS)
      .count()
      .get();
    alreadyInTransit = agg.data().count;
  } catch (_) {
    /* L'agregation `count()` peut ne pas etre disponible selon la version du
       SDK. Ce n'est qu'un indicateur de rapport : on degrade proprement. */
    alreadyInTransit = -1;
  }

  /* 3) Rapport. */
  console.log('');
  console.log('==============================================================================');
  console.log('BACKFILL ' + LEGACY_STATUS + ' -> ' + TARGET_STATUS + ' - ' + COLLECTION + ' @ ' + PROJECT_ID);
  console.log('MODE : ' + (opts.apply ? 'ECRITURE REELLE (--apply)' : 'SIMULATION (aucune ecriture)'));
  console.log('==============================================================================');
  console.log('Commandes lues (' + LEGACY_STATUS + ').... : ' + orders.length);
  console.log('Deja en ' + TARGET_STATUS + ' (global)... : ' +
    (alreadyInTransit === -1 ? 'indisponible (agregation non supportee)' : alreadyInTransit));
  if (Number.isFinite(opts.limit)) {
    console.log('Plafond --limit ............... : ' + opts.limit +
      (collected.truncated ? ' (resultat tronque)' : ''));
  }
  console.log('A migrer ..................... : ' + orders.length + ' commande(s)');
  console.log('');

  if (orders.length > 0) {
    console.log('--- A MIGRER (' + Math.min(orders.length, 30) + ' affichees) ---');
    orders.slice(0, 30).forEach((order) => {
      const hasTracking = order.data && order.data.trackingStartedAt ? 'tracking' : 'NO-tracking';
      console.log('  ' + shortId(order.id) + ' :: ' + hasTracking + ' :: updatedAt intact');
    });
    if (orders.length > 30) {
      console.log('  ... et ' + (orders.length - 30) + ' autre(s).');
    }
    console.log('');
  }

  if (!opts.apply) {
    console.log('SIMULATION : aucune ecriture effectuee.');
    console.log('Relancer avec --apply pour migrer les commandes.');
    console.log('');
    return 0;
  }

  if (orders.length === 0) {
    console.log('Rien a migrer : aucune commande en ' + LEGACY_STATUS + '.');
    console.log('(Un second --apply est un no-op legitime.)');
    console.log('');
    return 0;
  }

  /* 4) Ecriture. */
  const writeErrors = [];
  let written = 0;
  try {
    written = await applyBatches(db, admin, orders, writeErrors);
  } catch (err) {
    console.error('Ecriture interrompue : ' + (err && err.message ? err.message : err));
    writeErrors.push({ id: '(lot)', message: err && err.message ? err.message : String(err) });
  }

  /* 5) Rapport final. */
  console.log('');
  console.log('==============================================================================');
  console.log('RESUME');
  console.log('==============================================================================');
  console.log('Commandes lues ............... : ' + orders.length);
  console.log('Commandes migrees ............ : ' + written);
  console.log('Commandes deja ' + TARGET_STATUS + ' ...... : ' +
    (alreadyInTransit === -1 ? 'n/a' : alreadyInTransit));
  console.log('Commandes en erreur .......... : ' + writeErrors.length);
  if (writeErrors.length > 0) {
    writeErrors.forEach((e) => {
      console.log('  FAIL ' + shortId(e.id) + ' :: ' + e.message);
    });
  }
  console.log('');
  console.log('Rappel : updatedAt n\'a PAS ete modifie. Voir resolveCreditUnlockBase().');
  console.log('');
  return writeErrors.length > 0 ? 1 : 0;
}

/* ============================================================
   EXPORTS / BOOTSTRAP
   ------------------------------------------------------------
   Pattern Node standard : le script s'execute seul quand il est lance
   directement (node scripts/...), et expose main/parseArgs quand il est
   require() par les tests. Aucun stripping de source cote tests.
   ============================================================ */
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Erreur :', err && err.message ? err.message : err);
      process.exit(1);
    });
} else {
  module.exports = { main, parseArgs };
}

