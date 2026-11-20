# Correctifs de l'audit du 2026-11-20

> Branche : `main` — tous les correctifs ci-dessous sont appliqués dans le
> dépôt. Les déploiements et réglages externes sont listés en §7.

---

## 1. Sécurité production & fuite d'information

| Correctif | Fichier | Détail | État vérifié en prod |
|---|---|---|---|
| Filtre côté Firebase | `firebase.json` | `docs/**`, `scripts/**`, `package*.json`, `.nvmrc`, `_headers`, `_redirects`, `*.rules`, `firestore-debug.log` ajoutés à `ignore` | ✅ **404** sur `*.web.app` |
| Exclusion côté Pages | `.assetsignore` | Dossiers/fichiers internes exclus de la publication Pages | ⚠️ **NON appliqué par ce projet** (mesuré, cache-busté) → voir §7.3 |
| Règles 404 `_redirects` | `_redirects` | Bloc 404 **supprimé** : Cloudflare Pages n'applique pas ce code (seuls 200/301/302/303/307/308) | — |
| `unsafe-eval` retiré | `_headers`, `firebase.json` | Aucun `eval()` / `new Function()` dans le code : la directive était inutile | ✅ (à confirmer après déploiement Pages) |
| En-têtes durcis | `_headers`, `firebase.json` | `Cross-Origin-Opener-Policy: same-origin-allow-popups`, `Cross-Origin-Resource-Policy: same-site`, `X-Permitted-Cross-Domain-Policies: none`, `manifest-src`, `worker-src`, `upgrade-insecure-requests` |
| `Access-Control-Allow-Origin: *` | `_headers` | Remplacé par l'origine explicite `https://smartswika.ma` |

**Vérification après déploiement** (doit renvoyer 404) :

```bash
for p in /docs/DETTES.md /package.json /.nvmrc /_headers; do
  printf "%s -> " "$p"; curl -s -o /dev/null -w "%{http_code}\n" "https://smartswika.ma$p"
done
```

> ⚠️ **Mesure du 2026-11-20 après déploiement** : sur `*.web.app` → **404 ✅**.
> Sur `smartswika.ma` (Cloudflare Pages) → **200 ❌** : le projet Pages ne prend pas en
> compte `.assetsignore` (testé avec cache-buster, `cf-cache-status: DYNAMIC`).
> **Action dashboard requise** (voir §7.3, règle WAF `internal-files-block`).

---

## 2. Firestore — legacy, règles, FinOps

1. **Produits « legacy » sans `status`** — `firestore.rules`
   - Ajout de `isPublicProduct()` : un produit **sans champ `status`** est
     désormais lisible (avant : invisible). Les produits avec un status autre
     que `approved` restent privés.
   - Script de migration : `scripts/migrate-products-approved.cjs`
     ```bash
     node scripts/migrate-products-approved.cjs --dry-run   # diagnostic
     node scripts/migrate-products-approved.cjs             # migration
     ```
   - ⚠️ Le client requête `where("status","==","approved")` : une fiche sans
     `status` reste donc invisible **tant que la migration n'est pas lancée**.

2. **Brouillons de blog** — `blog` : `allow read` limité à `status == 'published'`
   (+ admin). `js/blog.js` ne requêtait déjà que les publiés : aucune régression.

3. **Analytics** — `analytics_daily.visitors` plafonné à **5 000** entrées
   (au lieu de 20 000) : limite la croissance du document et le coût d'écriture.

4. **Coupons** — `get` reste public (nécessaire au `getDoc` du panier).
   Risque résiduel documenté dans les règles ; mitigation : codes non devinables
   (8+ caractères + suffixe aléatoire) et revalidation serveur complète.

5. **FinOps lectures clientes**
   - `js/products.js` : `limit(500)` + alerte au plafond.
   - `js/reviews.js` : `limit(50)` (public) / `limit(200)` (admin).

Déploiement : `firebase deploy --only firestore:rules`

---

## 3. Tunnel d'achat

1. **`/boutique` cassée** — `js/boutique.js`
   Sans `?v=<uid>`, la page affichait « Boutique introuvable ». Elle redirige
   maintenant vers `/#produits` (le catalogue complet avec filtres/tri/pagination).
   `boutique.html` passe en `noindex, follow` (vitrines vendeurs = contenu mince).
   Les liens de navigation « Boutique » de 5 pages pointent désormais vers `/#produits`.

2. **Achat 100 % lié à un compte** (décision produit)
   - Aucun achat hors compte : `panier.js` ouvre la modale de connexion,
     `createCustomerOrder` exige `Authorization: Bearer <idToken>`.
   - **WhatsApp redevient un canal de support uniquement** :
     - hero : « Commander via WhatsApp » → « Une question ? WhatsApp » ;
     - fiche produit : « Demander un conseil » ;
     - `js/whatsapp.js` : le message ne contient plus nom/téléphone/adresse
       (ce n'était pas une commande) mais une **demande d'information**.

---

## 4. Design system

| Correctif | Détail mesuré |
|---|---|
| Contrastes AA | `--gold` `#a57b2e` (3,56:1) → **`#8a6a24`** (4,67:1 sur fond, 5,04:1 en blanc). Nouveaux tokens `--gold-text`, `--success-text`, `--warning-text`, `--danger-text`, `--info-text` |
| CTA | Dégradé `#8a6a24 → #5f4315` : le libellé blanc passe AA sur **toute** la largeur |
| CLS | `@font-face` de secours avec `size-adjust` (Inter/Playfair/Cairo/Amiri) + hauteur du hero réservée → plus de reflow de 42 px |
| Cibles tactiles | `#langSelect` 19 → **44 px**, `.btn-account` 35 → **44 px**, `.banner-nav` 28 → **44 px**, `.favorite-btn` 26 → **44 px** (mobile) |
| RTL | **63 propriétés physiques converties en logiques** (`left`→`inset-inline-start`, `margin-right`→`margin-inline-end`, …) dans `style.css` (36) et `style-patches.css` (25). Vérification automatisée : **0 écart structurel** (chaque ligne modifiée est exactement un renommage de propriété). Les 3 motifs `left: 50%` + `translateX(-50%)` (centrage) sont laissés physiques volontairement. Les blocs `[dir="rtl"]` existants ne sont pas touchés. |
| Arabe | corps en **Cairo**, titres **Amiri** avec `line-height: 1.55/1.6` (contre 1,07 mesuré) |
| Lisibilité | plancher 13 px sur les textes secondaires mobiles |
| `@import` bloquant | supprimé ; Cairo + Amiri chargés via `<link>` sur les **16 pages** |

CSS republiés sous de nouveaux noms (cache `immutable` 1 an) :
`/css/style.99512ca6.css` et `/css/style-patches.eedbd878.css`.
Les anciennes copies (`style.2cf30d9d.css`, `style-patches.532754ed.css`) sont supprimées.

---

## 5. SEO technique

| Correctif | Détail |
|---|---|
| `robots.txt` | `Disallow: /js/` → **`Allow: /js/`** + `Allow: /css/` (Googlebot peut enfin rendre le catalogue) |
| Canonical / hreflang | nouveau `js/seo.js` : canonical propre (sans `utm_*`/`fbclid`), hreflang auto-cohérents (fr = URL nue, ar/en = `?lang=xx`) |
| JSON-LD produit | enrichi : `sku`, `itemCondition`, `shippingDetails` (frais + 1-3 jours), marque = vendeur réel |
| Soft-404 | `/produit?slug=inexistant` → `noindex, follow` + JSON-LD retiré |
| `og:url` | aligné sur la canonical |

> ⚠️ Les fiches produit restent rendues côté client (`/produit?slug=`).
> Pour une indexation **robuste**, l'étape suivante est un prérendu statique
> `/produit/{slug}` (voir §7, point 8).

---

## 6. Nouveautés produit (validées)

### `js/smart-widgets.js` — 4 modules, chargés par `js/app.js`

| Module | Comportement | Garde-fou |
|---|---|---|
| **Live Glass** | Halo doré qui suit le curseur sur chaque carte produit | désactivé sur `hover: none` (mobile) |
| **Comparateur** | Bouton « ⇄ Comparer » sur chaque carte, barre flottante, tableau jusqu'à 3 produits (prix, note, stock) | état en `localStorage`, aucun appel réseau |
| **Barre Koulchi** | Pastille dynamique : « Ajoutez 1 article pour −5 % », palier atteint, jauge | lit `getCart()` + `js/koulchi.js`, mise à jour sur `cart-updated` |
| **Quiz gadget** | Bouton « Trouve ton gadget en 30 s » dans le hero → 4 questions → 3 recommandations cliquables | scoring local sur les produits déjà chargés |

Chaque module est isolé dans un `try/catch` : une erreur ne peut pas bloquer
le catalogue, le panier ni le checkout.

### Import du catalogue — `scripts/import-products-csv.cjs`

Le blocage n°1 (collection `products` vide) dispose maintenant d'un outil
testé, avec **validation stricte** et mode à blanc :

```bash
node scripts/import-products-csv.cjs scripts/products-template.csv --dry-run
node scripts/import-products-csv.cjs mon-catalogue.csv            # création
node scripts/import-products-csv.cjs mon-catalogue.csv --update    # upsert
```

- colonnes obligatoires : `name_fr, price, category, koulchi_price, stock, sku` ;
- rejette une ligne si `koulchi_price >= price`, `price <= 0`, `stock < 0`,
  `sku < 6` caractères ou **doublon** de SKU/slug ;
- `status` est **forcé** à `approved` (jamais lu depuis le CSV) et aucun champ
  réservé (`salesCount`, `ratingAvg`, `ratingCount`) n'est écrit ;
- une seule lecture des fiches existantes (pas une par ligne), lots de 400.

Test réel effectué : gabarit 3 lignes → **3 valides, 0 rejetée** ; fichier
volontairement corrompu (5 lignes) → **1 valide, 4 rejetées**, exit 1, avec le
motif précis de chaque rejet.

### Dette technique traitée dans cette passe

- **Doublon de traduction supprimé** : `translations.d321cfa7.js` (174 858 o)
  était une copie **octet pour octet** de `translations.js`. Les 17 pages
  chargent désormais `/translations.js` (servi en `no-cache`) ; le doublon est
  supprimé. Plus aucun risque de divergence entre deux fichiers.

### Dette restante (assumée, non traitée volontairement)

- **Bundling** (`esbuild`) : non mis en place. Changer le pipeline de fichiers
  servis sans déploiement de validation aurait été risqué ; à planifier avec un
  environnement de recette.
- **Monolithes** : `admin.js` (261 Ko), `vendor-dashboard.js` (165 Ko),
  `orders.js` (128 Ko) — découpage à faire hors audit.
- **CSS inline** dans les pages (~77 Ko cumulés) — à externaliser après mise en
  place du build.

### `functions/vendor-score.js` — COD Score vendeur (prêt, non activé)

Calcule un score 0-100 (40 % livraison, 20 % retours, 25 % délai, 15 % avis)
et l'écrit dans `vendorsPublic/{uid}.codScore`.

**Volontairement non importé par `functions/index.js`** : aucun risque de
régression sur les fonctions de commande. Activation en 2 lignes :

```js
// fin de functions/index.js
const { registerVendorScore } = require('./vendor-score');
registerVendorScore({ db, FieldValue });
```

puis `firebase deploy --only functions`.

---

## 7. À FAIRE MANUELLEMENT (hors dépôt)

### 7.1 BLOQUANT — le catalogue est vide

`products` contient **0 document** dans `smartswi9a-31063`. Tant que le
catalogue n'est pas importé, la boutique reste vide, quel que soit le code.

1. Remplir `scripts/products-template.csv` (ou votre propre CSV) puis :
   ```bash
   node scripts/import-products-csv.cjs mon-catalogue.csv --dry-run   # validation
   node scripts/import-products-csv.cjs mon-catalogue.csv             # import
   ```
2. Lancer `node scripts/migrate-products-approved.cjs --dry-run` (diagnostic).
3. Vérifier en production : la grille doit afficher des cartes.

### 7.2 Déploiement

```bash
# Cloudflare Pages : se déclenche au push sur main (_headers / _redirects)
git push origin main

# Firebase (règles + hosting)
firebase deploy --only firestore:rules
firebase deploy --only hosting
```

### 7.3 Cloudflare (dashboard — non accessible via MCP)

| Réglage | Valeur cible | Pourquoi |
|---|---|---|
| SSL/TLS | **Full (strict)** | déjà annoncé dans `docs/DETTES.md` |
| HSTS | `max-age=31536000; includeSubDomains; preload` | la prod renvoie `15768000` (6 mois) : insuffisant pour la préliste |
| DNSSEC | activer | actuellement absent |
| Brotli | activé | vérifié : `content-encoding: br` ✔ |
| HTTP/3 | activé | `alt-svc h3` présent ✔ |
| `Access-Control-Allow-Origin: *` | **retirer la Transform Rule** dans le dashboard | `_headers` ne déclare plus aucun CORS (inutile pour des fichiers statiques same-origin) ; c'est la Transform Rule qui produit le `*` observé en production |
| **WAF — blocage des fichiers internes** | **Security → WAF → Custom rules → Create**<br>Nom : `internal-files-block`<br>Expression :<br>`(http.request.uri.path matches "^/(docs|scripts|tests|functions|cloudflare)(/|$)") or (http.request.uri.path in {"/package.json" "/package-lock.json" "/.nvmrc" "/firestore.rules" "/storage.rules" "/firestore.indexes.json" "/firestore-debug.log" "/Smartswi9a-site.code-workspace"})`<br>Action : **Block** | **Seul correctif efficace pour `smartswika.ma`** : `.assetsignore` n'est pas appliqué par ce projet Pages (mesuré) |
| **Visibilité du dépôt GitHub** | Passer le dépôt en **privé** (Settings → Danger Zone) ou déplacer `docs/` hors du dépôt | Le dépôt est **public** : `docs/AUDIT-CORRECTIONS-*.md` et `docs/DETTES.md` y sont déjà lisibles. Les exclure du site sans exclure GitHub ne suffit pas |

### 7.4 E-mail — cas particulier : **vous n'avez pas de boîte @smartswika.ma**

Vous utilisez `smartswi9a@gmail.com`. C'est parfaitement valable, mais cela
change la recommandation :

- **Le domaine n'envoie aucun e-mail** (aucun enregistrement MX) → **ne créez
  PAS de SPF/DKIM/DMARC pointant vers un serveur inexistant**. Un SPF
  `-all` sans serveur d'envoi est correct, mais inutile tant que rien n'est
  envoyé depuis `@smartswika.ma`.
- **À faire malgré tout (anti-usurpation, 2 min)** — empêche un tiers
  d'envoyer des e-mails « de votre marque » :
  ```
  TXT  @        "v=spf1 -all"
  TXT  _dmarc   "v=DMARC1; p=reject; rua=mailto:smartswi9a@gmail.com; fo=1"
  ```
  (`p=reject` est sûr **uniquement** parce qu'aucun service légitime n'envoie
  depuis ce domaine. Si vous ajoutez plus tard un expéditeur transactionnel,
  remplacez par `p=quarantine` et ajoutez son `include:` au SPF.)
- **CAA** : à ajouter seulement si vous savez qui émet vos certificats.
  Cloudflare Universal SSL → `issue "digicert.com"`, `issue "letsencrypt.org"`,
  `issue "pki.goog"` sont les émetteurs usuels.
- **Ne communiquez jamais** une adresse `@smartswika.ma` tant que la boîte
  n'existe pas : le site affiche déjà `smartswi9a@gmail.com` (footer, JSON-LD).

### 7.5 Firestore — robustesse

- Activer **PITR** (récupération à 7 jours) et **delete protection** :
  aujourd'hui `pointInTimeRecoveryEnablement: DISABLED` et
  `deleteProtectionState: DISABLED`. Une suppression accidentelle des
  commandes COD serait irréversible.

### 7.6 Coupons

Générer des codes de 8+ caractères avec suffixe aléatoire
(`BIENVENUE-7K3QX9`) : le `get` public reste nécessaire au panier.

### 7.7 Vérification Core Web Vitals après déploiement

```bash
npx lighthouse https://smartswika.ma --only-categories=performance,accessibility,seo --view
```

Cibles : CLS < 0,05 · contraste AA (0 violation axe) · cibles ≥ 44 px.

### 7.8 Étape suivante recommandée (non bloquante)

Prérendu des fiches produit en URLs statiques `/produit/{slug}` (générées au
build depuis Firestore) : c'est la seule façon d'indexer durablement un
catalogue sans SSR.

---

## 8. Vérifications effectuées sur cette passe

| Vérification | Résultat |
|---|---|
| `npm test` (30 suites) | **exit 0** |
| `firebase_validate_security_rules` (firestore) | **OK: No errors detected** |
| `node --check` sur 11 fichiers JS modifiés/créés | **tous OK** |
| `tests/i18n-keys.test.cjs` | 1003 clés × 3 langues, **0 manquante** |
| `tests/css-integrity.test.cjs` | 16/16 PASS |
| Navigateur (serveur local) — FR | `--gold: #8a6a24`, canonical + hreflang cohérents, quiz injecté, 0 erreur |
| Navigateur — AR | `dir=rtl`, **Cairo** appliqué, `line-height` 1,6, `?lang=ar` auto-canonique, 0 débordement |
| Carte produit factice | bouton comparateur injecté, halo `--mx/--my` alimenté |
| Quiz | ouverture, 4 options, bouton « Suivant » activé après sélection |
| `/produit?slug=zzz` | `noindex, follow`, JSON-LD absent, page « introuvable » |
| `/boutique.html` sans `v` | redirection effective vers `/#produits` |
| Import CSV (gabarit) | 3 valides / 0 rejetée, mapping FR/AR/EN + `oldPrice` corrects |
| Import CSV (fichier corrompu) | 1 valide / 4 rejetées, exit 1, motifs explicites |
| Conversion RTL (63 déclarations) | **0 écart structurel** (diff lexical automatisé) |
| RTL navigateur | favori à **gauche**, badge à **droite**, 0 débordement |
| Suggestion de pack | pastille « Ajoutez 2 article(s) pour −5 % » + « + Prise test · 105 MAD » (même catégorie, meilleure note) |
| `npm test` après conversion | **exit 0** |
| **Déploiement Firebase Hosting** | 120 fichiers, `release complete`, exit 0 |
| **Déploiement Firestore rules** | `compiled successfully` + `released rules`, exit 0 |
| **Prod `*.web.app`** | `/docs/DETTES.md` 404, `/package.json` 404, ancien CSS 404, nouveau CSS 200 |
| **Prod `smartswika.ma`** | `/boutique` → `/#produits` ✅, `--gold #8a6a24` ✅, quiz ✅, Cairo ✅, hreflang ✅, 0 erreur console |
| **Prod `smartswika.ma` — docs** | ⚠️ 200 (Pages) → règle WAF requise (§7.3) |

