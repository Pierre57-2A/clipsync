// Service worker : met en cache la coquille de l'app (chargement hors-ligne).
// N'intercepte JAMAIS l'API (/ws, /files, /clip, /health).
const CACHE = 'clipsync-v17';
const ASSETS = [
  '/', '/index.html', '/app.js', '/db.js', '/crypto.js', '/styles.css', '/logo.png',
  '/fonts/plus-jakarta-sans.woff2',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // `reload` contourne le cache HTTP : la nouvelle version, pas une copie périmée.
  const reqs = ASSETS.map((u) => new Request(u, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(reqs)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const old = (await caches.keys()).filter((k) => k !== CACHE);
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
    // Mise à jour d'une version déjà installée : les fenêtres ouvertes tournent
    // encore l'ancien code, on les recharge pour qu'une simple relance suffise.
    if (old.length) {
      const wins = await self.clients.matchAll({ type: 'window' });
      for (const w of wins) w.navigate(w.url).catch(() => {});
    }
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (['/ws', '/files', '/clip', '/health'].some((p) => url.pathname.startsWith(p))) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
