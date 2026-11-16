# AUDIT & CORRECTIONS — 16/11/2026

> Journal des corrections appliquées suite à l'audit général.
> Chaque entrée indique la cause racine, le correctif et la vérification.

## C1 — `tests/livo-sync.test.cjs` : T10 périmé (CI rouge)

**Cause** : la dette 8.11 a retiré `SHIPPING` de `LIVO_SYNCABLE_STATUSES`
(`js/config.js:484-490`) mais le test T10 exigeait toujours `includes('shipping')`
et une liste de 6 statuts.

**Correctif** : assertion inversée (`!includes('shipping')`) et liste ramenée à
5 statuts. Commentaire expliquant le remappage `SHIPPING → IN_TRANSIT`.

**Vérification** : `node tests/livo-sync.test.cjs` → T10 PASS (11/12).

## C2 — `js/orders.js` : stock fantôme sur annulation depuis `in_transit`

**Cause** : deux gardes de restauration de stock (`orders.js:937` et `:957`)
testaient `previousStatus ∈ [PENDING, CONFIRMED, SHIPPING]`. Depuis le retrait de
`SHIPPING`, le statut normal est `IN_TRANSIT`, **absent de la liste**. Une
commande annulée depuis `in_transit` ne rendait donc jamais le stock.

**Correctif** : ajout de `ORDER_STATUS.IN_TRANSIT` aux deux listes + commentaire
expliquant pourquoi `SHIPPING` est conservé (lignes legacy).

**Vérification** : `node --check js/orders.js` → OK.

## C3 — Rapprochement des villes : doublons Firestore

**Cause** : `syncLivoCitiesFromApi` comparait les libellés Livo à l'existant
avec une **égalité stricte** sur `normalizeCityKey`. Or Livo fait varier ses
libellés d'une synchronisation à l'autre :

| Livo renvoie | Document historique | Résultat |
|---|---|---|
| `sidi sliman` | `sidi slimane` | pas de match → **doublon créé** |
| `ajdir al hoceima` | `ajdir` | pas de match → **doublon créé** |
| `bni bouayach al hoceima` | `bni bouayach` | pas de match → **doublon créé** |

Deux documents coexistaient alors pour la même ville (`cities/19`
« Sidi Slimane » à 30 DH et `cities/city_sidi_sliman` à 45 DH).
`utils.js` retenant le premier par `id`, c'est **l'ancien tarif** qui
s'affichait → sous-facturation de 15 DH.

**Correctif** (`functions/index.js`), trois passes du plus strict au plus
permissif :

1. clé exacte normalisée (comportement d'origine) ;
2. clé « agressive » : tout sauf `[a-z0-9]` supprimé ;
3. préfixe borné : l'une préfixe de l'autre, chacune ≥ 8 caractères et
   rapport de longueur ≥ 0,75 — pour ne **pas** fusionner des villes
   réellement distinctes (`bir jdid` / `bir rami`, `ksar el kebir` /
   `ksar sghir`, `oued jdida` / `oued laou`).

Helpers hissés au niveau module (`looseCityKey`, `findExistingCity`,
`MIN_CITY_PREFIX = 8`) pour être testables sans Firestore.

**Vérification** : `tests/livo-city-matching.test.cjs` — **8/8 PASS**.
M2/M3/M4 couvrent les trois cas réels, M8 vérifie qu'un préfixe trop court
ne fusionne pas.

## C3-bis — Le sync SUPPRIMAIT des documents référencés par des commandes

**Cause** : le bloc « suppression des villes obsolètes » supprimait tout
document dont la clé n'était pas **exactement** dans la grille Livo, y compris
les documents **historiques** (`lahraouiyine`, etc.).

Or `createCustomerOrder` valide la commande via
`db.collection('cities').doc(String(delivery.cityId))`. Si ce document a été
supprimé, **la commande est refusée**.

**Correctif** : la suppression ne vise plus que les documents **créés par
Livo** (`data.source === 'livo'`) et **non appariés** (`matchedRefs`). Les
documents historiques sont conservés — mis à jour au prix Livo s'ils
correspondent à une ville desservie, laissés tels quels sinon.

> Point le plus sensible du lot : sans ce correctif, un clic sur
> « Synchroniser les villes » pouvait rendre des commandes existantes
> invalides.

## Piège : apostrophes dans les commentaires de `functions/index.js`

Le test `livo-webhook-sim.test.cjs` extrait `resolveCreditUnlockBase` par
**comptage d'accolades et de quotes** (parseur naïf ignorant les commentaires).
Une apostrophe isolée dans un commentaire (`d'une`, `l'existant`, `s'ils`)
ouvrait une fausse chaîne et décalait l'extraction → `exports is not defined`.

Les commentaires de `functions/index.js` évitent désormais les apostrophes.
**À respecter** pour toute future modification de ce fichier.

## C5 — `orders.js` : `updateOrderStatus` pouvait retourner `undefined`

**Cause** : la garde anti-double-exécution (`previousStatus === normalizedStatus`)
faisait un `return` nu dans la transaction. `runTransaction` se résolvait donc
avec `undefined`, et un appelant testant `result.success` levait une `TypeError`.

**Correctif** : la garde alimente désormais `noopResult`, retourné explicitement
comme `{ success: false, error: 'Transition de commande interdite : statut deja
<statut>.', unchanged: true }`. Le comportement métier est identique (aucune
écriture, aucun email, aucun appel Livo) ; seul le contrat de retour est
normalisé.

**Vérification** : `node tests/livo-sync.test.cjs` → **12/12 PASS**, dont
`T9bis` qui échouait depuis le début de l'audit.

> ⚠️ **Contrat d'API modifié.** `updateOrderStatus` ne renvoie plus jamais
> `undefined`. Les appelants qui testaient `if (result.success)` sont sécurisés ;
> ceux qui testaient `if (result === undefined)` (improbable) devront être revus.

## C6 — `firestore.rules` : 5 collections sensibles sans clause explicite

**Cause** : `vendorCredentials`, `vendorLoginThrottle`, `order_requests`,
`livo_webhook_events` et `meta` n'avaient **aucune clause dédiée**. Elles
tombaient dans le refus par défaut (`match /{document=**} { allow read, write: if
false; }`). Le comportement était donc correct, mais **implicite** : une future
règle mal ciblée pouvait les exposer sans qu'aucun relecteur ne le voie.

**Correctif** : ajout de 5 blocs `allow read, write: if false;` documentés
(`firestore.rules:437-473`). `vendorCredentials` contient les hash bcrypt des
mots de passe vendeurs — c'est la collection la plus critique du modèle.

**Vérification** : validateur Firebase → `OK: No errors detected.`

## C7 — `worker-ip` : source absente du dépôt + CORS sur mauvais domaine

**Cause** : le Worker `worker-ip` était déployé en production depuis le
2026-10-23 (`last_deployed_from: quick_editor`) **sans aucune source versionnée**.
Son code figeait `Access-Control-Allow-Origin: https://smartswi9a.top`, alors que
le domaine exploité est `smartswika.ma` : depuis le site, le navigateur bloquait
la réponse et la capture d'IP des contrats échouait silencieusement.

**Correctif** :
- `cloudflare/workers/worker-ip.js` — source versionnée, liste blanche CORS
  (smartswika.ma + www + smartswi9a.top + localhost), fail-closed si l'origine
  n'est pas autorisée, `X-Content-Type-Options`, `Referrer-Policy`,
  méthode limitée à `GET`/`OPTIONS`, réponse `503` explicite si
  `CF-Connecting-IP` est absent, et suppression de `ua`/`acceptLang` du payload
  (non nécessaires pour la preuve d'IP, minimisation de données).
- `cloudflare/workers/wrangler.worker-ip.toml` — déploiement reproductible via
  `npx wrangler deploy --config wrangler.worker-ip.toml`.

**Statut** : source corrigée, **reste à déployer** par vous (je ne déploie pas en
production sans validation).

## C8 — `firestore-debug.log` suivi par Git

**Constat** : le fichier était déjà couvert par `.gitignore` (ligne 5 et `*.log`
ligne 7), mais restait **suivi** car ajouté avant la règle.

**Correctif** : `git rm --cached firestore-debug.log` — le fichier reste sur
disque, il n'est simplement plus versionné.

## C4 — Grille tarifaire Livo vs site : 126 villes sous-facturées

**Constat mesuré** (`scripts/audit-livo-fees.cjs`, 2026-11-16) :

| Métrique | Valeur |
|---|---|
| Villes `villes.json` | 240 |
| Villes Livo (`/fees/public`) | 404 |
| Prix identiques | 0 |
| Sous-facturées | 126 |
| Sur-facturées | 2 |
| Clés non appariées | 112 |

Le site affichait 30 DH là où Livo facture 45 DH → **−15 DH par commande**.
`villes.json` n'est qu'un **fallback** (`js/utils.js:876-955` : cache →
Firestore `cities` → `/villes.json`), donc la correction devait aussi porter sur
**Firestore**.

**Correctifs appliqués (politique : prix exacts Livo, marge = 0) :**

1. **`villes.json`** — `scripts/apply-livo-fees-to-villes.cjs --write` :
   135 villes alignées sur la grille Livo officielle. Résultat après coup :
   **128 prix identiques, 0 écart, 0 sous-facturation**.
   Casablanca 30 → 20 DH, Rabat 30 → 35 DH, Safi 30 → 45 DH.
   Les **112 villes sans correspondance** sont conservées à 30 DH et signalées
   par le script (aucun prix deviné).

2. **`admin.html`** — ajout du bouton `🏙️ Synchroniser les villes`
   (`#syncLivoCitiesBtn`). La Cloud Function `syncLivoCities` existait et était
   déployée, mais **aucun bouton ne l'appelait** : les prix Firestore sont restés
   figés. C'était la cause racine.

3. **`js/admin.js`** — handler `syncLivoCitiesGrid()` : appel authentifié
   `POST /api/syncLivoCities` avec `preserveCustom: false`, toast de résultat
   (`created` / `updated` / `deleted`), puis `loadCities(true)` pour invalider
   le cache local. Import de `loadCities` ajouté depuis `utils.js`.

**Garantie « sans marge »** : `syncLivoCitiesFromApi` écrit `price: c.fee`
(`functions/index.js:373` et `:390`) — la valeur Livo brute, sans coefficient.
`getCartDeliveryFee()` (`js/cart.js`) renvoie `Number(city.price)`, et
`panier.js:667` affiche `city.price`. Aucune marge n'est introduite à aucun
étage.

**☑️ Résiduel** : 112 villes du site ne figurent pas dans la grille Livo
(`berrechid`, `khemisset`, `sidi slimane`, `bejaad`, `fquih ben salah`…).
Elles restent à 30 DH. À traiter avec Livo (négociation de desserte) ou en
masquant ces villes du sélecteur.

## C9 — Cloud Function `syncLivoCities` : jamais déclenchée

**Cause** : `exports.syncLivoCities` est déployée (`europe-west1`, invoker
public, auth admin obligatoire) et présente dans `ALLOWED_FUNCTIONS` du Worker
`smart-swi9a-api`, mais **aucun élément d'interface ne l'appelait**. Résultat :
les prix Firestore n'ont jamais été rafraîchis depuis la mise en service.

**Correctif** : bouton admin + handler (voir C4.2 et C4.3).

**Ce que ça change** : après un clic sur « Synchroniser les villes », Firestore
reçoit les 404 villes Livo avec leurs tarifs réels. Le panier et la page HTML
lisent ensuite `city.price` — donc les prix exacts, sans marge.


## Fichiers ajoutés

| Fichier | Rôle |
|---|---|
| `docs/livo/fees-livo.json` | Grille Livo 404 villes (snapshot versionné) |
| `scripts/import-livo-fees.cjs` | Rafraîchit le snapshot |
| `scripts/audit-livo-fees.cjs` | Compare Livo ↔ `villes.json` |
