// Pont sécurisé entre l'interface (HTML/JS) et le processus principal.
// L'interface n'a accès QU'À ces fonctions-là (pas à Node.js ni aux fichiers).

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) {
    const err = new Error(r.error);
    err.code = r.code;
    throw err;
  }
  return r.data;
}

function listen(channel, cb) {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

contextBridge.exposeInMainWorld('launcher', {
  info: () => call('app:info'),
  open: (url) => call('app:open', url),
  window: {
    minimize: () => call('win:minimize'),
    maximize: () => call('win:maximize'),
    close: () => call('win:close'),
    onMaximized: (cb) => listen('win:maximized', cb),
  },
  auth: {
    restore: () => call('auth:restore'),
    signIn: (email, password) => call('auth:signIn', email, password),
    signUp: (email, password, pseudo) => call('auth:signUp', email, password, pseudo),
    google: () => call('auth:google'),
    cancelGoogle: () => call('auth:cancelGoogle'),
    resetPassword: (email) => call('auth:resetPassword', email),
    updateName: (pseudo) => call('auth:updateName', pseudo),
    signOut: () => call('auth:signOut'),
  },
  // Chaque fonction prend l'identifiant du jeu de la bibliothèque (ex : 'midnight-city')
  game: {
    state: (id) => call('game:state', id),
    check: (id) => call('game:check', id),
    install: (id) => call('game:install', id),
    repair: (id) => call('game:repair', id),
    cancel: (id) => call('game:cancel', id),
    play: (id) => call('game:play', id),
    uninstall: (id) => call('game:uninstall', id),
    openFolder: (id) => call('game:openFolder', id),
    chooseZip: (id) => call('game:chooseZip', id),
    onState: (cb) => listen('game:state', cb), // cb({ id, state })
  },
  settings: {
    get: (id) => call('settings:get', id),
    set: (patch, id) => call('settings:set', patch, id),
    chooseFolder: (id) => call('settings:chooseFolder', id),
  },
  news: {
    get: (id) => call('news:get', id),
  },
  // mise à jour du launcher lui-même
  launcherUpdate: {
    get: () => call('launcher:update'),
    restart: () => call('launcher:restart'),
    onChange: (cb) => listen('launcher:update', cb),
  },
});
