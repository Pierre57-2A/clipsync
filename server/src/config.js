// Configuration du serveur relais ClipSync.
// Seuls le port, l'adresse d'écoute et le dossier des fichiers se règlent par
// variables d'environnement ; le reste est fixé ici.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 7 jours glissants : la PWA garde son historique aussi longtemps, et une image
// reçue lundi doit encore s'ouvrir dimanche.
const KEEP_MS = 7 * 24 * 60 * 60_000;

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',

  // Délai (ms) sans heartbeat avant de considérer un appareil hors ligne.
  offlineAfterMs: 90_000,

  // Durée de vie d'un fichier sur le relais.
  fileTtlMs: KEEP_MS,

  // Les fichiers vivent sur disque, pas en RAM : le conteneur est fusible à
  // 512 Mo et 7 jours de rétention n'y tiendraient jamais.
  filesDir: process.env.FILES_DIR ?? path.join(serverRoot, 'data', 'files'),

  // Plafond global du stockage disque. Au-delà, les plus anciens fichiers
  // partent en premier — sans quoi le disque du VPS se remplit en silence.
  // Mesure du 30/10/2026 : ~100 Mo par jour, soit ~700 Mo sur 7 jours.
  maxStoreBytes: 2 * 1024 * 1024 * 1024,

  // Taille max d'un transfert (image ou fichier), octets.
  maxFileBytes: 100 * 1024 * 1024,

  // File d'attente hors ligne : un clip destiné à un appareil éteint est gardé
  // pour sa prochaine connexion. Réservé aux clients qui la demandent
  // (caps: ["queue"]) — un client qui colle automatiquement dans le
  // presse-papiers ne doit pas se prendre 100 messages d'un coup au démarrage.
  queueTtlMs: KEEP_MS,
  maxQueuePerDevice: 100,
};
