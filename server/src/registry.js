// Registre en mémoire des comptes, appareils et de leur présence.
// MVP : tout est en RAM (réinitialisé au redémarrage du serveur).

import { config } from './config.js';

export class Registry {
  constructor() {
    /** @type {Map<string, {id:string, secret:string|null, devices:Map}>} */
    this.accounts = new Map();
  }

  #account(accountId) {
    let acc = this.accounts.get(accountId);
    if (!acc) {
      acc = { id: accountId, secret: null, devices: new Map() };
      this.accounts.set(accountId, acc);
    }
    return acc;
  }

  // Vérifie/initialise le secret partagé du compte.
  // Le 1er appareil qui se connecte définit le secret ; les suivants doivent le fournir.
  authenticate(accountId, token) {
    const acc = this.#account(accountId);
    if (acc.secret === null) acc.secret = token;
    return acc.secret === token;
  }

  // Enregistre (ou met à jour) un appareil et l'attache à sa socket.
  connect({ accountId, deviceId, deviceName, platform, caps }, socket) {
    const acc = this.#account(accountId);
    let dev = acc.devices.get(deviceId);
    if (!dev) {
      dev = { id: deviceId, name: deviceName, platform, socket: null, lastSeen: 0, caps: [], queue: [] };
      acc.devices.set(deviceId, dev);
    }
    if (deviceName) dev.name = deviceName;
    if (platform) dev.platform = platform;
    if (Array.isArray(caps)) dev.caps = caps.map(String);
    dev.socket = socket;
    dev.lastSeen = Date.now();
    socket._clip = { accountId, deviceId };
    return dev;
  }

  touch(socket) {
    const ref = socket._clip;
    if (!ref) return;
    const dev = this.accounts.get(ref.accountId)?.devices.get(ref.deviceId);
    if (dev) dev.lastSeen = Date.now();
  }

  disconnect(socket) {
    const ref = socket._clip;
    if (!ref) return null;
    const dev = this.accounts.get(ref.accountId)?.devices.get(ref.deviceId);
    if (dev && dev.socket === socket) {
      dev.socket = null;
      dev.lastSeen = Date.now();
    }
    return ref;
  }

  // Oubli d'un appareil : il disparaît de la liste de tous les autres. S'il
  // tourne encore avec la même phrase il se réinscrira à sa reconnexion —
  // c'est au client de le masquer localement s'il ne veut plus le voir.
  removeDevice(accountId, deviceId) {
    const acc = this.accounts.get(accountId);
    const dev = acc?.devices.get(deviceId);
    if (!dev) return false;
    acc.devices.delete(deviceId);
    if (dev.socket) {
      // On prévient puis on ferme : garder la socket ouverte laisserait un
      // appareil connecté mais absent du registre, donc muet et invisible.
      safeSend(dev.socket, JSON.stringify({ type: 'removed', ts: Date.now() }));
      try { dev.socket.close(); } catch { /* déjà fermée */ }
    }
    return true;
  }

  isOnline(dev) {
    return !!dev.socket && (Date.now() - dev.lastSeen) < config.offlineAfterMs;
  }

  listDevices(accountId, exceptId = null) {
    const acc = this.accounts.get(accountId);
    if (!acc) return [];
    return [...acc.devices.values()]
      .filter((d) => d.id !== exceptId)
      .map((d) => ({
        deviceId: d.id,
        name: d.name,
        platform: d.platform,
        online: this.isOnline(d),
        lastSeen: d.lastSeen,
        queued: d.queue?.length ?? 0,
      }));
  }

  getDevice(accountId, deviceId) {
    return this.accounts.get(accountId)?.devices.get(deviceId) ?? null;
  }

  // Résout des cibles logiques ("all" / "default" / [ids]) en deux paquets :
  //  - online  : à pousser tout de suite ;
  //  - offline : à mettre en file d'attente, uniquement pour les appareils qui
  //    l'ont demandé (caps "queue"). Un client qui applique automatiquement les
  //    clips à son presse-papiers ne doit pas rejouer 100 messages au démarrage.
  resolveDelivery(accountId, senderId, targets) {
    const acc = this.accounts.get(accountId);
    if (!acc) return { online: [], offline: [] };

    const others = [...acc.devices.values()].filter((d) => d.id !== senderId);
    let wanted;
    if (targets === 'all' || targets == null) {
      wanted = others;
    } else if (targets === 'default') {
      wanted = others.filter((d) => this.isOnline(d)).slice(0, 1); // MVP : 1er en ligne
    } else {
      const ids = new Set(Array.isArray(targets) ? targets : [targets]);
      wanted = others.filter((d) => ids.has(d.id));
    }

    return {
      online: wanted.filter((d) => this.isOnline(d)),
      offline: wanted.filter((d) => !this.isOnline(d) && d.caps?.includes('queue')),
    };
  }

  enqueue(dev, payload) {
    if (!dev.queue) dev.queue = [];
    dev.queue.push({ ts: Date.now(), payload });
    const excess = dev.queue.length - config.maxQueuePerDevice;
    if (excess > 0) dev.queue.splice(0, excess); // on garde les plus récents
  }

  // Vide la file d'un appareil qui vient de se connecter (et jette le périmé).
  drainQueue(accountId, deviceId) {
    const dev = this.getDevice(accountId, deviceId);
    if (!dev?.queue?.length) return [];
    const now = Date.now();
    const items = dev.queue.filter((q) => now - q.ts <= config.queueTtlMs).map((q) => q.payload);
    dev.queue = [];
    return items;
  }

  broadcastDevices(accountId) {
    const acc = this.accounts.get(accountId);
    if (!acc) return;
    for (const dev of acc.devices.values()) {
      if (!dev.socket) continue;
      safeSend(
        dev.socket,
        JSON.stringify({ type: 'devices', devices: this.listDevices(accountId, dev.id) }),
      );
    }
  }
}

export function safeSend(socket, data) {
  try {
    if (socket && socket.readyState === 1) socket.send(data); // 1 = OPEN
  } catch {
    /* socket fermée entre-temps : on ignore */
  }
}
