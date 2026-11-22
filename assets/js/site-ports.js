/* =====================================================================
   Office website — «المنافذ التي نعمل فيها» from the office's own choice (owner 2026-11-22, 20261210000100)
   index.html: <section id="ports" hidden> … <ul data-site-ports> (static example list inside).
   Online: MarsaApi.siteServedPorts() → only the ports the office chose (staff settings «الموانئ التي نخدمها»);
           none chosen → the section stays hidden.
   Demo (no config.js / no database): the static example list is shown.
   Port names are data: set with textContent only. Icons are fixed markup by kind.
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
  function render() {
    var list = document.querySelector('[data-site-ports]');
    if (!list || !Array.isArray(ports)) return;
    var section = list.closest('section');
    list.textContent = '';
    ports.forEach(function (p) { if (p && p.code) list.appendChild(item(p)); });
    if (section) section.hidden = list.children.length === 0;
  }
  function showStatic() {
    var list = document.querySelector('[data-site-ports]');
    var section = list && list.closest('section');
    if (section) section.hidden = false;
  }
  function init() {
    if (!document.querySelector('[data-site-ports]')) return;
    if (!API || typeof API.isOnline !== 'function' || !API.isOnline() || typeof API.siteServedPorts !== 'function') { showStatic(); return; }
    API.siteServedPorts().then(function (r) {
      // database without 20261210000100 yet (the function is unknown): the example list, as before the feature
      var e = r && r.error, raw = (e && e.raw) || {};
      if (e && /PGRST202|site_served_ports|does not exist/.test([e.code, e.message, raw.code, raw.message].join(' '))) { showStatic(); return; }
      if (!r || r.error || !Array.isArray(r.data)) return;   // other errors: keep the section hidden (never show ports the office did not choose)
      ports = r.data;
      render();
    }, function () { /* network error: section stays hidden */ });
    window.addEventListener('marsa:langchange', render);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
