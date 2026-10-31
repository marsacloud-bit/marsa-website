/* =====================================================================
   مرسى | MARSA — shared behaviour (main.js)
   Load on every page:  <script src="assets/js/main.js" defer></script>
   then page script:    <script src="assets/js/<page>.js" defer></script>
   Each feature runs only if its elements exist. Works on file://.
   Public API: window.Marsa = { toast, genRef, saveLocal, readLocal, formatSAR, formatNum, qs, qsa, icon }
   ===================================================================== */
(function () {
  'use strict';
  document.documentElement.classList.remove('no-js');

  var qs = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var qsa = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- small icon set for JS-generated UI ---- */
  var ICONS = {
    info: '<path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/><path d="M12 16v-4M12 8h.01"/>',
    success: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m22 4-10 10-3-3"/>',
    error: '<path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/><path d="m15 9-6 6M9 9l6 6"/>',
    warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>'
  };
  function svgIcon(name) {
    return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || ICONS.info) + '</svg>';
  }

  /* ---- Toast ---- */
  function toast(msg, type) {
    type = type || 'info';
    var stack = qs('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      stack.setAttribute('aria-live', 'polite');
      stack.setAttribute('role', 'status');
      document.body.appendChild(stack);
    }
    var t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.innerHTML = svgIcon(type) + '<span></span>';
    t.querySelector('span').textContent = msg;
    stack.appendChild(t);
    setTimeout(function () {
      t.classList.add('is-leaving');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, 4200);
    return t;
  }

  /* ---- Reference number: MRS-2026-XXXXXX ---- */
  function genRef(prefix) {
    prefix = prefix || 'MRS';
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = '';
    var arr = null;
    if (window.crypto && window.crypto.getRandomValues) { arr = new Uint32Array(6); window.crypto.getRandomValues(arr); }
    for (var i = 0; i < 6; i++) {
      var r = arr ? arr[i] : Math.floor(Math.random() * 4294967296);
      out += chars.charAt(r % chars.length);
    }
    return prefix + '-' + new Date().getFullYear() + '-' + out;
  }

  /* ---- localStorage helpers (append to an array under key) ---- */
  function saveLocal(key, obj) {
    try {
      var list = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(list)) list = [];
      var entry = Object.assign({ savedAt: new Date().toISOString() }, obj);
      list.push(entry);
      localStorage.setItem(key, JSON.stringify(list));
      return true;
    } catch (e) { return false; }
  }
  function readLocal(key) {
    try { var v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }

  /* ---- Number formatting (Western digits, Saudi riyal SAR) ---- */
  function formatNum(n, digits) {
    var num = Number(n) || 0;
    return num.toLocaleString('en-US', { minimumFractionDigits: digits || 0, maximumFractionDigits: digits == null ? 2 : digits });
  }
  function formatSAR(n) { return formatNum(n, 2) + ' ر.س'; }

  window.Marsa = {
    toast: toast, genRef: genRef, saveLocal: saveLocal, readLocal: readLocal,
    formatSAR: formatSAR, formatNum: formatNum, qs: qs, qsa: qsa, icon: svgIcon
  };

  /* ---- Active nav link (by filename, or <body data-page="services">) ---- */
  function initActiveLink() {
    var page = document.body.getAttribute('data-page');
    var file = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    if (!file || file.indexOf('.html') === -1) file = 'index.html';
    if (page) file = page + '.html';
    qsa('.nav-link, .drawer-nav a').forEach(function (a) {
      var href = (a.getAttribute('href') || '').split('#')[0].split('?')[0].toLowerCase();
      if (href === file) { a.classList.add('is-active'); a.setAttribute('aria-current', 'page'); }
    });
  }

  /* ---- Mobile drawer ---- */
  function initDrawer() {
    var toggle = qs('.nav-toggle');
    var drawer = qs('#mobile-drawer');
    if (!toggle || !drawer) return;
    var backdrop = qs('.drawer-backdrop');
    var closeBtn = qs('.drawer-close', drawer);
    var lastFocus = null;

    function open() {
      lastFocus = document.activeElement;
      drawer.classList.add('is-open');
      if (backdrop) backdrop.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
      document.body.classList.add('drawer-open');
      var first = qs('a, button', drawer);
      if (first) setTimeout(function () { first.focus(); }, 60);
    }
    function close() {
      drawer.classList.remove('is-open');
      if (backdrop) backdrop.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      toggle.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('drawer-open');
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    toggle.addEventListener('click', function () { drawer.classList.contains('is-open') ? close() : open(); });
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (backdrop) backdrop.addEventListener('click', close);
    qsa('a', drawer).forEach(function (a) { a.addEventListener('click', close); });
    document.addEventListener('keydown', function (e) {
      if (!drawer.classList.contains('is-open')) return;
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'Tab') { // focus trap
        var f = qsa('a[href], button:not([disabled])', drawer);
        if (!f.length) return;
        var firstEl = f[0], lastEl = f[f.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
      }
    });
    window.addEventListener('resize', function () { if (window.innerWidth > 900 && drawer.classList.contains('is-open')) close(); });
  }

  /* ---- Header shadow + back-to-top ---- */
  function initScroll() {
    var header = qs('.site-header');
    var toTop = qs('.to-top');
    if (!header && !toTop) return;
    var ticking = false;
    function update() {
      var y = window.pageYOffset || document.documentElement.scrollTop;
      if (header) header.classList.toggle('is-scrolled', y > 10);
      if (toTop) toTop.classList.toggle('is-visible', y > 600);
      ticking = false;
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
    if (toTop) toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }); });
  }

  /* ---- Counters: <span data-count="1250" data-suffix="+" data-decimals="0"> ---- */
  function animateCounter(el) {
    var target = parseFloat(el.getAttribute('data-count')) || 0;
    var dec = parseInt(el.getAttribute('data-decimals') || '0', 10);
    var prefix = el.getAttribute('data-prefix') || '';
    var suffix = el.getAttribute('data-suffix') || '';
    if (reduceMotion) { el.textContent = prefix + formatNum(target, dec) + suffix; return; }
    var dur = 1600, start = null;
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = prefix + formatNum(target * eased, dec) + suffix;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ---- Reveal on scroll + counters + progress bars (data-width="72") ---- */
  function initObservers() {
    var reveals = qsa('.reveal');
    var counters = qsa('[data-count]');
    var bars = qsa('.progress-bar[data-width]');
    var fill = function (b) { b.style.width = (parseFloat(b.getAttribute('data-width')) || 0) + '%'; };
    if (!('IntersectionObserver' in window)) {
      reveals.forEach(function (el) { el.classList.add('is-visible'); });
      counters.forEach(animateCounter);
      bars.forEach(fill);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var el = en.target;
        if (el.classList.contains('reveal')) el.classList.add('is-visible');
        if (el.hasAttribute('data-count') && !el.dataset.counted) { el.dataset.counted = '1'; animateCounter(el); }
        if (el.classList.contains('progress-bar')) fill(el);
        io.unobserve(el);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    reveals.concat(counters, bars).forEach(function (el) { io.observe(el); });
  }

  /* ---- Accordion (.acc-trigger[aria-controls]) ; .accordion[data-single] closes siblings ---- */
  function initAccordion() {
    qsa('.acc-trigger').forEach(function (btn) {
      var panel = document.getElementById(btn.getAttribute('aria-controls'));
      if (!panel) return;
      var item = btn.closest('.acc-item');
      if (btn.getAttribute('aria-expanded') === 'true') { panel.hidden = false; if (item) item.classList.add('is-open'); }
      btn.addEventListener('click', function () {
        var expanded = btn.getAttribute('aria-expanded') === 'true';
        var acc = btn.closest('.accordion');
        if (!expanded && acc && acc.hasAttribute('data-single')) {
          qsa('.acc-trigger[aria-expanded="true"]', acc).forEach(function (other) {
            other.setAttribute('aria-expanded', 'false');
            var p = document.getElementById(other.getAttribute('aria-controls'));
            if (p) p.hidden = true;
            var it = other.closest('.acc-item'); if (it) it.classList.remove('is-open');
          });
        }
        btn.setAttribute('aria-expanded', String(!expanded));
        panel.hidden = expanded;
        if (item) item.classList.toggle('is-open', !expanded);
      });
    });
  }

  /* ---- Tabs ([data-tabs] container, role=tab buttons with aria-controls) ---- */
  function initTabs() {
    qsa('[data-tabs]').forEach(function (wrap) {
      var tabs = qsa('[role="tab"]', wrap);
      function select(tab, focus) {
        tabs.forEach(function (t) {
          var on = t === tab;
          t.setAttribute('aria-selected', String(on));
          t.setAttribute('tabindex', on ? '0' : '-1');
          var p = document.getElementById(t.getAttribute('aria-controls'));
          if (p) p.hidden = !on;
        });
        if (focus) tab.focus();
      }
      tabs.forEach(function (t, i) {
        t.addEventListener('click', function () { select(t); });
        t.addEventListener('keydown', function (e) {
          // RTL: ArrowLeft = next, ArrowRight = previous
          var idx = null;
          if (e.key === 'ArrowLeft') idx = (i + 1) % tabs.length;
          if (e.key === 'ArrowRight') idx = (i - 1 + tabs.length) % tabs.length;
          if (e.key === 'Home') idx = 0;
          if (e.key === 'End') idx = tabs.length - 1;
          if (idx !== null) { e.preventDefault(); select(tabs[idx], true); }
        });
      });
      var current = tabs.filter(function (t) { return t.getAttribute('aria-selected') === 'true'; })[0] || tabs[0];
      if (current) select(current);
    });
  }

  /* ---- Quick track forms: <form data-track-form> with input[name="id"] → tracking.html?id= ---- */
  function initQuickTrack() {
    qsa('form[data-track-form]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = qs('input[name="id"]', form);
        var val = input ? input.value.trim().toUpperCase() : '';
        if (!val || val.length < 4) {
          if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
          toast('من فضلك أدخل رقم شحنة أو رقم مرجعي صحيح', 'warning');
          return;
        }
        if (input) input.removeAttribute('aria-invalid');
        window.location.href = 'tracking.html?id=' + encodeURIComponent(val);
      });
    });
  }

  /* ---- Site-wide demo banner: [data-demo-banner]; dismissed for this session only ---- */
  var BANNER_KEY = 'marsa_demo_banner_dismissed';
  function initDemoBanner() {
    var banner = qs('[data-demo-banner]');
    if (!banner) return;
    var dismissed = false;
    try { dismissed = window.sessionStorage.getItem(BANNER_KEY) === '1'; } catch (e) { dismissed = false; }
    if (dismissed) banner.classList.add('is-dismissed');
    var btn = qs('[data-demo-banner-close]', banner);
    if (btn) btn.addEventListener('click', function () {
      banner.classList.add('is-dismissed');
      try { window.sessionStorage.setItem(BANNER_KEY, '1'); } catch (e) { /* storage unavailable: hide for this page view only */ }
    });
  }

  /* ---- Footer "clear my data": removes every localStorage key that starts with "marsa_" ---- */
  function initClearData() {
    qsa('[data-clear-local]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!window.confirm('سيتم حذف كل ما حفظه موقع مرسى في هذا المتصفح (الطلبات والحسابات والرسائل والمسودات). لا يمكن التراجع عن ذلك. هل تريد المتابعة؟')) return;
        var removed = 0;
        try {
          var keys = [];
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf('marsa_') === 0) keys.push(k);
          }
          keys.forEach(function (k) { localStorage.removeItem(k); removed++; });
        } catch (e) {
          toast('تعذّر الوصول إلى التخزين المحلي في هذا المتصفح، فلم يُحذف شيء.', 'error');
          return;
        }
        toast(removed ? 'تم مسح بياناتك المحفوظة من هذا الجهاز. أعد تحميل الصفحة لتحديث ما يظهر فيها.' : 'لا توجد بيانات محفوظة لموقع مرسى على هذا الجهاز.', removed ? 'success' : 'info');
      });
    });
  }

  /* ---- Footer year ---- */
  function initYear() {
    qsa('[data-year], #year').forEach(function (el) { el.textContent = new Date().getFullYear(); });
  }

  function init() {
    initActiveLink();
    initDrawer();
    initScroll();
    initObservers();
    initAccordion();
    initTabs();
    initQuickTrack();
    initDemoBanner();
    initClearData();
    initYear();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
