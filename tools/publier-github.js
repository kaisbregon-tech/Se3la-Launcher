#!/usr/bin/env node
// ============================================================================
//  PUBLIER UNE VERSION D'UN JEU SUR GITHUB (pour tous les joueurs)
//
//  À partir du zip du jeu (ex : MidnightCity-3.17-Windows.zip) :
//    1. crée la « release » midnight-city-3.17 sur le dépôt GitHub et y envoie les fichiers du jeu ;
//    2. met à jour jeux/midnight-city/manifest.json dans le dépôt.
//  Les launchers de tout le monde voient alors « METTRE À JOUR ».
//  (Le launcher lui-même se publie tout seul : voir .github/workflows/launcher.yml.)
//
//  Utilisation :
//    set GITHUB_TOKEN=github_pat_...      (un jeton avec « Contents : Read and write » sur le dépôt)
//    node tools/publier-github.js --zip "C:\...\MidnightCity-3.17-Windows.zip"
//  Options : --jeu midnight-city  --version 3.17  --notes "texte"  --actus fichier.json
// ============================================================================

const API = process.env.SEL3A_GITHUB_API || 'https://api.github.com'; // (remplacé pendant les tests)
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const config = require('../launcher.config.js');
const pkg = require('../package.json');
const { readZip, extractEntry } = require('../src/main/zip');
const { zipFiles, versionFromName } = require('../src/main/zip-updater');
const { buildManifest } = require('./publier-jeu');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith('--')) {
      o[k] = v;
      i++;
    } else o[k] = true;
  }
  return o;
}

function repoInfo() {
  const pub = ((pkg.build && pkg.build.publish) || []).find((p) => p.provider === 'github') || {};
  const owner = process.env.GITHUB_OWNER || pub.owner;
  const repo = process.env.GITHUB_REPO || pub.repo;
  if (!owner || !repo || owner === 'TON_PSEUDO_GITHUB') {
    throw new Error('Renseigne ton pseudo GitHub dans package.json → build.publish (voir GUIDE.md).');
  }
  return { owner, repo };
}

let TOKEN = process.env.GITHUB_TOKEN || '';

function headers(extra = {}) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sel3a-launcher', ...extra };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function api(method, url, body, { ok404 = false } = {}) {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (ok404 && res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${url} : ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function uploadAsset(release, file, name, log) {
  const size = (await fsp.stat(file)).size;
  const existing = (release.assets || []).find((a) => a.name === name);
  if (existing && existing.size === size && existing.state === 'uploaded') {
    log(`  ${name} : déjà en ligne`);
    return;
  }
  if (existing) await api('DELETE', `/repos/${release._owner}/${release._repo}/releases/assets/${existing.id}`);
  const url = `${release.upload_url.replace(/\{.*\}$/, '')}?name=${encodeURIComponent(name)}`;
  log(`  envoi de ${name} (${(size / 1048576).toFixed(1)} Mo)…`);
  // envoi en flux (le fichier n'est jamais charge en entier en memoire), avec l'avancement
  await new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(u, { method: 'POST', headers: headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }) }, (res) => {
      let txt = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (txt += d));
      res.on('end', () => (res.statusCode < 300 ? resolve() : reject(new Error(`Envoi de ${name} refusé : ${res.statusCode} ${txt.slice(0, 300)}`))));
    });
    req.on('error', (e) => reject(new Error(`Envoi de ${name} interrompu : ${e.message}`)));
    const inp = fs.createReadStream(file);
    let sent = 0;
    let step = 0;
    inp.on('data', (c) => {
      sent += c.length;
      const pct = Math.floor((sent / size) * 10);
      if (size > 20 * 1048576 && pct > step) {
        step = pct;
        log(`    ${pct * 10} %`);
      }
    });
    inp.on('error', reject);
    inp.pipe(req);
  });
}


async function putFile(owner, repo, repoPath, content, message) {
  const cur = await api('GET', `/repos/${owner}/${repo}/contents/${repoPath}?ref=main`, null, { ok404: true });
  await api('PUT', `/repos/${owner}/${repo}/contents/${repoPath}`, {
    message,
    content: Buffer.from(content).toString('base64'),
    branch: 'main',
    ...(cur && cur.sha ? { sha: cur.sha } : {}),
  });
}

/**
 * Envoie une version d'un jeu sur GitHub. writeManifest: false = le manifest est renvoyé
 * (et envoyé plus tard avec le reste du dossier, voir tools/publier.js).
 */
async function publishGame({ zip, jeu = 'midnight-city', version, notes, actus, owner, repo, token, writeManifest = true, log = console.log }) {
  if (token) TOKEN = token;
  if (!owner || !repo) ({ owner, repo } = repoInfo());
  const def = (config.autresJeux || []).find((j) => j.id === jeu);
  if (!def || !def.zip) throw new Error(`Jeu « ${jeu} » introuvable dans launcher.config.js (autresJeux).`);
  version = version || versionFromName(zip, def.zip.motif);
  if (!version) throw new Error('Version introuvable dans le nom du zip : précise --version.');
  const tag = `${jeu}-${version}`;

  // 1. extraction du zip dans un dossier temporaire
  log(`Extraction de ${path.basename(zip)}…`);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'publier-'));
  try {
    const files = zipFiles((await readZip(zip)).entries);
    for (const f of files) {
      if (f.rel.includes('/')) throw new Error(`Sous-dossier non pris en charge pour GitHub : ${f.rel}`);
      await extractEntry(zip, f, path.join(tmp, f.rel));
    }
    const manifest = await buildManifest(tmp, { version, exe: def.exe });
    manifest.baseUrl = `https://github.com/${owner}/${repo}/releases/download/${tag}/`;

    // 2. la release et ses fichiers (pas marquée « latest » : c'est réservé au launcher)
    let release = await api('GET', `/repos/${owner}/${repo}/releases/tags/${tag}`, null, { ok404: true });
    if (!release) {
      log(`Création de la release ${tag}…`);
      release = await api('POST', `/repos/${owner}/${repo}/releases`, {
        tag_name: tag,
        target_commitish: 'main',
        name: `${def.nom} ${version}`,
        body: notes || `${def.nom} version ${version}. Mise à jour automatique dans le launcher SEL3A.`,
        make_latest: 'false',
      });
    }
    release._owner = owner;
    release._repo = repo;
    for (const f of manifest.files) await uploadAsset(release, path.join(tmp, f.path), f.path, log);

    // 3. le manifest (en dernier : les joueurs ne voient la version que quand tout est en ligne)
    if (writeManifest) {
      await putFile(owner, repo, `jeux/${jeu}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, `${def.nom} ${version}`);
      if (actus) await putFile(owner, repo, `jeux/${jeu}/news.json`, await fsp.readFile(actus), `Actus ${def.nom} ${version}`);
      log(`✅ ${def.nom} ${version} est en ligne : les launchers proposent la mise à jour.`);
    } else log(`  fichiers de ${def.nom} ${version} en ligne.`);
    return { tag, manifest };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (!o.zip) {
    console.error('Indique le zip du jeu : node tools/publier-github.js --zip "MidnightCity-3.17-Windows.zip"');
    process.exit(1);
  }
  publishGame({ zip: o.zip, jeu: o.jeu, version: o.version, notes: o.notes, actus: o.actus }).catch((e) => {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  });
}

module.exports = { publishGame };
