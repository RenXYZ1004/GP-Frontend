// ════════════════════════════════════════════════════════════════
// e-gatepass Service Worker
//
// Strategy:
//   • App code (HTML / JS / CSS) → network-first, cache as fallback.
//     A cache-first shell used to pin users to an old build until the
//     cache name changed; network-first means a deploy is picked up on
//     the next load and offline still works from the cached copy.
//   • Everything else (images, fonts, libs) → cache-first.
//   • Pre-caching is per-file and fault tolerant: one missing asset can
//     no longer abort the whole install (cache.addAll is all-or-nothing).
// ════════════════════════════════════════════════════════════════

const CACHE_NAME = 'pgp-cache-v3.0.1';

// Files that make up the app shell — always revalidated against the network.
//
// Both URL forms are listed on purpose. In production vercel.json sets
// cleanUrls, so a navigation lands on / and /app; served from a plain static
// server (XAMPP, Live Server) only the .html form exists. cacheSafely
// swallows a miss, so whichever pair does not exist is simply skipped and
// offline works either way.
const APP_SHELL = [
  './',
  './app',
  './index.html',
  './app.html',
  './tgpForm.html',
  './css/styles.css',
  './css/landing.css',
  './js/main.js',
  './js/landing.js',
  './js/config.js',
  './js/publicApi.js',
  './js/utils.js',
  './js/icons.js',

  // Models & Services
  './js/models/AppModel.js',
  './js/services/appwrite.js',
  './js/services/ApiService.js',
  './js/services/AuthService.js',
  './js/services/EmailService.js',
  './js/services/FaceBiometrics.js',
  './js/services/Dialog.js',

  // Controllers
  './js/controllers/AppController.js',
  './js/controllers/pages/DashboardController.js',
  './js/controllers/pages/StudentsController.js',
  './js/controllers/pages/ScannerController.js',
  './js/controllers/pages/LogsController.js',
  './js/controllers/pages/PGPController.js',
  './js/controllers/pages/TGPController.js',
  './js/controllers/pages/SettingsController.js',
  './js/controllers/pages/ReportsController.js',

  // Views
  './js/views/AppView.js',
  './js/views/DashboardView.js',
  './js/views/StudentsView.js',
  './js/views/ScannerView.js',
  './js/views/LogsView.js',
  './js/views/PGPView.js',
  './js/views/TGPView.js',
  './js/views/ReportsView.js',
  './js/views/SettingsView.js',
  './js/views/UsersView.js'
];

// Static assets — safe to serve straight from cache.
const STATIC_ASSETS = [
  './js/lib/appwrite.js',
  './js/lib/jsQR.min.js',
  './logo.png',
  './SISC_logo.png',
  './manifest.json'
];

const CDN_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

// Extensions that belong to the app shell (network-first).
const SHELL_PATTERN = /\.(html|js|css)$/i;

// Cache one URL, logging (but swallowing) a failure so a single bad entry
// never takes the whole install down with it.
async function cacheSafely(cache, url, requestInit) {
  try {
    const request = requestInit ? new Request(url, requestInit) : url;
    const response = await fetch(request);
    // Opaque responses (no-cors CDN fetches) have status 0 — still cacheable.
    if (response.status !== 0 && !response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    await cache.put(url, response);
  } catch (err) {
    console.warn('[SW] Skipped pre-cache of', url, '—', err.message);
  }
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all([
      ...APP_SHELL.map(url => cacheSafely(cache, url)),
      ...STATIC_ASSETS.map(url => cacheSafely(cache, url)),
      ...CDN_URLS.map(url => cacheSafely(cache, url, { mode: 'no-cors' }))
    ]);
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept the Sheets backend or the Apps Script application form.
  // Gate scans and sign-ins must always hit the network — a cached exit
  // log or auth response would be actively wrong.
  if (url.hostname.includes('appwrite.io')) return;
  if (url.hostname.includes('appwrite.network')) return;
  // Matches both the clean route and the extension, since cleanUrls serves
  // this page at /newForm and redirects /newForm.html to it.
  if (url.pathname.endsWith('/newForm') || url.pathname.endsWith('/newForm.html')) return;
  if (url.pathname.endsWith('/tgpForm') || url.pathname.endsWith('/tgpForm.html')) return;
  // Nor our own serverless API — those responses must never be cached.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  const isShell =
    request.mode === 'navigate' ||
    (url.origin === self.location.origin && SHELL_PATTERN.test(url.pathname));

  event.respondWith(isShell ? networkFirst(request) : cacheFirst(request));
});

// Fresh code when online, cached code when not.
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // A navigation with nothing cached: fall back to the app shell. Try the
    // clean route first, then the extension, so this works under cleanUrls
    // and on a plain static server alike.
    if (request.mode === 'navigate') {
      const shell = await cache.match('./app') || await cache.match('./app.html');
      if (shell) return shell;
    }
    return new Response('You are offline and this resource is not cached.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// Instant load for assets; populate the cache on first sight.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}
