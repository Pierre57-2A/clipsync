// Service worker : met en cache la coquille de l'app (chargement hors-ligne).
// N'intercepte JAMAIS l'API (/ws, /files, /clip, /health).
const CACHE = 'clipsync-v13';
const ASSETS = [
  '/', '/index.html', '/app.js', '/crypto.js', '/styles.css', '/logo.png',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (['/ws', '/files', '/clip', '/health'].some((p) => url.pathname.startsWith(p))) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
