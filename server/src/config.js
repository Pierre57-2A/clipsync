// Configuration du serveur relais ClipSync.
// Tout est surchargeable par variables d'environnement.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',

  // Délai (ms) sans heartbeat avant de considérer un appareil hors ligne.
  offlineAfterMs: 90_000,

  // Durée de vie d'un fichier sur le relais.
  // 5 minutes ne marchaient que si les deux écrans étaient allumés en même
  // temps : on envoie depuis le Mac, on ouvre l'iPhone le soir, le fichier
  // avait disparu. 24 h couvre le cas réel et reste aligné sur la purge
  // automatique de l'historique côté PWA.
  fileTtlMs: Number(process.env.FILE_TTL_MS ?? 24 * 60 * 60_000),

  // Les fichiers vivent sur disque, pas en RAM : le conteneur est fusible à
  // 512 Mo et 24 h de rétention n'y tiendraient jamais.
  filesDir: process.env.FILES_DIR ?? path.join(serverRoot, 'data', 'files'),

  // Plafond global du stockage disque. Au-delà, les plus anciens fichiers
  // partent en premier — sans quoi le disque du VPS se remplit en silence.
  maxStoreBytes: Number(process.env.MAX_STORE_BYTES ?? 2 * 1024 * 1024 * 1024),

  // Taille max d'un transfert (image ou fichier), octets.
  maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? 100 * 1024 * 1024),

  // File d'attente hors ligne : un clip destiné à un appareil éteint est gardé
  // pour sa prochaine connexion. Réservé aux clients qui la demandent
  // (caps: ["queue"]) — un client qui colle automatiquement dans le
  // presse-papiers ne doit pas se prendre 100 messages d'un coup au démarrage.
  queueTtlMs: Number(process.env.QUEUE_TTL_MS ?? 24 * 60 * 60_000),
  maxQueuePerDevice: Number(process.env.MAX_QUEUE_PER_DEVICE ?? 100),
};
