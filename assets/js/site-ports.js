/* =====================================================================
   Office website — «المنافذ التي نعمل فيها» from the office's own choice (owner 2026-11-22, 20261210000100)
   office.html: <section id="ports" hidden> … <ul data-site-ports> (static example list inside).
   Online: MarsaApi.siteServedPorts() → only the ports the office chose (staff settings «الموانئ التي نخدمها»);
           none chosen → the section stays hidden.
   Demo (no config.js / no database): the static example list is shown.
   Port names are data: set with textContent only. Icons are fixed markup by kind.
   Every [data-site-ports] list on the page is filled (about.html: an empty list next to the example map, owner 2026-11-28):
     [data-site-ports-count]  the number of ports the office chose ([data-site-ports-unit]: its Arabic/English unit word)
     [data-site-ports-box]    the wrapper of that count: hidden when the office chose none
     [data-site-ports-static] example content (map pins, port buttons): hidden while online data is shown
   Online: the examples are hidden right away (never shown as the office's ports); demo / database without the
   function: the examples stay as they are.
   ===================================================================== */
(function () {
  'use strict';
  var I18N = window.MarsaI18n || null;
  var API = window.MarsaApi || null;
  var ICON = {
    sea: '<circle cx="12" cy="5" r="2.5"/><path d="M12 7.5V21M5 12H3a9 9 0 0 0 18 0h-2M8 11h8"/>',
    air: '<path d="M10.5 13.5L3 11l1.5-1.5 8 1 4-4.5a2 2 0 0 1 3 3L15 13l1 8-1.5 1.5-2.5-7.5L9 18v3l-1.5 1L6 18l-4-1.5L3 15h3z"/>',
    dry: '<path d="M2 6h11v10H2zM13 9h4l4 4v3h-8z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    land: '<path d="M2 6h11v10H2zM13 9h4l4 4v3h-8z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>'
  };
  var ports = null;   // null: not loaded / demo

  function lang() { return I18N && I18N.lang() === 'en' ? 'en' : 'ar'; }
  function item(p) {
    var li = document.createElement('li');
    var ico = document.createElement('span');
    ico.className = 'hm-ico';
    ico.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + (ICON[p.kind] || ICON.sea) + '</svg>';   // constant markup
    var name = document.createElement('span');
    name.textContent = lang() === 'en' ? (p.name_en || p.name_ar || '') : (p.name_ar || '');
    li.appendChild(ico);
    li.appendChild(name);
    return li;
  }
  function lists() { return Array.prototype.slice.call(document.querySelectorAll('[data-site-ports]')); }
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  // hidden works on HTML elements only; SVG groups (map pins) are hidden with display
  function show(el, on) {
    if (el instanceof HTMLElement) el.hidden = !on;
    else if (el.style) el.style.display = on ? '' : 'none';
  }
  function unit(n) {
    if (lang() === 'en') return n === 1 ? 'port' : 'ports';
    return n >= 3 && n <= 10 ? 'منافذ' : 'منفذ';
  }
  function setCount(n) {
    each('[data-site-ports-count]', function (el) { el.textContent = String(n); });
    each('[data-site-ports-unit]', function (el) { el.textContent = unit(n); });
    each('[data-site-ports-box]', function (el) { el.hidden = n === 0; });
  }
  function render() {
    if (!Array.isArray(ports)) return;
    var shown = ports.filter(function (p) { return p && p.code; });
    lists().forEach(function (list) {
      var section = list.closest('section');
      list.textContent = '';
      shown.forEach(function (p) { list.appendChild(item(p)); });
      list.hidden = list.children.length === 0;
      if (section) section.hidden = list.children.length === 0;
    });
    each('[data-site-ports-static]', function (el) { show(el, false); });
    setCount(shown.length);
  }
  // online: before the answer, show neither the examples nor their count
  function hideExamples() {
    each('[data-site-ports-static]', function (el) { show(el, false); });
    each('[data-site-ports-box]', function (el) { el.hidden = true; });
  }
  // the ports could not be loaded: hide every ports area (never show ports the office did not choose)
  function hideAll() {
    lists().forEach(function (list) { var section = list.closest('section'); if (section) section.hidden = true; });
    each('[data-site-ports-box]', function (el) { el.hidden = true; });
  }
  function showStatic() {
    lists().forEach(function (list) {
      var section = list.closest('section');
      if (section) section.hidden = false;
    });
    each('[data-site-ports-static]', function (el) { show(el, true); });
    each('[data-site-ports-box]', function (el) { el.hidden = false; });
  }
  function init() {
    if (!document.querySelector('[data-site-ports]')) return;
    if (!API || typeof API.isOnline !== 'function' || !API.isOnline() || typeof API.siteServedPorts !== 'function') { showStatic(); return; }
    hideExamples();
    API.siteServedPorts().then(function (r) {
      // database without 20261210000100 yet (the function is unknown): the example list, as before the feature
      var e = r && r.error, raw = (e && e.raw) || {};
      if (e && /PGRST202|site_served_ports|does not exist/.test([e.code, e.message, raw.code, raw.message].join(' '))) { showStatic(); return; }
      if (!r || r.error || !Array.isArray(r.data)) { hideAll(); return; }   // other errors: keep the ports hidden
      ports = r.data;
      render();
    }, function () { hideAll(); /* network error: ports stay hidden */ });
    window.addEventListener('marsa:langchange', render);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
