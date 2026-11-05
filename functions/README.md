Authentification vendeur Smart Swi9a

Cette fonction ajoute un mot de passe vendeur distinct, stocké uniquement sous forme de hash bcrypt dans vendorCredentials/{uid}. La connexion vendeur accepte le mot de passe vendeur ou le mot de passe Firebase acheteur, mais délivre un jeton seulement si users/{uid}.role == vendor et users/{uid}.vendorInfo.status == approved.


Déploiement


Depuis le dossier du site, vérifier le projet Firebase : firebase use smartswi9a-31063.

Installer les dépendances : cd functions && npm install.

Déployer les fonctions et l'hébergement : cd .. && firebase deploy --only functions,hosting.

Déployer les règles Firestore modifiées avec firebase deploy --only firestore:rules.

Dans Firebase Console > Authentication > Settings, vérifier que l'authentification par e-mail/mot de passe est activée.

Après déploiement, faire les tests décrits ci-dessous.


Tests indispensables avant production


Inscription vendeur avec une nouvelle adresse : mot de passe acheteur et vendeur distincts.

Inscription vendeur avec une adresse acheteur existante : mot de passe acheteur valide requis, puis définition du mot de passe vendeur.

Compte vendeur pending/rejected/suspended : les deux mots de passe doivent être refusés pour le dashboard.

Compte vendeur approved : les deux mots de passe doivent ouvrir le dashboard.

Compte admin et compte acheteur ordinaire : aucun accès vendeur.

Tester depuis https://smartswika.ma et https://www.smartswika.ma si les deux domaines sont utilisés.


Sécurité

Ne jamais rendre vendorCredentials lisible depuis le navigateur. La collection est bloquée par les règles Firestore. Configurez Firebase App Check et une limitation de tentatives (par exemple Cloud Armor / API Gateway) avant une mise en production publique. N'enregistrez jamais de mots de passe en clair dans les logs ou Firestore.

