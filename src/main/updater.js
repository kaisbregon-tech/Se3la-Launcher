// ============================================================================
//  TÉLÉCHARGEMENT ET MISES À JOUR DU JEU
//
//  Sur ton serveur il y a :
//    manifest.json   -> la version du jeu + la liste des fichiers (taille + empreinte sha256)
//    files/...       -> les fichiers du jeu
//  (les deux sont créés automatiquement par « npm run publier »)
//
//  Le launcher compare avec ce qui est installé sur le PC et ne télécharge
//  QUE les fichiers qui ont changé. Chaque fichier est vérifié après
//  téléchargement : un fichier abîmé est retéléchargé.
//  Ce fichier n'utilise pas Electron : il est testé avec « npm test ».
// ============================================================================

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');
const { finished } = require('stream/promises');

const STATE_DIR = '.launcher';
const STATE_FILE = 'installed.json';
const SHA256_RE = /^[a-f0-9]{64}$/;

class UpdateError extends Error {
  constructor(code, message, { retry = true } = {}) {
    super(message);
    this.code = code;
    this.retry = retry;
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Transforme un chemin du manifest en chemin sur le disque, en refusant tout ce qui sort du dossier du jeu. */
function safeJoin(root, rel) {
  const bad = () => new UpdateError('BAD_MANIFEST', `Chemin interdit dans le manifest : ${rel}`, { retry: false });
  if (typeof rel !== 'string' || !rel) throw bad();
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) throw bad();
  const parts = norm.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw bad();
  if (parts[0].toLowerCase() === STATE_DIR) throw bad();
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  if (!full.startsWith(base + path.sep)) throw bad();
  return full;
}

function encodePath(rel) {
  return rel
    .replace(/\\/g, '/')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

function validateManifest(m) {
  const fail = (msg) => new UpdateError('BAD_MANIFEST', `manifest.json invalide : ${msg}`, { retry: false });
  if (!m || typeof m !== 'object') throw fail('ce n’est pas un objet JSON');
  if (typeof m.version !== 'string' || !m.version) throw fail('"version" manquante');
  if (typeof m.exe !== 'string' || !m.exe) throw fail('"exe" manquant (nom du .exe du jeu)');
  if (!Array.isArray(m.files) || m.files.length === 0) throw fail('"files" est vide');
  const seen = new Set();
  for (const f of m.files) {
    if (!f || typeof f.path !== 'string') throw fail('un fichier n’a pas de "path"');
    if (!Number.isSafeInteger(f.size) || f.size < 0) throw fail(`taille invalide pour ${f.path}`);
    if (typeof f.sha256 !== 'string' || !SHA256_RE.test(f.sha256)) throw fail(`sha256 invalide pour ${f.path}`);
    const key = f.path.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) throw fail(`fichier en double : ${f.path}`);
    seen.add(key);
    safeJoin('/verif', f.path); // vérifie le chemin
  }
  if (!seen.has(m.exe.replace(/\\/g, '/').toLowerCase())) throw fail(`l'exe "${m.exe}" n'est pas dans la liste des fichiers`);
  if (m.args !== undefined && !(Array.isArray(m.args) && m.args.every((a) => typeof a === 'string'))) {
    throw fail('"args" doit être une liste de textes');
  }
  return m;
}

async function hashFile(file, onBytes) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk);
    if (onBytes) onBytes(chunk.length);
  }
  return hash.digest('hex');
}

async function statOrNull(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

async function removeEmptyParents(file, root) {
  const base = path.resolve(root);
  let dir = path.dirname(file);
  while (dir.startsWith(base + path.sep)) {
    try {
      await fsp.rmdir(dir); // échoue si le dossier n'est pas vide : c'est voulu
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

class GameUpdater extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.manifestUrl   lien vers manifest.json (vide = pas de serveur)
   * @param {Function} [opts.fetchImpl]
   * @param {number} [opts.concurrency] téléchargements en parallèle
   */
  constructor({ manifestUrl, fetchImpl, concurrency = 4, retries = 3, retryDelayMs = 1000 }) {
    super();
    this.manifestUrl = manifestUrl || '';
    this.fetch = fetchImpl || globalThis.fetch;
    this.concurrency = concurrency;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.abort = null;
  }

  // ------------------------------------------------------------- état local
  readLocal(dir) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, STATE_DIR, STATE_FILE), 'utf8'));
      if (!data || typeof data.files !== 'object') return null;
      return data;
    } catch {
      return null;
    }
  }

  async _writeLocal(dir, data) {
    const file = path.join(dir, STATE_DIR, STATE_FILE);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(`${file}.tmp`, JSON.stringify(data, null, 2));
    await fsp.rename(`${file}.tmp`, file);
  }

  isInstalled(dir) {
    const local = this.readLocal(dir);
    return !!(local && local.version);
  }

  // ------------------------------------------------------------- serveur
  async fetchManifest() {
    if (!this.manifestUrl) throw new UpdateError('NO_SERVER', 'Aucun serveur de jeu configuré.', { retry: false });
    let res;
    try {
      const url = new URL(this.manifestUrl);
      url.searchParams.set('t', Date.now().toString()); // évite les vieilles versions en cache
      res = await this.fetch(url.href, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    } catch {
      throw new UpdateError('NETWORK', 'Impossible de joindre le serveur du jeu. Vérifie ta connexion Internet.');
    }
    if (!res.ok) {
      throw new UpdateError('SERVER', `Le serveur du jeu a répondu une erreur (${res.status}).`, { retry: false });
    }
    let manifest;
    try {
      manifest = await res.json();
    } catch {
      throw new UpdateError('BAD_MANIFEST', 'manifest.json invalide : ce n’est pas du JSON.', { retry: false });
    }
    validateManifest(manifest);
    let base = new URL(manifest.baseUrl || 'files/', this.manifestUrl).href;
    if (!base.endsWith('/')) base += '/';
    manifest.baseUrl = base;
    return manifest;
  }

  // ------------------------------------------------------------- comparaison
  /** Liste des fichiers à télécharger. deep = recalcule l'empreinte de chaque fichier (réparation). */
  async _plan(dir, manifest, local, { deep = false } = {}) {
    const needed = [];
    const recorded = (local && local.files) || {};
    const totalHash = deep ? manifest.files.reduce((s, f) => s + f.size, 0) : 0;
    let hashed = 0;
    let lastEmit = 0;

    for (const f of manifest.files) {
      const target = safeJoin(dir, f.path);
      const st = await statOrNull(target);
      if (!st || !st.isFile() || st.size !== f.size) {
        needed.push(f);
        hashed += f.size;
        continue;
      }
      if (deep) {
        const digest = await hashFile(target, (n) => {
          hashed += n;
          const now = Date.now();
          if (now - lastEmit > 120) {
            lastEmit = now;
            this.emit('progress', { phase: 'verifying', done: hashed, total: totalHash, file: f.path });
          }
        });
        if (digest !== f.sha256) needed.push(f);
      } else {
        const rec = recorded[f.path];
        if (!rec || rec.sha256 !== f.sha256 || rec.size !== f.size) needed.push(f);
      }
    }
    if (deep) this.emit('progress', { phase: 'verifying', done: totalHash, total: totalHash });
    return needed;
  }

  /**
   * Vérifie l'état du jeu.
   * status : 'install' | 'update' | 'ready' | 'no-server' | 'offline'
   */
  async check(dir) {
    const local = this.readLocal(dir);
    const installed = !!(local && local.version);
    const base = {
      installed,
      localVersion: installed ? local.version : null,
      remoteVersion: null,
      downloadSize: 0,
      filesToDownload: 0,
      offline: false,
    };

    let manifest;
    try {
      manifest = await this.fetchManifest();
    } catch (e) {
      if (e.code === 'NO_SERVER') return { ...base, status: installed ? 'ready' : 'no-server' };
      if (e.code === 'NETWORK') return { ...base, status: installed ? 'ready' : 'offline', offline: true };
      throw e;
    }

    const needed = await this._plan(dir, manifest, local);
    const downloadSize = needed.reduce((s, f) => s + f.size, 0);
    let status = 'ready';
    if (!installed) status = 'install';
    else if (needed.length > 0 || local.version !== manifest.version) status = 'update';
    return {
      ...base,
      status,
      remoteVersion: manifest.version,
      downloadSize,
      filesToDownload: needed.length,
    };
  }

  // ------------------------------------------------------------- installation
  /** Installe, met à jour ou répare (repair: true) le jeu dans « dir ». */
  async install(dir, { repair = false } = {}) {
    if (this.abort) throw new UpdateError('BUSY', 'Un téléchargement est déjà en cours.', { retry: false });
    this.abort = new AbortController();
    const signal = this.abort.signal;

    try {
      await fsp.mkdir(dir, { recursive: true });
      const manifest = await this.fetchManifest();
      const local = this.readLocal(dir);
      const record = {
        version: local ? local.version : null,
        exe: manifest.exe,
        args: manifest.args || [],
        files: { ...((local && local.files) || {}) },
      };

      const needed = await this._plan(dir, manifest, local, { deep: repair });
      if (signal.aborted) throw new UpdateError('CANCELLED', 'Téléchargement annulé.', { retry: false });

      const total = needed.reduce((s, f) => s + f.size, 0);
      await this._checkDiskSpace(dir, total);

      // Les fichiers déjà corrects sont enregistrés tels quels
      const neededSet = new Set(needed.map((f) => f.path));
      for (const f of manifest.files) {
        if (neededSet.has(f.path)) delete record.files[f.path];
        else record.files[f.path] = { size: f.size, sha256: f.sha256 };
      }

      try {
        await this._downloadAll(dir, manifest, needed, total, signal, record);
      } finally {
        // On garde la trace de ce qui a déjà été téléchargé (reprise possible)
        await this._writeLocal(dir, record).catch(() => {});
      }

      // Supprime les fichiers qui n'existent plus dans la nouvelle version
      const wanted = new Set(manifest.files.map((f) => f.path));
      for (const old of Object.keys(record.files)) {
        if (wanted.has(old)) continue;
        try {
          const target = safeJoin(dir, old);
          await fsp.rm(target, { force: true });
          await removeEmptyParents(target, dir);
        } catch {
          /* chemin bizarre dans l'ancien état : on ignore */
        }
        delete record.files[old];
      }

      if (process.platform !== 'win32') {
        await fsp.chmod(safeJoin(dir, manifest.exe), 0o755).catch(() => {});
      }

      record.version = manifest.version;
      await this._writeLocal(dir, record);
      this.emit('progress', { phase: 'done', done: total, total });
      return { version: manifest.version, downloaded: needed.length, bytes: total };
    } finally {
      this.abort = null;
    }
  }

  cancel() {
    if (this.abort) this.abort.abort();
  }

  async _checkDiskSpace(dir, needBytes) {
    if (!fsp.statfs || needBytes === 0) return;
    let free;
    try {
      const st = await fsp.statfs(dir);
      free = st.bavail * st.bsize;
    } catch {
      return; // impossible de savoir : on tente quand même
    }
    const margin = 50 * 1024 * 1024;
    if (free < needBytes + margin) {
      throw new UpdateError(
        'DISK_FULL',
        `Pas assez d'espace disque : il faut ${formatSize(needBytes)}, il reste ${formatSize(free)}.`,
        { retry: false }
      );
    }
  }

  async _downloadAll(dir, manifest, files, total, signal, record) {
    let done = 0;
    let filesDone = 0;
    let lastEmit = 0;
    let lastDone = 0;
    let lastTime = Date.now();
    let speed = 0;
    let current = '';

    const emit = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 150) return;
      const dt = (now - lastTime) / 1000;
      if (dt >= 0.5) {
        const instant = (done - lastDone) / dt;
        speed = speed ? speed * 0.7 + instant * 0.3 : instant; // vitesse lissée
        lastDone = done;
        lastTime = now;
      }
      lastEmit = now;
      this.emit('progress', {
        phase: 'downloading',
        done,
        total,
        speed,
        eta: speed > 0 ? Math.round((total - done) / speed) : null,
        filesDone,
        filesTotal: files.length,
        file: current,
      });
    };
    emit(true);

    const queue = [...files].sort((a, b) => b.size - a.size); // les gros fichiers d'abord
    const worker = async () => {
      while (queue.length) {
        if (signal.aborted) return;
        const f = queue.shift();
        current = f.path;
        try {
          await this._downloadFile(dir, manifest.baseUrl, f, signal, (n) => {
            done += n;
            emit();
          });
        } catch (e) {
          queue.length = 0; // une erreur : on arrête les autres téléchargements
          throw e;
        }
        record.files[f.path] = { size: f.size, sha256: f.sha256 };
        filesDone++;
        emit();
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(this.concurrency, files.length); i++) workers.push(worker());
    const results = await Promise.allSettled(workers);
    if (signal.aborted) throw new UpdateError('CANCELLED', 'Téléchargement annulé.', { retry: false });
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    emit(true);
  }

  async _downloadFile(dir, baseUrl, f, signal, onBytes) {
    const target = safeJoin(dir, f.path);
    const part = `${target}.part`;
    await fsp.mkdir(path.dirname(target), { recursive: true });

    for (let attempt = 1; ; attempt++) {
      let received = 0;
      try {
        let res;
        try {
          res = await this.fetch(baseUrl + encodePath(f.path), { signal });
        } catch (e) {
          if (signal.aborted) throw e;
          throw new UpdateError('NETWORK', 'Connexion perdue pendant le téléchargement.');
        }
        if (!res.ok || !res.body) {
          throw new UpdateError(
            'SERVER',
            `Fichier introuvable sur le serveur : ${f.path} (erreur ${res.status}).`,
            { retry: res.status >= 500 }
          );
        }
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(part);
        try {
          for await (const chunk of res.body) {
            hash.update(chunk);
            received += chunk.length;
            onBytes(chunk.length);
            if (!out.write(chunk)) await once(out, 'drain');
          }
          out.end();
          await finished(out);
        } catch (e) {
          out.destroy();
          if (signal.aborted) throw e;
          throw new UpdateError('NETWORK', 'Connexion perdue pendant le téléchargement.');
        }
        if (received !== f.size || hash.digest('hex') !== f.sha256) {
          throw new UpdateError('CORRUPT', `Le fichier ${f.path} est arrivé abîmé.`);
        }
        try {
          await fsp.rename(part, target);
        } catch {
          throw new UpdateError(
            'LOCKED',
            `Impossible de remplacer ${f.path}. Ferme le jeu et réessaie.`,
            { retry: false }
          );
        }
        return;
      } catch (e) {
        onBytes(-received); // on retire de la barre de progression ce qui est perdu
        await fsp.rm(part, { force: true }).catch(() => {});
        if (signal.aborted) throw new UpdateError('CANCELLED', 'Téléchargement annulé.', { retry: false });
        const err = e instanceof UpdateError ? e : new UpdateError('NETWORK', e.message || String(e));
        if (!err.retry || attempt >= this.retries) throw err;
        await delay(this.retryDelayMs * attempt);
      }
    }
  }

  // ------------------------------------------------------------- désinstallation
  async uninstall(dir) {
    const local = this.readLocal(dir);
    if (local) {
      for (const rel of Object.keys(local.files)) {
        try {
          const target = safeJoin(dir, rel);
          await fsp.rm(target, { force: true });
          await removeEmptyParents(target, dir);
        } catch {
          /* ignore */
        }
      }
    }
    await fsp.rm(path.join(dir, STATE_DIR), { recursive: true, force: true });
    await fsp.rmdir(dir).catch(() => {}); // supprime le dossier s'il est vide
  }
}

module.exports = { GameUpdater, UpdateError, safeJoin, validateManifest, hashFile, formatSize, STATE_DIR };
