# Notifications email — Recommandation d'architecture

> **Statut** : document de recommandation (aucun code livré).
> **Périmètre** : Smart Swika — site statique Firebase Hosting/Cloudflare Pages + Cloud Functions (`smartswi9a-31063`, région `europe-west1`).
> **Contexte** : site en phase de lancement, aucune vente encore enregistrée (voir Étape 4).

---

## 1. Situation actuelle

### 1.1 Ce qui existe déjà

Le site dispose d'un **système de notifications in-app** complet et fonctionnel, stocké dans la collection Firestore `notifications`. Ce mécanisme est **indépendant de l'email** : il alimente la cloche de notifications dans l'interface.

Exemples d'événements déjà instrumentés côté serveur (fichier `functions/index.js`) :

| Événement | Type | Déclenché par | Ligne |
|---|---|---|---|
| Commande reçue | `order_created` | `createCustomerOrder` | L2830 |
| Commande livrée | `order_delivered` | `onOrderStatusChanged` | L2113 |
| Demande d'avis | `review_request` | `onOrderStatusChanged` | L2114 |
| Retrait payé | `payout_paid` | `adminPayoutAction` | L3082 |
| Retrait rejeté | `payout_rejected` | `adminPayoutAction` | L3099 |

Ces notifications sont **idempotentes** (documents à ID déterministe, ex. `order_delivered_{orderId}`, créées dans une transaction).

### 1.2 Ce qui n'existe pas

**Aucun envoi d'email.** Le code ne contient ni `nodemailer`, ni SDK SendGrid/Resend/Postmark. Le mot « email » n'y apparaît que pour l'authentification (`validEmail`, `findUserByEmail`, throttle de login vendeur).

### 1.3 Les données nécessaires sont déjà là

C'est le point le plus important pour chiffrer l'effort : **les adresses email sont déjà collectées et stockées**.

- **Client** : `orderData.userEmail = String(decoded.email || delivery.email || '')` — `functions/index.js` L2768.
- **Vendeur** : `users/{uid}.email` + Firebase Auth (`vendorAuthUser.email`), utilisé dans `loginVendor` L1035-1065.

Il n'y a donc **pas de collecte à ajouter** : il ne manque que le transport.

### 1.4 Architecture actuelle

- 19 Cloud Functions exportées, majoritairement `onRequest` en `europe-west1`.
- Un seul trigger Firestore lié au cycle de vie des commandes : `onOrderStatusChanged` (L2077, `onDocumentUpdated` sur `orders/{orderId}`, `retry: true`).
- Le projet utilise déjà `defineSecret()` (ex. `LIVO_WEBHOOK_SECRET` L40) : la gestion des secrets est donc une pratique établie dans ce dépôt.

---

## 2. Comparaison des quatre options

### 2.1 Tableau de synthèse

| Critère | **Firebase Extension « Trigger Email »** | **Resend** | **Postmark** | **SendGrid** |
|---|---|---|---|---|
| **Modèle** | Extension clé en main (Firestore → email) | API transactionnelle | API transactionnelle | API transactionnelle + marketing |
| **Intégration Firebase** | ⭐⭐⭐⭐⭐ Aucune fonction à écrire | ⭐⭐⭐ SDK Node + secret | ⭐⭐⭐ SDK Node + secret | ⭐⭐⭐ SDK Node + secret |
| **Effort de dev initial** | ~0,5 j (installation + templates) | ~1–2 j | ~1–2 j | ~2 j |
| **Effort par nouvel email** | ~30 min (template + 1 écriture Firestore) | ~1–2 h (code fonction) | ~1–2 h (code fonction) | ~1–2 h (code fonction) |
| **Gratuit** | Extension gratuite ; coût = Firestore + quota SMTP | 3 000 emails/mois, 100/jour | 100 emails/mois (essai) | 100 emails/jour (plan gratuit) |
| **Offre payante d'entrée** | Dépend du fournisseur SMTP | ~20 $/mois (50 000) | ~15 $/mois (10 000) | ~19,95 $/mois (50 000) |
| **Délivrabilité** | **Héritée du SMTP choisi** (variable) | Très bonne (SPF/DKIM/DMARC guidés) | **Excellente** (référence du marché) | Bonne, mais réputation IP partagée |
| **Emails transactionnels** | Oui (via SMTP) | Oui (cœur de métier) | Oui (cœur de métier) | Oui |
| **Emails marketing** | Non | Limité / non prévu | Non (volontairement) | Oui (conçu pour) |
| **Templates** | Templates gérés en Firestore | Dans le code ou le dashboard | Dashboard + API | Dashboard (éditeur visuel) |
| **Webhooks (bounces, plaintes)** | À ajouter soi-même | Oui | Oui, très détaillés | Oui |
| **Logs / debug** | Firestore (`mail`) + logs Functions | Dashboard clair | Dashboard excellent | Dashboard correct, dense |
| **Verrouillage fournisseur** | Faible (SMTP standard) | Moyen (API propre) | Moyen | Moyen-fort |
| **Adéquation Smart Swika** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |

### 2.2 Détail par option

#### Option 1 — Firebase Extension « Trigger Email »

**Principe.** On installe l'extension officielle `firebase/firestore-send-email`. Elle surveille une collection Firestore (par défaut `mail`) : chaque document ajouté est traité comme un email et envoyé via un serveur SMTP configuré. Le document peut contenir le corps HTML ou référencer un template stocké dans Firestore.

**Facilité d'intégration Firebase — excellente.** Pas une ligne de code de transport à écrire. On écrit un document Firestore, l'extension fait le reste. L'installation se fait par la console ou la CLI, se configure via des paramètres (`SMTP_CONNECTION_URI`, `MAIL_COLLECTION`, `DEFAULT_FROM`).

**Coût.** L'extension elle-même est gratuite. Le coût réel se décompose en : (a) les lectures/écritures Firestore supplémentaires (négligeables au volume visé), (b) les invocations de la fonction sous-jacente, (c) **l'abonnement SMTP du fournisseur choisi**. Point crucial : l'extension n'inclut pas de service d'envoi — il faut brancher un SMTP devant (Resend, Postmark, SendGrid, Mailgun, ou Gmail SMTP pour tester).

**Délivrabilité.** Elle est **entièrement déléguée** au fournisseur SMTP. L'extension n'améliore ni ne dégrade rien : elle ajoute une couche de transport. Si le SMTP est mal configuré (SPF/DKIM absents), les emails finiront en spam quel que soit l'outil.

**Cas d'usage recommandés.** Idéal quand on veut **livrer vite avec un effort minimal**, sur un volume faible à modéré, avec des templates simples et une équipe qui préfère Firestore au code. C'est exactement le profil de Smart Swika aujourd'hui.

**Effort de développement.** Le plus faible des quatre : installation (30 min), création de 3–5 templates HTML dans Firestore, et dans chaque fonction concernée une écriture `db.collection('mail').add({...})`. Aucune gestion de secret SMTP dans le code (portée par la config de l'extension).

**Limites à connaître.**
- Le debugging est moins direct : l'erreur d'envoi atterrit dans le document Firestore (`delivery.state = 'ERROR'`), pas dans une réponse HTTP.
- Absence de webhooks de bounce/plainte : il faut les gérer séparément si on veut du sérieux.
- Coût Firestore par email (2 écritures environ) à intégrer dans le budget à grande échelle (négligeable ici).
- On dépend d'un fournisseur SMTP **en plus** de l'extension : deux éléments à configurer, pas un.

#### Option 2 — Resend

**Principe.** API HTTP moderne d'email transactionnel, SDK Node officiel. On appelle `resend.emails.send()` depuis une Cloud Function.

**Facilité d'intégration Firebase — bonne.** Il faut créer une fonction d'envoi et un secret (`defineSecret('RESEND_API_KEY')`), mais l'API est très simple (JSON, pas de SDK lourd). Documentation courte, orientée développeur.

**Coût.** Gratuit : **3 000 emails/mois, 100/jour** — largement suffisant pour un lancement. Payant à partir de ~20 $/mois pour 50 000 emails. Tarification claire et sans surprise.

**Délivrabilité.** Très bonne. Resend guide explicitement la configuration SPF/DKIM/DMARC, et permet de vérifier un domaine en quelques minutes. Réputation correcte sur le transactionnel. Moins de recul historique que Postmark, mais largement suffisant pour un site de cette taille.

**Cas d'usage recommandés.** Transactionnel pur (confirmation de commande, statut, retrait), avec une équipe à l'aise en code. Bon compromis entre modernité, prix et contrôle.

**Effort de développement.** ~1–2 j : module `sendEmail()` réutilisable, gestion du secret, templates HTML (soit dans le code, soit via l'API de templates), branchement dans 3–5 fonctions. Effort par nouvel email : ~1–2 h.

**Limites.** **Pas conçu pour le marketing** (pas de campagnes, segmentation). L'API évolue vite : suivre les changements.

#### Option 3 — Postmark

**Principe.** Service transactionnel réputé, axé sur la délivrabilité maximale. Séparation stricte entre flux transactionnel et broadcast.

**Facilité d'intégration Firebase — bonne.** SDK Node (`postmark`), secret `POSTMARK_SERVER_TOKEN`. API un peu plus verbeuse que Resend, mais très stable et bien documentée.

**Coût.** Essai gratuit de **100 emails/mois** seulement. Offre payante d'entrée ~15 $/mois pour 10 000 emails. Plus cher au email que Resend sur les petits volumes.

**Délivrabilité.** **La meilleure du marché**, c'est son argument principal. Historique long, gestion excellente des bounces et plaintes, outils de diagnostic très fins. C'est le choix des entreprises pour qui un email perdu coûte cher.

**Cas d'usage recommandés.** Si à terme les emails transactionnels deviennent critiques (factures, notifications légales, volume élevé), Postmark est la référence. Pour un lancement, c'est **surdimensionné et plus cher**.

**Effort de développement.** Comparable à Resend (~1–2 j). Le dashboard Postmark est d'ailleurs excellent pour déboguer.

**Limites.** Le plan gratuit (100/mois) est trop limité pour tester sereinement. Pas d'emails marketing (par choix assumé, c'est un atout pour la délivrabilité, un manque si on veut faire des campagnes).

#### Option 4 — SendGrid

**Principe.** Plateforme historique (Twilio), couvrant transactionnel **et** marketing, avec éditeur visuel de templates.

**Facilité d'intégration Firebase — bonne.** SDK Node `@sendgrid/mail`, secret `SENDGRID_API_KEY`. API mature.

**Coût.** Gratuit : **100 emails/jour** (soit ~3 000/mois), puis ~19,95 $/mois pour 50 000. Compétitif.

**Délivrabilité.** Bonne, mais **réputation d'IP partagée** sur le plan gratuit : les emails de nouveaux comptes peuvent atterrir en spam plus souvent qu'avec Resend ou Postmark tant que le domaine n'a pas chauffé. Configuration SPF/DKIM indispensable.

**Cas d'usage recommandés.** Si on prévoit **aussi** des newsletters/campagnes marketing depuis le même outil, l'éditeur visuel et la gestion de listes sont un vrai atout. Sinon, c'est plus d'outillage que nécessaire.

**Effort de développement.** ~2 j : API simple mais écosystème plus large à apprivoiser (templates, catégories, listes). Effort par email : ~1–2 h.

**Limites.** Interface dense et parfois déroutante. Réputation de compte gratuit à surveiller. La séparation transactionnel/marketing est moins nette que chez Postmark, ce qui peut nuire à la délivrabilité si les deux flux se mélangent.

---

## 3. Recommandation pour Smart Swika

### 3.1 Décision

> **Adopter l'extension Firebase « Trigger Email », adossée à un SMTP Resend.**

C'est une recommandation **en deux couches**, et cette nuance est essentielle :

1. **L'extension** apporte l'intégration Firebase immédiate, sans code de transport, et s'inscrit dans la pratique déjà établie du dépôt (Firestore + Functions + `defineSecret`).
2. **Resend comme SMTP** apporte la délivrabilité, le plan gratuit de 3 000 emails/mois, et surtout **une porte de sortie** : l'extension parle SMTP standard, donc changer de fournisseur (Postmark, SendGrid) plus tard ne demande **aucune modification de code** — juste un changement de `SMTP_CONNECTION_URI`.

### 3.2 Pourquoi pas les autres

- **Resend seul (sans extension)** : parfaitement viable et c'est le **plan B** si l'extension pose problème. Mais il impose d'écrire une fonction d'envoi et de la câbler dans chaque flux. On paie un jour de dev pour un gain nul au volume actuel.
- **Postmark** : la meilleure délivrabilité, mais 100 emails/mois gratuits, c'est trop peu pour tester, et 15 $/mois pour un site qui n'a **encore jamais vendu** est prématuré. À reconsidérer si les emails deviennent critiques.
- **SendGrid** : utile seulement si on veut aussi faire du marketing depuis le même outil. À ce stade, non. Réputation du plan gratuit moins bonne que Resend.

### 3.3 Le raisonnement de fond

Le site n'a **aucune vente** à ce jour (constat Étape 4). Il faut donc une solution qui :

- **coûte 0 €** tant qu'il n'y a pas de trafic ;
- **se mette en place en une demi-journée**, pas une semaine ;
- **ne crée pas de dette** : si dans six mois les emails deviennent critiques, on doit pouvoir migrer sans réécrire les flux.

L'extension + Resend coche les trois. Postmark coche la 3 mais pas la 1 ni la 2. SendGrid coche la 1 mais pas la 3.

---

## 4. Plan d'action concret

### 4.1 Phase 1 — Socle (½ journée)

**Objectif : recevoir un premier email de test, sans toucher aux flux métier.**

1. **Créer le compte Resend**, vérifier le domaine `smartswika.ma` (enregistrements SPF, DKIM, et DMARC en `p=none` pour commencer).
2. **Installer l'extension** :
   ```bash
   firebase ext:install firebase/firestore-send-email --project=smartswi9a-31063
   ```
   Paramètres :
   - `MAIL_COLLECTION` : `mail`
   - `SMTP_CONNECTION_URI` : à stocker en secret Secret Manager, au format
     `smtps://resend:<API_KEY>@smtp.resend.com:465`
   - `DEFAULT_FROM` : `Smart Swika <notifications@smartswika.ma>`
   - `DEFAULT_REPLY_TO` : une adresse support réellement relevée
3. **Test** : écrire manuellement un document dans `mail` depuis la console Firestore et vérifier la réception. Contrôler `delivery.state` (`SUCCESS` / `ERROR`).

**Critère de sortie** : un email arrive dans une boîte réelle, et l'état du document `mail` est `SUCCESS`.

### 4.2 Phase 2 — Templates et helper (½ journée)

Créer une **fonction utilitaire unique** plutôt que d'écrire des documents `mail` épars. Exemple de signature visée :

```js
async function queueEmail(templateId, to, data, opts = {}) {
  return db.collection('mail').add({
    to: [to],
    template: { name: templateId, data },
    // idempotence : un ID déterministe évite les doublons sur retry
    ...(opts.docId ? { _docId: opts.docId } : {})
  });
}
```

Points d'attention tirés du code existant :

- `onOrderStatusChanged` est configuré avec **`retry: true`** (L2077). Il **rejouera** en cas d'erreur. L'email doit donc être **idempotent**, exactement comme les notifications Firestore qui utilisent un ID déterministe (`order_delivered_{orderId}`). Reprendre le même pattern : `mail/order_delivered_{orderId}`.
- Ne jamais faire échouer la transaction métier à cause d'un email. L'écriture dans `mail` doit être **hors** de la transaction Firestore (l'extension la traite de façon asynchrone), et l'échec d'envoi ne doit pas annuler un crédit vendeur.
- Les données sont déjà disponibles : `orderData.userEmail` (L2768), `users/{uid}.email` pour les vendeurs.

### 4.3 Phase 3 — Emails prioritaires

Classement par **valeur métier décroissante** et **effort croissant**. Les trois premiers sont à faire en premier : ce sont ceux qui évitent les appels au support et les litiges.

| Priorité | Email | Destinataire | Déclencheur | Données déjà présentes |
|---|---|---|---|---|
| **P1** | **Confirmation de commande** | Client | `createCustomerOrder` (L2830, à côté de `order_created`) | `orderData.userEmail`, n° de commande, articles, total |
| **P2** | **Nouvelle commande reçue** | Vendeur | `createCustomerOrder`, boucle sur `vendorList` (L2762) | `users/{vendorId}.email`, sous-total vendeur, articles filtrés |
| **P3** | **Commande livrée + demande d'avis** | Client | `onOrderStatusChanged`, à côté de `order_delivered` / `review_request` (L2113-2114) | `after.userId`, n° de commande |
| P4 | Retrait payé / rejeté | Vendeur | `adminPayoutAction` (L3082 / L3099) | `vendorId`, `amount`, méthode |
| P5 | Validation du ramassage | Client + vendeur | `onOrderStatusChanged` au passage `shipping` avec `trackingStartedAt` (L2088-2092) | commande, `trackingStartedAt` |
| P6 | Compte vendeur approuvé / rejeté | Vendeur | `adminVendorAction` (L1310) | `vendorId`, décision |
| P7 | Réinitialisation de mot de passe | Vendeur | `setVendorPassword` (L1078) | `email` |

**Justification des priorités.**

- **P1 et P2** sont les deux emails dont l'absence se remarque immédiatement dès la première vente. Ils sont faciles (données déjà chargées dans la fonction) et à fort impact.
- **P3** est le seul endroit où le client peut ignorer que sa commande est arrivée. Il est déjà instrumenté côté notifications : l'email se greffe à côté.
- **P4** rassure le vendeur sur son argent — sujet sensible, à ne pas négliger, mais il n'y a pas encore de vendeur actif.
- **P5** est intéressant mais délicat à formuler (le ramassage n'est ni la livraison ni l'expédition) : à traiter après les quatre premiers, une fois les templates stabilisés.
- **P7** mérite une attention particulière : Firebase Auth gère déjà les emails de réinitialisation de mot de passe. Il faut vérifier si on utilise le flux natif avant d'écrire le nôtre, pour ne pas **doubler** les emails. À traiter en dernier, et probablement à **ne pas** implémenter.

### 4.4 Phase 4 — Fiabilisation (optionnelle, plus tard)

- Ajouter les **webhooks Resend** pour capter les bounces et plaintes, et marquer les adresses invalides dans `users`.
- Mettre en place un **monitoring** : compter les documents `mail` en `delivery.state = 'ERROR'` et alerter.
- **SPF/DKIM/DMARC** : passer DMARC de `p=none` à `p=quarantine` après quelques semaines d'envoi propre.

### 4.5 Ce qu'il ne faut pas faire

- ❌ **Ne pas envoyer l'email dans la transaction Firestore** (L2188-2257). Un email lent ou en échec ferait échouer un crédit vendeur. L'écriture dans `mail` est hors transaction.
- ❌ **Ne pas rendre l'email bloquant** dans `createCustomerOrder` : la réponse HTTP ne doit pas attendre l'envoi. L'extension est asynchrone, c'est tout son intérêt.
- ❌ **Ne pas utiliser `Gmail SMTP`** en production (limites de quota, réputation personnelle, spam garanti).
- ❌ **Ne pas écrire les emails en dur dans chaque fonction** : passer par une fonction `queueEmail()` + templates, sinon la maintenance deviendra ingérable.
- ❌ **Ne pas mélanger marketing et transactionnel** sur le même flux. Si des campagnes arrivent plus tard, ajouter un outil dédié plutôt que d'élargir celui-ci.

---

## 5. Estimation d'effort et de coût

| Phase | Effort | Coût mensuel |
|---|---|---|
| Phase 1 — Socle | ½ journée | 0 € (Resend gratuit) |
| Phase 2 — Templates + helper | ½ journée | 0 € |
| Phase 3 — P1 à P3 | 1 journée | 0 € |
| Phase 3 — P4 à P6 | 1 journée | 0 € |
| **Total pour les 3 emails prioritaires** | **~2 journées** | **0 €** |
| Passage à l'échelle (> 3 000 emails/mois) | — | ~20 $/mois |

Le plan gratuit Resend couvre 3 000 emails/mois et 100/jour : cela correspond, à un ordre de grandeur près, à plusieurs centaines de commandes par mois. On a donc **plusieurs mois de marge** avant le premier euro dépensé.

---

## 6. Résumé exécutif

- Le site a déjà **les adresses email** et **les déclencheurs métier**. Il ne manque que le transport.
- **Recommandation : extension Firebase « Trigger Email » + Resend en SMTP.** Effort initial ~2 journées, coût 0 € au lancement, migration possible sans réécriture.
- **Trois emails d'abord** : confirmation client, nouvelle commande vendeur, commande livrée + avis.
- **Une règle non négociable** : l'email ne doit jamais pouvoir faire échouer une vente ou un crédit vendeur. Écriture dans `mail` hors transaction, ID déterministe, retry-safe.

---

*Document de recommandation — aucun code livré. Prochaine étape possible : implémentation de la Phase 1 après validation.*
