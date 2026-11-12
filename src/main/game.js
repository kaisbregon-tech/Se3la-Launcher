// ============================================================================
//  GESTION DU JEU : état (installer / mettre à jour / jouer), téléchargement,
//  réparation et lancement du .exe avec les infos du compte du joueur.
//
//  Le jeu reçoit ces VARIABLES D'ENVIRONNEMENT au lancement :
//    LAUNCHER_ID_TOKEN  jeton Firebase du joueur (valable 1 h, vérifiable par ton serveur)
//    LAUNCHER_UID       identifiant unique du joueur
//    LAUNCHER_PSEUDO    pseudo du joueur
//    LAUNCHER_EMAIL     email du joueur
//    LAUNCHER_DEMO      "1" si le launcher est en mode démo
//  Voir GUIDE.md, étape 7, pour les lire dans Unity / Unreal / Godot.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { safeJoin } = require('./updater');

/** Découpe « -fullscreen -name "Mon Nom" » en liste d'arguments. */
function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

class GameManager extends EventEmitter {
  constructor({ updater, auth, getInstallDir, getSettings, spawnImpl }) {
    super();
    this.updater = updater;
    this.auth = auth;
    this.getInstallDir = getInstallDir;
    this.getSettings = getSettings;
    this.spawn = spawnImpl || childProcess.spawn;
    this.child = null;
    this.state = {
      status: 'checking',
      installed: false,
      localVersion: null,
      remoteVersion: null,
      downloadSize: 0,
      offline: false,
      running: false,
      busy: false,
      error: null,
      progress: null,
      installDir: getInstallDir(),
    };
    updater.on('progress', (p) => this._set({ progress: p }));
  }

  getState() {
    return { ...this.state, installDir: this.getInstallDir() };
  }

  _set(patch) {
    Object.assign(this.state, patch);
    this.emit('state', this.getState());
  }

  async check() {
    if (this.state.busy) return this.getState();
    this._set({ status: 'checking', error: null });
    try {
      const r = await this.updater.check(this.getInstallDir());
      this._set({ ...r, error: null, progress: null });
    } catch (e) {
      const installed = this.updater.isInstalled(this.getInstallDir());
      // Serveur en panne mais jeu installé : on laisse jouer quand même
      this._set({ status: installed ? 'ready' : 'error', installed, error: e.message, progress: null });
    }
    return this.getState();
  }

  async install({ repair = false, zipPath = null } = {}) {
    if (this.state.busy) throw new Error('Une opération est déjà en cours.');
    if (this.state.running) throw new Error('Ferme le jeu avant de le mettre à jour.');
    this._set({ busy: true, status: repair ? 'repairing' : 'downloading', error: null, progress: null });
    let error = null;
    try {
      await this.updater.install(this.getInstallDir(), { repair, zipPath });
    } catch (e) {
      if (e.code !== 'CANCELLED') error = e.message;
    }
    this._set({ busy: false, progress: null });
    await this.check();
    if (error) this._set({ error });
    return this.getState();
  }

  cancel() {
    this.updater.cancel();
  }

  async uninstall() {
    if (this.state.busy || this.state.running) throw new Error('Impossible pendant un téléchargement ou une partie.');
    this._set({ busy: true });
    try {
      await this.updater.uninstall(this.getInstallDir());
    } finally {
      this._set({ busy: false });
    }
    return this.check();
  }

  async play() {
    if (this.state.running) throw new Error('Le jeu est déjà lancé.');
    if (this.state.busy) throw new Error('Attends la fin du téléchargement.');
    const dir = this.getInstallDir();
    const local = this.updater.readLocal(dir);
    if (!local || !local.version) throw new Error("Le jeu n'est pas installé.");

    const exePath = safeJoin(dir, local.exe);
    if (!fs.existsSync(exePath)) {
      throw new Error('Le fichier du jeu est introuvable. Utilise « Vérifier les fichiers » pour le réparer.');
    }

    const token = await this.auth.getIdToken();
    const user = this.auth.publicUser();
    const settings = this.getSettings();
    const args = [...(local.args || []), ...splitArgs(settings.argumentsSupp)];

    let child;
    try {
      child = this.spawn(exePath, args, {
        cwd: path.dirname(exePath),
        env: {
          ...process.env,
          LAUNCHER_ID_TOKEN: token,
          LAUNCHER_UID: user.uid,
          LAUNCHER_PSEUDO: user.displayName,
          LAUNCHER_EMAIL: user.email,
          LAUNCHER_DEMO: user.demo ? '1' : '0',
        },
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (e) {
      throw new Error(`Impossible de lancer le jeu : ${e.message}`);
    }

    this.child = child;
    this._set({ running: true, error: null });
    this.emit('launched');

    await new Promise((resolve, reject) => {
      let started = false;
      child.once('spawn', () => {
        started = true;
        resolve();
      });
      child.once('error', (e) => {
        this.child = null;
        this._set({ running: false, error: `Impossible de lancer le jeu : ${e.message}` });
        this.emit('exited', { code: null, error: e.message });
        if (!started) reject(new Error(`Impossible de lancer le jeu : ${e.message}`));
      });
      child.once('exit', (code) => {
        this.child = null;
        this._set({ running: false });
        this.emit('exited', { code });
        if (!started) resolve();
      });
    });
    return this.getState();
  }
}

module.exports = { GameManager, splitArgs };
