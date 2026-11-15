#!/usr/bin/env node
/*
 * tests/grouped-pickup.test.cjs
 *
 * Scenarios T1 a T9 du predicat d'eligibilite au ramassage groupe (PR 8.4).
 *
 * Aucun appel reseau, aucun Firestore : js/grouped-pickup.js est charge dans
 * un contexte `vm` (module ES, sans DOM) et evaluateGroupedPickupOrder() est
 * appele avec un contexte fabrique a la main (Map vendors / Map products),
 * exactement comme le font js/admin.js, js/orders.js et le backfill.
 *
 * Le module est donc teste TEL QUEL : pas de copie de la regle dans le test.
 *
 * Lancement : node tests/grouped-pickup.test.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const MODULE_PATH = path.join(__dirname, '..', 'js', 'grouped-pickup.js');

/* ------------------------------------------------------------------ */
/* Chargement du module reel via vm                                   */
/* ------------------------------------------------------------------ */

function loadModule() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  // Les imports Firebase servent au contexte de lot (createGroupedPickupContext),
  // inutilise ici : on les retire et on fournit des stubs.
  let code = source
    .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"]\s*;?/gm, '')
    .replace(/\bexport\s+default\s+/g, 'module.exports.default = ')
    .replace(/\bexport\s+(async\s+function|function|const|let|var|class)/g, '$1');

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    module: { exports: {} },
    exports: {},
    Map, Set, Date, Math, JSON, String, Number, Array, Object, Boolean, Promise,
    setTimeout, clearTimeout,
    // Stubs : le predicat ne fait aucun I/O.
    getDoc: async () => null,
    doc: () => ({ id: 'stub' }),
    db: null,
    document: undefined,
    window: undefined
  };

  const expose = [
    'evaluateGroupedPickupOrder',
    'filterGroupedPickupCandidates',
    'countGroupedPickupArticles',
    'getOrderVendorIds',
    'getOrderProductIds',
    'getOrderLines',
    'INCOMPATIBLE_PAYMENT_STATUSES',
    'PICKUP_REJECT',
    'renderGroupedPickupCandidateList'
  ];
  code += '\n;this.__api = {' + expose.map(n =>
    n + ': typeof ' + n + ' !== "undefined" ? ' + n + ' : null'
  ).join(',\n') + '};\n';

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: MODULE_PATH });

  const api = sandbox.__api;
  assert.ok(api, 'sandbox.__api absent');
  assert.strictEqual(typeof api.evaluateGroupedPickupOrder, 'function',
    'evaluateGroupedPickupOrder introuvable dans ' + MODULE_PATH);
  return api;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const VENDOR_ASMAA = 'v_asaa';       // drop-off
const VENDOR_TECHCO = 'v_techco';    // fulfillment
const VENDOR_SUSPENDED = 'v_susp';   // fulfillment mais suspendu
const VENDOR_OTHER = 'v_other';      // fulfillment

const P_WAREHOUSE_A = 'p_wh_a';
const P_WAREHOUSE_B = 'p_wh_b';
const P_DROPOFF = 'p_drop';

/**
 * Fabrique un contexte { vendors, products } au format attendu par le
 * predicat (identique a celui du module et du backfill).
 */
function makeCtx({ vendors = {}, products = {} } = {}) {
  const vendorMap = new Map();
  for (const [id, info] of Object.entries(vendors)) {
    vendorMap.set(id, {
      exists: info !== null,
      vendorInfo: info || {}
    });
  }
  const productMap = new Map();
  for (const [id, mode] of Object.entries(products)) {
    productMap.set(id, {
      exists: mode !== null,
      delivery_mode: mode === null ? null : mode
    });
  }
  return { vendors: vendorMap, products: productMap };
}

/** Contexte nominal : Tech & co fulfillment, tous produits entrepot. */
function nominalCtx(overrides = {}) {
  return makeCtx({
    vendors: {
      [VENDOR_TECHCO]: { status: 'approved', shippingMethod: 'fulfillment' },
      [VENDOR_ASMAA]: { status: 'approved', shippingMethod: 'dropoff' },
      [VENDOR_SUSPENDED]: { status: 'suspended', shippingMethod: 'fulfillment' },
      [VENDOR_OTHER]: { status: 'approved', shippingMethod: 'fulfillment' },
      ...(overrides.vendors || {})
    },
    products: {
      [P_WAREHOUSE_A]: 'smartswika_warehouse',
      [P_WAREHOUSE_B]: 'smartswika_warehouse',
      [P_DROPOFF]: 'dropoff',
      ...(overrides.products || {})
    }
  });
}

/** Commande confirmed 100 % entrepot d'un seul vendeur fulfillment. */
function warehouseOrder(overrides = {}) {
  // Le predicat lit le vendeur SUR LA LIGNE d'article (line.vendorId), comme les
  // commandes reelles de functions/index.js. order.vendorIds n'est pas lu.
  return {
    id: 'cmd_wh_1',
    status: 'confirmed',
    items: [{ productId: P_WAREHOUSE_A, quantity: 2, vendorId: VENDOR_TECHCO }],
    paymentStatus: 'unpaid',   // Smart Swika est COD : c'est le cas nominal
    ...overrides
  };
}

/* ------------------------------------------------------------------ */
/* Runner minimal                                                      */
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
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

(async () => {
  const api = loadModule();
  const { evaluateGroupedPickupOrder, PICKUP_REJECT } = api;
  const evaluate = (order, ctx) => evaluateGroupedPickupOrder(order, ctx || nominalCtx());

  /* T1 ------------------------------------------------------------- */
  await check('T1 : Asmaa Toys (drop-off) confirmed -> 0 candidate', async () => {
    const order = warehouseOrder({
      id: 'cmd_t1',
      items: [{ productId: P_DROPOFF, quantity: 1, vendorId: VENDOR_ASMAA }]
    });
    const eval1 = evaluate(order);
    assert.strictEqual(eval1.eligible, false, 'une commande drop-off ne doit pas etre eligible');
    // Les motifs portent un suffixe `:<id>` : on teste le prefixe.
    assert.ok(eval1.reasons.some(r => r.startsWith(PICKUP_REJECT.VENDOR_NOT_FULFILLMENT)),
      'motif vendor_not_fulfillment attendu: ' + eval1.reasons.join(','));
    assert.ok(eval1.reasons.some(r => r.startsWith(PICKUP_REJECT.PRODUCT_NOT_WAREHOUSE)),
      'motif product_not_warehouse attendu: ' + eval1.reasons.join(','));
  });

  /* T2 ------------------------------------------------------------- */
  await check('T2 : Tech & co fulfillment 100 % entrepot payee -> 1 candidate', async () => {
    const order = warehouseOrder({ id: 'cmd_t2', paymentStatus: 'paid' });
    const eval2 = evaluate(order);
    assert.strictEqual(eval2.eligible, true, 'eligible attendu true, motifs: ' + eval2.reasons.join(','));
    // Tableau issu du sandbox vm : deepStrictEqual echouerait sur le prototype.
    assert.strictEqual(eval2.reasons.length, 0,
      'aucun motif de rejet: ' + eval2.reasons.join(','));
    assert.strictEqual(eval2.articles, 2, 'articles comptes');
  });

  /* T3 ------------------------------------------------------------- */
  await check('T3 : Tech & co fulfillment avec 1 item drop-off -> 0 candidate', async () => {
    const order = warehouseOrder({
      id: 'cmd_t3',
      items: [
        { productId: P_WAREHOUSE_A, quantity: 1, vendorId: VENDOR_TECHCO },
        { productId: P_DROPOFF, quantity: 1, vendorId: VENDOR_TECHCO }
      ]
    });
    const eval3 = evaluate(order);
    assert.strictEqual(eval3.eligible, false, 'un seul item drop-off suffit a exclure');
    assert.ok(eval3.reasons.some(r => r.startsWith(PICKUP_REJECT.PRODUCT_NOT_WAREHOUSE)),
      'motif product_not_warehouse attendu: ' + eval3.reasons.join(','));
  });

  /* T4 ------------------------------------------------------------- */
  await check('T4 : vendeur suspendu -> 0 candidate', async () => {
    const order = warehouseOrder({
      id: 'cmd_t4',
      items: [{ productId: P_WAREHOUSE_A, quantity: 2, vendorId: VENDOR_SUSPENDED }]
    });
    const eval4 = evaluate(order);
    assert.strictEqual(eval4.eligible, false, 'un vendeur suspendu exclut la commande');
    assert.ok(eval4.reasons.some(r => r.startsWith(PICKUP_REJECT.VENDOR_NOT_APPROVED)),
      'motif vendor_not_approved attendu: ' + eval4.reasons.join(','));
  });

  /* T5 ------------------------------------------------------------- */
  await check('T5 : 2 vendeurs fulfillment approuves, tous warehouse -> 0 candidate', async () => {
    const order = warehouseOrder({
      id: 'cmd_t5',
      items: [
        { productId: P_WAREHOUSE_A, quantity: 1, vendorId: VENDOR_TECHCO },
        { productId: P_WAREHOUSE_B, quantity: 1, vendorId: VENDOR_OTHER }
      ]
    });
    const eval5 = evaluate(order);
    assert.strictEqual(eval5.eligible, false, 'panier multi-vendeurs exclu');
    assert.ok(eval5.reasons.includes(PICKUP_REJECT.MULTI_VENDOR),
      'motif multi_vendor attendu: ' + eval5.reasons.join(','));
  });

  /* T6 : COD nominal ------------------------------------------------ */
  await check('T6 : paymentStatus unpaid (COD nominal) -> 1 candidate', async () => {
    const order = warehouseOrder({ id: 'cmd_t6', paymentStatus: 'unpaid' });
    const eval6 = evaluate(order);
    assert.strictEqual(eval6.eligible, true,
      'unpaid DOIT etre ramassable (Smart Swika = COD), motifs: ' + eval6.reasons.join(','));
  });

  /* T6bis ----------------------------------------------------------- */
  await check('T6bis : paymentStatus refunded -> 0 candidate', async () => {
    const order = warehouseOrder({ id: 'cmd_t6bis', paymentStatus: 'refunded' });
    const evalb = evaluate(order);
    assert.strictEqual(evalb.eligible, false, 'refunded doit etre rejete');
    assert.ok(evalb.reasons.some(r => r.startsWith(PICKUP_REJECT.PAYMENT_INCOMPATIBLE)),
      'motif payment_incompatible attendu: ' + evalb.reasons.join(','));
  });

  /* T6ter ----------------------------------------------------------- */
  await check('T6ter : paymentStatus paid -> 1 candidate (RAMASSABLE)', async () => {
    const order = warehouseOrder({ id: 'cmd_t6ter', paymentStatus: 'paid' });
    const evalt = evaluate(order);
    assert.strictEqual(evalt.eligible, true,
      'paid reste ramassable (paiement encaisse), motifs: ' + evalt.reasons.join(','));
  });

  /* T7 ------------------------------------------------------------- */
  await check('T7 : commande entrepot avec livoPickupId deja pose -> 0 candidate', async () => {
    const order = warehouseOrder({ id: 'cmd_t7', livoPickupId: 'pickup_abc123' });
    const eval7 = evaluate(order);
    assert.strictEqual(eval7.eligible, false, 'une commande deja rattachee est exclue');
    assert.ok(eval7.reasons.includes(PICKUP_REJECT.ALREADY_PICKED_UP),
      'motif already_pickup_requested attendu: ' + eval7.reasons.join(','));
  });

  /* T8 ------------------------------------------------------------- */
  await check('T8 : lecture vendeur en erreur -> 0 candidate (fail-closed)', async () => {
    const order = warehouseOrder({
      id: 'cmd_t8',
      items: [{ productId: P_WAREHOUSE_A, quantity: 2, vendorId: VENDOR_TECHCO }]
    });
    // Contexte ou le vendeur est enregistre comme illisible.
    const ctx = nominalCtx();
    ctx.vendors.set(VENDOR_TECHCO, { exists: false, unreadable: true });
    const eval8 = evaluateGroupedPickupOrder(order, ctx);
    assert.strictEqual(eval8.eligible, false, 'une lecture en echec doit rejeter (fail-closed)');
    assert.ok(eval8.reasons.some(r => r.startsWith(PICKUP_REJECT.VENDOR_UNREADABLE)),
      'motif vendor_unreadable attendu: ' + eval8.reasons.join(','));
  });

  /* T8bis : lecture produit en erreur ------------------------------- */
  await check('T8bis : lecture produit en erreur -> 0 candidate (fail-closed)', async () => {
    const order = warehouseOrder({ id: 'cmd_t8bis' });
    const ctx = nominalCtx();
    ctx.products.delete(P_WAREHOUSE_A); // produit absent du contexte = illisible
    const eval8b = evaluateGroupedPickupOrder(order, ctx);
    assert.strictEqual(eval8b.eligible, false, 'produit non lu => rejet');
    assert.ok(eval8b.reasons.some(r => r.startsWith(PICKUP_REJECT.PRODUCT_UNREADABLE)),
      'motif product_unreadable attendu: ' + eval8b.reasons.join(','));
  });

  /* T9 ------------------------------------------------------------- */
  await check('T9 : compteur totalArticles == somme des articles des candidates', async () => {
    const ctx = nominalCtx();
    const orders = [
      // eligible : 2 + 3 = 5 articles
      warehouseOrder({
        id: 'cmd_t9_a',
        items: [
          { productId: P_WAREHOUSE_A, quantity: 2, vendorId: VENDOR_TECHCO },
          { productId: P_WAREHOUSE_B, quantity: 3, vendorId: VENDOR_TECHCO }
        ]
      }),
      // eligible : 1 article
      warehouseOrder({ id: 'cmd_t9_b', items: [{ productId: P_WAREHOUSE_A, quantity: 1, vendorId: VENDOR_TECHCO }] }),
      // exclue : drop-off
      warehouseOrder({
        id: 'cmd_t9_c',
        items: [{ productId: P_DROPOFF, quantity: 4, vendorId: VENDOR_ASMAA }]
      }),
      // exclue : multi-vendeurs
      warehouseOrder({
        id: 'cmd_t9_d',
        items: [
          { productId: P_WAREHOUSE_A, quantity: 7, vendorId: VENDOR_TECHCO },
          { productId: P_WAREHOUSE_B, quantity: 7, vendorId: VENDOR_OTHER }
        ]
      }),
      // exclue : deja ramassee
      warehouseOrder({ id: 'cmd_t9_e', livoPickupId: 'pickup_x', items: [{ productId: P_WAREHOUSE_A, quantity: 9, vendorId: VENDOR_TECHCO }] })
    ];

    const entries = orders
      .map(order => ({ order, evaluation: evaluateGroupedPickupOrder(order, ctx) }))
      .filter(entry => entry.evaluation.eligible);

    const totalArticles = entries.reduce((sum, e) => sum + e.evaluation.articles, 0);
    const expected = orders
      .map(order => ({ order, evaluation: evaluateGroupedPickupOrder(order, ctx) }))
      .filter(entry => entry.evaluation.eligible)
      .reduce((sum, e) => sum + api.countGroupedPickupArticles(e.order), 0);

    assert.strictEqual(entries.length, 2, 'deux candidates attendues, recu ' + entries.length);
    assert.strictEqual(totalArticles, 6, 'articles attendus 5 + 1 = 6, recu ' + totalArticles);
    assert.strictEqual(totalArticles, expected,
      'le compteur doit egaler la somme countGroupedPickupArticles des candidates');
    // Les exclues ne contribuent pas.
    assert.ok(!entries.some(e => e.order.id === 'cmd_t9_c'), 'drop-off exclue');
    assert.ok(!entries.some(e => e.order.id === 'cmd_t9_d'), 'multi-vendeurs exclue');
    assert.ok(!entries.some(e => e.order.id === 'cmd_t9_e'), 'deja ramassee exclue');
  });

  /* ------------------------------------------------------------------ */
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' verifications PASS');
  if (failed.length) {
    console.log('ECHECS: ' + failed.map(f => f.name).join(' | '));
    process.exit(1);
  }
})();
