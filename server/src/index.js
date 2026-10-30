// Serveur relais ClipSync.
//  - WebSocket (/ws)   : présence, relais des messages presse-papiers, accusés.
//  - HTTP (/files)     : upload/download des fichiers et images (7 jours).
// Le serveur route les messages mais ne voit jamais le contenu en clair :
// tout arrive déjà chiffré côté client (payloads opaques).

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { Registry, safeSend } from './registry.js';
import { FileStore } from './files.js';

const registry = new Registry();
const files = new FileStore();

// Le corps JSON reste petit (un texte chiffré en base64) ; les octets des
// fichiers passent par /files, en flux, sans jamais être bufferisés ici.
const app = Fastify({ bodyLimit: 16 * 1024 * 1024 });

await app.register(websocket);

// Upload : on rend le flux brut au lieu de bufferiser. Un fichier de 100 Mo
// entièrement chargé en mémoire mettrait le conteneur (fusible 512 Mo) en
// danger ; FileStore l'écrit directement sur disque et compte les octets.
app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

function authHttp(req) {
  const accountId = req.headers['x-account-id'];
  const token = req.headers['x-token'];
  if (!accountId) return null;
  if (!registry.authenticate(String(accountId), String(token ?? ''))) return null;
  return String(accountId);
}

// --- Santé ------------------------------------------------------------------
app.get('/health', async () => ({ ok: true, ts: Date.now() }));

// --- Upload / download des fichiers ------------------------------------------
app.post('/files', async (req, reply) => {
  const accountId = authHttp(req);
  if (!accountId) return reply.code(401).send({ error: 'unauthorized' });

  const contentType = String(req.headers['x-file-type'] ?? 'application/octet-stream');
  const res = await files.putStream(req.body, contentType, { accountId });
  if (res.error === 'too large') return reply.code(413).send({ error: 'file too large' });
  if (res.error === 'empty') return reply.code(400).send({ error: 'empty body' });
  if (res.error) return reply.code(500).send({ error: 'storage failure' });

  return { fileId: res.id, size: res.entry.size, ttlMs: config.fileTtlMs };
});

app.get('/files/:id', async (req, reply) => {
  const accountId = authHttp(req);
  if (!accountId) return reply.code(401).send({ error: 'unauthorized' });

  const f = files.get(req.params.id);
  if (!f) return reply.code(404).send({ error: 'not found or expired' });
  if (f.accountId && f.accountId !== accountId) return reply.code(403).send({ error: 'forbidden' });

  reply.header('content-type', f.contentType);
  reply.header('content-length', String(f.size));
  return reply.send(files.open(f.id));
});

// --- Distribution d'un clip ---------------------------------------------------
// Pousse aux appareils en ligne, met de côté pour ceux qui ont demandé la file
// d'attente. Retourne de quoi renseigner l'expéditeur.
function deliver(accountId, senderId, targets, payload) {
  const { online, offline } = registry.resolveDelivery(accountId, senderId, targets);
  const wire = JSON.stringify(payload);
  for (const dev of online) safeSend(dev.socket, wire);
  for (const dev of offline) registry.enqueue(dev, payload);
  return {
    delivered: online.length,
    queued: offline.length,
    targets: online.map((d) => d.id),
    queuedTargets: offline.map((d) => d.id),
  };
}

// --- Envoi d'un clip en HTTP (Raccourci Apple / App Intent / app fermée) -----
// Permet d'envoyer sans WebSocket : idéal pour un déclencheur en arrière-plan.
app.post('/clip', async (req, reply) => {
  const accountId = authHttp(req);
  if (!accountId) return reply.code(401).send({ error: 'unauthorized' });

  const body = req.body ?? {};
  const { contentType, text, fileId, fileType, enc, targets, meta, deviceId, deviceName } = body;
  if (!contentType) return reply.code(400).send({ error: 'missing contentType' });

  const senderId = deviceId ?? 'http-sender';
  return deliver(accountId, senderId, targets ?? 'all', {
    type: 'clip',
    messageId: body.messageId ?? randomUUID(),
    contentType, // 'text' | 'image' | 'file'
    text,
    fileId,
    fileType,
    enc, // marqueur de chiffrement ('v1' | undefined)
    meta: meta ?? {},
    from: { deviceId: senderId, name: deviceName ?? 'un appareil' },
    ts: Date.now(),
  });
});

// --- WebSocket temps réel ---------------------------------------------------
app.register(async (app) => {
  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      handle(socket, msg);
    });
    socket.on('close', () => {
      const ref = registry.disconnect(socket);
      if (ref) registry.broadcastDevices(ref.accountId);
    });
    socket.on('error', () => {});
  });
});

function handle(socket, msg) {
  switch (msg?.type) {
    // Authentification + arrivée en ligne.
    case 'hello': {
      const { accountId, token, deviceId, deviceName, platform, caps } = msg;
      if (!accountId || !deviceId) return safeSend(socket, err('missing accountId/deviceId'));
      if (!registry.authenticate(String(accountId), String(token ?? ''))) {
        return safeSend(socket, err('bad pairing secret'));
      }
      registry.connect({ accountId, deviceId, deviceName, platform, caps }, socket);
      safeSend(
        socket,
        JSON.stringify({
          type: 'welcome',
          deviceId,
          devices: registry.listDevices(accountId, deviceId),
        }),
      );
      registry.broadcastDevices(accountId);

      // Ce qui est arrivé pendant que l'appareil était éteint. `queued` prévient
      // le client qu'il rejoue du passé et ne doit rien coller automatiquement.
      for (const payload of registry.drainQueue(accountId, deviceId)) {
        safeSend(socket, JSON.stringify({ ...payload, queued: true }));
      }
      break;
    }

    // Maintien de présence.
    case 'heartbeat': {
      registry.touch(socket);
      break;
    }

    case 'list-devices': {
      const ref = socket._clip;
      if (ref) {
        safeSend(
          socket,
          JSON.stringify({ type: 'devices', devices: registry.listDevices(ref.accountId, ref.deviceId) }),
        );
      }
      break;
    }

    // Oubli d'un appareil (réglages de la PWA).
    case 'remove-device': {
      const ref = socket._clip;
      if (!ref) return safeSend(socket, err('not authenticated'));
      const target = msg.deviceId;
      if (!target) return safeSend(socket, err('missing deviceId'));
      if (target === ref.deviceId) return safeSend(socket, err('cannot remove self'));
      registry.removeDevice(ref.accountId, target);
      registry.broadcastDevices(ref.accountId);
      safeSend(
        socket,
        JSON.stringify({ type: 'devices', devices: registry.listDevices(ref.accountId, ref.deviceId) }),
      );
      break;
    }

    // Envoi d'un élément de presse-papiers vers une ou plusieurs cibles.
    case 'clip': {
      const ref = socket._clip;
      if (!ref) return safeSend(socket, err('not authenticated'));
      registry.touch(socket);

      const sender = registry.getDevice(ref.accountId, ref.deviceId);
      const result = deliver(ref.accountId, ref.deviceId, msg.targets, {
        type: 'clip',
        messageId: msg.messageId,
        contentType: msg.contentType, // 'text' | 'image' | 'file'
        text: msg.text, // si texte (chiffré si enc)
        fileId: msg.fileId, // si image/fichier (à télécharger via GET /files/:id)
        fileType: msg.fileType,
        enc: msg.enc, // marqueur de chiffrement ('v1' | undefined)
        meta: msg.meta ?? {},
        from: { deviceId: ref.deviceId, name: sender?.name ?? 'inconnu' },
        ts: Date.now(),
      });

      // Accusé "distribué" (pas encore "appliqué au presse-papiers").
      safeSend(socket, JSON.stringify({ type: 'sent', messageId: msg.messageId, ...result }));
      break;
    }

    // Le destinataire confirme avoir écrit dans son presse-papiers.
    case 'applied': {
      const ref = socket._clip;
      if (!ref) return;
      const origin = registry.getDevice(ref.accountId, msg.to);
      if (origin?.socket) {
        safeSend(
          origin.socket,
          JSON.stringify({
            type: 'applied',
            messageId: msg.messageId,
            by: {
              deviceId: ref.deviceId,
              name: registry.getDevice(ref.accountId, ref.deviceId)?.name,
            },
            success: msg.success !== false,
            ts: Date.now(),
          }),
        );
      }
      break;
    }

    default:
      safeSend(socket, err('unknown type: ' + msg?.type));
  }
}

function err(message) {
  return JSON.stringify({ type: 'error', message });
}

// --- PWA : fichiers statiques servis à la racine (/, /app.js, /crypto.js, …) -
await app.register(fastifyStatic, {
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'),
  prefix: '/',
});

// Diffusion périodique de la présence (rafraîchit aussi les statuts en/hors ligne).
const presenceTimer = setInterval(() => {
  for (const accountId of registry.accounts.keys()) registry.broadcastDevices(accountId);
}, 30_000);
presenceTimer.unref?.();

app
  .listen({ port: config.port, host: config.host })
  .then(() => console.log(`ClipSync relay → http://localhost:${config.port}  (ws://localhost:${config.port}/ws)`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
