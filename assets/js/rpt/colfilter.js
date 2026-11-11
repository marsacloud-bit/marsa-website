/* ==========================================================================
   مرسى | MARSA — legacy step 8: Excel-style column filter (window.MarsaColFilter)
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_REPORTS_AR.md (owner decision 2026-11-11 (9): the value lists are built in the
   browser from the loaded rows; the server keeps the main filters). Legacy: Index.html TRANSACTION_EXCEL_COLUMNS,
   renderTransactionsR12120 (value lists with search, a year / month / day tree for dates, clear).

     var cf = MarsaColFilter.create({ columns, onChange(cf), t(key, vars) → text, id })
       columns: [{ key, label, type: 'text'|'code'|'int'|'money'|'number'|'date'|'datetime', value(row) → raw,
                   display(raw, row) → text (optional), filter: false (no button) }]
     cf.setRows(rows)            the loaded rows (value lists come from them)
     cf.apply(rows) → rows       the rows every active column filter keeps
     cf.button(col) → <button>   the header button (aria-haspopup="dialog", aria-expanded, aria-pressed when active)
     cf.open(key) / cf.close()   the popover (role="dialog", search box, «تحديد الكل», list or date tree, apply / clear)
     cf.active() → n · cf.activeKeys() · cf.clear(key) · cf.clearAll() · cf.describe() → [[label, text]]
     cf.state() / cf.setState(s) (s = {key: [selected value keys]})
   Pure helpers (tests): keyOf(col, row), valuesOf(col, rows), dateTree(keys), dayOf(v), norm(s).

   Accessibility: the popover is a labelled dialog; Escape closes it and returns the focus to its button; Enter in
   the search box applies; every value is a real checkbox with its label and count; the date tree uses nested
   lists of checkboxes (a partly selected year / month is .indeterminate and aria-checked="mixed"). At phone width
   the popover is a bottom sheet (rpt/lrpt.css). Values are text nodes only (textContent / createElement).
   ========================================================================== */
(function () {
  'use strict';

  var EMPTY = '\u0000';            // the key of an empty cell («(فارغ)»)
  var MAX_LIST = 400;              // values drawn at once in a list (the search narrows the rest)
  var RIYADH_MS = 3 * 3600 * 1000;
  var DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var DATE_TYPES = { date: 1, datetime: 1 };
  var NUM_TYPES = { int: 1, money: 1, number: 1 };
  var FALLBACK = {
    ar: { cf_open: 'تصفية العمود «{c}»', cf_open_active: 'تصفية العمود «{c}» (مفعّلة)', cf_title: 'تصفية: {c}', cf_search: 'بحث في القيم',
      cf_all: 'تحديد الكل', cf_empty: '(فارغ)', cf_apply: 'تطبيق', cf_clear: 'مسح', cf_cancel: 'إلغاء', cf_none_found: 'لا توجد قيم مطابقة.',
      cf_more: 'تظهر أول {n} قيمة؛ استخدم البحث لتضييق القائمة.', cf_count: '{n}', cf_selected: 'محدد {n} من {t}', cf_list_label: 'قيم العمود',
      cf_year: 'سنة {y}', cf_month: 'شهر {m}', cf_toggle: 'إظهار / إخفاء', cf_sep: '، ' },
    en: { cf_open: 'Filter the «{c}» column', cf_open_active: 'Filter the «{c}» column (active)', cf_title: 'Filter: {c}', cf_search: 'Search values',
      cf_all: 'Select all', cf_empty: '(empty)', cf_apply: 'Apply', cf_clear: 'Clear', cf_cancel: 'Cancel', cf_none_found: 'No matching values.',
      cf_more: 'The first {n} values are shown; use the search to narrow the list.', cf_count: '{n}', cf_selected: '{n} of {t} selected', cf_list_label: 'Column values',
      cf_year: 'Year {y}', cf_month: 'Month {m}', cf_toggle: 'Show / hide', cf_sep: ', ' }
  };

  function lang() { var I = window.MarsaI18n; return I && typeof I.lang === 'function' ? I.lang() : 'ar'; }
  function interp(s, vars) { return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : String(s); }
  function defaultT(k, vars) {
    var I = window.MarsaI18n, key = 'lrpt.' + k;
    if (I && typeof I.t === 'function') { var s = I.t(key, vars); if (s != null && s !== key) return s; }
    var d = (FALLBACK[lang()] || {})[k]; if (d == null) d = FALLBACK.ar[k];
    return interp(d == null ? k : d, vars);
  }

  /* ------------------------------------------------------------------ pure helpers */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // a date-only value stays as it is (never shifted); a timestamp becomes its Asia/Riyadh day
  function dayOf(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'string' && DAY_RE.test(v)) return v;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?$/.test(v)) return v.slice(0, 10);
    var d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return '';
    var r = new Date(d.getTime() + RIYADH_MS);
    return r.getUTCFullYear() + '-' + pad(r.getUTCMonth() + 1) + '-' + pad(r.getUTCDate());
  }
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[ً-ٰٟ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 1632); })
      .replace(/\s+/g, ' ').trim();
  }
  function rawOf(col, row) { try { return col.value ? col.value(row) : row ? row[col.key] : null; } catch (e) { return null; } }
  // the comparison key of a cell: dates → their (Riyadh) day, numbers → their text, codes / text → trimmed text
  function keyOf(col, row) {
    var v = rawOf(col, row);
    if (v == null || v === '') return EMPTY;
    if (DATE_TYPES[col.type]) { var d = dayOf(v); return d || EMPTY; }
    if (NUM_TYPES[col.type]) { var n = +v; return isFinite(n) ? String(n) : String(v).trim() || EMPTY; }
    var s = String(v).trim();
    return s === '' ? EMPTY : s;
  }
  function displayOf(col, key, row) {
    if (key === EMPTY) return null;
    if (col.display) { try { var s = col.display(key, row); if (s != null && s !== '') return String(s); } catch (e) { /* the key */ } }
    return key;
  }
  // distinct values with counts, sorted (numbers numerically, dates newest first, text by its label), empty last
  function valuesOf(col, rows) {
    var map = Object.create(null), list = [];   // cell text as keys: no prototype ('__proto__' / 'constructor' are values too)
    (rows || []).forEach(function (r) {
      var k = keyOf(col, r);
      if (!map[k]) { map[k] = { key: k, n: 0, label: displayOf(col, k, r) }; list.push(map[k]); }
      map[k].n++;
    });
    list.sort(function (a, b) {
      if (a.key === EMPTY) return 1;
      if (b.key === EMPTY) return -1;
      if (NUM_TYPES[col.type]) return (+a.key) - (+b.key);
      if (DATE_TYPES[col.type]) return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
      var x = norm(a.label), y = norm(b.label);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return list;
  }
  // [{key: 'YYYY-MM-DD', n}] → [{y, n, months: [{m: 'YYYY-MM', n, days: [{d: 'YYYY-MM-DD', n}]}]}] (newest first)
  function dateTree(vals) {
    var years = {}, out = [];
    (vals || []).forEach(function (v) {
      var key = typeof v === 'string' ? v : v.key, n = typeof v === 'string' ? 1 : (v.n || 0);
      if (!DAY_RE.test(key)) return;
      var y = key.slice(0, 4), m = key.slice(0, 7);
      if (!years[y]) { years[y] = { y: y, n: 0, months: [], _m: {} }; out.push(years[y]); }
      var Y = years[y];
      Y.n += n;
      if (!Y._m[m]) { Y._m[m] = { m: m, n: 0, days: [] }; Y.months.push(Y._m[m]); }
      Y._m[m].n += n;
      Y._m[m].days.push({ d: key, n: n });
    });
    out.sort(function (a, b) { return a.y < b.y ? 1 : -1; });
    out.forEach(function (Y) {
      delete Y._m;
      Y.months.sort(function (a, b) { return a.m < b.m ? 1 : -1; });
      Y.months.forEach(function (M) { M.days.sort(function (a, b) { return a.d < b.d ? 1 : -1; }); });
    });
    return out;
  }

  /* ------------------------------------------------------------------ DOM */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = String(v); else n.setAttribute(k, v === true ? '' : String(v));
    });
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    });
    return n;
  }
  var SEQ = 0;
  var OPEN = null;   // the one open popover of the page

  function create(o) {
    o = o || {};
    var t = typeof o.t === 'function' ? o.t : defaultT;
    var cols = (o.columns || []).filter(function (c) { return c && c.key && c.filter !== false; });
    var byKey = {}; cols.forEach(function (c) { byKey[c.key] = c; });
    var uid = (o.id || 'cf') + '-' + (++SEQ);
    var rows = [];
    var sel = {};          // key → {valueKey: 1} (absent = no filter on that column)
    var buttons = {};
    var pop = null;

    function isActive(k) { return !!sel[k]; }
    function active() { return Object.keys(sel).length; }
    function activeKeys() { return Object.keys(sel); }
    function apply(list) {
      var keys = activeKeys();
      if (!keys.length) return (list || []).slice();
      return (list || []).filter(function (r) {
        for (var i = 0; i < keys.length; i++) { var c = byKey[keys[i]]; if (c && !sel[keys[i]][keyOf(c, r)]) return false; }
        return true;
      });
    }
    function paintButtons() {
      Object.keys(buttons).forEach(function (k) {
        var b = buttons[k], c = byKey[k], on = isActive(k);
        b.setAttribute('aria-pressed', String(on));
        b.setAttribute('aria-label', t(on ? 'cf_open_active' : 'cf_open', { c: c.label }));
        b.title = b.getAttribute('aria-label');
        b.className = 'cf-btn' + (on ? ' is-active' : '');
      });
    }
    function changed() { paintButtons(); if (typeof o.onChange === 'function') o.onChange(api); }
    function setSel(k, keys, all) {
      if (all || keys == null) delete sel[k];
      else { var m = Object.create(null); keys.forEach(function (x) { m[x] = 1; }); sel[k] = m; }
    }
    function button(c) {
      c = typeof c === 'string' ? byKey[c] : byKey[c && c.key];
      if (!c) return null;
      var b = el('button', { type: 'button', class: 'cf-btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-pressed': 'false', 'data-cf-key': c.key },
        [el('span', { class: 'cf-icon', 'aria-hidden': 'true', text: '▾' })]);
      b.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); if (e && e.stopPropagation) e.stopPropagation(); if (pop && pop.key === c.key) close(); else open(c.key); });
      buttons[c.key] = b;
      paintButtons();
      return b;
    }
    function close(noFocus) {
      if (!pop) return;
      var p = pop; pop = null;
      if (OPEN === p) OPEN = null;
      if (p.node.parentNode) p.node.parentNode.removeChild(p.node);
      if (typeof document.removeEventListener === 'function') {
        document.removeEventListener('keydown', p.onKey, true); document.removeEventListener('mousedown', p.onDown, true); document.removeEventListener('focusin', p.onFocus, true);
      }
      var b = buttons[p.key];
      if (b) { b.setAttribute('aria-expanded', 'false'); if (!noFocus && typeof b.focus === 'function') b.focus(); }
    }
    function open(k) {
      var c = byKey[k];
      if (!c) return null;
      if (OPEN && OPEN.close) OPEN.close(true);
      close(true);
      var vals = valuesOf(c, rows), cur = sel[k] || null, isDate = !!DATE_TYPES[c.type];
      var checked = Object.create(null); vals.forEach(function (v) { checked[v.key] = !cur || !!cur[v.key]; });
      var titleId = uid + '-t-' + k.replace(/[^a-z0-9_]/gi, '');
      var search = el('input', { type: 'search', class: 'form-control is-sm cf-search', 'aria-label': t('cf_search'), placeholder: t('cf_search'), autocomplete: 'off', maxlength: 80 });
      var all = el('input', { type: 'checkbox', class: 'cf-all-box' });
      var allRow = el('label', { class: 'cf-row cf-all' }, [all, el('span', { text: t('cf_all') })]);
      var listBox = el('div', { class: 'cf-list', role: 'group', 'aria-label': t('cf_list_label') });
      var count = el('p', { class: 'cf-status text-xs text-muted', role: 'status', 'aria-live': 'polite' });
      var applyB = el('button', { type: 'button', class: 'btn btn-sm btn-primary cf-apply', text: t('cf_apply') });
      var clearB = el('button', { type: 'button', class: 'btn btn-sm btn-ghost cf-clear', text: t('cf_clear') });
      var cancelB = el('button', { type: 'button', class: 'btn btn-sm btn-ghost cf-cancel', text: t('cf_cancel') });
      var node = el('div', { class: 'cf-pop', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId, 'data-cf-pop': k }, [
        el('p', { class: 'cf-title', id: titleId, text: t('cf_title', { c: c.label }) }),
        search, allRow, listBox, count,
        el('div', { class: 'cf-actions' }, [applyB, clearB, cancelB])
      ]);
      var boxes = [];   // [{input, key}] of the drawn values
      function visible(v) { var q = norm(search.value); return !q || norm(v.label == null ? t('cf_empty') : v.label).indexOf(q) !== -1 || norm(v.key).indexOf(q) !== -1; }
      function nSelected() { var n = 0; vals.forEach(function (v) { if (checked[v.key]) n++; }); return n; }
      function paintAll() {
        var shown = vals.filter(visible), on = shown.filter(function (v) { return checked[v.key]; }).length;
        all.checked = shown.length > 0 && on === shown.length;
        all.indeterminate = on > 0 && on < shown.length;
        all.setAttribute('aria-checked', all.indeterminate ? 'mixed' : String(all.checked));
        count.textContent = t('cf_selected', { n: nSelected(), t: vals.length });
        applyB.disabled = nSelected() === 0;
      }
      function valueRow(v) {
        var box = el('input', { type: 'checkbox', class: 'cf-box', value: v.key === EMPTY ? '' : v.key });
        box.checked = !!checked[v.key];
        box.addEventListener('change', function () { checked[v.key] = !!box.checked; paintTree(); paintAll(); });
        boxes.push({ input: box, key: v.key });
        return el('label', { class: 'cf-row' }, [box,
          el('span', { class: 'cf-label' + (v.key === EMPTY ? ' is-empty' : ''), dir: 'auto', text: v.label == null ? t('cf_empty') : v.label }),
          el('span', { class: 'cf-n num', text: t('cf_count', { n: v.n }) })]);
      }
      var groups = [];  // date tree parents: {input, keys}
      function paintTree() {
        groups.forEach(function (g) {
          var on = g.keys.filter(function (x) { return checked[x]; }).length;
          g.input.checked = on === g.keys.length && on > 0;
          g.input.indeterminate = on > 0 && on < g.keys.length;
          g.input.setAttribute('aria-checked', g.input.indeterminate ? 'mixed' : String(g.input.checked));
        });
        boxes.forEach(function (b) { b.input.checked = !!checked[b.key]; });
      }
      function groupBox(keys, label, n, kids) {
        var gb = el('input', { type: 'checkbox', class: 'cf-box cf-group-box' });
        var g = { input: gb, keys: keys };
        groups.push(g);
        gb.addEventListener('change', function () { keys.forEach(function (x) { checked[x] = !!gb.checked; }); paintTree(); paintAll(); });
        var sub = el('ul', { class: 'cf-tree-sub' }, kids);
        var tog = el('button', { type: 'button', class: 'cf-tree-toggle', 'aria-expanded': 'false', 'aria-label': t('cf_toggle') + ' — ' + label, text: '+' });
        sub.hidden = true;
        tog.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); sub.hidden = !sub.hidden; tog.setAttribute('aria-expanded', String(!sub.hidden)); tog.textContent = sub.hidden ? '+' : '−'; });
        return el('li', { class: 'cf-tree-node' }, [el('div', { class: 'cf-row' }, [tog, el('label', { class: 'cf-tree-label' }, [gb, el('span', { dir: 'ltr', text: label }), el('span', { class: 'cf-n num', text: String(n) })])]), sub]);
      }
      function draw() {
        while (listBox.firstChild) listBox.removeChild(listBox.firstChild);
        boxes = []; groups = [];
        var shown = vals.filter(visible);
        if (!shown.length) { listBox.appendChild(el('p', { class: 'cf-none text-sm text-muted', text: t('cf_none_found') })); paintAll(); return; }
        if (isDate) {
          var days = shown.filter(function (v) { return v.key !== EMPTY; }), empty = shown.filter(function (v) { return v.key === EMPTY; });
          var tree = dateTree(days);
          listBox.appendChild(el('ul', { class: 'cf-tree' }, tree.map(function (Y) {
            var yKeys = []; Y.months.forEach(function (M) { M.days.forEach(function (D) { yKeys.push(D.d); }); });
            return groupBox(yKeys, Y.y, Y.n, Y.months.map(function (M) {
              return groupBox(M.days.map(function (D) { return D.d; }), M.m, M.n, M.days.map(function (D) {
                return el('li', null, valueRow({ key: D.d, n: D.n, label: D.d }));
              }));
            }));
          })));
          empty.forEach(function (v) { listBox.appendChild(valueRow(v)); });
          paintTree();
        } else {
          shown.slice(0, MAX_LIST).forEach(function (v) { listBox.appendChild(valueRow(v)); });
          if (shown.length > MAX_LIST) listBox.appendChild(el('p', { class: 'cf-more text-xs text-muted', text: t('cf_more', { n: MAX_LIST }) }));
        }
        paintAll();
      }
      all.addEventListener('change', function () { var on = !!all.checked; vals.filter(visible).forEach(function (v) { checked[v.key] = on; }); paintTree(); paintAll(); });
      var timer = null;
      search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(draw, 120); });
      // with a search text, apply keeps the checked values the search shows (as Excel does); otherwise every checked value
      function doApply() {
        var pool = norm(search.value) ? vals.filter(visible) : vals;
        var keys = pool.filter(function (v) { return checked[v.key]; }).map(function (v) { return v.key; });
        if (!keys.length) return;
        setSel(k, keys, keys.length === vals.length);
        close();
        changed();
      }
      search.addEventListener('keydown', function (e) { if (e && e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); clearTimeout(timer); draw(); doApply(); } });
      applyB.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); doApply(); });
      clearB.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); delete sel[k]; close(); changed(); });
      cancelB.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); close(); });
      var p = {
        key: k, node: node, close: close,
        onKey: function (e) { if (e && (e.key === 'Escape' || e.key === 'Esc')) { if (e.preventDefault) e.preventDefault(); close(); } },
        onDown: function (e) { var tg = e && e.target; if (tg && !node.contains(tg) && !(buttons[k] && buttons[k].contains(tg))) close(true); },
        // focus that still reaches the page (a screen reader, a click without mousedown) closes it: never a stray open dialog
        onFocus: function (e) { var tg = e && e.target; if (tg && tg.nodeType === 1 && !node.contains(tg) && !(buttons[k] && buttons[k].contains(tg))) close(true); },
        // test hooks
        _apply: doApply, _check: function (key, on) { checked[key] = !!on; paintTree(); paintAll(); }, _search: function (q) { search.value = q; draw(); }, _boxes: function () { return boxes; }
      };
      pop = p; OPEN = p;
      node.addEventListener('keydown', function (e) {
        if (e && (e.key === 'Escape' || e.key === 'Esc')) { if (e.stopPropagation) e.stopPropagation(); p.onKey(e); return; }
        // Tab / Shift+Tab stay inside the dialog (it sits at the end of <body>, away from its button in DOM order)
        if (e && e.key === 'Tab') {
          var f = focusables(node);
          if (!f.length) return;
          var at = document.activeElement, i = f.indexOf(at);
          var to = e.shiftKey ? (i <= 0 ? f[f.length - 1] : null) : (i === -1 || i === f.length - 1 ? f[0] : null);
          if (to) { if (e.preventDefault) e.preventDefault(); try { to.focus(); } catch (x) { /* ignore */ } }
        }
      });
      draw();
      (document.body || document.documentElement).appendChild(node);
      place(node, buttons[k]);
      var b = buttons[k];
      if (b) b.setAttribute('aria-expanded', 'true');
      try { search.focus(); } catch (e) { /* ignore */ }
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('keydown', p.onKey, true); document.addEventListener('mousedown', p.onDown, true); document.addEventListener('focusin', p.onFocus, true);
      }
      return p;
    }
    var FOCUSABLE = { INPUT: 1, BUTTON: 1, SELECT: 1, TEXTAREA: 1 };
    function focusables(root) {
      var out = [];
      (function walk(n) {
        var kids = n && n.childNodes ? n.childNodes : [];
        for (var i = 0; i < kids.length; i++) {
          var x = kids[i];
          if (!x || x.nodeType === 3 || x.hidden) continue;
          var ti = x.getAttribute ? x.getAttribute('tabindex') : null;
          if ((FOCUSABLE[x.tagName] || (ti != null && ti !== '-1')) && !x.disabled && ti !== '-1') out.push(x);
          walk(x);
        }
      })(root);
      return out;
    }
    // fixed position under the button, inside the viewport (the table scrolls in its own .table-wrap, which would clip
    // an absolute popover); at phone width the CSS turns it into a bottom sheet
    function place(node, b) {
      try {
        if (!b || typeof b.getBoundingClientRect !== 'function' || typeof window.innerWidth !== 'number') return;
        var r = b.getBoundingClientRect(), w = window.innerWidth, h = window.innerHeight || 0;
        if (w < 600) return;
        var width = Math.min(320, w - 16), left = Math.min(Math.max(8, (document.documentElement.dir === 'rtl' ? r.right - width : r.left)), w - width - 8);
        node.style.position = 'fixed';
        node.style.width = width + 'px';
        node.style.left = left + 'px';
        node.style.top = Math.max(8, Math.min(r.bottom + 4, h - 120)) + 'px';
      } catch (e) { /* keep the CSS default */ }
    }
    function describe() {
      return activeKeys().map(function (k) {
        var c = byKey[k], keys = Object.keys(sel[k]);
        var labels = keys.slice(0, 6).map(function (x) { return x === EMPTY ? t('cf_empty') : displayOf(c, x, null) || x; });
        return [c.label, labels.join(t('cf_sep')) + (keys.length > 6 ? ' …(+' + (keys.length - 6) + ')' : '')];
      });
    }
    var api = {
      setRows: function (r) {
        rows = Array.isArray(r) ? r.slice() : [];
        // a selected value that no longer exists is dropped; a column left with nothing selected is cleared
        Object.keys(sel).forEach(function (k) {
          var c = byKey[k]; if (!c) { delete sel[k]; return; }
          var have = Object.create(null); rows.forEach(function (x) { have[keyOf(c, x)] = 1; });
          Object.keys(sel[k]).forEach(function (v) { if (!have[v]) delete sel[k][v]; });
          if (!Object.keys(sel[k]).length) delete sel[k];
        });
        paintButtons();
        return api;
      },
      apply: apply, button: button, open: open, close: function () { close(true); }, active: active, activeKeys: activeKeys, isActive: isActive,
      clear: function (k) { delete sel[k]; changed(); }, clearAll: function () { sel = {}; close(true); changed(); },
      describe: describe,
      state: function () { var o2 = {}; Object.keys(sel).forEach(function (k) { o2[k] = Object.keys(sel[k]); }); return o2; },
      setState: function (s) { sel = {}; Object.keys(s || {}).forEach(function (k) { if (byKey[k] && Array.isArray(s[k]) && s[k].length) setSel(k, s[k], false); }); paintButtons(); return api; },
      columns: function () { return cols.slice(); },
      _pop: function () { return pop; }
    };
    return api;
  }

  window.MarsaColFilter = { VERSION: 'cf-1', create: create, keyOf: keyOf, valuesOf: valuesOf, dateTree: dateTree, dayOf: dayOf, norm: norm, EMPTY: EMPTY, MAX_LIST: MAX_LIST };
})();
