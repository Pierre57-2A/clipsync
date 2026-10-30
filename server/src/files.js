// Stockage des fichiers (et images) qui transitent entre appareils.
//
// Sur disque, pas en RAM : le conteneur est plafonné à 512 Mo et on garde
// désormais les transferts 7 jours pour qu'un appareil éteint au moment de l'envoi
// puisse encore les récupérer. Deux entrées par transfert : <id>.bin (octets,
// toujours chiffrés côté client) et <id>.json (métadonnées). L'index est
// reconstruit au démarrage pour survivre à un redéploiement.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

export class FileStore {
  constructor(dir = config.filesDir) {
    this.dir = dir;
    /** @type {Map<string, {id:string, size:number, contentType:string, accountId:string|null, createdAt:number, expiresAt:number}>} */
    this.files = new Map();
    this.totalBytes = 0;

    fs.mkdirSync(this.dir, { recursive: true });
    this.#restore();

    const t = setInterval(() => this.sweep(), 60_000);
    t.unref?.(); // n'empêche pas le process de se terminer
  }

  #binPath(id) { return path.join(this.dir, id + '.bin'); }
  #metaPath(id) { return path.join(this.dir, id + '.json'); }

  #restore() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        const meta = JSON.parse(fs.readFileSync(this.#metaPath(id), 'utf8'));
        meta.size = fs.statSync(this.#binPath(id)).size;
        if (Date.now() > meta.expiresAt) { this.#erase(id); continue; }
        this.files.set(id, meta);
        this.totalBytes += meta.size;
      } catch {
        this.#erase(id); // métadonnées ou octets illisibles : on repart propre
      }
    }
  }

  // Écrit le flux entrant directement sur disque. On compte les octets au
  // passage : bodyLimit de Fastify ne s'applique pas à un parseur qui rend le
  // flux brut, c'est donc ici qu'on protège la machine.
  async putStream(source, contentType, meta = {}) {
    const id = randomUUID();
    let size = 0;
    let tooBig = false;

    async function* count(src) {
      for await (const chunk of src) {
        size += chunk.length;
        if (size > config.maxFileBytes) { tooBig = true; throw new Error('file too large'); }
        yield chunk;
      }
    }

    try {
      await pipeline(source, count, fs.createWriteStream(this.#binPath(id)));
    } catch {
      this.#erase(id);
      return { error: tooBig ? 'too large' : 'write failed' };
    }
    if (size === 0) { this.#erase(id); return { error: 'empty' }; }

    const entry = {
      id,
      size,
      contentType: contentType || 'application/octet-stream',
      accountId: meta.accountId ?? null,
      createdAt: Date.now(),
      expiresAt: Date.now() + config.fileTtlMs,
    };
    try {
      await fsp.writeFile(this.#metaPath(id), JSON.stringify(entry));
    } catch {
      this.#erase(id);
      return { error: 'write failed' };
    }

    this.files.set(id, entry);
    this.totalBytes += size;
    this.#evict();
    return { id, entry };
  }

  get(id) {
    const f = this.files.get(id);
    if (!f) return null;
    if (Date.now() > f.expiresAt) { this.remove(id); return null; }
    return f;
  }

  // Flux de lecture : un fichier de 100 Mo ne passe jamais entièrement en RAM.
  open(id) {
    return fs.createReadStream(this.#binPath(id));
  }

  remove(id) {
    const f = this.files.get(id);
    if (f) {
      this.files.delete(id);
      this.totalBytes -= f.size;
    }
    this.#erase(id);
  }

  #erase(id) {
    for (const p of [this.#binPath(id), this.#metaPath(id)]) {
      try { fs.rmSync(p, { force: true }); } catch { /* déjà parti */ }
    }
  }

  sweep() {
    const now = Date.now();
    for (const [id, f] of this.files) if (now > f.expiresAt) this.remove(id);
  }

  // Plafond global : au-delà, les plus anciens partent d'abord. Sans ça, un VPS
  // partagé se remplit en silence jusqu'à faire tomber les autres services.
  #evict() {
    if (this.totalBytes <= config.maxStoreBytes) return;
    const oldest = [...this.files.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const f of oldest) {
      if (this.totalBytes <= config.maxStoreBytes) break;
      this.remove(f.id);
    }
  }
}
