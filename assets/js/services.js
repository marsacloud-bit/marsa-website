/* =====================================================================
   مرسى | MARSA — services.html
   Required-documents checklist: progress per tab, saved locally
   (per-device convenience only; nothing leaves the browser).
   ===================================================================== */
(function () {
  'use strict';

  var KEY = 'marsa_doc_checklist';
  var qsa = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function store(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable: keep in memory */ }
  }
  function toast(msg, type) {
    if (window.Marsa && typeof window.Marsa.toast === 'function') window.Marsa.toast(msg, type);
  }

  function init() {
    var lists = qsa('[data-docs-list]');
    if (!lists.length) return;
    var state = load();
    var completed = {};

    function update(key, announce) {
      var list = document.querySelector('[data-docs-list="' + key + '"]');
      if (!list) return;
      var boxes = qsa('input[type="checkbox"]', list);
      var done = boxes.filter(function (b) { return b.checked; }).length;
      var pct = boxes.length ? Math.round((done / boxes.length) * 100) : 0;

      var count = document.querySelector('[data-docs-count="' + key + '"]');
      if (count) count.textContent = done + '/' + boxes.length;
      var prog = document.querySelector('[data-docs-progress="' + key + '"]');
      if (prog) {
        prog.setAttribute('aria-valuenow', String(pct));
        var bar = prog.querySelector('.progress-bar');
        if (bar) bar.style.width = pct + '%';
      }

      var full = boxes.length > 0 && done === boxes.length;
      if (announce && full && !completed[key]) {
        toast(key === 'export' ? 'ملف مستندات التصدير مكتمل! يمكنك تقديم طلبك الآن.' : 'ملف مستندات الاستيراد مكتمل! يمكنك تقديم طلبك الآن.', 'success');
      }
      completed[key] = full;
    }

    lists.forEach(function (list) {
      var key = list.getAttribute('data-docs-list');
      qsa('input[data-doc]', list).forEach(function (box) {
        box.checked = !!state[box.getAttribute('data-doc')];
        box.addEventListener('change', function () {
          var id = box.getAttribute('data-doc');
          if (box.checked) state[id] = true; else delete state[id];
          store(state);
          update(key, true);
        });
      });
      update(key, false);
    });

    var reset = document.querySelector('[data-docs-reset]');
    if (reset) {
      reset.addEventListener('click', function () {
        state = {};
        store(state);
        qsa('input[data-doc]').forEach(function (b) { b.checked = false; });
        lists.forEach(function (l) { update(l.getAttribute('data-docs-list'), false); });
        toast('تم مسح اختيارات قائمة المستندات', 'info');
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
