// Petit stockage de fichiers JSON (paramètres, session, cache des actus).
// Volontairement indépendant d'Electron pour pouvoir être testé avec Node.

const fs = require('fs');
const path = require('path');

class JsonStore {
  /**
   * @param {string} filePath  chemin du fichier
   * @param {object} [crypto]  { encrypt(str) -> Buffer, decrypt(Buffer) -> str } pour chiffrer
   */
  constructor(filePath, crypto = null) {
    this.filePath = filePath;
    this.crypto = crypto;
  }

  read(fallback = null) {
    try {
      const raw = fs.readFileSync(this.filePath);
      const text = this.crypto ? this.crypto.decrypt(raw) : raw.toString('utf8');
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const text = JSON.stringify(value, null, 2);
    const data = this.crypto ? this.crypto.encrypt(text) : text;
    // Écriture atomique : on écrit dans un fichier temporaire puis on renomme.
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.filePath);
  }

  clear() {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      /* déjà supprimé */
    }
  }
}

module.exports = { JsonStore };
