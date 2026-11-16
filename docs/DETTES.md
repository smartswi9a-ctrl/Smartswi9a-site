# Dettes techniques ouvertes - Smart Swi9a

## Dette 8.11 - SHIPPING residuel (js/config.js + js/orders.js)

**Etat** : gelee et documentee dans js/config.js (commentaire GELE 2026-11-16).

**Probleme** : ORDER_STATUS.SHIPPING est encore dans LIVO_SYNCABLE_STATUSES,
et des setters actifs dans js/orders.js (L1017/1022/1023) creent encore ce statut.

**Ne PAS retirer SHIPPING du sync avant** d'avoir migre les setters orders.js,
sinon bug silencieux : commandes en SHIPPING jamais synchronisees vers Livo.

**Fix complet** : refactor machine a etats de js/orders.js + retrait SHIPPING
de LIVO_SYNCABLE_STATUSES + tests de non-regression.

**Effort** : ~2h. **Priorite** : basse (backfill = 0 shipping en base).

---

## Dette 8.12 - RESOLUE le 2026-11-16 : generate-sitemap.cjs : migration + gestion erreur async

**Etat** : RESOLUE (PR #66). Migration v14 + gestion async ADC + timeout 10s appliquee.

Ancien etat : rollback de la migration v14. Le fichier utilise encore l'API v9
(admin.apps, admin.credential.*), supprimee en firebase-admin v14.
Crash sync attrape par le caller, degradation a 10 URLs statiques + exit 1.

**Migration testee puis rollbackee** : migration vers firebase-admin/app +
firebase-admin/firestore expose un bug plus profond : applicationDefault()
crash async dans google-auth-library via processTimers hors await chain
-> unhandled rejection -> crash process.

**Fix complet** : migration v14 + gestion explicite erreur async
(try/catch autour getFirestore() avec timeout ADC, ou check
GOOGLE_APPLICATION_CREDENTIALS avant init, fallback propre a []).
Tests a couvrir : ADC present / service account present / aucun credentials.

**Effort** : ~30 min. **Priorite** : basse (script local, pas en prod).

---

## Dettes cosmetiques (non prioritaires)

- js/navbar.js : 15 occurrences de var -> const/let (auto-fixable ESLint)
- 580 console.log en prod (bruyant, aucun bug)
- 232 innerHTML= dans admin.js/app.js (rendu interne, verifie non-XSS)

---

**Reference** : audit PowerShell complet du 2026-11-16 (tag v8.10.0).
---

## Cloudflare - Audit du 2026-11-16

**Etat** : Audite et securise.

- **SSL/TLS** : Mode Full (strict) active (correction appliquee).
- **HSTS** : Active (max-age 6 mois, includeSubDomains, preload, nosniff).
- **WAF Custom** : Regle active pour bloquer l'acces aux fichiers sensibles (/firebase.json, /.gitignore, /.github/, etc.).
- **WAF Manage** : Plan gratuit. Le *Free Managed Ruleset* est actif par defaut. Les rulesets OWASP/Managed avances necessitent un plan payant (hors scope).
- **DNS** : Tous les enregistrements (smartswika.ma, www, ideos) sont proxies.
- **DNSSEC** : Desactive (optionnel, necessite configuration chez le registrar).
