#!/usr/bin/env node
/*
 * tests/livo-sync.test.cjs
 *
 * Scenarios T1 a T10 (+ T9bis) de la refonte syncLivoStatus / LIVO_STATUS_MAP
 * (PR 8.5, dette A).
 *
 * Aucun appel reseau, aucun Firestore : js/config.js et js/orders.js sont
 * charges tels quels dans un contexte `vm`. Les dependances Firebase sont
 * remplacees par des stubs en memoire qui enregistrent les ecritures, ce qui
 * permet d'asserter « extras ecrits » sans mock de test ecrit a la main.
 *
 * Le code teste est donc LE code de production : pas de copie de la regle.
 *
 * Lancement : node tests/livo-sync.test.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const CONFIG_PATH = path.join(__dirname, '..', 'js', 'config.js');
const ORDERS_PATH = path.join(__dirname, '..', 'js', 'orders.js');

/* ------------------------------------------------------------------ */
/* Chargement des modules reels via vm                                */
/* ------------------------------------------------------------------ */

/* Retire les imports ESM et expose les ``export`` comme declarations nues. */
function stripEsm(source) {
  return source
    .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"]\s*;?/gm, '')
    .replace(/\bexport\s+default\s+/g, 'module.exports.default = ')
    .replace(/\bexport\s+(async\s+function|function|const|let|var|class)/g, '$1');
}

/* Ajoute l'export explicite d'une liste de symboles vers this.__api. */
function exposeAll(code, names) {
  return code + '\n;this.__api = {' + names.map((n) =>
    n + ': typeof ' + n + ' !== "undefined" ? ' + n + ' : null'
  ).join(',\n') + '};\n';
}

function makeSandbox(extra = {}) {
  return Object.assign({
    console: { log() {}, warn() {}, error() {} },
    module: { exports: {} },
    exports: {},
    Map, Set, WeakMap, Date, Math, JSON, String, Number, Array, Object,
    Boolean, Promise, Error, RegExp, Intl, parseInt, parseFloat, isNaN,
    setTimeout, clearTimeout,
  }, extra);
}

/* ---------------------------- config.js --------------------------- */

function loadConfig() {
  const sandbox = makeSandbox();
  const code = exposeAll(stripEsm(fs.readFileSync(CONFIG_PATH, 'utf8')), [
    'LIVO_STATUS_MAP',
    'LIVO_SYNCABLE_STATUSES',
    'mapLivoStatusToSmart',
    'ORDER_STATUS',
    'normalizeOrderStatus',
  ]);
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: CONFIG_PATH });
  const api = sandbox.__api;
  assert.ok(api && typeof api.mapLivoStatusToSmart === 'function',
    'mapLivoStatusToSmart introuvable dans ' + CONFIG_PATH);
  assert.ok(api.LIVO_STATUS_MAP, 'LIVO_STATUS_MAP introuvable dans ' + CONFIG_PATH);
  assert.ok(Array.isArray(api.LIVO_SYNCABLE_STATUSES),
    'LIVO_SYNCABLE_STATUSES introuvable dans ' + CONFIG_PATH);
  return api;
}

/* ---------------------------- orders.js --------------------------- */

/*
 * Charge orders.js avec : config.js fourni, et un Firestore en memoire.
 *
 * `store` est un objet { [orderId]: data }. Les ecritures sont collectees
 * dans `writes` (liste d'objets { id, data }) pour asserter les extras.
 */
function loadOrders(configApi, store, writes) {
  const { ORDER_STATUS, normalizeOrderStatus, mapLivoStatusToSmart,
          LIVO_SYNCABLE_STATUSES } = configApi;

  /* --- stubs Firestore --- */
  /* doc() est appele en production sous la forme doc(db, 'orders', orderId) :
     le stub doit donc prendre le DERNIER argument comme identifiant. */
  const docRef = (...args) => {
    const id = args[args.length - 1];
    return { __id: id, path: 'orders/' + id };
  };

  function getDoc(ref) {
    const data = store[ref.__id];
    return Promise.resolve({
      exists: () => data !== undefined,
      data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
    });
  }

  function updateDoc(ref, patch) {
    writes.push({ id: ref.__id, data: JSON.parse(JSON.stringify(patch)) });
    return Promise.resolve();
  }

  /* runTransaction : rejoue le callback avec un `transaction.get` de stub. */
  function runTransaction(db, cb) {
    return cb({
      get: (ref) => getDoc(ref),
      update: (ref, patch) => updateDoc(ref, patch),
      set: () => { throw new Error('set non supporte dans ce stub'); },
      delete: () => { throw new Error('delete non supporte dans ce stub'); },
    });
  }

  /* --- stubs de la reponse Livo (fetch) --- */
  const livoState = { livoOrder: null };

  function fetchWithRetryResponse() {
    return Promise.resolve({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({
        success: true,
        data: { data: JSON.parse(JSON.stringify(livoState.livoOrder)) },
      }),
      text: () => Promise.resolve('{}'),
    });
  }

  const sandbox = makeSandbox({
    /* Firebase / Firestore */
    db: { __isDb: true },
    auth: { currentUser: { getIdToken: () => Promise.resolve('id-token-test') } },
    storage: {},
    collection: () => ({}),
    doc: docRef,
    getDocs: () => Promise.resolve({ empty: true, docs: [], forEach() {} }),
    getDoc,
    updateDoc,
    query: () => ({}),
    where: () => ({}),
    orderBy: () => ({}),
    limit: () => ({}),
    startAfter: () => ({}),
    Timestamp: { fromDate: (d) => d, now: () => new Date() },
    runTransaction,
    writeBatch: () => ({
      update: () => {}, set: () => {}, delete: () => {}, commit: () => Promise.resolve(),
    }),
    increment: (n) => ({ __increment: n }),
    addDoc: () => Promise.resolve({ id: 'stub' }),

    /* Config / utils */
    CONFIG: {
      LIVO: { LABEL_BARCODE_PREFIX: 'SW' },
      LOGISTICS: { PROXY_WORKER_URL: 'https://livo-proxy.test' },
    },
    ORDER_STATUS,
    normalizeOrderStatus,
    mapLivoStatusToSmart,
    LIVO_SYNCABLE_STATUSES,
    NOTIFICATION_TYPES: {},
    ORDER_STATUS_ORDER: [],
    ORDER_DEPRECATED_STATUSES: [],

    t: (k) => k,
    escapeHTML: (s) => String(s == null ? '' : s),
    formatDateTime: () => '',
    getOrderStatusEmoji: () => '',
    getOrderStatusLabelKey: () => '',
    getOrderTimelineSteps: () => [],
    isOrderCancellable: () => false,
    getTimeRemainingForCancellation: () => 0,
    formatTimeRemaining: () => '',
    getOrderDeletability: () => ({ deletable: false }),
    toDate: (d) => d,
    getCityName: (c) => c,
    getLang: () => 'fr',
    slugify: (s) => String(s),
    getStoragePathFromUrl: () => null,
    isStorageUrl: () => false,
    getSignupMethodLabel: () => '',
    getSignupMethodEmoji: () => '',
    formatLivoDate: (d) => String(d),
    isLivoPickupDateValid: () => true,
    parseLivoDate: (d) => d,
    fetchWithRetryResponse,
    fetchWithRetry: fetchWithRetryResponse,
    getRetryAfterMs: () => null,
    firestoreWithRetry: (fn) => fn(),

    /* DOM : jamais utilise par les fonctions testees */
    document: undefined,
    window: undefined,
    localStorage: undefined,

    /* Expose la reponse Livo pilotable */
    __livoState: livoState,
  });

  const code = exposeAll(stripEsm(fs.readFileSync(ORDERS_PATH, 'utf8')), [
    'syncLivoStatus',
    'updateOrderStatus',
    'autoSyncActiveOrders',
  ]);
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: ORDERS_PATH });
  assert.ok(sandbox.__api && typeof sandbox.__api.syncLivoStatus === 'function',
    'syncLivoStatus introuvable dans ' + ORDERS_PATH);
  assert.ok(typeof sandbox.__api.updateOrderStatus === 'function',
    'updateOrderStatus introuvable dans ' + ORDERS_PATH);
  return { api: sandbox.__api, livoState };
}

/* ------------------------------------------------------------------ */
/* Runner minimal (meme forme que tests/grouped-pickup.test.cjs)       */
/* ------------------------------------------------------------------ */

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('PASS: ' + name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log('FAIL: ' + name + ' -> ' + (err && err.message ? err.message : err));
  }
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                          */
/* ------------------------------------------------------------------ */

(async () => {
  const config = loadConfig();
  const { mapLivoStatusToSmart, LIVO_STATUS_MAP, LIVO_SYNCABLE_STATUSES } = config;

  /* T1 ------------------------------------------------------------- */
  await check('T1 : mapLivoStatusToSmart(draft/problem/reported/xyz) -> null', async () => {
    ['draft', 'problem', 'reported', 'xyz', 'inconnu-total'].forEach((raw) => {
      assert.strictEqual(mapLivoStatusToSmart(raw), null,
        `le statut ${raw} ne doit avoir aucun equivalent metier`);
    });
  });

  /* T2 ------------------------------------------------------------- */
  await check('T2 : mapLivoStatusToSmart(null/undefined/"") -> null', async () => {
    assert.strictEqual(mapLivoStatusToSmart(null), null, 'null -> null');
    assert.strictEqual(mapLivoStatusToSmart(undefined), null, 'undefined -> null');
    assert.strictEqual(mapLivoStatusToSmart(''), null, 'chaine vide -> null');
    assert.strictEqual(mapLivoStatusToSmart('   '), null, 'espaces -> null');
  });

  /* T3 ------------------------------------------------------------- */
  await check('T3 : les 7 cles serveur -> statut exact', async () => {
    const expected = {
      'pending': 'confirmed',
      'programmed': 'confirmed',
      'awaiting pickup': 'pickup_requested',
      'awaiting transfer': 'picked_up',
      'in progress': 'in_transit',
      'fulfilled': 'delivered',
      'cancelled': 'cancelled',
    };
    Object.keys(expected).forEach((key) => {
      assert.strictEqual(mapLivoStatusToSmart(key), expected[key],
        `mapping ${key} -> ${expected[key]} attendu`);
    });
    // La casse et les espaces sont tolerés (normalisation interne).
    assert.strictEqual(mapLivoStatusToSmart('IN PROGRESS'), 'in_transit', 'casse toleree');
    assert.strictEqual(mapLivoStatusToSmart('  fulfilled  '), 'delivered', 'espaces toleres');
  });

  /* T4 ------------------------------------------------------------- */
  await check('T4 : "shipping" absent de toutes les values de LIVO_STATUS_MAP', async () => {
    const values = Object.values(LIVO_STATUS_MAP);
    assert.ok(!values.includes('shipping'),
      'shipping est legacy : le mapping client ne doit jamais le produire');
    assert.ok(!values.includes('pending'),
      'pending est un statut d entree : le mapping ne doit pas y ramener une commande');
  });

  /* T5 ------------------------------------------------------------- */
  await check('T5 : statut non mappe -> raw:true, extras ecrits, statut inchange', async () => {
    const store = { o_t5: { status: 'confirmed', livoTracking: 'TRK-T5' } };
    const writes = [];
    const { api, livoState } = loadOrders(config, store, writes);
    livoState.livoOrder = { status: 'problem', return_status: 'returned-started' };

    const res = await api.syncLivoStatus('o_t5');

    assert.strictEqual(res.success, true, 'success attendu');
    assert.strictEqual(res.updated, false, 'aucune mise a jour de statut attendue');
    assert.strictEqual(res.raw, true, 'raw:true attendu sur statut non mappe');
    assert.strictEqual(res.currentStatus, 'problem', 'currentStatus = statut Livo brut');

    assert.strictEqual(writes.length, 1, 'exactement une ecriture extras attendue');
    assert.strictEqual(writes[0].data.livoStatusRaw, 'problem', 'livoStatusRaw ecrit');
    assert.strictEqual(writes[0].data.livoProblem, true, 'livoProblem pose');
    assert.strictEqual(writes[0].data.livoReturnStatus, 'returned-started',
      'livoReturnStatus ecrit');
    // Le statut Smart n'a pas bouge : aucun update de champ status.
    assert.ok(!('status' in writes[0].data), 'le statut Smart ne doit pas etre touche');
    assert.strictEqual(store.o_t5.status, 'confirmed', 'statut Firestore inchange');
  });

  /* T6 ------------------------------------------------------------- */
  await check('T6 : delivered + "in progress" -> terminal:true, statut inchange, extras ecrits', async () => {
    const store = { o_t6: { status: 'delivered', livoTracking: 'TRK-T6' } };
    const writes = [];
    const { api, livoState } = loadOrders(config, store, writes);
    livoState.livoOrder = { status: 'in progress' };

    const res = await api.syncLivoStatus('o_t6');

    assert.strictEqual(res.success, true, 'success attendu');
    assert.strictEqual(res.updated, false, 'une commande livree ne doit pas bouger');
    assert.strictEqual(res.terminal, true, 'terminal:true attendu');
    assert.strictEqual(res.currentStatus, 'in progress', 'currentStatus = statut Livo brut');

    assert.strictEqual(writes.length, 1, 'les extras doivent etre ecrits malgre la garde terminale');
    assert.strictEqual(writes[0].data.livoStatusRaw, 'in progress', 'livoStatusRaw ecrit');
    assert.ok(!('status' in writes[0].data), 'aucun ecrasement du statut terminal');
    assert.strictEqual(store.o_t6.status, 'delivered', 'statut Firestore inchange');
  });

  /* T7 ------------------------------------------------------------- */
  await check('T7 : meme statut -> updated:false, extras ecrits', async () => {
    // in_transit cote Smart, 'in progress' cote Livo : le mapping donne le meme statut.
    const store = { o_t7: { status: 'in_transit', livoTracking: 'TRK-T7' } };
    const writes = [];
    const { api, livoState } = loadOrders(config, store, writes);
    livoState.livoOrder = { status: 'in progress' };

    const res = await api.syncLivoStatus('o_t7');

    assert.strictEqual(res.success, true, 'success attendu');
    assert.strictEqual(res.updated, false, 'statut identique : pas de mise a jour');
    assert.ok(!res.raw, 'raw ne doit pas etre pose');
    assert.ok(!res.terminal, 'terminal ne doit pas etre pose');
    assert.ok(!res.transitionBlocked, 'transitionBlocked ne doit pas etre pose');

    assert.strictEqual(writes.length, 1,
      'bug latent corrige : les extras doivent etre ecrits meme sans changement de statut');
    assert.strictEqual(writes[0].data.livoStatusRaw, 'in progress', 'livoStatusRaw ecrit');
    assert.strictEqual(store.o_t7.status, 'in_transit', 'statut Firestore inchange');
  });

  /* T8 ------------------------------------------------------------- */
  /* PR 8.6 (D2) : le legacy 'shipping' est desormais remappe a la lecture vers
     'in_transit' par normalizeOrderStatus(). Ce scenario verifie donc le
     RATTRAPAGE LEGACY de bout en bout : la commande est stockee en 'shipping',
     Livo dit 'in progress' (= in_transit) : le sync ne doit RIEN changer au
     statut (deja in_transit par remappage) mais doit tracer les extras.
     Sans D2, currentStatus resterait 'shipping' et le sync ecrirait le statut. */
  await check('T8 : legacy shipping + Livo "in progress" -> updated:true, statut in_transit (D2)', async () => {
    const store = {
      o_t8: { status: 'shipping', livoTracking: 'TRK-T8', items: [] },
    };
    const writes = [];
    const { api, livoState } = loadOrders(config, store, writes);
    livoState.livoOrder = { status: 'in progress' };

    // D2 : le remappage doit etre actif AVANT le sync.
    assert.strictEqual(config.normalizeOrderStatus('shipping'), 'in_transit',
      'D2 : normalizeOrderStatus(shipping) doit valoir in_transit');

    const res = await api.syncLivoStatus('o_t8');

    /* Branche 3 de syncLivoStatus (statut Smart inchange) : l'ordre est stocke
       en 'shipping', mais normalizeOrderStatus() le lit deja comme 'in_transit'.
       Livo annoncant 'in progress' (=> in_transit), il n'y a DONC aucun
       changement de statut a appliquer. C'est bien la preuve que D2 est actif :
       sans le remappage, currentStatus vaudrait 'shipping' et la branche 5
       declencherait une ecriture de statut. */
    assert.strictEqual(res.success, true, 'success attendu sur rattrapage legacy');
    assert.strictEqual(res.updated, false,
      'deja in_transit apres remappage D2 : aucun changement a appliquer');
    assert.strictEqual(res.currentStatus, 'in progress', 'currentStatus = statut Livo brut');
    assert.strictEqual(res.terminal, undefined, 'non terminal');

    const statusWrite = writes.find((w) => 'status' in w.data);
    assert.strictEqual(statusWrite, undefined,
      'D2 : aucun changement de statut (shipping est deja lu comme in_transit)');

    const extrasWrite = writes.find((w) => 'livoStatusRaw' in w.data);
    assert.ok(extrasWrite, 'les extras doivent etre ecrits meme sans changement de statut');
    assert.strictEqual(extrasWrite.data.livoStatusRaw, 'in progress', 'livoStatusRaw ecrit');
  });

  /* T8bis ---------------------------------------------------------- */
  /* D2, test unitaire du remappage (ne depend d'aucun stub Firestore). */
  await check('T8bis : normalizeOrderStatus remappe shipping -> in_transit (D2 unitaire)', async () => {
    const norm = config.normalizeOrderStatus;
    assert.strictEqual(norm('shipping'), 'in_transit', 'shipping -> in_transit');
    // Les remappages historiques restent intacts.
    assert.strictEqual(norm('validated'), 'confirmed', 'validated -> confirmed inchange');
    assert.strictEqual(norm('received'), 'delivered', 'received -> delivered inchange');
    // Les statuts courants ne sont pas touches.
    ['pending', 'confirmed', 'preparing', 'prepared', 'pickup_requested',
     'picked_up', 'in_transit', 'delivered', 'returned', 'cancelled'].forEach((st) => {
      assert.strictEqual(norm(st), st, 'le statut courant ' + st + ' ne doit pas etre remappe');
    });
    // Les valeurs falsy retombent sur pending (comportement d'origine).
    assert.strictEqual(norm(''), 'pending', 'chaine vide -> pending');
    assert.strictEqual(norm(null), 'pending', 'null -> pending');
    assert.strictEqual(norm(undefined), 'pending', 'undefined -> pending');
  });

  /* T9 ------------------------------------------------------------- */
  /* PR 8.6 (D1) : confirmed -> in_transit est desormais AUTORISE. Ce scenario
     est l'exigence metier directe de la dette 8.6 : une commande confirmed dont
     Livo dit 'in progress' ne doit plus echouer a chaque sync. */
  await check('T9 : confirmed + "in progress" -> updated:true, statut in_transit (D1)', async () => {
    const store = { o_t9: { status: 'confirmed', livoTracking: 'TRK-T9', items: [] } };
    const writes = [];
    const { api, livoState } = loadOrders(config, store, writes);
    livoState.livoOrder = { status: 'in progress' };

    const res = await api.syncLivoStatus('o_t9');

    assert.strictEqual(res.success, true, 'success attendu (recu : ' + JSON.stringify(res) + ')');
    assert.strictEqual(res.updated, true, 'confirmed -> in_transit doit etre applique');
    assert.strictEqual(res.newStatus, 'in_transit', 'nouveau statut attendu');
    assert.strictEqual(res.currentStatus, 'in progress', 'currentStatus = statut Livo brut');
    assert.ok(!res.transitionBlocked, 'transitionBlocked ne doit plus etre pose sur ce cas');

    const statusWrite = writes.find((w) => 'status' in w.data);
    assert.ok(statusWrite, 'le statut doit avoir ete ecrit');
    assert.strictEqual(statusWrite.data.status, 'in_transit', 'statut ecrit = in_transit');

    const extrasWrite = writes.find((w) => 'livoStatusRaw' in w.data);
    assert.ok(extrasWrite, 'les extras doivent etre ecrits (ecriture tracee)');
    assert.strictEqual(extrasWrite.data.livoStatusRaw, 'in progress', 'livoStatusRaw ecrit');
  });
  /* T9bis ---------------------------------------------------------- */
  /* Contrat reel de updateOrderStatus : la fonction NE LEVE JAMAIS. Son corps
     est encapsule dans un try/catch et renvoie { success: false, error }.
     On asserte donc le RESULTAT, pas une exception.

     PR 8.6 : le cas confirmed -> in_transit est desormais ACCEPTE (D1). Les
     refus restants doivent venir des vrais invariants metier : statuts
     terminaux, garde anti-credit, et eligibilite entrepot pour le dropoff. */
  await check('T9bis : confirmed->in_transit accepte (D1), refus terminaux/anti-credit conserves', async () => {
    const writes = [];

    /* 1) confirmed -> in_transit : DESORMAIS AUTORISE (D1, dette 8.6 close) */
    const s1 = { o_a: { status: 'confirmed', items: [] } };
    const a1 = loadOrders(config, s1, writes).api;
    const r1 = await a1.updateOrderStatus('o_a', 'in_transit');
    assert.strictEqual(r1.success, true,
      'confirmed -> in_transit doit etre autorise (recu : ' + JSON.stringify(r1) + ')');
    const w1 = writes.filter((w) => w.id === 'o_a' && 'status' in w.data);
    assert.ok(w1.length >= 1, 'la mise a jour confirmed -> in_transit doit etre ecrite');
    assert.strictEqual(w1[0].data.status, 'in_transit', 'statut ecrit = in_transit');

    /* 2) shipping -> in_transit : la cle ALLOWED_TRANSITIONS[shipping] contient
       toujours IN_TRANSIT (legacy conserve). MAIS updateOrderStatus normalise
       d'abord previousStatus : une ligne stockee en 'shipping' est lue
       'in_transit', donc la transition demandee devient in_transit -> in_transit,
       refusee comme no-op. Comportement ATTENDU post-D2 : le legacy est deja
       considere in_transit a la lecture, il n'y a rien a re-ecrire. */
    const s2 = { o_b: { status: 'shipping', items: [] } };
    const a2 = loadOrders(config, s2, writes).api;
    const r2 = await a2.updateOrderStatus('o_b', 'in_transit');
    assert.strictEqual(r2.success, false,
      'post-D2 : shipping est deja lu in_transit, in_transit -> in_transit est refuse');
    assert.match(String(r2.error), /interdite/i,
      'refus attendu par la garde de transition (recu : ' + r2.error + ')');
    assert.strictEqual(writes.filter((w) => w.id === 'o_b' && 'status' in w.data).length, 0,
      'aucune ecriture de statut sur une ligne legacy deja in_transit');

    /* 3) delivered -> in_transit : REFUSE (delivered est terminal) */
    const s3 = { o_c: { status: 'delivered', items: [] } };
    const a3 = loadOrders(config, s3, writes).api;
    const r3 = await a3.updateOrderStatus('o_c', 'in_transit');
    assert.strictEqual(r3.success, false, 'delivered -> in_transit doit etre refuse');
    assert.match(String(r3.error), /interdite/i,
      'delivered est terminal : aucune transition sortante (recu : ' + r3.error + ')');
    assert.strictEqual(s3.o_c.status, 'delivered', 'statut inchange apres refus');
    assert.strictEqual(writes.filter((w) => w.id === 'o_c' && 'status' in w.data).length, 0,
      'un refus ne doit rien ecrire');

    /* 4) pending -> delivered : REFUSE (garde anti-credit vendeur) */
    const s4 = { o_d: { status: 'pending', items: [] } };
    const a4 = loadOrders(config, s4, writes).api;
    const r4 = await a4.updateOrderStatus('o_d', 'delivered');
    assert.strictEqual(r4.success, false,
      'pending -> delivered doit rester refuse (anti-credit vendeur)');
    assert.strictEqual(s4.o_d.status, 'pending', 'statut inchange apres refus');

    /* 5) confirmed -> pickup_requested : reste DANS la table des transitions.
       Un refus doit venir de la garde d eligibilite entrepot (PR 8.4), jamais
       de ALLOWED_TRANSITIONS. On asserte l invariant, pas l issue. */
    const s5 = { o_e: { status: 'confirmed', items: [], paymentStatus: 'unpaid' } };
    const a5 = loadOrders(config, s5, writes).api;
    const r5 = await a5.updateOrderStatus('o_e', 'pickup_requested');
    assert.ok(!/interdite/i.test(String(r5 && r5.error)),
      'confirmed -> pickup_requested doit rester autorise dans ALLOWED_TRANSITIONS ' +
      '(un refus doit venir de l eligibilite entrepot, recu : ' + (r5 && r5.error) + ')');
    if (r5 && r5.success === true) {
      assert.strictEqual(s5.o_e.status, 'pickup_requested', 'statut ecrit si autorise');
    } else {
      assert.strictEqual(s5.o_e.status, 'confirmed', 'statut inchange si refus');
    }
  });

  /* T10 ------------------------------------------------------------ */
  await check('T10 : LIVO_SYNCABLE_STATUSES contient shipping+in_transit, exclut pending+preparing', async () => {
    assert.ok(LIVO_SYNCABLE_STATUSES.includes('shipping'),
      'shipping doit rester syncable (legacy, retrait en 8.6)');
    assert.ok(LIVO_SYNCABLE_STATUSES.includes('in_transit'),
      'in_transit doit etre syncable');
    assert.ok(!LIVO_SYNCABLE_STATUSES.includes('pending'),
      'pending ne doit pas etre syncable (le webhook rattrape)');
    assert.ok(!LIVO_SYNCABLE_STATUSES.includes('preparing'),
      'preparing ne doit pas etre syncable (le webhook rattrape)');
    // Completude : les 6 statuts attendus, ni plus ni moins.
    assert.deepStrictEqual(
      Array.from(LIVO_SYNCABLE_STATUSES).slice().sort(),
      ['confirmed', 'in_transit', 'picked_up', 'pickup_requested', 'prepared', 'shipping'],
      'LIVO_SYNCABLE_STATUSES doit contenir exactement les 6 statuts prevus'
    );
  });

  /* ------------------------------------------------------------------ */
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' verifications PASS');
  if (failed.length) {
    console.log('ECHECS: ' + failed.map((f) => f.name).join(' | '));
    process.exit(1);
  }
})();
