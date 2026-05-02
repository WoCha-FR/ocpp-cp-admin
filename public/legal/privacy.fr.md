# Politique de confidentialité

*Dernière mise à jour : à compléter*

> Ce document est générique. Pour l'adapter à votre situation, copiez-le dans `config/legal/privacy.fr.md` et modifiez-le.

## Responsable du traitement

Cette application est exploitée par **[Nom de l'opérateur]**.  
Contact : [adresse e-mail de contact]

## Données collectées

### Données d'authentification

Lors de l'authentification via Google, les informations suivantes sont transmises et enregistrées :

- Adresse e-mail
- Nom d'affichage
- Identifiant Google (ID unique)

Si vous utilisez l'authentification locale (mot de passe), un hash de votre mot de passe est stocké. Le mot de passe en clair n'est jamais conservé.

Lors d'une demande de réinitialisation de mot de passe, un token à usage unique est généré et transmis par e-mail. Ce token est valide 30 minutes. Pour la configuration initiale du mot de passe à la création du compte, le token est valide 24 heures. Ces tokens ne sont pas stockés en clair.

### Données de compte

Les informations suivantes sont enregistrées par l'application lors de la gestion de votre compte :

- Rôle attribué (administrateur, gestionnaire ou utilisateur) — défini par un administrateur
- Sites supervisés auxquels vous avez accès et votre rôle sur chacun — défini par un administrateur
- Préférence de langue
- Date de création du compte
- Date et heure de la dernière connexion

### Tokens RFID et historique de recharge

Si un ou plusieurs tokens RFID (ou autres identifiants de charge) vous sont attribués par un administrateur, les informations suivantes sont enregistrées et associées à votre compte :

- Identifiant(s) du ou des tokens (RFID, code, adresse MAC, etc.)
- Historique des sessions de recharge démarrées avec ces tokens : borne utilisée, connecteur, date et heure de début et de fin, énergie consommée, puissance mesurée, raison d'arrêt

Ces données ne sont enregistrées que lorsqu'un token vous est explicitement assigné. Les sessions initiées sans token identifié ne sont pas rattachées à votre profil.

### Notifications push (si activées)

Si vous activez les notifications push dans votre navigateur, les données suivantes sont enregistrées :

- Identifiant d'abonnement push
- Clé de chiffrement de la notification (fournie par votre navigateur)
- Agent utilisateur (user-agent) du navigateur au moment de l'abonnement
- Préférences de notification par type d'événement

Un historique des notifications envoyées (type, horodatage) est également conservé.

### Notifications Pushover (si activées)

Si vous configurez des notifications via Pushover, les données suivantes sont enregistrées dans votre compte et transmises à l'API Pushover lors de l'envoi de notifications :

- Clé utilisateur Pushover
- Jeton d'appareil Pushover

Pushover est un service tiers soumis à sa propre politique de confidentialité. L'utilisation de cette fonctionnalité implique un transfert de données vers les serveurs de Pushover.

### Emails envoyés par l'application

L'application utilise un serveur SMTP pour envoyer des e-mails dans les situations suivantes :

- Réinitialisation de mot de passe (lien à usage unique, valide 30 minutes)
- Configuration initiale du mot de passe lors de la création du compte (valide 24 heures)
- Notification d'ajout, suppression, suspension ou réactivation d'accès à un site
- Alertes d'événements liés aux bornes supervisées ou aux sessions de recharge (si activées dans vos préférences)

Ces e-mails sont envoyés à l'adresse associée à votre compte. Aucune donnée n'est transmise à un prestataire tiers au-delà du relais SMTP configuré par l'opérateur.

## Finalité du traitement

Les données collectées sont utilisées pour les finalités suivantes :

- **Authentification** : vérifier l'identité des utilisateurs autorisés et maintenir leur session
- **Gestion des accès** : contrôler les droits d'accès aux sites et aux bornes supervisées
- **Supervision de l'infrastructure** : gérer et surveiller les bornes de recharge OCPP
- **Envoi de notifications** : alerter les utilisateurs d'événements liés aux bornes et aux sessions de recharge
- **Récupération d'accès** : permettre la réinitialisation sécurisée d'un mot de passe oublié

Vos données ne sont ni vendues, ni partagées avec des tiers à des fins commerciales, ni utilisées à des fins de profilage ou de marketing.

## Accès restreint

Cette application **ne propose pas d'inscription autonome**. L'accès est accordé uniquement sur invitation d'un administrateur ou d'un gestionnaire autorisé. Vos données ne sont traitées que si vous avez été expressément invité à utiliser ce service.

## Base légale

Le traitement est fondé sur l'intérêt légitime de l'opérateur à sécuriser l'accès à son infrastructure de supervision de bornes de recharge.

## Durée de conservation

Vos données sont conservées tant que votre compte est actif dans l'application. Elles sont supprimées à votre demande ou sur décision de l'administrateur système.

## Vos droits (RGPD)

Conformément au Règlement Général sur la Protection des Données (RGPD), vous disposez des droits suivants :

- **Accès** : obtenir une copie de vos données
- **Rectification** : corriger des données inexactes
- **Suppression** : demander l'effacement de vos données
- **Opposition** : vous opposer au traitement

Pour exercer ces droits, contactez l'administrateur système à : [adresse e-mail de contact]

## Cookies et sessions

L'application utilise un cookie de session sécurisé (`httpOnly`, durée 24 h) afin de maintenir votre authentification. Ce cookie référence une session stockée côté serveur dans une base de données locale — aucune donnée de session n'est conservée dans le navigateur. Aucun cookie de traçage ou publicitaire n'est utilisé.

## Contact

Pour toute question relative à la protection de vos données : [adresse e-mail de contact]
