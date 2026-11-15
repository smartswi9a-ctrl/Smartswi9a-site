# Contrat webhook Livo — Smart Swika (PR 8.3)

> **Objet** : documenter la réception des événements Livo, le mapping des
> statuts vers `ORDER_STATUS`, la configuration des secrets et les points de
> déploiement manuels.
>
> **Périmètre** : `functions/index.js` (`exports.livoWebhook`),
> `cloudflare/workers/livo-proxy.js`, `cloudflare/workers/smart-swi9a-api.js`.
>
> **Ce fichier ne contient AUCUN secret réel.** Les valeurs sont toujours des
> placeholders. Voir `docs/runbooks/ROTATION-SECRET-LIVO.md` pour la rotation.

---

## 1. Architecture de réception

Livo envoie ses événements à la Cloud Function `livoWebhook`
(`europe-west1`), **pas** directement au Worker Cloudflare.

```
Livo  ──POST──►  https://smartswika.ma/api/livoWebhook
                        │
                        ▼
              Worker smart-swi9a-api.js   (passe-plat, ALLOWED_FUNCTIONS)
                        │
                        ▼
              Cloud Function livoWebhook  (europe-west1)
                        │
                        ▼
              Firestore : orders/ + livo_webhook_events/
```

**Prérequis bloquant** : `livoWebhook` doit figurer dans `ALLOWED_FUNCTIONS`
de `cloudflare/workers/smart-swi9a-api.js`. Sans cette entrée, le proxy
renvoie `404` et aucun événement n'atteint la Function.

### Deux Workers distincts — ne pas les confondre

| Worker | Source | Secrets | Rôle |
|---|---|---|---|
| `livo-proxy` | `cloudflare/workers/livo-proxy.js` | `LIVO_ADMIN_UIDS`, `LIVO_API_KEY`, `LIVO_CLIENT_ID` | Appels **sortants** vers l'API Livo |
| `smart-swi9a-api` | `cloudflare/workers/smart-swi9a-api.js` | — | Proxy des Cloud Functions (dont `livoWebhook`) |

> ⚠️ **`livo-proxy.js` n'a pas de configuration `wrangler.toml` dédiée dans le
> dépôt.** Le `wrangler.toml` présent ne déclare que `smart-swi9a-api`. Le
> déploiement de `livo-proxy` est donc **manuel** et doit toujours préciser le
> nom du Worker :
>
> ```powershell
> npx wrangler deploy --name livo-proxy
> npx wrangler secret put LIVO_CLIENT_ID --name livo-proxy
> ```
>
> Un `wrangler deploy` lancé sans `--name` depuis `cloudflare/workers/`
> déploie `smart-swi9a-api`, **pas** `livo-proxy`. Voir
> `docs/runbooks/ROTATION-SECRET-LIVO.md` §« Pourquoi `--name livo-proxy` est
> OBLIGATOIRE ».

---

## 2. Authentification des livraisons

Livo signe chaque livraison. Le récepteur doit vérifier **cumulativement** :

| Contrôle | En-tête / calcul | Échec |
|---|---|---|
| Clé Bearer | `Authorization: Bearer <LIVO_WEBHOOK_SECRET>`, comparaison à temps constant | `401` |
| Anti-replay | `X-Livo-Timestamp` (epoch s) à ±300 s | `401` |
| Signature | `X-Livo-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<corps brut>")` | `401` |
| Secret absent | `defineSecret('LIVO_WEBHOOK_SECRET')` non résolu | `500` |
| Idempotence | `X-Livo-Delivery` (ou `id` du corps) déjà présent dans `livo_webhook_events` | `200 duplicate` |
| Type d'événement | `X-Livo-Event` hors liste blanche | `400` |
| Méthode | ≠ `POST` | `405` |

Le HMAC porte sur le **corps brut**, jamais sur le JSON re-sérialisé. Toute
altération du corps par un intermédiaire casse la signature.

**Familles d'événements** : `orders`, `pickups`, `returns`, `messages`.
Configuration côté Livo : portail client (**Paramètres → Webhook**) ou
`PUT /client_webhooks/me`.

---

## 3. Mapping des statuts Livo → `ORDER_STATUS`

Statuts internes : `pending`, `confirmed`, `preparing`, `prepared`,
`pickup_requested`, `picked_up`, `in_transit`, `delivered`, `returned`,
`cancelled`. `shipping` est **legacy** : il n'est plus jamais produit par le
webhook, seulement toléré en lecture sur les commandes historiques.

### 3.1 `order.status_changed`

| Statut Livo | → `ORDER_STATUS` | Notes |
|---|---|---|
| `draft` | `pending` | Commande non confirmée |
| `pending` | `confirmed` | Enregistrée chez Livo = confirmée côté Smart Swika |
| `programmed` | `confirmed` | Programmée, pas encore prise en charge |
| `awaiting pickup` | `pickup_requested` | **Seule source fiable de `pickup_requested`** côté webhook |
| `awaiting transfer` | `picked_up` | Collectée, en transfert vers l'entrepôt |
| `in progress` | `in_transit` | En circulation — **déclenche `trackingStartedAt`** (voir §4) |
| `fulfilled` | `delivered` | Terminal |
| `problem` | *(inchangé)* | Écrit uniquement `livoStatusRaw = "problem"` ; le statut principal n'est pas écrasé (incident de transport) |
| `cancelled` | `cancelled` | Terminal |
| *(inconnu / absent)* | *(inchangé)* | Événement journalisé, aucun effet |

**Transitions terminales protégées** : `delivered`, `returned`, `cancelled`.
Un événement ultérieur ne peut plus modifier le statut principal.

### 3.2 `order.return_status_changed`

| `return_status` | Action | Statut principal |
|---|---|---|
| `returned-pending` | écrit `livoReturnStatus` | inchangé |
| `returned-started` | écrit `livoReturnStatus` | inchangé |
| `returned-warehouse` | écrit `livoReturnStatus` + **restitution stock** (§5) | inchangé |
| `returned-fully` | écrit `livoReturnStatus` + **restitution stock** (§5) | → `returned` |

### 3.3 Cas ambigus tranchés

| Cas | Décision | Justification |
|---|---|---|
| `pending` → `pending` ou `confirmed` ? | **`confirmed`** | `pending` chez Livo signifie « enregistrée », pas « commandée ». |
| `awaiting pickup` → `confirmed` ou `pickup_requested` ? | **`pickup_requested`** | Sinon `pickup_requested` n'est jamais atteint, l'objectif de 8.3 n'est pas rempli. |
| `awaiting transfer` → `shipping` ou `picked_up` ? | **`picked_up`** | Collecte effectuée, avant circulation. |
| `in progress` → `shipping` ou `in_transit` ? | **`in_transit`** | Aligne le statut interne sur `trackingStartedAt`. |
| `problem` écrase-t-il le statut ? | **Non** | Incident de transport, pas une transition d'état métier. |
| `returned` ré-ouvrable ? | **Non** | Terminal. |
| `shipping` encore produit ? | **Non** | Legacy en lecture uniquement. |

---

## 4. `trackingStartedAt`

**Règle** : posé **une seule fois**, au premier événement dont le statut Livo
est `in progress` (→ `in_transit`).

- **Jamais** posé sur `pickup_requested` : la demande de ramassage n'est pas
  une prise en charge physique.
- **Jamais repoussé** : si le champ existe déjà, il n'est pas réécrit, même
  après un retour en arrière puis un nouveau passage en `in_transit`.
- Ancrage du chrono de déblocage des fonds vendeurs
  (`resolveCreditUnlockBase`). En l'absence du champ, repli documenté sur
  `createdAt` puis `updatedAt`, avec un warning dans les logs.

---

## 5. Restitution du stock (`stock_warehouse`)

Sur `returned-warehouse` et `returned-fully` :

1. Lecture de la commande **dans la transaction**.
2. Si `stockRestituted === true` → **aucune action**, réponse `200 applied:false`.
3. Sinon : incrémentation de `stock_warehouse` pour chaque ligne de
   `order.items`, puis écriture de `stockRestituted: true` **dans la même
   transaction**.

**Double idempotence** :

- par `event_id` (`livo_webhook_events`) — couvre le rejeu d'une même livraison ;
- par `stockRestituted` — couvre **deux événements distincts** pour la même
  commande, que la première barrière ne voit pas.

> ⚠️ L'idempotence par `event_id` seule est insuffisante : Livo peut émettre
> un deuxième événement de retour avec un `id` différent. Sans
> `stockRestituted`, le stock serait incrémenté deux fois.

**Sémantique de `stockRestituted: true`** — « événement retour **traité**,
idempotence scellée ». Ce flag ne signifie **PAS** « du stock a été incrémenté » :
il est posé même lorsque aucun incrément n'a lieu (flags de décrément absents, aucun
produit stocké à l'entrepôt, `returned-fully` sur commande déjà annulée). Sa seule
fonction est d'empêcher qu'un événement ultérieur, porteur d'un `event_id` distinct,
ne retraite la restitution.

---

## 6. Configuration des secrets

Aucun secret ne réside dans le dépôt ni dans `wrangler.toml`.

### 6.1 Réception des webhooks (Firebase)

```cmd
firebase functions:secrets:set LIVO_WEBHOOK_SECRET --project smartswi9a-31063
```

- Valeur générée par nos soins, **≥ 24 caractères** (exigence Livo).
- Sert à la fois de clé Bearer et de clé HMAC.
- Doit être reportée dans le portail Livo via `PUT /client_webhooks/me`.

### 6.2 Appels sortants (Worker `livo-proxy`)

```powershell
npx wrangler secret put LIVO_CLIENT_ID --name livo-proxy
npx wrangler secret put LIVO_API_KEY    --name livo-proxy
npx wrangler secret put LIVO_ADMIN_UIDS --name livo-proxy
```

Vérification :

```powershell
npx wrangler secret list --name livo-proxy
```

Attendu : les trois noms présents. Contrôle croisé — ils ne doivent **pas**
apparaître sur `smart-swi9a-api`.

### 6.3 Activation du webhook côté Livo

```http
PUT /client_webhooks/me
{
  "url": "https://smartswika.ma/api/livoWebhook",
  "secret": "<LIVO_WEBHOOK_SECRET>",
  "events": ["orders", "pickups", "returns", "messages"],
  "active": true
}
```

Puis `POST /client_webhooks/me/test` pour envoyer un événement `ping`.

> ⚠️ Après **50 échecs consécutifs**, Livo désactive le webhook
> automatiquement. `active: true` remet le compteur à zéro. Tester l'endpoint
> **avant** d'activer en production.

---

## 7. Robustesse des appels sortants (`createLivoPickup`)

### 7.1 Garde-fou `client_id`

`livo-proxy.js` lit `env.LIVO_CLIENT_ID` et l'injecte dans le payload
`POST /pickups`. **L'injection est conditionnelle** : si la valeur est absente
ou vide, le champ `client_id` disparaît du payload et Livo rejette la requête
(validation `required`). Le Worker doit donc **échouer explicitement** avant
l'appel :

- `client_id` absent → `500` avec message explicite, **et log serveur**
  mentionnant le nom du secret manquant ;
- ne jamais laisser Livo produire l'erreur à notre place : le message Livo est
  opaque et ne dit pas quel Worker est mal configuré.

### 7.2 `Idempotency-Key` — **NON SUPPORTÉ par Livo**

**Constat vérifié dans le contrat OpenAPI Livo** (`docs/api/api-entrepôt-livo.json`) :

| Élément | Résultat |
|---|---|
| Occurrences de `Idempotency` / `idempotency` / `idempotent` dans le contrat | **0** |
| En-tête `Idempotency-Key` documenté sur `POST /pickups` | **non** |
| `parameters` déclarés sur `POST /pickups` | `[]` |
| Codes d'erreur documentés pour `POST /pickups` | `201`, `400`, `401`, `429` |

Le contrat ne documente **aucun mécanisme d'idempotence** sur la création de
ramassage. Envoyer un `Idempotency-Key` serait au mieux ignoré, au pire rejeté
(`400`, `additionalProperties: false` ne s'applique qu'au corps, mais rien ne
garantit le comportement sur un en-tête inconnu).

### 7.3 Décision : **retry DÉSACTIVÉ**

Conséquence directe de §7.2 : **aucun retry automatique sur
`POST /pickups`**.

- Sans garantie d'idempotence côté Livo, une nouvelle tentative après un
  timeout ambigu (la requête a peut-être abouti) créerait un **ramassage
  en double**.
- Un doublon de ramassage n'est pas réparable par programmation : il faut
  annuler manuellement côté Livo (`DELETE /pickups`).
- Le comportement retenu est donc **fail-fast** : une seule tentative, erreur
  remontée à l'opérateur, qui décide de relancer ou non en connaissance de
  cause.

**Réactivation conditionnelle** : si Livo documente un jour un mécanisme
d'idempotence sur `POST /pickups`, réintroduire un retry borné (3 tentatives,
backoff exponentiel) avec la clé fournie. Tant que ce n'est pas documenté,
**ne pas ajouter de retry**.

### 7.4 Résilience aux erreurs d'authentification

En cas de `401` / `403` **massifs** sur les appels sortants (clé révoquée,
Worker mal configuré, mauvaise cible de secret) :

- ne pas marteler l'API Livo ;
- propager un `503` explicite côté Worker, avec un message qui oriente vers
  `docs/runbooks/ROTATION-SECRET-LIVO.md` ;
- consulter les logs Cloudflare **avant** toute rotation réflexe (une `401`
  n'implique pas une fuite).

---

## 8. Tests

| Commande | Objet |
|---|---|
| `node tests/livo-webhook-sim.test.cjs` | Signature, idempotence, mapping, `trackingStartedAt`, restitution stock |
| `node tests/livo-compliance.test.cjs` | Conformité au contrat Livo (en-têtes, bornes, `Retry-After`) |

Toute modification du mapping ou des règles d'idempotence doit être
accompagnée d'un test dans `tests/livo-webhook-sim.test.cjs`.
