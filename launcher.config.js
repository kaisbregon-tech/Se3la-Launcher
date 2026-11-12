// ============================================================================
//  CONFIGURATION DE TON LAUNCHER
//  C'est le SEUL fichier que tu dois modifier pour personnaliser le launcher.
//  Tant que "firebase.apiKey" est vide, le launcher tourne en MODE DÉMO
//  (la connexion est simulée, rien n'est envoyé sur Internet).
// ============================================================================

// --- Ton dépôt GitHub : il héberge le launcher et les jeux pour tout le monde ---
// (le même pseudo doit être dans package.json → build.publish → owner)
const GITHUB = 'kaisbregon-tech/Se3la-Launcher';
const EN_LIGNE = `https://raw.githubusercontent.com/${GITHUB}/main/jeux`;

module.exports = {
  // --- Ton jeu --------------------------------------------------------------
  nomDuJeu: 'SEL3A',
  slogan: 'Bienvenue dans le game.',

  // Couleur principale des boutons (code couleur hexadécimal)
  couleurPrincipale: '#8b3dff',

  // Images : soit un fichier du dossier src/renderer/assets/,
  // soit un lien https vers une image.
  logo: 'assets/icone.png', // petit logo (barre du haut, menu)
  imageDeFond: 'assets/fond.jpg', // grande image de la page d'accueil et de connexion

  // --- Comptes joueurs (Firebase) -------------------------------------------
  // Voir le GUIDE.md, étape 3, pour trouver cette clé.
  firebase: {
    apiKey: '',
  },

  // --- Connexion avec Google ------------------------------------------------
  // Voir le GUIDE.md, étape 4 : identifiant client OAuth de type
  // « Application de bureau » créé dans Google Cloud (même projet que Firebase).
  google: {
    clientId: '',
    clientSecret: '',
  },

  // --- Serveur de téléchargement --------------------------------------------
  // Lien vers le fichier manifest.json créé par « npm run publier ».
  // Exemple : 'https://mon-jeu.web.app/jeu/manifest.json'
  urlManifest: '',

  // Lien vers le fichier news.json (actus et patch notes).
  // Laisse vide pour afficher les actus de démo (dossier demo/).
  urlActus: '',

  // --- Liens affichés dans le launcher (laisse vide pour les cacher) --------
  liens: {
    siteWeb: '',
    discord: '',
  },

  // --- Les autres jeux de la bibliothèque -------------------------------------
  // Chaque jeu apparaît à gauche de l'accueil, avec son image, sa couleur et son
  // bouton JOUER. Un jeu vient d'un serveur (urlManifest : ton dépôt GitHub, mis
  // à jour avec « node tools/publier-github.js ») et/ou d'un fichier .zip posé
  // sur le PC (bloc « zip ») : le launcher cherche le zip dans les dossiers
  // indiqués et lit la version dans son nom.
  //   Dossiers possibles : 'musique', 'telechargements', 'bureau', 'documents'
  //   (suivis d'un sous-dossier si besoin), ou un chemin complet.
  autresJeux: [
    {
      id: 'midnight-city',
      nom: 'Midnight City',
      slogan: 'Port Solara, 1986. Pars de rien et prends la ville.',
      etiquette: 'Monde ouvert · années 80',
      couleur: '#ff4fa3',
      logo: 'assets/jeux/midnight-city/icone.png', // icône de la bibliothèque
      image: 'assets/jeux/midnight-city/fond.jpg', // grande image de l'accueil
      imagePleine: true, // l'image remplit tout l'accueil
      titreDansImage: true, // le nom du jeu est déjà dessiné sur l'image
      // en ligne : chaque nouvelle version publiée arrive chez tous les joueurs
      urlManifest: `${EN_LIGNE}/midnight-city/manifest.json`,
      urlActus: `${EN_LIGNE}/midnight-city/news.json`,
      actus: 'midnight-city.json', // actus livrées avec le launcher (sans Internet)
      exe: 'MidnightCity.exe',
      // en secours (sans Internet) : le zip du jeu posé sur le PC
      zip: {
        motif: 'MidnightCity-*-Windows.zip', // l'étoile = le numéro de version
        dossiers: ['musique/Claude outputs', 'telechargements', 'telechargements/Claude outputs', 'bureau', 'documents/Claude outputs', 'musique'],
      },
    },
  ],
};
