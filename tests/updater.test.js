// Tests du téléchargement / mises à jour (lancer avec : npm test)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { GameUpdater, safeJoin, validateManifest } = require('../src/main/updater');
const { GameManager, splitArgs } = require('../src/main/game');
const { publish } = require('../tools/publier-jeu');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
const build = path.join(tmp, 'build');
const pub = path.join(tmp, 'publication');
const install = path.join(tmp, 'install');
let server;
let base;
const faults = { corruptOnce: new Set(), notFound: new Set(), requests: [] };

function write(rel, content) {
  const f = path.join(build, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

before(async () => {
  write('MonJeu.exe', 'EXE-v1');
  write('Data/level1.pak', Buffer.alloc(300 * 1024, 1));
  write('Data/level2.pak', Buffer.alloc(200 * 1024, 2));
  write('Data/Sous dossier/é tè.txt', 'accents et espaces');
  write('Thumbs.db', 'ignoré');
  await publish({ source: build, out: pub, version: '1.0.0', exe: 'MonJeu.exe', log: () => {} });

  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(url.pathname.slice(1));
    faults.requests.push(rel);
    if (faults.notFound.has(rel)) return res.writeHead(404).end();
    const file = path.join(pub, ...rel.split('/'));
    if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    let data = fs.readFileSync(file);
    if (faults.corruptOnce.has(rel)) {
      faults.corruptOnce.delete(rel);
      data = Buffer.from(data);
      data[0] ^= 0xff;
    }
    res.writeHead(200, { 'Content-Length': data.length });
    res.end(data);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const makeUpdater = () => new GameUpdater({ manifestUrl: `${base}/manifest.json`, retryDelayMs: 10 });

test("l'outil de publication ignore Thumbs.db et produit un manifest valide", () => {
  const m = JSON.parse(fs.readFileSync(path.join(pub, 'manifest.json'), 'utf8'));
  assert.strictEqual(m.version, '1.0.0');
  assert.strictEqual(m.exe, 'MonJeu.exe');
  assert.ok(!m.files.some((f) => f.path === 'Thumbs.db'));
  assert.strictEqual(m.files.length, 4);
  validateManifest(m);
  assert.ok(fs.existsSync(path.join(pub, 'news.json')));
});

test('jeu pas installé -> status install', async () => {
  const r = await makeUpdater().check(install);
  assert.strictEqual(r.status, 'install');
  assert.strictEqual(r.remoteVersion, '1.0.0');
  assert.ok(r.downloadSize > 500 * 1024);
});

test('installation complète, avec un fichier abîmé une fois (retéléchargé)', async () => {
  faults.corruptOnce.add('files/Data/level1.pak');
  const u = makeUpdater();
  const phases = new Set();
  let last;
  u.on('progress', (p) => {
    phases.add(p.phase);
    last = p;
  });
  const r = await u.install(install);
  assert.strictEqual(r.downloaded, 4);
  assert.ok(phases.has('downloading'));
  assert.strictEqual(last.phase, 'done');
  assert.strictEqual(fs.readFileSync(path.join(install, 'MonJeu.exe'), 'utf8'), 'EXE-v1');
  assert.strictEqual(fs.readFileSync(path.join(install, 'Data', 'Sous dossier', 'é tè.txt'), 'utf8'), 'accents et espaces');
  assert.ok(!fs.readdirSync(path.join(install, 'Data')).some((f) => f.endsWith('.part')));
  const c = await u.check(install);
  assert.strictEqual(c.status, 'ready');
  assert.strictEqual(c.localVersion, '1.0.0');
});

test('mise à jour : seuls les fichiers modifiés sont téléchargés, les anciens supprimés', async () => {
  write('MonJeu.exe', 'EXE-v2');
  fs.rmSync(path.join(build, 'Data', 'level2.pak'));
  write('Data/level3.pak', 'nouveau niveau');
  await publish({ source: build, out: pub, version: '1.1.0', exe: 'MonJeu.exe', log: () => {} });

  const u = makeUpdater();
  const c = await u.check(install);
  assert.strictEqual(c.status, 'update');
  assert.strictEqual(c.filesToDownload, 2);

  faults.requests.length = 0;
  const r = await u.install(install);
  assert.strictEqual(r.downloaded, 2);
  const fileRequests = faults.requests.filter((x) => x.startsWith('files/')).sort();
  assert.deepStrictEqual(fileRequests, ['files/Data/level3.pak', 'files/MonJeu.exe']);
  assert.strictEqual(fs.readFileSync(path.join(install, 'MonJeu.exe'), 'utf8'), 'EXE-v2');
  assert.ok(!fs.existsSync(path.join(install, 'Data', 'level2.pak')));
  assert.strictEqual((await u.check(install)).status, 'ready');
});

test('les fichiers du joueur (sauvegardes) ne sont jamais supprimés', async () => {
  fs.writeFileSync(path.join(install, 'Data', 'sauvegarde.sav'), 'ma partie');
  await makeUpdater().install(install);
  assert.ok(fs.existsSync(path.join(install, 'Data', 'sauvegarde.sav')));
});

test('réparation : un fichier modifié à la main est détecté et réparé', async () => {
  fs.writeFileSync(path.join(install, 'MonJeu.exe'), 'EXE-v9'); // même taille, contenu différent
  const u = makeUpdater();
  assert.strictEqual((await u.check(install)).status, 'ready'); // la vérif rapide ne le voit pas
  const r = await u.install(install, { repair: true });
  assert.strictEqual(r.downloaded, 1);
  assert.strictEqual(fs.readFileSync(path.join(install, 'MonJeu.exe'), 'utf8'), 'EXE-v2');
});

test('fichier manquant sur le serveur -> erreur claire, puis reprise', async () => {
  fs.rmSync(path.join(install, 'Data', 'level3.pak'));
  faults.notFound.add('files/Data/level3.pak');
  const u = makeUpdater();
  await assert.rejects(u.install(install), /introuvable sur le serveur/);
  faults.notFound.clear();
  const r = await u.install(install);
  assert.strictEqual(r.downloaded, 1);
});

test('annulation', async () => {
  write('Data/gros.pak', Buffer.alloc(3 * 1024 * 1024, 7));
  await publish({ source: build, out: pub, version: '1.2.0', exe: 'MonJeu.exe', log: () => {} });
  const u = makeUpdater();
  u.once('progress', () => u.cancel());
  await assert.rejects(u.install(install), (e) => e.code === 'CANCELLED');
  assert.strictEqual((await u.check(install)).status, 'update');
  await u.install(install);
  assert.strictEqual((await u.check(install)).status, 'ready');
});

test('sans Internet : jeu installé = jouable, sinon offline', async () => {
  const dead = new GameUpdater({ manifestUrl: 'http://127.0.0.1:1/manifest.json' });
  assert.strictEqual((await dead.check(install)).status, 'ready');
  assert.strictEqual((await dead.check(path.join(tmp, 'vide'))).status, 'offline');
  const none = new GameUpdater({ manifestUrl: '' });
  assert.strictEqual((await none.check(path.join(tmp, 'vide'))).status, 'no-server');
});

test('sécurité : chemins dangereux refusés', () => {
  for (const bad of ['../evil.exe', 'a/../../b', '/etc/passwd', 'C:/Windows/x', '.launcher/installed.json', 'a//b', '..\\x']) {
    assert.throws(() => safeJoin(install, bad), /interdit/, bad);
  }
  assert.ok(safeJoin(install, 'Data/ok.pak').startsWith(install));
});

test('désinstallation : supprime le jeu mais garde les sauvegardes', async () => {
  const u = makeUpdater();
  await u.uninstall(install);
  assert.ok(!fs.existsSync(path.join(install, 'MonJeu.exe')));
  assert.ok(!fs.existsSync(path.join(install, '.launcher')));
  assert.ok(fs.existsSync(path.join(install, 'Data', 'sauvegarde.sav')));
  assert.strictEqual((await u.check(install)).status, 'install');
});

test('GameManager : lancement du jeu avec les infos du joueur', async () => {
  const u = makeUpdater();
  await u.install(install);
  let spawned;
  const { EventEmitter } = require('events');
  const fakeChild = new EventEmitter();
  const gm = new GameManager({
    updater: u,
    auth: {
      getIdToken: async () => 'TOKEN123',
      publicUser: () => ({ uid: 'u1', displayName: 'Tequzal', email: 't@x.fr', demo: false }),
    },
    getInstallDir: () => install,
    getSettings: () => ({ argumentsSupp: '-fullscreen -nom "Mon Nom"' }),
    spawnImpl: (exe, args, opts) => {
      spawned = { exe, args, opts };
      setImmediate(() => fakeChild.emit('spawn'));
      return fakeChild;
    },
  });
  await gm.check();
  assert.strictEqual(gm.getState().status, 'ready');
  const exited = new Promise((r) => gm.once('exited', r));
  await gm.play();
  assert.strictEqual(gm.getState().running, true);
  assert.strictEqual(spawned.exe, path.join(install, 'MonJeu.exe'));
  assert.deepStrictEqual(spawned.args, ['-fullscreen', '-nom', 'Mon Nom']);
  assert.strictEqual(spawned.opts.env.LAUNCHER_ID_TOKEN, 'TOKEN123');
  assert.strictEqual(spawned.opts.env.LAUNCHER_PSEUDO, 'Tequzal');
  await assert.rejects(gm.play(), /déjà lancé/);
  fakeChild.emit('exit', 0);
  await exited;
  assert.strictEqual(gm.getState().running, false);
});

test('splitArgs', () => {
  assert.deepStrictEqual(splitArgs(''), []);
  assert.deepStrictEqual(splitArgs('-a  "b c" d'), ['-a', 'b c', 'd']);
});
