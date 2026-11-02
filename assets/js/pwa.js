/* ==========================================================================
   مرساة كلاود | Marsa Cloud — pwa.js (STAGING)
   Contract: docs/online/APP_UI_SPEC.md §PWA. Load (defer) after app-shell.js on app
   pages and after supa.js on login.html / offline.html; works without either.

   * Registers ./sw.js with scope './' (http(s) secure contexts only; file:// and
     old browsers simply skip it).
   * Install: 'beforeinstallprompt' is kept and an «تثبيت التطبيق» button is placed
     in every [data-pwa-install] slot (topbar of the shell, header of login.html).
     iOS Safari has no prompt → the same button shows the "Share → Add to Home
     Screen" hint as a toast. Nothing is shown when already running standalone
     (html.is-standalone is set for CSS).
   * Update: when a new worker is waiting (and this page is already controlled),
     MarsaShell.toast (or Marsa.toast) announces it and the slot gets an «تحديث»
     button; reloading posts {type:'SKIP_WAITING'} and the page reloads once on
     'controllerchange'.
   * window.MarsaPwa = { install(), applyUpdate(), isStandalone(), registration(), render() }.
   Strings: namespace 'pwa' (ar + en) registered here; DOM built with createElement.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n || null;
  var STR = {
    ar: {
      install: 'تثبيت التطبيق',
      installAria: 'تثبيت مرساة كلاود على هذا الجهاز',
      iosHint: 'لتثبيت التطبيق على iPhone أو iPad: اضغط زر «مشاركة» في Safari ثم اختر «إضافة إلى الشاشة الرئيسية».',
      installed: 'تم تثبيت التطبيق.',
      update: 'تحديث',
      updateAria: 'تحميل الإصدار الجديد من التطبيق',
      updateReady: 'يتوفر إصدار جديد من التطبيق.',
      reload: 'إعادة التحميل'
    },
    en: {
      install: 'Install app',
      installAria: 'Install Marsa Cloud on this device',
      iosHint: 'To install on iPhone or iPad: tap “Share” in Safari, then “Add to Home Screen”.',
      installed: 'The app has been installed.',
      update: 'Update',
      updateAria: 'Load the new version of the app',
      updateReady: 'A new version of the app is available.',
      reload: 'Reload'
    }
  };
  if (I && typeof I.register === 'function') I.register('pwa', STR);
  function t(k) {
    if (I && typeof I.t === 'function') { var s = I.t('pwa.' + k); if (s && s !== 'pwa.' + k) return s; }
    return STR.ar[k] || k;
  }

  var deferredPrompt = null;   // BeforeInstallPromptEvent
  var reg = null;
  var updateReady = false;
  var reloading = false;
  var ua = navigator.userAgent || '';
  var isIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isSafari = /safari/i.test(ua) && !/crios|fxios|edgios|chrome|android/i.test(ua);

  function isStandalone() {
    return !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true);
  }
  function syncStandalone() { document.documentElement.classList.toggle('is-standalone', isStandalone()); }
  syncStandalone();

  function toast(text, tone, opts) {
    var S = window.MarsaShell, M = window.Marsa;
    if (S && typeof S.toast === 'function') return S.toast(text, tone || 'info', opts);
    if (M && typeof M.toast === 'function') return M.toast(text, tone || 'info');
  }

  /* ---- slot rendering ---- */
  var ICON_INSTALL = 'M12 3v12M7 10l5 5 5-5M5 21h14';
  var ICON_UPDATE = 'M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5';
  function svg(d) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('class', 'icon'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.appendChild(p);
    return s;
  }
  function button(kind) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm btn-ghost pwa-btn pwa-' + kind;
    b.setAttribute('data-pwa-action', kind);
    b.appendChild(svg(kind === 'update' ? ICON_UPDATE : ICON_INSTALL));
    var sp = document.createElement('span'); sp.className = 'pwa-btn-label'; b.appendChild(sp);
    b.addEventListener('click', kind === 'update' ? applyUpdate : install);
    return b;
  }
  function label(b, kind) {
    b.querySelector('.pwa-btn-label').textContent = t(kind);
    b.setAttribute('aria-label', t(kind + 'Aria'));
    b.title = t(kind + 'Aria');
  }
  function render() {
    syncStandalone();
    var showInstall = !isStandalone() && (!!deferredPrompt || (isIos && isSafari));
    Array.prototype.forEach.call(document.querySelectorAll('[data-pwa-install]'), function (slot) {
      ['update', 'install'].forEach(function (kind) {
        var want = kind === 'update' ? updateReady : showInstall;
        var b = slot.querySelector('[data-pwa-action="' + kind + '"]');
        if (want && !b) { b = button(kind); slot.appendChild(b); }
        if (b) { b.hidden = !want; if (want) label(b, kind); }
      });
      slot.hidden = !(updateReady || showInstall);
    });
  }

  /* ---- install ---- */
  function install() {
    if (deferredPrompt) {
      var p = deferredPrompt;
      deferredPrompt = null;
      render();
      try {
        p.prompt();
        return Promise.resolve(p.userChoice).then(null, function () {}).then(function () { render(); });
      } catch (e) { return Promise.resolve(); }
    }
    if (isIos) toast(t('iosHint'), 'info');
    return Promise.resolve();
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    render();
  });
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    render();
    toast(t('installed'), 'success');
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(display-mode: standalone)');
    if (mq.addEventListener) mq.addEventListener('change', render);
  }

  /* ---- update ---- */
  function applyUpdate() {
    var w = reg && reg.waiting;
    if (!w) { location.reload(); return; }
    reloading = true;
    w.postMessage({ type: 'SKIP_WAITING' });
  }
  function onUpdateReady() {
    if (updateReady) return;
    updateReady = true;
    render();
    toast(t('updateReady'), 'info', { action: { label: t('reload'), onClick: applyUpdate }, duration: 0, sticky: true });
  }
  function track(r) {
    reg = r;
    if (r.waiting && navigator.serviceWorker.controller) onUpdateReady();
    r.addEventListener('updatefound', function () {
      var w = r.installing;
      if (!w) return;
      w.addEventListener('statechange', function () {
        // 'installed' with an existing controller = an update (first install has none)
        if (w.state === 'installed' && navigator.serviceWorker.controller) onUpdateReady();
      });
    });
  }

  function register() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (r) {
      track(r);
      // look for a new version when the app comes back to the foreground (at most hourly)
      var last = Date.now();
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && Date.now() - last > 3600000) {
          last = Date.now();
          r.update().then(null, function () {});
        }
      });
    }, function () { /* registration failed (e.g. 401 behind Basic Auth): the site works without it */ });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!reloading) return;
      reloading = false;
      location.reload();
    });
  }

  window.addEventListener('marsa:langchange', render);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
  function onLoad() { render(); register(); }   // render again: the shell may build its topbar late
  if (document.readyState === 'complete') onLoad(); else window.addEventListener('load', onLoad);

  window.MarsaPwa = {
    install: install,
    applyUpdate: applyUpdate,
    isStandalone: isStandalone,
    registration: function () { return reg; },
    render: render   // the shell may call this after it (re)builds a [data-pwa-install] slot
  };
})();
