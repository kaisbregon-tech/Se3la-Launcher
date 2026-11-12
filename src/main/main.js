// ============================================================================
//  PROCESSUS PRINCIPAL D'ELECTRON
//  Crée la fenêtre, et fait le lien entre l'interface (renderer) et les
//  modules : comptes (auth.js), jeux (game.js / updater.js / zip-updater.js),
//  actus (news.js). Le launcher a une bibliothèque : le jeu principal et les
//  « autresJeux » de launcher.config.js, chacun avec son propre gestionnaire.
// ============================================================================

const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const config = require('../../launcher.config.js');
const { JsonStore } = require('./store');
const { Auth } = require('./auth');
const { GameUpdater } = require('./updater');
const { ZipGameUpdater, HybridUpdater, scanFolders } = require('./zip-updater');
const { GameManager } = require('./game');
const { loadNews } = require('./news');

const RENDERER = path.join(__dirname, '..', 'renderer');
const DEMO_DIR = path.join(__dirname, '..', '..', 'demo');

let win = null;
let auth;
let settingsStore;
let newsCache;
let games = []; // [{ def, manager }] : un gestionnaire par jeu de la bibliothèque

// ---------------------------------------------------------------- outils
const folderName = (name) => String(name || 'MonJeu').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'MonJeu';

function isWebUrl(url) {
  try {
    return ['https:', 'http:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function openSafe(url) {
  if (isWebUrl(url)) shell.openExternal(url);
}

function imageSetting(value) {
  if (typeof value !== 'string') return '';
  if (/^assets\/[\w\-./]+$/.test(value) && !value.includes('..')) return value;
  try {
    return new URL(value).protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

function baseDir() {
  return process.platform === 'win32' && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : app.getPath('userData');
}

function defaultSettings() {
  return {
    installDir: path.join(baseDir(), folderName(config.nomDuJeu), 'Jeu'), // dossier du jeu principal
    dossiers: {}, // dossiers des autres jeux : { id: chemin }
    dossiersZip: {}, // dossiers où l'on a déjà choisi un zip à la main : { id: chemin }
    jeuActif: '',
    cacherPendantJeu: true,
    lancerAuDemarrage: false,
    argumentsSupp: '',
  };
}

function getSettings() {
  return { ...defaultSettings(), ...settingsStore.read({}) };
}

/** Dossier d'installation d'un jeu de la bibliothèque. */
function installDirOf(id, s = getSettings()) {
  const g = findGame(id);
  if (!g || g.def.principal) return s.installDir;
  const d = s.dossiers && s.dossiers[id];
  return typeof d === 'string' && path.isAbsolute(d)
    ? d
    : path.join(baseDir(), folderName(config.nomDuJeu), folderName(g.def.nom));
}

function setSettings(patch, id) {
  const current = getSettings();
  const next = { ...current, dossiers: { ...(current.dossiers || {}) }, dossiersZip: { ...(current.dossiersZip || {}) } };
  const g = findGame(id);
  if (typeof patch.installDir === 'string' && path.isAbsolute(patch.installDir)) {
    if (!g || g.def.principal) next.installDir = patch.installDir;
    else next.dossiers[g.def.id] = patch.installDir;
  }
  if (typeof patch.jeuActif === 'string' && findGame(patch.jeuActif)) next.jeuActif = patch.jeuActif;
  if (typeof patch.cacherPendantJeu === 'boolean') next.cacherPendantJeu = patch.cacherPendantJeu;
  if (typeof patch.lancerAuDemarrage === 'boolean') next.lancerAuDemarrage = patch.lancerAuDemarrage;
  if (typeof patch.argumentsSupp === 'string') next.argumentsSupp = patch.argumentsSupp.slice(0, 500);
  settingsStore.write(next);

  if (next.lancerAuDemarrage !== current.lancerAuDemarrage && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.lancerAuDemarrage });
  }
  for (const x of games) {
    if (installDirOf(x.def.id, next) !== installDirOf(x.def.id, current)) x.manager.check();
  }
  return { ...next, installDir: installDirOf(id, next) };
}

// ---------------------------------------------------------------- bibliothèque de jeux
const slug = (v) =>
  String(v || 'jeu')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'jeu';

const couleur = (c, def) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : def);

/** Le jeu principal (réglages du haut de launcher.config.js) + les « autresJeux ». */
function gameDefs() {
  const defs = [
    {
      id: slug(config.nomDuJeu),
      principal: true,
      nom: config.nomDuJeu,
      slogan: config.slogan || '',
      etiquette: config.etiquette || 'En développement',
      couleur: couleur(config.couleurPrincipale, '#8b3dff'),
      logo: imageSetting(config.logo),
      image: imageSetting(config.imageDeFond),
      titreImage: '',
      urlManifest: config.urlManifest || '',
      urlActus: config.urlActus || '',
      actusDemo: path.join(DEMO_DIR, 'news.json'),
      liens: config.liens || {},
    },
  ];
  for (const j of Array.isArray(config.autresJeux) ? config.autresJeux : []) {
    if (!j || !j.nom) continue;
    let id = slug(j.id || j.nom);
    while (defs.some((d) => d.id === id)) id += '-2';
    const zip = j.zip && typeof j.zip === 'object' ? j.zip : null;
    defs.push({
      id,
      principal: false,
      nom: String(j.nom),
      slogan: j.slogan || '',
      etiquette: j.etiquette || '',
      couleur: couleur(j.couleur, couleur(config.couleurPrincipale, '#8b3dff')),
      logo: imageSetting(j.logo),
      image: imageSetting(j.image),
      titreImage: imageSetting(j.titreImage),
      imagePleine: !!j.imagePleine,
      titreDansImage: !!j.titreDansImage,
      urlManifest: j.urlManifest || '',
      urlActus: j.urlActus || '',
      actusDemo: typeof j.actus === 'string' && /^[\w\-]+\.json$/.test(j.actus) ? path.join(DEMO_DIR, j.actus) : '',
      liens: j.liens || {},
      zip: zip
        ? {
            exe: String(j.exe || zip.exe || ''),
            motif: String(zip.motif || '*.zip'),
            dossiers: Array.isArray(zip.dossiers) ? zip.dossiers.map(String) : [],
          }
        : null,
    });
  }
  return defs;
}

function findGame(id) {
  return games.find((g) => g.def.id === id) || null;
}

function needGame(id) {
  const g = findGame(id) || games[0];
  if (!g) throw new Error('Aucun jeu configuré.');
  return g;
}

/** « musique/Claude outputs » -> C:\Users\…\Music\Claude outputs (ou un chemin complet). */
function resolveFolder(spec) {
  const alias = { musique: 'music', telechargements: 'downloads', 'téléchargements': 'downloads', bureau: 'desktop', documents: 'documents' };
  const parts = String(spec).replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length) return '';
  if (path.isAbsolute(spec)) return spec;
  const key = alias[parts[0].toLowerCase()];
  if (!key) return '';
  try {
    return path.join(app.getPath(key), ...parts.slice(1));
  } catch {
    return '';
  }
}

function publicGame(def) {
  return {
    id: def.id,
    nom: def.nom,
    slogan: def.slogan,
    etiquette: def.etiquette,
    couleur: def.couleur,
    logo: def.logo,
    image: def.image,
    titreImage: def.titreImage,
    imagePleine: !!def.imagePleine,
    titreDansImage: !!def.titreDansImage,
    zip: !!def.zip,
    zipMotif: def.zip ? def.zip.motif : '',
    zipDossiers: def.zip ? def.zip.dossiers : [],
    serverConfigured: !!(def.urlManifest || def.zip),
    liens: {
      siteWeb: isWebUrl(def.liens && def.liens.siteWeb) ? def.liens.siteWeb : '',
      discord: isWebUrl(def.liens && def.liens.discord) ? def.liens.discord : '',
    },
  };
}

function createGame(def) {
  const zipUpdater = def.zip
    ? new ZipGameUpdater({
        exe: def.zip.exe,
        motif: def.zip.motif,
        findZips: () => {
          const extra = (getSettings().dossiersZip || {})[def.id];
          const folders = [...def.zip.dossiers.map(resolveFolder), extra].filter(Boolean);
          return scanFolders(folders, def.zip.motif);
        },
      })
    : null;
  const serverUpdater = def.urlManifest ? new GameUpdater({ manifestUrl: def.urlManifest }) : null;
  // en ligne d'abord (tout le monde reçoit les mises à jour), le zip du PC en secours
  const updater =
    serverUpdater && zipUpdater
      ? new HybridUpdater({ server: serverUpdater, zip: zipUpdater })
      : zipUpdater || serverUpdater || new GameUpdater({ manifestUrl: '' });
  const manager = new GameManager({
    updater,
    auth,
    getInstallDir: () => installDirOf(def.id),
    getSettings,
  });
  manager.on('state', (st) => send('game:state', { id: def.id, state: st }));
  manager.on('launched', () => {
    if (getSettings().cacherPendantJeu && win) win.hide();
  });
  manager.on('exited', () => showWindow());
  return { def, manager };
}

function checkAll() {
  for (const g of games) {
    if (!g.manager.state.busy && !g.manager.state.running) g.manager.check();
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Enregistre une fonction appelable depuis l'interface. Les erreurs sont renvoyées proprement. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const frameUrl = event.senderFrame && event.senderFrame.url;
    if (frameUrl && !frameUrl.startsWith('file://')) return { ok: false, error: 'Accès refusé.' };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), code: e && e.code };
    }
  });
}

// ---------------------------------------------------------------- fenêtre
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 1000,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#07050c',
    title: `${config.nomDuJeu} Launcher`,
    icon: path.join(RENDERER, 'assets', 'icone.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(RENDERER, 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Les liens s'ouvrent dans le navigateur du joueur, jamais dans le launcher
  win.webContents.setWindowOpenHandler(({ url }) => {
    openSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      openSafe(url);
    }
  });

  // Un nouveau zip a peut-être été déposé pendant que le launcher était en arrière-plan
  let lastFocusCheck = 0;
  win.on('focus', () => {
    if (!auth || !auth.session || Date.now() - lastFocusCheck < 15000) return;
    lastFocusCheck = Date.now();
    for (const g of games) {
      if (g.def.zip && !g.manager.state.busy && !g.manager.state.running) g.manager.check();
    }
  });
  win.on('maximize', () => send('win:maximized', true));
  win.on('unmaximize', () => send('win:maximized', false));
  win.on('closed', () => {
    win = null;
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------- démarrage
function init() {
  const userData = app.getPath('userData');
  const encryption = safeStorage.isEncryptionAvailable()
    ? { encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) }
    : null;

  settingsStore = new JsonStore(path.join(userData, 'parametres.json'));
  newsCache = new JsonStore(path.join(userData, 'actus-cache.json'));

  auth = new Auth({
    apiKey: config.firebase && config.firebase.apiKey,
    google: config.google,
    store: new JsonStore(path.join(userData, encryption ? 'session.dat' : 'session.json'), encryption),
    openExternal: (url) => shell.openExternal(url),
    appName: `${config.nomDuJeu} Launcher`,
  });

  games = gameDefs().map(createGame);

  // Vérifie les mises à jour des jeux toutes les 30 minutes
  setInterval(() => {
    if (auth.session) checkAll();
  }, 30 * 60 * 1000);

  // ---- application
  handle('app:info', () => {
    const s = getSettings();
    return {
      nomDuJeu: config.nomDuJeu,
      slogan: config.slogan,
      couleurPrincipale: couleur(config.couleurPrincipale, '#8b3dff'),
      logo: imageSetting(config.logo),
      imageDeFond: imageSetting(config.imageDeFond),
      liens: {
        siteWeb: isWebUrl(config.liens && config.liens.siteWeb) ? config.liens.siteWeb : '',
        discord: isWebUrl(config.liens && config.liens.discord) ? config.liens.discord : '',
      },
      demo: auth.demo,
      googleConfigured: auth.demo || !!(config.google && config.google.clientId),
      serverConfigured: !!config.urlManifest,
      version: app.getVersion(),
      jeux: games.map((g) => publicGame(g.def)),
      jeuActif: findGame(s.jeuActif) ? s.jeuActif : (games.find((g) => g.def.urlManifest || g.def.zip) || games[0]).def.id,
    };
  });
  handle('app:open', (url) => openSafe(url));
  handle('win:minimize', () => win && win.minimize());
  handle('win:maximize', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
  handle('win:close', () => win && win.close());

  // ---- comptes
  handle('auth:restore', () => auth.restore());
  handle('auth:signIn', (email, password) => auth.signIn(email, password));
  handle('auth:signUp', (email, password, pseudo) => auth.signUp(email, password, pseudo));
  handle('auth:google', async () => {
    const user = await auth.signInWithGoogle();
    showWindow(); // on revient sur le launcher après le navigateur
    return user;
  });
  handle('auth:cancelGoogle', () => auth.cancelGoogle());
  handle('auth:resetPassword', (email) => auth.sendPasswordReset(email));
  handle('auth:updateName', (pseudo) => auth.updateDisplayName(pseudo));
  handle('auth:signOut', () => auth.signOut());

  // ---- jeux (chaque appel précise l'identifiant du jeu)
  handle('game:state', (id) => needGame(id).manager.getState());
  handle('game:check', (id) => needGame(id).manager.check());
  handle('game:install', (id) => needGame(id).manager.install());
  handle('game:repair', (id) => needGame(id).manager.install({ repair: true }));
  handle('game:cancel', (id) => needGame(id).manager.cancel());
  handle('game:play', (id) => needGame(id).manager.play());
  handle('game:uninstall', (id) => needGame(id).manager.uninstall());
  handle('game:openFolder', async (id) => {
    const dir = installDirOf(needGame(id).def.id);
    if (!fs.existsSync(dir)) throw new Error("Le dossier du jeu n'existe pas encore.");
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });
  // Jeu livré en .zip : choisir le zip à la main (n'importe où sur le PC)
  handle('game:chooseZip', async (id) => {
    const g = needGame(id);
    if (!g.def.zip) throw new Error("Ce jeu ne s'installe pas depuis un zip.");
    if (g.manager.state.busy) throw new Error('Une installation est déjà en cours.');
    if (g.manager.state.running) throw new Error('Ferme le jeu avant de le mettre à jour.');
    const r = await dialog.showOpenDialog(win, {
      title: `Choisis le zip de ${g.def.nom}`,
      properties: ['openFile'],
      filters: [{ name: 'Archive zip', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    // on retient ce dossier : les prochaines versions déposées ici seront trouvées toutes seules
    const s = getSettings();
    settingsStore.write({ ...s, dossiersZip: { ...(s.dossiersZip || {}), [g.def.id]: path.dirname(file) } });
    return g.manager.install({ zipPath: file });
  });

  // ---- paramètres
  handle('settings:get', (id) => ({ ...getSettings(), installDir: installDirOf(id) }));
  handle('settings:set', (patch, id) => setSettings(patch || {}, id));
  handle('settings:chooseFolder', async (id) => {
    const g = needGame(id);
    if (g.manager.state.busy) throw new Error('Attends la fin du téléchargement.');
    const r = await dialog.showOpenDialog(win, {
      title: `Choisis le dossier d'installation de ${g.def.nom}`,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return { ...getSettings(), installDir: installDirOf(g.def.id) };
    let dir = r.filePaths[0];
    // Si le dossier choisi ne contient pas déjà le jeu, on crée un sous-dossier à son nom
    const name = folderName(g.def.nom);
    if (!fs.existsSync(path.join(dir, '.launcher')) && path.basename(dir).toLowerCase() !== name.toLowerCase()) {
      dir = path.join(dir, name);
    }
    return setSettings({ installDir: dir }, g.def.id);
  });

  // ---- actus (chaque jeu a les siennes)
  handle('news:get', (id) => {
    const d = needGame(id).def;
    return loadNews({
      url: d.urlActus,
      demoFile: d.actusDemo || path.join(DEMO_DIR, 'news.json'),
      cacheStore: d.principal ? newsCache : new JsonStore(path.join(app.getPath('userData'), `actus-cache-${d.id}.json`)),
    });
  });

  createWindow();

  setupLauncherUpdates();
}

// ---------------------------------------------------------------- mise à jour du launcher lui-même
// Chaque nouvelle version publiée sur GitHub (voir GUIDE.md) est téléchargée en arrière-plan,
// puis installée quand on ferme le launcher (ou tout de suite avec le bouton « Redémarrer »).
let launcherUpdate = null; // { version, ready }
let autoUpdater = null;

function setupLauncherUpdates() {
  handle('launcher:update', () => launcherUpdate);
  handle('launcher:restart', () => {
    if (autoUpdater && launcherUpdate && launcherUpdate.ready) setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });
  // pas en développement (npm start), ni pour la version portable (elle ne peut pas se remplacer)
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return; // electron-updater non configuré
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => {
    launcherUpdate = { version: i.version, ready: false };
    send('launcher:update', launcherUpdate);
  });
  autoUpdater.on('update-downloaded', (i) => {
    launcherUpdate = { version: i.version, ready: true };
    send('launcher:update', launcherUpdate);
  });
  autoUpdater.on('error', () => {
    /* pas d'Internet ou pas encore de version publiée : on réessaiera */
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 2 * 60 * 60 * 1000);
}

// Une seule fenêtre du launcher à la fois
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(init);
  app.on('window-all-closed', () => app.quit());
}
