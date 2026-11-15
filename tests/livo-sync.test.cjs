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
  await check('T8 : legacy shipping -> in_transit : updated:true (transition autorisee)', async () => {
    const store = {
      o_t8: { status: 'shipping', livoTracking: 'TRK-T8', items: [] },
    };
    const writes = [];
    const { api, livoState } = loadOrders(config, store, writes);
    livoState.livoOrder = { status: 'in progress' };

    const res = await api.syncLivoStatus('o_t8');

    assert.strictEqual(res.success, true, 'success attendu sur transition legacy autorisee');
    assert.strictEqual(res.updated, true, 'shipping -> in_transit doit etre applique');
    assert.strictEqual(res.newStatus, 'in_transit', 'nouveau statut attendu');

    const statusWrite = writes.find((w) => 'status' in w.data);
    assert.ok(statusWrite, 'le statut doit avoir ete ecrit');
    assert.strictEqual(statusWrite.data.status, 'in_transit', 'statut ecrit = in_transit');

    const extrasWrite = writes.find((w) => 'livoStatusRaw' in w.data);
    assert.ok(extrasWrite, 'les extras doivent aussi etre ecrits sur la branche updated');
    assert.strictEqual(extrasWrite.data.livoStatusRaw, 'in progress', 'livoStatusRaw ecrit');

    // normalizeOrderStatus n'a pas remappe le legacy : il est bien reste 'shipping'
    // avant la mise a jour (sinon le cas ne testerait pas la transition visée).
    assert.strictEqual(config.normalizeOrderStatus('shipping'), 'shipping',
      'shipping reste un statut legacy distinct (retrait prevu en 8.6)');
  });

  /* T9 ------------------------------------------------------------- */
  await check('T9 : confirmed + "in progress" -> transitionBlocked:true, extras ecrits', async () => {
    const store = { o_t9: { status: 'confirmed', livoTracking: 'TRK-T9' } };
    const writes = [];
    const { api, livoState } = loadOrders(config, store, writes);
    livoState.livoOrder = { status: 'in progress' };

    const res = await api.syncLivoStatus('o_t9');

    assert.strictEqual(res.success, true,
      'une transition bloquee est un cas nominal, pas une erreur technique');
    assert.strictEqual(res.updated, false, 'la commande ne doit pas bouger');
    assert.strictEqual(res.transitionBlocked, true, 'transitionBlocked:true attendu');
    assert.strictEqual(res.currentStatus, 'in progress', 'currentStatus = statut Livo brut');
    assert.strictEqual(res.targetStatus, 'in_transit', 'targetStatus attendu');
    assert.match(res.reason, /confirmed/,
      'la raison doit nommer le statut courant (recu : ' + res.reason + ')');
    assert.match(res.reason, /in_transit/,
      'la raison doit nommer le statut cible (recu : ' + res.reason + ')');

    assert.strictEqual(writes.length, 1,
      'les extras doivent etre ecrits malgre le blocage de transition');
    assert.strictEqual(writes[0].data.livoStatusRaw, 'in progress', 'livoStatusRaw ecrit');
    assert.ok(!('status' in writes[0].data), 'aucun ecrasement du statut Smart');
    assert.strictEqual(store.o_t9.status, 'confirmed', 'statut Firestore inchange');
  });

  /* T9bis ---------------------------------------------------------- */
  /* Contrat reel de updateOrderStatus : la fonction NE LEVE JAMAIS. Son corps
     est encapsule dans un try/catch (js/orders.js:1066-1069) et renvoie
     { success: false, error }. On asserte donc le RESULTAT, pas une exception
     (c'etait l'erreur de la premiere version de ce test). */
  await check('T9bis : apres hissage, updateOrderStatus refuse toujours les memes transitions', async () => {
    const writes = [];

    /* confirmed -> in_transit : REFUSE (workflow metier, reporte en 8.6) */
    const s1 = { o_a: { status: 'confirmed', items: [] } };
    const a1 = loadOrders(config, s1, writes).api;
    const r1 = await a1.updateOrderStatus('o_a', 'in_transit');
    assert.strictEqual(r1.success, false, 'confirmed -> in_transit doit etre refuse');
    assert.match(String(r1.error), /interdite/i,
      'le refus doit venir de la garde de transition (recu : ' + r1.error + ')');
    assert.match(String(r1.error), /in_transit/,
      'le refus doit nommer le statut cible (recu : ' + r1.error + ')');
    assert.strictEqual(s1.o_a.status, 'confirmed', 'statut inchange apres refus');
    assert.strictEqual(writes.length, 0, 'un refus ne doit rien ecrire');

    /* shipping -> in_transit : AUTORISE (legacy) */
    const s2 = { o_b: { status: 'shipping', items: [] } };
    const a2 = loadOrders(config, s2, writes).api;
    const r2 = await a2.updateOrderStatus('o_b', 'in_transit');
    assert.strictEqual(r2.success, true,
      'shipping -> in_transit doit rester autorise (recu : ' + JSON.stringify(r2) + ')');
    const w2 = writes.filter((w) => w.id === 'o_b' && 'status' in w.data);
    assert.ok(w2.length >= 1, 'la mise a jour shipping -> in_transit doit etre ecrite');
    assert.strictEqual(w2[0].data.status, 'in_transit', 'statut ecrit = in_transit');

    /* delivered -> in_transit : REFUSE (delivered est terminal) */
    const s3 = { o_c: { status: 'delivered', items: [] } };
    const a3 = loadOrders(config, s3, writes).api;
    const r3 = await a3.updateOrderStatus('o_c', 'in_transit');
    assert.strictEqual(r3.success, false, 'delivered -> in_transit doit etre refuse');
    assert.match(String(r3.error), /interdite/i,
      'delivered est terminal : aucune transition sortante (recu : ' + r3.error + ')');
    assert.strictEqual(s3.o_c.status, 'delivered', 'statut inchange apres refus');

    /* pending -> delivered : REFUSE (garde anti-credit sans expedition) */
    const s4 = { o_d: { status: 'pending', items: [] } };
    const a4 = loadOrders(config, s4, writes).api;
    const r4 = await a4.updateOrderStatus('o_d', 'delivered');
    assert.strictEqual(r4.success, false,
      'pending -> delivered doit rester refuse (anti-credit vendeur)');
    assert.strictEqual(s4.o_d.status, 'pending', 'statut inchange apres refus');

    /* confirmed -> pickup_requested : reste DANS la table des transitions.
       Un refus doit venir de la garde d'eligibilite entrepot (PR 8.4), jamais
       de ALLOWED_TRANSITIONS. On asserte l'invariant, pas l'issue. */
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
