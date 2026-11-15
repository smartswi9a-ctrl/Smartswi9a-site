# Runbook — Migration `shipping` → `in_transit`

| Champ | Valeur |
|---|---|
| Script | `scripts/backfill-shipping-to-in-transit.cjs` |
| PR | 8.7 (cloture sur donnees de la dette 8.6) |
| Nature | One-shot, idempotent, sans deploiement |
| Perimetre | Collection `orders`, documents dont `status === 'shipping'` |

## Pourquoi

La PR 8.6 a ajoute `'shipping': 'in_transit'` a `STATUS_MIGRATION_MAP`.
`normalizeOrderStatus()` **masque** donc la valeur legacy a la lecture, mais la
donnee Firestore reste `shipping` indefiniment. Ce script fait la migration
physique : c'est la vraie cloture de la dette 8.6 sur les donnees.

## Prerequis

1. `firebase-admin` installe en dependance de developpement :

   ```bash
   npm install --save-dev firebase-admin
   ```

2. Cle de service Firebase (projet `smartswi9a-31063`) :

   ```
   C:/Users/hp/firebase-admin-key.json
   ```

   Emplacement different possible via `--key <chemin>`. Le script refuse de
   demarrer si le `project_id` du fichier ne correspond pas a `smartswi9a-31063`.

## Commandes

Toujours dans cet ordre :

```bash
# 1. Simulation (defaut, AUCUNE ecriture)
node scripts/backfill-shipping-to-in-transit.cjs --dry-run

# 2. Ecriture reelle
node scripts/backfill-shipping-to-in-transit.cjs --apply

# 3. Verification : doit annoncer 0 commande a migrer
node scripts/backfill-shipping-to-in-transit.cjs --dry-run
```

Options :

| Option | Effet |
|---|---|
| *(aucune)* | Simulation implicite — aucune ecriture |
| `--dry-run` | Simulation explicite (redondant avec le defaut) |
| `--apply` | **Ecriture reelle**. Obligatoire pour migrer |
| `--limit=N` | Traite au plus `N` commandes |
| `--key <chemin>` | Fichier de cle de service |
| `--help` | Aide |

## Comportement

- **Idempotent de par sa requete** : la collecte ne ramene que les documents
  encore en `shipping`. Apres une migration, elle ne ramene plus rien, donc un
  second `--apply` ecrit **0 document**. C'est un no-op legitime, pas une erreur.
- **Simulation par defaut** : sans `--apply`, aucune ecriture, quelles que soient
  les autres options.
- **Pagination par curseur** (`startAfter` sur `__name__`), pas d'offset :
  utilisable sur un gros volume.
- **Aucun index composite** requis : filtre sur le seul champ `status`, index
  mono-champ automatique cote Firestore.
- **Ecriture par lots de 100**. Si un lot echoue, le script le signale puis
  reprend **document par document** pour isoler les coupables et sauver les
  autres : une erreur sur un document n'interrompt pas la migration.
- **Log par identifiant court** (8 caracteres) pour chaque document traite.

## Effet exact sur les documents

Champs ecrits, et eux seuls :

```js
{
  status:       'in_transit',       // remplace 'shipping'
  migratedAt:   <timestamp serveur>, // tracabilite de la migration
  migratedFrom: 'shipping'          // d'ou venait le document
}
```

> **`updatedAt` n'est JAMAIS ecrit.** Idem pour `createdAt` et
> `trackingStartedAt`. Voir la section suivante : c'est une exigence financiere,
> pas un detail.

## Pourquoi `updatedAt` ne doit pas etre touche (CRITIQUE)

`resolveCreditUnlockBase()` (`functions/index.js`) determine la date d'ancrage du
chrono de deblocage des fonds vendeur, dans cet ordre :

1. `trackingStartedAt` (ancre nominale : prise en charge reelle par Livo)
2. `createdAt` (repli documente)
3. `updatedAt` (dernier repli)

`updatedAt` n'est donc sollicite **que si `trackingStartedAt` ET `createdAt`
sont tous deux absents** — cas d'un import historique sans date de creation.

Si ce backfill touchait `updatedAt` sur une telle commande, l'ancre de secours
financiere serait **repoussee a la date de la migration**, ce qui **retarderait
le deblocage des fonds vendeur**. C'est un bug financier silencieux : il ne
casse rien visiblement, il paie juste les vendeurs plus tard.

C'est la raison du choix retenu (option B de la PR 8.7) : tracabilite complete
via `migratedAt` / `migratedFrom`, et `updatedAt` strictement intact. Le test
T3 de `tests/backfill-shipping.test.cjs` verifie cette propriete par assertion
stricte sur la valeur, pas par confiance dans le code.

## Apres execution

- Verifier dans la console que `orders` ne contient plus aucun `status: 'shipping'`.
- L'admin affichait deja ces commandes en `in_transit` (remappage a la lecture)
- elles restent affichees a l'identique, mais la valeur en base est desormais
  correcte. Un clic **Sync** sur ces commandes cesse de retourner `updated:false`.

## Archivage

> **Archiver ce runbook apres execution reussie en production.**
> Le script reste versionne pour l'historique et pour un eventuel nouveau cycle
> de migration, mais le runbook n'a plus vocation a rester actif une fois la
> migration passee : le laisser trainer fait croire qu'il reste des choses a
> migrer.
