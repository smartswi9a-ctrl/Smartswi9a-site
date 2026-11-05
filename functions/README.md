Authentification vendeur Smart Swi9a

Cette fonction ajoute un mot de passe vendeur distinct, stocké uniquement sous forme de hash bcrypt dans vendorCredentials/{uid}. La connexion vendeur accepte le mot de passe vendeur ou le mot de passe Firebase acheteur. Un vendeur en attente peut se connecter pour consulter son statut ; un vendeur approuvé avec un ancien contrat peut se connecter uniquement pour le re-signer. Les droits métier exigent role == vendor, status == approved, contractStatus == accepted et contractVersion == 1.4.0.


Déploiement


Depuis le dossier du site, vérifier le projet Firebase : firebase use smartswi9a-31063.

Installer les dépendances : cd functions && npm install.

Déployer les fonctions et l'hébergement : cd .. && firebase deploy --only functions,hosting.

Déployer toutes les ressources Firebase avec firebase deploy --only functions,hosting,firestore:rules,firestore:indexes,storage.

Dans Firebase Console > Authentication > Settings, vérifier que l'authentification par e-mail/mot de passe est activée.

Après déploiement, faire les tests décrits ci-dessous.


Tests indispensables avant production


Inscription vendeur avec une nouvelle adresse : mot de passe acheteur et vendeur distincts.

Inscription vendeur avec une adresse acheteur existante : mot de passe acheteur valide requis, puis définition du mot de passe vendeur.

Compte vendeur pending : les deux mots de passe ouvrent uniquement l'écran d'attente.

Compte vendeur rejected/suspended : les deux mots de passe doivent être refusés.

Compte vendeur approved avec contrat 1.3.0 ou ancien : connexion limitée à l'écran de re-signature 1.4.0.

Compte vendeur approved avec contrat 1.4.0 : les deux mots de passe ouvrent le dashboard.

Compte admin et compte acheteur ordinaire : aucun accès vendeur.

Tester depuis https://smartswika.ma et https://www.smartswika.ma si les deux domaines sont utilisés.


Sécurité

Ne jamais rendre vendorCredentials lisible depuis le navigateur. La collection est bloquée par les règles Firestore. Configurez Firebase App Check et une limitation de tentatives (par exemple Cloud Armor / API Gateway) avant une mise en production publique. N'enregistrez jamais de mots de passe en clair dans les logs ou Firestore.



Migration des commandes vendeurs existantes

Après le déploiement des fonctions, un administrateur doit exécuter POST /api/backfillVendorOrderViews avec un jeton Firebase valide dans Authorization: Bearer. Le corps accepte pageSize (maximum 100) et cursor. Répéter l'appel avec nextCursor jusqu'à ce que complete soit true. La migration est idempotente et crée une vue privée par vendeur sans exposer les articles des autres boutiques. Elle doit être terminée avant de considérer l'historique vendeur comme entièrement migré.

Contrôles automatisés

Le workflow GitHub Actions exécute node --check, valide les fichiers JSON et lance les tests d'autorisation Firestore/Storage dans les émulateurs Firebase. Un déploiement de production ne doit pas être lancé si le workflow échoue.
