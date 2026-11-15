#!/usr/bin/env node
/*
 * Simulation locale de l'endpoint livoWebhook.
 *
 * Aucun appel reseau : ni Livo, ni Firestore, ni Firebase.
 * Le VRAI handler est extrait de functions/index.js et execute dans un sandbox vm,
 * avec un Firestore en memoire (StubDB) et des objets req/res simules.
 *
 * But : verifier le comportement applicatif de bout en bout (signature -> parsing
 * d'evenement -> transaction -> mise a jour de la commande -> idempotence),
 * ce que les tests de conformite (regex + extraits) ne couvrent pas.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

const INDEX = path.join(__dirname, '..', 'functions', 'index.js');
const src = fs.readFileSync(INDEX, 'utf8');
const SECRET = 'lv_whsec_simulation_locale_0123456789abcdef0123456789abcdef01234567';
const COLLECTION = 'livo_webhook_events';

/* ------------------------------------------------------------------ */
/* Extraction du handler reel                                         */
/* ------------------------------------------------------------------ */

function extractHandler() {
  const start = src.indexOf('exports.livoWebhook = onRequest(');
  assert.ok(start >= 0, 'exports.livoWebhook introuvable dans index.js');

  const marker = '}, async (req, res) => {';
  const bodyStart = src.indexOf(marker, start);
  assert.ok(bodyStart >= 0, 'signature du handler introuvable');

  // On demarre sur "async (req, res) => {" et non sur le "{" seul :
  // sinon on extrait un bloc orphelin, invalide syntaxiquement.
  const decl = 'async (req, res) => {';
  const fnStart = bodyStart + marker.length - decl.length;
  assert.strictEqual(src.slice(fnStart, fnStart + decl.length), decl, 'debut du handler inattendu');

  const SLASH = '/';
  const STAR = '*';
  const BACKSLASH = '\\';
  const NEWLINE = '\n';
  const DQUOTE = '"';
  const SQUOTE = "'";
  const BTICK = '`';

  let depth = 0;
  let quote = null;
  let escaped = false;
  let i = fnStart;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === BACKSLASH) { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === DQUOTE || c === SQUOTE || c === BTICK) { quote = c; continue; }
    if (c === SLASH && src[i + 1] === SLASH) {
      while (i < src.length && src[i] !== NEWLINE) i++;
      continue;
    }
    if (c === SLASH && src[i + 1] === STAR) {
      i += 2;
      while (i < src.length && !(src[i] === STAR && src[i + 1] === SLASH)) i++;
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, 'fermeture du handler non trouvee');
  const handlerSrc = src.slice(fnStart, i + 1);
  assert.ok(handlerSrc.length > 4000, 'handler extrait trop court: ' + handlerSrc.length);
  return handlerSrc;
}

/* ------------------------------------------------------------------ */
/* Firestore en memoire                                               */
/* ------------------------------------------------------------------ */

function createStubDb(seedOrders, seedProducts) {
  const state = {
    events: new Map(),   // collection livo_webhook_events : id -> data
    orders: new Map(),   // collection orders : id -> data
    products: new Map(), // collection products : id -> data
    calls: { where: 0, transaction: 0, updates: 0, creates: 0, productUpdates: 0 }
  };
  for (const [id, data] of Object.entries(seedOrders || {})) state.orders.set(id, { ...data });
  for (const [id, data] of Object.entries(seedProducts || {})) state.products.set(id, { ...data });

  const storeFor = (kind) => {
    if (kind === 'events') return state.events;
    if (kind === 'orders') return state.orders;
    if (kind === 'products') return state.products;
    throw new Error('kind inconnu: ' + kind);
  };

  const makeRef = (kind, id) => ({
    id,
    __kind: kind,
    get: async () => makeSnapshot(kind, id)
  });

  const makeSnapshot = (kind, id) => {
    const store = storeFor(kind);
    const exists = store.has(id);
    const data = store.get(id);
    return { exists, id, data: () => (exists ? { ...data } : undefined), ref: makeRef(kind, id) };
  };

  // Applique un patch en respectant les sentinelles FieldValue.increment().
  const applyPatch = (store, id, patch) => {
    const current = { ...(store.get(id) || {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && value.__increment !== undefined) {
        const base = Number(current[key]) || 0;
        current[key] = base + value.__increment;
      } else {
        current[key] = value;
      }
    }
    store.set(id, current);
  };

  const db = {
    collection(name) {
      const kind = name === COLLECTION ? 'events' : name;
      assert.ok(['events', 'orders', 'products'].includes(kind), 'collection inattendue: ' + name);
      return {
        doc: (id) => makeRef(kind, id),
        where(field, op, value) {
          state.calls.where++;
          assert.strictEqual(kind, 'orders', 'where() attendu sur orders');
          assert.strictEqual(op, '==', 'seul == est attendu: ' + op);
          return {
            limit() { return this; },
            async get() {
              const docs = [];
              for (const [id, data] of state.orders.entries()) {
                if (data[field] === value) docs.push(makeSnapshot('orders', id));
              }
              return { size: docs.length, docs };
            }
          };
        }
      };
    },
    async runTransaction(fn) {
      state.calls.transaction++;
      const tx = {
        async get(ref) {
          assert.ok(['events', 'orders', 'products'].includes(ref.__kind), 'get sur kind ' + ref.__kind);
          return makeSnapshot(ref.__kind, ref.id);
        },
        create(ref, data) {
          assert.strictEqual(ref.__kind, 'events');
          assert.ok(!state.events.has(ref.id), 'create sur un evenement existant');
          state.events.set(ref.id, { ...data });
          state.calls.creates++;
        },
        update(ref, data) {
          assert.ok(['orders', 'products'].includes(ref.__kind), 'update sur kind ' + ref.__kind);
          assert.ok(storeFor(ref.__kind).has(ref.id), 'update sur ' + ref.__kind + ' inexistant: ' + ref.id);
          applyPatch(storeFor(ref.__kind), ref.id, data);
          if (ref.__kind === 'products') state.calls.productUpdates++;
          else state.calls.updates++;
        }
      };
      return fn(tx);
    }
  };
  return { db, state };
}

/* ------------------------------------------------------------------ */
/* req / res simules                                                  */
/* ------------------------------------------------------------------ */

function makeRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: undefined,
    set(k, v) { this._headers[k.toLowerCase()] = v; return this; },
    status(code) { this._status = code; return this; },
    json(payload) { this._body = payload; return this; }
  };
  return res;
}

function makeReq({ method = 'POST', headers = {}, rawBody = null }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    method,
    rawBody,
    get(name) { return lower[String(name).toLowerCase()]; }
  };
}

/* ------------------------------------------------------------------ */
/* Sandbox                                                            */
/* ------------------------------------------------------------------ */

const handlerSrc = extractHandler();

function buildHandler({ secret = SECRET, nowSeconds = Math.floor(Date.now() / 1000), seedOrders, seedProducts } = {}) {
  const stub = createStubDb(seedOrders, seedProducts);
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console: { log() {}, warn() {}, error() {} },
    require(mod) {
      if (mod === 'crypto') return crypto;
      throw new Error('require inattendu: ' + mod);
    },
    db: stub.db,
    LIVO_WEBHOOK_SECRET: { value: () => secret },
    LIVO_WEBHOOK_MAX_CLOCK_SKEW_SECONDS: 300,
    LIVO_WEBHOOK_EVENT_COLLECTION: COLLECTION,
    LIVO_WEBHOOK_ALLOWED_EVENTS: new Set([
      'order.created', 'order.status_changed', 'order.return_status_changed',
      'pickup.created', 'pickup.status_changed',
      'return.created', 'return.status_changed', 'message.created', 'ping'
    ]),
    // Doit rester STRICTEMENT synchrone avec LIVO_STATUS_TO_ORDER_STATUS de
    // functions/index.js (verrouille par tests/livo-compliance.test.cjs).
    // `draft`, `problem` et `reported` sont absents : ces evenements n'ecrivent
    // que livoStatusRaw et ne touchent jamais le statut principal.
    LIVO_STATUS_TO_ORDER_STATUS: {
      pending: 'confirmed',
      programmed: 'confirmed',
      'awaiting pickup': 'pickup_requested',
      'awaiting transfer': 'picked_up',
      'in progress': 'in_transit',
      fulfilled: 'delivered',
      cancelled: 'cancelled'
    },
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      increment: (n) => ({ __increment: n })
    },
    timingSafeTextEqual(left, right) {
      const a = Buffer.from(String(left || ''), 'utf8');
      const b = Buffer.from(String(right || ''), 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
    __clock: { now: nowSeconds },
    // Globals Node absents d'un contexte vm isole.
    // crypto : importe en tete de index.js, donc hors de l'extrait, mais utilise par le handler.
    crypto,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    process: { env: {} }
  };
  sandbox.Date = class extends Date {
    constructor(...args) { if (args.length === 0) super(sandbox.__clock.now * 1000); else super(...args); }
    static now() { return sandbox.__clock.now * 1000; }
  };
  vm.createContext(sandbox);
  sandbox.__handler = undefined;
  vm.runInContext('__handler = (' + handlerSrc + ');', sandbox, { filename: 'livoWebhook-handler.js' });
  assert.strictEqual(typeof sandbox.__handler, 'function', 'handler extrait non executable');
  return { handler: sandbox.__handler, stub, sandbox };
}

function sign(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex');
}

async function deliver({ handler, event, eventId, secret = SECRET, ts, tamperSignature = false, omitBearer = false, method = 'POST' }) {
  const body = Buffer.from(JSON.stringify(event), 'utf8');
  const timestamp = String(ts != null ? ts : Math.floor(Date.now() / 1000));
  const headers = {
    'x-livo-timestamp': timestamp,
    'x-livo-signature': tamperSignature ? 'sha256=' + 'a'.repeat(64) : sign(secret, timestamp, body),
    'x-livo-delivery': eventId,
    'x-livo-event': event && event.event ? event.event : ''
  };
  if (!omitBearer) headers.authorization = 'Bearer ' + secret;
  const req = makeReq({ method, headers, rawBody: body });
  const res = makeRes();
  await handler(req, res);
  return res;
}

/* ------------------------------------------------------------------ */
/* Scenario                                                           */
/* ------------------------------------------------------------------ */

const results = [];
function check(name, fn) {
  return (async () => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log('PASS: ' + name);
    } catch (err) {
      results.push({ name, ok: false, err });
      console.log('FAIL: ' + name + ' -> ' + err.message);
    }
  })();
}

const NOW = Math.floor(Date.now() / 1000);

const ORDER_SEED = {
  cmd_sim_001: { id: 'cmd_sim_001', status: 'pending', livoTracking: 'LIVO-TRK-0001', userId: 'u1' }
};

function statusEvent(status = 'in progress') {
  return {
    id: 'evt_sim_1',
    event: 'order.status_changed',
    created_at: '2026-11-12T20:00:00Z',
    data: { _id: 'LIVO-TRK-0001', status }
  };
}

(async () => {
  /* 1. Signature invalide -> 401, aucun effet */
  await check('signature invalide -> 401 et aucun evenement enregistre', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const res = await deliver({ handler, event: statusEvent(), eventId: 'evt_sim_1', tamperSignature: true });
    assert.strictEqual(res._status, 401, 'status attendu 401, recu ' + res._status);
    assert.strictEqual(stub.state.events.size, 0, 'aucun evenement ne doit etre cree');
    assert.strictEqual(stub.state.orders.get('cmd_sim_001').status, 'pending', 'commande non modifiee');
  });

  /* 2. Bearer absent -> 401 */
  await check('Bearer absent -> 401 meme avec une signature valide', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const res = await deliver({ handler, event: statusEvent(), eventId: 'evt_sim_2', omitBearer: true });
    assert.strictEqual(res._status, 401);
    assert.strictEqual(stub.state.events.size, 0);
  });

  /* 3. Nominal : order.status_changed applique le statut */
  await check('order.status_changed "in progress" -> 200 applied et commande en in_transit', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const res = await deliver({ handler, event: statusEvent('in progress'), eventId: 'evt_sim_3' });
    assert.strictEqual(res._status, 200, 'status ' + res._status + ' ' + JSON.stringify(res._body));
    assert.strictEqual(res._body.success, true);
    assert.strictEqual(res._body.applied, true, 'applied attendu true');
    assert.strictEqual(res._body.duplicate, false);
    const order = stub.state.orders.get('cmd_sim_001');
    // `shipping` est deprecie : PR 8.3 produit `in_transit`.
    assert.strictEqual(order.status, 'in_transit', 'statut commande: ' + order.status);
    assert.strictEqual(order.livoStatusRaw, 'in progress');
    assert.ok(stub.state.events.has('evt_sim_3'), 'evenement journalise');
    assert.strictEqual(stub.state.events.get('evt_sim_3').processing, 'applied');
  });

  /* 4. Idempotence : rejeu du meme eventId -> duplicate, pas de double application */
  await check('rejeu du meme eventId -> duplicate=true, commande inchanges', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const first = await deliver({ handler, event: statusEvent('in progress'), eventId: 'evt_sim_4' });
    assert.strictEqual(first._status, 200);
    const ordersBefore = JSON.stringify(stub.state.orders);
    const updatesBefore = stub.state.calls.updates;

    const second = await deliver({ handler, event: statusEvent('fulfilled'), eventId: 'evt_sim_4' });
    assert.strictEqual(second._status, 200);
    assert.strictEqual(second._body.duplicate, true, 'duplicate attendu true');
    assert.strictEqual(JSON.stringify(stub.state.orders), ordersBefore, 'aucune modification');
    assert.strictEqual(stub.state.calls.updates, updatesBefore, 'aucun update supplementaire');
    assert.strictEqual(stub.state.events.size, 1, 'un seul evenement en base');
  });

  /* 5. Statut terminal : delivered ne doit plus etre ecrase */
  await check('commande deja delivered : statut terminal preserve, livoStatusRaw ecrit', async () => {
    const seed = { cmd_sim_005: { id: 'cmd_sim_005', status: 'delivered', livoTracking: 'LIVO-TRK-0005' } };
    const { handler, stub } = buildHandler({ seedOrders: seed });
    const evt = { id: 'evt_sim_5', event: 'order.status_changed', data: { _id: 'LIVO-TRK-0005', status: 'in progress' } };
    const res = await deliver({ handler, event: evt, eventId: 'evt_sim_5' });
    assert.strictEqual(res._status, 200);
    // Le statut principal ne bouge JAMAIS depuis un etat terminal, mais l'audit
    // brut doit etre enregistre : applied reflete l'ecriture de livoStatusRaw.
    assert.strictEqual(res._body.applied, true, 'applied reflete l ecriture de livoStatusRaw');
    const order = stub.state.orders.get('cmd_sim_005');
    assert.strictEqual(order.status, 'delivered', 'statut terminal preserve');
    assert.strictEqual(order.livoStatusRaw, 'in progress', 'livoStatusRaw trace l evenement');
    assert.strictEqual(order.trackingStartedAt, undefined, 'aucune ancre sur commande terminale');
    assert.strictEqual(stub.state.events.get('evt_sim_5').processing, 'applied');
  });

  /* 6. Tracking inconnu -> unmatched */
  await check('tracking inconnu -> 200 unmatched, aucun update', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const evt = { id: 'evt_sim_6', event: 'order.status_changed', data: { _id: 'LIVO-INCONNU', status: 'in progress' } };
    const res = await deliver({ handler, event: evt, eventId: 'evt_sim_6' });
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied, false);
    assert.strictEqual(stub.state.calls.updates, 0, 'aucun update');
    assert.strictEqual(stub.state.events.get('evt_sim_6').processing, 'unmatched');
  });

  /* 7. order.return_status_changed */
  await check('order.return_status_changed -> livoReturnStatus mis a jour', async () => {
    const seed = { cmd_sim_007: { id: 'cmd_sim_007', status: 'shipping', livoTracking: 'LIVO-TRK-0007' } };
    const { handler, stub } = buildHandler({ seedOrders: seed });
    const evt = { id: 'evt_sim_7', event: 'order.return_status_changed', data: { _id: 'LIVO-TRK-0007', return_status: 'returned' } };
    const res = await deliver({ handler, event: evt, eventId: 'evt_sim_7' });
    assert.strictEqual(res._status, 200, 'status ' + res._status);
    assert.strictEqual(res._body.applied, true);
    const order = stub.state.orders.get('cmd_sim_007');
    assert.strictEqual(order.livoReturnStatus, 'returned');
    assert.strictEqual(order.status, 'shipping', 'le statut principal ne bouge pas');
  });

  /* 8. ping sans data */
  await check('ping sans data -> 200 unmatched (pas de 400)', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const res = await deliver({ handler, event: { id: 'ping_1', event: 'ping' }, eventId: 'ping_1' });
    assert.strictEqual(res._status, 200, 'status ' + res._status + ' ' + JSON.stringify(res._body));
    assert.strictEqual(res._body.success, true);
    assert.strictEqual(stub.state.events.get('ping_1').processing, 'unmatched');
  });

  /* 9. Type d'evenement inconnu */
  await check('type inconnu -> 400 sans creation', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const evt = { id: 'evt_sim_9', event: 'order.deleted', data: { _id: 'LIVO-TRK-0001' } };
    const res = await deliver({ handler, event: evt, eventId: 'evt_sim_9' });
    assert.strictEqual(res._status, 400);
    assert.strictEqual(stub.state.events.size, 0);
  });

  /* 10. Timestamp hors fenetre */
  await check('timestamp a 10 min dans le passe -> 401', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const res = await deliver({ handler, event: statusEvent(), eventId: 'evt_sim_10', ts: NOW - 600 });
    assert.strictEqual(res._status, 401);
    assert.strictEqual(stub.state.events.size, 0);
  });

  /* 11. JSON invalide */
  await check('corps non-JSON -> 400', async () => {
    const { handler } = buildHandler({ seedOrders: ORDER_SEED });
    const raw = Buffer.from('ceci n est pas du json', 'utf8');
    const ts = String(NOW);
    const req = makeReq({
      headers: {
        authorization: 'Bearer ' + SECRET,
        'x-livo-timestamp': ts,
        'x-livo-signature': sign(SECRET, ts, raw),
        'x-livo-delivery': 'evt_sim_11'
      },
      rawBody: raw
    });
    const res = makeRes();
    await handler(req, res);
    assert.strictEqual(res._status, 400);
  });

  /* 12. Secret absent -> 500 (config) */
  await check('secret absent -> 500', async () => {
    const { handler } = buildHandler({ secret: '', seedOrders: ORDER_SEED });
    const res = await deliver({ handler, event: statusEvent(), eventId: 'evt_sim_12' });
    assert.strictEqual(res._status, 500);
  });

  /* 13. Methode != POST */
  await check('GET -> 405', async () => {
    const { handler } = buildHandler({ seedOrders: ORDER_SEED });
    const res = await deliver({ handler, event: statusEvent(), eventId: 'evt_sim_13', method: 'GET' });
    assert.strictEqual(res._status, 405);
  });

  /* 14. T4 : `pending` ne pose PAS l'ancre (commande enregistree, pas prise en charge) */
  await check('T4 : "pending" -> confirmed, reconnu, mais AUCUNE ancre trackingStartedAt', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const res = await deliver({ handler, event: statusEvent('pending'), eventId: 'evt_sim_14' });
    assert.strictEqual(res._status, 200, 'status ' + res._status);
    assert.strictEqual(res._body.applied, true, 'applied attendu true');
    const order = stub.state.orders.get('cmd_sim_001');
    assert.strictEqual(order.status, 'confirmed', 'statut commande: ' + order.status);
    assert.strictEqual(order.livoStatusRaw, 'pending');
    assert.strictEqual(order.trackingStartedAt, undefined, 'pas d ancre sur pending');
    assert.strictEqual(order.trackingStartedFrom, undefined, 'pas d origine sur pending');
  });

  /* 14b. T4 bis : `awaiting pickup` -> pickup_requested SANS ancre */
  await check('T4 bis : "awaiting pickup" -> pickup_requested sans ancre', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const res = await deliver({ handler, event: statusEvent('awaiting pickup'), eventId: 'evt_sim_14b' });
    assert.strictEqual(res._status, 200, 'status ' + res._status);
    assert.strictEqual(res._body.applied, true);
    const order = stub.state.orders.get('cmd_sim_001');
    assert.strictEqual(order.status, 'pickup_requested');
    assert.strictEqual(order.livoStatusRaw, 'awaiting pickup');
    assert.strictEqual(order.trackingStartedAt, undefined, 'aucune ancre sur pickup_requested');
  });

  /* 15. T3 : `in_transit` -> `in_transit` ne repousse pas l'ancre */
  await check('T3 : ancre posee une seule fois sur "in progress", non repoussee ensuite', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const first = await deliver({ handler, event: statusEvent('in progress'), eventId: 'evt_sim_15a' });
    assert.strictEqual(first._status, 200);
    const anchorAfterFirst = stub.state.orders.get('cmd_sim_001').trackingStartedAt;
    assert.deepStrictEqual(anchorAfterFirst, { __serverTimestamp: true }, 'ancre posee sur in progress');
    assert.strictEqual(stub.state.orders.get('cmd_sim_001').trackingStartedFrom, 'livo_webhook');

    const updatesBefore = stub.state.calls.updates;
    // Second event distinct (event_id different) avec le MEME statut Livo.
    const second = await deliver({ handler, event: statusEvent('in progress'), eventId: 'evt_sim_15b' });
    assert.strictEqual(second._status, 200);
    assert.strictEqual(second._body.duplicate, false, 'event_id different => pas un duplicate');
    const order = stub.state.orders.get('cmd_sim_001');
    assert.strictEqual(order.status, 'in_transit');
    assert.deepStrictEqual(order.trackingStartedAt, anchorAfterFirst, 'ancre identique (pas repoussee)');
    assert.strictEqual(order.trackingStartedFrom, 'livo_webhook');
    // L'ancre n'est pas reecrite : la cle doit etre absente du patch.
    assert.strictEqual(stub.state.calls.updates, updatesBefore + 1, 'un seul update (livoStatusRaw)');
  });

  /* 15b. T5 : reconciliation - le Worker a echoue, le webhook rattrape */
  await check('T5 : commande prepared (Worker a echoue) + "awaiting pickup" -> pickup_requested', async () => {
    // Scenario reel : create-pickup est parti, Livo a bien pris le ramassage mais la
    // reponse n'est jamais revenue -> la commande est restee en `prepared`.
    const seed = { cmd_sim_015b: { id: 'cmd_sim_015b', status: 'prepared', livoTracking: 'LIVO-TRK-0015' } };
    const { handler, stub } = buildHandler({ seedOrders: seed });
    const evt = { id: 'evt_sim_15c', event: 'order.status_changed',
                  data: { _id: 'LIVO-TRK-0015', status: 'awaiting pickup' } };
    const res = await deliver({ handler, event: evt, eventId: 'evt_sim_15c' });
    assert.strictEqual(res._status, 200, 'status ' + res._status);
    assert.strictEqual(res._body.applied, true, 'le webhook doit rattraper l etat');
    const order = stub.state.orders.get('cmd_sim_015b');
    assert.strictEqual(order.status, 'pickup_requested', 'statut rattrape: ' + order.status);
    assert.strictEqual(order.livoStatusRaw, 'awaiting pickup');
    assert.strictEqual(order.trackingStartedAt, undefined, 'pas d ancre sur pickup_requested');
  });

  /* 15c. `problem` : livoStatusRaw seul, le statut principal ne bouge pas */
  await check('"problem" -> livoStatusRaw ecrit, statut principal in_transit preserve', async () => {
    const seed = { cmd_sim_015d: { id: 'cmd_sim_015d', status: 'in_transit',
                                   livoTracking: 'LIVO-TRK-0016', trackingStartedAt: { __serverTimestamp: true } } };
    const { handler, stub } = buildHandler({ seedOrders: seed });
    const evt = { id: 'evt_sim_15d', event: 'order.status_changed',
                  data: { _id: 'LIVO-TRK-0016', status: 'problem' } };
    const res = await deliver({ handler, event: evt, eventId: 'evt_sim_15d' });
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied, true, 'applied: livoStatusRaw est ecrit');
    const order = stub.state.orders.get('cmd_sim_015d');
    assert.strictEqual(order.status, 'in_transit', 'statut principal JAMAIS ecrase par problem');
    assert.strictEqual(order.livoStatusRaw, 'problem', 'l incident est trace brut');
  });

  /* 15d. `draft` et `reported` : hors mapping, aucune retrogradation possible */
  await check('"draft" et "reported" -> livoStatusRaw seul, aucune retrogradation', async () => {
    const seed = { cmd_sim_015e: { id: 'cmd_sim_015e', status: 'picked_up', livoTracking: 'LIVO-TRK-0017' } };
    const { handler, stub } = buildHandler({ seedOrders: seed });

    const draft = await deliver({ handler, event: {
      id: 'evt_sim_15e', event: 'order.status_changed',
      data: { _id: 'LIVO-TRK-0017', status: 'draft' } }, eventId: 'evt_sim_15e' });
    assert.strictEqual(draft._status, 200);
    assert.strictEqual(stub.state.orders.get('cmd_sim_015e').status, 'picked_up', 'draft ne retrograde pas');
    assert.strictEqual(stub.state.orders.get('cmd_sim_015e').livoStatusRaw, 'draft');

    const reported = await deliver({ handler, event: {
      id: 'evt_sim_15f', event: 'order.status_changed',
      data: { _id: 'LIVO-TRK-0017', status: 'reported' } }, eventId: 'evt_sim_15f' });
    assert.strictEqual(reported._status, 200);
    assert.strictEqual(stub.state.orders.get('cmd_sim_015e').status, 'picked_up', 'reported ne retrograde pas');
    assert.strictEqual(stub.state.orders.get('cmd_sim_015e').livoStatusRaw, 'reported');
  });

  /* 15e. `shipping` n'est plus JAMAIS produit */
  await check('aucun statut Livo ne produit plus "shipping"', async () => {
    const mapped = buildHandler({ seedOrders: ORDER_SEED }).sandbox.LIVO_STATUS_TO_ORDER_STATUS;
    const produced = Object.values(mapped);
    assert.ok(!produced.includes('shipping'), 'shipping ne doit plus figurer dans le mapping: ' + produced.join(','));
    assert.ok(!produced.includes('pending'), 'pending ne doit plus etre une cible du webhook');
    assert.ok(produced.includes('in_transit') && produced.includes('pickup_requested') && produced.includes('picked_up'),
      'les statuts du nouveau workflow doivent etre presents: ' + produced.join(','));
  });

  /* ================================================================ */
  /* T2 : restitution stock_warehouse - 6 cas                        */
  /* ================================================================ */

  const PROD_WAREHOUSE = { p_wh: { id: 'p_wh', nameFr: 'Produit entrepot', delivery_mode: 'smartswika_warehouse', stock_warehouse: 10, stock: 50 } };
  const PROD_NORMAL    = { p_norm: { id: 'p_norm', nameFr: 'Produit normal', stock: 50 } };
  const PROD_BOTH      = { ...PROD_WAREHOUSE, ...PROD_NORMAL };

  function returnEvent(trackingId, returnStatus, id) {
    return { id, event: 'order.return_status_changed',
             data: { _id: trackingId, return_status: returnStatus } };
  }

  /* Cas 1 : commande 100 % entrepot, returned-warehouse -> restitution, statut intouche */
  await check('T2-1 : warehouse-deducted=true + returned-warehouse -> +1 stock, statut intouche', async () => {
    const seed = { c1: { id: 'c1', status: 'delivered', livoTracking: 'TRK-C1',
                         stock_warehouse_deducted: true, stockDeducted: false,
                         items: [{ productId: 'p_wh', quantity: 2 }] } };
    const { handler, stub } = buildHandler({ seedOrders: seed, seedProducts: PROD_WAREHOUSE });
    const res = await deliver({ handler, event: returnEvent('TRK-C1', 'returned-warehouse', 'ev-c1'),
                                eventId: 'ev-c1' });
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied, true);
    const order = stub.state.orders.get('c1');
    assert.strictEqual(stub.state.products.get('p_wh').stock_warehouse, 12, 'stock_warehouse 10 -> 12');
    assert.strictEqual(stub.state.products.get('p_wh').stock, 50, 'stock commercial INTOUCHE');
    assert.strictEqual(order.livoReturnStatus, 'returned-warehouse');
    assert.strictEqual(order.status, 'delivered', 'statut principal INTOUCHE par warehouse seul');
    assert.strictEqual(order.stockRestituted, true, 'idempotence scellee');
  });

  /* Cas 2 : warehouse puis fully, 2 event_ids -> UN SEUL increment, status=returned au 2e */
  await check('T2-2 : warehouse PUIS fully (2 event_ids) -> UN SEUL increment', async () => {
    const seed = { c2: { id: 'c2', status: 'delivered', livoTracking: 'TRK-C2',
                         stock_warehouse_deducted: true,
                         items: [{ productId: 'p_wh', quantity: 3 }] } };
    const { handler, stub } = buildHandler({ seedOrders: seed, seedProducts: PROD_WAREHOUSE });

    const first = await deliver({ handler, event: returnEvent('TRK-C2', 'returned-warehouse', 'ev-c2a'),
                                  eventId: 'ev-c2a' });
    assert.strictEqual(first._status, 200);
    assert.strictEqual(stub.state.products.get('p_wh').stock_warehouse, 13, '10 + 3');
    assert.strictEqual(stub.state.orders.get('c2').status, 'delivered', 'encore delivered au 1er');

    const second = await deliver({ handler, event: returnEvent('TRK-C2', 'returned-fully', 'ev-c2b'),
                                   eventId: 'ev-c2b' });
    assert.strictEqual(second._status, 200);
    assert.strictEqual(second._body.duplicate, false, 'event_id different => pas duplicate');
    assert.strictEqual(second._body.applied, true);
    assert.strictEqual(stub.state.products.get('p_wh').stock_warehouse, 13,
      'PAS de second increment (idempotence par commande)');
    assert.strictEqual(stub.state.calls.productUpdates, 1, 'un seul update produit au total');
    const order = stub.state.orders.get('c2');
    assert.strictEqual(order.status, 'returned', 'le 2e evenement pose le statut returned');
    assert.strictEqual(order.livoReturnStatus, 'returned-fully', 'livoReturnStatus mis a jour');
    assert.strictEqual(order.stockRestituted, true);
  });

  /* Cas 3 : returned-fully seul, flags=true -> restitution + status=returned */
  await check('T2-3 : returned-fully seul, flags=true -> restitution + status=returned', async () => {
    const seed = { c3: { id: 'c3', status: 'delivered', livoTracking: 'TRK-C3',
                         stockDeducted: true,
                         items: [{ productId: 'p_wh', quantity: 4 }] } };
    const { handler, stub } = buildHandler({ seedOrders: seed, seedProducts: PROD_WAREHOUSE });
    const res = await deliver({ handler, event: returnEvent('TRK-C3', 'returned-fully', 'ev-c3'),
                                eventId: 'ev-c3' });
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied, true);
    assert.strictEqual(stub.state.products.get('p_wh').stock_warehouse, 14, '10 + 4');
    const order = stub.state.orders.get('c3');
    assert.strictEqual(order.status, 'returned');
    assert.strictEqual(order.livoReturnStatus, 'returned-fully');
  });

  /* Cas 4 : returned-fully seul, flags ABSENTS -> aucune restitution, status=returned */
  await check('T2-4 : returned-fully seul, flags absents -> ZERO increment, status=returned', async () => {
    const seed = { c4: { id: 'c4', status: 'shipping', livoTracking: 'TRK-C4',
                         items: [{ productId: 'p_wh', quantity: 5 }] } };
    const { handler, stub } = buildHandler({ seedOrders: seed, seedProducts: PROD_WAREHOUSE });
    const res = await deliver({ handler, event: returnEvent('TRK-C4', 'returned-fully', 'ev-c4'),
                                eventId: 'ev-c4' });
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied, true, 'le retour est traite meme sans restitution');
    assert.strictEqual(stub.state.products.get('p_wh').stock_warehouse, 10, 'AUCUN increment');
    assert.strictEqual(stub.state.calls.productUpdates, 0, 'aucun update produit');
    const order = stub.state.orders.get('c4');
    assert.strictEqual(order.status, 'returned', 'transition metier independante du stock');
    assert.strictEqual(order.livoReturnStatus, 'returned-fully');
    // Semantique validee : stockRestituted = "evenement traite", PAS "stock incremente".
    assert.strictEqual(order.stockRestituted, true, 'idempotence scellee meme sans restitution');
  });

  /* Cas 5 : commande mixte -> seul le produit warehouse est restitue */
  await check('T2-5 : commande mixte -> seul le produit smartswika_warehouse est restitue', async () => {
    const seed = { c5: { id: 'c5', status: 'delivered', livoTracking: 'TRK-C5',
                         stockDeducted: true,
                         items: [{ productId: 'p_wh', quantity: 2 },
                                 { productId: 'p_norm', quantity: 7 }] } };
    const { handler, stub } = buildHandler({ seedOrders: seed, seedProducts: PROD_BOTH });
    const res = await deliver({ handler, event: returnEvent('TRK-C5', 'returned-warehouse', 'ev-c5'),
                                eventId: 'ev-c5' });
    assert.strictEqual(res._status, 200);
    assert.strictEqual(stub.state.products.get('p_wh').stock_warehouse, 12, 'warehouse 10 -> 12');
    assert.strictEqual(stub.state.products.get('p_norm').stock, 50, 'produit normal INTOUCHE (stock)');
    assert.strictEqual(stub.state.products.get('p_norm').stock_warehouse, undefined,
      'produit normal : aucun champ stock_warehouse cree');
    assert.strictEqual(stub.state.products.get('p_wh').stock, 50, 'stock commercial du produit wh INTOUCHE');
    assert.strictEqual(stub.state.calls.productUpdates, 1, 'un seul produit mis a jour');
  });

  /* Cas 6 : returned-pending / returned-started -> livoReturnStatus seul */
  await check('T2-6 : returned-pending puis returned-started -> aucun increment, statut intouche', async () => {
    const seed = { c6: { id: 'c6', status: 'in_transit', livoTracking: 'TRK-C6',
                         stock_warehouse_deducted: true,
                         items: [{ productId: 'p_wh', quantity: 2 }] } };
    const { handler, stub } = buildHandler({ seedOrders: seed, seedProducts: PROD_WAREHOUSE });

    for (const [status, evId] of [['returned-pending', 'ev-c6a'], ['returned-started', 'ev-c6b']]) {
      const res = await deliver({ handler, event: returnEvent('TRK-C6', status, evId), eventId: evId });
      assert.strictEqual(res._status, 200, status);
      assert.strictEqual(res._body.applied, true, status);
      assert.strictEqual(stub.state.orders.get('c6').livoReturnStatus, status);
      assert.strictEqual(stub.state.orders.get('c6').status, 'in_transit', 'statut intouche (' + status + ')');
    }
    assert.strictEqual(stub.state.products.get('p_wh').stock_warehouse, 10, 'aucun increment');
    assert.strictEqual(stub.state.calls.productUpdates, 0, 'aucun update produit');
  });

  /* 16. fulfilled sans ancre : le webhook applique `delivered` mais ne pose PAS
        l'ancre (statut terminal, hors TRACKING_START_STATUSES). C'est
        onOrderStatusChanged qui fournit le fallback createdAt (test 17). */
  await check('fulfilled sans trackingStartedAt -> delivered applique, ancre non posee par le webhook', async () => {
    const seed = { cmd_sim_016: { id: 'cmd_sim_016', status: 'shipping', livoTracking: 'LIVO-TRK-0016' } };
    const { handler, stub } = buildHandler({ seedOrders: seed });
    const evt = { id: 'evt_sim_16', event: 'order.status_changed', created_at: '2026-11-12T20:00:00Z', data: { _id: 'LIVO-TRK-0016', status: 'fulfilled' } };
    const res = await deliver({ handler, event: evt, eventId: 'evt_sim_16' });
    assert.strictEqual(res._status, 200, 'status ' + res._status);
    assert.strictEqual(res._body.applied, true, 'delivered doit etre applique');
    const order = stub.state.orders.get('cmd_sim_016');
    assert.strictEqual(order.status, 'delivered');
    assert.strictEqual(order.trackingStartedAt, undefined, 'le webhook ne pose pas l ancre sur fulfilled');
  });

  /* 17. Fallback createdAt : resolveCreditUnlockBase (code REEL extrait de
        functions/index.js) ancre sur createdAt quand trackingStartedAt est
        absent, puis sur updatedAt, et echoue proprement sans aucune date. */
  await check('resolveCreditUnlockBase : fallback createdAt puis updatedAt si trackingStartedAt absent', async () => {
    const start = src.indexOf('function resolveCreditUnlockBase(order) {');
    assert.ok(start >= 0, 'resolveCreditUnlockBase introuvable dans index.js');

    let depth = 0, i = start, quote = null, escaped = false;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    const fnSrc = src.slice(start, i + 1);

    const sandbox2 = {
      console: { log() {}, warn() {}, error() {} },
      OFFICIAL_VENDOR_CONFIG: { UNLOCK_DAYS_SMART: 15, UNLOCK_DAYS_VENDOR: 7 }
    };
    vm.createContext(sandbox2);
    vm.runInContext(fnSrc + '; __fn = resolveCreditUnlockBase;', sandbox2);
    const resolve = sandbox2.__fn;
    assert.strictEqual(typeof resolve, 'function', 'extraction impossible');

    const createdAt = new Date('2026-01-10T08:00:00Z');
    const updatedAt = new Date('2026-01-12T09:30:00Z');

    // Cas A : ancre normale prioritaire.
    const a = resolve({ trackingStartedAt: new Date('2026-01-20T00:00:00Z'), items: [] });
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.date.toISOString(), '2026-01-20T00:00:00.000Z');
    assert.strictEqual(a.unlockDays, 7);

    // Cas B : fallback createdAt.
    const b = resolve({ createdAt, updatedAt, items: [] });
    assert.strictEqual(b.ok, true, 'fallback doit reussir: ' + JSON.stringify(b));
    assert.strictEqual(b.date.toISOString(), createdAt.toISOString());
    assert.strictEqual(b.unlockDays, 7);

    // Cas C : fallback updatedAt quand createdAt absent.
    const c = resolve({ updatedAt, items: [] });
    assert.strictEqual(c.ok, true, 'fallback updatedAt: ' + JSON.stringify(c));
    assert.strictEqual(c.date.toISOString(), updatedAt.toISOString());

    // Cas D : aucune date -> echec explicite.
    const d = resolve({ items: [] });
    assert.strictEqual(d.ok, false);
    assert.ok(/createdAt\/updatedAt/.test(d.reason), 'raison explicite attendue: ' + d.reason);

    // Cas E : produit Smart Swika -> 15 jours meme via le fallback.
    const e = resolve({ createdAt, items: [{ isSmartSwika: true }] });
    assert.strictEqual(e.ok, true);
    assert.strictEqual(e.unlockDays, 15);
    assert.strictEqual(e.scope, 'smart');
  });

  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' verifications PASS');
  if (failed.length) {
    console.log('ECHECS: ' + failed.map(f => f.name).join(' | '));
    process.exit(1);
  }
})();
