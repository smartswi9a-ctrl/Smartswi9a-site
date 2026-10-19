# 🛍️ Smart Swi9a — E-commerce Tech Marocain

> Boutique en ligne de gadgets et objets connectés au Maroc.
> Site : [https://smartswi9a.top](https://smartswi9a.top)

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![Status](https://img.shields.io/badge/status-production-brightgreen)
![Firebase](https://img.shields.io/badge/firebase-100%25-orange)
![License](https://img.shields.io/badge/license-proprietary-red)

---

## 📋 Table des matières

- [1. Présentation](#1-présentation)
- [2. Historique du projet](#2-historique-du-projet)
- [3. Stack technique](#3-stack-technique)
- [4. Architecture générale](#4-architecture-générale)
- [5. Installation locale](#5-installation-locale)
- [6. Configuration](#6-configuration)
- [7. Déploiement](#7-déploiement)
- [8. Fonctionnalités](#8-fonctionnalités)
- [9. Sécurité](#9-sécurité)
- [10. Maintenance](#10-maintenance)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Roadmap](#12-roadmap)
- [13. Contact](#13-contact)
- [14. Licence](#14-licence)

---

## 1. Présentation

**Smart Swi9a** est une boutique e-commerce marocaine spécialisée dans les gadgets
tech, objets connectés et Smart Home. Le site propose :

- 🛒 **Commande via WhatsApp** — paiement à la livraison (COD)
- 🌍 **3 langues** — Français 🇫🇷, Arabe 🇲🇦, Anglais 🇬🇧
- 📱 **Responsive design** — optimisé mobile-first
- 🚚 **Livraison dans 240 villes marocaines** — frais fixes 30 DH
- ⚡ **Livraison rapide** — 24h à 72h selon région
- ⭐ **Système d'avis clients vérifiés** avec photos
- 🔔 **Notifications temps réel** (commande, livraison, avis)
- 📧 **Vérification email obligatoire** à l'inscription
- 🔵 **Connexion Google + Facebook** disponible
- 📝 **Blog dynamique** géré depuis l'admin
- 🛡️ **Sécurité complète** (Firebase Rules + CSP)
- 📦 **5 statuts de commande** avec timeline visuelle
- 📨 **Emails automatiques** à chaque changement de statut

### Chiffres clés

| Métrique | Valeur |
|---|---|
| **Villes couvertes** | 240 |
| **Frais de livraison** | 30 MAD (uniforme) |
| **Délais de livraison** | 24h à 72h selon région |
| **Réduction auto** | -5% à partir de 3 articles |
| **Annulation commande** | Possible pendant 4h |
| **Langues supportées** | 3 (FR/AR/EN) |
| **Statuts commande** | 5 |
| **Méthodes d'inscription** | 3 (OTP, Google, Facebook) |

---

## 2. Historique du projet

### Genèse

Smart Swi9a a été construit comme une boutique e-commerce moderne pour
le marché marocain, en utilisant une architecture **serverless** avec
un frontend ultra-léger.

### Phases majeures

| Phase | Description |
|---|---|
| **Phase 1-8** | MVP initial, fonctionnalités, sécurité, migration villes, tests |
| **Phase 9** | Migration complète vers Firebase Auth natif |
| **Phase 10** | Ajout connexion Google + Facebook |
| **Phase 11** | Vérification email obligatoire |
| **Phase 12** | Blog dynamique complet |
| **Phase 13** | Refonte 5 statuts de commande + emails automatiques |
| **Phase 14** | Optimisations design, SEO et accessibilité |

### État actuel (v2.0.0)

**Le site est 100% opérationnel et prêt pour la production.**

- ✅ Circuit client complet validé
- ✅ 100% Firebase (pas de dépendance externe pour l'auth)
- ✅ Sécurité Firebase Rules complète
- ✅ Migration Firestore des 240 villes effectuée
- ✅ Blog dynamique avec CRUD admin
- ✅ Vérification email obligatoire
- ✅ Google + Facebook Sign-In
- ✅ Système d'emails automatiques
- ✅ Déploiement avec domaine HTTPS

---

## 3. Stack technique

| Composant | Technologie |
|---|---|
| **Frontend** | HTML5, CSS3, JavaScript ES6 |
| **Backend** | Firebase (Google Cloud) |
| **Auth** | Firebase Authentication |
| **Base de données** | Firebase Firestore |
| **Stockage fichiers** | Firebase Cloud Storage |
| **Emails** | Firebase Auth natif + Trigger Email Extension |
| **Hébergement** | Cloudflare Workers |
| **Domaine** | smartswi9a.top (HTTPS) |
| **Design System** | CSS custom (thème or/glass) |
| **Polices** | Google Fonts |
| **Icônes** | SVG inline |

### Philosophie technique

- ❌ **Pas de framework** (React, Vue, Angular…)
- ❌ **Pas de build tool** (Webpack, Vite…)
- ✅ **Modules ES6 natifs** dans le navigateur
- ✅ **Firebase SDK via CDN** (importmap)
- ✅ **Vanilla JS** — plus léger, plus rapide, plus maintenable

**Pourquoi ce choix ?**
- Temps de chargement ultra-rapide (< 1s)
- Aucune dépendance npm à maintenir
- Code lisible et accessible à tout développeur JS
- Pas de régression cassée par des mises à jour de framework

---

## 4. Architecture générale

### Organisation haut niveau
