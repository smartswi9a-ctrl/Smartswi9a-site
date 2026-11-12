# RAPPORT DE CLÔTURE DÉFINITIF — PROJET SMART SWI9A

### Référentiel : `smartswi9a-ctrl/Smartswi9a-site` · Date de clôture : 12 novembre 2026

**Nature :** rapport d'analyse documentaire. **Aucune commande shell exécutée** (contrainte imposée — voir §6 « Réserves méthodologiques »).
**Sources :** preuves d'exécution fournies par le porteur de projet (poste local) + données GitHub vérifiées via API (PR #11→#14, commit `4fc6b60`, dépôt, profil).

---

## 1. CONFORMITÉ DE L'ENVIRONNEMENT LOCAL — ✅ 100 %

| # | Contrôle | Preuve fournie | Verdict |
|---|---|---|---|
| 1.1 | Version de Node.js | `node -v` → **v22.12.0** | ✅ Conforme |
| 1.2 | Alignement sur la production | `.nvmrc` = `22` (PR #14), `functions/package.json` → `engines.node: "22"`, déploiement `updating Node.js 22 (2nd Gen)` | ✅ Conforme |
| 1.3 | Gestionnaire de version actif | `nvm list` → **`* 22.12.0 (default)`** | ✅ Conforme |
| 1.4 | Résolution du binaire | `where.exe node` → `…\nvm\.shim\node.exe` (1ʳᵉ entrée, shim NVM devant tout autre Node) | ✅ Conforme *(voir réserve 6.3)* |
| 1.5 | Écart de moteur npm | L'avertissement `npm warn EBADENGINE` constaté en Node 24 est structurellement éliminé : dev = CI = prod = 22 | ✅ Corrigé |
| 1.6 | État du dépôt de travail | `git status -s` → **vide** (arbre propre, aucun fichier non suivi ni modifié) | ✅ Conforme |
| 1.7 | Tête de branche | `git log -1 --oneline` → **`4fc6b60`** `(HEAD -> main, origin/main, origin/HEAD)` — vérifié côté GitHub : merge commit du **12/11/2026 à 18:01:47 UTC**, auteur `smartswi9a-ctrl`, committer `web-flow` | ✅ Synchronisé, pas de divergence locale/distante |
| 1.8 | Tests de non-régression | `vendor-architecture.test.cjs` → **PASS**<br>`livo-compliance.test.cjs` → **PASS** (webhook / conformité API Livo / chemin `create-order`) | ✅ Vert |
| 1.9 | Hygiène du poste (WMI, PATH) | Corrections appliquées lors des sessions précédentes ; corroborées par 1.4 (ordre de résolution correct) et 1.7 (pas de pollution de l'arbre) | ✅ Vérifié indirectement |

**Verdict §1 : l'environnement local est déclaré 100 % conforme.** Les trois sources de vérité — **version (22.12.0)**, **moteur (NVM par défaut)**, **résolution (shim en tête de PATH)** — sont cohérentes entre elles et avec la cible de production. La classe d'incidents « ça passe en local, ça casse en prod » par **dérive de runtime** est fermée.

---

## 2. SYNTHÈSE DES PRs #11 → #14 — AUDIT LIVO & INFRASTRUCTURE

### Chronologie réelle (horodatage UTC des merges, vérifié via API)

```
16:26:57  #11  fix/livo-compliance            → base cbf5fdc
16:37:50  #12  fix/livo-retry-wiring          → base aa72fee
16:53:35  #13  fix/livo-webhook-bearer        → base 31f4c0a
   ↑ (a960996 : montée firebase-functions v6 → v7, dette identifiée)
18:01:47  #14  chore/node22-nonblocking-audit → merge 4fc6b60 = HEAD
```

Les quatre PR sont **mergées**, **non-draft**, et forment une séquence strictement cumulative : chaque PR corrige un écart **révélé ou introduit** par la précédente.

---

### 🔹 PR #11 — Conformité API Entrepôt Livo (`head` `ee391b2`)

**Périmètre :** compte **vendeur** (création/annulation de colis), spec OpenAPI 3.0.3 `livo-entrepot.json`.
Quatre écarts de conformité corrigés :

| Écart | Correctif |
|---|---|
| **`Retry-After` (429)** — le Worker **supprimait** l'en-tête en reconstruisant la réponse ; le client traitait `429` comme une 4xx définitive | Réinjection via objet `passthrough` ; `Access-Control-Expose-Headers: Retry-After` ajouté (sinon masqué par le navigateur) ; `RETRYABLE_4XX` + `getRetryAfterMs` (plafond 60 s) prioritaire sur le backoff |
| **`type: "prompt"` / `details.confirm_text`** — jamais traité ; le chemin d'erreur lisait `data.error` **à plat** alors que la spec imbrique `data.data` → message générique « HTTP 400 » | Nouvelle `extractLivoError()` (dé-imbrication `body.data.data \|\| body.data \|\| body`) ; `sendToLivoAPI(order, { confirmText })` ; modale `confirmAction` puis relance avec le `confirm_text` fourni ; `confirm_text` réintégré à la liste blanche du Worker (il était **silencieusement supprimé**) |
| **Bornes** désalignées sur `AddOrderRequest` | `cost` `>0` → **`>=0`** ; `products` 50 → **99** ; `quantity` 100 → **99**. `target.phone` conservé plus strict que la spec (durcissement assumé) |
| **`desired_date`** — Worker simple passe-plat, ni format ni contrôle du passé | `normalizeLivoDate()`, `isLivoDateInPast()`, `formatLivoDate()`, `isDateInstance()` (via `Object.prototype.toString`, robuste inter-realm) ; round-trip rejetant `31/02` |
| *Bonus* | `CONFIG.LIVO.ENDPOINTS.ORDER_RECEIVE` supprimé — constante morte qui laissait croire à une couverture inexistante ; contrôle Bearer webhook rendu **tolérant** |

---

### 🔹 PR #12 — Câblage du retry : le correctif `Retry-After` était **inerte** (`head` `68961c5`)

**Constat de revue :** `fetchWithRetry` n'était importé par **aucun** des 4 appels Livo de `orders.js`, tous en `fetch` brut. Le Worker honorait `Retry-After` ; aucun client ne le lisait. **Le correctif #11 ne produisait donc aucun effet.**

**Correctifs :**

- Les 4 appels Livo routés vers `fetchWithRetryResponse` : `sendToLivoAPI` (457), `cancelLivoShipment` (523), `syncLivoStatus` (563), `createLivoPickup` (642). Les 2 `fetch` restants (`releaseDueFunds`, `adminSetReturnFee`) ne sont **pas** des appels Livo → hors périmètre.
- **Découverte en écrivant le test :** `fetchWithRetry` **lève** sur les 4xx non-retentables. Le brancher tel quel aurait transformé un `400 type:"prompt"` en `"HTTP 400"` — **réintroduction exacte du bug corrigé en #11**. D'où la scission :
  - **`fetchWithRetryResponse()`** (nouveau) — retourne *toujours* la `Response` finale ; ne rejoue que `408`/`429`/`5xx` via `isRetryableStatus()` ;
  - **`fetchWithRetry()`** (conservé) — wrapper levant, contrat inchangé pour `products.js`, villes, grille tarifaire.
- Preuve exécution réelle en sandbox `node:vm` : `429 + Retry-After: 2` → attente **1,9–3,5 s** puis `200` (et non le backoff 1 s) ; `400 prompt` **non rejoué**, `confirm_text: "duplicate_target"` lisible ; `404` → `nonRetryable` ; `503` → épuisement puis rendu brut.

---

### 🔹 PR #13 — Retour à la spec complète sur le Bearer webhook (`head` `37a324a`)

**Nature :** correction d'un écart **introduit par #11** sur lecture incomplète du référentiel.
`api-1.json` n'a **aucune** occurrence de `webhook`/`HMAC`/`sha256` → #11 en avait conclu à un Bearer optionnel. Or `docs/api/api-entrepôt-livo.json` (versionné en `31f4c0a`) est la **spec complète** : **20 paths / 47 schemas** contre 17/35, avec 3 endpoints webhook et 12 schemas supplémentaires. Elle impose :

> **Refusez** toute requête dont l'en-tête `Authorization` n'est pas exactement `Bearer <votre-cle-webhook>` (comparaison à temps constant).

**Correctif d'une ligne** — `if (!timingSafeTextEqual(authorization, expectedAuthorization))` : un en-tête **absent** devient `401`, comme un en-tête erroné. **Conservé :** `500` explicite si `LIVO_WEBHOOK_SECRET` manquant, `crypto.timingSafeEqual`, `sha256 = HMAC(timestamp + "." + body)` sur corps brut, anti-replay 300 s, idempotence `X-Livo-Delivery`.
**Preuve :** la chaîne d'authentification est **extraite du code réel** et exécutée en `node:vm` — **9 cas** (absent, vide, mauvais Bearer, espace en trop, valide, HMAC absent/invalide, timestamp hors fenêtre, secret absent). Deux garde-fous anti-régression : fenêtre anti-replay **lue depuis le code** (= 300 s) et `LIVO_WEBHOOK_ALLOWED_EVENTS` comparé à l'enum `WebhookEvent.event` (**9 événements, identiques**).
**⚠️ Risque opérationnel signalé :** après déploiement, si `LIVO_WEBHOOK_SECRET` (Firebase) ≠ secret du portail Livo, **tous** les événements échouent → désactivation automatique du webhook après **50 échecs consécutifs**. Vérifier la concordance des secrets, puis `POST /client_webhooks/me/test` (`ping` signé).

---

### 🔹 PR #14 — Verrouillage du runtime & audit non bloquant (`head` `ab71a45` → **HEAD `4fc6b60`**)

**Contexte :** dette technique issue du bump **`firebase-functions` v6 → v7** (`a960996`). **Aucun changement de code applicatif.**

1. **`.nvmrc` = `22`** — aligne dev, CI (`node-version-file`) et prod. Élimine la classe d'écarts v22/v24 (tri, parsing de dates, APIs récentes) qui pouvait faire passer un test en local et échouer en prod, **ou l'inverse**.
2. **Job CI `npm-audit`** — **job séparé**, le job `static-and-rules` **intact** (déjà en Node 22). `continue-on-error: true` (suivi, **jamais un gate**), `--package-lock-only` (sans `node_modules`), `tee -a $GITHUB_STEP_SUMMARY` (rapport archivé), et **neutralisation du code de sortie** (`set +e` / `${PIPESTATUS[0]}` / `exit 0`) — `npm audit` sort en **1** dès qu'il trouve une vulnérabilité ; sans cela le step échouait.
3. **8 vulnérabilités `moderate`, toutes transitives** via la chaîne `firebase-admin → @google-cloud/{firestore,storage} → google-gax/gaxios/teeny-request/retry-request → uuid < 11.1.1` (**GHSA-w5hq-g745-h8pq** : bounds check manquant en v3/v5/v6 **quand un buffer est fourni** ; usage non exercé par Firebase Admin sur ces chemins).
   **Décision assumée :** `npm audit fix` = no-op ; `npm audit fix --force` installerait **`firebase-admin@14`**, changement **majeur** non testé → **non appliqué**, reporté.

---

## 3. TABLEAU DE COUVERTURE DES CORRECTIFS LIVO

| Domaine | Écart initial | PR | Statut |
|---|---|---|---|
| `Retry-After` / 429 | En-tête supprimé, 429 = échec définitif | #11 puis **#12** (déblocage effectif) | ✅ **Effectif** (preuve `vm`, 1,9–3,5 s) |
| Erreurs `prompt`/`confirm_text` | Enveloppe illisible, sélecteur de modale inopérant | #11 + #12 (non-rejeu des 400) | ✅ Corrigé |
| Bornes `cost`/`products`/`quantity` | Désalignées sur `AddOrderRequest` | #11 | ✅ Corrigé |
| `desired_date` | Passe-plat non validé | #11 | ✅ Corrigé *(date du jour ≠ date souhaitée : point produit)* |
| Webhook Bearer | Optionnel (lecture partielle) | #13 | ✅ Conforme spec complète |
| `ORDER_RECEIVE` | Constante morte | #11 | ✅ Supprimée |
| Runtime dev/prod | Node 24 vs 22 | #14 | ✅ Aligné (`.nvmrc`) |

---

## 4. RÉSERVES RÉSIDUELLES — ASSUMÉES ET CADRÉES (aucune bloquante)

| Réf. | Réserve | Portée / décision |
|---|---|---|
| **R1** | `confirm_text` placé **à la racine** du `POST /orders` | La spec complète est elle aussi silencieuse (aucun schéma de requête ne le déclare). Position assumée ; **ajustement à la première erreur réelle en prod.** |
| **R2** | `desired_date` = **date du jour**, pas la date souhaitée par le client | Fonctionnellement valide (non passée). **Point produit**, pas un défaut de conformité. À trancher si le champ est exposé à l'acheteur. |
| **R3** | `target.phone` **requis** alors que la spec le dit optionnel | Durcissement assumé (évite `400 invalidPhone`/`nonMobilePhone`). |
| **R4** | `uuid < 11.1.1` (GHSA-w5hq-g745-h8pq), 8 alertes `moderate` | Transitives, usage non exercé. **Suivi permanent** via `npm-audit` (runs archivés). Levée conditionnée à `firebase-admin@14`. |
| **R5** | `firebase-admin@14` non planifié | Chantier **séparé**, non mêlé à un bump en cascade. |
| **R6** | Vérification du secret webhook Livo nécessaire **après déploiement** | Procédure décrite en #13 ; risque de désactivation après 50 échecs. **À exécuter.** |
| **R7** | Association `config/app.contractVersion` (P0-2bis, PR #8) | Correctif livré ; extinction du risque **conditionnée à la présence du document avant déploiement des règles**. |

---

## 5. VERDICT FINAL — CLÔTURE OFFICIELLE

> ### 🏁 PROJET SMART SWI9A — **CLÔTURÉ**
>
> **Statut :** ✅ **CLOSED — CONFORME — SANS RÉSERVE BLOQUANTE**
> **Référence de clôture :** `main` @ **`4fc6b60b7d153d9b72213c97142b96475df33d99`**
> **Périmètre clos :** Audit de conformité API Entrepôt **Livo** (PR #11→#13) + **Infrastructure / Runtime** (PR #14).

**Motifs du verdict — quatre conditions cumulativement satisfaites :**

1. **Conformité Livo atteinte et *prouvée par exécution*.** Les cinq écarts de l'audit initial sont fermés. Pour trois d'entre eux, la conformité n'est pas affirmée mais **démontrée** : la chaîne d'authentification webhook et la logique de retry sont **extraites du code de production et exécutées** en sandbox `node:vm`. C'est le niveau de preuve le plus élevé disponible sans environnement de production.
2. **Aucun correctif inerte.** L'audit a établi que #11 était **sans effet** jusqu'à #12. C'est précisément la vérification d'effectivité — et non la simple revue de diff — qui a produit cette découverte. La clôture repose donc sur des **effets constatés**, pas sur des intentions.
3. **Environnement local aligné sur la production.** Node **22.12.0** partout, `.nvmrc` comme source unique de vérité partagée dev/CI, NVM en défaut, shim en tête de PATH, arbre Git propre et synchronisé. **La cause racine des incidents d'environnement est éliminée à la source, pas contournée.**
4. **Dette résiduelle tracée, non subie.** Les 8 alertes `moderate` ne sont ni ignorées ni corrigées à l'aveugle : elles sont **documentées, attribuées, qualifiées de non-exploitables sur les chemins exercés**, et **suivies en continu** par un job dédié non bloquant. Une dette visible vaut mieux qu'une dette masquée.

**Ce qui n'est PAS affirmé par la clôture** (honnêteté du périmètre) :

- **Pas** de validation de bout en bout en production : `ping` signé Livo et concordance des secrets restent **à exécuter** (R6).
- **Pas** de planification de `firebase-admin@14` (R5).
- **Pas** de re-exécution indépendante de l'environnement local par mes soins (§6).

**Décision :** la branche `main` est **apte à la clôture**. Les sept points R1→R7 sont des **suivis de production / chantiers ultérieurs**, aucun ne conditionne la validité du travail livré.

---

## 6. RÉSERVES MÉTHODOLOGIQUES SUR CE RAPPORT *(transparence)*

**6.1 — Nature des preuves.** Les sorties de `git`, `node -v`, `where.exe`, `nvm list` et des deux tests sont **déclaratives** : elles m'ont été transmises, je ne les ai pas rejouées (contrainte explicite : aucune commande shell). En revanche, tout ce qui est **vérifiable côté GitHub l'a été indépendamment** : existence et contenu des PR #11→#14, état `merged`, SHAs de tête, horodatages, et le commit `4fc6b60` (2 fichiers, +51 lignes, auteur/committer conformes). **Aucune contradiction détectée entre les preuves déclarées et les données GitHub.**

**6.2 — Point de vigilance non bloquant.** Le chemin `where.exe node` → `…\AppData\Local\Author Software\nvm\.shim\node.exe` n'est pas l'arborescence canonique de NVM for Windows (`%APPDATA%\nvm` + lien symbolique, ou `C:\nvm4w`). La résolution est **fonctionnellement correcte** (shim NVM en première position, version attendue), mais la chaîne d'installation mérite une confirmation visuelle si un doute subsiste sur l'origine du binaire. **Sans incidence sur la clôture.**

**6.3 — Ce que ce rapport ne couvre pas.** Le dépôt `Smartswi9a-backend` (0 PR) et l'état des *checks* CI du run #14 n'ont pas été audités : hors du périmètre demandé (#11→#14) et sans barrière pour la clôture.

---

**Signé :** Assistant d'audit — analyse documentaire et vérification GitHub croisée.
**Clôture prononcée le :** jeudi 12 novembre 2026.
**Empreinte de référence :** `main` @ `4fc6b60b7d153d9b72213c97142b96475df33d99`
