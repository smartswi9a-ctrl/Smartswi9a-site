# RAPPORT PR 8.4 — Filtrage du ramassage groupé par `delivery_mode`

### Branche : `feat/pr-8.4-filtrage-ramassage` · Base : `main`
### Nature : correctif applicatif + script d'exploitation one-shot. **Aucun déploiement.**

---

## ⚠️ À EXÉCUTER APRÈS MERGE, AVANT TOUT TEST DE RAMASSAGE

```
node scripts/backfill-grouped-pickup-eligible.cjs --dry-run
puis
node scripts/backfill-grouped-pickup-eligible.cjs --apply
```

Sans cette étape, les commandes déjà en `confirmed` au moment du merge n'ont pas
l'attestation `groupedPickupEligible` : la garde de `js/orders.js` les refuserait et
elles resteraient visibles à tort dans la liste de ramassage jusqu'à un passage manuel.

---

## 1. Le problème corrigé

Avant cette PR, `getGroupedPickupCandidates()` (`js/admin.js`) ne filtrait que sur deux
critères :

```js
where('status', '==', 'confirmed')
...
.filter(order => !order.livoPickupId)
```

Conséquence : **toute** commande confirmée sans ramassage était proposée au ramassage
groupé de l'entrepôt. Y compris :

- les commandes **drop-off**, dont le colis est encore **chez le vendeur** — Livo se
  déplaçait pour un colis qui n'était pas sur place ;
- les **paniers multi-vendeurs**, hétérogènes par nature ;
- les commandes de **vendeurs non approuvés ou suspendus** ;
- les commandes dont **une seule ligne** n'est pas en `smartswika_warehouse`
  (commande mixte entrepôt + drop-off).

Le compteur « X colis en attente » était gonflé par les mêmes commandes, et la
confirmation ne montrait qu'un **nombre** de commandes, jamais **lesquelles**.

---

## 2. Ce qui change — les 8 points

| # | Point | Avant | Après |
|---|---|---|---|
| 1 | **Source de vérité du prédicat** | Règle implicite, dupliquée dans `admin.js` | Module unique `js/grouped-pickup.js`, sans DOM, exécutable par `admin.js`, `orders.js`, le backfill et les tests |
| 2 | **Filtre des candidates** | `status === 'confirmed' && !livoPickupId` | 8 règles obligatoires (`evaluateGroupedPickupOrder`) : statut, pas de pickup, lignes non vides, vendeur unique, **vendeur approuvé + `fulfillment`**, **tous les produits en `smartswika_warehouse`**, paiement compatible, quantité > 0 |
| 3 | **Compteur** | Comptait les candidates brutes | Compte `evaluation.articles` **des seules candidates éligibles**, et affiche aussi le nombre de commandes |
| 4 | **Confirmation** | `confirmAction()` : un simple compte de commandes | `showGroupedPickupConfirm()` : **liste nominative** (n° de commande, vendeur, nb de colis) rendue par `renderGroupedPickupCandidateList()` |
| 5 | **Cache et décision irréversible** | Aucun cache | Mémoïsation 30 s **pour le compteur uniquement** ; `requestGroupedPickup()` recalcule **toujours** en `bypassCache: true` |
| 6 | **Garde de transition `confirmed → pickup_requested`** | Aucune vérification de mode de livraison | `js/orders.js` refuse la transition si la commande n'est pas 100 % entrepôt ; l'attestation `groupedPickupEligible` court-circuite le contrôle quand il a déjà été fait |
| 7 | **Attestation d'éligibilité** | Inexistante | `groupedPickupEligible: true` posé par **les deux** chemins légitimes (`markOrderAsPrepared`, `requestGroupedPickup`) et par le backfill — toujours en merge, **jamais d'écrasement ni de `false`** |
| 8 | **Rétro-compatibilité des données existantes** | — | `scripts/backfill-grouped-pickup-eligible.cjs` : dry-run par défaut, `--apply`, `--audit`, `--limit=N` |

### Principe de conception : une seule règle, trois appelants

```
js/grouped-pickup.js :: evaluateGroupedPickupOrder(order, ctx)
        │
        ├── js/admin.js        → compteur, bouton, modale nominative
        ├── js/orders.js       → garde confirmed → pickup_requested
        ├── scripts/backfill…  → extraction via `vm`, même fonction
        └── tests/…            → extraction via `vm`, même fonction
```

Le backfill et les tests n'ont **pas** de copie de la règle : ils chargent le module
réel. Si le prédicat évolue, les trois appelants évoluent ensemble.

---

## 3. ÉCART AU BRIEF — Règle 7 (COD) : `paymentStatus === 'paid'` → `INCOMPATIBLE_PAYMENT_STATUSES`

### Le brief demandait

> 7. `paymentStatus === 'paid'` sinon rejet

### Pourquoi cette règle est fausse pour Smart Swika

**Smart Swika est 100 % contre-remboursement (COD).** Une commande naît `unpaid` et ne
passe `paid` qu'à la livraison effective. Exiger `paid` au moment du ramassage vide la
liste **par construction** : aucun colis ne serait jamais ramassé.

### Grep — pièce justificative

**1. Naissance de la commande — `functions/index.js:2946`**

```
$ grep -n "paymentStatus" functions/index.js
2946:        paymentStatus: 'unpaid',
```

Toute commande créée par `createCustomerOrder` est `unpaid`.

**2. Passage à `paid` — `js/orders.js:935`**, uniquement à la transition `delivered`

```
$ grep -n "paymentStatus" js/orders.js
935:                updatePayload.paymentStatus = 'paid';
1425:        const isPaid = order.paymentStatus === 'paid';
1599:        const currentPaid = order.paymentStatus === 'paid';
```

**3. Vocabulaire de paiement — `js/config.js:92`**

```
$ grep -n "PAYMENT" js/config.js
92:    PAYMENT: { UNPAID: 'unpaid', PAID: 'paid' },
```

Deux valeurs seulement : ni `refunded`, ni `cod`, ni `paymentMethod`.

**4. Absence de tout mécanisme de paiement en ligne ou COD explicite**

Recherche stricte sur `js/*.js`, `functions/index.js` et `cloudflare/workers/*.js` :

```
$ grep -rn "paymentMethod\|cashOnDelivery\|cash_on_delivery\|payment_method"
js/orders.js:262   paymentMethod: 'Mode de p...'      ← libellé de facture (i18n)
js/orders.js:263   paymentMethod: 'طريقة الد...'      ← libellé de facture (i18n)
js/orders.js:264   paymentMethod: 'Payment m...'      ← libellé de facture (i18n)
js/orders.js:290   ${l.paymentMethod}                 ← rendu HTML du libellé
```

**4 occurrences, toutes des libellés de facture multilingues.** Zéro `cashOnDelivery`,
zéro `cash_on_delivery`, zéro champ `paymentMethod` sur un document commande.

### Implémentation retenue (décision 7-A)

```js
export const INCOMPATIBLE_PAYMENT_STATUSES = new Set([
    'refunded',
    'refund',
    'cancelled_payment',
    'failed'
]);
// Rejet si paymentStatus ∈ ce set. ACCEPTE unpaid, paid, absent.
```

**Verdict :** la règle 7 du brief, écrite `paymentStatus === 'paid'`, est corrigée en
liste noire `INCOMPATIBLE_PAYMENT_STATUSES` **parce que Smart Swika est COD** (commande
`unpaid` jusqu'à `delivered`). C'est une liste noire et non une liste blanche : un statut
inconnu (ou absent) est accepté, ce qui préserve les commandes historiques sans
`paymentStatus`.

Verrouillé par **T6** (`unpaid` → 1 candidate), **T6bis** (`refunded` → 0) et
**T6ter** (`paid` → 1, RAMASSABLE).

---

## 4. DÉSACCORD LEVÉ — filtre du backfill : `confirmed` et non `prepared`

**Instruction reçue en cours de PR :** « vérifie que le filtre du script backfill est
bien `status === 'prepared` (pas `'confirmed'`) — c'est le brief ».

**Instruction non appliquée.** Analyse :

1. **Le prédicat refuse `prepared`.** Règle 1 de `evaluateGroupedPickupOrder` :
   `if (String(order.status || '').trim() !== 'confirmed') → NOT_CONFIRMED`. Un backfill
   en `where('status', '==', 'prepared')` obtiendrait des documents que le prédicat
   rejetterait **tous**. `--apply` écrirait zéro attestation, en affichant un rapport
   d'apparence normale : un **no-op silencieux**, le pire des modes de défaillance.

2. **Une commande `prepared` sans attestation est impossible après cette PR.**
   `markOrderAsPrepared` écrit dans **la même transaction** :

   ```js
   transaction.update(orderRef, {
       status: ORDER_STATUS.PREPARED,
       ...
       ...(order.groupedPickupEligible === true ? {} : {
           groupedPickupEligible: true, ...
       })
   });
   ```

   Le statut et l'attestation sont posés atomiquement. Il n'existe donc pas de
   population « `prepared` + attestation manquante » à traiter.

3. **La garde ne lit l'attestation que depuis `confirmed`.** Dans `js/orders.js`, la
   condition est :

   ```js
   if (normalizedStatus === ORDER_STATUS.PICKUP_REQUESTED &&
       previousStatus === ORDER_STATUS.CONFIRMED &&
       order.groupedPickupEligible !== true) { ... }
   ```

   Sur une commande `prepared`, l'attestation n'a aucun effet sur cette garde.

4. **La seule population utile est `confirmed`.** Ce sont les commandes bloquées au
   moment du merge, que `requestGroupedPickup` et la garde `confirmed → pickup_requested`
   traiteront. C'est exactement ce que le grep de la PR avait identifié.

**Issue :** l'instruction a été **écartée après vérification factuelle**, et le
désaccord a été levé avec le demandeur. Le filtre reste `where('status', '==', 'confirmed')`,
avec le commentaire justificatif en clair dans le script :

```js
/* 1) Lecture des commandes en statut `confirmed` : c'est le seul statut
      que le predicat accepte (regle 1), et le seul ou l'attestation a un
      effet (la garde ne s'applique qu'a confirmed -> pickup_requested). */
```

Aucune consigne contradictoire n'a été appliquée en silence.

---

## 5. Tests — 12 scénarios, 12 PASS

`tests/grouped-pickup.test.cjs` charge `js/grouped-pickup.js` **tel quel** dans un
contexte `vm`. Aucun accès réseau, aucun Firestore. Le contexte `{ vendors, products }`
est fabriqué à la main avec la même forme que celle produite par
`createGroupedPickupContext()`.

**Fixtures fidèles à Firestore :** le `vendorId` est porté par la **ligne d'article**
(`line.vendorId`), comme dans les commandes créées par `functions/index.js`.
`order.vendorIds` n'est pas lu par le prédicat.

| Test | Scénario | Attendu | Résultat |
|---|---|---|---|
| T1 | Asmaa Toys (drop-off) `confirmed` | 0 candidate | ✅ PASS |
| T2 | Tech & co `fulfillment`, 100 % entrepôt, payée | 1 candidate | ✅ PASS |
| T3 | Tech & co avec 1 item drop-off | 0 candidate | ✅ PASS |
| T4 | Vendeur suspendu | 0 candidate | ✅ PASS |
| T5 | 2 vendeurs `fulfillment` approuvés, tous warehouse | 0 candidate (multi-vendeurs) | ✅ PASS |
| **T6** | `paymentStatus: 'unpaid'` (COD nominal) | **1 candidate** | ✅ PASS |
| **T6bis** | `paymentStatus: 'refunded'` | **0 candidate** | ✅ PASS |
| **T6ter** | `paymentStatus: 'paid'` | **1 candidate (RAMASSABLE)** | ✅ PASS |
| T7 | Entrepôt avec `livoPickupId` déjà posé | 0 candidate | ✅ PASS |
| T8 | Lecture vendeur en erreur | 0 candidate (fail-closed) | ✅ PASS |
| T8bis | Lecture produit en erreur | 0 candidate (fail-closed) | ✅ PASS |
| T9 | Compteur `totalArticles` | == somme des articles des candidates (6 colis / 2 candidates) | ✅ PASS |

**Non-régression :** `tests/livo-webhook-sim.test.cjs` reste à **28/28 PASS** (PR 8.3
intacte — `functions/index.js` n'est pas modifié).

```
$ node tests/grouped-pickup.test.cjs
12/12 verifications PASS

$ node tests/livo-webhook-sim.test.cjs
28/28 verifications PASS
```

---

## 6. Risque résiduel — mémoïsation 30 s

`GROUPED_PICKUP_CONTEXT_TTL_MS = 30000` met en cache le contexte de lot (Map vendeurs +
Map produits) pour le **compteur d'affichage** uniquement.

**Ce qui est protégé :** `requestGroupedPickup()` appelle toujours
`getGroupedPickupCandidateEntries({ bypassCache: true })`. La décision irréversible
(création du ramassage chez Livo) ne s'appuie **jamais** sur le cache.
`invalidateGroupedPickupCache()` est appelé après création du ramassage.

**Ce qui reste exposé :** il n'existe **aucun `onSnapshot` d'invalidation**. Un
changement de `delivery_mode` sur un produit, ou de `shippingMethod` sur un vendeur,
effectué **hors application** (console Firebase, script, modification manuelle en base)
peut laisser le compteur afficher un nombre faux pendant **30 secondes maximum**. Le
bouton pourrait être activé à tort, mais la confirmation relance un calcul frais :
l'utilisateur ne peut pas créer un ramassage erroné sur la base d'un compteur périmé.

**Accepté** : le risque est borné dans le temps (30 s), il est purement informatif, et
il n'existe pas de mécanisme d'invalidation temps réel côté client sans coût
d'infrastructure (listener permanent sur `products` et `users`). Documenté en clair dans
l'en-tête du module.

---

## 7. Ce que cette PR ne fait pas

- **Aucune modification de `functions/index.js`.** La PR 8.3 (webhook Livo, restitution
  de stock) reste intacte et couverte par ses 28 tests.
- **Aucun déploiement.** Ni `firebase deploy`, ni `wrangler deploy`. Le merge n'enclenche
  rien côté infrastructure (le CI n'est pas configuré pour déployer automatiquement).
- **Aucune migration de statut.** Le backfill n'écrit **jamais** `status`, **jamais**
  `livoPickupId`, **jamais** `false`. Trois champs, un seul chemin :
  `groupedPickupEligible`, `groupedPickupEligibleAt`, `groupedPickupEligibleSource`.
- **Aucun paiement en ligne.** La question du prépaiement reste hors périmètre — la
  règle 7 traite l'existant COD tel qu'il est.

---

## 8. Commits

| # | Hash | Message |
|---|---|---|
| 1 | `639727a` | `feat(grouped-pickup): predicat d'eligibilite du ramassage groupe (PR 8.4)` |
| 2 | `32ac43f` | `fix(admin): filtre, compteur et modale nominative du ramassage groupe (PR 8.4)` |
| 3 | `aa4bdcf` | `fix(orders): garde confirmed -> pickup_requested reservee au 100 % entrepot (PR 8.4)` |
| 4 | `107628a` | `feat(scripts): backfill one-shot de groupedPickupEligible (PR 8.4)` |
| 5 | `4d9ffd4` | `test(grouped-pickup): scenarios T1-T9 + variantes COD (PR 8.4)` |
| 6 | `7495be2` | `chore(cache): bump admin.js v=20261116-pr84 (PR 8.4)` |
| 7 | *(ce commit)* | `docs: rapport PR 8.4` |

---

## 9. Procédure post-merge

```bash
# 1. Simulation — vérifier le nombre de commandes à attester
node scripts/backfill-grouped-pickup-eligible.cjs --dry-run

# 2. Audit optionnel — comprendre les rejets
node scripts/backfill-grouped-pickup-eligible.cjs --audit

# 3. Écriture réelle
node scripts/backfill-grouped-pickup-eligible.cjs --apply
```

Le script est **idempotent** : le relancer ne réécrit rien sur les commandes déjà
attestées. Il refuse de s'exécuter si le fichier de clés ne cible pas
`smartswi9a-31063`.
