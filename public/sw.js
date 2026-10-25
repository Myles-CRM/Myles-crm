const CACHE_NAME = 'myles-crm-static-v8';
const CORE_ASSETS = [
  './',
  './login.html',
  './auth-callback.html',
  './assets/style.css',
  './assets/common.js',
  './assets/crm-auth.js',
  './manifest.webmanifest'
];
const CACHEABLE_PATHS = new Set(CORE_ASSETS.map((asset) => new URL(asset, self.location.href).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;
  const isRuntimeConfig = requestUrl.pathname.endsWith('/runtime-config.js');
  const isCacheableStatic = isSameOrigin && CACHEABLE_PATHS.has(requestUrl.pathname);

  // Never cache Supabase, API, Auth callback tokens, or user-specific responses.
  if (!isCacheableStatic || isRuntimeConfig || requestUrl.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }))
  );
});
