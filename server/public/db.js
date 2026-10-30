// Stockage local de l'historique (IndexedDB).
//
// Deux magasins :
//   entries — une fiche par élément d'historique (petite : pas d'octets dedans)
//   blobs   — les octets, séparés, pour pouvoir les évincer sans perdre la fiche
//
// Version 2 : plus d'environnements ni de favoris. Une seule liste, triée par
// date, et tout part au bout de 7 jours.

const DB_NAME = 'clipsync';
const DB_VERSION = 2;
let dbPromise = null;

// Passage de la v1 à la v2 : on ne garde que l'historique de l'environnement
// conservé (choisi par app.js avant la première ouverture).
let keepEnv = null;
export const upgrade = { kept: 0, dropped: 0 };
export function keepOnlyEnv(id) { keepEnv = id; }

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        const tx = req.transaction;
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('entries')) {
          d.createObjectStore('entries', { keyPath: 'id' }).createIndex('ts', 'ts');
          return;
        }
        const store = tx.objectStore('entries');
        if (store.indexNames.contains('env_ts')) store.deleteIndex('env_ts');
        if (!store.indexNames.contains('ts')) store.createIndex('ts', 'ts');
        const blobs = tx.objectStore('blobs');
        store.openCursor().onsuccess = (ev) => {
          const cur = ev.target.result;
          if (!cur) return;
          const e = cur.value;
          if (keepEnv && e.env && e.env !== keepEnv) {
            blobs.delete(e.id);
            cur.delete();
            upgrade.dropped++;
          } else {
            delete e.env; delete e.fav; delete e.favTs;
            cur.update(e);
            upgrade.kept++;
          }
          cur.continue();
        };
      };
      req.onsuccess = () => {
        // Une version plus récente veut s'ouvrir (mise à jour de l'app) : on
        // libère la base au lieu de la bloquer.
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const p = (req) =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

const finished = (tx) =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });

// --- Fiches -----------------------------------------------------------------

// Plus récent d'abord (l'index trie par date croissante).
export async function allEntries() {
  const d = await db();
  return (await p(d.transaction('entries').objectStore('entries').index('ts').getAll())).reverse();
}

export async function putEntry(entry) {
  const d = await db();
  const tx = d.transaction('entries', 'readwrite');
  tx.objectStore('entries').put(entry);
  return finished(tx);
}

export async function deleteEntry(id) {
  const d = await db();
  const tx = d.transaction(['entries', 'blobs'], 'readwrite');
  tx.objectStore('entries').delete(id);
  tx.objectStore('blobs').delete(id);
  return finished(tx);
}

// Suppression en masse : un curseur, une seule transaction.
async function sweep(range) {
  const d = await db();
  const tx = d.transaction(['entries', 'blobs'], 'readwrite');
  const blobs = tx.objectStore('blobs');
  const req = tx.objectStore('entries').index('ts').openCursor(range);
  let removed = 0;
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return;
    blobs.delete(cur.value.id);
    cur.delete();
    removed++;
    cur.continue();
  };
  await finished(tx);
  return removed;
}

export const clearHistory = () => sweep(null);

// Purge automatique : tout ce qui est arrivé avant `before`.
export const purgeBefore = (before) => sweep(IDBKeyRange.upperBound(before, true));

// --- Octets ------------------------------------------------------------------

export async function putBlob(id, buf, mime) {
  const d = await db();
  const tx = d.transaction('blobs', 'readwrite');
  tx.objectStore('blobs').put({ id, buf, mime });
  return finished(tx);
}

export async function getBlob(id) {
  const d = await db();
  return p(d.transaction('blobs').objectStore('blobs').get(id));
}

// Plafond de place occupée. On calcule depuis les fiches (légères) plutôt que
// depuis les octets : parcourir le magasin `blobs` chargerait tous les fichiers
// en mémoire rien que pour en faire la somme. Les plus anciens partent d'abord ;
// la fiche reste, le fichier redevient téléchargeable depuis le relais.
export async function enforceBlobCap(cap) {
  const entries = await allEntries();
  const stored = entries.filter((e) => e.hasBlob);
  let total = stored.reduce((n, e) => n + (e.size || 0), 0);
  if (total <= cap) return 0;

  const victims = stored.sort((a, b) => a.ts - b.ts);
  const d = await db();
  const tx = d.transaction(['entries', 'blobs'], 'readwrite');
  let freed = 0;
  for (const e of victims) {
    if (total <= cap) break;
    tx.objectStore('blobs').delete(e.id);
    tx.objectStore('entries').put({ ...e, hasBlob: false });
    total -= e.size || 0;
    freed++;
  }
  await finished(tx);
  return freed;
}
