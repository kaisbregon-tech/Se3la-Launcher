// ============================================================================
//  INTERFACE DU LAUNCHER
//  Tout passe par « window.launcher » (défini dans src/preload.js).
//  Les textes venant d'Internet (actus) sont insérés avec textContent :
//  jamais de HTML, donc pas de risque d'injection.
// ============================================================================
'use strict';

const api = window.launcher;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let info = null;
let user = null;
let games = []; // bibliothèque : [{ id, nom, slogan, couleur, logo, image, zip, … }]
let activeId = ''; // jeu affiché
const states = {}; // état de chaque jeu : { id: state }
let newsItems = [];
let newsFor = '';
let authMode = 'signin';
let openModalId = null;

// ------------------------------------------------------------------ outils
const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

function fmtSize(bytes) {
  if (!bytes || bytes < 0) return '0 Mo';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${nf1.format(v)} ${units[i]}`;
}

function fmtEta(sec) {
  if (sec == null || !isFinite(sec)) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min ${String(Math.round(sec % 60)).padStart(2, '0')}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

function fmtDate(str) {
  const d = new Date(str);
  if (!str || isNaN(d)) return str || '';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function initials(name) {
  return (
    String(name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?'
  );
}

const cssUrl = (url) => `url("${String(url).replace(/["\\\n]/g, '')}")`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixWhite([r, g, b], t) {
  return `rgb(${Math.round(r + (255 - r) * t)}, ${Math.round(g + (255 - g) * t)}, ${Math.round(b + (255 - b) * t)})`;
}

function toast(message, type = 'info', ms = 4500) {
  const t = el('div', `toast ${type}`, message);
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ------------------------------------------------------------------ apparence
function setAccent(hex) {
  const root = document.documentElement.style;
  const rgb = hexToRgb(hex);
  root.setProperty('--accent', hex);
  root.setProperty('--accent-rgb', rgb.join(', '));
  root.setProperty('--accent-hi', mixWhite(rgb, 0.35));
}

function applyInfo() {
  document.title = `${info.nomDuJeu} Launcher`;
  setAccent(info.couleurPrincipale);
  games = Array.isArray(info.jeux) && info.jeux.length ? info.jeux : [];

  $('#tbName').textContent = `${info.nomDuJeu}`;
  const art = info.imageDeFond || info.logo;
  const logo = info.logo || info.imageDeFond;
  for (const [id, src] of [
    ['#tbLogo', logo],
    ['#splashLogo', art],
    ['#loginArt', art],
  ]) {
    if (src) $(id).src = src;
    else $(id).classList.add('hidden');
  }
  if (art) $('#ambient').style.backgroundImage = cssUrl(art);

  $('#demoPill').classList.toggle('hidden', !info.demo);
  $('#aboutLine').textContent = `${info.nomDuJeu} Launcher · version ${info.version}`;
  renderLibrary();
}

const activeGame = () => games.find((g) => g.id === activeId) || games[0] || null;

/** La bibliothèque : un bouton par jeu, à gauche de l'accueil. */
function renderLibrary() {
  const list = $('#libraryList');
  list.replaceChildren();
  $('#library').classList.toggle('hidden', games.length < 2);
  for (const g of games) {
    const b = el('button', 'lib-item');
    b.dataset.id = g.id;
    b.setAttribute('role', 'tab');
    b.title = g.nom;
    b.style.setProperty('--game', g.couleur);
    const ic = el('span', 'lib-icon');
    const src = g.logo || g.image;
    if (src) ic.style.backgroundImage = cssUrl(src);
    else ic.textContent = initials(g.nom);
    b.append(ic, el('span', 'lib-name', g.nom), el('span', 'lib-dot'));
    b.addEventListener('click', () => selectGame(g.id, true));
    list.appendChild(b);
  }
  updateLibraryState();
}

function updateLibraryState() {
  $$('.lib-item').forEach((b) => {
    const s = states[b.dataset.id];
    b.classList.toggle('active', b.dataset.id === activeId);
    b.setAttribute('aria-selected', String(b.dataset.id === activeId));
    let dot = '';
    if (s) {
      if (s.running) dot = 'running';
      else if (s.busy) dot = 'busy';
      else if (s.status === 'update' || s.status === 'install') dot = 'update';
      else if (s.status === 'ready') dot = 'ready';
    }
    b.dataset.dot = dot;
  });
}

/** Affiche un jeu de la bibliothèque (image, titre, couleur, état, actus). */
function selectGame(id, remember = false) {
  const g = games.find((x) => x.id === id) || games[0];
  if (!g) return;
  const changed = g.id !== activeId;
  activeId = g.id;
  closeMenus();
  setAccent(g.couleur || info.couleurPrincipale);

  const art = g.image || g.logo;
  $('#hero').classList.toggle('art-full', !!g.imagePleine);
  if (art) {
    $('#heroArt').src = art;
    $('#heroArt').classList.remove('hidden');
    $('#ambient').style.backgroundImage = cssUrl(art);
  } else $('#heroArt').classList.add('hidden');
  const logo = $('#heroLogo');
  if (g.titreImage) {
    logo.src = g.titreImage;
    logo.alt = g.nom;
  }
  logo.classList.toggle('hidden', !g.titreImage);
  $('#heroTitle').classList.toggle('hidden', !!g.titreImage || !!g.titreDansImage);
  $('#hero').classList.toggle('title-in-art', !!g.titreDansImage);
  $('#heroTitle').textContent = g.nom;
  $('#heroSlogan').textContent = g.slogan || '';
  $('#heroTag').textContent = g.etiquette || '';
  $('#heroTag').classList.toggle('hidden', !g.etiquette);
  $('#gameMenu [data-action="zip"]').classList.toggle('hidden', !g.zip);

  const links = $('#extLinks');
  links.replaceChildren();
  const add = (label, url, svgPath) => {
    if (!url) return;
    const b = el('button', 'btn-ghost');
    b.innerHTML = `<svg viewBox="0 0 24 24">${svgPath}</svg>`; // icône fixe (pas de donnée externe)
    b.append(label);
    b.addEventListener('click', () => api.open(url));
    links.appendChild(b);
  };
  add('Site web', g.liens.siteWeb, '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>');
  add('Discord', g.liens.discord, '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>');

  updateLibraryState();
  renderGame();
  if (changed && user) loadNews();
  if (remember) api.settings.set({ jeuActif: g.id }).catch(() => {});
}

function makeParticles(count = 28) {
  const box = $('#particles');
  for (let i = 0; i < count; i++) {
    const p = el('i');
    const size = 1.5 + Math.random() * 2.5;
    p.style.left = `${Math.random() * 100}%`;
    p.style.width = p.style.height = `${size}px`;
    p.style.animationDuration = `${10 + Math.random() * 14}s`;
    p.style.animationDelay = `${-Math.random() * 24}s`;
    p.style.setProperty('--dx', `${(Math.random() - 0.5) * 120}px`);
    box.appendChild(p);
  }
}

// ------------------------------------------------------------------ navigation
function show(viewId) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === viewId));
  $$('.nav-btn').forEach((b) => {
    const target = b.dataset.view === 'news' ? 'viewNews' : 'viewHome';
    b.classList.toggle('active', target === viewId);
  });
}

function closeMenus() {
  $$('.menu.open').forEach((m) => m.classList.remove('open'));
}

function toggleMenu(menu) {
  const isOpen = menu.classList.contains('open');
  closeMenus();
  if (!isOpen) menu.classList.add('open');
}

function openModal(id) {
  closeMenus();
  if (openModalId) $(openModalId).classList.remove('open');
  openModalId = id;
  $('#backdrop').classList.add('open');
  $(id).classList.add('open');
}

function closeModal() {
  if (!openModalId) return;
  $(openModalId).classList.remove('open');
  $('#backdrop').classList.remove('open');
  const wasConfirm = openModalId === '#modalConfirm';
  openModalId = null;
  if (wasConfirm && confirmResolve) confirmResolve(false);
}

let confirmResolve = null;
function confirmBox(title, text, yesLabel = 'Confirmer') {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmYes').textContent = yesLabel;
  openModal('#modalConfirm');
  return new Promise((resolve) => {
    confirmResolve = (v) => {
      confirmResolve = null;
      resolve(v);
    };
  });
}

// ------------------------------------------------------------------ connexion
const TEXTS = {
  signin: { title: 'Bon retour !', sub: () => `Connecte-toi pour jouer à ${info.nomDuJeu}.`, submit: 'Se connecter' },
  signup: { title: 'Crée ton compte', sub: () => 'Gratuit, et ça prend 30 secondes.', submit: 'Créer mon compte' },
};

function setAuthMode(mode) {
  authMode = mode;
  $('#viewLogin').dataset.mode = mode;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('#loginTitle').textContent = TEXTS[mode].title;
  $('#loginSub').textContent = TEXTS[mode].sub();
  $('#btnSubmit').textContent = TEXTS[mode].submit;
  $('#fPassword').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  setFormMsg('');
}

function setFormMsg(text, type = 'error') {
  const m = $('#formMsg');
  m.textContent = text;
  m.className = `form-msg ${text ? type : ''}`;
}

function setAuthBusy(busy) {
  $$('#authForm input, #authForm button, #btnGoogle, .tab').forEach((x) => (x.disabled = busy));
  $('#btnSubmit').textContent = busy ? 'Patiente…' : TEXTS[authMode].submit;
}

async function submitAuth(e) {
  e.preventDefault();
  const email = $('#fEmail').value.trim();
  const password = $('#fPassword').value;
  const pseudo = $('#fPseudo').value.trim();
  setFormMsg('');
  setAuthBusy(true);
  try {
    user =
      authMode === 'signin'
        ? await api.auth.signIn(email, password)
        : await api.auth.signUp(email, password, pseudo);
    onSignedIn(true);
  } catch (err) {
    setFormMsg(err.message);
  } finally {
    setAuthBusy(false);
  }
}

async function googleSignIn() {
  setFormMsg('');
  $('#googleWait').classList.remove('hidden');
  try {
    user = await api.auth.google();
    onSignedIn(true);
  } catch (err) {
    if (err.code !== 'CANCELLED') setFormMsg(err.message);
  } finally {
    $('#googleWait').classList.add('hidden');
  }
}

async function forgotPassword() {
  const email = $('#fEmail').value.trim();
  if (!email) {
    setFormMsg('Entre ton email ci-dessus, puis clique à nouveau sur « Mot de passe oublié ».');
    $('#fEmail').focus();
    return;
  }
  try {
    await api.auth.resetPassword(email);
    setFormMsg('Si un compte existe avec cet email, tu vas recevoir un lien pour changer ton mot de passe.', 'ok');
  } catch (err) {
    setFormMsg(err.message);
  }
}

function renderUser() {
  if (!user) return;
  $('#userName').textContent = user.displayName;
  $('#menuName').textContent = user.displayName;
  $('#menuEmail').textContent = user.email;
  for (const av of [$('#avatar'), $('#profAvatar')]) {
    if (user.photoUrl && user.photoUrl.startsWith('https://')) {
      av.style.backgroundImage = cssUrl(user.photoUrl);
      av.textContent = '';
    } else {
      av.style.backgroundImage = '';
      av.textContent = initials(user.displayName);
    }
  }
}

async function onSignedIn(fresh) {
  renderUser();
  $('#userBox').classList.remove('hidden');
  $('#mainNav').classList.remove('hidden');
  $('#fPassword').value = '';
  show('viewHome');
  if (fresh) toast(`Bienvenue, ${user.displayName} !`, 'ok');
  if (user.offline) toast('Mode hors ligne : impossible de joindre les serveurs pour le moment.');

  loadNews();
  try {
    for (const g of games) states[g.id] = await api.game.state(g.id);
    renderGame();
    updateLibraryState();
    await Promise.all(games.map((g) => api.game.check(g.id).catch(() => {})));
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function signOut() {
  closeMenus();
  await api.auth.signOut();
  user = null;
  $('#userBox').classList.add('hidden');
  $('#mainNav').classList.add('hidden');
  setAuthMode('signin');
  show('viewLogin');
}

// ------------------------------------------------------------------ jeu
function renderGame() {
  const g = activeGame();
  const s = g && states[g.id];
  if (!s || !info) return;
  const btn = $('#btnPlay');
  let label = 'JOUER';
  let disabled = false;
  let icon = false;
  let cancel = false;
  let main = '';
  let side = '';
  let sub = '';
  let pct = null;

  switch (s.status) {
    case 'checking':
      label = 'VÉRIFICATION';
      disabled = true;
      main = 'Recherche de mises à jour…';
      break;
    case 'install':
      label = 'INSTALLER';
      main = s.remoteVersion ? `Prêt à installer · version ${s.remoteVersion}` : 'Prêt à installer';
      side = fmtSize(s.downloadSize);
      sub = s.zipName ? `Depuis ${s.zipName} · dossier : ${s.installDir}` : `Dossier : ${s.installDir}`;
      break;
    case 'update':
      label = 'METTRE À JOUR';
      main = s.source === 'zip' ? `Nouvelle version ${s.remoteVersion} trouvée` : `Mise à jour ${s.remoteVersion} disponible`;
      side = fmtSize(s.downloadSize);
      sub = [s.localVersion ? `Version installée : ${s.localVersion}` : '', s.zipName || ''].filter(Boolean).join(' · ');
      break;
    case 'ready':
      label = 'JOUER';
      icon = true;
      main = `${g.nom} est prêt`;
      side = s.localVersion ? `v${s.localVersion}` : '';
      sub = s.offline ? 'Hors ligne · les mises à jour seront vérifiées plus tard' : 'À jour';
      break;
    case 'no-zip':
      label = 'CHOISIR LE ZIP';
      main = `Le zip de ${g.nom} n'a pas été trouvé`;
      sub = `Dépose ${g.zipMotif.replace('*', 'x.xx')} dans Musique\\Claude outputs ou Téléchargements, ou clique pour le choisir.`;
      break;
    case 'no-server':
      label = 'BIENTÔT';
      disabled = true;
      main = "Le jeu n'est pas encore disponible au téléchargement";
      sub = 'Aucun serveur configuré : renseigne « urlManifest » dans launcher.config.js (GUIDE.md, étape 6).';
      break;
    case 'offline':
      label = 'RÉESSAYER';
      main = 'Impossible de joindre le serveur du jeu';
      sub = 'Vérifie ta connexion Internet.';
      break;
    case 'error':
    default:
      label = 'RÉESSAYER';
      main = 'Un problème est survenu';
      break;
  }

  if (s.busy) {
    cancel = true;
    label = 'ANNULER';
    const p = s.progress;
    const total = p && p.total ? p.total : 0;
    pct = total ? Math.min(100, (p.done / total) * 100) : 0;
    if (!p) {
      main = 'Préparation…';
    } else if (p.phase === 'verifying') {
      main = 'Vérification des fichiers…';
      side = `${Math.floor(pct)} %`;
      sub = p.file || '';
    } else {
      const zipText = s.status === 'repairing' ? 'Réparation des fichiers…' : s.installed ? 'Mise à jour en cours…' : 'Installation en cours…';
      const netText = s.status === 'repairing' ? 'Réparation des fichiers…' : s.installed ? 'Mise à jour en cours…' : 'Téléchargement en cours…';
      main = p.phase === 'extracting' ? zipText : netText;
      side = `${Math.floor(pct)} %`;
      const parts = [`${fmtSize(p.done)} / ${fmtSize(total)}`];
      if (p.speed) parts.push(`${fmtSize(p.speed)}/s`);
      if (p.eta) parts.push(`${fmtEta(p.eta)} restantes`);
      sub = parts.join(' · ');
    }
  }

  if (s.running) {
    label = 'EN COURS';
    disabled = true;
    icon = false;
    main = 'Bonne partie !';
    sub = 'Le jeu est lancé.';
  }

  const subEl = $('#statusSub');
  subEl.classList.toggle('error', !!s.error && !s.busy);
  if (s.error && !s.busy) sub = s.error;

  $('#playLabel').textContent = label;
  btn.disabled = disabled;
  btn.classList.toggle('is-cancel', cancel);
  btn.classList.toggle('no-icon', !icon);
  $('#statusMain').textContent = main;
  $('#statusSide').textContent = side;
  subEl.textContent = sub;
  subEl.title = sub;
  $('#progress').classList.toggle('hidden', pct === null);
  if (pct !== null) $('#progressBar').style.width = `${pct}%`;

  // menu des options
  const can = s.installed && !s.busy && !s.running;
  $('#gameMenu [data-action="repair"]').disabled = !can || !g.serverConfigured;
  $('#gameMenu [data-action="uninstall"]').disabled = !can;
  $('#gameMenu [data-action="folder"]').disabled = !s.installed;
  $('#gameMenu [data-action="zip"]').disabled = s.busy || s.running;
}

function onGameState({ id, state }) {
  const prev = states[id];
  states[id] = state;
  if (id === activeId) renderGame();
  updateLibraryState();
  if (prev && prev.busy && !state.busy && !state.error && state.status === 'ready') {
    const g = games.find((x) => x.id === id);
    const nom = g ? g.nom : 'Le jeu';
    toast(prev.status === 'repairing' ? `${nom} : fichiers vérifiés et réparés.` : `${nom} est à jour. Bon jeu !`, 'ok');
  }
}

async function onPlayClick() {
  const id = activeId;
  const s = states[id];
  if (!s) return;
  try {
    if (s.busy) return await api.game.cancel(id);
    switch (s.status) {
      case 'install':
      case 'update':
        return await api.game.install(id);
      case 'ready':
        $('#btnPlay').disabled = true;
        return await api.game.play(id);
      case 'no-zip':
        return await api.game.chooseZip(id);
      default:
        return await api.game.check(id);
    }
  } catch (err) {
    toast(err.message, 'error');
    renderGame();
  }
}

async function onGameMenu(action) {
  closeMenus();
  const g = activeGame();
  if (!g) return;
  try {
    if (action === 'zip') await api.game.chooseZip(g.id);
    if (action === 'repair') await api.game.repair(g.id);
    if (action === 'folder') await api.game.openFolder(g.id);
    if (action === 'settings') await openSettings();
    if (action === 'uninstall') {
      const ok = await confirmBox(
        `Désinstaller ${g.nom} ?`,
        'Les fichiers du jeu seront supprimés de ton PC. Tes sauvegardes et fichiers personnels ne sont pas touchés.',
        'Désinstaller'
      );
      if (ok) {
        await api.game.uninstall(g.id);
        toast(`${g.nom} désinstallé.`, 'ok');
      }
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ------------------------------------------------------------------ actus
function thumb(item, cls) {
  const t = el('div', cls);
  const g = activeGame();
  const img = item.image || (g && (g.logo || g.image)) || info.logo || info.imageDeFond;
  if (img) t.style.backgroundImage = cssUrl(img);
  else t.textContent = initials(item.tag || item.title);
  return t;
}

function renderNews() {
  const home = $('#homeNews');
  const grid = $('#newsGrid');
  home.replaceChildren();
  grid.replaceChildren();

  if (!newsItems.length) {
    home.appendChild(el('div', 'empty', 'Aucune actu pour le moment.'));
    grid.appendChild(el('div', 'empty', 'Aucune actu pour le moment.'));
    return;
  }

  newsItems.slice(0, 3).forEach((n) => {
    const card = el('button', 'news-card');
    const text = el('div', 'news-text');
    if (n.tag) text.appendChild(el('span', 'tag', n.tag));
    text.appendChild(el('strong', '', n.title));
    if (n.date) text.appendChild(el('span', 'date', fmtDate(n.date)));
    card.append(thumb(n, 'news-thumb'), text);
    card.addEventListener('click', () => openNews(n));
    home.appendChild(card);
  });

  newsItems.forEach((n) => {
    const tile = el('button', 'news-tile');
    const text = el('div', 'news-text');
    if (n.tag) text.appendChild(el('span', 'tag', n.tag));
    text.appendChild(el('strong', '', n.title));
    if (n.summary) text.appendChild(el('p', '', n.summary));
    if (n.date) text.appendChild(el('span', 'date', fmtDate(n.date)));
    tile.append(thumb(n, 'news-thumb'), text);
    tile.addEventListener('click', () => openNews(n));
    grid.appendChild(tile);
  });
}

async function loadNews() {
  const id = activeId;
  newsFor = id;
  try {
    const r = await api.news.get(id);
    if (newsFor !== id) return; // on a changé de jeu entre-temps
    newsItems = r.items || [];
  } catch {
    newsItems = [];
  }
  renderNews();
}

let currentNewsUrl = '';
function openNews(n) {
  const cover = $('#newsCover');
  const g = activeGame();
  const img = n.image || (g && g.image) || info.imageDeFond;
  cover.style.backgroundImage = img ? cssUrl(img) : '';
  $('#newsTag').textContent = n.tag || 'Actu';
  $('#newsDate').textContent = fmtDate(n.date);
  $('#newsTitle').textContent = n.title;
  $('#newsContent').textContent = n.content || n.summary || '';
  currentNewsUrl = n.url || '';
  $('#newsLink').classList.toggle('hidden', !currentNewsUrl);
  openModal('#modalNews');
}

// ------------------------------------------------------------------ paramètres & profil
async function openSettings() {
  const g = activeGame();
  const s = await api.settings.get(g && g.id);
  $('#setDirTitle').textContent = g && games.length > 1 ? `Dossier d'installation de ${g.nom}` : "Dossier d'installation";
  $('#setDir').textContent = s.installDir;
  $('#setHide').checked = s.cacherPendantJeu;
  $('#setStartup').checked = s.lancerAuDemarrage;
  $('#setArgs').value = s.argumentsSupp;
  openModal('#modalSettings');
}

async function saveSetting(patch) {
  try {
    await api.settings.set(patch);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openProfile() {
  renderUser();
  $('#profName').textContent = user.displayName;
  $('#profEmail').textContent = user.email;
  $('#profProvider').textContent = (user.provider === 'google' ? 'Compte Google' : 'Compte email') + (user.demo ? ' · démo' : '');
  $('#profPseudo').value = user.displayName;
  $('#profUid').textContent = user.uid;
  $('#profMsg').textContent = '';
  openModal('#modalProfile');
}

async function saveName(e) {
  e.preventDefault();
  const msg = $('#profMsg');
  try {
    user = await api.auth.updateName($('#profPseudo').value);
    renderUser();
    $('#profName').textContent = user.displayName;
    msg.textContent = 'Pseudo enregistré !';
    msg.className = 'form-msg ok';
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-msg error';
  }
}

// ------------------------------------------------------------------ événements
function bindEvents() {
  // fenêtre
  $('#btnMin').addEventListener('click', () => api.window.minimize());
  $('#btnMax').addEventListener('click', () => api.window.maximize());
  $('#btnClose').addEventListener('click', () => api.window.close());
  api.window.onMaximized((max) => {
    $('#btnMax').innerHTML = max
      ? '<svg viewBox="0 0 24 24"><rect x="5" y="8" width="11" height="11" rx="1"/><path d="M8 8V5h11v11h-3"/></svg>'
      : '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>';
  });

  // navigation
  $$('[data-view]').forEach((b) =>
    b.addEventListener('click', () => show(b.dataset.view === 'news' ? 'viewNews' : 'viewHome'))
  );

  // connexion
  $$('.tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
  $('#authForm').addEventListener('submit', submitAuth);
  $('#btnGoogle').addEventListener('click', googleSignIn);
  $('#btnCancelGoogle').addEventListener('click', () => api.auth.cancelGoogle());
  $('#btnForgot').addEventListener('click', forgotPassword);
  $('#togglePw').addEventListener('click', () => {
    const i = $('#fPassword');
    i.type = i.type === 'password' ? 'text' : 'password';
  });

  // menus
  $('#userBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu($('#userMenu'));
  });
  $('#btnGameMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu($('#gameMenu'));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) closeMenus();
  });
  $$('#userMenu [data-action]').forEach((b) =>
    b.addEventListener('click', () => {
      closeMenus();
      if (b.dataset.action === 'profile') openProfile();
      if (b.dataset.action === 'settings') openSettings();
      if (b.dataset.action === 'signout') signOut();
    })
  );
  $$('#gameMenu [data-action]').forEach((b) => b.addEventListener('click', () => onGameMenu(b.dataset.action)));

  // mise à jour du launcher
  if (api.launcherUpdate) {
    api.launcherUpdate.onChange((u) => {
      renderLauncherUpdate(u);
      if (u && u.ready) toast(`La version ${u.version} du launcher est prête : redémarre-le pour l’installer.`, 'ok', 7000);
    });
    $('#updPill').addEventListener('click', () => api.launcherUpdate.restart().catch((err) => toast(err.message, 'error')));
    api.launcherUpdate.get().then(renderLauncherUpdate).catch(() => {});
  }

  // jeu
  $('#btnPlay').addEventListener('click', onPlayClick);
  api.game.onState(onGameState);

  // modales
  $('#backdrop').addEventListener('click', closeModal);
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  $('#confirmNo').addEventListener('click', closeModal);
  $('#confirmYes').addEventListener('click', () => {
    const r = confirmResolve;
    confirmResolve = null;
    closeModal();
    if (r) r(true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenus();
      closeModal();
    }
  });
  $('#newsLink').addEventListener('click', () => currentNewsUrl && api.open(currentNewsUrl));

  // paramètres
  $('#setHide').addEventListener('change', (e) => saveSetting({ cacherPendantJeu: e.target.checked }));
  $('#setStartup').addEventListener('change', (e) => saveSetting({ lancerAuDemarrage: e.target.checked }));
  $('#setArgs').addEventListener('change', (e) => saveSetting({ argumentsSupp: e.target.value }));
  $('#btnChooseDir').addEventListener('click', async () => {
    try {
      const s = await api.settings.chooseFolder(activeId);
      $('#setDir').textContent = s.installDir;
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // profil
  $('#nameForm').addEventListener('submit', saveName);
}

// ------------------------------------------------------------------ mise à jour du launcher
function renderLauncherUpdate(u) {
  const pill = $('#updPill');
  pill.classList.toggle('hidden', !u);
  if (!u) return;
  pill.classList.toggle('ready', !!u.ready);
  pill.disabled = !u.ready;
  pill.textContent = u.ready ? `Launcher ${u.version} prêt · Redémarrer` : `Téléchargement du launcher ${u.version}…`;
  pill.title = u.ready
    ? 'La nouvelle version du launcher est téléchargée. Clique pour redémarrer et l’installer (sinon, elle s’installera à la fermeture).'
    : 'Une nouvelle version du launcher se télécharge en arrière-plan.';
}

// ------------------------------------------------------------------ démarrage
(async function boot() {
  makeParticles();
  try {
    info = await api.info();
  } catch (err) {
    document.body.textContent = `Erreur de démarrage : ${err.message}`;
    return;
  }
  applyInfo();
  bindEvents();
  selectGame(info.jeuActif);
  setAuthMode('signin');

  const minSplash = new Promise((r) => setTimeout(r, 900));
  try {
    user = await api.auth.restore();
  } catch {
    user = null;
  }
  await minSplash;

  if (user) onSignedIn(false);
  else show('viewLogin');
})();
