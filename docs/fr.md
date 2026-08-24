# Transports en Commun Lyonnais

Faites entrer le réseau lyonnais dans Gladys : les prochains passages aux
arrêts que vous empruntez, les vélos et les places libres de vos stations
Vélo'v, et les places disponibles dans les parcs relais TCL.

Tous les appareils créés par cette intégration sont en **lecture seule** : ils
publient ce que disent les flux open data, et rien n'est jamais renvoyé au
réseau.

## Ce que vous obtenez

Un appareil par entrée listée dans la configuration.

**Arrêt** — pour chacun des prochains passages (jusqu'à cinq, à votre choix) :

| Fonctionnalité            | Contenu                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Prochain passage          | Minutes d'attente (`999` quand rien n'est annoncé)                                     |
| Ligne du prochain passage | `T1 → IUT Feyssine` (le préfixe `~` signale un horaire théorique et non un temps réel) |
| Prochains passages        | Tout le tableau sur une ligne, pratique en tuile de tableau de bord                    |

**Station Vélo'v**

| Fonctionnalité                | Contenu                                                 |
| ----------------------------- | ------------------------------------------------------- |
| Vélos disponibles             | Vélos prêts à être loués                                |
| Vélos électriques disponibles | Part électrique, quand le flux la détaille              |
| Places disponibles            | Bornettes libres pour reposer un vélo                   |
| Occupation                    | Part des bornettes occupées par un vélo, en pourcentage |
| Statut                        | `OK`, `no bike available`, `Out of service`…            |

**Parc relais (P+R)**

| Fonctionnalité         | Contenu                                                |
| ---------------------- | ------------------------------------------------------ |
| Places disponibles     | Places voitures libres                                 |
| Places PMR disponibles | Places réservées PMR libres, quand elles sont publiées |
| Occupation             | Part de la capacité occupée, en pourcentage            |

## Configuration

### 1. Compte Data Grand Lyon (arrêts et parcs relais uniquement)

Vélo'v fonctionne sans rien configurer : son flux est totalement ouvert.

Les passages et l'occupation des parcs relais proviennent des jeux de données
temps réel TCL hébergés sur [data.grandlyon.com](https://data.grandlyon.com),
qui nécessitent un compte gratuit.

> **Le mot de passe demandé ici n'est pas celui de connexion au portail.** Vous
> naviguez sur le portail avec GrandLyon Connect (l'authentification unique
> commune à tous les services de la Métropole), mais le service web appelé par
> cette intégration n'accepte qu'un mot de passe propre à la plateforme de
> données. Saisir le mot de passe GrandLyon Connect donne « Data Grand Lyon a
> refusé les identifiants ».

1. Créez un compte, ou connectez-vous, sur
   [GrandLyon Connect](https://moncompte.grandlyon.com/login/).
2. Rendez-vous sur
   [votre profil de la plateforme de données](https://data.grandlyon.com/onegeo-login/fr/profile/)
   et définissez le mot de passe de la plateforme. Il peut — et devrait — être
   différent de celui de GrandLyon Connect.

   Le formulaire s'intitule « Changer votre mot de passe » et réclame un
   **ancien mot de passe**. Si vous n'avez jamais utilisé que GrandLyon
   Connect, vous n'en avez aucun — et le mot de passe GrandLyon Connect n'est
   pas accepté ici non plus. Déconnectez-vous du portail : la page de profil
   renvoie alors vers la connexion propre à la plateforme de données, où le
   lien **Mot de passe oublié ?** envoie par email un lien de définition du
   mot de passe, sans avoir à connaître le précédent. Le mot de passe ainsi
   défini est celui à saisir dans l'intégration.

3. Dans la configuration de l'intégration, renseignez l'**identifiant** (en
   général l'adresse email de votre compte) et ce **mot de passe de la
   plateforme**.
4. Appuyez sur **Tester le compte Data Grand Lyon** : le bouton indique combien
   de parcs relais ont pu être lus.

Laissez les deux champs vides si vous ne surveillez que des stations Vélo'v.

### 2. Indiquez ce que vous voulez surveiller

Les trois champs de liste acceptent des entrées séparées par des virgules, des
points-virgules ou des retours à la ligne. Inutile de chercher les identifiants
sur un site : les boutons en bas de l'écran de configuration les cherchent pour
vous.

**Arrêts** — `<identifiant>[@<ligne>[|<ligne>…]][:<nom personnalisé>]`

| Entrée                | Signification                                 |
| --------------------- | --------------------------------------------- |
| `1234`                | Tous les passages à l'arrêt 1234              |
| `1234@T1`             | Uniquement la ligne T1                        |
| `1234@C3\|C13`        | Les lignes C3 et C13                          |
| `1234@T1:Tram en bas` | Uniquement T1, appareil nommé « Tram en bas » |

Surveiller deux fois le même arrêt avec deux filtres de lignes différents crée
deux appareils — un par ligne, ce qui est généralement ce que l'on veut sur un
tableau de bord.

Appuyez sur **Chercher un arrêt** et tapez un nom (par exemple `Bellecour`)
pour obtenir les identifiants à coller.

**Stations Vélo'v** — `<identifiant ou nom>[:<nom personnalisé>]`

`10063`, `Hotel de Ville`, ou `10063:Bureau`. Appuyez sur **Chercher une
station Vélo'v** pour chercher par nom.

**Parcs relais** — `<identifiant ou nom>[:<nom personnalisé>]`

`Gorge de Loup`, `SOI`, ou `Parilly:Trajet boulot`. Les identifiants sont de
courts codes en majuscules (`SOI`, `BON`, `GREY`…), et le nom fonctionne tout
aussi bien. Appuyez sur **Lister les parcs relais** pour voir tous les parcs
avec leur identifiant et leur occupation — les 22, y compris ceux que le SYTRAL
ne compte pas en temps réel, affichés avec « ? » places libres. Ils donnent
quand même un appareil utile : leur capacité est publiée, pas leur comptage.

### 3. Fréquences de rafraîchissement

Chaque source a son propre intervalle, car elles ne bougent pas à la même
vitesse :

| Réglage                           | Défaut | Ce qu'il pilote                            |
| --------------------------------- | ------ | ------------------------------------------ |
| Rafraîchissement des passages     | 60 s   | Les décomptes de chaque arrêt surveillé    |
| Rafraîchissement Vélo'v           | 120 s  | Les vélos et places disponibles            |
| Rafraîchissement des parcs relais | 300 s  | Les places libres de chaque parc surveillé |

Les trois acceptent de 30 s à 3600 s. Descendre sous 60 s n'apporte rien : les
flux sources sont eux-mêmes recalculés environ toutes les minutes, donc une
interrogation plus rapide renvoie les mêmes chiffres tout en consommant votre
quota Data Grand Lyon. Gladys, de son côté, ne déclenche jamais moins d'une
fois par minute : un intervalle supérieur à 60 s est respecté par
l'intégration, qui ignore simplement les déclenchements intermédiaires.

L'intégration groupe aussi ses requêtes : surveiller dix stations Vélo'v coûte
deux requêtes HTTP par cycle, pas vingt, et surveiller cinq parcs relais en
coûte deux.

### 4. Enregistrez

Enregistrez la configuration, puis ouvrez l'onglet **Découverte** : vos arrêts,
stations et parcs y sont, prêts à être ajoutés à Gladys.

## Idées d'automatisations

- Me notifier à 8h en semaine avec les prochains passages à mon arrêt.
- Si la station Vélo'v près du bureau a moins de 3 places libres à l'heure où
  je pars, m'envoyer une alerte.
- Si mon parc relais habituel est rempli à plus de 90 % à 7h30, me rappeler de
  prendre le tram à la place.

## Dépannage

**« Les arrêts et parcs relais nécessitent un compte Data Grand Lyon »** — le
statut de l'intégration reste rouge parce que vous avez listé un arrêt ou un
parc sans renseigner les identifiants. Ajoutez-les, ou retirez les entrées.

**« Ancien mot de passe » demandé alors que je n'en ai jamais défini** — le
formulaire de la page de profil sert à _changer_ un mot de passe existant, et
un compte créé via GrandLyon Connect n'en a pas. Déconnectez-vous du portail,
retournez sur
[data.grandlyon.com/onegeo-login/fr/profile/](https://data.grandlyon.com/onegeo-login/fr/profile/)
— vous arrivez sur la connexion de la plateforme de données — et utilisez
**Mot de passe oublié ?** avec l'adresse email du compte. Le lien reçu par
email définit le mot de passe de la plateforme sans ancien mot de passe.

**« Data Grand Lyon a refusé les identifiants »** — neuf fois sur dix, le mot
de passe saisi est celui de GrandLyon Connect. Le service web attend le mot de
passe que vous définissez sur
[data.grandlyon.com/onegeo-login/fr/profile/](https://data.grandlyon.com/onegeo-login/fr/profile/),
avec l'adresse email de votre compte comme identifiant. Définissez-le là-bas,
collez-le ici, puis appuyez sur **Tester le compte Data Grand Lyon**. Si l'appel
échoue encore, le compte n'a peut-être pas confirmé son adresse email.

**« Data Grand Lyon a répondu HTTP 404 »** — votre compte n'est pas en cause :
c'est le jeu de données qui n'est plus publié sous le nom demandé. La Métropole
renomme ses couches TCL à chaque évolution du réseau (d'où le suffixe `_2_0_0`
dans le message). L'intégration essaie tous les noms qu'elle connaît, puis
demande au catalogue de la plateforme comment le jeu de données s'appelle
aujourd'hui et utilise ce nom : la plupart des renommages se réparent donc tout
seuls, sans mise à jour. Quand le catalogue lui-même n'a rien, le message liste
ce qui a été essayé et les noms voisins réellement publiés : ouvrez un ticket
avec, une mise à jour de l'intégration suffira.

**« Tester le compte Data Grand Lyon » signale un jeu de données illisible** —
le bouton teste les trois jeux de données séparément, et c'est la première
ligne qui compte : si elle dit que votre compte a été accepté, vos identifiants
sont bons. Une seule ligne `✖` signifie que ce jeu de données a été retiré (voir
ci-dessus) ; les fonctions basées sur les deux autres continuent de marcher.

**« Data Grand Lyon n'a pas répondu en ... »** — la plateforme a mis trop de
temps, en général pendant le téléchargement de l'annuaire complet des arrêts
pour **Chercher un arrêt**. Relancez le bouton : le premier téléchargement
réussi est gardé en mémoire pendant une heure, et les recherches suivantes sont
immédiates. Saisir le nom complet de l'arrêt (`Bellecour` plutôt que `belle`)
évite complètement ce téléchargement.

**Un arrêt affiche toujours `999`** — `999` signifie « aucun passage annoncé ».
Hors des heures de service, c'est normal. Si cela persiste en journée,
l'identifiant d'arrêt est probablement faux (ou le filtre de lignes ne
correspond jamais, par exemple `@T1` sur un arrêt uniquement desservi par des
bus) : relancez **Chercher un arrêt**.

**Une station Vélo'v ou un parc relais est en erreur à chaque relève** —
l'identifiant n'existe pas dans le flux. Relancez le bouton de recherche
correspondant et collez l'identifiant qu'il retourne.

**J'ai collé un identifiant et l'écran Découverte reste vide** — l'écran
Découverte ne liste que ce que l'intégration a publié, et elle publie à
l'**enregistrement** de la configuration, pas à la saisie d'un champ.
Enregistrez la configuration, puis lisez le statut de l'intégration juste
au-dessus : il détaille désormais ce qui est surveillé (« Connecté. Surveille
1 arrêt — ils apparaissent dans l'écran Découverte »). S'il dit autre chose, ou
si votre entrée manque au décompte, la valeur n'est pas arrivée jusqu'à
l'intégration : vérifiez que le champ a bien été enregistré, puis relancez la
recherche depuis l'écran Découverte. Les logs disent la même chose à chaque
publication : `Publishing 1 device(s): Bellecour`.

L'intégration journalise tout ce qu'elle fait : consultez les logs de
l'intégration depuis l'interface Gladys, avec `LOG_LEVEL=debug` pour le détail
complet (chaque requête sortante y est tracée).

## Sources de données et crédits

- [Prochains passages TCL](https://data.grandlyon.com/portail/fr/jeux-de-donnees/prochains-passages-reseau-transports-commun-lyonnais-rhonexpress-disponibilites-temps-reel/info)
  — Métropole de Lyon / SYTRAL, sur Data Grand Lyon.
- [Disponibilités des parcs relais TCL](https://data.grandlyon.com/portail/fr/jeux-de-donnees/parcs-relais-reseau-transports-commun-lyonnais-disponibilites-temps-reel/info)
  — Métropole de Lyon / SYTRAL, sur Data Grand Lyon.
- [Disponibilités Vélo'v](https://transport.data.gouv.fr/datasets/velos-libre-service-lyon-velov-disponibilite-en-temps-reel)
  — Métropole de Lyon / JCDecaux, publiées au format
  [GBFS](https://gbfs.org/documentation/reference/).

Intégration non officielle, sans lien avec SYTRAL Mobilités, Keolis Lyon ou
JCDecaux.
