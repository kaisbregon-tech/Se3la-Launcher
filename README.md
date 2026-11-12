# SEL3A Launcher

Launcher officiel du jeu SEL3A : comptes joueurs (Google + email via Firebase), téléchargement,
mises à jour automatiques, vérification des fichiers, actus et patch notes.
Bibliothèque de jeux : SEL3A et **Midnight City**. Le launcher et les jeux se mettent à jour tout seuls
chez tout le monde.

## ⬇️ Télécharger le launcher

**https://github.com/kaisbregon-tech/Se3la-Launcher/releases/latest** → `SEL3A-Launcher-Setup-x.y.z.exe`

Si Windows affiche « Windows a protégé votre ordinateur » : *Informations complémentaires → Exécuter quand même*.

## Publier une nouvelle version (jeu ou launcher)

Double-clic sur **PUBLIER.bat** : tout le monde reçoit la mise à jour. Voir [GUIDE.md](GUIDE.md), « Partager le launcher ».

## Pour le développement

```
npm install    # une seule fois
npm start      # lance le launcher (mode démo tant que Firebase n'est pas configuré)
npm run publier  # prépare une nouvelle version du jeu à mettre en ligne (ton propre serveur)
npm run publier-github -- --zip "MidnightCity-3.17-Windows.zip"   # publie un jeu sur GitHub pour tout le monde
npm run dist   # crée l'installateur Windows (.exe) dans dist/
npm test       # tests automatiques
```

👉 Tout est expliqué pas à pas dans **[GUIDE.md](GUIDE.md)**.
