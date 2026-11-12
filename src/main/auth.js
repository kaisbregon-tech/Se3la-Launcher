// ============================================================================
//  COMPTES JOUEURS
//  - Email / mot de passe   -> API REST de Firebase Authentication
//  - Google                 -> ouvre le navigateur du joueur (méthode officielle
//                              recommandée par Google pour les applis de bureau),
//                              puis connecte le compte Google à Firebase.
//  - Session                -> enregistrée chiffrée sur le PC, on reste connecté.
//  Ce fichier n'utilise pas Electron : il est testé avec « npm test ».
// ============================================================================

const crypto = require('crypto');
const http = require('http');

const MESSAGES = {
  EMAIL_EXISTS: 'Un compte existe déjà avec cet email.',
  EMAIL_NOT_FOUND: 'Email ou mot de passe incorrect.',
  INVALID_PASSWORD: 'Email ou mot de passe incorrect.',
  INVALID_LOGIN_CREDENTIALS: 'Email ou mot de passe incorrect.',
  INVALID_EMAIL: "L'adresse email n'est pas valide.",
  MISSING_EMAIL: 'Entre ton adresse email.',
  MISSING_PASSWORD: 'Entre ton mot de passe.',
  WEAK_PASSWORD: 'Mot de passe trop faible (6 caractères minimum).',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Trop de tentatives. Réessaie dans quelques minutes.',
  USER_DISABLED: 'Ce compte a été désactivé.',
  USER_NOT_FOUND: "Ce compte n'existe plus.",
  OPERATION_NOT_ALLOWED: "Ce mode de connexion n'est pas activé dans Firebase (voir GUIDE.md, étape 3).",
  TOKEN_EXPIRED: 'Ta session a expiré, reconnecte-toi.',
  INVALID_REFRESH_TOKEN: 'Ta session a expiré, reconnecte-toi.',
  INVALID_ID_TOKEN: 'Ta session a expiré, reconnecte-toi.',
  CREDENTIAL_TOO_OLD_LOGIN_AGAIN: 'Reconnecte-toi pour faire cette modification.',
  INVALID_IDP_RESPONSE: 'La connexion Google a été refusée par Firebase (voir GUIDE.md, « Problèmes fréquents »).',
  API_KEY_INVALID: 'La clé Firebase (apiKey) dans launcher.config.js est invalide.',
  NETWORK: 'Impossible de joindre le serveur. Vérifie ta connexion Internet.',
};

// Erreurs qui veulent dire « la session n'est plus valable, il faut se reconnecter »
const SESSION_DEAD = new Set([
  'TOKEN_EXPIRED',
  'INVALID_REFRESH_TOKEN',
  'INVALID_ID_TOKEN',
  'USER_NOT_FOUND',
  'USER_DISABLED',
  'CREDENTIAL_TOO_OLD_LOGIN_AGAIN',
]);

class AuthError extends Error {
  constructor(code, message) {
    super(message || MESSAGES[code] || `Erreur : ${code}`);
    this.code = code;
  }
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function checkEmail(email) {
  if (!email) throw new AuthError('MISSING_EMAIL');
  if (!EMAIL_RE.test(email)) throw new AuthError('INVALID_EMAIL');
}
function checkPassword(password) {
  if (!password) throw new AuthError('MISSING_PASSWORD');
  if (password.length < 6) throw new AuthError('WEAK_PASSWORD');
}
function checkPseudo(pseudo) {
  const p = String(pseudo || '').trim();
  if (p.length < 3 || p.length > 20) {
    throw new AuthError('INVALID_PSEUDO', 'Ton pseudo doit faire entre 3 et 20 caractères.');
  }
  return p;
}

function browserPage(title, text, ok) {
  const color = ok ? '#3ddc84' : '#ff5c5c';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8ecf4;
font-family:'Segoe UI',system-ui,sans-serif}.c{text-align:center;max-width:420px;padding:32px}
.d{width:56px;height:56px;border-radius:50%;margin:0 auto 20px;background:${color};opacity:.9}
h1{font-size:22px;margin:0 0 8px}p{color:#9aa4b8;margin:0}</style></head>
<body><div class="c"><div class="d"></div><h1>${title}</h1><p>${text}</p></div></body></html>`;
}

class Auth {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey             clé Firebase (vide = mode démo)
   * @param {object} opts.google             { clientId, clientSecret }
   * @param {JsonStore} opts.store           où enregistrer la session
   * @param {(url:string)=>Promise} opts.openExternal  ouvre une page dans le navigateur
   * @param {string} [opts.appName]
   * @param {Function} [opts.fetchImpl]
   * @param {object} [opts.endpoints]        (pour les tests)
   */
  constructor({ apiKey, google = {}, store, openExternal, appName = 'le launcher', fetchImpl, endpoints = {} }) {
    this.apiKey = apiKey || '';
    this.demo = !this.apiKey;
    this.google = google || {};
    this.store = store;
    this.openExternal = openExternal;
    this.appName = appName;
    this.fetch = fetchImpl || globalThis.fetch;
    this.ep = {
      identity: 'https://identitytoolkit.googleapis.com/v1',
      token: 'https://securetoken.googleapis.com/v1',
      googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth',
      googleToken: 'https://oauth2.googleapis.com/token',
      ...endpoints,
    };
    this.session = null;
    this.offline = false;
    this.googlePending = null;
    this.googleTimeoutMs = 5 * 60 * 1000;
  }

  // ---------------------------------------------------------------- outils HTTP
  async _post(url, body, { form = false } = {}) {
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new AuthError('NETWORK');
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* réponse vide */
    }
    if (!res.ok) {
      // Format Google OAuth : { error: 'invalid_client', error_description: '...' }
      if (typeof data.error === 'string') {
        throw new AuthError(
          `GOOGLE_${data.error.toUpperCase()}`,
          `Erreur Google : ${data.error_description || data.error}. Vérifie google.clientId et google.clientSecret.`
        );
      }
      // Format Firebase : { error: { message: 'WEAK_PASSWORD : Password should be...' } }
      const msg = (data.error && data.error.message) || `HTTP_${res.status}`;
      if (/API key not valid/i.test(msg)) throw new AuthError('API_KEY_INVALID');
      const code = msg.split(/[\s:]/)[0];
      throw new AuthError(code);
    }
    return data;
  }

  _identity(method, body) {
    return this._post(`${this.ep.identity}/accounts:${method}?key=${encodeURIComponent(this.apiKey)}`, body);
  }

  _save() {
    if (this.session) this.store.write(this.session);
  }

  _newSession(data, provider) {
    this.session = {
      uid: data.localId,
      email: data.email || '',
      displayName: data.displayName || '',
      photoUrl: data.photoUrl || '',
      provider,
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
    };
    this.offline = false;
    this._save();
    return this.publicUser();
  }

  _demoSession(email, displayName, provider) {
    const uid = `demo-${crypto.createHash('sha1').update(email).digest('hex').slice(0, 12)}`;
    this.session = {
      demo: true,
      uid,
      email,
      displayName: displayName || '',
      photoUrl: '',
      provider,
      idToken: 'demo-token',
      refreshToken: 'demo-refresh',
      expiresAt: 32503680000000, // an 3000
    };
    this._save();
    return this.publicUser();
  }

  /** Les infos du joueur qu'on peut montrer dans l'interface (jamais les jetons). */
  publicUser() {
    if (!this.session) return null;
    const s = this.session;
    return {
      uid: s.uid,
      email: s.email,
      displayName: s.displayName || (s.email ? s.email.split('@')[0] : 'Joueur'),
      photoUrl: s.photoUrl,
      provider: s.provider,
      demo: !!s.demo,
      offline: this.offline,
    };
  }

  // ---------------------------------------------------------------- session
  /** Au démarrage : recharge la session enregistrée et la rafraîchit. */
  async restore() {
    const saved = this.store.read(null);
    if (!saved || !saved.uid) return null;

    // Une session démo n'est plus valable dès que Firebase est configuré (et inversement)
    if (!!saved.demo !== this.demo) {
      this.store.clear();
      return null;
    }
    this.session = saved;
    if (this.demo) return this.publicUser();

    try {
      await this._refresh();
      this.offline = false;
    } catch (e) {
      if (e.code === 'NETWORK') {
        this.offline = true; // pas d'Internet : on garde la session (mode hors ligne)
      } else {
        this.signOut();
        return null;
      }
    }
    return this.publicUser();
  }

  async _refresh() {
    const data = await this._post(
      `${this.ep.token}/token?key=${encodeURIComponent(this.apiKey)}`,
      { grant_type: 'refresh_token', refresh_token: this.session.refreshToken },
      { form: true }
    );
    this.session.idToken = data.id_token;
    this.session.refreshToken = data.refresh_token || this.session.refreshToken;
    this.session.expiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
    this._save();
  }

  /** Jeton d'identité valable (à donner au jeu ou à ton serveur). */
  async getIdToken() {
    if (!this.session) throw new AuthError('NOT_SIGNED_IN', "Tu n'es pas connecté.");
    if (this.session.demo) return this.session.idToken;
    if (this.session.expiresAt - Date.now() < 5 * 60 * 1000) {
      try {
        await this._refresh();
        this.offline = false;
      } catch (e) {
        if (e.code === 'NETWORK') {
          this.offline = true;
        } else {
          if (SESSION_DEAD.has(e.code)) this.signOut();
          throw e;
        }
      }
    }
    return this.session.idToken;
  }

  // ---------------------------------------------------------------- email / mot de passe
  async signUp(email, password, pseudo) {
    email = String(email || '').trim();
    checkEmail(email);
    checkPassword(password);
    const name = checkPseudo(pseudo);

    if (this.demo) {
      await delay(400);
      return this._demoSession(email, name, 'password');
    }
    const data = await this._identity('signUp', { email, password, returnSecureToken: true });
    this._newSession(data, 'password');
    try {
      await this.updateDisplayName(name);
    } catch {
      /* le compte est créé, le pseudo pourra être changé plus tard */
    }
    // Email de vérification (facultatif, on ignore les erreurs)
    this._identity('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: this.session.idToken }).catch(() => {});
    return this.publicUser();
  }

  async signIn(email, password) {
    email = String(email || '').trim();
    checkEmail(email);
    if (!password) throw new AuthError('MISSING_PASSWORD');

    if (this.demo) {
      await delay(400);
      checkPassword(password);
      return this._demoSession(email, '', 'password');
    }
    const data = await this._identity('signInWithPassword', { email, password, returnSecureToken: true });
    return this._newSession(data, 'password');
  }

  async sendPasswordReset(email) {
    email = String(email || '').trim();
    checkEmail(email);
    if (this.demo) {
      await delay(300);
      return true;
    }
    await this._identity('sendOobCode', { requestType: 'PASSWORD_RESET', email });
    return true;
  }

  async updateDisplayName(pseudo) {
    const name = checkPseudo(pseudo);
    if (!this.session) throw new AuthError('NOT_SIGNED_IN', "Tu n'es pas connecté.");
    if (this.session.demo) {
      this.session.displayName = name;
      this._save();
      return this.publicUser();
    }
    const idToken = await this.getIdToken();
    const data = await this._identity('update', { idToken, displayName: name, returnSecureToken: true });
    this.session.displayName = data.displayName || name;
    if (data.idToken) {
      this.session.idToken = data.idToken;
      this.session.refreshToken = data.refreshToken || this.session.refreshToken;
      this.session.expiresAt = Date.now() + Number(data.expiresIn || 3600) * 1000;
    }
    this._save();
    return this.publicUser();
  }

  signOut() {
    this.cancelGoogle();
    this.session = null;
    this.offline = false;
    this.store.clear();
  }

  // ---------------------------------------------------------------- Google
  async signInWithGoogle() {
    if (this.demo) {
      await delay(700);
      return this._demoSession('joueur.google@demo.local', 'Joueur Google', 'google');
    }
    if (!this.google.clientId) {
      throw new AuthError(
        'GOOGLE_NOT_CONFIGURED',
        "La connexion Google n'est pas encore configurée (voir GUIDE.md, étape 4)."
      );
    }
    this.cancelGoogle();

    // PKCE + state : protège contre le vol du code de connexion
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    // Petit serveur local temporaire qui reçoit la réponse de Google
    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirectUri = `http://127.0.0.1:${server.address().port}`;

    let timer;
    const codePromise = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new AuthError('GOOGLE_TIMEOUT', 'La connexion Google a expiré. Réessaie.')),
        this.googleTimeoutMs
      );
      this.googlePending = { reject };
      server.on('request', (req, res) => {
        const url = new URL(req.url, redirectUri);
        const send = (status, title, text, ok) => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
          res.end(browserPage(title, text, ok));
        };
        if (url.pathname !== '/') {
          res.writeHead(404, { Connection: 'close' }).end();
          return;
        }
        if (url.searchParams.get('state') !== state) {
          send(400, 'Lien invalide', 'Relance la connexion depuis le launcher.', false);
          return;
        }
        const error = url.searchParams.get('error');
        if (error) {
          send(200, 'Connexion annulée', `Tu peux fermer cet onglet et retourner sur ${this.appName}.`, false);
          reject(
            error === 'access_denied'
              ? new AuthError('CANCELLED', 'Connexion Google annulée.')
              : new AuthError('GOOGLE_ERROR', `Erreur Google : ${error}`)
          );
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          send(400, 'Réponse invalide', 'Relance la connexion depuis le launcher.', false);
          return;
        }
        send(200, 'Connexion réussie !', `Tu peux fermer cet onglet et retourner sur ${this.appName}.`, true);
        resolve(code);
      });
    });
    codePromise.catch(() => {}); // évite un avertissement si on abandonne avant

    const authUrl =
      `${this.ep.googleAuth}?` +
      new URLSearchParams({
        client_id: this.google.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        prompt: 'select_account',
      }).toString();

    try {
      await this.openExternal(authUrl);
      const code = await codePromise;

      // 1) on échange le code contre un jeton d'identité Google
      const tok = await this._post(
        this.ep.googleToken,
        {
          code,
          client_id: this.google.clientId,
          client_secret: this.google.clientSecret || '',
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        },
        { form: true }
      );
      if (!tok.id_token) throw new AuthError('GOOGLE_ERROR', "Google n'a pas renvoyé d'identité.");

      // 2) on connecte ce compte Google à Firebase
      const data = await this._identity('signInWithIdp', {
        postBody: `id_token=${encodeURIComponent(tok.id_token)}&providerId=google.com`,
        requestUri: redirectUri,
        returnSecureToken: true,
        returnIdpCredential: true,
      });
      if (data.needConfirmation || !data.idToken) {
        throw new AuthError(
          'ACCOUNT_EXISTS',
          'Un compte existe déjà avec cet email. Connecte-toi avec ton email et ton mot de passe.'
        );
      }
      return this._newSession(data, 'google');
    } finally {
      clearTimeout(timer);
      this.googlePending = null;
      server.closeAllConnections?.();
      server.close();
    }
  }

  cancelGoogle() {
    if (this.googlePending) {
      this.googlePending.reject(new AuthError('CANCELLED', 'Connexion Google annulée.'));
      this.googlePending = null;
    }
  }
}

module.exports = { Auth, AuthError, MESSAGES };
