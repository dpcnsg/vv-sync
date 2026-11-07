/* victorview 밑줄펜 service worker — 앱 껍데기 + 연 책을 저장해 오프라인에서도 읽고 밑줄 긋기 */
var VERSION = 'mj-v16';
var SHELL = VERSION + '-shell';
var BOOKS = 'mj-books-v2'; // 잠긴 .enc만 (풀린 PDF는 저장하지 않음)
var CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
var SHELL_FILES = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/listen.js', 'js/books.js', 'manifest.webmanifest', 'icons/icon.svg',
  CDN + 'pdf.min.js', CDN + 'pdf.worker.min.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return Promise.all(SHELL_FILES.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL && k !== BOOKS && k.indexOf('mj-') === 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function fromNetThenCache(req, cacheName) {
  return fetch(req).then(function (res) {
    if (res && (res.ok || res.type === 'opaque')) { var copy = res.clone(); caches.open(cacheName).then(function (c) { c.put(req, copy); }); }
    return res;
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return; // 보내기(POST)는 건드리지 않는다
  var url = new URL(req.url);

  // 작은 자료(version.json·answers.enc·marks.enc): GitHub raw 또는 넷리파이 같은 경로. 새것 먼저, 오프라인이면 저장본
  var isSync = /\/(version\.json|answers\.enc|marks\.enc)$/.test(url.pathname) &&
    (url.hostname === 'raw.githubusercontent.com' || url.origin === location.origin || /^(localhost|127\.0\.0\.1)$/.test(url.hostname));
  if (isSync) {
    var key = new Request(url.origin + url.pathname);
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(BOOKS).then(function (c) { c.put(key, copy); }); }
      else if (res && !res.ok) return caches.open(BOOKS).then(function (c) { return c.match(key); }).then(function (hit) { return hit || res; });
      return res;
    }).catch(function () { return caches.open(BOOKS).then(function (c) { return c.match(key); }).then(function (hit) { return hit || Response.error(); }); }));
    return;
  }
  // 모두의 밑줄(marks.enc): 다시 올릴 때마다 바뀌므로 새것 먼저, 오프라인이면 저장본
  if (url.origin === location.origin && /\/books\/marks\.enc$/.test(url.pathname)) {
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(BOOKS).then(function (c) { c.put(new Request(url.pathname), copy); }); }
      return res;
    }).catch(function () { return caches.open(BOOKS).then(function (c) { return c.match(new Request(url.pathname)); }).then(function (hit) { return hit || Response.error(); }); }));
    return;
  }
  // 잠긴 책(.enc): 저장본 먼저(한 번 연 책은 오프라인에서도). ?v= 가 바뀌면(다시 잠금) 새로 받고 옛것은 지운다.
  if (url.origin === location.origin && /\/books\/.+\.enc$/.test(url.pathname)) {
    e.respondWith(caches.open(BOOKS).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            c.keys().then(function (ks) {
              ks.forEach(function (k) { var u = new URL(k.url); if (u.pathname === url.pathname && u.search !== url.search) c.delete(k); });
              c.put(req, copy);
            });
          }
          return res;
        });
      });
    }));
    return;
  }
  // PDF.js(고정 버전)와 글꼴: 저장본 먼저
  if (url.href.indexOf(CDN) === 0 || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.match(req).then(function (hit) { return hit || fromNetThenCache(req, SHELL); }));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com') {
    e.respondWith(caches.match(req).then(function (hit) {
      var net = fromNetThenCache(req, SHELL).catch(function () { return hit; });
      return hit || net;
    }));
    return;
  }
  // 앱 껍데기: 새것 먼저, 안 되면 저장본
  if (url.origin === location.origin) {
    e.respondWith(fromNetThenCache(req, SHELL).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
      });
    }));
  }
});
