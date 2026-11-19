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

Aucune IP, aucun nom, aucun cookie publicitaire. Collections Firestore : `analytics_daily` (lecture admin ; le client peut seulement incrémenter `views` et ajouter un identifiant à `visitors`) et `presence` (battement toutes les 60 s, « en ligne » si vu il y a moins de 5 min).

Conséquence pratique : **le nombre de vues reflète tout le trafic** (y compris les visiteurs qui n'ont jamais répondu au bandeau), tandis que « visiteurs uniques » et « en ligne » ne comptent que les consentants. La politique de confidentialité (§ 3.6 et article 10) décrit ces deux flux.

### Activer Cloudflare Web Analytics (une seule fois)

1. Dashboard Cloudflare → **Analytics & Logs → Web Analytics**.
2. **Add a site** → choisir `smartswika.ma` → **Enable**.
3. Le domaine étant proxied par Cloudflare, le beacon est injecté automatiquement (aucun code à ajouter). Sinon, coller le snippet fourni dans le `<head>`.
4. Les premières données apparaissent sous 5 à 10 minutes.

### Limite de cache à connaître

Les `.js` sont mis en cache (1 h via `firebase.json`, jusqu'à 4 h via Cloudflare selon le réglage de zone). Un visiteur déjà venu peut donc exécuter l'ancien JS jusqu'à expiration : ses visites des premières heures suivant un déploiement peuvent ne pas être comptées.

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
