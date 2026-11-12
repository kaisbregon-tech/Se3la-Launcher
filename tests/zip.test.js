// Tests de l'installation d'un jeu livré en .zip (lancer avec : npm test)
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { readZip, crc32 } = require('../src/main/zip');
const { ZipGameUpdater, scanFolders, compareVersions, versionFromName } = require('../src/main/zip-updater');
const { GameManager } = require('../src/main/game');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-zip-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Petit créateur de zip pour les tests. files : { 'chemin': contenu }, opts.store = sans compression. */
function makeZip(file, files, { store = false, zip64 = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = store ? data : zlib.deflateRawSync(data);
    const method = store ? 0 : 8;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    // répertoire central (avec un champ ZIP64 si demandé)
    let extra = Buffer.alloc(0);
    if (zip64) {
      extra = Buffer.alloc(4 + 24);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(comp.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 4);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(zip64 ? 0xffffffff : comp.length, 20);
    ch.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(ch, nameBuf, extra);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const n = Object.keys(files).length;
  const parts = [...locals, cd];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeBigUInt64LE(BigInt(n), 24);
    rec.writeBigUInt64LE(BigInt(n), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(rec, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : n, 8);
  end.writeUInt16LE(zip64 ? 0xffff : n, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  parts.push(end);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(parts));
}

const BIG = Buffer.alloc(3 * 1024 * 1024 + 17, 7); // ~3 Mo, pour avoir plusieurs morceaux
function gameFiles(version) {
  return {
    'Midnight City/MidnightCity.exe': `EXE ${version}`,
    'Midnight City/LISEZMOI.txt': `Version ${version} – é à ç`,
    'Midnight City/data/big.pak': BIG,
  };
}

test('versions : lecture dans le nom et comparaison', () => {
  assert.strictEqual(versionFromName('MidnightCity-3.16-Windows.zip', 'MidnightCity-*-Windows.zip'), '3.16');
  assert.strictEqual(versionFromName('midnightcity-3.12.3-windows.zip', 'MidnightCity-*-Windows.zip'), '3.12.3');
  assert.strictEqual(versionFromName('MidnightCity-3.16-Windows (1).zip', 'MidnightCity-*-Windows.zip'), null);
  assert.strictEqual(versionFromName('midnight-city-3.16-projet-1sur2.zip', 'MidnightCity-*-Windows.zip'), null);
  assert.ok(compareVersions('3.16', '3.9') > 0);
  assert.ok(compareVersions('3.12.3', '3.12') > 0);
  assert.strictEqual(compareVersions('3.16', '3.16.0'), 0);
});

test('lecture d’un zip : stocké, compressé et ZIP64', async () => {
  for (const opts of [{}, { store: true }, { zip64: true }]) {
    const f = path.join(tmp, 'lecture', `t-${JSON.stringify(opts).replace(/\W/g, '')}.zip`);
    makeZip(f, gameFiles('1'), opts);
    const z = await readZip(f);
    assert.strictEqual(z.entries.length, 3);
    const big = z.entries.find((e) => e.name.endsWith('big.pak'));
    assert.strictEqual(big.size, BIG.length);
    assert.strictEqual(big.crc32, crc32(BIG));
  }
  fs.writeFileSync(path.join(tmp, 'pas-un-zip.zip'), 'bonjour');
  await assert.rejects(readZip(path.join(tmp, 'pas-un-zip.zip')), /pas un zip/);
});

test('recherche des zips : le plus récent d’abord, les autres fichiers ignorés', async () => {
  const d1 = path.join(tmp, 'scan', 'Musique', 'Claude outputs');
  const d2 = path.join(tmp, 'scan', 'Telechargements');
  makeZip(path.join(d1, 'MidnightCity-3.9-Windows.zip'), gameFiles('3.9'));
  makeZip(path.join(d1, 'MidnightCity-3.16-Windows.zip'), gameFiles('3.16'));
  makeZip(path.join(d2, 'MidnightCity-3.15-Windows.zip'), gameFiles('3.15'));
  fs.writeFileSync(path.join(d1, 'midnight-city-3.16-projet-1sur2.zip'), 'x'.repeat(100));
  const list = await scanFolders([d1, d2, path.join(tmp, 'absent')], 'MidnightCity-*-Windows.zip');
  assert.deepStrictEqual(list.map((z) => z.version), ['3.16', '3.15', '3.9']);
});

test('installation, mise à jour, réparation et désinstallation depuis un zip', async () => {
  const zips = path.join(tmp, 'flux', 'zips');
  const dir = path.join(tmp, 'flux', 'Jeu');
  makeZip(path.join(zips, 'MidnightCity-3.15-Windows.zip'), { ...gameFiles('3.15'), 'Midnight City/ancien.txt': 'à supprimer' });
  const up = new ZipGameUpdater({ exe: 'MidnightCity.exe', motif: 'MidnightCity-*-Windows.zip', findZips: () => scanFolders([zips], 'MidnightCity-*-Windows.zip') });
  const phases = new Set();
  up.on('progress', (p) => phases.add(p.phase));

  let st = await up.check(dir);
  assert.strictEqual(st.status, 'install');
  assert.strictEqual(st.remoteVersion, '3.15');
  assert.strictEqual(st.downloadSize, BIG.length + Buffer.byteLength('EXE 3.15') + Buffer.byteLength('Version 3.15 – é à ç') + Buffer.byteLength('à supprimer'));

  await up.install(dir);
  assert.ok(phases.has('extracting') && phases.has('done'));
  // le dossier « Midnight City/ » du zip est retiré : le jeu est directement dans le dossier
  assert.strictEqual(fs.readFileSync(path.join(dir, 'MidnightCity.exe'), 'utf8'), 'EXE 3.15');
  assert.ok(fs.readFileSync(path.join(dir, 'data', 'big.pak')).equals(BIG));
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.part')).length, 0);
  st = await up.check(dir);
  assert.strictEqual(st.status, 'ready');
  assert.strictEqual(st.localVersion, '3.15');

  // un zip plus récent arrive : mise à jour, l'ancien fichier disparaît, le gros fichier identique n'est pas réécrit
  makeZip(path.join(zips, 'MidnightCity-3.16-Windows.zip'), gameFiles('3.16'));
  const bigBefore = fs.statSync(path.join(dir, 'data', 'big.pak')).mtimeMs;
  st = await up.check(dir);
  assert.strictEqual(st.status, 'update');
  assert.strictEqual(st.remoteVersion, '3.16');
  const r = await up.install(dir);
  assert.strictEqual(r.version, '3.16');
  assert.strictEqual(r.extracted, 2);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'MidnightCity.exe'), 'utf8'), 'EXE 3.16');
  assert.ok(!fs.existsSync(path.join(dir, 'ancien.txt')));
  assert.strictEqual(fs.statSync(path.join(dir, 'data', 'big.pak')).mtimeMs, bigBefore);
  assert.strictEqual((await up.check(dir)).status, 'ready');

  // un fichier abîmé (même taille) : la réparation le retrouve et le remplace
  const big = path.join(dir, 'data', 'big.pak');
  const bad = Buffer.from(BIG);
  bad[12345] ^= 0xff;
  fs.writeFileSync(big, bad);
  phases.clear();
  const rep = await up.install(dir, { repair: true });
  assert.ok(phases.has('verifying'));
  assert.strictEqual(rep.extracted, 1);
  assert.ok(fs.readFileSync(big).equals(BIG));

  // les sauvegardes et fichiers ajoutés par le joueur ne sont jamais touchés
  fs.writeFileSync(path.join(dir, 'ma-sauvegarde.sav'), 'perso');
  await up.uninstall(dir);
  assert.ok(!fs.existsSync(path.join(dir, 'MidnightCity.exe')));
  assert.ok(fs.existsSync(path.join(dir, 'ma-sauvegarde.sav')));
  assert.strictEqual((await up.check(dir)).status, 'install');
});

test('zip choisi à la main, zip sans le jeu, zip piégé et aucun zip', async () => {
  const dir = path.join(tmp, 'main', 'Jeu');
  const none = new ZipGameUpdater({ exe: 'MidnightCity.exe', motif: 'MidnightCity-*-Windows.zip', findZips: async () => [] });
  assert.strictEqual((await none.check(dir)).status, 'no-zip');
  await assert.rejects(none.install(dir), /Aucun zip/);

  const perso = path.join(tmp, 'main', 'mon jeu (copie).zip');
  makeZip(perso, gameFiles('x'), { store: true });
  await none.install(dir, { zipPath: perso });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'MidnightCity.exe'), 'utf8'), 'EXE x');
  assert.strictEqual((await none.check(dir)).status, 'ready');

  const wrong = path.join(tmp, 'main', 'autre.zip');
  makeZip(wrong, { 'photos/a.jpg': 'img' });
  await assert.rejects(none.install(path.join(tmp, 'main', 'Jeu2'), { zipPath: wrong }), /ne contient pas MidnightCity\.exe/);

  const evil = path.join(tmp, 'main', 'piege.zip');
  makeZip(evil, { 'MidnightCity.exe': 'x', '../../dehors.txt': 'non' });
  await assert.rejects(none.install(path.join(tmp, 'main', 'Jeu3'), { zipPath: evil }), /Chemin interdit/);
  assert.ok(!fs.existsSync(path.join(tmp, 'dehors.txt')));

  // zip abîmé (données modifiées) : refusé, rien n'est mis en place
  const broken = path.join(tmp, 'main', 'MidnightCity-9.0-Windows.zip');
  makeZip(broken, gameFiles('9.0'), { store: true });
  const raw = fs.readFileSync(broken);
  raw[raw.indexOf('EXE 9.0')] ^= 0x20;
  fs.writeFileSync(broken, raw);
  await assert.rejects(none.install(path.join(tmp, 'main', 'Jeu4'), { zipPath: broken }), /abîmé/);
  assert.ok(!fs.existsSync(path.join(tmp, 'main', 'Jeu4', 'MidnightCity.exe')));
});

test('le gestionnaire lance bien le .exe extrait du zip', async () => {
  const zips = path.join(tmp, 'lance', 'zips');
  const dir = path.join(tmp, 'lance', 'Jeu');
  makeZip(path.join(zips, 'MidnightCity-3.16-Windows.zip'), gameFiles('3.16'));
  const up = new ZipGameUpdater({ exe: 'MidnightCity.exe', motif: 'MidnightCity-*-Windows.zip', findZips: () => scanFolders([zips], 'MidnightCity-*-Windows.zip') });
  let spawned = null;
  const { EventEmitter } = require('events');
  const gm = new GameManager({
    updater: up,
    auth: { getIdToken: async () => 'jeton', publicUser: () => ({ uid: 'u1', displayName: 'Nico', email: 'n@x.fr', demo: true }) },
    getInstallDir: () => dir,
    getSettings: () => ({ argumentsSupp: '' }),
    spawnImpl: (exe, args, opts) => {
      spawned = { exe, args, opts };
      const child = new EventEmitter();
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  });
  assert.strictEqual((await gm.check()).status, 'install');
  await gm.install();
  assert.strictEqual(gm.getState().status, 'ready');
  assert.strictEqual(gm.getState().localVersion, '3.16');
  await gm.play();
  assert.strictEqual(spawned.exe, path.join(dir, 'MidnightCity.exe'));
  assert.strictEqual(spawned.opts.cwd, dir);
  assert.strictEqual(spawned.opts.env.LAUNCHER_PSEUDO, 'Nico');
});

test('en ligne d’abord, zip en secours, et pas de re-téléchargement après une installation par zip', async () => {
  const http = require('http');
  const { GameUpdater } = require('../src/main/updater');
  const { HybridUpdater } = require('../src/main/zip-updater');
  const { publish } = require('../tools/publier-jeu');
  const root = path.join(tmp, 'hybride');
  const zips = path.join(root, 'zips');
  const dir = path.join(root, 'Jeu');
  // la même version 3.16 : en zip sur le PC et publiée sur un « serveur »
  const files = { 'Midnight City/MidnightCity.exe': 'EXE 3.16', 'Midnight City/LISEZMOI.txt': 'v3.16' };
  makeZip(path.join(zips, 'MidnightCity-3.16-Windows.zip'), files);
  const build = path.join(root, 'build');
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, 'MidnightCity.exe'), 'EXE 3.16');
  fs.writeFileSync(path.join(build, 'LISEZMOI.txt'), 'v3.16');
  const pub = path.join(root, 'pub');
  await publish({ source: build, out: pub, version: '3.16', exe: 'MidnightCity.exe', log: () => {} });
  let online = false;
  const requests = [];
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    requests.push(rel);
    if (!online) return res.destroy(); // serveur injoignable
    const f = path.join(pub, ...rel.split('/'));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/manifest.json`;
    const hy = new HybridUpdater({
      server: new GameUpdater({ manifestUrl: url, retryDelayMs: 5 }),
      zip: new ZipGameUpdater({ exe: 'MidnightCity.exe', motif: 'MidnightCity-*-Windows.zip', findZips: () => scanFolders([zips], 'MidnightCity-*-Windows.zip') }),
    });
    // hors ligne : le zip du PC prend le relais
    let st = await hy.check(dir);
    assert.strictEqual(st.status, 'install');
    assert.strictEqual(st.source, 'zip');
    await hy.install(dir);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'MidnightCity.exe'), 'utf8'), 'EXE 3.16');
    // en ligne : même version, rien à télécharger
    online = true;
    requests.length = 0;
    st = await hy.check(dir);
    assert.strictEqual(st.source, 'server');
    assert.strictEqual(st.status, 'ready');
    // une nouvelle version publiée en ligne : mise à jour depuis le serveur
    fs.writeFileSync(path.join(build, 'MidnightCity.exe'), 'EXE 3.17 !');
    await publish({ source: build, out: pub, version: '3.17', exe: 'MidnightCity.exe', log: () => {} });
    st = await hy.check(dir);
    assert.strictEqual(st.status, 'update');
    assert.strictEqual(st.remoteVersion, '3.17');
    await hy.install(dir);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'MidnightCity.exe'), 'utf8'), 'EXE 3.17 !');
    assert.ok(!requests.includes('files/LISEZMOI.txt'), 'le fichier inchangé ne doit pas être retéléchargé');
    assert.strictEqual((await hy.check(dir)).status, 'ready');
  } finally {
    server.close();
  }
});
