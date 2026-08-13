[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md)

# Codex SwitchBridge

**Passez facilement d'un compte Codex enregistré à un fournisseur d'API compatible avec Responses, conservez l'historique local des conversations dans les deux modes et consultez l'utilisation locale des jetons pour chaque sélection.**

Codex SwitchBridge met à jour les identifiants et le routage du fournisseur au cours d'une même opération protégée. Le mode compte et le mode fournisseur d'API compatible utilisent le même espace d'historique local. Changer le mode d'authentification de Codex ne sépare donc pas les nouvelles conversations en plusieurs chronologies.

L'extension VS Code ouvre dans la zone d'édition un tableau de bord graphique qui présente le mode actif, l'état de l'historique partagé, les échéances de réinitialisation des quotas et l'utilisation locale totale des jetons. Les comptes enregistrés et les fournisseurs d'API figurent ensemble dans une liste de routes plate. Les détails des jetons comprennent un graphique en anneau par source, tandis que le graphique orange regroupe les observations locales par jour, semaine ou mois. Le tableau de bord peut suivre la langue d'affichage de VS Code ou passer immédiatement de l'anglais au chinois simplifié.

## Aperçu de l'utilisation

Lorsque vous ouvrez la vue **Codex SwitchBridge** dans la barre d'activité, les comptes enregistrés et les fournisseurs d'API s'affichent au même niveau dans une liste plate **Accounts & API Routes**. Le tableau de bord s'ouvre ou reprend automatiquement le focus. Utilisez la liste pour gérer les comptes et les API, et le tableau de bord large pour consulter les quotas, les dates de réinitialisation, le changement automatique et l'historique local des jetons.

![Tableau de bord Codex SwitchBridge en anglais avec le thème sombre](./assets/screenshots/dashboard-en-dark.png)

Le même tableau de bord peut passer immédiatement au chinois simplifié :

![Tableau de bord Codex SwitchBridge en chinois simplifié avec le thème clair](./assets/screenshots/dashboard-zh-light.png)

Codex SwitchBridge fonctionne sous Windows, macOS et Linux. Vous pouvez l'utiliser depuis VS Code ou en ligne de commande.

[![Version GitHub](https://img.shields.io/github/v/release/ShawBob001/codex-switchbridge)](https://github.com/ShawBob001/codex-switchbridge/releases)
[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-install-007ACC)](https://marketplace.visualstudio.com/search?sortBy=Relevance&term=Codex%20SwitchBridge&target=VSCode)
[![Licence : MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Deux modes, un seul historique local des conversations

```text
Mode compte Codex  <->  Codex SwitchBridge  <->  Mode fournisseur d'API Responses
                               |
                    historique partagé sous CODEX_HOME
```

| Fonction | Comportement de SwitchBridge |
| --- | --- |
| Changement de compte et d'API | Applique les identifiants du compte sélectionné ou le profil du fournisseur d'API avec la configuration Codex correspondante |
| Historique partagé des conversations | Conserve les nouveaux fils locaux visibles dans les deux modes grâce à un même espace d'historique Codex |
| Utilisation locale des jetons | Indexe localement les compteurs des rollouts Codex, trace l'activité quotidienne, hebdomadaire ou mensuelle et répartit l'utilisation suivie par compte enregistré ou fournisseur d'API |
| Conservation de l'état | Enregistre les identifiants du compte ou du fournisseur que vous quittez avant d'appliquer le mode suivant |
| Transitions sûres | Sérialise les changements simultanés, écrit les données d'authentification de façon atomique et conserve des sauvegardes pour revenir en arrière |
| Gestion du rechargement | Affiche par défaut une action de rechargement non bloquante lorsque l'extension Codex doit lire le nouvel état d'authentification |

> L'historique partagé des conversations reste local à un seul `CODEX_HOME`. Il ne copie ni ne fusionne l'historique web de ChatGPT, les tâches Codex Cloud, les connecteurs, les quotas ou les conversations entre appareils.

## Démarrage rapide

### Extension VS Code

Recherchez l'extension sur le [Visual Studio Marketplace](https://marketplace.visualstudio.com/search?sortBy=Relevance&term=Codex%20SwitchBridge&target=VSCode), ou ouvrez la vue Extensions de VS Code et recherchez `Codex SwitchBridge`.

Pour une installation hors ligne, téléchargez le dernier fichier `.vsix` depuis les [versions GitHub](https://github.com/ShawBob001/codex-switchbridge/releases), puis lancez **Extensions: Install from VSIX...**. Vous pouvez aussi utiliser la commande ci-dessous dans un terminal. Remplacez VERSION par la version présente dans le nom du fichier téléchargé.

```bash
code --install-extension codex-switchbridge-VERSION.vsix
```

Ouvrez la vue **Codex SwitchBridge** dans la barre d'activité. La liste plate **Accounts & API Routes** place les comptes enregistrés et les fournisseurs d'API dans le même répertoire de la barre latérale. Le tableau de bord s'ouvre automatiquement ou revient au premier plan dans la zone d'édition centrale. L'action **Open Dashboard** de la barre de titre reste disponible comme solution de secours.

### CLI

Installez l'archive CLI depuis une version GitHub :

```bash
npm install --global ./codex-switchbridge-cli-0.3.0.tgz
codex-switchbridge --version
```

Une fois le paquet publié sur npm, installez-le depuis le registre :

```bash
npm install --global codex-switchbridge-cli
```

## Passer d'un compte à un fournisseur d'API

Dans VS Code, utilisez **Switch Account** ou **Switch API Provider**. SwitchBridge enregistre la sélection actuelle, met à jour `auth.json` et `config.toml`, puis actualise ses vues de comptes et de fournisseurs.

Depuis la CLI :

```bash
# Passer à un compte Codex enregistré
codex-switchbridge use work

# Passer à un fournisseur d'API enregistré compatible avec Responses
# L'historique local partagé est activé par défaut
codex-switchbridge mode team-api

# Conserver un historique propre au fournisseur si la compatibilité l'exige
codex-switchbridge mode team-api --separate-history
```

Pour revenir à un compte nommé, utilisez `codex-switchbridge use <name>`. Si `mode account` identifie un seul compte enregistré, il le restaure. Lorsque plusieurs comptes sont enregistrés, la CLI vous demande d'en choisir un avec `use <name>` au lieu d'en sélectionner un arbitrairement.

Un profil de fournisseur d'API contient les données d'authentification destinées à `auth.json` et la configuration du fournisseur destinée à `config.toml`. L'historique partagé exige `wire_api = "responses"` et une valeur `base_url` valide pour le fournisseur.

## Tableau de bord, réinitialisation des quotas et utilisation locale des jetons

Le tableau de bord VS Code lit les métadonnées de quota du compte et les événements cumulatifs `token_count` dans les fichiers de rollout Codex locaux du `CODEX_HOME` actuel. Il affiche :

- le pourcentage restant pour chaque fenêtre de quota renvoyée par le service de comptes, notamment les limites de 5 heures, de 7 jours et les limites nommées ;
- chaque réinitialisation disponible sous la forme d'un compte à rebours actualisé à la seconde ;
- la même échéance en heure locale, avec les secondes et le décalage horaire ;
- l'horodatage UTC exact fourni par le service, avec les millisecondes lorsqu'elles sont présentes ;
- le nombre de réinitialisations de limite gagnées et disponibles lorsque le service de comptes fournit cette donnée ;
- une action **Use one reset** avec confirmation pour le compte actuel lorsqu'une réinitialisation gagnée peut être utilisée ;
- les jetons enregistrés au total, en entrée, en sortie, en entrée mise en cache et en sortie de raisonnement ;
- les totaux attribués et non attribués ;
- l'utilisation et le nombre de sessions pour chaque compte et fournisseur d'API ;
- un graphique en anneau par source qui compare les totaux mutuellement exclusifs des comptes, des fournisseurs d'API et des données non attribuées ;
- un graphique orange quotidien, hebdomadaire ou mensuel avec des filtres de source et de date ;
- le total, la moyenne, le pic et l'estimation d'utilisation pour la plage sélectionnée ;
- la couverture de l'index, le nombre de sessions, le début du suivi et l'heure de la dernière actualisation.

Les horloges de réinitialisation utilisent en priorité l'horodatage absolu renvoyé par le service de quotas. Si seul un compte à rebours relatif est disponible, SwitchBridge calcule l'horodatage correspondant au moment de la requête. Les métadonnées absentes, non valides ou déjà échues sont signalées clairement. Le compte à rebours est recalculé d'après l'horloge système et s'actualise sans recharger tout le tableau de bord. Les requêtes de quota et le renouvellement des jetons OAuth utilisent d'abord `codex-switchbridge.proxy`, puis le paramètre `http.proxy` de VS Code et enfin les variables `HTTPS_PROXY`, `HTTP_PROXY` ou `ALL_PROXY` de l'hôte d'extension. La résolution des variables d'environnement continue de respecter `NO_PROXY`. Ce paramètre propre à la machine est exclu de la synchronisation des paramètres. VS Code stocke sa valeur dans les paramètres locaux. Préférez donc un proxy local sans authentification ou protégez le fichier des paramètres machine si l'URL contient des identifiants.

Dans l'en-tête du tableau de bord, le sélecteur de langue propose **Auto**, **English** et **简体中文**. Le mode Auto suit la langue d'affichage de VS Code. Un choix explicite est enregistré dans les paramètres de la fenêtre et s'applique sans recharger VS Code.

L'action de réinitialisation utilise la méthode officielle de Codex App Server. Elle vérifie que le même compte enregistré est toujours actif, demande une confirmation, consomme au plus une réinitialisation gagnée à l'aide d'une clé d'idempotence, puis actualise le quota. Si la version installée de Codex ne prend pas en charge cette consommation, SwitchBridge ouvre la page officielle Usage.

Les entrées et les sorties composent le total enregistré. Les entrées mises en cache sont déjà comprises dans les entrées, tout comme les sorties de raisonnement sont déjà comprises dans les sorties. Ces deux valeurs ne sont donc pas ajoutées une seconde fois. Le graphique en anneau utilise uniquement des totaux attribués par source qui ne se chevauchent pas. Il ne compte donc pas deux fois les entrées mises en cache ou les sorties de raisonnement.

L'attribution par sélection commence lorsque SwitchBridge démarre le suivi local. L'index affecte ensuite chaque augmentation de jetons au compte ou au fournisseur d'API actif lorsque Codex l'a enregistrée, y compris lorsqu'une conversation se poursuit après un changement de mode. Les anciennes sessions partagées `openai` ne peuvent pas être associées de façon sûre à une entrée enregistrée précise. Elles restent dans la catégorie **Earlier or unattributed**. Les anciennes sessions étiquetées avec un fournisseur sont attribuées uniquement si leur identifiant correspond exactement à un seul profil enregistré.

Le service de comptes fournit un pourcentage restant, et non un nombre absolu de jetons disponibles. Le graphique d'historique repose sur les compteurs d'activité locaux de l'appareil. Il ne représente ni la facturation, ni les coûts, ni un solde distant. Les anciennes activités indexées dont la date ne peut pas être déterminée précisément sont indiquées comme des estimations. Les activités sans date fiable restent hors du graphique. Les profils de fournisseurs d'API ne présentent que les compteurs locaux, sauf si le fournisseur propose une API de quota compatible. SwitchBridge ne téléverse pas le contenu des rollouts. Son index local conserve des compteurs, des horodatages, des empreintes de fichiers et des identifiants opaques, sans enregistrer le texte des conversations, les chemins, les libellés des comptes, les noms des fournisseurs ou les identifiants secrets. Utilisez **Refresh Local Token Usage** pour réindexer immédiatement. Sinon, l'extension le fait pendant sa maintenance normale en arrière-plan.

## Fonctionnement de l'historique partagé

Codex regroupe normalement les fils locaux par fournisseur de modèle. Un identifiant de fournisseur personnalisé peut donner l'impression que des fils ont disparu lorsque vous revenez au mode compte, même si leurs fichiers existent toujours.

SwitchBridge évite cette séparation pour les nouveaux fils :

1. Le mode compte utilise le fournisseur `openai` intégré à Codex.
2. Un fournisseur d'API compatible avec Responses conserve cette même identité d'historique pendant que SwitchBridge applique sa clé d'API et son URL de base.
3. Le retour au mode compte restaure les identifiants du compte et la route OpenAI d'origine.

Les deux modes lisent ainsi le même historique local dans le même `CODEX_HOME`. SwitchBridge synchronise la route utilisée pour indexer l'historique. Il ne copie pas le texte des conversations après chaque changement.

L'historique partagé est activé par défaut dans l'extension VS Code et lors des changements de fournisseur compatibles effectués depuis la CLI. Dans VS Code, contrôlez ce comportement avec `codex-switchbridge.shareHistoryAcrossProviders`.

### Réparer les anciens fils étiquetés par fournisseur

Les fils créés avant l'utilisation du routage partagé peuvent encore porter un identifiant propre à leur fournisseur. Pour les intégrer à l'historique local partagé :

1. Arrêtez toute génération Codex en cours.
2. Exécutez **Codex SwitchBridge: Repair Shared Conversation History**.
3. Une fois la réparation terminée, utilisez l'action **Reload recommended** de la barre d'état.

La commande de réparation crée des sauvegardes, modifie uniquement les champs d'identité du fournisseur, valide les enregistrements JSONL et SQLite, et s'arrête si un rollout change pendant l'inspection. L'activation de l'extension ne réécrit jamais l'historique. Python 3 est nécessaire uniquement pour cette commande de maintenance.

Consultez [Historique des conversations entre les modes](./docs/shared-history.md) pour connaître le périmètre exact et les contrôles de sécurité.

## Fonctionnalités

- Changement en un clic entre les comptes Codex locaux ou synchronisés et les fournisseurs d'API dans VS Code
- Une liste plate de routes dans la barre latérale, avec les comptes enregistrés et les fournisseurs d'API au même niveau
- Changement de compte ou de fournisseur d'API en une commande depuis la CLI
- Historique local partagé pour les routes de fournisseurs compatibles avec Responses
- Tableau de bord large dans l'éditeur avec quotas graphiques, horloges de réinitialisation précises, utilisation des réinitialisations gagnées, graphique en anneau par source et historique local des jetons filtrable par jour, semaine ou mois
- Changement à chaud entre l'anglais et le chinois simplifié dans le tableau de bord, avec commandes et paramètres VS Code traduits
- Affichage des quotas de compte, renouvellement des jetons et maintenance périodique en arrière-plan
- Stockage local ou via la synchronisation des paramètres VS Code pour les comptes et fournisseurs enregistrés
- Chiffrement facultatif des données d'authentification enregistrées
- Importation et exportation des comptes enregistrés
- Réparation avec sauvegarde préalable des anciens fils locaux étiquetés par fournisseur
- Verrouillage des changements entre fenêtres et instantanés de restauration

## Commandes CLI

| Commande | Description |
| --- | --- |
| `codex-switchbridge add <name>` | Exécute `codex login` et enregistre le résultat sous forme de compte nommé |
| `codex-switchbridge list` | Répertorie les comptes et les fournisseurs d'API enregistrés |
| `codex-switchbridge use <name>` | Passe à un compte enregistré et restaure le mode compte |
| `codex-switchbridge mode [name]` | Affiche le mode actuel ou passe à un fournisseur d'API avec l'historique partagé par défaut |
| `codex-switchbridge mode <name> --separate-history` | Passe à un fournisseur d'API avec un historique local propre à ce fournisseur |
| `codex-switchbridge remove <name>` | Supprime un compte enregistré |
| `codex-switchbridge quota [name]` | Affiche l'utilisation du quota d'un compte |
| `codex-switchbridge current` | Affiche le compte ou le mode fournisseur d'API actuel |
| `codex-switchbridge refresh [name]` | Renouvelle le jeton d'accès d'un compte |
| `codex-switchbridge export [file]` | Exporte les comptes enregistrés au format JSON |
| `codex-switchbridge import <file>` | Importe des comptes enregistrés depuis un fichier JSON |

Utilisez `--auth-dir <path>` ou `CODEX_SWITCHBRIDGE_AUTH_DIR` pour placer les entrées enregistrées hors du répertoire Codex par défaut. Utilisez `--password` ou `CODEX_SWITCHBRIDGE_PASSWORD` pour déverrouiller les entrées chiffrées.

## Paramètres VS Code

| Paramètre | Valeur par défaut | Description |
| --- | --- | --- |
| `codex-switchbridge.language` | `auto` | Suit la langue de VS Code ou utilise l'anglais ou le chinois simplifié dans le tableau de bord |
| `codex-switchbridge.proxy` | `""` | Proxy HTTP(S) propre à la machine pour les requêtes de quota et le renouvellement des jetons OAuth. Exclu de la synchronisation des paramètres. Une valeur vide utilise les paramètres du proxy de VS Code et de l'hôte d'extension |
| `codex-switchbridge.shareHistoryAcrossProviders` | `true` | Maintient les nouvelles conversations locales accessibles entre le mode compte et les modes de fournisseurs d'API compatibles |
| `codex-switchbridge.reloadWindowAfterSwitch` | `statusBar` | Affiche une action de rechargement, n'envoie jamais de notification ou recharge automatiquement après un changement |
| `codex-switchbridge.quotaRefreshInterval` | `30` | Vérifie un compte enregistré à chaque intervalle pour la maintenance des jetons et l'actualisation des quotas |
| `codex-switchbridge.tokenAutoUpdate` | `true` | Renouvelle les jetons des comptes enregistrés pendant la maintenance en arrière-plan lorsqu'ils ont expiré ou approchent de leur expiration |
| `codex-switchbridge.showStatusBar` | `true` | Affiche la sélection actuelle, le quota, l'utilisation des jetons et les recommandations de rechargement dans la barre d'état |
| `codex-switchbridge.authDirectory` | `""` | Stocke les entrées locales enregistrées dans ce répertoire. Une valeur vide utilise le répertoire Codex par défaut |

## Sécurité des données et des changements

Les comptes locaux utilisent `auth_{name}.json`. Les fournisseurs d'API locaux utilisent `provider_{name}.json`. VS Code peut aussi conserver des entrées chiffrées dans le stockage synchronisé de l'extension.

Avant qu'un changement n'écrase le fichier `auth.json` actif, SwitchBridge réenregistre les derniers identifiants du compte ou du fournisseur que vous quittez dans l'entrée correspondante. Il met ensuite à jour l'authentification, le routage du fournisseur et l'état de la route d'historique partagé sous un seul verrou interprocessus. Les fichiers d'authentification sont remplacés de façon atomique. En cas d'échec, les instantanés sont restaurés.

La consultation des quotas et l'indexation locale des jetons sont des opérations en lecture seule. Elles ne renouvellent pas les jetons, ne réécrivent pas les données d'authentification enregistrées et ne modifient pas les fichiers de conversation. La maintenance des jetons est une opération distincte.

Certains outils Codex mettent l'authentification en cache au démarrage. SwitchBridge ne peut pas forcer un autre processus d'extension à supprimer ce cache. Il peut donc rester nécessaire de recharger la fenêtre VS Code après un changement de fichiers réussi. Par défaut, cette recommandation reste dans la barre d'état au lieu de provoquer des fenêtres contextuelles répétées.

N'exécutez pas **Codex Account Switch** et Codex SwitchBridge en même temps. Les deux extensions écrivent dans les mêmes fichiers Codex locaux.

## Développement

```bash
npm install
npm run build
npm run verify
```

Les tests visuels du tableau de bord nécessitent également Playwright Chromium et ses dépendances système sous Linux :

```bash
npx playwright install --with-deps chromium
npm run test:visual -w packages/vscode
```

Sur les images Linux minimales sans `/etc/fonts/fonts.conf`, vous devez fournir une configuration Fontconfig valide à l'aide de `FONTCONFIG_FILE` et `FONTCONFIG_PATH`. Sans cela, Chromium ne peut ni mesurer ni afficher le texte.

Organisation du projet :

```text
packages/
  core/     Logique partagée d'authentification, de routage des fournisseurs et de l'historique, des quotas et du stockage
  cli/      Interface en ligne de commande
  vscode/   Extension VS Code
scripts/    Outils de maintenance de l'historique et de publication
docs/       Notes sur l'architecture, le comportement et le déploiement
```

Les procédures de publication sont décrites dans [Déploiement](./docs/deployment.md).

## Origine et licence

Codex SwitchBridge est un projet open source indépendant dérivé de [jqknono/codex-account-switch](https://github.com/jqknono/codex-account-switch), avec des modifications importantes apportées par `ShawBob001`.

Le projet est distribué sous [licence MIT](./LICENSE). L'avis de droit d'auteur et le texte de licence du projet d'origine sont conservés.
