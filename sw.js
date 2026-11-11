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
       docs/guide/(ar|en)/*.md  network-first → cache (G7 user guides, rendered by help.html;
                            not precached, so a guide is offline only after it was opened once)
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

var VERSION = '2026-11-25.2';   // legacy step 9 harness + browser-check fixes (imp/legacy-import.js RHK- reference column + «مطابقة بالمرجع», «م» dates, server date codes / levels, alternative required columns, parent-skip warning, only used files recorded, stepper end states, file names isolated, void dialog «رجوع»; i18n/limp.js count wording; ops/alerts.js formModal cancelText; pages/limp.css); legacy step 9 UI (imp/legacy-import.js #legacy_import owner-only wizard: files read in the browser, sheet / column detection, stage → validate → review → commit in chunks, error report, void, RHK- step; i18n/limp.js, pages/limp.css precached; admin.html, admin.js owner views + nav order, app-shell.js owner nav item); legacy step 8 browser-check fixes (rpt/export.js movements verify without cancelled money, rpt/audit-diff.js no raw row ids + billing labels, rpt/fasah-recon.js inflate / width messages, pages/lrpt.css table scroller relative, i18n/lrpt.js, i18n/rpt.js export count wording); legacy step 8 review fixes (rpt/export.js follow-up «وحدة الشحن» container numbers / Ro-Ro chassis + plate, payments file B/L + SADAD / bank ref / receipt columns + «م», movements employee + return status filters, org-switch reset of the step-8 views; rpt/xlsx.js wrap styles; rpt/register.js tooltip + units total + stale ids; rpt/colfilter.js no-prototype maps + focus kept in the dialog; rpt/fasah-recon.js audited system-only rows, ≤100 months, read limits, files one by one; xlsx-lite.js inflate / row / column limits; rpt/audit-diff.js real table names; rpt/rules.js switched-off rules; supa.js OTP gate only for code-form sessions; app-shell.js ETA; i18n/lrpt.js, pages/lrpt.css); legacy step 8 UI (rpt/colfilter.js column filters, rpt/register.js #register + follow-up export, rpt/fasah-recon.js #fasah_recon, rpt/audit-diff.js #changes + tx log, rpt/rules.js #attention_rules, i18n/lrpt.js, pages/lrpt.css precached; rpt/export.js movements / payments / tx_followup defs + row filter + tones, rpt/xlsx.js tone fills, rpt/reports.js movements / payments tabs + trips groups, rpt/dashboards.js tx-count tiles, ops/alerts.js new kinds + technical errors, app-shell.js progress overlay / response badge / OTP gate / nav, admin.js #transactions?… → #register, login.html + auth.js e-mail code login (off by default), supa.js, i18n.js, i18n/login.js, i18n/ops.js); legacy step 7 browser-check fixes (bill.css phone width: grid items min-width 0 + wrapped refs; bill/billing.js job errors via the Daftra dictionary, step-7 job kinds + targets; bill/dft-settings.js dry run not «ready» when blocked; bill/dft-kit.js + bill/tx-bill.js Daftra state labels; bill/daftra.js last error in Arabic; i18n/dft.js, i18n/bill.js); legacy step 7 UI (bill/dft-kit.js MarsaOps.dftKit + bill/dft-settings.js #daftra products / fields / import / reviews + account guard / policy / org settings, i18n/dft.js precached; bill/daftra.js, bill/tx-bill.js Daftra link / refresh / opening / invoice link / reviews / purchase drafts, ops/tx-legacy.js supplier search + Daftra cancel codes, ops/tx-sections.js + decl-review.js opening note, i18n/bill.js, i18n/decl.js, pages/bill.css; admin.html + ocr.html scripts); legacy step 6 browser-check fixes (fin/payments.js ?tx= filter and fin/custody.js ?client= filter not sticky); legacy step 6 review fixes (fin/payments.js reuse confirmation not sticky / correction keeps invoice date + VAT + payment date / shared invoice VAT / FP claim rule / approved evidence locked / hidden-branch duplicates, fin/custody.js search keeps focus, fin/pay-ai.js one proof amount + no GIF, i18n/pay.js, supa.js + i18n.js new detail messages); legacy step 6 UI (fin/payments.js register + form + detail, fin/custody.js #custody + client balance, fin/draft.js MarsaDraft, fin/tx-fin.js payments section, i18n/pay.js, pages/pay.css precached; admin.html, admin.js nav + client sections, app-shell.js nav, supa.js listServiceItems); legacy step 6 backend (fin/pay-ai.js payment-document merge / fill-empty helper precached; supa.js payment register / custody wrappers + payment AI doc types, i18n.js MRS_PAY_* / MRS_CUSTODY_* / MRS_CONFIRM_INVOICE_REUSE messages); legacy step 5 review fixes (appt-cards.js cost kept / movement type / B/L + declaration hints / approve while reading / branch gate, ops/tx-return.js unreadable proof + kept form values, ops/tx-appt.js TASTO stage + readiness on top, ops/tx-legacy.js card + party columns, admin.js top sections, i18n/appt.js, pages/appt.css); legacy step 5 UI (appt-cards.js appointment cards on ocr.html, ops/tx-appt.js readiness banner + card draft + TASTO order and ops/tx-return.js empty-return proofs on #tx, i18n/appt.js, pages/appt.css precached; ocr.html, admin.html); legacy step 5 backend (supa.js appointment drafts / empty-return proofs / TASTO / readiness wrappers + AI doc types, i18n.js MRS_APPT_* / MRS_EMPTY_RETURN_* / MRS_TASTO_* messages); legacy step 4 review fixes (decl-review.js live plan / container preview / stale reload / picker close, ops/fasah-sheet.js, i18n/decl.js, pages/decl.css); legacy step 4 UI (decl-review.js declaration reading + review + approval on ocr.html, hs-picker.js, ops/tx-decl.js + ops/fasah-sheet.js on #tx, i18n/decl.js, pages/decl.css precached; ocr.html, admin.html, doc-batch.js, ops/tx-docs.js, ocr.js, ocr-parse.js, doc-match.js, supa.js, i18n.js, i18n/rpt.js, i18n/portal.js); legacy step 3 UI (doc-batch.js shipment batch + pending drafts on ocr.html, ops/tx-docs.js shipment data on #tx, i18n/docb.js precached; ocr.html, admin.html, ocr.css, ops.css); legacy step 2 UI (ops/tx-legacy.js + legacy-norm.js precached; admin.js tx form / stepper / cancel / movements, tx-sections.js Hijri + Fasah stages, portal.js / tracking.js «ملغاة», supa.js, i18n.js, i18n/portal.js, ops.css); invoice ↔ B/L ↔ customs declaration matching (doc-match.js engine, ocr-match.js, ocr.html section, i18n/ocr.js, ocr.css; supa.js saveDocumentMatch / reviewDocumentMatch / listDocumentMatches / voidDocumentMatch); AI review fixes (ocr.js / supa.js image limit 5 MB, i18n/ocr.js, i18n/admin.js consent covers inbox message text); AI reading with Claude (ocr.html, ocr.js, ocr-parse.js, i18n/ocr.js, supa.js aiAccess / aiExtract / aiGetSettings / aiSaveSettings, i18n.js err, admin.js + i18n/admin.js AI card); env-aware wording (main.js data-marsa-env, style.css [data-show-env], login/contact/request/portal/tracking/ocr/platform/help pages, i18n admin/bill/login/platform, guides); self-hosted Cairo font (assets/fonts/cairo/) + supabase-js 2.45.4 (assets/vendor/, SRI) instead of Google Fonts / jsDelivr; MFA: mfa.js, login / admin / platform gates, supa.js mfa*, app-shell.js mfa redirect + account security link, login.css; main.js reloads once when config.js did not load (PWA window opened from an e-mail link without Basic Auth); G7 review fixes (help.js skip link + phone scroll, platform.js paused / trial-ended badges, i18n/platform.js, platform.css); G7: plans / subscriptions / usage (platform.js, i18n/platform.js, platform.css, supa.js), help.html + help.js + i18n/help.js + help.css (guides network-first, not precached), app-shell.js help nav + admin.js help pill; G6b review fixes (msg/inbox.js, kit.js, contacts.js, tx-msg.js, i18n/msg.js, app-shell.js); G6b: unified inbox (msg/*.js, i18n/msg.js, msg.css); G6a review fixes (rpt/*.js, i18n/rpt.js); G6a: search / reports / dashboards (rpt/*.js, rpt.js, rpt.css, dash.css) + portal tabs; G4 fin/*, G5 bill/* kept
var CACHE = 'marsa-app-' + VERSION;
var OFFLINE_URL = 'offline.html';

// relative to the worker's location (= the site root)
var PRECACHE = [
  OFFLINE_URL,
  'login.html', 'admin.html', 'platform.html', 'portal.html', 'ocr.html', 'bulk-upload.html', 'help.html',
  'manifest.json',
  // styles: the original design system + shared components + page sheets
  'assets/css/style.css', 'assets/css/app.css',
  'assets/fonts/cairo/cairo.css', 'assets/fonts/cairo/cairo-arabic.woff2', 'assets/fonts/cairo/cairo-latin.woff2', 'assets/fonts/cairo/cairo-latin-ext.woff2',
  'assets/vendor/supabase-js-2.45.4/supabase.js',
  'assets/css/pages/login.css', 'assets/css/pages/admin.css', 'assets/css/pages/ops.css', 'assets/css/pages/fin.css', 'assets/css/pages/pay.css', 'assets/css/pages/bill.css',
  'assets/css/pages/rpt.css', 'assets/css/pages/dash.css', 'assets/css/pages/msg.css', 'assets/css/pages/lrpt.css', 'assets/css/pages/limp.css',
  'assets/css/pages/platform.css', 'assets/css/pages/help.css',
  'assets/css/pages/portal.css', 'assets/css/pages/ocr.css', 'assets/css/pages/bulk-upload.css', 'assets/css/pages/decl.css', 'assets/css/pages/appt.css',
  // scripts
  'assets/js/config.js', 'assets/js/i18n.js', 'assets/js/main.js', 'assets/js/supa.js',
  'assets/js/app-shell.js', 'assets/js/pwa.js', 'assets/js/auth.js', 'assets/js/mfa.js',
  'assets/js/admin.js', 'assets/js/platform.js', 'assets/js/portal.js', 'assets/js/help.js',
  'assets/js/ocr.js', 'assets/js/ocr-parse.js', 'assets/js/doc-match.js', 'assets/js/ocr-match.js', 'assets/js/doc-batch.js', 'assets/js/decl-review.js', 'assets/js/appt-cards.js', 'assets/js/hs-picker.js', 'assets/js/bulk-upload.js', 'assets/js/xlsx-lite.js',
  'assets/js/ops/alerts.js', 'assets/js/ops/schedule.js', 'assets/js/ops/parties.js',
  'assets/js/ops/exceptions.js', 'assets/js/ops/requirements.js', 'assets/js/ops/tx-sections.js', 'assets/js/ops/tx-legacy.js', 'assets/js/ops/tx-docs.js', 'assets/js/ops/tx-decl.js', 'assets/js/ops/tx-appt.js', 'assets/js/ops/tx-return.js', 'assets/js/ops/fasah-sheet.js',
  'assets/js/legacy-norm.js',
  'assets/js/fin/invoices.js', 'assets/js/fin/payables.js', 'assets/js/fin/margins.js',
  'assets/js/fin/demurrage.js', 'assets/js/fin/tx-fin.js', 'assets/js/fin/draft.js', 'assets/js/fin/payments.js', 'assets/js/fin/custody.js', 'assets/js/fin/pay-ai.js',
  'assets/js/bill/billing.js', 'assets/js/bill/dft-kit.js', 'assets/js/bill/dft-settings.js', 'assets/js/bill/daftra.js', 'assets/js/bill/tx-bill.js',
  'assets/js/rpt/xlsx.js', 'assets/js/rpt/export.js', 'assets/js/rpt/search.js', 'assets/js/rpt/reports.js', 'assets/js/rpt/dashboards.js',
  'assets/js/rpt/colfilter.js', 'assets/js/rpt/register.js', 'assets/js/rpt/fasah-recon.js', 'assets/js/rpt/audit-diff.js', 'assets/js/rpt/rules.js',
  'assets/js/imp/legacy-import.js',
  'assets/js/msg/kit.js', 'assets/js/msg/inbox.js', 'assets/js/msg/channels.js', 'assets/js/msg/contacts.js', 'assets/js/msg/templates.js',
  'assets/js/msg/tx-msg.js',
  // (supabase/functions/* — daftra-sync, inbox-sync — is server source: never precached, never served by the site)
  // dictionaries (a missing optional file never blocks the install)
  'assets/i18n/app.js', 'assets/i18n/login.js', 'assets/i18n/admin.js', 'assets/i18n/ops.js', 'assets/i18n/fin.js', 'assets/i18n/pay.js', 'assets/i18n/bill.js', 'assets/i18n/dft.js', 'assets/i18n/rpt.js', 'assets/i18n/lrpt.js', 'assets/i18n/limp.js', 'assets/i18n/msg.js',
  'assets/i18n/platform.js', 'assets/i18n/help.js',
  'assets/i18n/ocr.js', 'assets/i18n/docb.js', 'assets/i18n/decl.js', 'assets/i18n/appt.js', 'assets/i18n/bulk.js', 'assets/i18n/portal.js',
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
  if (/\/docs\/guide\/(?:ar|en)\/[a-z0-9-]+\.md$/i.test(url.pathname)) { event.respondWith(networkFirst(req)); return; }
  if (req.destination === 'image' || req.destination === 'font' ||
      /\.(?:png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf)$/i.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event));
  }
  // anything else: browser default
});
