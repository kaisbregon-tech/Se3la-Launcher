#!/usr/bin/env node
// ============================================================================
//  PUBLIER POUR TOUT LE MONDE (lancé par PUBLIER.bat, un double-clic)
//
//  1. Le jeu : si un zip plus récent que la version en ligne est trouvé
//     (ex : Musique\Claude outputs\MidnightCity-3.17-Windows.zip), ses fichiers
//     sont envoyés dans une « release » GitHub et jeux/midnight-city/manifest.json
//     est mis à jour.
//  2. Le launcher : les fichiers du dossier sont envoyés sur le dépôt. S'ils ont
//     changé, le numéro de version augmente tout seul (1.1.0 -> 1.1.1) et GitHub
//     construit et publie le nouveau launcher (.github/workflows/launcher.yml).
//  Les launchers installés chez tout le monde se mettent alors à jour.
//
//  Le jeton GitHub reste sur ton PC (%APPDATA%\SEL3A\github.json), jamais dans le dépôt.
// ============================================================================

const API = process.env.SEL3A_GITHUB_API || 'https://api.github.com'; // (remplacé pendant les tests)
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'publication', '.git', '.firebase', '.launcher']);
const IGNORE_FILES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
// fichiers qui changent le launcher lui-même (=> nouvelle version à construire)
const LAUNCHER_RE = /^(src\/|demo\/|build\/|launcher\.config\.js$|package\.json$|package-lock\.json$)/;
// fichiers du dépôt écrits depuis un autre fichier du dossier (la recette GitHub est gardée dans tools/)
const VIRTUAL = { '.github/workflows/launcher.yml': 'tools/github-workflow.yml' };
const sourceOf = (rel) => path.join(ROOT, ...(VIRTUAL[rel] || rel).split('/'));

const log = (...a) => console.log(...a);
const pkgPath = path.join(ROOT, 'package.json');
const readPkg = () => JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// ---------------------------------------------------------------- jeton GitHub (sur ce PC uniquement)
const secretFile = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'SEL3A', 'github.json');
let TOKEN = '';

async function gh(method, url, body, { ok404 = false, raw = false } = {}) {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sel3a-publier',
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (ok404 && (res.status === 404 || res.status === 409)) return null;
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GitHub a refusé (${res.status}) ${method} ${url.replace(API, '')} : ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return raw ? text : text ? JSON.parse(text) : {};
}

/** Demande le jeton sans l'afficher à l'écran (des étoiles à la place). */
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setEncoding('utf8');
    if (!stdin.isTTY) {
      // pas une vraie fenêtre (tests) : lecture d'une ligne
      let buf = '';
      const onData = (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        stdin.off('data', onData);
        stdin.pause();
        process.stdout.write('\n');
        resolve(buf.slice(0, i).replace(/\r$/, ''));
      };
      stdin.on('data', onData);
      stdin.resume();
      return;
    }
    let val = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(val);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(1); // Ctrl+C
        }
        if (ch === '\u007f' || ch === '\b') {
          if (val) {
            val = val.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          val += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function login() {
  try {
    const saved = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
    TOKEN = saved.token;
    const me = await gh('GET', '/user');
    return me.login;
  } catch {
    /* pas encore de jeton, ou jeton expiré / supprimé */
  }
  log('\nIl faut un jeton GitHub (une seule fois). Voir GUIDE.md, « Partager le launcher ».');
  log(`Il commence par github_pat_ et doit avoir, sur le dépôt ${readPkg().build.publish[0].repo} : Contents et Workflows en « Read and write ».`);
  for (;;) {
    TOKEN = (await askHidden('\nColle ton jeton ici (il ne s\'affiche pas) puis appuie sur Entrée : ')).trim();
    try {
      const me = await gh('GET', '/user');
      await fsp.mkdir(path.dirname(secretFile), { recursive: true });
      await fsp.writeFile(secretFile, JSON.stringify({ login: me.login, token: TOKEN }));
      log(`Connecté à GitHub en tant que ${me.login}. Le jeton est gardé sur ce PC uniquement.`);
      return me.login;
    } catch {
      log('Ce jeton ne marche pas. Vérifie-le et réessaie.');
    }
  }
}

// ---------------------------------------------------------------- fichiers locaux
async function walk(rel = '') {
  const out = [];
  for (const e of await fsp.readdir(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) out.push(...(await walk(r)));
    } else if (e.isFile() && !IGNORE_FILES.has(e.name.toLowerCase()) && !e.name.endsWith('.log') && !e.name.endsWith('.part')) {
      out.push(r);
    }
  }
  return out;
}

const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// ---------------------------------------------------------------- envoi du dossier sur le dépôt (un seul commit)
async function remoteTree(owner, repo) {
  const ref = await gh('GET', `/repos/${owner}/${repo}/git/ref/heads/main`, null, { ok404: true });
  if (!ref) return null;
  const commit = await gh('GET', `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
  const tree = await gh('GET', `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  const files = new Map();
  for (const t of tree.tree) if (t.type === 'blob') files.set(t.path, t.sha);
  return { head: ref.object.sha, tree: commit.tree.sha, files };
}

/** Dépôt vide : un premier fichier crée la branche main (il en faut une pour les releases). */
async function ensureInitialized(owner, repo) {
  if (await remoteTree(owner, repo)) return;
  log('Dépôt vide : premier envoi.');
  await gh('PUT', `/repos/${owner}/${repo}/contents/README.md`, {
    message: 'Premier envoi',
    content: fs.readFileSync(path.join(ROOT, 'README.md')).toString('base64'),
  });
  if (!(await remoteTree(owner, repo))) {
    throw new Error('La branche principale du dépôt doit s\'appeler « main » (GitHub → Settings → Default branch).');
  }
}

async function diffWithRepo(owner, repo) {
  const remote = await remoteTree(owner, repo);
  const local = await walk();
  for (const [target, src] of Object.entries(VIRTUAL)) if (fs.existsSync(path.join(ROOT, src))) local.push(target);
  const changed = [];
  for (const rel of local) {
    const buf = await fsp.readFile(sourceOf(rel));
    if (remote.files.get(rel) !== blobSha(buf)) changed.push(rel);
  }
  const localSet = new Set(local);
  const removed = [...remote.files.keys()].filter((p) => !localSet.has(p));
  return { remote, changed, removed };
}

async function commit(owner, repo, remote, changed, removed, message) {
  const tree = [];
  for (const rel of changed) {
    const buf = await fsp.readFile(sourceOf(rel));
    const blob = await gh('POST', `/repos/${owner}/${repo}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const rel of removed) tree.push({ path: rel, mode: '100644', type: 'blob', sha: null });
  const t = await gh('POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: remote.tree, tree });
  const c = await gh('POST', `/repos/${owner}/${repo}/git/commits`, { message, tree: t.sha, parents: [remote.head] });
  await gh('PATCH', `/repos/${owner}/${repo}/git/refs/heads/main`, { sha: c.sha });
}

function bumpPatch() {
  const bump = (v) => v.replace(/^(\d+)\.(\d+)\.(\d+)$/, (_m, a, b, c) => `${a}.${b}.${Number(c) + 1}`);
  const pkg = readPkg();
  const old = pkg.version;
  const next = bump(old);
  for (const f of ['package.json', 'package-lock.json']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    let text = fs.readFileSync(p, 'utf8');
    let n = 0;
    // seulement la version du launcher (les premières occurrences), pas celles des modules
    text = text.replace(new RegExp(`"version": "${old.replace(/\./g, '\\.')}"`, 'g'), (m) => (n++ < (f === 'package.json' ? 1 : 2) ? `"version": "${next}"` : m));
    fs.writeFileSync(p, text);
  }
  return next;
}

// ---------------------------------------------------------------- jeux
function homeFolder(spec) {
  const alias = { musique: 'Music', telechargements: 'Downloads', 'téléchargements': 'Downloads', bureau: 'Desktop', documents: 'Documents' };
  const parts = String(spec).replace(/\\/g, '/').split('/').filter(Boolean);
  if (path.isAbsolute(spec)) return spec;
  const base = alias[(parts[0] || '').toLowerCase()];
  return base ? path.join(os.homedir(), base, ...parts.slice(1)) : '';
}

/**
 * Le zip le plus recent du jeu. Un gros zip peut arriver en morceaux (MidnightCity-3.18-Windows.zip.001,
 * .002...) : les morceaux sont recolles dans un fichier temporaire.
 */
async function findGameZip(def, zipArg) {
  const { scanFolders, compareVersions, patternToRegex } = require('../src/main/zip-updater');
  const folders = def.zip.dossiers.map(homeFolder).filter(Boolean);
  if (zipArg) folders.unshift(path.dirname(path.resolve(String(zipArg))));
  const found = await scanFolders(folders, def.zip.motif); // zips entiers
  const partRe = patternToRegex(`${def.zip.motif}.001`);
  const seen = new Set();
  for (const dir of folders) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = partRe.exec(name);
      if (!m || !/^\d+(\.\d+)*$/.test(m[1])) continue;
      const base = name.slice(0, -4);
      const parts = [];
      for (let k = 1; k < 100; k++) {
        const pth = path.join(dir, `${base}.${String(k).padStart(3, '0')}`);
        if (!fs.existsSync(pth)) break;
        parts.push(pth);
      }
      const key = path.join(dir, base).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ path: null, parts, name: base, dir, version: m[1], mtimeMs: fs.statSync(parts[0]).mtimeMs });
    }
    // morceaux emballes dans des zips (MidnightCity-3.18-Windows-partie1.zip, -partie2.zip...)
    const wrapRe = patternToRegex(def.zip.motif.replace(/\.zip$/i, '-partie1.zip'));
    for (const name of names) {
      const m = wrapRe.exec(name);
      if (!m || !/^\d+(\.\d+)*$/.test(m[1])) continue;
      const wrappers = [];
      for (let k = 1; k < 100; k++) {
        const pth = path.join(dir, name.replace(/-partie1\.zip$/i, `-partie${k}.zip`));
        if (!fs.existsSync(pth)) break;
        wrappers.push(pth);
      }
      const base = def.zip.motif.replace('*', m[1]);
      const key = path.join(dir, base).toLowerCase() + '|w';
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ path: null, wrappers, name: base, dir, version: m[1], mtimeMs: fs.statSync(wrappers[0]).mtimeMs });
    }
  }
  // le plus recent ; a version egale, le zip entier plutot que les morceaux
  const split = (z) => (z.parts || z.wrappers ? 1 : 0);
  found.sort((a, b) => compareVersions(b.version, a.version) || split(a) - split(b));
  return found[0] || null;
}

/** Des morceaux : on les recolle dans un fichier temporaire (supprime apres l'envoi). */
async function materialize(best) {
  const tmpParts = [];
  if (best.wrappers) {
    // chaque zip « partieN » contient un morceau : on le sort (avec verification) puis on recolle
    const { readZip, extractEntry } = require('../src/main/zip');
    best.parts = [];
    for (const w of best.wrappers) {
      const entry = (await readZip(w)).entries.find((e) => !e.isDir);
      if (!entry) throw new Error(`${path.basename(w)} est vide.`);
      const out = path.join(os.tmpdir(), `sel3a-${path.basename(entry.name)}`);
      log(`Lecture de ${path.basename(w)}…`);
      await extractEntry(w, entry, out);
      tmpParts.push(out);
      best.parts.push(out);
    }
  }
  if (best.parts) {
    const joined = path.join(os.tmpdir(), best.name);
    log(`Assemblage de ${best.parts.length} morceaux de ${best.name}…`);
    const out = fs.createWriteStream(joined);
    for (const pth of best.parts) {
      await new Promise((resolve, reject) => {
        const inp = fs.createReadStream(pth);
        inp.on('error', reject);
        inp.on('end', resolve);
        inp.pipe(out, { end: false });
      });
    }
    await new Promise((resolve) => out.end(resolve));
    best.path = joined;
    best.temp = true;
  }
  for (const t of tmpParts) await fsp.rm(t, { force: true }).catch(() => {});
}

async function publishGames(owner, repo, zipArg) {
  const config = require('../launcher.config.js');
  const { compareVersions } = require('../src/main/zip-updater');
  const { publishGame } = require('./publier-github');
  let published = 0;
  for (const def of config.autresJeux || []) {
    if (!def.zip || !def.urlManifest) continue;
    const zip = await findGameZip(def, zipArg);
    const manifestFile = path.join(ROOT, 'jeux', def.id, 'manifest.json');
    let online = null;
    try {
      online = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).version;
    } catch {
      /* jamais publié */
    }
    if (!zip) {
      log(`${def.nom} : aucun zip trouvé (version en ligne : ${online || 'aucune'}).`);
      continue;
    }
    if (online && compareVersions(zip.version, online) <= 0) {
      log(`${def.nom} : la version ${online} est déjà en ligne.`);
      continue;
    }
    log(`\n${def.nom} ${zip.version} : envoi de ${zip.name} (ça peut prendre quelques minutes)…`);
    await materialize(zip);
    let manifest;
    try {
      ({ manifest } = await publishGame({ zip: zip.path, jeu: def.id, version: zip.version, owner, repo, token: TOKEN, writeManifest: false, log }));
    } finally {
      if (zip.temp) await fsp.rm(zip.path, { force: true }).catch(() => {});
    }
    await fsp.mkdir(path.dirname(manifestFile), { recursive: true });
    await fsp.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    published++;
  }
  return published;
}

// ---------------------------------------------------------------- principal
async function main() {
  {
    log('=== Publier le launcher SEL3A et ses jeux pour tout le monde ===');
    const me = await login();
    const pub = (readPkg().build.publish || []).find((p) => p.provider === 'github');
    const owner = pub.owner;
    const repo = pub.repo;
    if (owner.toLowerCase() !== me.toLowerCase()) log(`Attention : le dépôt est ${owner}/${repo} mais tu es connecté en tant que ${me}.`);
    const info = await gh('GET', `/repos/${owner}/${repo}`, null, { ok404: true });
    if (!info) {
      fs.rmSync(secretFile, { force: true }); // le jeton enregistré ne donne pas accès à ce dépôt : on en redemandera un
      throw new Error(
        `Le dépôt ${owner}/${repo} est introuvable avec ce jeton. Vérifie qu'il existe en « Public », puis crée un jeton ` +
          `qui a accès à ${repo} (Contents et Workflows en « Read and write ») et relance PUBLIER.bat : il te le redemandera.`
      );
    }
    if (info.private) log('Attention : le dépôt est privé, tes amis ne pourront rien télécharger. Passe-le en Public (Settings → Danger Zone).');

    await ensureInitialized(owner, repo);

    // 1. les jeux (avant le reste : le manifest n'est envoyé qu'une fois les fichiers en ligne)
    const games = await publishGames(owner, repo, process.argv[2]);

    // 2. le dossier du launcher
    let { remote, changed, removed } = await diffWithRepo(owner, repo);
    const launcherChanged = changed.some((p) => LAUNCHER_RE.test(p)) || removed.some((p) => LAUNCHER_RE.test(p));
    let version = readPkg().version;
    if (launcherChanged) {
      const rel = await gh('GET', `/repos/${owner}/${repo}/releases/tags/v${version}`, null, { ok404: true });
      if (rel) {
        version = bumpPatch();
        log(`Le launcher a changé : nouvelle version ${version}.`);
        ({ remote, changed, removed } = await diffWithRepo(owner, repo));
      }
    }
    if (changed.length || removed.length) {
      log(`Envoi de ${changed.length} fichier(s) sur GitHub${removed.length ? `, ${removed.length} supprimé(s)` : ''}…`);
      await commit(owner, repo, remote, changed, removed, launcherChanged ? `Launcher ${version}` : 'Mise à jour des jeux et des actus');
    }

    log('\n✅ Terminé.');
    if (games) log('   Le jeu est en ligne : les launchers proposent METTRE À JOUR.');
    if (launcherChanged) {
      log(`   GitHub construit le launcher ${version} (5 à 10 minutes) : https://github.com/${owner}/${repo}/actions`);
      log('   Ensuite, les launchers installés se mettent à jour tout seuls.');
    }
    if (!games && !changed.length && !removed.length) log('   Rien de nouveau : tout était déjà en ligne.');
    log(`\n   Lien à partager : https://github.com/${owner}/${repo}/releases/latest`);
  }
}

async function run() {
  for (let essai = 1; ; essai++) {
    try {
      return await main();
    } catch (e) {
      if ((e.status === 403 || e.status === 401) && essai < 3) {
        fs.rmSync(secretFile, { force: true }); // ce jeton ne peut pas écrire : on en demande un autre
        const repo = readPkg().build.publish[0].repo;
        console.error(`\n❌ Ce jeton n'a pas le droit d'écrire sur le dépôt ${repo}.`);
        console.error('   Crée-en un nouveau sur GitHub : ta photo → Settings → Developer settings → Personal access tokens');
        console.error(`   → Fine-grained tokens → Generate new token → Only select repositories → ${repo}`);
        console.error('   → Repository permissions : Contents = Read and write, Workflows = Read and write → Generate token.');
        console.error(`   (détail : ${e.message.slice(0, 160)})`);
        continue; // login() redemande un jeton
      }
      throw e;
    }
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error(`\n❌ ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { blobSha, walk, homeFolder };
