#!/usr/bin/env node
/*
 * tests/backfill-shipping.test.cjs
 *
 * PR 8.7 (C2) - tests du script de migration `shipping` -> `in_transit`.
 *
 * Le script de production n'est PAS copie ni reecrit : il est require() tel
 * quel. Le script expose { main, parseArgs } via module.exports quand il est
 * charge comme module (require.main === module gere le cas CLI). Aucun strip
 * de bootstrap, aucun vm, aucune regex sur le source.
 *
 * firebase-admin est simule en patchant Module._load (firebase-admin/app et
 * firebase-admin/firestore). Firestore est un stub en memoire.
 *
 * Lancement : node tests/backfill-shipping.test.cjs
 */
'use strict';

const path = require('path');
const assert = require('assert');
const Module = require('module');
const fsReal = require('fs');

const SCRIPT_PATH = path.join(
  __dirname,
  '..',
  'scripts',
  'backfill-shipping-to-in-transit.cjs'
);

const FIXED_CREATED_AT = '2025-01-01T08:00:00.000Z';
const FIXED_UPDATED_AT = '2025-01-15T10:00:00.000Z';
const SERVER_TS = '__SERVER_TS__';

/* ============================================================
   STUB FIRESTORE EN MEMOIRE
   ============================================================ */

function materialize(patch) {
  const out = {};
  Object.keys(patch).forEach((k) => {
    const v = patch[k];
    if (v && typeof v === 'object' && v.__isServerTimestamp === true) {
      out[k] = SERVER_TS;
    } else {
      out[k] = v;
    }
  });
  return out;
}

/* Store : objet id -> data. Le stub ne conserve que les champs du patch
   (comme Firestore : update() est un merge partiel, jamais un remplacement). */
function makeDb(store, opts) {
  const options = opts || {};
  const failIds = options.failIds || new Set();
  const writes = [];

  function failFor(id) {
    if (failIds.has(id)) {
      const err = new Error('simulated write failure for ' + id);
      err.code = 'permission-denied';
      throw err;
    }
  }

  function applyPatch(id, patch) {
    failFor(id);
    const merged = Object.assign({}, store[id] || {});
    const mat = materialize(patch);
    Object.keys(mat).forEach((k) => {
      merged[k] = mat[k];
    });
    store[id] = merged;
    writes.push({ id: id, keys: Object.keys(mat).sort(), patch: mat });
  }

  function makeRef(id) {
    return {
      id: id,
      path: 'orders/' + id,
      data: function () {
        return store[id] ? Object.assign({}, store[id]) : undefined;
      },
      update: async function (patch) {
        applyPatch(id, patch);
      }
    };
  }

  /* --- query ---
     Chaine : .where().orderBy().limit().startAfter().get()
     Le tri est fait sur l'id (comme orderBy(documentId())).
     La comparaison supporte '==' (utilise par le script). */
  function runQuery(state) {
    const allIds = Object.keys(store).sort();
    let ids = allIds;

    state.filters.forEach((f) => {
      const field = f.field;
      const op = f.op;
      const value = f.value;
      ids = ids.filter((id) => {
        const doc = store[id] || {};
        const left = field === '__name__' || field === 'documentId' || field === '__id__'
          ? id
          : doc[field];
        if (op === '==') return left === value;
        if (op === '!=') return left !== value;
        if (op === 'in') return Array.isArray(value) ? value.indexOf(left) !== -1 : false;
        return true;
      });
    })

    if (state.afterId !== null && state.afterId !== undefined) {
      ids = ids.filter((id) => id > state.afterId);
    }

    if (Number.isFinite(state.limitValue)) {
      ids = ids.slice(0, state.limitValue);
    }

    return ids;
  }

  function makeQuery(state) {
    return {
      where: function (field, op, value) {
        const next = Object.assign({}, state, { filters: state.filters.concat([{ field: field, op: op, value: value }]) });
        return makeQuery(next);
      },
      orderBy: function () {
        return makeQuery(state);
      },
      limit: function (n) {
        return makeQuery(Object.assign({}, state, { limitValue: n }));
      },
      startAfter: function (docSnap) {
        const afterId = docSnap && docSnap.id ? docSnap.id : String(docSnap);
        return makeQuery(Object.assign({}, state, { afterId: afterId }));
      },
      count: function () {
        const ids = runQuery(state);
        return {
          get: async function () {
            return { data: function () { return { count: ids.length }; } };
          }
        };
      },
      get: async function () {
        const ids = runQuery(state);
        const docs = ids.map((id) => {
          return {
            id: id,
            ref: makeRef(id),
            exists: true,
            data: function () { return Object.assign({}, store[id]); }
          };
        });
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs: docs,
          forEach: function (fn) { docs.forEach((d) => fn(d)); }
        };
      }
    };
  }

  function collection() {
    return makeQuery({ filters: [], afterId: null, limitValue: Infinity });
  }

  function batch() {
    const ops = [];
    return {
      update: function (ref, patch) {
        ops.push({ ref: ref, patch: patch });
        return this;
      },
      commit: async function () {
        /* Echec atomique si UN document du lot echoue (comportement batch). */
        ops.forEach((op) => failFor(op.ref.id));
        ops.forEach((op) => applyPatch(op.ref.id, op.patch));
      }
    };
  }

  const db = {
    collection: collection,
    batch: batch
  };

  return { db: db, writes: writes, store: store };
}

/* ============================================================
   STUBS firebase-admin / fs
   ============================================================ */

function installAdminStub(db) {
  const originalLoad = Module._load;

  Module._load = function (request, parent, isMain) {
    if (request === 'firebase-admin/app') {
      return {
        getApps: function () { return []; },
        initializeApp: function () { return { name: 'test-app' }; },
        cert: function () { return {}; }
      };
    }
    if (request === 'firebase-admin/firestore') {
      return {
        getFirestore: function () { return db; },
        FieldValue: {
          serverTimestamp: function () { return { __isServerTimestamp: true }; }
        },
        FieldPath: {
          documentId: function () { return '__name__'; }
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  return function restore() {
    Module._load = originalLoad;
  };
}

function installFsStub() {
  const originalExistsSync = fsReal.existsSync;
  const originalReadFileSync = fsReal.readFileSync;

  fsReal.existsSync = function (p) {
    if (String(p).indexOf('fake-key.json') !== -1) return true;
    return originalExistsSync.apply(fsReal, arguments);
  };

  fsReal.readFileSync = function (p, enc) {
    if (String(p).indexOf('fake-key.json') !== -1) {
      return JSON.stringify({ project_id: 'smartswi9a-31063', type: 'service_account' });
    }
    return originalReadFileSync.apply(fsReal, arguments);
  };

  return function restore() {
    fsReal.existsSync = originalExistsSync;
    fsReal.readFileSync = originalReadFileSync;
  };
}

/* ============================================================
   HARNAIS
   ============================================================ */

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (err) {
    failed += 1;
    console.log('FAIL ' + name);
    console.log('     ' + (err && err.message ? err.message : String(err)));
  }
}

async function run(store, argv, opts) {
  const options = opts || {};
  const built = makeDb(store, options);
  const restoreAdmin = installAdminStub(built.db);
  const restoreFs = installFsStub();

  const savedArgv = process.argv.slice();
  const savedLog = console.log;
  const savedErr = console.error;
  const logs = [];
  const errors = [];

  let resolved = null;
  try {
    resolved = require.resolve(SCRIPT_PATH);
    delete require.cache[resolved];
  } catch (_) {
    resolved = null;
  }

  process.argv = ['node', SCRIPT_PATH].concat(argv || []);
  console.log = function () {
    logs.push(Array.prototype.slice.call(arguments).join(' '));
  };
  console.error = function () {
    errors.push(Array.prototype.slice.call(arguments).join(' '));
  };

  let code;
  try {
    const mod = require(SCRIPT_PATH);
    assert.strictEqual(typeof mod.main, 'function', 'module.exports.main doit etre une fonction');
    const ret = await mod.main();
    code = ret;
  } finally {
    console.log = savedLog;
    console.error = savedErr;
    process.argv = savedArgv;
    restoreFs();
    restoreAdmin();
    if (resolved) delete require.cache[resolved];
  }

  return { writes: built.writes, store: store, logs: logs, errors: errors, code: code };
}

/* ============================================================
   FIXTURES
   ============================================================ */

function shippingOrder(extra) {
  return Object.assign({
    status: 'shipping',
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_UPDATED_AT
  }, extra || {});
}

function baseOrder(status) {
  return {
    status: status,
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_UPDATED_AT
  };
}

const KEY_ARG = '--key=fake-key.json';

/* ============================================================
   TESTS
   ============================================================ */

async function t1() {
  const store = {
    t1: baseOrder('in_transit'),
    d1: baseOrder('delivered')
  };
  const before = JSON.stringify(store);

  const dry = await run(store, [KEY_ARG, '--dry-run']);
  assert.strictEqual(dry.writes.length, 0, 'dry-run : aucune ecriture');
  assert.strictEqual(dry.code, 0, 'dry-run : code 0');

  const apply = await run(store, [KEY_ARG, '--apply']);
  assert.strictEqual(apply.writes.length, 0, 'apply sur 0 shipping : aucune ecriture');
  assert.strictEqual(apply.code, 0, 'apply sur 0 shipping : code 0');

  assert.strictEqual(JSON.stringify(store), before, 'store inchange');
  assert.strictEqual(store.t1.status, 'in_transit');
  assert.strictEqual(store.d1.status, 'delivered');
}

async function t2() {
  const store = {
    s1: shippingOrder(),
    s2: shippingOrder(),
    s3: shippingOrder(),
    t1: baseOrder('in_transit'),
    t2: baseOrder('in_transit'),
    d1: baseOrder('delivered')
  };

  const dry = await run(store, [KEY_ARG, '--dry-run']);
  assert.strictEqual(dry.writes.length, 0, 'dry-run : 0 ecriture');
  const dryText = dry.logs.join('\n');
  assert.ok(dryText.indexOf('3 commande(s)') !== -1, 'le rapport annonce 3 commande(s) a migrer');

  const apply = await run(store, [KEY_ARG, '--apply']);
  assert.strictEqual(apply.writes.length, 3, 'apply : exactement 3 writes');
  const ids = apply.writes.map((w) => w.id).sort();
  assert.deepStrictEqual(ids, ['s1', 's2', 's3'], 'les 3 writes portent sur s1/s2/s3');
  assert.strictEqual(store.s1.status, 'in_transit');
  assert.strictEqual(store.s2.status, 'in_transit');
  assert.strictEqual(store.s3.status, 'in_transit');
  assert.strictEqual(store.t1.status, 'in_transit');
  assert.strictEqual(store.d1.status, 'delivered');
  assert.strictEqual(store.t1.updatedAt, FIXED_UPDATED_AT, 't1 non touche (updatedAt)');
  assert.strictEqual(store.d1.updatedAt, FIXED_UPDATED_AT, 'd1 non touche (updatedAt)');
  assert.strictEqual(apply.code, 0, 'apply : code 0');

  const second = await run(store, [KEY_ARG, '--apply']);
  assert.strictEqual(second.writes.length, 0, '2e apply : 0 ecriture (idempotent)');
  assert.strictEqual(second.code, 0, '2e apply : code 0');
}

async function t3() {
  const store = {
    legacy: {
      status: 'shipping',
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_UPDATED_AT
    }
  };
  assert.ok(!Object.prototype.hasOwnProperty.call(store.legacy, 'trackingStartedAt'), 'fixture sans trackingStartedAt');

  const r = await run(store, [KEY_ARG, '--apply']);
  assert.strictEqual(r.writes.length, 1, '1 write');
  const w = r.writes[0];
  assert.strictEqual(w.id, 'legacy');
  assert.ok(w.keys.indexOf('updatedAt') === -1, 'le patch ne contient PAS updatedAt');
  assert.strictEqual(store.legacy.updatedAt, FIXED_UPDATED_AT, 'updatedAt STRICTEMENT inchange');
  assert.strictEqual(store.legacy.status, 'in_transit', 'status migre');
  assert.strictEqual(store.legacy.createdAt, FIXED_CREATED_AT, 'createdAt intact');
  assert.strictEqual(r.code, 0, 'code 0');
}

async function t4() {
  const store = {
    s1: shippingOrder(),
    s2: shippingOrder(),
    s3: shippingOrder()
  };
  const failIds = new Set(['s2']);

  const r = await run(store, [KEY_ARG, '--apply'], { failIds: failIds });
  assert.strictEqual(store.s1.status, 'in_transit', 's1 migre');
  assert.strictEqual(store.s3.status, 'in_transit', 's3 migre');
  assert.strictEqual(store.s2.status, 'shipping', 's2 reste shipping');

  const errText = r.errors.join('\n');
  assert.ok(errText.indexOf('s2') !== -1, 'console.error mentionne l id fautif (s2)');

  const resumeLines = r.logs.filter((l) => l.indexOf('en erreur') !== -1);
  assert.ok(resumeLines.length > 0, 'le resume contient une ligne en erreur');
  assert.ok(resumeLines.join(' ').indexOf('1') !== -1, 'la ligne en erreur porte le compte');

  assert.strictEqual(r.code, 1, 'code de sortie 1');
}

async function t5() {
  const store = {
    s1: shippingOrder(),
    s2: shippingOrder(),
    s3: shippingOrder()
  };

  const r1 = await run(store, [KEY_ARG, '--apply', '--limit=2']);
  assert.strictEqual(r1.writes.length, 2, '--limit=2 : exactement 2 writes');
  assert.strictEqual(r1.code, 0);

  const shippingLeft = Object.keys(store).filter((id) => store[id].status === 'shipping');
  assert.strictEqual(shippingLeft.length, 1, '1 commande reste shipping');

  const r2 = await run(store, [KEY_ARG, '--apply']);
  assert.strictEqual(r2.writes.length, 1, 'apply sans limite : 1 write');
  assert.strictEqual(r2.code, 0);

  const noneLeft = Object.keys(store).filter((id) => store[id].status === 'shipping');
  assert.strictEqual(noneLeft.length, 0, '0 shipping restant');
}

async function t6() {
  const store = {
    only: shippingOrder()
  };

  const r = await run(store, [KEY_ARG, '--apply']);
  assert.strictEqual(r.writes.length, 1, '1 write');
  const patch = r.writes[0].patch;

  assert.deepStrictEqual(
    Object.keys(patch).sort(),
    ['migratedAt', 'migratedFrom', 'status'],
    'le patch contient EXACTEMENT migratedAt/migratedFrom/status'
  );
  assert.strictEqual(patch.migratedFrom, 'shipping');
  assert.strictEqual(patch.status, 'in_transit');
  assert.strictEqual(patch.migratedAt, SERVER_TS, 'migratedAt = serverTimestamp');
  assert.ok(!Object.prototype.hasOwnProperty.call(patch, 'updatedAt'), 'pas de updatedAt dans le patch');
  assert.ok(!Object.prototype.hasOwnProperty.call(patch, 'createdAt'), 'pas de createdAt dans le patch');
  assert.ok(!Object.prototype.hasOwnProperty.call(patch, 'trackingStartedAt'), 'pas de trackingStartedAt dans le patch');

  assert.strictEqual(store.only.updatedAt, FIXED_UPDATED_AT, 'updatedAt en base inchange');
  assert.strictEqual(store.only.createdAt, FIXED_CREATED_AT, 'createdAt en base inchange');
}

/* ============================================================
   MAIN
   ============================================================ */

async function main() {
  await check('T1 - 0 shipping : dry-run et apply = 0 ecriture', t1);
  await check('T2 - 3 shipping : dry-run puis apply 3 writes, 2e apply idempotent', t2);
  await check('T3 - shipping legacy sans trackingStartedAt : updatedAt intact', t3);
  await check('T4 - 1 echec sur 3 : les 2 autres passent, code 1', t4);
  await check('T5 - --limit=2 puis sans limite', t5);
  await check('T6 - patch exact : 3 cles, updatedAt intact', t6);

  console.log('');
  console.log('Resultat : ' + passed + '/' + (passed + failed) + ' tests passes');
  if (failed > 0) {
    process.exit(1);
  }
}

main();
