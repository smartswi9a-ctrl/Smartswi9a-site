# Runbook — TTL Firestore sur `presence`

**Objet** : purge automatique des battements de présence (`presence/{visitorId}`)
sans fonction planifiée, sans code serveur, sans coût récurrent.

**État** : politique active depuis le 2026-11-19 sur le projet
`smartswi9a-31063`, collection `presence`, champ `expireAt`.

---

## Comment ça fonctionne

1. `js/analytics.js` écrit, à chaque battement (60 s, onglet visible) :
   - `lastSeen: serverTimestamp()` — sert à calculer « en ligne » (< 5 min) ;
   - `expireAt: now + 7 jours` — sert **uniquement** à la purge.
2. Firestore considère un document expiré quand `expireAt` est dépassé.
3. La politique TTL le supprime **généralement dans les 24 h** qui suivent
   (la suppression n'est pas instantanée, c'est documenté par Google).

**Pourquoi un champ dédié** : le TTL Firestore prend la valeur du champ comme
date d'expiration, sans décalage possible. Mettre le TTL sur `lastSeen`
rendrait chaque document « déjà expiré » et pourrait supprimer un visiteur
actif entre deux battements. `expireAt` garantit 7 jours de marge.

**Garde-fous** :
- `firestore.rules` n'accepte `expireAt` que s'il est un timestamp **futur**
  et **< 8 jours** ; un client ne peut donc pas créer un document éternel.
- Le champ reste **optionnel** : un onglet resté ouvert avec l'ancien JS
  pendant le déploiement continue d'écrire sans être bloqué.
- L'admin lit `presence` avec `limit(300)` et calcule « en ligne » côté
  client (`computeOnline`, seuil 5 min) : la suppression TTL ne change aucun
  calcul.

---

## Créer / vérifier la politique

### Option A — API REST (utilisée ici, sans gcloud installé)

```powershell
$cfg = Get-Content "$env:USERPROFILE\.config\configstore\firebase-tools.json" -Raw | ConvertFrom-Json
$token = $cfg.tokens.access_token
$uri = "https://firestore.googleapis.com/v1/projects/smartswi9a-31063/databases/(default)/collectionGroups/presence/fields/expireAt?updateMask=ttlConfig"
$headers = @{ Authorization = "Bearer $token"; "x-goog-user-project" = "smartswi9a-31063" }
Invoke-RestMethod -Method Patch -Uri $uri -Headers $headers -ContentType "application/json" -Body '{"ttlConfig":{}}'
```

### Option B — gcloud (si installé)

```powershell
gcloud firestore fields ttls update expireAt --collection-group=presence --enable-ttl --project=smartswi9a-31063
```

### Vérifier

```powershell
gcloud firestore fields ttls list --collection-group=presence --project=smartswi9a-31063
```

ou, via REST :

```powershell
Invoke-RestMethod -Uri $uri.Replace("?updateMask=ttlConfig","") -Headers $headers
```

La réponse doit contenir `ttlConfig` avec un état `ACTIVE` (ou `CREATING`
juste après la création).

---

## Désactiver (rollback)

```powershell
gcloud firestore fields ttls update expireAt --collection-group=presence --disable-ttl --project=smartswi9a-31063
```

Sans gcloud : même appel REST avec `{"ttlConfig":null}`.

Le rollback n'affecte pas les documents déjà supprimés ; il arrête seulement
les suppressions futures. Aucun autre composant ne dépend de `expireAt`.

---

## Documents antérieurs au 2026-11-19

Les documents créés avant l'ajout du champ n'ont pas `expireAt` : Firestore
ne les expire pas tant qu'ils ne sont pas réécrits. Un visiteur qui revient
les met à jour et le champ est ajouté. Pour les nettoyer une fois pour
toutes, un backfill (Admin SDK ou console) peut poser
`expireAt = lastSeen + 7 jours` sur les documents qui n'en ont pas.

---

## Ce que ce runbook ne couvre pas

`analytics_daily` **n'a volontairement pas de TTL** : ces documents alimentent
le graphique 12 mois, et le volume est négligeable (~1 doc/jour). Une purge
mal dimensionnée supprimerait l'historique.
