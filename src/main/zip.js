// ============================================================================
//  LECTURE DES FICHIERS .ZIP (sans dépendance)
//  Sert à installer un jeu livré en .zip (ex : MidnightCity-3.16-Windows.zip).
//  Gère les méthodes « stockée » et « deflate », et le format ZIP64.
//  Chaque fichier extrait est vérifié (taille + CRC32) avant d'être mis en place.
//  Ce fichier n'utilise pas Electron : il est testé avec « npm test ».
// ============================================================================

const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform, Readable } = require('stream');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

class ZipError extends Error {
  constructor(message, code = 'BAD_ZIP') {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- CRC32
let crcTable = null;
function crc32Js(buf, prev = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** CRC32 (celui du format zip). Utilise la version rapide de Node quand elle existe. */
const crc32 = typeof zlib.crc32 === 'function' ? (buf, prev = 0) => zlib.crc32(buf, prev) >>> 0 : crc32Js;

async function crc32File(file, onBytes) {
  let c = 0;
  const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    c = crc32(chunk, c);
    if (onBytes) onBytes(chunk.length);
  }
  return c >>> 0;
}

// ---------------------------------------------------------------- lecture du répertoire central
async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  return off === len ? buf : buf.subarray(0, off);
}

const u64 = (buf, at) => {
  const v = buf.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('Zip trop grand.');
  return Number(v);
};

/**
 * Ouvre un zip et renvoie la liste de ses fichiers.
 * @returns {Promise<{ file: string, size: number, entries: Array<{name, method, compSize, size, crc32, localOffset, isDir, encrypted}> }>}
 */
async function readZip(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
  } catch (e) {
    throw new ZipError(`Impossible d'ouvrir le zip : ${e.message}`, 'NOT_FOUND');
  }
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipError("Ce fichier n'est pas un zip valide.");
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        e = i;
        break;
      }
    }
    if (e < 0) throw new ZipError("Ce fichier n'est pas un zip valide (ou il est incomplet).");
    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOffset = tail.readUInt32LE(e + 16);

    // ZIP64 : les vraies valeurs sont dans l'enregistrement ZIP64
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locPos = size - tailLen + e - 20;
      if (locPos < 0) throw new ZipError('Zip64 invalide.');
      const loc = await readAt(fh, locPos, 20);
      if (loc.readUInt32LE(0) !== SIG_EOCD64_LOC) throw new ZipError('Zip64 invalide.');
      const rec = await readAt(fh, u64(loc, 8), 56);
      if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new ZipError('Zip64 invalide.');
      count = u64(rec, 32);
      cdSize = u64(rec, 40);
      cdOffset = u64(rec, 48);
    }
    if (cdOffset + cdSize > size) throw new ZipError('Le zip est incomplet (téléchargement interrompu ?).');

    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('Répertoire du zip abîmé.');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compSize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const name = nameBuf.toString(flags & 0x800 ? 'utf8' : 'latin1');
      // champ « extra » ZIP64 (id 0x0001)
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) {
            usize = u64(cd, q);
            q += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = u64(cd, q);
            q += 8;
          }
          if (localOffset === 0xffffffff) localOffset = u64(cd, q);
        }
        x += 4 + len;
      }
      entries.push({
        name,
        method,
        compSize,
        size: usize,
        crc32: crc >>> 0,
        localOffset,
        isDir: name.endsWith('/') || name.endsWith('\\'),
        encrypted: !!(flags & 1),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { file, size, entries };
  } finally {
    await fh.close();
  }
}

/** Position du début des données compressées d'un fichier (après son en-tête local). */
async function dataStart(file, entry) {
  const fh = await fsp.open(file, 'r');
  try {
    const h = await readAt(fh, entry.localOffset, 30);
    if (h.length < 30 || h.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError(`En-tête abîmé pour ${entry.name}.`);
    return entry.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally {
    await fh.close();
  }
}

/**
 * Extrait un fichier du zip vers « dest » (via un fichier .part, vérifié puis renommé).
 * onBytes(n) est appelé avec le nombre d'octets décompressés écrits.
 * Renvoie l'empreinte sha256 du fichier (la même que celle du manifest d'un serveur).
 */
async function extractEntry(file, entry, dest, { signal, onBytes } = {}) {
  if (entry.encrypted) throw new ZipError(`${entry.name} est protégé par un mot de passe : impossible de l'installer.`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError(`${entry.name} utilise une compression non prise en charge (méthode ${entry.method}).`);
  }
  const start = await dataStart(file, entry);
  const part = `${dest}.part`;
  let written = 0;
  let crc = 0;
  const sha = crypto.createHash('sha256');
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      crc = crc32(chunk, crc);
      sha.update(chunk);
      if (onBytes) onBytes(chunk.length);
      cb(null, chunk);
    },
  });
  const source =
    entry.compSize > 0
      ? fs.createReadStream(file, { start, end: start + entry.compSize - 1, highWaterMark: 1024 * 1024 })
      : Readable.from([]);
  const steps = [source];
  if (entry.method === 8 && entry.compSize > 0) steps.push(zlib.createInflateRaw());
  steps.push(counter, fs.createWriteStream(part));
  try {
    if (signal) await pipeline(...steps, { signal });
    else await pipeline(...steps);
  } catch (e) {
    if (onBytes) onBytes(-written);
    await fsp.rm(part, { force: true }).catch(() => {});
    if (signal && signal.aborted) throw new ZipError('Installation annulée.', 'CANCELLED');
    if (e.code === 'ENOSPC') throw new ZipError("Le disque est plein : libère de l'espace et réessaie.", 'DISK_FULL');
    throw new ZipError(`Le fichier ${entry.name} est abîmé dans le zip : ${e.message}`);
  }
  if (written !== entry.size || crc >>> 0 !== entry.crc32) {
    if (onBytes) onBytes(-written);
    await fsp.rm(part, { force: true }).catch(() => {});
    throw new ZipError(`Le fichier ${entry.name} est abîmé dans le zip (vérification échouée). Retélécharge le zip.`);
  }
  try {
    await fsp.rename(part, dest);
  } catch {
    if (onBytes) onBytes(-written);
    await fsp.rm(part, { force: true }).catch(() => {});
    throw new ZipError(`Impossible de remplacer ${entry.name}. Ferme le jeu et réessaie.`, 'LOCKED');
  }
  return sha.digest('hex');
}

module.exports = { readZip, extractEntry, crc32, crc32File, ZipError };
