# Runbook — Monitoring post-lancement

> **Objet** : surveiller les **5 réserves terrain** de la mise en production
> Smart Swika (wallet vendeur, webhook Livo, commandes) et détecter les
> anomalies **avant** qu'elles ne deviennent des litiges ouverts.
>
> **Public** : mainteneur / astreinte. Exécutable seul, sans contexte préalable.
>
> **Prérequis outillage** : `firebase` CLI connecté (projet
> `smartswi9a-31063`), `gcloud` **absent** du `PATH` — ne pas l'utiliser.

---

## 0. Accès aux logs

Le shell est **`cmd.exe`** : pas de `for`, `head`, `sed`, `;`, `$()`.
Enchaîner avec `&&`. Filtrage avec `findstr`.

| Besoin | Commande |
|---|---|
| Logs webhook Livo | `firebase functions:log --only livoWebhook --project smartswi9a-31063` |
| Logs déblocage wallet | `firebase functions:log --only releaseDueFunds --project smartswi9a-31063` |
| Logs retrait vendeur | `firebase functions:log --only requestWithdrawal --project smartswi9a-31063` |
| Logs commande client | `firebase functions:log --only createCustomerOrder --project smartswi9a-31063` |
| Logs création/annulation colis | `firebase functions:log --only createLivoShipment --project smartswi9a-31063` |
| Tout | `firebase functions:log --project smartswi9a-31063` |
| Filtrer les erreurs | `... \| findstr /i /c:"error" /c:"401" /c:"429" /c:"500"` |
| Filtrer les fallbacks | `firebase functions:log --project smartswi9a-31063 \| findstr /i /c:"Fallback createdAt"` |

**Complément côté Livo** (spec `docs/api/api-entrepôt-livo.json`) :
`GET /client_webhooks/me/logs` liste les derniers envois **avec la réponse
renvoyée par notre serveur** — source de vérité la plus directe pour savoir
si Livo reçoit des `4xx`.

---

## 1. Les 5 réserves terrain

Chacune doit être **observée au moins une fois en réel** avant de considérer
la mise en production comme stabilisée.

### R1 — Premier `duplicate_target`

**Origine** : réponse `400` de l'API Livo, `data.data.type = "prompt"`,
`confirm_text = "duplicate_target"` (cf. `docs/RAPPORT-CLOTURE-2026-11-12.md`
§PR #11). Signifie qu'un colis existe déjà pour ce `target` et que Livo
demande une confirmation explicite.

**Pourquoi c'est une réserve** : le chemin `prompt` → modale `confirmAction`
→ relance avec `confirm_text` est le correctif le plus récent et le plus
complexe. Il n'a **jamais** tourné en production.

| Point | Attendu |
|---|---|
| Déclencheur | Envoi d'une commande vers un `target` déjà connu |
| Log attendu | `[Livo] duplicate_target` (ou message de prompt équivalent) |
| Comportement attendu | Modale de confirmation affichée, **pas** de colis dupliqué, relance avec `confirm_text` → `201` |
| Échec caractéristique | Message générique « HTTP 400 », ou `confirm_text` silencieusement supprimé par le Worker |
| Fréquence | À provoquer **une fois** en test dès le jour 1 |

### R2 — Premier `429` (rate limit Livo)

**Origine** : Livo limite les appels. La réponse porte `Retry-After`.

**Pourquoi c'est une réserve** : deux correctifs successifs (#11 puis #12)
ont été nécessaires. Le premier réinjectait l'en-tête dans le Worker, le
second — sans lequel le premier était **inerte** — branchait réellement
`fetchWithRetryResponse` sur les 4 appels Livo.

| Point | Attendu |
|---|---|
| Déclencheur | Rafale de créations/annulations de colis |
| Log attendu | statut `429`, puis reprise |
| Comportement attendu | Attente **conforme à `Retry-After`** (plafond 60 s), puis succès ; en-tête exposé au navigateur (`Access-Control-Expose-Headers`) |
| Échec caractéristique | Backoff fixe 1 s → nouvelle vague de `429` ; ou `Retry-After` invisible côté client |
| Fréquence | Opportuniste ; à provoquer en test de charge léger |

### R3 — Premier crédit vendeur (déblocage wallet)

**Origine** : `releaseDueFunds` débloque les fonds 15 j (article Smart Swika)
ou 7 j après `trackingStartedAt`.

**Pourquoi c'est une réserve** : c'est le **cœur métier**. Une date d'ancre
erronée signifie soit un vendeur payé trop tôt, soit un vendeur bloqué à tort.

| Point | Attendu |
|---|---|
| Déclencheur | Première commande livrée dont le délai est écoulé |
| Log attendu | crédit de la `wallet_transactions` type `sale` |
| Comportement attendu | `unlockAt` posé par **`trackingStartedAt`** (+ 7 ou 15 j), jamais par la date de commande |
| Échec caractéristique | `unlockAt` calculé sur `createdAt` → crédit trop tôt |
| Vérification | Lire 2 ou 3 `wallet_transactions` récentes et comparer `unlockAt` à `trackingStartedAt` |

### R4 — Premier retrait vendeur

**Origine** : `requestWithdrawal` — demande de retrait par un vendeur.

**Pourquoi c'est une réserve** : premier mouvement d'argent **sortant** du
système. Implique solde disponible, statut de paie et validation admin
(`adminPayoutAction`).

| Point | Attendu |
|---|---|
| Déclencheur | Un vendeur demande un retrait |
| Log attendu | création de la demande + génération `payouts` |
| Comportement attendu | Solde **gelé** au moment de la demande, montant ≤ solde disponible, statut `pending` |
| Échec caractéristique | Double débit, retrait d'un solde déjà demandé, montant négatif |
| Vérification | Comparer solde avant/après ; rejouer mentalement une 2ᵉ demande pour vérifier le gel |

### R5 — Warnings `Fallback createdAt`

**Origine** : `resolveCreditUnlockBase` — quand `trackingStartedAt` est absent,
le calcul se rabat sur `createdAt` puis `updatedAt` (couvert par le test
`17/17` : « resolveCreditUnlockBase : fallback createdAt puis updatedAt si
trackingStartedAt absent »).

**Pourquoi c'est une réserve** : un fallback **isolé** est normal (commande
antérieure au webhook). Un volume de fallbacks **croissant** signifie que le
webhook ne pose plus `trackingStartedAt` → **dérive silencieuse** du cron.

| Point | Attendu |
|---|---|
| Déclencheur | Commande sans `trackingStartedAt` arrivant à échéance |
| Log attendu | `Fallback createdAt` |
| Comportement attendu | Volume **stable et faible**, non croissant dans le temps |
| Échec caractéristique | Augmentation semaine après semaine → le webhook ne pose plus l'ancre |
| Action si dérive | Vérifier les statuts `pending` / `in progress` dans `livo_webhook_events` |

---

## 2. Métriques à relever (journal de bord)

Relever ces chiffres **chaque jour** pendant la première semaine, puis une
fois par semaine. Consigner dans un tableau hors dépôt.

| Métrique | Source | Seuil d'alerte |
|---|---|---|
| `401` webhook | `functions:log --only livoWebhook` | **> 0** (hors fenêtre de rotation) |
| `500` webhook | idem | **> 0** |
| `400` webhook | idem | suspect si > quelques unités / jour |
| `duplicate: true` | logs + `livo_webhook_events` | normal en faible volume |
| `unmatched` | idem | surveiller la **tendance** |
| `429` Livo | logs des fonctions appelantes | > 0 résiduel |
| Fallbacks `createdAt` | `findstr /i /c:"Fallback createdAt"` | tendance **croissante** |
| Crédits wallet / jour | `releaseDueFunds` | 0 pendant > 48 h → suspect |
| Retraits / jour | `requestWithdrawal` | pic anormal |
| Webhook Livo `active` | `GET /client_webhooks/me` | **`false`** = incident |

> 💡 Astuce `cmd.exe` : `command | findstr /c:"401"` fonctionne ;
> `findstr /v` pour exclure. Éviter les regex complexes dans le shell —
> les faire dans un script Node si besoin.

---

## 3. Six scénarios de test manuels

À exécuter au moins une fois **avant** de déclarer la mise en production
stabilisée. Chacun cible une réserve ou une zone à fort risque.

### S1 — `ping` Livo signé (santé du webhook)

- **Action** : bouton « Tester » du portail, ou `POST /client_webhooks/me/test`.
- **Attendu** : `200`, corps `{ success: true, duplicate: false }`
  (`ping` → `unmatched`, normal).
- **Échec** : `401` → secret désynchronisé ; `500` → secret absent.

### S2 — Rejeu d'un webhook (idempotence)

- **Action** : renvoyer depuis le portail le **même** `X-Livo-Delivery` déjà reçu.
- **Attendu** : `200` avec `duplicate: true`, commande **inchangée**.
- **Échec** : deux `livo_webhook_events`, ou statut modifié une 2ᵉ fois.

### S3 — Cycle de statut complet (ancre chrono)

- **Action** : faire passer une commande de test `pending` → `in progress`
  → `delivered` via des événements Livo.
- **Attendu** : `trackingStartedAt` posé au **premier** état de tracking et
  **jamais repoussé** ; `status` suit `pending→confirmed`, `in progress→shipping`,
  `delivered→delivered`.
- **Échec** : `trackingStartedAt` absent, ou déplacé après un aller-retour.

### S4 — `duplicate_target` (R1)

- **Action** : envoyer une commande vers un `target` déjà utilisé.
- **Attendu** : prompt affiché → confirmation → relance avec `confirm_text` → `201`.
- **Échec** : message générique, double colis, ou blocage.

### S5 — Retrait vendeur complet (R4)

- **Action** : vendeur avec solde disponible demandant un retrait ; puis 2ᵉ
  demande immédiate du même montant.
- **Attendu** : 1ʳᵉ demande acceptée + solde gelé ; 2ᵉ demande **refusée**
  (solde déjà engagé).
- **Échec** : solde négatif, ou double demande acceptée.

### S6 — Commande non liée (webhook `unmatched`)

- **Action** : simuler un événement valide pour un `order_id` **inconnu**.
- **Attendu** : `200 unmatched`, **aucune** modification Firestore, l'événement
  est journalisé pour audit.
- **Échec** : `500`, ou création/modification d'une commande par erreur.

---

## 4. Fréquence de surveillance

| Période | Cadence | Actions minimales |
|---|---|---|
| **Jour 1** | Toutes les 2 h (en heures ouvrées) | Logs `livoWebhook` + `releaseDueFunds` ; `401` = 0 ; S1 exécuté ; webhook `active: true` |
| **Semaine 1** | 1 × / jour, même heure | Tableau §2 complet ; surveiller les **fallbacks** en tendance ; surveiller les `429` |
| **Mois 1** | 1 × / semaine | Tableau §2 ; vérifier échantillon de crédits wallet (R3) ; vérifier retraits (R4) |
| **Mensuel** | 1 × / mois | Tableau §2 ; calendrier de rotation du secret (§6 du runbook de rotation) ; relecture des runbooks |

**Critères de sortie de la surveillance rapprochée** :

- 7 jours consécutifs avec `401 = 0` et `500 = 0`.
- Les 5 réserves R1–R5 **observées en réel** au moins une fois.
- Aucune tendance à la hausse des fallbacks `createdAt`.
- Au moins un crédit vendeur et un retrait vendeur comptabilisés et vérifiés.

---

## 5. Réactions rapides

| Symptôme | Diagnostic | Action |
|---|---|---|
| `401` en série sur `livoWebhook` | Secret désynchronisé | → **Runbook rotation**, §5 rollback |
| Webhook `inactive` côté Livo | 50 échecs consécutifs | Réactiver `active: true`, puis rotation |
| `500` + `LIVO_WEBHOOK_SECRET absent` | Secret non monté | `functions:secrets:get` puis redéploiement |
| Fallbacks en hausse | Le webhook ne pose plus `trackingStartedAt` | Vérifier `livo_webhook_events` et le mapping de statut |
| `429` persistants | Volume trop élevé | Vérifier que `Retry-After` est bien respecté (R2) |
| 0 crédit depuis 48 h | Cron bloqué ou aucune échéance | `functions:log --only releaseDueFunds` |

---

## 6. Lien avec la rotation du secret

La **R5** (fallbacks) et les **`401`** sont les deux signaux qui déclenchent
le runbook de rotation `docs/runbooks/ROTATION-SECRET-LIVO.md`. Après toute
rotation, la **checklist post-rotation sur 24 h** de ce runbook-là s'applique
et complète la présente surveillance.
