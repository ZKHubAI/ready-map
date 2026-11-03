/* Ready Map service worker.
 * - App shell: precached, cache-first, versioned cache; old versions deleted on activate.
 * - OSM tiles: cache-first from a separate tile cache, only tiles the user actually viewed,
 *   bounded to MAX_TILES (oldest removed first). There is no prefetch: the OSM tile policy
 *   forbids it. The old 1.0.0 "Save this area" cache (ready-map-saved-v1) is deleted on activate.
 * - Everything else (Overpass, NOAA/NWS weather, RainViewer, map links) is NOT handled here:
 *   it goes straight to the network and is never cached. That includes the 1.2.0 Ocean layer
 *   hosts (nowcoast.noaa.gov, gis.charttools.noaa.gov, mapservices.weather.noaa.gov): ocean
 *   model/satellite/chart pictures change and must never be shown stale from a cache.
 *   The 1.2.1 spot weather host marine-api.open-meteo.com is never cached either.
 *   The same goes for the 1.2.0 World layer hosts: www.gdacs.org (disaster alerts),
 *   coastwatch.noaa.gov (world currents), wms.gebco.net (world sea depth) and RainViewer
 *   (world radar), and the Weather news feeds (api.weather.gov, www.weather.gov, www.gdacs.org).
 *   The Local weather card (api.weather.gov, api.open-meteo.com) is never cached here either:
 *   its last result is kept only in page memory.
 *   Only same-origin app files and TILE_HOST tiles are ever cached.
 */
'use strict';

var VERSION = '1.2.1';
var SHELL_CACHE = 'ready-map-shell-' + VERSION;
var TILE_CACHE = 'ready-map-tiles-v1';   // must match app.js
var MAX_TILES = 500;                     // must match MAX_VIEWED_TILES in app.js
var TILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // refresh viewed tiles after a week when online
var TILE_HOST = 'tile.openstreetmap.org';

var SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/LICENSE',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        var ours = k.indexOf('ready-map-') === 0;
        var keep = k === SHELL_CACHE || k === TILE_CACHE;
        return ours && !keep ? caches.delete(k) : null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  if (url.hostname === TILE_HOST) {
    event.respondWith(handleTile(event));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(handleShell(req, url));
  }
  // All other origins: not intercepted, so never cached by us.
});

function handleShell(req, url) {
  var scopePath = new URL(self.registration.scope).pathname;
  var isNav = req.mode === 'navigate';
  return caches.open(SHELL_CACHE).then(function (cache) {
    // Navigations (with or without ?lat=..) map to the cached index page.
    var key = isNav ? './index.html' : req;
    return cache.match(key, { ignoreSearch: isNav }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        // Only cache same-origin files inside our scope that are part of the app.
        if (res.ok && url.pathname.indexOf(scopePath) === 0 && !isNav) {
          var copy = res.clone();
          cache.put(req, copy);
        }
        return res;
      }).catch(function () {
        if (isNav) return cache.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    });
  });
}

var putsSinceTrim = 0;

function handleTile(event) {
  var req = event.request;
  var matchOpts = { ignoreVary: true };
  // Keep the worker alive until the cache write + trim finish (not just until the tile is
  // returned). waitUntil is called synchronously here, during the fetch event dispatch.
  var finishWrite;
  event.waitUntil(new Promise(function (resolve) { finishWrite = resolve; }));
  var wrote = false;

  var result = caches.open(TILE_CACHE).then(function (cache) {
    return cache.match(req.url, matchOpts).then(function (hit) {
      var fresh = hit && (Date.now() - Number(hit.headers.get('x-rm-cached-at') || 0) < TILE_MAX_AGE_MS);
      if (hit && (fresh || !self.navigator.onLine)) return hit;
      return fetch(req).then(function (res) {
        // Store only readable (CORS) successful tiles; opaque responses waste quota.
        if (res.ok && res.type !== 'opaque') {
          wrote = true;
          finishWrite(stamp(res.clone()).then(function (stamped) {
            return cache.put(req.url, stamped);
          }).then(function () {
            putsSinceTrim++;
            if (putsSinceTrim >= 25) { putsSinceTrim = 0; return trim(cache); }
          }).catch(function () { /* storage full: ignore */ }));
        }
        return res;
      }).catch(function () {
        if (hit) return hit;
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    });
  });
  // Nothing to write (cache hit, error, opaque): release the waitUntil promise.
  result.then(function () { if (!wrote) finishWrite(); }, function () { finishWrite(); });
  return result;
}

/** Copy a response, adding the time we cached it. */
function stamp(res) {
  return res.blob().then(function (body) {
    var headers = new Headers();
    headers.set('Content-Type', res.headers.get('Content-Type') || 'image/png');
    headers.set('x-rm-cached-at', String(Date.now()));
    return new Response(body, { status: 200, statusText: 'OK', headers: headers });
  });
}

/** Keep the viewed-tile cache bounded (oldest entries first; keys() is insertion order). */
function trim(cache) {
  return cache.keys().then(function (keys) {
    var extra = keys.length - MAX_TILES;
    var dels = [];
    for (var i = 0; i < extra; i++) dels.push(cache.delete(keys[i]));
    return Promise.all(dels);
  });
}
