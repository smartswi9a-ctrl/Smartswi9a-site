# Rapport PR 8.6 — Workflow transit `confirmed -> in_transit` + legacy `shipping` remappe

| Champ | Valeur |
|---|---|
| Branche | `feat/pr-8.6-workflow-transit` |
| Base | `main` @ `f22a07b` (PR 8.5 mergee) |
| Type | Dette technique 8.6 (dette documentee dans `docs/RAPPORT-PR-8.5.md`) |
| Deploiement | **Aucun deploiement manuel requis.** |
| `functions/index.js` | **Non touche** (regle de fer absolue) |

## Commits

| Commit | Etape | Contenu | Fichiers |
|---|---|---|---|
| `77be55c` | **C1** | D1 + D4 + D2 | `js/orders.js`, `js/config.js`, `admin.html` |
| `0db9921` | **C2** | D3 (tests adaptes) | `tests/livo-sync.test.cjs` |
| `<hash C3>` | **C3** | D5 (ce rapport) | `docs/RAPPORT-PR-8.6.md` |

---

## C1 — D1 + D2 + D4 (code + cache-buster groupes)

Trois dettes traitees dans **un seul commit**, volontairement groupees : le cache-buster
doit partir avec les changements de `orders.js` et `config.js`, sinon il ne protege rien.

### D1 — `ALLOWED_TRANSITIONS` : ouverture `confirmed -> in_transit`

**Fichier** : `js/orders.js` — table `ALLOWED_TRANSITIONS` (l.580).

`ORDER_STATUS.IN_TRANSIT` est ajoute au tableau de `ORDER_STATUS.CONFIRMED`.
Aucune autre cle de la table n'est modifiee.

```js
[ORDER_STATUS.CONFIRMED]: [
    ORDER_STATUS.PREPARING,          /* mode entrepot */
    ORDER_STATUS.PICKUP_REQUESTED,   /* dropoff */
    ORDER_STATUS.SHIPPING,           /* LEGACY : ancien flux direct */
    ORDER_STATUS.IN_TRANSIT,         /* PR 8.6 : sync Livo direct (confirmed -> in progress) */
    ORDER_STATUS.CANCELLED
],
```

**Justification** (deja actee comme dette 8.6 en PR 8.5) : `shipping -> in_transit` etait
deja autorise (`ALLOWED_TRANSITIONS[SHIPPING]` contient `IN_TRANSIT`). L'ancien mapping
permettait donc ce saut **par proxy** via `shipping`. Sans cette ouverture, une commande
`confirmed` dont Livo annonce `in progress` restait bloquee a `confirmed` et echouait a
chaque synchronisation (`transitionBlocked`). On supprime un contournement, on n'assouplit
pas le cycle metier.

### D2 — `normalizeOrderStatus` : legacy `shipping -> in_transit`

**Fichier** : `js/config.js` — `STATUS_MIGRATION_MAP` (~l.325).

```js
export const STATUS_MIGRATION_MAP = { 'validated': 'confirmed', 'received': 'delivered', 'shipping': 'in_transit' };
```

Les deux remappages historiques (`validated -> confirmed`, `received -> delivered`) sont
conserves. Le nouveau remappage fait qu'une commande encore stockee en `shipping` est
**lue** `in_transit` par `normalizeOrderStatus()`.

### D4 — Cache-buster (CRITIQUE)

**Fichier** : `admin.html`, **lignes 36 et 1110**.

```diff
-  /js/admin.js?v=20261116-pr84
+  /js/admin.js?v=20261116-pr86
```

**Justification** : `admin.js` importe `orders.js` **sans query string**.
`config.js` est egalement importe sans query string par `admin`, `orders` et
`vendor-dashboard`. Sans bump, le navigateur continue de servir l'ancien `orders.js`
pendant **1 heure** (`max-age=3600`) alors que `admin.js` est, lui, rafraichi : c'est
exactement le bug vecu en 8.4. Le bump est **obligatoire** et doit etre dans le meme
commit que D1/D2, sinon `admin.js` pointe sur un vieux `orders.js`.

---

## C2 — D3 (tests adaptes)

**Fichier** : `tests/livo-sync.test.cjs` uniquement.

| Test | Adaptation |
|---|---|
| **T8** | Legacy `shipping` + Livo `in progress` : `updated:false`, **aucune ecriture de statut**, extras (`livoStatusRaw`) traces. Devient le test de bout en bout de D2. |
| **T8bis** | Test **unitaire** de `normalizeOrderStatus` : `shipping -> in_transit`, remappages historiques intacts, statuts courants non remappes, valeurs falsy -> `pending`. |
| **T9** | `confirmed` + `in progress` -> `updated:true`, `newStatus:'in_transit'`, ecriture de statut + extras tracee. **Exigence metier directe de D1.** |
| **T9bis** | 5 cas : (1) `confirmed -> in_transit` **accepte** (D1) ; (2) `shipping -> in_transit` = **no-op** post-D2, aucune ecriture ; (3) `delivered -> in_transit` **refuse** (terminal) ; (4) `pending -> delivered` **refuse** (anti-credit vendeur) ; (5) `confirmed -> pickup_requested` reste **conforme** a la table (un refus eventuel vient de l'eligibilite entrepot PR 8.4, pas de `ALLOWED_TRANSITIONS`). |
| **T1–T7, T10** | Inchanges. |

**Resultats** :

```
tests/livo-sync.test.cjs        12/12 PASS
tests/livo-compliance.test.cjs   5/5 PASS
tests/grouped-pickup.test.cjs   12/12 PASS
```

---

## CRITIQUE — D2 ne migre PAS la donnee

> **D2 est un remappage a la lecture, pas une migration de donnees.**
> `normalizeOrderStatus()` **masque** la valeur `shipping` au moment de la lecture.
> Aucune ecriture Firestore n'est produite par D2.

Consequences explicites, a connaitre avant toute exploitation :

**(a)** Une commande legacy stockee en `shipping` **reste `shipping` en base Firestore
indefiniment**. Le remappage n'existe qu'en memoire, a chaque lecture. Un export brut,
une requete Firestore ou un consommateur qui ne passe pas par `normalizeOrderStatus()`
verra toujours `shipping`.

**(b)** Un admin qui clique **Sync** sur une telle commande obtient `updated:false`,
`livoStatusRaw` trace dans les extras, et un **statut inchange**. Cote metier c'est
coherent : l'ordre est deja considere `in_transit` a la lecture, il n'y a rien a
re-ecrire. Cela peut surprendre en lecture rapide de l'ecran admin — ce n'est pas une
panne.

**(c)** **Aucune migration de donnees n'est faite en 8.6.** Si une vraie normalisation
des valeurs stockees est souhaitee, c'est une **PR 8.7 dediee**, avec un script one-shot
de type *backfill* (lecture de toutes les commandes `shipping`, ecriture de `in_transit`,
idempotent, journalise). Ce n'est **pas** code ici et ne doit pas etre improvise dans
cette branche.

---

## Deploiement

> **Aucun deploiement manuel requis. Aucune modification de `functions/index.js`.**

Le changement est **front-only** : `js/orders.js`, `js/config.js`, `admin.html` et le
fichier de tests. Aucune Cloud Function, aucune regle Firestore, aucun index.

---

## Purge Cloudflare post-merge

> **Purge Cloudflare OBLIGATOIRE post-merge.**

`admin.html` est bumpe (`?v=20261116-pr86`) et `js/orders.js` / `js/config.js` sont
modifies. Or `config.js` est importe **sans query string** par `admin`, `orders` et
`vendor-dashboard`, et `orders.js` est importe **sans query string** par `admin.js`.
Sans purge, le cache CDN peut continuer de servir les anciennes versions de `orders.js`
et `config.js` evenements apres le merge — le bump de `admin.html` ne protege que
`admin.js`.

A purger : `/js/orders.js`, `/js/config.js`, `/js/admin.js`, `/admin.html`.

---

## Dette 8.6 — statut

Reference close : **dette 8.6**, documentee dans [`docs/RAPPORT-PR-8.5.md`](./RAPPORT-PR-8.5.md).
Les points D1 (ouverture `confirmed -> in_transit`), D2 (remappage legacy `shipping`),
D3 (tests) et D4 (cache-buster) sont traites par cette PR. **Dette 8.6 close.**

Reste ouvert, hors perimetre et volontairement non traite : la **migration physique** des
valeurs `shipping` en base (voir section CRITIQUE point (c)) — candidate PR 8.7.
