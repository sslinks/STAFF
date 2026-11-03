/* SSL Staff - background worker: opens the app without network and uploads saved entries. */
importScripts('sync.js');
var CACHE = 'ssl-staff-v1';
var SHELL = ['./', 'index.html', 'sync.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
function timeout(ms) { return new Promise(function (_, rej) { setTimeout(function () { rej(new Error('slow')); }, ms); }); }
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || /script\.google(usercontent)?\.com$/.test(url.hostname)) return;
  var isPage = req.mode === 'navigate';
  var key = isPage ? 'index.html' : req;
  // App files: fresh copy when the network is quick, saved copy when offline or slow
  e.respondWith(
    Promise.race([fetch(req), timeout(isPage ? 3500 : 6000)]).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
      return res;
    }).catch(function () {
      return caches.match(key, { ignoreSearch: true }).then(function (m) { return m || fetch(req); });
    })
  );
});
// Upload saved entries even when the app is closed (Android Chrome)
self.addEventListener('sync', function (e) {
  if (e.tag !== 'ssl-sync') return;
  e.waitUntil(syncNow().then(function (r) { if (r.offline || (r.pending && !r.needLogin)) throw new Error('retry later'); }));
});
self.addEventListener('message', function (e) { if (e.data === 'sync') e.waitUntil(syncNow().catch(function () {})); });
