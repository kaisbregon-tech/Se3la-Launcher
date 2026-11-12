# Launcher SEL3A : le guide complet

Ce guide t'explique tout, étape par étape, même si tu débutes.
Tu peux t'arrêter à l'étape 2 pour voir le launcher tourner tout de suite (mode démo).

---

## Ce qu'il y a dans le dossier

```
sel3a-launcher/
├── launcher.config.js     ← LE fichier à modifier (nom, couleurs, clés Firebase, liens…)
├── GUIDE.md               ← ce guide
├── package.json           ← la "carte d'identité" du projet (nom, version, commandes)
├── PUBLIER.bat            ← double-clic : met le launcher et les jeux en ligne pour tout le monde
├── CONSTRUIRE-LE-LAUNCHER.bat ← double-clic : construit le launcher sur ton PC (pour essayer)
├── jeux/                  ← en ligne : manifest et actus de chaque jeu (envoyés par PUBLIER.bat)
├── tools/github-workflow.yml ← la recette avec laquelle GitHub construit et publie le launcher
├── src/
│   ├── main/              ← le "cerveau" : comptes, téléchargements, zips, lancement des jeux
│   ├── renderer/          ← l'interface (HTML / CSS / JS)
│   │   └── assets/        ← ton logo (icone.png), ton image de fond (fond.jpg), jeux/ (images des autres jeux)
│   └── preload.js         ← le pont sécurisé entre l'interface et le cerveau
├── tools/publier.js       ← ce que fait PUBLIER.bat (GitHub)
├── tools/publier-jeu.js   ← mettre un jeu sur ton propre serveur (étape 6)
├── demo/news.json         ← les actus affichées en mode démo
├── demo/midnight-city.json ← les patch notes de Midnight City
├── exemple-serveur/       ← un modèle de news.json pour ton serveur
├── build/icon.png         ← l'icône du .exe du launcher
└── tests/                 ← tests automatiques (npm test)
```

---

## Étape 1 : installer les outils (une seule fois)

1. Installe **Node.js** (version « LTS ») : https://nodejs.org
   Garde les options par défaut pendant l'installation.
2. (Conseillé) Installe **Visual Studio Code** pour modifier les fichiers : https://code.visualstudio.com
3. **Redémarre ton PC** (pour que Windows trouve Node.js).

Pour vérifier : ouvre le menu Démarrer, tape `cmd`, ouvre l'Invite de commandes et écris :

```
node -v
```

Si un numéro s'affiche (ex : `v22.x.x`), c'est bon.

---

## Étape 2 : lancer le launcher (mode démo)

1. Dézippe le dossier `sel3a-launcher` où tu veux (ex : `Documents\sel3a-launcher`).
2. Ouvre ce dossier dans VS Code (**Fichier → Ouvrir le dossier**), puis ouvre un terminal :
   **Terminal → Nouveau terminal**.
3. Tape ces deux commandes (la première prend une ou deux minutes, une seule fois) :

```
npm install
npm start
```

🎉 Le launcher s'ouvre ! Il est en **MODE DÉMO** (badge orange en haut) :
tu peux créer un compte avec n'importe quel email, mais rien n'est enregistré sur Internet.
Pour que les vrais comptes fonctionnent, fais l'étape 3.

> Astuce : pour fermer le launcher lancé avec `npm start`, ferme simplement la fenêtre.

---

## Étape 3 : les comptes joueurs avec Firebase (gratuit)

Firebase est un service de Google qui stocke les comptes de tes joueurs de façon sécurisée.

1. Va sur https://console.firebase.google.com et connecte-toi avec ton compte Google.
2. Clique sur **Créer un projet**, appelle-le par exemple `sel3a`.
   (Google Analytics : tu peux le désactiver, pas besoin.)
3. Dans le menu de gauche : **Créer / Build → Authentication → Commencer**.
4. Onglet **Mode de connexion (Sign-in method)** :
   - clique sur **Adresse e-mail/Mot de passe** → active le premier interrupteur → **Enregistrer** ;
   - clique sur **Ajouter un fournisseur** → **Google** → active → choisis ton email d'assistance → **Enregistrer**.
5. Récupère ta clé : clique sur la **roue ⚙️ → Paramètres du projet**, onglet **Général**.
   En bas, dans « Vos applications », clique sur l'icône **`</>`** (Web), donne un nom (ex : `launcher`),
   ne coche pas Hosting, puis **Enregistrer l'application**.
   Firebase t'affiche un bout de code : copie la valeur de **`apiKey`** (elle commence par `AIza...`).
6. Ouvre `launcher.config.js` et colle-la :

```js
firebase: {
  apiKey: 'AIzaSy...ta_clé...',
},
```

7. Relance le launcher (`npm start`). Le badge MODE DÉMO a disparu : crée un compte,
   puis regarde dans Firebase → **Authentication → Users** : ton joueur apparaît ! ✅

> ℹ️ Cette clé `apiKey` n'est **pas un secret** : c'est normal qu'elle soit dans le launcher.
> Ce qui protège les comptes, ce sont les mots de passe et les règles de Firebase.

---

## Étape 4 : le bouton « Continuer avec Google »

Pour une application de bureau, Google demande d'ouvrir le **navigateur** du joueur
(c'est plus sûr : le launcher ne voit jamais le mot de passe Google).
Le launcher s'occupe de tout ; il te faut juste un « identifiant client ».

1. Va sur https://console.cloud.google.com et, en haut, **sélectionne le même projet** que Firebase (`sel3a`).
2. Menu ☰ → **API et services → Identifiants**
   (ou **Google Auth Platform → Clients**, selon la version de la page).
3. **Créer des identifiants → ID client OAuth**.
   - Type d'application : **Application de bureau** (⚠️ pas « Application Web »)
   - Nom : `Launcher SEL3A` → **Créer**.
4. Copie l'**ID client** et le **Code secret du client** dans `launcher.config.js` :

```js
google: {
  clientId: '1234567890-abc...apps.googleusercontent.com',
  clientSecret: 'GOCSPX-...',
},
```

5. **Ouvre l'accès à tout le monde** : **Google Auth Platform → Audience** (ou « Écran de consentement OAuth »)
   → **Publier l'application**. Sinon, seuls les comptes ajoutés en « utilisateurs test » pourront se connecter.

> ℹ️ Pour une application de bureau, Google considère que ce « code secret » n'est pas vraiment secret :
> c'est normal qu'il soit dans le launcher.

---

## Étape 5 : préparer ton jeu à recevoir le compte du joueur

Quand on clique sur **JOUER**, le launcher démarre ton `.exe` et lui donne ces informations
(des « variables d'environnement ») :

| Variable            | Contenu                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `LAUNCHER_ID_TOKEN` | jeton de connexion Firebase (valable 1 h) pour ton serveur de jeu |
| `LAUNCHER_UID`      | identifiant unique du joueur (ne change jamais)                   |
| `LAUNCHER_PSEUDO`   | pseudo du joueur                                                  |
| `LAUNCHER_EMAIL`    | email du joueur                                                   |
| `LAUNCHER_DEMO`     | `1` si le launcher est en mode démo                               |

Selon le moteur que tu choisiras :

**Unity (C#)** : crée un script `LauncherAuth.cs` sur un objet de ta première scène :

```csharp
using System;
using UnityEngine;

public class LauncherAuth : MonoBehaviour
{
    public static string Uid, Pseudo, Token;

    void Awake()
    {
        Token  = Environment.GetEnvironmentVariable("LAUNCHER_ID_TOKEN");
        Uid    = Environment.GetEnvironmentVariable("LAUNCHER_UID");
        Pseudo = Environment.GetEnvironmentVariable("LAUNCHER_PSEUDO");

#if !UNITY_EDITOR
        // Oblige à passer par le launcher (enlève ces lignes si tu ne veux pas)
        if (string.IsNullOrEmpty(Token)) { Application.Quit(); return; }
#endif
        Debug.Log("Connecté en tant que " + Pseudo);
    }
}
```

**Unreal Engine (C++)** :

```cpp
#include "HAL/PlatformMisc.h"

FString Token  = FPlatformMisc::GetEnvironmentVariable(TEXT("LAUNCHER_ID_TOKEN"));
FString Pseudo = FPlatformMisc::GetEnvironmentVariable(TEXT("LAUNCHER_PSEUDO"));
FString Uid    = FPlatformMisc::GetEnvironmentVariable(TEXT("LAUNCHER_UID"));
```

> Avec Unreal, quand tu publies (étape 6), choisis le `.exe` qui est **à la racine** du build
> (ex : `SEL3A.exe`), pas celui dans `Binaries/Win64`.

**Godot 4 (GDScript)** :

```gdscript
func _ready():
    var token = OS.get_environment("LAUNCHER_ID_TOKEN")
    var pseudo = OS.get_environment("LAUNCHER_PSEUDO")
    if token == "" and not OS.has_feature("editor"):
        get_tree().quit() # oblige à passer par le launcher
    print("Connecté en tant que ", pseudo)
```

> 🔒 **Pour un jeu en ligne** : ne fais jamais confiance au pseudo envoyé par le jeu.
> Ton serveur de jeu doit vérifier `LAUNCHER_ID_TOKEN` avec le **Firebase Admin SDK**
> (`verifyIdToken`) : il obtient alors l'UID réel du joueur.

---

## Étape 6 : mettre le jeu en ligne (téléchargement et mises à jour)

### A. Préparer la version

1. Compile ton jeu (« Build » dans Unity / « Package » dans Unreal / « Exporter » dans Godot).
2. Dans le terminal du launcher, tape :

```
npm run publier
```

3. Réponds aux questions :
   - le dossier du build (tu peux glisser-déposer le dossier dans le terminal) ;
   - le nom du `.exe` du jeu (proposé automatiquement) ;
   - le numéro de version (ex : `1.0.0`, puis `1.0.1` pour la mise à jour suivante…).

Le dossier **`publication/`** est créé :

```
publication/
├── manifest.json   ← version + liste des fichiers avec leur empreinte
├── news.json       ← tes actus (à modifier)
└── files/          ← les fichiers du jeu
```

### B. Héberger ce dossier sur Internet

N'importe quel hébergement qui donne un lien **https** vers les fichiers fonctionne.

**Option simple : Firebase Hosting** (même projet que l'étape 3)

```
npm install -g firebase-tools
firebase login
firebase init hosting
```

- « Use an existing project » → choisis `sel3a`
- « What do you want to use as your public directory? » → tape `publication`
- « Configure as a single-page app? » → `N`
- « Set up automatic builds with GitHub? » → `N`

Puis, à chaque nouvelle version :

```
firebase deploy --only hosting
```

Ton jeu est en ligne sur `https://sel3a.web.app` (le nom exact s'affiche à la fin).

> ⚠️ L'offre gratuite de Firebase Hosting a des limites de stockage et de bande passante, et un fichier
> ne peut pas dépasser 2 Go : parfait pour tester avec quelques amis. Pour un gros jeu avec beaucoup de joueurs,
> utilise plutôt un stockage fait pour ça, comme **Cloudflare R2** (pas de frais de téléchargement) :
> envoie le contenu de `publication/` dans un « bucket » public et utilise son lien.

### C. Brancher le launcher sur ton serveur

Dans `launcher.config.js` :

```js
urlManifest: 'https://sel3a.web.app/manifest.json',
urlActus: 'https://sel3a.web.app/news.json',
```

Relance le launcher : le bouton devient **INSTALLER**. 🎉

### D. Publier une mise à jour

1. Recompile ton jeu.
2. `npm run publier` (il propose automatiquement le numéro de version suivant).
3. `firebase deploy --only hosting` (ou renvoie le dossier sur ton hébergement).

Les launchers des joueurs voient la mise à jour au prochain démarrage (ou dans les 30 minutes),
et **ne téléchargent que les fichiers qui ont changé**. Les sauvegardes des joueurs ne sont jamais supprimées.

---

## Étape 7 : publier des actus et des patch notes

Modifie `publication/news.json`, puis renvoie-le sur ton serveur (`firebase deploy --only hosting`).

```json
{
  "news": [
    {
      "id": "patch-1-0-1",
      "title": "Patch 1.0.1",
      "date": "2026-12-05",
      "tag": "Patch notes",
      "image": "images/patch-1-0-1.jpg",
      "summary": "Petit résumé affiché sur la carte.",
      "content": "Texte complet.\n• Une ligne par correction\n• ...",
      "url": "https://ton-site.com/patch-1-0-1"
    }
  ]
}
```

- La **première actu** de la liste est la plus récente (affichée en premier).
- `image` : un lien `https://...` ou un chemin à côté de `news.json` (ex : mets l'image dans `publication/images/`).
- `url` (facultatif) : ajoute un bouton « Lire sur le site ».
- `\n` = retour à la ligne.

---

## Étape 8 : créer l'installateur du launcher (.exe)

```
npm run dist
```

Tu obtiens dans `dist/` un fichier **`SEL3A Launcher Setup 1.0.0.exe`** : c'est lui que tu donnes à tes joueurs
(sur ton site, ton Discord…). Il crée un raccourci sur le bureau avec ton logo.

> Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » car le launcher n'est pas signé.
> Les joueurs cliquent sur **Informations complémentaires → Exécuter quand même**.
> Pour supprimer ce message, il faut acheter un **certificat de signature de code** (plus tard, quand le jeu grandit).

---

## Étape 9 : mise à jour automatique du launcher lui-même

C'est en place : voir « Partager le launcher » juste en dessous (GitHub construit et publie le launcher,
les launchers installés se mettent à jour tout seuls).

---

## Partager le launcher : les mises à jour arrivent chez tout le monde

Ton dépôt GitHub public **`kaisbregon-tech/Se3la-Launcher`** sert de serveur, gratuitement :

- **Le launcher** : à chaque nouvelle version, GitHub vérifie le code, construit l'installateur et le publie
  dans *Releases* (recette : `tools/github-workflow.yml`, envoyée sur GitHub par PUBLIER.bat). Les launchers installés chez tes amis
  et chez toi le téléchargent en arrière-plan : un bouton vert **« Launcher x.y.z prêt · Redémarrer »**
  apparaît en haut, sinon il s'installe à la fermeture.
- **Les jeux** : chaque version de Midnight City est une *release* `midnight-city-x.xx` et le fichier
  `jeux/midnight-city/manifest.json` du dépôt dit quelle est la dernière. Tout le monde voit
  **METTRE À JOUR**. Les actus sont dans `jeux/midnight-city/news.json`.

### Donner le launcher à tes amis

Envoie-leur ce lien : **https://github.com/kaisbregon-tech/Se3la-Launcher/releases/latest**
Ils téléchargent `SEL3A-Launcher-Setup-x.y.z.exe` et l'ouvrent. Si Windows affiche « Windows a protégé
votre ordinateur » : **Informations complémentaires → Exécuter quand même** (le launcher n'est pas signé).
Ensuite, tout est automatique.

### Publier : un double-clic sur PUBLIER.bat

**PUBLIER.bat** (dans ce dossier) met tout en ligne pour tout le monde :

1. **Le jeu** : il cherche le zip le plus récent (`Musique\Claude outputs`, `Téléchargements`, Bureau…).
   S'il est plus récent que la version en ligne, il l'envoie sur GitHub (quelques minutes pour ~450 Mo).
   Tu peux aussi **glisser un zip sur PUBLIER.bat**.
2. **Le launcher** : il envoie les fichiers de ce dossier sur le dépôt. Si le launcher a changé, son numéro de
   version augmente tout seul (1.1.0 → 1.1.1) et GitHub construit le nouvel installateur (5 à 10 minutes,
   à suivre dans l'onglet *Actions* du dépôt).

Les launchers installés chez tout le monde, le tien compris, reçoivent ensuite la mise à jour.

**La première fois**, PUBLIER.bat te demande un jeton GitHub. Il reste sur ton PC
(`%APPDATA%\SEL3A\github.json`) et n'est jamais envoyé dans le dépôt. Pour le créer : ta photo GitHub →
**Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** →
**Generate new token** : *Only select repositories* → `Se3la-Launcher`, puis dans *Repository permissions* :
**Contents** et **Workflows** en *Read and write*. Ne le colle nulle part ailleurs que dans la fenêtre de PUBLIER.bat.

Quand Claude te fait une nouvelle version de Midnight City ou modifie le launcher, il te suffit de
double-cliquer sur PUBLIER.bat.

> Le dépôt est public : n'importe qui avec le lien peut télécharger le launcher et les jeux.
> Ne mets jamais de mot de passe ni de jeton dans les fichiers du dépôt.

---

## Bibliothèque : plusieurs jeux dans le launcher (ex : Midnight City)

Le launcher a une **bibliothèque** à gauche de l'accueil : ton jeu principal (SEL3A, réglé en haut de
`launcher.config.js`) et les jeux de la liste **`autresJeux`**. Chaque jeu a son image, sa couleur, ses
actus, son dossier d'installation et son bouton JOUER. Le launcher se souvient du dernier jeu affiché.

### Midnight City : en ligne, avec le zip en secours

Midnight City s'installe et se met à jour depuis ton dépôt GitHub (voir ci-dessus). Sans Internet,
le launcher se rabat sur le zip du jeu s'il le trouve sur le PC, par exemple
**`MidnightCity-3.16-Windows.zip`**, dans ces dossiers :

- `Musique\Claude outputs` (là où arrivent les versions envoyées par Claude)
- `Téléchargements` (et `Téléchargements\Claude outputs`)
- le `Bureau`, `Documents\Claude outputs` et `Musique`

1. Clique sur **Midnight City** dans la bibliothèque.
2. Clique sur **INSTALLER** : le jeu est extrait (environ 450 Mo, quelques secondes) dans
   `%LOCALAPPDATA%\SEL3A\Midnight City` (modifiable dans **Paramètres**).
3. Clique sur **JOUER**.

Quand une nouvelle version est publiée, le bouton devient **METTRE À JOUR** (au démarrage, quand tu
reviens sur le launcher, et toutes les 30 minutes). Seuls les fichiers qui ont changé sont téléchargés.
Tes sauvegardes ne sont jamais touchées.

Le zip est ailleurs ? Menu **⋯ → Installer depuis un fichier .zip…** : le launcher retient ce dossier
et y cherchera aussi les versions suivantes. **Vérifier / réparer les fichiers** compare chaque fichier
installé avec le zip et remplace ceux qui sont abîmés.

### Ajouter un autre jeu

Dans `launcher.config.js`, ajoute un bloc à `autresJeux` (copie celui de Midnight City) :

| Réglage          | Rôle                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `nom`, `slogan`, `etiquette` | textes de l'accueil                                       |
| `couleur`        | couleur des boutons quand ce jeu est affiché                           |
| `logo`           | petite icône carrée de la bibliothèque                                 |
| `image`          | grande image de l'accueil (`imagePleine: true` = plein écran)          |
| `titreDansImage` | `true` si le nom du jeu est déjà dessiné sur l'image                   |
| `actus`          | fichier d'actus dans le dossier `demo/` (ou `urlActus` sur un serveur) |
| `exe`            | le `.exe` du jeu                                                       |
| `zip`            | `motif` du nom des zips (l'étoile = la version) et `dossiers` où chercher |
| `urlManifest`    | à la place de `zip` : un serveur, comme à l'étape 6                    |

Les images vont dans `src/renderer/assets/jeux/<nom-du-jeu>/`.

---

## Reconstruire le launcher après une modification

Normalement, c'est GitHub qui construit et publie le launcher (voir « Partager le launcher »).
Pour essayer une modification sur ton PC sans la publier : double-clique sur **`CONSTRUIRE-LE-LAUNCHER.bat`**.
Il installe les outils si besoin, crée l'installateur dans `dist/` puis le lance. C'est la même chose que `npm run dist` (étape 8).

---

## Personnaliser le launcher

| Je veux changer…              | Où ?                                                                     |
| ----------------------------- | ------------------------------------------------------------------------ |
| Le nom, le slogan             | `launcher.config.js` → `nomDuJeu`, `slogan`                              |
| La couleur des boutons        | `launcher.config.js` → `couleurPrincipale`                               |
| Le logo / l'image de fond     | remplace `src/renderer/assets/icone.png` et `fond.jpg` (mêmes noms)      |
| L'icône du .exe               | remplace `build/icon.png` (carré, 512×512 px minimum)                    |
| Les liens Site web / Discord  | `launcher.config.js` → `liens`                                           |
| Le nom du programme installé  | `package.json` → `productName` (2 endroits)                              |
| Le style (tailles, effets…)   | `src/renderer/styles.css`                                                |
| Les textes de l'interface     | `src/renderer/index.html` et `src/renderer/app.js`                       |

Après chaque modification : ferme le launcher et relance `npm start`.

---

## Sécurité : ce qu'il faut savoir

- Les mots de passe ne passent **jamais** par toi : ils vont directement chez Firebase.
- La session du joueur est **chiffrée** sur son PC (avec la protection de Windows).
- Chaque fichier téléchargé est **vérifié** (empreinte SHA-256) : un fichier abîmé ou modifié est retéléchargé.
- Le launcher refuse tout fichier qui essaierait de s'installer en dehors du dossier du jeu.
- ❌ Ne mets **jamais** dans le launcher une « clé de compte de service » Firebase (fichier `.json` avec `private_key`) :
  elle sert uniquement sur ton serveur.

---

## Problèmes fréquents

| Problème | Solution |
| --- | --- |
| `'npm' n'est pas reconnu…` | Node.js n'est pas installé, ou il faut redémarrer le PC (étape 1). |
| « Ce mode de connexion n'est pas activé dans Firebase » | Active Email/Mot de passe et Google dans Firebase (étape 3.4). |
| « La clé Firebase (apiKey)… est invalide » | Recopie l'`apiKey` sans espace ni guillemet en trop (étape 3.5). |
| Google affiche « redirect_uri_mismatch » | Ton ID client est de type « Application Web ». Recrée-le en **Application de bureau** (étape 4.3). |
| Google affiche « Accès bloqué » / « application non validée » | Publie l'application (étape 4.5) ou ajoute le compte en utilisateur test. |
| « La connexion Google a été refusée par Firebase » | Vérifie que l'ID client a été créé dans **le même projet** que Firebase. Sinon : Firebase → Authentication → Google → « Ajouter des ID client de projets externes » et colle ton `clientId`. |
| « Un compte existe déjà avec cet email » (Google) | Le joueur a déjà un compte email/mot de passe : il doit se connecter avec. |
| « Fichier introuvable sur le serveur » | Tu as envoyé `manifest.json` mais pas le dossier `files/`. Renvoie tout `publication/`. |
| Le bouton reste sur « BIENTÔT » | `urlManifest` est vide dans `launcher.config.js` (étape 6.C). |
| « Impossible de remplacer … Ferme le jeu » | Le jeu tourne encore pendant la mise à jour : ferme-le et clique sur RÉESSAYER. |

Pour vérifier que tout le code fonctionne : `npm test` (31 tests automatiques).

| Problème avec PUBLIER.bat | Solution |
| --- | --- |
| « Ce jeton ne marche pas » | Le jeton a expiré ou a été supprimé : crée-en un nouveau (voir « Partager le launcher »). |
| « Le dépôt … n'existe pas » | Crée le dépôt `Se3la-Launcher` sur GitHub, en **Public**, sans README. |
| GitHub a refusé (403) | Le jeton n'a pas **Contents** et **Workflows** en *Read and write* sur le dépôt `Se3la-Launcher`. |
| Le launcher ne se construit pas | Onglet *Actions* du dépôt : clique sur la ligne en rouge et envoie le message à Claude. |

---

## Idées pour la suite

- 👥 Liste d'amis et invitations (avec Firestore, la base de données de Firebase)
- 🏆 Succès / statistiques affichés dans le launcher
- 💬 Chat ou lien direct vers le Discord
- 🌍 Version anglaise de l'interface
- 🛡️ Serveur de jeu qui vérifie les jetons des joueurs (anti-triche)
