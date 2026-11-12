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
assert.match(utils, /error\.retryAfterMs \?\? backoff/,
  "Le delai serveur doit primer sur le backoff exponentiel.");

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
assert.match(functions, /if \(authorization && !timingSafeTextEqual\(authorization, expectedAuthorization\)\)/,
  "Le Bearer du webhook doit etre tolere s'il est absent ; la signature HMAC reste obligatoire.");
assert.match(functions, /crypto\.createHmac\('sha256', secret\)/,
  "Le calcul HMAC doit rester present.");
assert.match(functions, /\.update\('\.'\)/, "Le separateur '.' du HMAC doit rester present.");

console.log("PASS: conformite API Livo (Retry-After, prompt/confirm_text, bornes, desired_date, perimetre).");
