/* ==========================================================================
   مرسى | MARSA — HS reference picker (legacy step 4)  →  window.MarsaHsPicker
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_DECL_AR.md §4 (search_hs_reference, 20261120000100).
   * A search box with the scored suggestions of the organization's HS reference library
     (learned only from APPROVED customs declarations). A suggestion only: picking writes
     nothing to the server; the caller decides what to do with the picked row
     (the declaration review copies the code into its local draft; the step-3 invoice item
     tables show the suggestions read-only — the supplier HS stays reference only).
   * MarsaHsPicker.panel({ api, orgId?, query?, onPick?(item), t?(key, vars) }) → { el, search(q), close() }
     MarsaHsPicker.pure: { queryOf(row), cleanQuery(q), digits(s), itemLine(item), sortItems(list) }
   * Strings: namespace 'decl' (assets/i18n/decl.js). Server data only via textContent. ES5, no library.
   ========================================================================== */
(function (root) {
  'use strict';

  var MIN_Q = 2, MAX_Q = 200, LIMIT = 10, DEBOUNCE_MS = 300;

  function digits(s) {
    return String(s == null ? '' : s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
  }
  // the text to search for a row: its description first (Arabic declaration text, then invoice text), else its HS code
  function queryOf(row) {
    row = row || {};
    var d = [row.description, row.description_ar, row.invoice_description].filter(function (x) { return x != null && String(x).trim(); })[0];
    if (d) return cleanQuery(d);
    return cleanQuery(row.hs_code || row.supplier_hs_code || '');
  }
  function cleanQuery(q) {
    var s = digits(q).replace(/\s+/g, ' ').trim();
    return s.length > MAX_Q ? s.slice(0, MAX_Q) : s;
  }
  // one line of facts under a suggestion (no label words: the caller adds them)
  function itemLine(it) {
    it = it || {};
    return [it.invoice_description, it.scientific_name, it.origin_country].filter(function (x) { return x != null && String(x).trim(); }).join(' · ');
  }
  // server order is score desc; kept stable here (score, usage, code) for a list merged from several calls
  function sortItems(list) {
    return (Array.isArray(list) ? list : []).slice().sort(function (a, b) {
      return (Number(b.score) || 0) - (Number(a.score) || 0) || (Number(b.usage_count) || 0) - (Number(a.usage_count) || 0)
        || String(a.hs_code || '').localeCompare(String(b.hs_code || ''));
    });
  }

  function defaultT(k, vars) {
    var I = root && root.MarsaI18n, key = 'decl.' + k;
    if (!I || typeof I.t !== 'function') return k;
    var s = I.t(key, vars);
    return s === key ? k : s;
  }
  function errText(api, e, t) {
    var A = api && (api.MarsaApi || api);
    if (api && typeof api.errText === 'function') { try { return api.errText(e); } catch (x) { /* below */ } }
    if (A && typeof A.errorMessage === 'function') { try { var m = A.errorMessage(e); if (m) return m; } catch (x) { /* below */ } }
    return (e && e.message) || t('err_generic');
  }

  function panel(o) {
    o = o || {};
    var t = typeof o.t === 'function' ? o.t : defaultT;
    var doc = (typeof document !== 'undefined' ? document : root.document);
    var A = o.api && (o.api.MarsaApi || o.api);
    function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    var box = el('div', 'hsp');
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', t('hs_title'));
    var head = el('div', 'hsp-head');
    head.appendChild(el('strong', 'hsp-title', t('hs_title')));
    var closeB = null;
    if (o.closable !== false) {
      closeB = el('button', 'btn btn-sm btn-ghost hsp-close', t('close'));
      closeB.type = 'button';
      head.appendChild(closeB);
    }
    box.appendChild(head);
    var row = el('div', 'hsp-search');
    var inp = el('input', 'form-control hsp-input');
    inp.type = 'search'; inp.maxLength = MAX_Q; inp.autocomplete = 'off';
    inp.setAttribute('aria-label', t('hs_search_aria'));
    inp.placeholder = t('hs_placeholder');
    var go = el('button', 'btn btn-sm btn-secondary', t('search'));
    go.type = 'button';
    row.appendChild(inp); row.appendChild(go);
    box.appendChild(row);
    var status = el('p', 'hsp-status text-sm text-muted');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    box.appendChild(status);
    var list = el('ul', 'hsp-list');
    box.appendChild(list);
    box.appendChild(el('p', 'form-hint hsp-hint', o.onPick ? t('hs_hint_pick') : t('hs_hint_ref')));

    var seq = 0, timer = null;
    function paint(items) {
      list.textContent = '';
      items.forEach(function (it) {
        var li = el('li', 'hsp-item');
        var main = el('div', 'hsp-item-main');
        var code = el('bdi', 'hsp-code num', it.hs_code || '');
        code.dir = 'ltr';
        main.appendChild(code);
        var d = el('bdi', 'hsp-desc', it.description_ar || it.invoice_description || '');
        d.dir = 'auto';
        main.appendChild(d);
        var line = itemLine(it);
        if (line) main.appendChild(el('span', 'hsp-sub', line));
        var facts = [t('hs_score', { n: Number(it.score) || 0 }), t('hs_usage', { n: Number(it.usage_count) || 0 })];
        if (it.last_declaration_no) facts.push(t('hs_last', { n: it.last_declaration_no }));
        if (it.last_importer) facts.push(it.last_importer);
        main.appendChild(el('span', 'hsp-sub', facts.join(' · ')));
        li.appendChild(main);
        if (typeof o.onPick === 'function') {
          var pb = el('button', 'btn btn-sm btn-secondary hsp-pick', t('hs_pick'));
          pb.type = 'button';
          pb.setAttribute('aria-label', t('hs_pick_aria', { code: it.hs_code || '' }));
          pb.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); o.onPick(it); });
          li.appendChild(pb);
        }
        list.appendChild(li);
      });
    }
    function search(q) {
      var s = cleanQuery(q == null ? inp.value : q);
      if (q != null) inp.value = s;
      var my = ++seq;
      if (s.length < MIN_Q) { list.textContent = ''; status.textContent = t('hs_min', { n: MIN_Q }); return Promise.resolve(null); }
      if (!A || typeof A.searchHsReference !== 'function') { status.textContent = t('err_unavailable'); return Promise.resolve(null); }
      status.textContent = t('loading');
      return Promise.resolve().then(function () { return A.searchHsReference(s, { orgId: o.orgId || undefined, limit: o.limit || LIMIT }); })
        .then(function (r) {
          if (my !== seq) return null;
          if (!r || r.error) { list.textContent = ''; status.textContent = errText(o.api, r && r.error, t); return null; }
          var items = sortItems(r.data && r.data.items);
          paint(items);
          status.textContent = items.length ? t('hs_count', { n: items.length }) : t('hs_none');
          return items;
        }, function (e) { if (my === seq) status.textContent = errText(o.api, e, t); return null; });
    }
    inp.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; search(); }, DEBOUNCE_MS);
    });
    inp.addEventListener('keydown', function (e) { if (e && e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); search(); } });
    go.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); search(); });
    function close() {
      if (timer) { clearTimeout(timer); timer = null; }
      seq++;
      if (box.parentNode) box.parentNode.removeChild(box);
      if (typeof o.onClose === 'function') o.onClose();
    }
    if (closeB) closeB.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); close(); });
    if (o.query) { inp.value = cleanQuery(o.query); }
    return { el: box, input: inp, search: search, close: close };
  }

  root.MarsaHsPicker = {
    VERSION: 'hsp-1', panel: panel, MIN_Q: MIN_Q, MAX_Q: MAX_Q,
    pure: { queryOf: queryOf, cleanQuery: cleanQuery, digits: digits, itemLine: itemLine, sortItems: sortItems }
  };
})(typeof window !== 'undefined' ? window : this);
