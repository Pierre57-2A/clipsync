// Stockage local de l'historique (IndexedDB).
//
// localStorage ne tenait pas la route : quota ~5 Mo, tout en base64, et les
// images finissaient jetées pour faire de la place. Ici les octets sont gardés
// tels quels, ce qui permet de reproposer un téléchargement des heures plus tard
// et de garder un favori indéfiniment.
//
// Deux magasins :
//   entries — une fiche par élément d'historique (petite : pas d'octets dedans)
//   blobs   — les octets, séparés, pour pouvoir les évincer sans perdre la fiche

const DB_NAME = 'clipsync';
const DB_VERSION = 1;
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('entries')) {
          d.createObjectStore('entries', { keyPath: 'id' }).createIndex('env_ts', ['env', 'ts']);
        }
        if (!d.objectStoreNames.contains('blobs')) {
          d.createObjectStore('blobs', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
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

const envRange = (env) => IDBKeyRange.bound([env, 0], [env, Number.MAX_SAFE_INTEGER]);

// --- Fiches -----------------------------------------------------------------

// Plus récent d'abord (l'index trie par date croissante).
export async function entriesOf(env) {
  const d = await db();
  const idx = d.transaction('entries').objectStore('entries').index('env_ts');
  return (await p(idx.getAll(envRange(env)))).reverse();
}

export async function allEntries() {
  const d = await db();
  return p(d.transaction('entries').objectStore('entries').getAll());
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

// Suppression en masse : un curseur, une seule transaction. `keep` permet de
// conserver certaines fiches (les favoris échappent à la purge).
async function sweep(env, range, keep) {
  const d = await db();
  const tx = d.transaction(['entries', 'blobs'], 'readwrite');
  const blobs = tx.objectStore('blobs');
  const req = tx.objectStore('entries').index('env_ts').openCursor(range);
  let removed = 0;
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return;
    if (!keep || !keep(cur.value)) {
      blobs.delete(cur.value.id);
      cur.delete();
      removed++;
    }
    cur.continue();
  };
  await finished(tx);
  return removed;
}

export function deleteEnv(env) {
  return sweep(env, envRange(env), null);
}

export function clearHistory(env, keepFavorites = true) {
  return sweep(env, envRange(env), keepFavorites ? (e) => e.fav : null);
}

// Purge automatique : tout ce qui date de plus de `before`, sauf les favoris.
export function purgeBefore(env, before) {
  return sweep(env, IDBKeyRange.bound([env, 0], [env, before], false, true), (e) => e.fav);
}

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

export async function deleteBlob(id) {
  const d = await db();
  const tx = d.transaction('blobs', 'readwrite');
  tx.objectStore('blobs').delete(id);
  return finished(tx);
}

// Plafond de place occupée. On calcule depuis les fiches (légères) plutôt que
// depuis les octets : parcourir le magasin `blobs` chargerait tous les fichiers
// en mémoire rien que pour en faire la somme.
// Les favoris ne sont jamais évincés — c'est précisément leur promesse.
export async function enforceBlobCap(cap) {
  const entries = await allEntries();
  const stored = entries.filter((e) => e.hasBlob);
  let total = stored.reduce((n, e) => n + (e.size || 0), 0);
  if (total <= cap) return 0;

  const victims = stored.filter((e) => !e.fav).sort((a, b) => a.ts - b.ts);
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
