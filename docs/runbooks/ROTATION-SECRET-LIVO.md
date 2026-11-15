# Runbook — Rotation du secret `LIVO_WEBHOOK_SECRET`

> **Objet** : faire tourner la clé Bearer partagée entre **Livo** (émetteur des
> webhooks) et **Smart Swika** (récepteur, Cloud Function `livoWebhook`), sans
> perdre aucun événement.
>
> **Criticité** : 🔴 **ÉLEVÉE**. Une rotation mal ordonnée coupe la
> synchronisation des statuts de commande (tracking, retours), donc le calcul
> des dates de déblocage des wallets vendeurs.
>
> **Dernière relecture** : voir l'historique Git du présent fichier.

---

## 1. Ce que protège ce secret

La fonction `livoWebhook` (`functions/index.js`, export `livoWebhook`,
`europe-west1`) authentifie **chaque** livraison Livo par des contrôles
cumulatifs (refus = `401`) :

| Contrôle | Implémentation | Refus |
|---|---|---|
| En-tête `Authorization` | strictement `Bearer <secret>`, comparaison à temps constant (`crypto.timingSafeEqual`) | `401` |
| Anti-replay | `X-Livo-Timestamp` (epoch s) à ±300 s de l'heure serveur (`LIVO_WEBHOOK_MAX_CLOCK_SKEW_SECONDS`) | `401` |
| Signature | `X-Livo-Signature: sha256=<HMAC-SHA256(secret, timestamp + "." + corps brut)>` | `401` |
| Secret manquant | `defineSecret('LIVO_WEBHOOK_SECRET')` non résolu | `500` |

Le même secret sert donc **à la fois** de clé Bearer et de clé HMAC. Il est
déclaré via `defineSecret` (`functions/index.js` L40) et injecté par Firebase
au déploiement — il n'est **jamais** dans le dépôt.

**Conséquence directe** : le secret côté Firebase et le secret côté portail
Livo doivent être **strictement identiques**. Sinon 100 % des livraisons
échouent et, côté Livo, le webhook est **désactivé automatiquement après
50 échecs consécutifs** (comportement documenté par la spec, cf.
`docs/RAPPORT-CLOTURE-2026-11-12.md` §PR #13).

---

## 2. Prérequis

Avant de commencer, vérifier **tous** les points suivants :

- [ ] `firebase --version` → CLI ≥ 13.
- [ ] `firebase login:list` → compte **`smartswi9a@gmail.com`**.
- [ ] `firebase projects:list` → projet actif **`smartswi9a-31063`**.
- [ ] `node --version` → **v22.x** (aligné sur `.nvmrc`).
- [ ] Accès administrateur au **portail client Livo** (Paramètres → Webhook).
- [ ] Fenêtre de faible activité choisie (pas de pic de livraisons).
- [ ] Ce runbook ouvert dans un onglet séparé.
- [ ] Le shell est **`cmd.exe`** : pas de `for`, `head`, `sed`, `;`, `$()` —
      enchaîner avec `&&` uniquement.

> ⚠️ **`gcloud` n'est pas dans le `PATH`** sur ce poste. Pour les logs,
> utiliser exclusivement : `firebase functions:log --only livoWebhook --project smartswi9a-31063`.

**État de référence à relever avant rotation** (à archiver dans le ticket) :

```cmd
firebase functions:secrets:access LIVO_WEBHOOK_SECRET --project smartswi9a-31063
```

Noter uniquement : préfixe, longueur, date de dernière modification.
**Ne jamais coller le secret en clair dans un ticket, un chat ou un mail.**

---

## 3. ⚠️ ORDRE CRITIQUE — ne pas inverser

L'ordre ci-dessous est **le seul** qui ne crée pas de fenêtre de panne
prolongée. **Le portail Livo doit être mis à jour EN DERNIER.**

```
   (1) Firebase  secrets:set   ──►  (2) Firebase  deploy livoWebhook  ──►  (3) Portail Livo
        nouveau secret              la fonction lit le nouveau            coller le nouveau
                                    secret (encore inutilisé)              secret + test ping
```

**Pourquoi cet ordre ?**

1. `secrets:set` crée une **nouvelle version** du secret. La fonction
   actuellement déployée continue de tourner avec **l'ancienne** version :
   aucune coupure.
2. Le `deploy` de `livoWebhook` monte la dernière version du secret. À partir
   de cet instant, la fonction **rejette l'ancien secret** (`401`). Livo, lui,
   envoie **encore** l'ancien → **fenêtre de panne courte et attendue**.
3. La mise à jour du portail Livo referme la fenêtre immédiatement.

**Ce qu'il ne faut JAMAIS faire :**

- ❌ Mettre à jour le portail Livo **avant** le déploiement → Livo envoie le
  nouveau secret à une fonction qui n'a encore que l'ancien → `401` sur
  **toutes** les livraisons, et **50 échecs consécutifs désactivent le webhook
  chez Livo**. Il faut alors réactiver manuellement (`active: true`) et
  potentiellement rejouer les événements manqués.
- ❌ Faire `secrets:set` puis attendre plusieurs heures avant le `deploy` :
  crée un état « secret à deux vitesses » difficile à diagnostiquer.
- ❌ Lancer un `firebase deploy` **global** (sans `--only`) : risque de
  redéployer les règles Firestore/Storage et l'ensemble des fonctions.

**Durée cible de la fenêtre** : **moins de 5 minutes** entre l'étape 2 et
l'étape 3.

---

## 4. Procédure numérotée

### Étape 1 — Générer le nouveau secret (local, jamais affiché)

```cmd
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- Sortie : **64 caractères hexadécimaux** (32 octets d'entropie).
- Exigence Livo : clé Bearer de **24 caractères minimum** → largement respecté.
- **Ne pas** l'afficher à l'écran, ne pas l'envoyer par chat, ne pas le
  committer. Le conserver uniquement en mémoire / gestionnaire de mots de passe.

### Étape 2 — Écrire le secret dans Firebase (**premier maillon**)

`firebase functions:secrets:set` est **interactif** et attend la valeur sur
`stdin`. Sous `cmd.exe`, le pipe direct est peu fiable : utiliser un script
Node jetable qui `spawn` la CLI et écrit sur son `stdin`.

```cmd
node scripts\_rotate-secret.cjs
```

> Le script jetable doit : générer le secret, spawner
> `firebase functions:secrets:set LIVO_WEBHOOK_SECRET --project smartswi9a-31063`,
> écrire la valeur sur `stdin` suivie de `\n`, puis **supprimer toute trace
> locale** et n'afficher que la longueur / l'empreinte SHA-256 tronquée.

Vérifier ensuite la **nouvelle** version (sans dévoiler la valeur) :

```cmd
firebase functions:secrets:get LIVO_WEBHOOK_SECRET --project smartswi9a-31063
```

Attendu : une nouvelle version listée, `status: ENABLED`, horodatage du jour.

### Étape 3 — Déployer **uniquement** `livoWebhook` (**deuxième maillon**)

```cmd
firebase deploy --only functions:livoWebhook --project smartswi9a-31063
```

- Attendu : `✔ functions[livoWebhook(europe-west1)] Successful update operation.`
- **Ne pas** utiliser `--only functions` (déploierait toutes les fonctions).
- Attendu ensuite : les livraisons Livo reçoivent `401` (fenêtre ouverte).

### Étape 4 — Mettre à jour le **portail Livo** (**troisième et dernier maillon**)

Dans le **portail client Livo** : **Paramètres → Webhook**
(équivalent API : `PUT /client_webhooks/me`, champ `secret`, cf.
`docs/api/api-entrepôt-livo.json`, tag *Webhooks*).

1. Coller le **nouveau** secret dans le champ `secret`.
2. Vérifier que l'URL reste
   `https://europe-west1-smartswi9a-31063.cloudfunctions.net/livoWebhook`
   (ou l'URL `/api/livoWebhook` du domaine, cf. réécriture `firebase.json`).
3. Laisser `active: true` puis enregistrer.
4. Envoyer un **événement de test** signé : bouton « Tester » du portail ou
   `POST /client_webhooks/me/test`. Attendu : `200` avec `duplicate:false`
   ou `applied:false` (type `ping` → `unmatched`, ce qui est **normal**).
5. **Fermer immédiatement** l'onglet / purger le presse-papiers.

### Étape 5 — Vérifier que la fenêtre est refermée

```cmd
firebase functions:log --only livoWebhook --project smartswi9a-31063
```

Attendu dans les minutes qui suivent :

- `200` sur le `ping` de test.
- Reprise des `200` sur les livraisons `order.status_changed`.
- **Aucun** `401` postérieur à l'étape 4.

---

## 5. Rollback d'urgence

**Déclencheur** : persistance de `401` **plus de 15 minutes** après l'étape 4,
ou webhook désactivé côté Livo.

Firebase conserve **les versions de secret pendant 7 jours** : le retour
arrière est mécanique et rapide.

### 5.1 Rollback rapide (< 2 min) — on remet l'ancienne version

```cmd
firebase functions:secrets:versions LIVO_WEBHOOK_SECRET --project smartswi9a-31063
```

Repérer la version **N-1** (celle active avant la rotation), puis la
**réactiver** depuis la console Google Cloud → *Secret Manager* →
`LIVO_WEBHOOK_SECRET` → versions → `ENABLE` sur la version N-1, puis
**redéployer** :

```cmd
firebase deploy --only functions:livoWebhook --project smartswi9a-31063
```

Enfin, **remettre l'ancien secret dans le portail Livo**
(Paramètres → Webhook) et relancer un `ping` de test.

> Si la CLI propose `firebase functions:secrets:disable` / `:destroy`, ne
> **jamais** détruire la version N-1 avant la fin de la checklist post-rotation :
> c'est elle qui rend le rollback possible.

### 5.2 Après le rollback

- [ ] `ping` de test → `200`.
- [ ] `firebase functions:log --only livoWebhook` → plus aucun `401`.
- [ ] Si Livo a désactivé le webhook (50 échecs) : **réactiver**
      (`PUT /client_webhooks/me` avec `active: true`).
- [ ] Rejouer les événements manqués : `livoWebhook` est **idempotent** par
      `X-Livo-Delivery` (collection `livo_webhook_events`) → un rejeu est sans
      danger, il produit `duplicate: true` pour les événements déjà vus.
- [ ] Documenter l'incident et la cause racine.

> ⚠️ **Fenêtre de rétention = 7 jours.** Au-delà, l'ancienne version du secret
> est détruite définitivement : le rollback n'est plus possible. Ne jamais
> laisser une rotation « en suspens » plus de 48 h.

---

## 6. Fréquence recommandée

| Situation | Fréquence |
|---|---|
| Régime normal | **Tous les 6 à 12 mois** |
| Départ d'un collaborateur ayant eu accès au secret | **Immédiat** |
| Secret exposé (log, capture, dépôt, chat) | **Immédiat** |
| Incident de sécurité / suspicion de fuite | **Immédiat** |
| Changement d'hébergeur ou de prestataire logistique secondaire | À l'occasion |

Justification : secret **symétrique** partagé avec un tiers, sans expiration
native côté Livo. La rotation périodique est donc la seule limitation de durée
de vie réellement maîtrisée par Smart Swika.

Sur le poste de travail : consigner la date de rotation dans un journal interne
(et non dans le dépôt).

---

## 7. Checklist post-rotation

À dérouler dans les **24 heures** qui suivent.

- [ ] **H+5 min** — `ping` de test → `200`.
- [ ] **H+15 min** — `firebase functions:log --only livoWebhook --project smartswi9a-31063`
      → aucun `401`, aucun `500`.
- [ ] **H+1 h** — consommer `GET /client_webhooks/me/logs` (spec Livo) :
      constater des réponses `2xx` sur les derniers envois.
- [ ] **H+24 h** — survoler **24 h** de logs :
      - `401` = **0** (critère bloquant) ;
      - `500` = 0 ou expliqué (le `500` est réservé au secret absent / erreur
        Firestore) ;
      - présence des `200` habituels sur `order.status_changed` /
        `order.return_status_changed`.
- [ ] **H+24 h** — vérifier que le webhook Livo est toujours `active: true`
      (non désactivé par la protection des 50 échecs).
- [ ] **H+24 h** — inspecter 2 ou 3 commandes récemment livrées : leur
      `trackingStartedAt` et leur statut sont cohérents.
- [ ] **H+24 h** — supprimer **tout** script temporaire de rotation
      (`scripts\_rotate-secret.cjs` et variantes `_*.cjs`) et vérifier :
      `git status --short` ne doit rien afficher d'inattendu.
- [ ] Archiver dans le ticket : horodatages, empreinte SHA-256 tronquée,
      résultat de la checklist. **Jamais** la valeur du secret.

---

## 8. Erreurs fréquentes

| Symptôme | Cause probable | Action |
|---|---|---|
| `401` juste après l'étape 3 | Comportement **normal** (fenêtre ouverte) | Passer à l'étape 4 |
| `401` 30 min après l'étape 4 | Secrets Firebase ≠ portail Livo | Recoller le secret ; sinon rollback |
| `500` + log `LIVO_WEBHOOK_SECRET absent` | Secret non monté sur la fonction | Vérifier `functions:secrets:get`, redéployer |
| Webhook Livo `inactive` | 50 échecs consécutifs | Réactiver puis rollback |
| `401` « Horodatage invalide » | Horloge désynchronisée, ou proxy réécrivant `X-Livo-Timestamp` | Vérifier le proxy / l'heure |
| Deploy échoue sur les permissions | `secrets:set` récent, IAM non propagé | Attendre 2 min, redéployer |

---

## 9. Ce qu'il ne faut jamais faire

- ❌ Coller le secret dans un ticket, un chat, un e-mail, un `console.log`.
- ❌ Committer un fichier contenant le secret (le `.gitignore` ne protège
  que ce qu'on n'a pas committé).
- ❌ Laisser un `_rotate-secret.cjs` traîner dans le dépôt.
- ❌ Mettre à jour le portail Livo **avant** `secrets:set` + `deploy`.
- ❌ Faire un `deploy` **global** pour cette opération.
- ❌ Laisser la rotation dans un état intermédiaire plus de 48 h (les
  versions ne vivent que 7 jours).

---

## Rotation du secret côté Worker Cloudflare (LIVO_API_KEY)

> **Périmètre** : ce chapitre concerne la clé API **sortante** utilisée par le
> Worker Cloudflare `livo-proxy` (`cloudflare/workers/livo-proxy.js`) pour
> appeler l'API Livo (`https://rest.livo.ma`).
>
> ⚠️ **Ne pas confondre** avec `LIVO_WEBHOOK_SECRET` traité aux sections 1 à 5 :
> ce sont **deux secrets distincts**, sur **deux plateformes distinctes**,
> avec **deux procédures distinctes**.
>
> 🔐 **Ce fichier ne contient AUCUNE clé réelle.** Les valeurs sont toujours
> remplacées par des placeholders du type `<COLLER_LA_CLE_ICI>`. La clé de
> production ne transite jamais par Git, ni par un chat, ni par un ticket.

**Nom exact de la variable d'environnement : `LIVO_API_KEY`**

Vérifié dans le code source du Worker :

```js
// cloudflare/workers/livo-proxy.js
if (!env.LIVO_API_KEY) {                      // ligne 268 — garde : secret absent
  ...
}

Authorization: `Bearer ${env.LIVO_API_KEY}`,   // ligne 281
```

- ✅ `LIVO_API_KEY`
- ❌ `API_KEY` — n'existe pas dans le code. Un secret nommé `API_KEY` serait
  **silencieusement ignoré** et le Worker continuerait d'échouer en croyant
  la clé absente.

### 1. QUAND déclencher une rotation

| Déclencheur | Criticité | Type de rotation |
|---|---|---|
| Compromission suspectée : clé collée dans un chat, un commit, un screenshot, un log, un ticket support, ou tout canal non chiffré | 🔴 Critique | **IMMÉDIATE** |
| Départ d'un collaborateur ayant eu accès à la clé | 🔴 Critique | **IMMÉDIATE** |
| Rotation périodique (hygiène de sécurité) | 🟡 Normale | **PLANIFIÉE** — tous les **90 jours** |
| Erreurs `401` répétées sur le Worker `livo-proxy` | 🟠 À qualifier | **RÉACTIVE** — **vérifier les logs Cloudflare d'abord**, la clé n'est peut-être pas en cause |
| Changement de compte Livo (migration, renouvellement) | 🟠 Anticipée | **ANTICIPÉE** — avant la bascule, pas après |

> 💡 En cas de `401` massifs sans fuite connue : consulter les logs du Worker
> **avant** de tourner la clé. Une rotation réflexe sur une panne réseau
> ajoute de l'incertitude sans corriger la cause.

### 2. COMMENT faire la rotation (procédure pas à pas)

**Étape 1 — Générer une nouvelle clé dans Livo UI**

Livo UI → **Paramètres → Votre clé API** → **« Générer nouvelle clé API »**.

> ⚠️ Cette action **révoque l'ancienne clé immédiatement**. La nouvelle clé
> s'affiche **UNE SEULE FOIS** : la copier dans la foulée (gestionnaire de
> mots de passe), sinon il faudra recommencer la génération.

**Étape 2 — Copier la nouvelle clé**

Copier depuis Livo UI. Ne pas la coller dans un fichier, un chat ou un ticket.

**Étape 3 — Écrire le secret sur le Worker `livo-proxy`**

Dans **PowerShell**, depuis le dossier `cloudflare/workers/` :

```powershell
cd cloudflare/workers
npx wrangler secret put LIVO_API_KEY --config wrangler.livo-proxy.toml
```

Quand `wrangler` affiche `Enter a secret value`, **coller la clé**.
Elle n'apparaît **pas** à l'écran (ni en clair, ni en étoiles) : c'est normal,
c'est le comportement attendu.

**Étape 4 — ⚠️ Pourquoi `--config wrangler.livo-proxy.toml` est OBLIGATOIRE**

> ⚠️ **SANS `--config`, wrangler lit `wrangler.toml` et cible `smart-swi9a-api`.**
>
> Ce n'est pas une hypothèse : `cloudflare/workers/wrangler.toml` déclare
> `name = "smart-swi9a-api"`. Toute commande `wrangler` lancée depuis
> `cloudflare/workers/` **sans `--config`** écrit ou déploie sur
> **`smart-swi9a-api`**, qui ne lit **jamais** `LIVO_API_KEY`.

Les quatre commandes de ce runbook sont donc **toutes** préfixées par `--config` :

```powershell
cd cloudflare/workers
npx wrangler deploy            --config wrangler.livo-proxy.toml
npx wrangler secret put LIVO_API_KEY    --config wrangler.livo-proxy.toml
npx wrangler secret put LIVO_CLIENT_ID  --config wrangler.livo-proxy.toml
npx wrangler secret put LIVO_ADMIN_UIDS --config wrangler.livo-proxy.toml
```

`cloudflare/workers/wrangler.livo-proxy.toml` est le fichier de configuration
**dédié** au Worker `livo-proxy` (introduit par la PR 8.5). Il déclare
`name = "livo-proxy"` et `main = "livo-proxy.js"`.

> **Règle absolue : toujours passer `--config wrangler.livo-proxy.toml`.**
> Corollaire : ne jamais lancer `wrangler deploy` depuis `cloudflare/workers/`
> en pensant déployer `livo-proxy` — cela déploie `smart-swi9a-api`.

Les secrets déclarés en production pour ce Worker sont exactement trois :
`LIVO_API_KEY`, `LIVO_CLIENT_ID`, `LIVO_ADMIN_UIDS`. **Ils ne doivent jamais
apparaître dans le `.toml`** — uniquement via `wrangler secret put`.

**Étape 5 — Vérifier que le secret est bien sur le bon Worker**

```powershell
npx wrangler secret list --config wrangler.livo-proxy.toml
```

Attendu : `LIVO_API_KEY` présent dans la liste.

Contrôle croisé — `LIVO_API_KEY` ne doit **pas** figurer ici :

```powershell
npx wrangler secret list --config wrangler.toml
```

S'il y figure à la suite d'une manipulation erronée, le supprimer :

```powershell
npx wrangler secret delete LIVO_API_KEY --config wrangler.toml
```

> Wrangler ne réaffiche **jamais** la valeur d'un secret : seuls le nom et la
> date de modification sont visibles.

**Étape 6 — Tester de bout en bout depuis l'admin**

Depuis `smartswika.ma/admin.html` : **créer une commande de test**, puis
vérifier qu'elle **arrive bien dans Livo UI**.

- Commande visible côté Livo → rotation réussie.
- `401` / erreur « clé invalide » → revenir à l'étape 3 (mauvais Worker ou
  clé non collée).

Tests complémentaires utiles (routes publiques du Worker, sans Firebase) :

```powershell
curl.exe -s https://<domaine-du-worker>/health
curl.exe -s https://<domaine-du-worker>/cities
```

Attendu : `200` et `service: "livo-proxy"` pour `/health`, liste de villes non
vide pour `/cities`.

**Étape 7 — Clore la rotation**

- [ ] Ancienne clé révoquée (fait automatiquement à l'étape 1).
- [ ] `wrangler secret list --config wrangler.livo-proxy.toml` → `LIVO_API_KEY` présent.
- [ ] Commande de test visible dans Livo UI.
- [ ] Presse-papiers purgé, onglet Livo UI fermé.
- [ ] `git status --short` → rien d'inattendu.

### 3. EN CAS DE SECRET FUITÉ (procédure d'urgence)

**Déclencheur** : clé exposée dans un chat, un commit, un screenshot, un log,
un ticket support, ou tout canal non chiffré.
→ **Considérer la clé comme publique dès la seconde de l'exposition.**

1. **Rotation IMMÉDIATE** via Livo UI — dérouler la **section 2** sans délai.
   C'est l'action qui protège réellement : tant que l'ancienne clé est active,
   elle est utilisable par n'importe qui.
2. **Vérifier les logs Cloudflare du Worker `livo-proxy`** sur les dernières
   **24 h** : recherche d'un usage anormal (pics d'appels, origines
   inattendues, rafales de `401`).
3. **Vérifier les commandes créées dans Livo UI** sur les dernières **24 h** :
   détecter toute création non sollicitée (colis, enlèvements, commandes).
4. **Si usage malveillant avéré** : contacter le **support Livo** et
   **suspendre temporairement le Worker** (route désactivée) le temps de
   contenir l'incident.
5. **Noter dans le journal de bord** : **date**, **canal de fuite**, **actions
   menées**, portée de l'exposition. **Jamais** la valeur de la clé.

> ⚠️ **Ne JAMAIS coller la clé dans un chat, un commit, un fichier de config,
> ou un ticket.** Toujours passer par `wrangler secret put` en local, jamais
> par copier-coller vers un tiers.
>
> ⚠️ Un message supprimé n'est pas un secret récupéré : il n'existe pas de
> « suppression » fiable d'un message ou d'un commit déjà diffusé. Seule la
> **révocation côté émetteur** (Livo UI) protège réellement.

### 4. Où est stockée la clé de secours ?

- La clé de production vit **UNIQUEMENT** dans le **Cloudflare Worker Secret**
  (stockage chiffré par Cloudflare, non lisible après écriture, non exposé par
  `wrangler secret list`).
- **Ce fichier ne contient AUCUNE clé réelle.** C'est de la **documentation**,
  pas un coffre-fort. Toute valeur y figurant serait de toute façon gravée dans
  l'historique Git.
- L'administrateur peut sauvegarder la clé dans un **gestionnaire de secrets**
  (1Password, Bitwarden, KeePass), avec accès restreint et journalisé.

| Emplacement | Contient la clé ? | Rôle |
|---|---|---|
| Cloudflare Worker Secret (`livo-proxy`) | ✅ **Oui — source de vérité** | Utilisée à l'exécution |
| Gestionnaire de secrets (1Password, Bitwarden, KeePass) | ✅ Oui — sauvegarde | Récupération / continuité |
| Ce fichier `docs/runbooks/ROTATION-SECRET-LIVO.md` | ❌ **Jamais** | Documentation |
| Dépôt Git / historique | ❌ **Jamais** | Code seulement |
| Chat, ticket, e-mail, screenshot | ❌ **Jamais** | — |
