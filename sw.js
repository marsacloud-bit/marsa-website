/* ==========================================================================
   مرسى | MARSA — service worker (STAGING)
   Registered by assets/js/pwa.js with scope './'. Contract: docs/online/APP_UI_SPEC.md §PWA.

   * One versioned cache (CACHE). Bump VERSION whenever the precache list or this
     file's strategy changes; activate deletes every other 'marsa-' cache.
   * Precache: the signed-in pages in their original site layout + their local
     CSS / JS / i18n / images + offline.html. Each file
     is fetched on its own so a missing optional file never blocks install; only
     offline.html is mandatory.
   * Strategies (same-origin GET only):
       navigations          network-first → cached page (stored by path, query
                            stripped) → offline.html
       .js / .css / .json   network-first → cache
       images / fonts       stale-while-revalidate: the cached copy at once, refreshed
                            in the background (a same-name logo / icon updates on the
                            next load without a VERSION bump)
   * NEVER intercepted: cross-origin requests (Supabase, jsDelivr, Google Fonts),
     non-GET, Range requests. Responses are stored only when ok + same-origin
     ('basic'), so a 401 from HTTP Basic Auth or an error page is never cached.
     Same-origin fetches carry the browser's Basic Auth credentials by default.
   * A 401 on a navigation (HTTP Basic Auth credentials gone after a browser restart) is
     never handed to the page: a worker-made fetch cannot show the browser's login prompt,
     so the worker answers with a tiny page that unregisters it and reloads; the browser
     then makes the navigation itself and prompts. pwa.js registers the worker again on
     the next successful page load.
   * Query strings are dropped from cache keys of pages, so invite tokens / auth
     codes in the address bar (login.html?invite=…, ?code=…) never land in Cache Storage.
   * Update: a new worker waits; the page (pwa.js) shows "update available — reload"
     and posts {type:'SKIP_WAITING'}; activate then claims the open clients.
   ========================================================================== */
'use strict';

var VERSION = '2026-11-07.2';   // G6b review fixes (msg/inbox.js, kit.js, contacts.js, tx-msg.js, i18n/msg.js, app-shell.js); G6b: unified inbox (msg/*.js, i18n/msg.js, msg.css); G6a review fixes (rpt/*.js, i18n/rpt.js); G6a: search / reports / dashboards (rpt/*.js, rpt.js, rpt.css, dash.css) + portal tabs; G4 fin/*, G5 bill/* kept
var CACHE = 'marsa-app-' + VERSION;
var OFFLINE_URL = 'offline.html';

// relative to the worker's location (= the site root)
var PRECACHE = [
  OFFLINE_URL,
  'login.html', 'admin.html', 'platform.html', 'portal.html', 'ocr.html', 'bulk-upload.html',
  'manifest.json',
  // styles: the original design system + shared components + page sheets
  'assets/css/style.css', 'assets/css/app.css',
  'assets/css/pages/login.css', 'assets/css/pages/admin.css', 'assets/css/pages/ops.css', 'assets/css/pages/fin.css', 'assets/css/pages/bill.css',
  'assets/css/pages/rpt.css', 'assets/css/pages/dash.css', 'assets/css/pages/msg.css',
  'assets/css/pages/platform.css',
  'assets/css/pages/portal.css', 'assets/css/pages/ocr.css', 'assets/css/pages/bulk-upload.css',
  // scripts
  'assets/js/config.js', 'assets/js/i18n.js', 'assets/js/main.js', 'assets/js/supa.js',
  'assets/js/app-shell.js', 'assets/js/pwa.js', 'assets/js/auth.js',
  'assets/js/admin.js', 'assets/js/platform.js', 'assets/js/portal.js',
  'assets/js/ocr.js', 'assets/js/ocr-parse.js', 'assets/js/bulk-upload.js', 'assets/js/xlsx-lite.js',
  'assets/js/ops/alerts.js', 'assets/js/ops/schedule.js', 'assets/js/ops/parties.js',
  'assets/js/ops/exceptions.js', 'assets/js/ops/requirements.js', 'assets/js/ops/tx-sections.js',
  'assets/js/fin/invoices.js', 'assets/js/fin/payables.js', 'assets/js/fin/margins.js',
  'assets/js/fin/demurrage.js', 'assets/js/fin/tx-fin.js',
  'assets/js/bill/billing.js', 'assets/js/bill/daftra.js', 'assets/js/bill/tx-bill.js',
  'assets/js/rpt/xlsx.js', 'assets/js/rpt/export.js', 'assets/js/rpt/search.js', 'assets/js/rpt/reports.js', 'assets/js/rpt/dashboards.js',
  'assets/js/msg/kit.js', 'assets/js/msg/inbox.js', 'assets/js/msg/channels.js', 'assets/js/msg/contacts.js', 'assets/js/msg/templates.js',
  'assets/js/msg/tx-msg.js',
  // (supabase/functions/* — daftra-sync, inbox-sync — is server source: never precached, never served by the site)
  // dictionaries (a missing optional file never blocks the install)
  'assets/i18n/app.js', 'assets/i18n/login.js', 'assets/i18n/admin.js', 'assets/i18n/ops.js', 'assets/i18n/fin.js', 'assets/i18n/bill.js', 'assets/i18n/rpt.js', 'assets/i18n/msg.js',
  'assets/i18n/platform.js',
  'assets/i18n/ocr.js', 'assets/i18n/bulk.js', 'assets/i18n/portal.js',
  // images: header logo (site-header / drawer / footer), favicon, PWA icons
  'assets/img/logo-header.png', 'assets/img/favicon.png', 'assets/img/logo.png',
  'assets/img/icons/icon-180.png', 'assets/img/icons/icon-192.png',
  'assets/img/icons/icon-512.png', 'assets/img/icons/maskable-512.png'
];

function scopeUrl(path) { return new URL(path, self.registration.scope).href; }

function cacheable(res) { return !!res && res.ok && res.type === 'basic'; }

// page cache key: path only (no query, no hash)
function pageKey(url) { var u = new URL(url); return u.origin + u.pathname; }

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return Promise.all(PRECACHE.map(function (p) {
      var url = scopeUrl(p);
      // cache:'reload' bypasses the HTTP cache so a new version gets fresh files
      return fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' })).then(function (res) {
        if (cacheable(res)) return cache.put(url, res);
        if (p === OFFLINE_URL) throw new Error('offline page not available');
      }, function (err) {
        if (p === OFFLINE_URL) throw err;
      });
    }));
  }));
  // no skipWaiting() here: an update waits until the page asks (SKIP_WAITING)
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) {
      return k.indexOf('marsa-') === 0 && k !== CACHE ? caches.delete(k) : null;
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function put(key, res) {
  return caches.open(CACHE).then(function (c) { return c.put(key, res); }).then(null, function () { /* quota */ });
}

// inline recovery page for a 401 navigation (see header). The sessionStorage flag stops a
// reload loop when unregistering does not take effect; then the user gets a manual button.
var AUTH_RECOVERY_HTML = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>مرسى MARSA</title>' +
  '<style>body{font:16px/1.6 "Cairo","Segoe UI",Tahoma,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#F4F8FB;color:#0F1E33}' +
  'main{max-width:28rem;padding:24px;text-align:center}' +
  'button{font:inherit;font-weight:700;padding:10px 22px;border-radius:999px;border:0;background:#0B3A6E;color:#fff;cursor:pointer}</style></head>' +
  '<body><main><p>يلزم تسجيل الدخول إلى بيئة الاختبار من جديد… <span lang="en" dir="ltr">Re-authenticating…</span></p>' +
  '<p><button type="button" id="r" hidden>إعادة المحاولة · Retry</button></p></main><script>(function(){' +
  'var k="marsa_sw_auth",b=document.getElementById("r");b.onclick=function(){try{sessionStorage.removeItem(k)}catch(e){}go()};' +
  'function go(){var sw=navigator.serviceWorker;(sw?sw.getRegistrations():Promise.resolve([])).then(function(rs){return Promise.all(rs.map(function(r){return r.unregister()}))})' +
  '.then(null,function(){}).then(function(){try{sessionStorage.setItem(k,String(Date.now()))}catch(e){}location.reload()})}' +
  'var t=0;try{t=+sessionStorage.getItem(k)||0}catch(e){}if(Date.now()-t<15000){b.hidden=false}else go()})();</script></body></html>';

function networkFirstPage(req) {
  var key = pageKey(req.url);
  return fetch(req).then(function (res) {
    if (res && res.status === 401) {
      return new Response(AUTH_RECOVERY_HTML, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (cacheable(res)) put(key, res.clone());
    return res;
  }, function () {
    return caches.open(CACHE).then(function (c) {
      return c.match(key).then(function (hit) {
        return hit || c.match(scopeUrl(OFFLINE_URL));
      });
    }).then(function (hit) {
      return hit || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    });
  });
}

function networkFirst(req) {
  return fetch(req).then(function (res) {
    if (cacheable(res)) put(req, res.clone());
    return res;
  }, function (err) {
    return caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      throw err;
    });
  });
}

// stale-while-revalidate: answer from the cache when possible, refresh the copy in the background
function staleWhileRevalidate(event) {
  var req = event.request, stored;
  var fresh = fetch(req).then(function (res) {
    if (cacheable(res)) stored = put(req, res.clone());
    return res;
  });
  // keeps the worker alive until the background copy is stored (called during dispatch)
  event.waitUntil(fresh.then(function () { return stored; }, function () { /* offline: keep the cached copy */ }));
  return caches.match(req, { cacheName: CACHE }).then(function (hit) { return hit || fresh; });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;              // Supabase, CDNs, fonts: untouched
  if (url.pathname === new URL(self.location.href).pathname) return;   // sw.js itself
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  if (req.mode === 'navigate') { event.respondWith(networkFirstPage(req)); return; }
  if (/\.(?:js|css|json)$/i.test(url.pathname)) { event.respondWith(networkFirst(req)); return; }
  if (req.destination === 'image' || req.destination === 'font' ||
      /\.(?:png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf)$/i.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event));
  }
  // anything else: browser default
});
