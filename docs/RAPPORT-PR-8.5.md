# Rapport PR 8.5 — Hygiène dette technique & alignement Livo

**Branche** : `feat/pr-8.5-hygiene-dette`
**Base** : `48e8617` — Merge PR #53 — PR 8.4 : filtrage du ramassage groupé par `delivery_mode`
**Nature** : PR d'hygiène / dette technique. **Aucune fonctionnalité nouvelle.**

---

## 1. Commits de la PR

| # | SHA | Message | Étape |
|---|-----|---------|-------|
| 0 | `48e8617` | Merge PR #53 — PR 8.4 : filtrage du ramassage groupé par delivery_mode | **base** |
| 1 | `7fd68e2` | chore(eol): normaliser smart-swi9a-api.js en LF pur (76 CRLF -> 0) | dette C2-eol |
| 2 | `8d1a3db` | chore(config): wrangler dédié pour livo-proxy + runbook --config | dette B |
| 3 | `e78d8c5` | feat(config): aligner LIVO_STATUS_MAP sur le serveur + refonte syncLivoStatus | **C1** |
| 4 | `b738c17` | fix(admin): source unique de sync Livo + compteur d'erreurs du 'Tout synchroniser' | **C2** |
| 5 | `7344edb` | test(livo): tests de non-regression syncLivoStatus + garde de transition | **C3** |

---

## 2. C1 — Alignement du mapping Livo client ↔ serveur (`e78d8c5`)

Fichiers : `js/config.js`, `js/orders.js`.

### 2.1 `LIVO_STATUS_MAP` (js/config.js L462-470) — 7 entrées, alignées sur le serveur

```js
export const LIVO_STATUS_MAP = {
    'pending':           ORDER_STATUS.CONFIRMED,
    'programmed':        ORDER_STATUS.CONFIRMED,
    'awaiting pickup':   ORDER_STATUS.PICKUP_REQUESTED,
    'awaiting transfer': ORDER_STATUS.PICKED_UP,
    'in progress':       ORDER_STATUS.IN_TRANSIT,
    'fulfilled':         ORDER_STATUS.DELIVERED,
    'cancelled':         ORDER_STATUS.CANCELLED
};
```

- 7 clés, valeurs **strictement identiques** à `LIVO_STATUS_TO_ORDER_STATUS` de `functions/index.js`.
- `draft`, `problem`, `reported` sont **volontairement absents** : ces statuts n'écrivent que `livoStatusRaw`.
- **`shipping` n'est produit par aucune value** (il reste un statut legacy d'entrée, pas de sortie).

### 2.2 `LIVO_SYNCABLE_STATUSES` (js/config.js L479-486) — source unique

```js
export const LIVO_SYNCABLE_STATUSES = [
    ORDER_STATUS.CONFIRMED,
    ORDER_STATUS.PREPARED,
    ORDER_STATUS.PICKUP_REQUESTED,
    ORDER_STATUS.PICKED_UP,
    ORDER_STATUS.IN_TRANSIT,
    ORDER_STATUS.SHIPPING      // legacy seulement, retrait prévu en 8.6
];
```

- `PENDING` et `PREPARING` **volontairement absents** (le webhook serveur rattrape ces cas — pas d'élargissement en 8.5).
- La liste n'est **plus dupliquée** dans `orders.js` / `admin.js`.

### 2.3 `mapLivoStatusToSmart()` retourne `null` (js/config.js L495-505)

```js
if (!livoStatus) return null;
const key = String(livoStatus).toLowerCase().trim();
return LIVO_STATUS_MAP[key] || null;
```

Retourner `null` (et non une valeur par défaut) force l'appelant à traiter explicitement le cas — contrat aligné sur le serveur.

### 2.4 `ALLOWED_TRANSITIONS` hissée au niveau module — **js/orders.js L580**

Attention au chemin : la table est dans **`js/orders.js`**, pas dans `js/config.js`.

```js
/* TRANSITIONS DE STATUT AUTORISEES (table unique) — L580 */
const ALLOWED_TRANSITIONS = {
    [ORDER_STATUS.PENDING]:           [CONFIRMED, CANCELLED],
    [ORDER_STATUS.CONFIRMED]:         [PREPARING, PICKUP_REQUESTED, SHIPPING /* legacy */, CANCELLED],
    [ORDER_STATUS.PREPARING]:         [PREPARED, CANCELLED],
    [ORDER_STATUS.PREPARED]:          [PICKUP_REQUESTED, CANCELLED],
    [ORDER_STATUS.PICKUP_REQUESTED]:  [PICKED_UP, CANCELLED],
    [ORDER_STATUS.PICKED_UP]:         [IN_TRANSIT, RETURNED],
    [ORDER_STATUS.IN_TRANSIT]:        [DELIVERED, RETURNED],
    [ORDER_STATUS.SHIPPING]:          [PICKED_UP, IN_TRANSIT, DELIVERED, CANCELLED],
    [ORDER_STATUS.DELIVERED]:         [],
    [ORDER_STATUS.RETURNED]:          [],
    [ORDER_STATUS.CANCELLED]:         []
};
```

Avant C1 cette table était locale au corps de `updateOrderStatus`. Elle est désormais **partagée** entre la garde transactionnelle (`updateOrderStatus`, L829) et le pré-test de `syncLivoStatus` (L677) : **une seule source de vérité**.

### 2.5 `syncLivoStatus()` — 6 branches explicites (js/orders.js L607-704)

Les extras (`livoStatusRaw`, `livoProblem`, `livoReturnStatus`) sont construits **AVANT toutes les gardes** et persistés dans **toutes** les branches sauf l'incident technique :

| Branche | Condition | Retour |
|---|---|---|
| 1 | `!mapped` (draft / problem / reported / inconnu) | `{success:true, updated:false, raw:true, currentStatus}` + extras |
| 2 | commande terminale (delivered / returned / cancelled) | `{success:true, updated:false, terminal:true}` + extras |
| 3 | `currentStatus === mapped` | `{success:true, updated:false, currentStatus}` + extras |
| 4 | transition non autorisée (pré-test `ALLOWED_TRANSITIONS`) | `{success:true, updated:false, transitionBlocked:true, targetStatus, reason}` + extras |
| 5 | `updateOrderStatus` OK | `{success:true, updated:true, newStatus}` + extras |
| 6 | `updateOrderStatus` en échec (vrai incident) | `{success:false, error}` — **pas d'extras écrits** |

La branche 4 évite de provoquer le `throw` transactionnel de `updateOrderStatus` tout en traçant l'état réel.

### 2.6 Filtre U6 — source unique côté admin (js/admin.js L2326)

```js
return trackingId && LIVO_SYNCABLE_STATUSES.includes(normalizeOrderStatus(o.status));
```

### 2.7 Toast U2 — `js/orders.js` L1662-1689 (bouton Sync unitaire)

Les 5 cas de retour sont distingués à l'écran :
- `updated` → « Statut mis à jour : X »
- `raw` → « Statut Livo X enregistré (traçage seul) »
- `terminal` → « Commande déjà livrée/annulée — non modifiée »
- `transitionBlocked` → « Statut Livo X enregistré (transition Y non autorisée) »
- sinon → « Erreur: … »

---

## 3. C2 — Source unique de sync côté admin (`b738c17`)

Fichier : `js/admin.js`.

| Point | Ligne | Contenu |
|---|---|---|
| Import | **L19** | `LIVO_SYNCABLE_STATUSES` importé depuis `js/config.js` (fin de la liste locale dupliquée) |
| U5 — bouton Sync de l'onglet Livo | **L2279** | `const syncBtn = trackingId && LIVO_SYNCABLE_STATUSES.includes(status) ? …` |
| U7 — filtre « Tout synchroniser » | **L2326** | `return trackingId && LIVO_SYNCABLE_STATUSES.includes(normalizeOrderStatus(o.status));` |
| U3 — compteur d'erreurs | **L2343-2352** | `let updatedCount = 0, errorCount = 0;` … `if (!res.success) errorCount++;` … `catch { errorCount++; }` |
| Toast U2 admin | **L2352** | `` `${updatedCount} commande(s) mise(s) à jour.${errorCount > 0 ? ' ' + errorCount + ' erreur(s).' : ''}` `` |

Avant C2, un échec de `syncLivoStatus` était **silencieux** dans le « Tout synchroniser » : l'admin voyait un décompte de mises à jour sans jamais savoir combien de commandes avaient échoué. Le compteur `errorCount` comble ce trou.

---

## 4. C3 — Tests de non-régression (`7344edb`)

Deux fichiers, **aucune modification de code de production**.

### 4.1 `tests/livo-sync.test.cjs` — **11/11 PASS**

| Test | Vérifie |
|---|---|
| T1 | `mapLivoStatusToSmart(draft/problem/reported/xyz)` → `null` |
| T2 | `mapLivoStatusToSmart(null/undefined/"")` → `null` |
| T3 | les 7 clés serveur → statut exact |
| T4 | `"shipping"` absent de toutes les **values** de `LIVO_STATUS_MAP` |
| T5 | statut non mappé → `raw:true`, extras écrits, statut inchangé |
| T6 | `delivered` + « in progress » → `terminal:true`, statut inchangé, extras écrits |
| T7 | même statut → `updated:false`, extras écrits |
| T8 | legacy `shipping` → `in_transit` : `updated:true` (transition autorisée) |
| **T9** | `confirmed` + « in progress » → `transitionBlocked:true`, extras écrits |
| **T9bis** | après hissage, `updateOrderStatus` refuse **toujours** les mêmes transitions — **contrat réel** : retourne `{success:false, error}` (la garde transactionnelle n'a pas été contournée) |
| T10 | `LIVO_SYNCABLE_STATUSES` contient `shipping`+`in_transit`, exclut `pending`+`preparing` |

T9bis est le test charnière : il ne se contente pas de vérifier que `syncLivoStatus` *dit* « bloqué », il vérifie que la couche du dessous **refuse réellement** (`{success:false, error}`). L'invariant tient donc aux deux niveaux.

### 4.2 `tests/livo-compliance.test.cjs` — **5/5 PASS**

| Bloc | Vérifie |
|---|---|
| baseline-1 | `mapping LIVO_STATUS_TO_ORDER_STATUS identique entre functions/index.js et le simulateur` |
| baseline-2 | webhook — `Authorization` Bearer obligatoire (401 si absent/invalide), HMAC et anti-replay conservés |
| **6ter** | **parité mapping Livo client (`js/config.js`) ↔ serveur (`functions/index.js`)** : 7 clés, valeurs identiques, `draft`/`problem`/`reported` absents, `shipping` non produit |
| baseline-4 | conformité API Livo (Retry-After, prompt/confirm_text, bornes, desired_date, périmètre) |
| baseline-5 | chemin `create-order` branché sur `fetchWithRetryResponse` et Retry-After honoré |

`readClientMap()` a été corrigé pour extraire `CONFIG.ORDERS.STATUS` puis **évaluer `LIVO_STATUS_MAP` dans un `vm`** (et non par regex sur le texte source) : c'est ce qui rend le test 6ter robuste — il compare des **valeurs exécutées**, pas des chaînes de caractères.

### 4.3 `tests/grouped-pickup.test.cjs` — **12/12 PASS** (non-régression)

T1, T2, T3, T4, T5, T6, T6bis, **T6ter**, T7, T8, T8bis, T9.

Ce fichier est **antérieur** à la PR 8.5 et n'a pas été modifié : il sert de garde-fou de non-régression sur le ramassage groupé, touché indirectement par la refonte de `syncLivoStatus`.

---

## 5. Dettes reportées en 8.6

### 5.1 Blocage de transition `confirmed` → `in_transit` (dette principale)

> **confirmed→in_transit non autorisé, syncLivoStatus trace livoStatusRaw + retourne transitionBlocked, admin avance manuellement — ouverture workflow en 8.6**

Contexte : une commande encore `confirmed` que Livo déclare « in progress » ne peut pas sauter directement à `in_transit` (la table exige de passer par `pickup_requested` → `picked_up`). Comportement actuel assumé : on **trace** (`livoStatusRaw`) et on **signale** (`transitionBlocked: true`), sans casser la commande. L'admin avance manuellement. La refonte de ce workflow (rattrapage automatique multi-sauts, ou transition directe justifiée) est hors périmètre 8.5.

### 5.2 Placeholder vide dans le runbook §2

`docs/runbooks/ROTATION-SECRET-LIVO.md` §2 (« Prérequis ») contient une section de commandes de vérification dont le bloc « État de référence à relever » n'est pas encore renseigné de manière définitive pour tous les champs. À compléter lors de la prochaine rotation réelle.

### 5.3 `workers_dev = true` figé pour `livo-proxy` (vs voisin à `false`)

`cloudflare/workers/wrangler.livo-proxy.toml` L53 : `workers_dev = true`, alors que `cloudflare/workers/wrangler.toml` L8 déclare `workers_dev = false`.

Justification (verbatim du fichier) : `https://livo-proxy.smartswi9a.workers.dev` **répond aujourd'hui** (`OPTIONS` → `204`) ; figer `true` préserve l'existant à l'identique. Un passage à `false` **couperait un accès actuellement actif**. Le TODO est inscrit : migrer le front vers un domaine de zone (`js/config.js:155`, `PROXY_WORKER_URL`) puis passer à `false` pour bénéficier WAF / rate limiting / bot management — **PR dédiée**.

### 5.4 `normalizeOrderStatus` : legacy `shipping` → `in_transit`

`js/config.js` L325 `normalizeOrderStatus()` remappe encore le statut legacy `shipping` vers `in_transit` (L476 : « Retrait prévu en 8.6 »). Tant que des commandes en base portent `shipping`, ce remappage et l'entrée `ORDER_STATUS.SHIPPING` de `LIVO_SYNCABLE_STATUSES` doivent rester. Retrait après vérification qu'aucun document Firestore ne porte plus `shipping`.

### 5.5 `LIVO_VENDOR_UIDS` non configuré en production

`cloudflare/workers/livo-proxy.js` L245 lit `env.LIVO_VENDOR_UIDS` avec repli `""`. Conséquence (verbatim du TOML L36-38) : « `LIVO_VENDOR_UIDS` n'étant pas configuré en production, aucun vendeur n'est actuellement autorisé à appeler le proxy. Constat antérieur à la PR 8.5, suivi en dette 8.6, non corrigé ici. » Fail-closed volontaire.

### 5.6 EOL groupés (`git ls-files --eol`)

Contrôle : `git ls-files --eol` → **51 fichiers** portent encore `w/crlf` en working tree (index majoritairement `i/lf`, `attr/text=auto eol=lf`).

Fichiers avec `i/crlf` (CRLF **dans l'index**, les plus gênants) : `docs/legal/cgu-acheteur.md`, `cgu-vendeur.md`, `contrat-vendeur.md`, `politique-confidentialite.md`, `firestore.rules`, `storage.rules`, `scripts/seed-config-app.cjs`.

Seul `cloudflare/workers/smart-swi9a-api.js` a été normalisé en LF pur par cette PR (`7fd68e2`, 76 CRLF → 0). Les autres relèvent d'une passe EOL dédiée 8.6, à faire fichier par fichier avec re-run des tests.

### 5.7 Modernisation de `compatibility_date` du Worker `livo-proxy`

`cloudflare/workers/wrangler.livo-proxy.toml` L18 : `compatibility_date = "2025-01-01"`, identique au `wrangler.toml` voisin. Verbatim du fichier : « La modifier change le runtime au prochain déploiement — ce n'est pas le rôle d'une PR d'hygiène. Modernisation = PR dédiée, avec tests. »

---

## 6. Périmètre — ce qui n'a **pas** été fait

- **Aucun déploiement manuel** : ni `firebase deploy`, ni `wrangler deploy`, ni `wrangler publish`. Aucun `--config` déclenché hors lecture.
- **Aucune modification de `functions/index.js`** : le fichier est identique à la base `48e8617`. Vérifié par `git status --porcelain functions/index.js` (vide) et `git diff --stat HEAD -- functions/index.js` (vide) à chaque étape.
- **Aucune migration Firestore** : pas de script, pas de write, pas de changement de règle. `firestore.rules` et `storage.rules` sont inchangés (seule leur EOL est notée en dette 8.6).

Toutes les modifications sont **côté client** (`js/`) et **tests** (`tests/`) + documentation/configuration Worker (`cloudflare/workers/wrangler.livo-proxy.toml`).

---

## 7. Vérifications finales

| Contrôle | Résultat |
|---|---|
| `node tests/livo-sync.test.cjs` | **11/11 PASS** |
| `node tests/livo-compliance.test.cjs` | **5/5 PASS** (dont 6ter parité) |
| `node tests/grouped-pickup.test.cjs` | **12/12 PASS** |
| `node --check tests/livo-sync.test.cjs` | OK |
| `node --check tests/livo-compliance.test.cjs` | OK |
| `functions/index.js` | intact (aucun delta) |
| Commit C3 | `7344edb` — 2 fichiers, +663 lignes |
| EOL des fichiers C3 | CRLF = 0 sur les deux |
