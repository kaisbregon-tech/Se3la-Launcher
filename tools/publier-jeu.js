#!/usr/bin/env node
// ============================================================================
//  PUBLIER UNE VERSION DU JEU
//
//  Prépare le dossier « publication/ » à mettre en ligne sur ton serveur :
//     publication/manifest.json   (version + liste des fichiers)
//     publication/files/...       (les fichiers du jeu)
//     publication/news.json       (tes actus, à modifier)
//
//  Utilisation (dans le dossier du launcher) :
//     npm run publier
//  ou directement :
//     npm run publier -- --dossier "C:\MonJeu\Build" --version 1.0.1 --exe MonJeu.exe
// ============================================================================

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// Fichiers jamais publiés
const IGNORE_FILES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
const IGNORE_DIR_RE = /(_BurstDebugInformation_DoNotShip|_BackUpThisFolder_ButDontShipItWithYourGame)$/i;
const NOT_THE_GAME_EXE = new Set(['unitycrashhandler64.exe', 'unitycrashhandler32.exe', 'crashreportclient.exe']);

async function walk(root, rel = '') {
  const out = [];
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === '.launcher' || IGNORE_DIR_RE.test(e.name)) continue;
      out.push(...(await walk(root, r)));
    } else if (e.isFile()) {
      if (IGNORE_FILES.has(e.name.toLowerCase()) || e.name.endsWith('.part')) continue;
      out.push(r);
    }
  }
  return out;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** Liste les .exe à la racine du build (pour deviner l'exe du jeu). */
async function findExes(sourceDir) {
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe') && !NOT_THE_GAME_EXE.has(e.name.toLowerCase()))
    .map((e) => e.name);
}

async function buildManifest(sourceDir, { version, exe, args, onFile } = {}) {
  const paths = (await walk(sourceDir)).sort();
  if (paths.length === 0) throw new Error('Le dossier du jeu est vide.');
  const files = [];
  for (const p of paths) {
    const full = path.join(sourceDir, ...p.split('/'));
    const st = await fsp.stat(full);
    files.push({ path: p, size: st.size, sha256: await sha256(full) });
    if (onFile) onFile(p, files.length, paths.length);
  }
  const exeNorm = String(exe || '').replace(/\\/g, '/');
  if (!files.some((f) => f.path.toLowerCase() === exeNorm.toLowerCase())) {
    throw new Error(`Le fichier « ${exe} » n'existe pas dans le dossier du jeu.`);
  }
  const manifest = {
    version: String(version),
    exe: files.find((f) => f.path.toLowerCase() === exeNorm.toLowerCase()).path,
    date: new Date().toISOString(),
    files,
  };
  if (args && args.length) manifest.args = args;
  return manifest;
}

async function publish({ source, out, version, exe, args, log = console.log }) {
  source = path.resolve(source);
  out = path.resolve(out);
  if (!fs.existsSync(source)) throw new Error(`Dossier introuvable : ${source}`);
  if (out === source || out.startsWith(source + path.sep) || source.startsWith(out + path.sep)) {
    throw new Error('Le dossier de publication doit être en dehors du dossier du jeu.');
  }

  log(`\nAnalyse des fichiers de ${source} ...`);
  const manifest = await buildManifest(source, {
    version,
    exe,
    args,
    onFile: (p, i, n) => {
      if (i % 25 === 0 || i === n) process.stdout.write(`\r  ${i}/${n} fichiers analysés`);
    },
  });
  log('');

  const filesDir = path.join(out, 'files');
  await fsp.rm(filesDir, { recursive: true, force: true });
  await fsp.mkdir(filesDir, { recursive: true });
  log('Copie des fichiers ...');
  for (const f of manifest.files) {
    const dest = path.join(filesDir, ...f.path.split('/'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(source, ...f.path.split('/')), dest);
  }
  await fsp.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const newsFile = path.join(out, 'news.json');
  if (!fs.existsSync(newsFile)) {
    await fsp.copyFile(path.join(__dirname, '..', 'exemple-serveur', 'news.json'), newsFile);
  }
  const total = manifest.files.reduce((s, f) => s + f.size, 0);
  return { manifest, total, out };
}

// ---------------------------------------------------------------- ligne de commande
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else opts[key] = true;
    }
  }
  return opts;
}

function bumpVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '');
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.0';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const readline = require('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    // Enlève les guillemets ajoutés quand on glisse-dépose un dossier dans le terminal
    const a = (await rl.question(def ? `${q} [${def}] : ` : `${q} : `))
      .trim()
      .replace(/^&\s*/, '')
      .replace(/^(["'])(.*)\1$/, '$2');
    return a || def || '';
  };

  try {
    console.log('=== Publier une nouvelle version du jeu ===');
    const out = path.resolve(opts.sortie || path.join(__dirname, '..', 'publication'));

    const source = opts.dossier || (await ask('Dossier du jeu compilé (le build, là où il y a le .exe)'));
    if (!source) throw new Error('Il faut indiquer le dossier du jeu.');

    let exe = opts.exe;
    if (!exe) {
      const exes = await findExes(path.resolve(source)).catch(() => []);
      exe = await ask("Nom du .exe du jeu", exes[0]);
    }

    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).version;
    } catch {
      /* première publication */
    }
    const version = opts.version || (await ask(`Numéro de version${previous ? ` (avant : ${previous})` : ''}`, bumpVersion(previous)));

    const { manifest, total } = await publish({ source, out, version, exe });
    const mo = (total / 1024 / 1024).toFixed(1);
    console.log(`\n✅ Version ${manifest.version} prête : ${manifest.files.length} fichiers (${mo} Mo).`);
    console.log(`   Dossier à mettre en ligne : ${out}`);
    console.log('   Envoie TOUT le contenu de ce dossier sur ton serveur (voir GUIDE.md, étape 6).');
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

if (require.main === module) main();

module.exports = { buildManifest, publish, findExes, bumpVersion };
