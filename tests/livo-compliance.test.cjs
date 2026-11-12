/**
 * Tests de conformite API Entrepot Livo (docs/api/livo-entrepot.json).
 *
 * Couvre les correctifs de la branche fix/livo-compliance :
 *   1. Retry-After propage par le Worker et 429 redevenu retentable cote client.
 *   2. Erreurs de type "prompt" (duplicate_target) : de-imbrication de
 *      l'enveloppe, remontee du confirm_text et renvoi de la requete.
 *   3. Bornes products/quantity alignees sur la spec (99 / 99, cost >= 0).
 *   4. desired_date normalise en JJ/MM/AAAA et refuse si dans le passe.
 *   5. Constante ORDER_RECEIVE supprimee (hors perimetre vendeur).
 */
const fs = require("node:fs");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(file, "utf8");

const worker = read("cloudflare/workers/livo-proxy.js");
const orders = read("js/orders.js");
const utils = read("js/utils.js");
const config = read("js/config.js");
const functions = read("functions/index.js");

/* ------------------------------------------------------------------ */
/* 1. Retry-After                                                      */
/* ------------------------------------------------------------------ */
assert.match(worker, /Access-Control-Expose-Headers"?\s*:\s*"Retry-After"/,
  "Le Worker doit exposer Retry-After au navigateur.");
assert.match(worker, /response\.headers\.get\("Retry-After"\)/,
  "Le Worker doit lire le Retry-After amont.");
assert.match(worker, /if \(retryAfter\) passthrough\["Retry-After"\] = retryAfter;/,
  "Le Worker doit reinjecter Retry-After dans la reponse sortante.");
assert.match(utils, /const RETRYABLE_4XX = new Set\(\[408, 429\]\)/,
  "429 doit etre considere retentable cote client.");
assert.match(utils, /!RETRYABLE_4XX\.has\(response\.status\)/,
  "La liste des 4xx non retentables doit exclure 429.");
assert.match(utils, /export function getRetryAfterMs\(response\)/,
  "getRetryAfterMs doit exister pour lire l'en-tete Retry-After.");
assert.match(utils, /getRetryAfterMs\(response\) \?\? backoff/,
  "Le delai serveur doit primer sur le backoff exponentiel.");

assert.match(utils, /export async function fetchWithRetryResponse\(/,
  "fetchWithRetryResponse doit exister : les appels Livo doivent lire l'enveloppe d'erreur.");

assert.match(utils, /function isRetryableStatus\(status\)/,
  "isRetryableStatus doit centraliser la politique de retry (408/429/5xx).");

/* ------------------------------------------------------------------ */
/* 2. Erreurs "prompt" / confirm_text                                  */
/* ------------------------------------------------------------------ */
assert.match(orders, /function extractLivoError\(body, status\)/,
  "orders.js doit de-imbriquer l'enveloppe d'erreur Livo.");
assert.match(orders, /const payload = body\?\.data\?\.data \|\| body\?\.data \|\| body \|\| \{\};/,
  "extractLivoError doit gerer les deux niveaux d'enveloppe.");
assert.match(orders, /needsConfirmation: type === 'prompt'/,
  "Une erreur type 'prompt' doit etre signalee comme confirmable.");
assert.match(orders, /payload\.details\.confirm_text/,
  "confirm_text doit etre lu dans details, conformement a ErrorEnvelope.");
assert.match(orders, /payload\.confirm_text = options\.confirmText\.trim\(\)\.slice\(0, 200\);/,
  "sendToLivoAPI doit reinjecter confirm_text lors d'une relance.");
assert.match(orders, /livoResult\.needsConfirmation && livoResult\.confirmText/,
  "L'appelant doit declencher la confirmation avant de considerer l'echec.");
assert.match(worker, /const confirmText = typeof payload\?\.confirm_text === "string"/,
  "Le Worker ne doit plus supprimer confirm_text du payload.");
assert.match(worker, /\.\.\.\(confirmText \? \{ confirm_text: confirmText \} : \{\}\),/,
  "Le Worker doit transmettre confirm_text a Livo.");

/* ------------------------------------------------------------------ */
/* 3. Bornes products / quantity / cost                                */
/* ------------------------------------------------------------------ */
assert.match(worker, /cost < 0 \|\| cost > 1000000/,
  "cost = 0 est autorise par la spec (minimum: 0).");
assert.match(worker, /products\.length > 99/,
  "products est borne a 99 items dans la spec.");
assert.match(worker, /Number\(item\.quantity\) > 99/,
  "quantity est borne a 99 dans la spec.");
assert.doesNotMatch(worker, /products\.length > 50/,
  "L'ancienne borne de 50 doit avoir disparu.");
assert.doesNotMatch(worker, /Number\(item\.quantity\) > 100/,
  "L'ancien off-by-one sur quantity (100) doit avoir disparu.");

/* ------------------------------------------------------------------ */
/* 4. desired_date - tests fonctionnels sur le vrai code du Worker     */
/* ------------------------------------------------------------------ */
const start = worker.indexOf("const LIVO_DATE_PATTERN");
const stop = worker.indexOf("async function callLivo");
assert.ok(start > -1 && stop > start, "Le bloc de helpers de date doit etre localisable.");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  worker.slice(start, stop) +
    "\nthis.normalizeLivoDate = normalizeLivoDate;" +
    "\nthis.isLivoDateInPast = isLivoDateInPast;" +
    "\nthis.formatLivoDate = formatLivoDate;",
  sandbox
);

const normalizeLivoDate = sandbox.normalizeLivoDate;
const isLivoDateInPast = sandbox.isLivoDateInPast;
const formatLivoDate = sandbox.formatLivoDate;

assert.equal(normalizeLivoDate("10/06/2026"), "10/06/2026", "Format JJ/MM/AAAA conserve.");
assert.equal(normalizeLivoDate("2026-06-10"), "10/06/2026", "ISO converti en JJ/MM/AAAA.");
assert.equal(normalizeLivoDate("2026-06-10T00:00:00Z"), "10/06/2026", "ISO datetime converti.");
assert.equal(formatLivoDate(new Date(2026, 5, 10)), "10/06/2026", "formatLivoDate padde JJ/MM.");
assert.equal(normalizeLivoDate(new Date(2026, 5, 10)), "10/06/2026", "Date acceptee.");
assert.equal(normalizeLivoDate("10-06-2026"), null, "Format a tirets rejete.");
assert.equal(normalizeLivoDate("2026/06/10"), null, "Format annees d'abord rejete.");
assert.equal(normalizeLivoDate("31/02/2026"), null, "31/02 rejete (round-trip).");
assert.equal(normalizeLivoDate("10/13/2026"), null, "Mois 13 rejete.");
assert.equal(normalizeLivoDate(""), null, "Chaine vide rejetee.");
assert.equal(normalizeLivoDate(12345), null, "Type non supporte rejete.");

const today = new Date();
const tomorrow = new Date(today.getTime() + 86400000);
assert.equal(isLivoDateInPast(formatLivoDate(today)), false, "Aujourd'hui n'est pas dans le passe.");
assert.equal(isLivoDateInPast(formatLivoDate(tomorrow)), false, "Demain n'est pas dans le passe.");
assert.equal(isLivoDateInPast("01/01/2000"), true, "2000 est dans le passe.");

assert.match(worker, /if \(isLivoDateInPast\(desiredDate\)\)/,
  "Le Worker doit refuser une desired_date passee.");
assert.match(worker, /\.\.\.\(desiredDate \? \{ desired_date: desiredDate \} : \{\}\),/,
  "Le Worker doit envoyer la date normalisee, pas la valeur brute.");

/* ------------------------------------------------------------------ */
/* 5. ORDER_RECEIVE hors perimetre                                     */
/* ------------------------------------------------------------------ */
assert.doesNotMatch(config, /ORDER_RECEIVE/,
  "La constante ORDER_RECEIVE doit etre supprimee (vendeur, pas operateur d'entrepot).");
assert.doesNotMatch(config, /\/orders\/receive/,
  "Aucune reference a /orders/receive ne doit subsister dans la config.");

/* ------------------------------------------------------------------ */
/* Bonus : controle Bearer du webhook rendu tolerant                   */
/* ------------------------------------------------------------------ */
/* Le Bearer du webhook est desormais EXIGE (spec complete, section
   "Webhooks > Securiser votre endpoint"). Le detail des cas est couvert
   par le bloc 7 ci-dessous. */
assert.match(functions, /if \(!timingSafeTextEqual\(authorization, expectedAuthorization\)\) \{/,
  "Le Bearer du webhook doit etre exige (comparaison a temps constant).");
assert.match(functions, /crypto\.createHmac\('sha256', secret\)/,
  "Le calcul HMAC doit rester present.");
assert.match(functions, /\.update\('\.'\)/, "Le separateur '.' du HMAC doit rester present.");

/* ------------------------------------------------------------------ */
/* 6. Le chemin create-order honore reellement Retry-After             */
/*    (suite de la PR #11 : le helper corrige n'etait pas branche)     */
/* ------------------------------------------------------------------ */

// 6a. Les 4 appels Livo de orders.js passent par fetchWithRetryResponse.
assert.match(orders, /fetchWithRetryResponse/,
  "orders.js doit importer fetchWithRetryResponse.");
assert.doesNotMatch(orders, /await fetch\(`\$\{LIVO_API_CONFIG\.BASE_URL\}/,
  "Aucun appel Livo de orders.js ne doit rester en fetch brut.");

const livoCalls = orders.match(/await fetchWithRetryResponse\(/g) || [];
assert.equal(livoCalls.length, 4,
  "Les 4 appels Livo (create, cancel, track, pickup) doivent utiliser fetchWithRetryResponse.");

assert.match(orders, /fetchWithRetryResponse\(`\$\{LIVO_API_CONFIG\.BASE_URL\}\$\{LIVO_API_CONFIG\.ENDPOINTS\.CREATE\}`/,
  "L'appel create-order doit specifiquement utiliser fetchWithRetryResponse.");

// 6b. Execution reelle du helper extrait de utils.js dans un sandbox VM.
const utilsSrc = read("js/utils.js");
const blockStart = utilsSrc.indexOf("const RETRYABLE_4XX");
const blockStop = utilsSrc.indexOf("export async function firestoreWithRetry");
assert.ok(blockStart > -1 && blockStop > blockStart,
  "Le bloc retry de utils.js doit etre localisable.");

const retryCode = utilsSrc.slice(blockStart, blockStop).replace(/^export /gm, "");

/* Fabrique une reponse minimale compatible avec le helper. */
function makeResponse(status, headers = {}, body = "") {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body || "{}"),
  };
}

async function runRetry(fetchImpl, retries = 3, delay = 1000) {
  const sandbox = { fetch: fetchImpl, setTimeout, console };
  vm.createContext(sandbox);
  vm.runInContext(
    retryCode +
      "\nthis.fetchWithRetry = fetchWithRetry;" +
      "\nthis.fetchWithRetryResponse = fetchWithRetryResponse;" +
      "\nthis.getRetryAfterMs = getRetryAfterMs;",
    sandbox
  );
  return sandbox;
}

// 6c. 429 + Retry-After: 2 -> le 2e essai doit attendre ~2 s (pas le backoff 1 s).
(async () => {
  let calls = 0;
  const sandbox = await runRetry(async () => {
    calls++;
    if (calls === 1) {
      return makeResponse(429, { "Retry-After": "2" }, '{"success":false}');
    }
    return makeResponse(200, {}, '{"success":true}');
  }, 3, 1000);

  const startedAt = Date.now();
  const response = await sandbox.fetchWithRetryResponse(
    "https://worker/create-order",
    { method: "POST" },
    3,
    1000
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(calls, 2, "Un 429 doit etre rejoue une fois.");
  assert.equal(response.status, 200, "Le 2e essai doit reussir.");
  assert.ok(elapsed >= 1900,
    `Retry-After: 2 doit imposer ~2000 ms d'attente, mesure ${elapsed} ms.`);
  assert.ok(elapsed < 3500,
    `L'attente ne doit pas depasser largement 2 s (mesure ${elapsed} ms).`);

  // 6d. Sans Retry-After, on retombe sur le backoff exponentiel (1 s ici).
  let calls2 = 0;
  const sandbox2 = await runRetry(async () => {
    calls2++;
    return calls2 === 1 ? makeResponse(429, {}, "{}") : makeResponse(200, {}, "{}");
  }, 3, 300);
  const t2 = Date.now();
  await sandbox2.fetchWithRetryResponse("https://worker/create-order", {}, 3, 300);
  const elapsed2 = Date.now() - t2;
  assert.ok(elapsed2 >= 250 && elapsed2 < 1200,
    `Sans Retry-After, le backoff initial doit s'appliquer (mesure ${elapsed2} ms).`);

  // 6e. Un 400 "prompt" NE doit PAS lever : l'enveloppe doit rester lisible,
  //     sinon confirm_text redevient inaccessible (regression de la PR #11).
  const envelope = JSON.stringify({
    success: false,
    data: { fr_message: "Telephone deja utilise", type: "prompt",
            details: { confirm_text: "duplicate_target" } },
  });
  let calls3 = 0;
  const sandbox3 = await runRetry(async () => {
    calls3++;
    return makeResponse(400, {}, envelope);
  }, 3, 1000);

  const badResponse = await sandbox3.fetchWithRetryResponse(
    "https://worker/create-order", {}, 3, 1000
  );
  assert.equal(badResponse.status, 400, "Le 400 doit etre retourne, pas leve.");
  assert.equal(calls3, 1, "Un 400 ne doit pas etre rejoue.");
  const parsed = JSON.parse(await badResponse.text());
  assert.equal(parsed.data.details.confirm_text, "duplicate_target",
    "L'enveloppe prompt/confirm_text doit rester accessible apres le passage en retry.");

  // 6f. fetchWithRetry (variante levant) conserve son contrat historique.
  const sandbox4 = await runRetry(async () => makeResponse(404, {}, "{}"), 3, 100);
  let threw = false;
  try {
    await sandbox4.fetchWithRetry("https://x/y", {}, 3, 100);
  } catch (error) {
    threw = true;
    assert.equal(error.status, 404, "fetchWithRetry doit exposer le statut.");
    assert.equal(error.nonRetryable, true, "Un 404 reste non retentable.");
  }
  assert.ok(threw, "fetchWithRetry doit lever sur un 4xx non retentable.");

  // 6g. Un 5xx reste retentable puis est rendu tel quel apres epuisement.
  let calls5 = 0;
  const sandbox5 = await runRetry(async () => {
    calls5++;
    return makeResponse(503, {}, "{}");
  }, 2, 50);
  const res5 = await sandbox5.fetchWithRetryResponse("https://x/y", {}, 2, 50);
  assert.equal(res5.status, 503, "Le 503 doit etre rendu apres epuisement des essais.");
  assert.equal(calls5, 2, "Un 503 doit etre rejoue jusqu'a epuisement.");

  console.log("PASS: conformite API Livo (Retry-After, prompt/confirm_text, bornes, desired_date, perimetre).");
  console.log("PASS: chemin create-order branche sur fetchWithRetryResponse et Retry-After honore.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

/* ------------------------------------------------------------------ */
/* 7. Webhook : Authorization: Bearer obligatoire (exigence stricte)   */
/*    Spec complete : docs/api/api-entrepot-livo.json, section         */
/*    "Webhooks > Securiser votre endpoint" :                          */
/*      "Refusez toute requete dont l'en-tete Authorization n'est pas  */
/*       exactement `Bearer <votre-cle-webhook>` (comparaison a temps  */
/*       constant)."                                                   */
/*    Ce bloc execute reellement la chaine d'authentification extraite  */
/*    de functions/index.js (secret -> bearer -> timestamp -> body ->   */
/*    signature HMAC).                                                 */
/* ------------------------------------------------------------------ */
(async () => {
  const crypto = require("node:crypto");

  const fnSrc = read("functions/index.js");

  // Contrat statique : le Bearer ne doit plus etre conditionnel.
  assert.doesNotMatch(
    fnSrc,
    /if \(authorization && !timingSafeTextEqual\(authorization, expectedAuthorization\)\)/,
    "Le Bearer du webhook ne doit plus etre optionnel : un en-tete absent est un 401."
  );
  assert.match(
    fnSrc,
    /if \(!timingSafeTextEqual\(authorization, expectedAuthorization\)\) \{/,
    "Le controle Bearer doit etre inconditionnel (comparaison a temps constant)."
  );
  // Le 500 explicite quand le secret est absent doit etre conserve.
  assert.match(
    fnSrc,
    /if \(!secret\) \{[\s\S]{0,200}?res\.status\(500\)/,
    "Un secret absent doit toujours produire un 500 explicite."
  );

  // Extraction de la chaine d'authentification reelle.
  const authStart = fnSrc.indexOf("  const secret = LIVO_WEBHOOK_SECRET.value();");
  const authEnd = fnSrc.indexOf("  let event;");
  assert.ok(
    authStart > -1 && authEnd > authStart,
    "La chaine d'authentification du webhook doit etre localisable dans functions/index.js."
  );
  const authRegion = fnSrc.slice(authStart, authEnd);

  // Extraction de timingSafeTextEqual (helper utilise par la region).
  const tsStart = fnSrc.indexOf("function timingSafeTextEqual");
  const tsEnd = fnSrc.indexOf("}", fnSrc.indexOf("return leftBuffer.length")) + 1;
  assert.ok(tsStart > -1 && tsEnd > tsStart, "timingSafeTextEqual doit etre localisable.");
  const tsEqualSrc = fnSrc.slice(tsStart, tsEnd);

  // La fenetre anti-replay est lue depuis le code, pas recopiee en dur :
  // si quelqu'un la change, le test suit.
  const skewMatch = fnSrc.match(/LIVO_WEBHOOK_MAX_CLOCK_SKEW_SECONDS = (\d+)/);
  assert.ok(skewMatch, "LIVO_WEBHOOK_MAX_CLOCK_SKEW_SECONDS doit etre defini dans functions/index.js.");
  const MAX_SKEW_SECONDS = Number(skewMatch[1]);
  assert.equal(MAX_SKEW_SECONDS, 300, "La spec impose une fenetre anti-replay de 5 minutes.");

  const sandbox = { crypto, Buffer, console };
  vm.createContext(sandbox);
  vm.runInContext(
    `const LIVO_WEBHOOK_MAX_CLOCK_SKEW_SECONDS = ${MAX_SKEW_SECONDS};`,
    sandbox
  );
  vm.runInContext(tsEqualSrc, sandbox);
  vm.runInContext(
    "this.runWebhookAuth = function(secretValue, headers, bodyBuffer) {\n" +
      "  const LIVO_WEBHOOK_SECRET = { value: function () { return secretValue; } };\n" +
      "  let captured = null;\n" +
      "  const res = {\n" +
      "    status: function (code) {\n" +
      "      captured = { status: code };\n" +
      "      return { json: function (payload) { captured.body = payload; return captured; } };\n" +
      "    }\n" +
      "  };\n" +
      "  const req = {\n" +
      "    rawBody: bodyBuffer,\n" +
      "    get: function (name) {\n" +
      "      const key = String(name).toLowerCase();\n" +
      "      return Object.prototype.hasOwnProperty.call(headers, key) ? headers[key] : undefined;\n" +
      "    }\n" +
      "  };\n" +
      authRegion +
      "\n  return captured; // null = toutes les verifications sont passees\n" +
      "};",
    sandbox
  );

  const SECRET = "lv_whsec_7f3a9c1e5b2d8f4a6c0e9b1d3f5a7c9e";
  const BODY = Buffer.from(
    JSON.stringify({
      id: "wd-abcde12345",
      event: "order.status_changed",
      created_at: "2026-11-05T10:24:00.000Z",
      data: { _id: "or-ab12cd34", status: "fulfilled" },
    }),
    "utf8"
  );
  const now = String(Math.floor(Date.now() / 1000));
  const goodSignature =
    "sha256=" +
    crypto.createHmac("sha256", SECRET).update(now).update(".").update(BODY).digest("hex");

  function validHeaders(overrides = {}) {
    return Object.assign(
      {
        authorization: "Bearer " + SECRET,
        "x-livo-timestamp": now,
        "x-livo-signature": goodSignature,
      },
      overrides
    );
  }

  // 7a. Aucun en-tete Authorization -> 401.
  const noAuth = sandbox.runWebhookAuth(SECRET, validHeaders({ authorization: undefined }), BODY);
  assert.ok(noAuth, "Une requete sans Authorization doit etre rejetee.");
  assert.equal(noAuth.status, 401, "Absence de Bearer doit renvoyer 401.");

  // 7b. Bearer vide -> 401.
  const emptyAuth = sandbox.runWebhookAuth(SECRET, validHeaders({ authorization: "" }), BODY);
  assert.equal(emptyAuth.status, 401, "Un Bearer vide doit renvoyer 401.");

  // 7c. Mauvais Bearer -> 401.
  const badAuth = sandbox.runWebhookAuth(
    SECRET,
    validHeaders({ authorization: "Bearer lv_whsec_mauvais_secret_000000000000" }),
    BODY
  );
  assert.equal(badAuth.status, 401, "Un mauvais Bearer doit renvoyer 401.");

  // 7d. Secret correct mais prefixe/suffixe en trop -> 401 (egalite stricte).
  const paddedAuth = sandbox.runWebhookAuth(
    SECRET,
    validHeaders({ authorization: "Bearer " + SECRET + " " }),
    BODY
  );
  assert.equal(paddedAuth.status, 401, "L'egalite du Bearer doit etre stricte.");

  // 7e. Cas nominal : tout est correct -> aucune erreur capturee.
  const ok = sandbox.runWebhookAuth(SECRET, validHeaders(), BODY);
  assert.equal(ok, null, "Une requete authentifiee correctement doit franchir toute la chaine.");

  // 7f. Non-regression : la signature HMAC reste exigee meme avec un bon Bearer.
  const noSig = sandbox.runWebhookAuth(SECRET, validHeaders({ "x-livo-signature": undefined }), BODY);
  assert.equal(noSig.status, 401, "La signature HMAC doit rester obligatoire.");

  const badSig = sandbox.runWebhookAuth(
    SECRET,
    validHeaders({ "x-livo-signature": "sha256=" + "0".repeat(64) }),
    BODY
  );
  assert.equal(badSig.status, 401, "Une signature HMAC invalide doit renvoyer 401.");

  // 7g. Non-regression : anti-replay toujours actif (timestamp hors fenetre).
  const oldTs = String(Math.floor(Date.now() / 1000) - (MAX_SKEW_SECONDS + 60));
  const replay = sandbox.runWebhookAuth(SECRET, validHeaders({ "x-livo-timestamp": oldTs }), BODY);
  assert.equal(replay.status, 401, "Un timestamp de plus de 5 minutes doit renvoyer 401.");

  // 7h. Secret absent -> 500 explicite, pas 401 silencieux.
  const noSecret = sandbox.runWebhookAuth(undefined, validHeaders(), BODY);
  assert.equal(noSecret.status, 500, "Un secret absent doit renvoyer 500.");

  // 7i. La liste d'evenements autorises doit rester identique a l'enum de la spec.
  const spec = JSON.parse(read("docs/api/api-entrepôt-livo.json"));
  const specEvents = spec.components.schemas.WebhookEvent.properties.event.enum.slice().sort();
  const codeEventsMatch = fnSrc.match(/LIVO_WEBHOOK_ALLOWED_EVENTS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(codeEventsMatch, "LIVO_WEBHOOK_ALLOWED_EVENTS doit exister.");
  const codeEvents = [...codeEventsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    codeEvents,
    specEvents,
    "Les evenements acceptes doivent correspondre exactement a WebhookEvent.event de la spec complete."
  );

  console.log("PASS: webhook - Authorization Bearer obligatoire (401 si absent ou invalide), HMAC et anti-replay conserves.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
