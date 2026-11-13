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

function createStubDb(seedOrders) {
  const state = {
    events: new Map(),   // collection livo_webhook_events : id -> data
    orders: new Map(),   // collection orders : id -> data
    calls: { where: 0, transaction: 0, updates: 0, creates: 0 }
  };
  for (const [id, data] of Object.entries(seedOrders || {})) state.orders.set(id, { ...data });

  const makeRef = (kind, id) => ({
    id,
    __kind: kind,
    get: async () => makeSnapshot(kind, id)
  });

  const makeSnapshot = (kind, id) => {
    const store = kind === 'events' ? state.events : state.orders;
    const exists = store.has(id);
    const data = store.get(id);
    return { exists, id, data: () => (exists ? { ...data } : undefined), ref: makeRef(kind, id) };
  };

  const db = {
    collection(name) {
      const kind = name === COLLECTION ? 'events' : 'orders';
      assert.ok(kind === 'events' || name === 'orders', 'collection inattendue: ' + name);
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
          return ref.__kind === 'events' ? makeSnapshot('events', ref.id) : makeSnapshot('orders', ref.id);
        },
        create(ref, data) {
          assert.strictEqual(ref.__kind, 'events');
          assert.ok(!state.events.has(ref.id), 'create sur un evenement existant');
          state.events.set(ref.id, { ...data });
          state.calls.creates++;
        },
        update(ref, data) {
          assert.strictEqual(ref.__kind, 'orders');
          assert.ok(state.orders.has(ref.id), 'update sur une commande inexistante');
          state.orders.set(ref.id, { ...state.orders.get(ref.id), ...data });
          state.calls.updates++;
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

function buildHandler({ secret = SECRET, nowSeconds = Math.floor(Date.now() / 1000), seedOrders } = {}) {
  const stub = createStubDb(seedOrders);
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
    LIVO_STATUS_TO_ORDER_STATUS: {
      draft: 'pending', pending: 'pending', 'in progress': 'shipping', fulfilled: 'delivered',
      problem: 'shipping', cancelled: 'cancelled', 'awaiting transfer': 'shipping',
      'awaiting pickup': 'confirmed', reported: 'shipping', programmed: 'confirmed'
    },
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
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
  await check('order.status_changed "in progress" -> 200 applied et commande en shipping', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const res = await deliver({ handler, event: statusEvent('in progress'), eventId: 'evt_sim_3' });
    assert.strictEqual(res._status, 200, 'status ' + res._status + ' ' + JSON.stringify(res._body));
    assert.strictEqual(res._body.success, true);
    assert.strictEqual(res._body.applied, true, 'applied attendu true');
    assert.strictEqual(res._body.duplicate, false);
    const order = stub.state.orders.get('cmd_sim_001');
    assert.strictEqual(order.status, 'shipping', 'statut commande: ' + order.status);
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
  await check('commande deja delivered : nouvel evenement ignore et commande intacte', async () => {
    const seed = { cmd_sim_005: { id: 'cmd_sim_005', status: 'delivered', livoTracking: 'LIVO-TRK-0005' } };
    const { handler, stub } = buildHandler({ seedOrders: seed });
    const evt = { id: 'evt_sim_5', event: 'order.status_changed', data: { _id: 'LIVO-TRK-0005', status: 'in progress' } };
    const res = await deliver({ handler, event: evt, eventId: 'evt_sim_5' });
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied, false, 'applied doit etre false');
    assert.strictEqual(stub.state.orders.get('cmd_sim_005').status, 'delivered', 'statut terminal preserve');
    assert.strictEqual(stub.state.events.get('evt_sim_5').processing, 'ignored');
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

  /* 14. pending : le chrono demarre des le premier statut de tracking Livo */
  await check('order.status_changed "pending" -> trackingStartedAt pose (ancre chrono)', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const res = await deliver({ handler, event: statusEvent('pending'), eventId: 'evt_sim_14' });
    assert.strictEqual(res._status, 200, 'status ' + res._status);
    assert.strictEqual(res._body.applied, true, 'applied attendu true');
    const order = stub.state.orders.get('cmd_sim_001');
    assert.strictEqual(order.status, 'pending', 'statut commande: ' + order.status);
    assert.strictEqual(order.livoStatusRaw, 'pending');
    assert.ok(order.trackingStartedAt, 'trackingStartedAt doit etre pose');
    assert.deepStrictEqual(order.trackingStartedAt, { __serverTimestamp: true });
    assert.strictEqual(order.trackingStartedFrom, 'livo_webhook_pending');
  });

  /* 15. pending puis in progress : l'ancre ne doit jamais etre repoussee */
  await check('pending puis "in progress" -> trackingStartedAt non ecrase ni repousse', async () => {
    const { handler, stub } = buildHandler({ seedOrders: ORDER_SEED });
    const first = await deliver({ handler, event: statusEvent('pending'), eventId: 'evt_sim_15a' });
    assert.strictEqual(first._status, 200);
    const anchorAfterFirst = stub.state.orders.get('cmd_sim_001').trackingStartedAt;
    assert.ok(anchorAfterFirst, 'ancre posee sur pending');
    const fromAfterFirst = stub.state.orders.get('cmd_sim_001').trackingStartedFrom;

    const second = await deliver({ handler, event: statusEvent('in progress'), eventId: 'evt_sim_15b' });
    assert.strictEqual(second._status, 200);
    const order = stub.state.orders.get('cmd_sim_001');
    assert.strictEqual(order.status, 'shipping', 'statut commande: ' + order.status);
    assert.deepStrictEqual(order.trackingStartedAt, anchorAfterFirst, 'ancre inchangee');
    assert.strictEqual(order.trackingStartedFrom, fromAfterFirst, 'origine inchangee');
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
