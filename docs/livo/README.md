# Documentation Livo — dossier d'audit

Ce dossier centralise la **documentation technique** ET les **données de
référence** de Livo (le prestataire de livraison). Il complète `docs/api/` qui
contient les spécifications OpenAPI d'origine.

## Contenu

| Fichier | Taille | Objet |
|---|---|---|
| `livo-api-entrepot.yaml` | 106 Ko | Spec OpenAPI 3.0.3 (source client) |
| `livo-api-entrepot.json` | 140 Ko | Même spec, format JSON |
| `fees-livo.json` | 33 Ko | **Grille tarifaire live — 404 villes** |
| `README.md` | — | Ce fichier |

## `fees-livo.json` — grille tarifaire de référence

Produit par `node scripts/import-livo-fees.cjs` à partir de l'endpoint
**public** `GET https://rest.livo.ma/fees/public` (aucune clé API requise).

```json
{
  "source": "https://rest.livo.ma/fees/public",
  "fetched_at": "2026-11-16T19:01:32.751Z",
  "request_date": "<valeur brute renvoyée par Livo>",
  "count": 404,
  "cities": [ { "key": "casablanca", "name": "casablanca", "fee": 20 } ]
}
```

**Répartition constatée au 2026-11-16 :**

| Tarif | Nb villes |
|---|---|
| 20 DH | 1 |
| 29 DH | 13 |
| 30 DH | 1 |
| 35 DH | 28 |
| 39 DH | 50 |
| 40 DH | 29 |
| 43 DH | 1 |
| **45 DH** | **280** |
| 47 DH | 1 |

Tarifs clés : Casablanca **20**, Rabat/Marrakech/Agadir/Fès/Tanger **35**,
Oujda/Safi/Dakhla/Laâyoune **45**. La majorité des villes est donc à **45 DH**.

## ⚠️ Écart critique avec `villes.json` (audit 2026-11-16)

`node scripts/audit-livo-fees.cjs` compare les deux référentiels :

| Constat | Valeur |
|---|---|
| Villes `villes.json` | 240 |
| Villes Livo | 404 |
| Prix identiques | **0** |
| **Sous-facturées** (perte sèche) | **126** |
| Sur-facturées | 2 |
| Villes du site absentes de Livo (clé brute) | 112 |

**Le site affiche 30 DH pour des villes coûtant 45 DH chez Livo** → −15 DH par
commande sur 126 villes. À arbitrer : aligner `villes.json` sur cette grille
avec une marge explicite, ou documenter la marge par zone.

> Les 112 « absentes » peuvent majoritairement relever d'un simple écart
> d'orthographe (`khemisset` vs `khemis rmila`) : à traiter par correspondance
> floue avant de conclure à une non-desserte.

## Contraintes Livo issues de la spec

| Contrainte | Valeur | Conséquence |
|---|---|---|
| Timeout webhook | **10 s** | au-delà = échec compté |
| Désactivation auto | **50 échecs consécutifs** | sync des statuts coupée |
| Rate limit | **5 req/s** | boucles de sync → `429` |
| Pagination liste | 500 max | 404 villes passent, marge faible |
| Signature webhook | `HMAC-SHA256(timestamp.body)` | anti-replay < 5 min |

Statuts Livo : `draft`, `pending`, `in progress`, `fulfilled`, `problem`,
`cancelled`, `awaiting transfer`, `awaiting pickup`, `reported`, `programmed`.
`problem` et `reported` ne sont **pas** mappés dans `js/config.js`
(`LIVO_STATUS_MAP`) — décision métier à trancher.

## Scripts associés

| Script | Rôle | Réseau |
|---|---|---|
| `scripts/import-livo-fees.cjs` | Rafraîchit `fees-livo.json` | Oui (GET public) |
| `scripts/audit-livo-fees.cjs` | Compare Livo ↔ `villes.json` | Oui (GET public) |

## Règle de sécurité

> ⚠️ **Aucun secret dans ce dossier.**
>
> Ne jamais écrire ici : `LIVO_WEBHOOK_SECRET`, `LIVO_API_KEY`, `LIVO_CLIENT_ID`.
>
> Rotation : `docs/runbooks/ROTATION-SECRET-LIVO.md`. Les secrets vivent dans
> `wrangler secret put` (Worker `livo-proxy`) et Firebase Secret Manager
> (`livoWebhook`).

## Références

- `docs/api/livo-entrepot.json`, `docs/api/api-entrepôt-livo.yaml`
- `docs/api/livo-webhook.md` — contrat webhook, architecture de réception
- `docs/runbooks/ROTATION-SECRET-LIVO.md`
- `js/config.js` — `LIVO_STATUS_MAP`, `LIVO_SYNCABLE_STATUSES`
- `functions/index.js` — `livoWebhook`, `getLivoFees`, `syncLivoCities`

