# Smartswika — boutique e-commerce

Site statique (Firebase Hosting) + Cloud Functions + Workers Cloudflare.
Livraison assurée par **Livo** (`rest.livo.ma`).

Boutique : <https://smartswika.ma> · Projet Firebase : `smartswi9a-31063`

---

## Architecture

```
Navigateur
   │
   ├── Firebase Hosting (HTML/CSS/JS statiques, à la racine)
   │      └── js/app.js est le SEUL point d'entrée chargé sur toutes les pages
   │
   ├── Firestore  (products, orders, users, cities, reviews, wallet…)
   ├── Firebase Storage (images produits, avis, blog)
   │
   ├── Worker Cloudflare `smart-swi9a-api`
   │      └── proxy /api/* → Cloud Functions (whitelist de 15 fonctions)
   │
   └── Worker Cloudflare `livo-proxy`  +  Cloud Function `livoWebhook`
          └── pont vers l'API Livo (sortant / entrant)
```

**19 Cloud Functions** (`europe-west1`, `nodejs22`, 256 Mo) — voir `functions/index.js`.

---

## Structure du dépôt

| Chemin | Contenu |
|---|---|
| `*.html` | Pages du site (racine = racine publiée) |
| `js/` | Modules ES (app, admin, orders, cart, products, reviews…) |
| `functions/index.js` | Toutes les Cloud Functions + helpers |
| `cloudflare/workers/` | `livo-proxy.js`, `smart-swi9a-api.js`, `worker-ip.js` |
| `firestore.rules`, `storage.rules` | Règles de sécurité |
| `firestore.indexes.json` | Index composites |
| `tests/` | Suites de non-régression (aucune dépendance réseau) |
| `scripts/` | Outils locaux (migration, backfill, sitemap, audit Livo) |
| `docs/` | Documentation (API Livo, runbooks, dettes, journal d'audit) |

---

## Documentation

| Document | Objet |
|---|---|
| **`docs/livo/`** | **Spec OpenAPI Livo (246 Ko) + grille tarifaire live (404 villes)** |
| `docs/livo/README.md` | Index du dossier Livo, contraintes API, politiques de prix |
| `docs/AUDIT-CORRECTIONS-2026-11-16.md` | Journal des 13 corrections (causes racines + validations) |
| `docs/DETTES.md` | Dettes techniques ouvertes |
| `docs/api/` | Spécifications OpenAPI Livo d'origine |
| `docs/runbooks/` | Rotation des secrets, migration shipping, monitoring |
| `docs/legal/` | CGU acheteur, CGU vendeur, contrat vendeur, confidentialité |

---

## Développement

```powershell
# Tests (aucune dépendance externe, aucun réseau)
npm test

# Déploiement
firebase deploy --only hosting
firebase deploy --only functions
firebase deploy --only firestore:rules,firestore:indexes

# Worker Cloudflare — TOUJOURS préciser --config
cd cloudflare\workers
npx wrangler deploy --config wrangler.worker-ip.toml
```

La CI (`static-and-rules`) exécute `npm test` — **21 suites hors ligne**, aucune
dépendance, aucun réseau — puis les règles Firestore/Storage dans l'émulateur.
Une suite qui échoue bloque la PR. `tests/rules.test.cjs` reste hors de
`npm test` car il exige l'émulateur ; la CI l'exécute séparément.

### Deux cibles de déploiement (audit 2026-11-18)

| Cible | URL | Déclencheur | Configuration |
|---|---|---|---|
| **Cloudflare Pages** | `https://smartswika.ma` (canonique) | **automatique** à chaque push sur `main` | `_headers`, `_redirects` |
| **Firebase Hosting** | `https://smartswi9a-31063.web.app` | `firebase deploy --only hosting` | `firebase.json` |

Conséquence à retenir : une redirection doit être déclarée **dans les
deux** systèmes.

- Les `redirects` / `rewrites` de `firebase.json` ne s'appliquent
  **pas** au domaine canonique (servi par Cloudflare).
- `_headers` / `_redirects` ne s'appliquent **qu'à** Cloudflare Pages.
- `cleanUrls: true` côté Firebase : les URLs publiques sont sans
  `.html` (`/koulchi`, `/villesmaroc`…), y compris pour les
  canonicals et le sitemap.

### Outils Livo

```powershell
node scripts/import-livo-fees.cjs             # rafraîchit docs/livo/fees-livo.json
node scripts/rebuild-villes-from-livo.cjs     # reconstruit villes.json (404 villes)
node scripts/audit-livo-fees.cjs              # compare Livo ↔ site
```

---

## Mesure d'audience (depuis le 2026-11-18)

Deux dispositifs complémentaires :

| Dispositif | Où | Données |
|---|---|---|
| **Dashboard interne** | `/admin` → onglet **📈 Trafic** | vues (tous) + visiteurs uniques (consentants) sur aujourd'hui / 7 j / 30 j / 12 mois, **en ligne maintenant**, visiteurs par page, 14 derniers jours |
| **Cloudflare Web Analytics** | dashboard Cloudflare | pages vues, visiteurs, sources, pays, pages populaires (sans cookie, tous les visiteurs) |

Collecte interne, **deux flux distincts** :

| Flux | Qui | Données envoyées | Base légale |
|---|---|---|---|
| **Vues** (`views`) | **tous les visiteurs** | compteur journalier seul | mesure agrégée non personnelle → hors consentement |
| **Visiteurs uniques** (`visitors`) + **présence** | **uniquement les visiteurs consentants** | identifiant pseudonyme local + page | consentement (bandeau cookies) |

Aucune IP, aucun nom, aucun cookie publicitaire. Collections Firestore : `analytics_daily` (lecture admin ; le client peut seulement incrémenter `views` et ajouter un identifiant à `visitors`) et `presence` (battement toutes les 60 s, « en ligne » si vu il y a moins de 5 min). Chaque battement écrit aussi `expireAt` (maintenant + 7 jours) : une **politique TTL Firestore** supprime le document une fois cette date passée (généralement sous 24 h). Voir `docs/runbooks/FIRESTORE-TTL-PRESENCE.md`.

Le bouton **« 🗑️ Remettre à zéro »** (admin → Trafic) supprime `analytics_daily` et `presence` après confirmation. La suppression est réservée à l'admin par `firestore.rules` (`allow delete: if isAdmin()`), et le bouton est refusé à tout autre utilisateur.

Conséquence pratique : **le nombre de vues reflète tout le trafic** (y compris les visiteurs qui n'ont jamais répondu au bandeau), tandis que « visiteurs uniques » et « en ligne » ne comptent que les consentants. La politique de confidentialité (§ 3.6 et article 10) décrit ces deux flux.

### Activer Cloudflare Web Analytics (une seule fois)

1. Dashboard Cloudflare → **Analytics & Logs → Web Analytics**.
2. **Add a site** → choisir `smartswika.ma` → **Enable**.
3. Le domaine étant proxied par Cloudflare, le beacon est injecté automatiquement (aucun code à ajouter). Sinon, coller le snippet fourni dans le `<head>`.
4. Les premières données apparaissent sous 5 à 10 minutes.

### Politique de cache (mise à jour du 2026-11-19)

| Ressource | En-tête | Effet |
|---|---|---|
| `*.js` | `Cache-Control: no-cache` | revalidation ETag avant chaque usage (`304`) : **un correctif est visible immédiatement** |
| `css/*.css` | `immutable`, 1 an | ces fichiers sont hachés par `build-css.cjs` |
| `*.html` | `max-age=0, must-revalidate` | toujours frais |

Ce réglage a demandé **deux actions côté Cloudflare** (zone) : `Browser Cache TTL = Respect Existing Headers`, sinon la zone réécrit le `Cache-Control` d'origine en `max-age=14400`.

Les points d'entrée versionnés (`admin.js?v=<hash>`, `translations.<hash>.js`) restent la première ligne de défense ; le `no-cache` couvre les modules importés en relatif (`auth.js`, `analytics.js`, `ui.js`…), qui n'ont pas de jeton.

---

## Règles à respecter

1. **Aucun secret dans le dépôt.** Clés via `wrangler secret put` et Firebase Secret Manager.
2. **`functions/index.js` : pas d'apostrophe dans les commentaires.** Le test
   `livo-webhook-sim` extrait du code par comptage de quotes et ne sait pas
   ignorer les commentaires ; une apostrophe seule décale l'extraction.
3. **Ne jamais réécrire `js/admin.js` avec `Set-Content -Encoding UTF8`.**
   Cela double-encode accents et emojis. Utiliser l'éditeur, ou
   `ReadAllLines`/`WriteAllLines` avec `UTF8Encoding(false)`.
4. **Branche `main` protégée** : PR obligatoire + check `static-and-rules`.
5. **Aligner `villes.json` et Firestore sur Livo** après toute sync tarifaire.

---

## État connu (2026-11-16)

- **404 villes** desservies, prix Livo exacts, sans marge.
- **Catalogue produits vide** : le site est en cours de construction.
- Les sections « Avis » et « Témoignages » se masquent tant qu'il n'y a
  aucun avis `featured`.

---

## Décisions produit

| Décision | Date | Conséquence technique |
|---|---|---|
| **Le panier exige un compte client** (pas de panier invité) | 2026-11-19 | `addToCart` (`js/cart.js`) refuse un visiteur non connecté, ouvre la modale de compte et **mémorise le produit cliqué** (`js/cart-intent.js`, TTL 30 min) pour l'ajouter automatiquement dès la connexion ou l'inscription. |
| Mesure d'audience : vues anonymes pour tous, uniques sous consentement | 2026-11-19 | deux flux distincts, voir « Mesure d'audience ». |
| Vente flash : publication directe par le vendeur, sans validation admin | 2026-11-16 | `firestore.rules` / `flash_sales`, voir le commentaire dans les règles. |

---

## Dette technique connue (revue du 2026-11-19)

Ces points sont **assumés et documentés** — ce ne sont pas des oublis. Chacun
indique pourquoi il n'est pas traité et ce qu'il faudrait pour le faire.

| # | Dette | Pourquoi elle n'est pas traitée | Coût actuel |
|---|---|---|---|
| 1 | **`delivery_mode` absent des items de commande** | L'ajouter exige de modifier `createCustomerOrder` (`functions/index.js`) **puis de redéployer les Cloud Functions** ; à faire lors d'une intervention planifiée sur les functions, pas isolément. | Le badge « Mode » de l'admin dérive le mode depuis la collection `products`, avec un cache partagé de 30 s (1 lecture produits par rendu admin, pas par commande). |
| 2 | **Statut `SHIPPING` déprécié mais conservé** | Des commandes anciennes le portent encore ; il n'est plus jamais produit par l'UI. | Quelques branches de compatibilité dans `orders.js`/`utils.js`. À supprimer quand plus aucune commande ne le porte. |
| 3 | **`analytics_daily` sans purge** | Les documents sont agrégés par jour (1 doc/jour) : volume négligeable. | Croissance linéaire, ~365 docs/an. |
| 5 | **Modules JS non versionnés** | `auth.js`, `analytics.js`, `ui.js`… sont importés en relatif : les versionner demanderait un build qui réécrit les imports (récursion de hash). | Compensé par `Cache-Control: no-cache` (voir plus haut). |

La dette 4 (`presence` sans TTL) est **résolue le 2026-11-19** : chaque
battement écrit `expireAt = maintenant + 7 jours`, et une politique TTL
Firestore sur `presence.expireAt` purge les documents expirés. Le champ est
validé par `firestore.rules` (timestamp futur, borne à 8 jours) et reste
optionnel pour ne pas casser un onglet resté ouvert pendant le déploiement.
Procédure et vérification : `docs/runbooks/FIRESTORE-TTL-PRESENCE.md`.

Les TODO/FIXME historiques qui référençaient des lots de PR terminés ont été
soit vérifiés comme résolus (décrément de stock au checkout, ancrage
`trackingStartedAt`), soit convertis en lignes de ce tableau.
