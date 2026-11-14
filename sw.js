/* Service worker: permite usar la app sin conexión. */
const VERSION = 'anota-pdf-1.2.0';
const SHELL = [
  './',
  'index.html',
  'styles.css?v=1.2.0',
  'app.js?v=1.2.0',
  'manifest.webmanifest',
  'vendor/pdfjs/pdf.min.js',
  'vendor/pdfjs/pdf.worker.min.js',
  'vendor/pdf-lib.min.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Red primero para la app (para recibir actualizaciones); caché si no hay conexión.
  const isShell = req.mode === 'navigate' || /\.(html|css|js|webmanifest)$/.test(new URL(req.url).pathname);
  if (isShell) {
    e.respondWith(
      // no-store: evita la caché HTTP de GitHub Pages para recibir siempre la última versión.
      fetch(req.url, { cache: 'no-store', credentials: 'same-origin' })
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
    );
    return;
  }
  // Recursos estáticos (fuentes, cmaps, iconos): caché primero.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
