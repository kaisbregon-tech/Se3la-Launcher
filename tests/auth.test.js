// Tests des comptes joueurs avec un faux serveur Firebase + Google (lancer avec : npm test)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Auth } = require('../src/main/auth');
const { JsonStore } = require('../src/main/store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
const KEY = 'cle-test';
let server;
let base;
const users = new Map(); // email -> { uid, password, displayName }
const log = [];
let refreshCounter = 0;

function readBody(req) {
  return new Promise((r) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => r(s));
  });
}
const json = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const fbErr = (res, msg) => json(res, 400, { error: { code: 400, message: msg } });
const tokens = (u) => ({ localId: u.uid, email: u.email, displayName: u.displayName || '', idToken: `id-${u.uid}-${Date.now()}`, refreshToken: `rt-${u.uid}`, expiresIn: '3600' });

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await readBody(req);
    log.push(url.pathname);
    if (url.pathname.startsWith('/identity/') && url.searchParams.get('key') !== KEY) {
      return fbErr(res, 'API key not valid. Please pass a valid API key.');
    }
    const body = raw && raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    switch (url.pathname) {
      case '/identity/accounts:signUp': {
        if (users.has(body.email)) return fbErr(res, 'EMAIL_EXISTS');
        if (body.password.length < 6) return fbErr(res, 'WEAK_PASSWORD : Password should be at least 6 characters');
        const u = { uid: `uid${users.size + 1}`, email: body.email, password: body.password };
        users.set(body.email, u);
        return json(res, 200, tokens(u));
      }
      case '/identity/accounts:signInWithPassword': {
        const u = users.get(body.email);
        if (!u || u.password !== body.password) return fbErr(res, 'INVALID_LOGIN_CREDENTIALS');
        return json(res, 200, tokens(u));
      }
      case '/identity/accounts:update': {
        const u = [...users.values()].find((x) => body.idToken.startsWith(`id-${x.uid}-`));
        if (!u) return fbErr(res, 'INVALID_ID_TOKEN');
        u.displayName = body.displayName;
        return json(res, 200, { ...tokens(u), displayName: u.displayName });
      }
      case '/identity/accounts:sendOobCode':
        return json(res, 200, { email: body.email || 'x' });
      case '/identity/accounts:signInWithIdp': {
        const p = new URLSearchParams(body.postBody);
        if (p.get('providerId') !== 'google.com' || p.get('id_token') !== 'google-id-token-ok') return fbErr(res, 'INVALID_IDP_RESPONSE');
        const u = { uid: 'guid1', email: 'joueur@gmail.com', displayName: 'Joueur Google' };
        return json(res, 200, { ...tokens(u), photoUrl: 'https://photo' });
      }
      case '/token/token': {
        refreshCounter++;
        if (body.refresh_token === 'rt-revoked') return fbErr(res, 'TOKEN_EXPIRED');
        return json(res, 200, { id_token: `refreshed-${refreshCounter}`, refresh_token: body.refresh_token, expires_in: '3600', user_id: 'x' });
      }
      case '/google/token': {
        if (body.client_id !== 'cid' || body.client_secret !== 'secret') return json(res, 401, { error: 'invalid_client', error_description: 'Unauthorized' });
        if (body.code !== 'bon-code' || !body.code_verifier) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, { id_token: 'google-id-token-ok', access_token: 'at' });
      }
      default:
        return json(res, 404, {});
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const endpoints = () => ({ identity: `${base}/identity`, token: `${base}/token`, googleAuth: `${base}/google/auth`, googleToken: `${base}/google/token` });
let n = 0;
function makeAuth(extra = {}) {
  const store = new JsonStore(path.join(tmp, `session-${++n}.json`));
  return new Auth({ apiKey: KEY, google: { clientId: 'cid', clientSecret: 'secret' }, store, endpoints: endpoints(), openExternal: async () => {}, ...extra });
}

test('inscription avec pseudo + reconnexion automatique au redémarrage', async () => {
  const a = makeAuth();
  const user = await a.signUp('tequzal@test.fr', 'motdepasse', 'Tequzal');
  assert.strictEqual(user.displayName, 'Tequzal');
  assert.strictEqual(user.email, 'tequzal@test.fr');
  assert.ok(!('idToken' in user), "les jetons ne doivent pas être envoyés à l'interface");

  const b = new Auth({ apiKey: KEY, store: a.store, endpoints: endpoints(), openExternal: async () => {} });
  const restored = await b.restore();
  assert.strictEqual(restored.displayName, 'Tequzal');
  assert.match(b.session.idToken, /^refreshed-/);
});

test('erreurs traduites en français', async () => {
  const a = makeAuth();
  await assert.rejects(a.signUp('tequzal@test.fr', 'motdepasse', 'Autre'), /existe déjà/);
  await assert.rejects(a.signIn('tequzal@test.fr', 'mauvais'), /incorrect/);
  await assert.rejects(a.signIn('pas-un-email', 'x'), /pas valide/);
  await assert.rejects(a.signUp('nouveau@test.fr', '123', 'Pseudo'), /trop faible/);
  await assert.rejects(a.signUp('nouveau@test.fr', '123456', 'ab'), /entre 3 et 20/);
  const badKey = makeAuth({ apiKey: 'mauvaise' });
  await assert.rejects(badKey.signIn('a@b.fr', '123456'), /apiKey/);
});

test('connexion + changement de pseudo + mot de passe oublié', async () => {
  const a = makeAuth();
  await a.signIn('tequzal@test.fr', 'motdepasse');
  const u = await a.updateDisplayName('NouveauPseudo');
  assert.strictEqual(u.displayName, 'NouveauPseudo');
  assert.strictEqual(await a.sendPasswordReset('tequzal@test.fr'), true);
});

test('session révoquée -> déconnecté au redémarrage', async () => {
  const store = new JsonStore(path.join(tmp, 'revoked.json'));
  store.write({ uid: 'x', email: 'x@x.fr', refreshToken: 'rt-revoked', idToken: 'old', expiresAt: 0 });
  const a = new Auth({ apiKey: KEY, store, endpoints: endpoints(), openExternal: async () => {} });
  assert.strictEqual(await a.restore(), null);
  assert.strictEqual(store.read(null), null);
});

test('pas d’Internet -> on reste connecté en mode hors ligne', async () => {
  const store = new JsonStore(path.join(tmp, 'offline.json'));
  store.write({ uid: 'x', email: 'x@x.fr', refreshToken: 'rt-x', idToken: 'old', expiresAt: 0 });
  const a = new Auth({ apiKey: KEY, store, endpoints: { ...endpoints(), token: 'http://127.0.0.1:1' }, openExternal: async () => {} });
  const u = await a.restore();
  assert.ok(u);
  assert.strictEqual(u.offline, true);
});

test('jeton rafraîchi automatiquement avant expiration', async () => {
  const a = makeAuth();
  await a.signIn('tequzal@test.fr', 'motdepasse');
  a.session.expiresAt = Date.now() + 60 * 1000; // expire dans 1 min
  assert.match(await a.getIdToken(), /^refreshed-/);
});

test('connexion Google : navigateur -> code -> Firebase', async () => {
  let openedUrl;
  const a = makeAuth({
    openExternal: async (url) => {
      openedUrl = new URL(url);
      // On simule le navigateur : Google redirige vers le petit serveur local
      const redirect = new URL(openedUrl.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code', 'bon-code');
      redirect.searchParams.set('state', openedUrl.searchParams.get('state'));
      setTimeout(async () => {
        const res = await fetch(redirect.href);
        assert.match(await res.text(), /Connexion réussie/);
      }, 20);
    },
  });
  const user = await a.signInWithGoogle();
  assert.strictEqual(openedUrl.searchParams.get('client_id'), 'cid');
  assert.strictEqual(openedUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.match(openedUrl.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.strictEqual(user.provider, 'google');
  assert.strictEqual(user.displayName, 'Joueur Google');
});

test('connexion Google : mauvais "state" ignoré, annulation possible', async () => {
  const a = makeAuth({
    openExternal: async (url) => {
      const u = new URL(url);
      const redirect = new URL(u.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code', 'bon-code');
      redirect.searchParams.set('state', 'pirate');
      setTimeout(async () => {
        const res = await fetch(redirect.href);
        assert.strictEqual(res.status, 400);
        a.cancelGoogle();
      }, 20);
    },
  });
  await assert.rejects(a.signInWithGoogle(), /annulée/);
});

test('connexion Google : refus du joueur', async () => {
  const a = makeAuth({
    openExternal: async (url) => {
      const u = new URL(url);
      const redirect = new URL(u.searchParams.get('redirect_uri'));
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('state', u.searchParams.get('state'));
      setTimeout(() => fetch(redirect.href), 20);
    },
  });
  await assert.rejects(a.signInWithGoogle(), /annulée/);
});

test('connexion Google : mauvais clientSecret -> message clair', async () => {
  const a = makeAuth({
    google: { clientId: 'cid', clientSecret: 'faux' },
    openExternal: async (url) => {
      const u = new URL(url);
      const redirect = new URL(u.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code', 'bon-code');
      redirect.searchParams.set('state', u.searchParams.get('state'));
      setTimeout(() => fetch(redirect.href), 20);
    },
  });
  await assert.rejects(a.signInWithGoogle(), /clientSecret/);
});

test('mode démo (sans clé Firebase) : tout fonctionne sans Internet', async () => {
  const store = new JsonStore(path.join(tmp, 'demo.json'));
  const a = new Auth({ apiKey: '', store, openExternal: async () => {} });
  assert.strictEqual(a.demo, true);
  const u = await a.signUp('demo@demo.fr', '123456', 'Démo');
  assert.strictEqual(u.demo, true);
  const g = await a.signInWithGoogle();
  assert.strictEqual(g.provider, 'google');
  const b = new Auth({ apiKey: '', store, openExternal: async () => {} });
  assert.ok(await b.restore());
  // Une fois Firebase configuré, la session démo est oubliée
  const c = new Auth({ apiKey: KEY, store, endpoints: endpoints(), openExternal: async () => {} });
  assert.strictEqual(await c.restore(), null);
});
