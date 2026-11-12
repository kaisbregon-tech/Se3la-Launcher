// ============================================================================
//  JEU LIVRÉ EN .ZIP (ex : Midnight City)
//
//  Au lieu d'un serveur, le launcher cherche le zip du jeu sur le PC
//  (Musique\Claude outputs, Téléchargements, Bureau…), par exemple :
//      MidnightCity-3.16-Windows.zip
//  Le numéro de version est lu dans le nom du fichier. Si un zip plus récent
//  que la version installée apparaît, le bouton devient METTRE À JOUR.
//
//  Même fonctionnement que updater.js (même dossier .launcher/installed.json),
//  donc « Jouer », « Désinstaller » et « Ouvrir le dossier » marchent pareil.
//  Ce fichier n'utilise pas Electron : il est testé avec « npm test ».
// ============================================================================

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { GameUpdater, UpdateError, safeJoin } = require('./updater');
const { readZip, extractEntry, crc32File } = require('./zip');

const VERSION_RE = /^\d+(\.\d+)*$/;

/** Compare deux versions « 3.16 », « 3.12.3 »… (négatif si a < b). */
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** « MidnightCity-*-Windows.zip » -> expression régulière (l'étoile = la version). */
function patternToRegex(motif) {
  const parts = String(motif).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('(.+?)')}$`, 'i');
}

/** Version lue dans le nom d'un zip (ou null). */
function versionFromName(name, motif) {
  const m = patternToRegex(motif).exec(path.basename(String(name)));
  return m && VERSION_RE.test(m[1]) ? m[1] : null;
}

/** Cherche les zips du jeu dans une liste de dossiers. Renvoie le plus récent en premier. */
async function scanFolders(folders, motif) {
  const found = [];
  const seen = new Set();
  for (const dir of folders) {
    if (!dir) continue;
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue; // dossier absent
    }
    for (const name of names) {
      const version = versionFromName(name, motif);
      if (!version) continue;
      const full = path.join(dir, name);
      if (seen.has(full.toLowerCase())) continue;
      try {
        const st = await fsp.stat(full);
        if (!st.isFile() || st.size < 22) continue;
        seen.add(full.toLowerCase());
        found.push({ path: full, name, dir, version, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* fichier en cours de copie ou illisible */
      }
    }
  }
  found.sort((a, b) => compareVersions(b.version, a.version) || b.mtimeMs - a.mtimeMs);
  return found;
}

/** Les fichiers du zip, avec le dossier racine commun retiré (« Midnight City/… »). */
function zipFiles(entries) {
  let files = entries
    .filter((e) => !e.isDir)
    .map((e) => ({ ...e, rel: e.name.replace(/\\/g, '/') }))
    .filter((e) => !e.rel.startsWith('__MACOSX/'));
  if (files.length === 0) throw new UpdateError('BAD_ZIP', 'Le zip est vide.', { retry: false });
  const first = files[0].rel.split('/')[0];
  if (files.every((f) => f.rel.includes('/') && f.rel.split('/')[0] === first)) {
    files = files.map((f) => ({ ...f, rel: f.rel.slice(first.length + 1) }));
  }
  return files;
}

class ZipGameUpdater extends GameUpdater {
  /**
   * @param {object} opts
   * @param {string} opts.exe            nom du .exe du jeu dans le zip (ex : MidnightCity.exe)
   * @param {Function} opts.findZips     async () -> liste de zips trouvés (voir scanFolders)
   * @param {string} [opts.motif]        modèle du nom des zips (pour lire la version d'un zip choisi à la main)
   */
  constructor({ exe, findZips, motif = '*.zip' }) {
    super({ manifestUrl: '' });
    this.exe = exe;
    this.findZips = findZips;
    this.motif = motif;
  }

  async _best() {
    try {
      const list = await this.findZips();
      return list && list.length ? list[0] : null;
    } catch {
      return null;
    }
  }

  /** Décrit un zip choisi à la main (n'importe quel nom). */
  async describeZip(file) {
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) throw new UpdateError('NOT_FOUND', 'Fichier introuvable.', { retry: false });
    const name = path.basename(file);
    return { path: file, name, dir: path.dirname(file), version: versionFromName(name, this.motif), size: st.size, mtimeMs: st.mtimeMs };
  }

  /** status : 'install' | 'update' | 'ready' | 'no-zip' */
  async check(dir) {
    const local = this.readLocal(dir);
    const installed = !!(local && local.version);
    const best = await this._best();
    const base = {
      installed,
      localVersion: installed ? local.version : null,
      remoteVersion: best ? best.version : null,
      downloadSize: 0,
      filesToDownload: 0,
      offline: false,
      source: 'zip',
      zipPath: best ? best.path : null,
      zipName: best ? best.name : null,
    };
    if (!best) return { ...base, status: installed ? 'ready' : 'no-zip' };
    if (installed && compareVersions(best.version, local.version) <= 0) return { ...base, status: 'ready' };
    let downloadSize = 0;
    try {
      downloadSize = zipFiles((await readZip(best.path)).entries).reduce((s, f) => s + f.size, 0);
    } catch (e) {
      if (installed) return { ...base, status: 'ready', error: `Zip ${best.name} illisible : ${e.message}` };
      throw new UpdateError('BAD_ZIP', `Le zip ${best.name} est illisible : ${e.message}`, { retry: false });
    }
    return { ...base, status: installed ? 'update' : 'install', downloadSize };
  }

  /** Installe, met à jour ou répare (repair: true) depuis le zip le plus récent (ou « zipPath »). */
  async install(dir, { repair = false, zipPath = null } = {}) {
    if (this.abort) throw new UpdateError('BUSY', 'Une installation est déjà en cours.', { retry: false });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      const zip = zipPath ? await this.describeZip(zipPath) : await this._best();
      if (!zip) {
        throw new UpdateError('NO_ZIP', 'Aucun zip du jeu trouvé. Choisis-le avec « Installer depuis un fichier .zip ».', { retry: false });
      }
      let info;
      try {
        info = await readZip(zip.path);
      } catch (e) {
        throw new UpdateError('BAD_ZIP', `Le zip ${zip.name} est illisible : ${e.message}`, { retry: false });
      }
      const files = zipFiles(info.entries);
      for (const f of files) safeJoin(dir, f.rel); // refuse tout chemin qui sort du dossier du jeu
      const exe = files.find((f) => f.rel.toLowerCase() === String(this.exe).replace(/\\/g, '/').toLowerCase());
      if (!exe) throw new UpdateError('BAD_ZIP', `Ce zip ne contient pas ${this.exe} : ce n'est pas le bon fichier.`, { retry: false });

      await fsp.mkdir(dir, { recursive: true });
      const local = this.readLocal(dir);
      const recorded = (local && local.files) || {};
      const record = {
        version: local ? local.version : null,
        exe: exe.rel,
        args: [],
        source: 'zip',
        zip: zip.name,
        files: { ...recorded },
      };

      // 1. quels fichiers faut-il extraire ?
      const needed = [];
      const verifyTotal = repair ? files.reduce((s, f) => s + f.size, 0) : 0;
      let verified = 0;
      let lastEmit = 0;
      for (const f of files) {
        if (signal.aborted) throw new UpdateError('CANCELLED', 'Installation annulée.', { retry: false });
        const target = safeJoin(dir, f.rel);
        const st = await fsp.stat(target).catch(() => null);
        let ok = !!(st && st.isFile() && st.size === f.size);
        if (ok && repair) {
          const c = await crc32File(target, (n) => {
            verified += n;
            const now = Date.now();
            if (now - lastEmit > 120) {
              lastEmit = now;
              this.emit('progress', { phase: 'verifying', done: verified, total: verifyTotal, file: f.rel });
            }
          });
          ok = c === f.crc32;
        } else {
          if (repair) verified += f.size;
          const rec = recorded[f.rel];
          ok = ok && !!rec && rec.crc32 === f.crc32 && rec.size === f.size;
        }
        if (ok) record.files[f.rel] = { ...(recorded[f.rel] || {}), size: f.size, crc32: f.crc32 };
        else {
          delete record.files[f.rel];
          needed.push(f);
        }
      }
      if (repair) this.emit('progress', { phase: 'verifying', done: verifyTotal, total: verifyTotal });

      const total = needed.reduce((s, f) => s + f.size, 0);
      await this._checkDiskSpace(dir, total);

      // 2. extraction
      let done = 0;
      let filesDone = 0;
      let speed = 0;
      let lastDone = 0;
      let lastTime = Date.now();
      lastEmit = 0;
      let current = '';
      const emit = (force = false) => {
        const now = Date.now();
        if (!force && now - lastEmit < 150) return;
        const dt = (now - lastTime) / 1000;
        if (dt >= 0.5) {
          const instant = (done - lastDone) / dt;
          speed = speed ? speed * 0.7 + instant * 0.3 : instant;
          lastDone = done;
          lastTime = now;
        }
        lastEmit = now;
        this.emit('progress', {
          phase: 'extracting',
          done,
          total,
          speed,
          eta: speed > 0 ? Math.round((total - done) / speed) : null,
          filesDone,
          filesTotal: needed.length,
          file: current,
        });
      };
      emit(true);
      try {
        for (const f of needed) {
          if (signal.aborted) throw new UpdateError('CANCELLED', 'Installation annulée.', { retry: false });
          current = f.rel;
          const target = safeJoin(dir, f.rel);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          let sha256;
          try {
            sha256 = await extractEntry(zip.path, f, target, {
              signal,
              onBytes: (n) => {
                done += n;
                emit();
              },
            });
          } catch (e) {
            if (e.code === 'CANCELLED' || signal.aborted) throw new UpdateError('CANCELLED', 'Installation annulée.', { retry: false });
            throw new UpdateError(e.code || 'BAD_ZIP', e.message, { retry: false });
          }
          record.files[f.rel] = { size: f.size, crc32: f.crc32, sha256 };
          filesDone++;
          emit();
        }
      } finally {
        await this._writeLocal(dir, record).catch(() => {});
      }

      // 3. supprime les fichiers qui n'existent plus dans cette version
      const wanted = new Set(files.map((f) => f.rel));
      for (const old of Object.keys(record.files)) {
        if (wanted.has(old)) continue;
        try {
          const target = safeJoin(dir, old);
          await fsp.rm(target, { force: true });
        } catch {
          /* ignore */
        }
        delete record.files[old];
      }

      record.version = zip.version || (local && local.version) || 'zip';
      await this._writeLocal(dir, record);
      this.emit('progress', { phase: 'done', done: total, total });
      return { version: record.version, extracted: needed.length, bytes: total };
    } finally {
      this.abort = null;
    }
  }
}

/**
 * Jeu en ligne avec un zip en secours : le serveur d'abord (tout le monde reçoit les mises à jour) ;
 * si le serveur est injoignable, le launcher propose le zip trouvé sur le PC.
 * « Installer depuis un fichier .zip… » passe toujours par le zip choisi.
 */
class HybridUpdater extends EventEmitter {
  constructor({ server, zip }) {
    super();
    this.server = server;
    this.zip = zip;
    this.lastSource = 'server';
    for (const u of [server, zip]) u.on('progress', (p) => this.emit('progress', p));
  }

  readLocal(dir) {
    return this.server.readLocal(dir);
  }

  isInstalled(dir) {
    return this.server.isInstalled(dir);
  }

  async check(dir) {
    let r = null;
    let err = null;
    try {
      r = await this.server.check(dir);
    } catch (e) {
      err = e;
    }
    if (r && !r.offline && r.status !== 'no-server') {
      this.lastSource = 'server';
      return { ...r, source: 'server' };
    }
    // serveur injoignable (ou pas encore configuré) : y a-t-il un zip sur le PC ?
    const z = await this.zip.check(dir).catch(() => null);
    if (z && (z.status === 'install' || z.status === 'update')) {
      this.lastSource = 'zip';
      return z;
    }
    this.lastSource = 'server';
    if (r) return r;
    throw err;
  }

  install(dir, { repair = false, zipPath = null } = {}) {
    if (zipPath || this.lastSource === 'zip') return this.zip.install(dir, { repair, zipPath });
    return this.server.install(dir, { repair });
  }

  cancel() {
    this.server.cancel();
    this.zip.cancel();
  }

  uninstall(dir) {
    return this.server.uninstall(dir);
  }
}

module.exports = { ZipGameUpdater, HybridUpdater, scanFolders, compareVersions, versionFromName, patternToRegex, zipFiles };
