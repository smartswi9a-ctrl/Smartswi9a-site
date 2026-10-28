Corrections authentification vendeur — Smart Swi9a

Cette archive contient uniquement les fichiers complets concernés par l'inscription et la connexion vendeur, la signature du contrat, les règles Firestore et le chemin du dashboard.


Fichiers à remplacer à la racine du site


firebase.json

firestore.rules

vendor-login.html

vendor/dashboard.html (le dossier Vendor/ a été renommé en minuscules vendor/)

js/vendor-signup.js

js/vendor-dashboard.js

functions/index.js

functions/package.json


Le lien « Espace vendeur » est déjà présent dans le index.html du ZIP d'origine : aucun remplacement de ce fichier n'est nécessaire.


Corrections principales


L'inscription permet à un profil acheteur existant de déposer une demande vendeur en attente, sans lui permettre de s'approuver lui-même.

Le mot de passe vendeur indépendant reste stocké uniquement sous forme de hash bcrypt dans vendorCredentials/{uid}.

La connexion vendeur accepte le mot de passe vendeur ou le mot de passe Firebase de l'acheteur, mais délivre un jeton seulement si le profil est approuvé et le contrat accepté.

La connexion vendeur applique une limitation persistante des tentatives : 8 échecs maximum par adresse/IP sur 15 minutes.

La signature du contrat peut être créée par son propriétaire, mais le navigateur ne peut plus modifier directement vendorInfo.contractStatus. Une Cloud Function vérifie le document et met à jour le profil.

Le chemin est uniformisé en vendor/dashboard.html, sensible à la casse sur l'hébergement.

functions/ est exclu de l'hébergement statique.


Déploiement

Depuis le dossier racine du dépôt Firebase :


firebase use smartswi9a-31063
cd functions
npm install
cd ..
firebase deploy --only functions,firestore:rules,hosting

Vérifier dans la console Firebase que l'authentification e-mail/mot de passe est activée. Le déploiement des fonctions peut demander des autorisations IAM et une API de facturation active.


Tests à effectuer avant production


Inscription avec un nouvel e-mail : création du profil pending, mot de passe vendeur défini, contrat enregistré.

Inscription avec un e-mail acheteur existant : le mot de passe acheteur est vérifié et l'UID acheteur est conservé.

Profil vendeur pending/rejected/suspended : aucun accès dashboard.

Profil approuvé avec contrat accepté : connexion avec les deux mots de passe.

Acheteur ordinaire et administrateur : pas d'accès vendeur non autorisé.

Tentatives erronées répétées : blocage temporaire.

Signature et re-signature du contrat depuis l'inscription et depuis le dashboard.

Vérifier le site sous https://smartswi9a.top et https://www.smartswi9a.top si les deux domaines sont utilisés.


Limite importante : commandes

Les règles continuent de refuser la création directe de orders/{orderId} par le navigateur. C'est volontaire : le panier actuel est côté client et les montants/stock ne doivent pas être approuvés sans vérification serveur. Pour rétablir la validation de commande, il faut créer et tester un endpoint de commande qui valide le prix, le stock, les frais, les vendeurs et l'idempotence. Ne pas remplacer cette règle par allow create: if signedIn().


Cette archive a été contrôlée statiquement (syntaxe JavaScript et JSON). Elle n'a pas été déployée ni testée sur le projet Firebase réel ; exécuter les tests ci-dessus et idéalement Firebase Emulator avant la mise en production.

