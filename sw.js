/* =========================================================
   BDPLAYER Service Worker
   Deploy at the repo root, alongside index.html:
       https://liwozwa.github.io/bdplayer/sw.js

   Strategy:
   - Navigations: cache-first for instant, offline-proof startup
     (no network round-trip before first paint), with a silent
     background revalidate so a redeploy is picked up next launch.
   - Other same-origin GETs: stale-while-revalidate.
   - Cross-origin, non-GET, and range requests: passed through
     untouched. Range requests matter here — audio playback uses
     them for seeking, and caching partial (206) responses would
     corrupt the cache.

   Note: this app stores audio as Blobs in IndexedDB and plays
   them from blob: URLs, which never reach this fetch handler.
   Nothing about your music library depends on this cache; it
   exists purely so the app shell itself opens offline.
   ========================================================= */

const CACHE = 'bdplayer-shell-v2';
const SHELL_URLS = ['./', './index.html'];
const FALLBACK_DOC = './index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch((err) => { console.warn('[sw] Precache failed:', err); })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* Allows the page to trigger an immediate activation of a waiting
   worker (used by the "reload to update" flow in index.html). */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isCacheableResponse(res) {
  return res && res.status === 200 && res.type === 'basic';
}

function revalidate(request, cacheKey) {
  return fetch(request)
    .then((res) => {
      if (isCacheableResponse(res)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(cacheKey || request, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  // Never intercept range requests — partial 206 responses must not
  // be cached or served from cache, or media seeking breaks.
  if (req.headers.has('range')) return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // --- Navigations: cache-first, revalidate in background ---
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(FALLBACK_DOC, { ignoreSearch: true })
        .then((cached) => {
          if (cached) {
            // Refresh the cached shell for the *next* launch; failures
            // here are silent and never block this one.
            event.waitUntil(revalidate(req, FALLBACK_DOC));
            return cached;
          }
          return fetch(req)
            .then((res) => {
              if (isCacheableResponse(res)) {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(FALLBACK_DOC, copy)).catch(() => {});
              }
              return res;
            })
            .catch(() => caches.match('./', { ignoreSearch: true }));
        })
    );
    return;
  }

  // --- Everything else same-origin: stale-while-revalidate ---
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = revalidate(req);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return network.then((res) => res || Response.error());
    })
  );
});
