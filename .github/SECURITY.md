# Politique de securite

## Versions supportees

Seule la branche `main` recoit des correctifs de securite.

| Version | Supportee |
|---------|-----------|
| main (8.x+) | Oui |
| < 8.0 | Non |

## Signaler une vulnerabilite

**Ne pas ouvrir d'issue publique pour une vulnerabilite.**

Envoyez un email a smartswi9a@gmail.com avec :

- Description de la vulnerabilite
- Etapes de reproduction
- Impact estime (confidentialite / integrite / disponibilite)
- Version ou commit concerne

## Engagement

- Accuse de reception sous 72h ouvrees
- Evaluation initiale sous 7 jours
- Correctif selon severite : critique 7j, haute 14j, moyenne 30j

## Scope

Inclus :
- Code source de ce depot
- Configuration Firebase (rules, functions, hosting)
- Worker Cloudflare `livo-proxy`
- Site en production `smartswika.ma`

Exclus :
- Vulnerabilites dans les dependances tierces (signaler en amont)
- Ingenierie sociale
- Deni de service (DoS)