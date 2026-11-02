/* ==========================================================================
   مرسى | MARSA — G6a reports: export engine + shared report kit (window.MarsaExport)
   --------------------------------------------------------------------------
   Contract: docs/online/G6A_SPEC.md §5.3 (binding export contract), G6a-7…G6a-13.

     MarsaExport.run({ api, def, format: 'xlsx'|'csv'|'print', filters, ctx })
         → Promise<{ ok: true, rows: n, format } | { ok: false, error: { code, detail, message } }>
     MarsaExport.fetchAll(api, def, filters, cap) → Promise<{ items, first, total } | { error }>
     MarsaExport.toCsv(columns, rows, totals) → string (UTF-8 BOM, RFC 4180, CRLF, formula guard)
     MarsaExport.printReport({ title, org, criteria, columns, rows, totals, generatedAt, generatedBy, dir })
     MarsaExport.kit() → the shared UI / report-definition kit used by rpt/search.js + rpt/reports.js

   The export always calls the SAME reader with the SAME filters as the visible table (deep copy at
   click time), pages until `total`, checks `total` / `fingerprint` on every page and recomputes the
   totals from the fetched rows in integer minor units; a mismatch is retried once, then refused
   (MRS_EXPORT data_changed / totals_mismatch). Caps: Excel / CSV ≤ 10 000 rows, print ≤ 2 000,
   known from page 1 before anything else is fetched. Audit first: MarsaApi.logReportExport
   ({report, format, filters, row_count}) — never row data or totals — must succeed before a file
   is built. The file columns are the visible table columns; the totals row is built from the server
   totals (the same function draws the on-screen <tfoot>).

   textContent / createElement only (the constant SVG icons of MarsaOps.ui aside).
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var CAP_FILE = 10000, CAP_PRINT = 2000;
  var RIYADH_MS = 3 * 3600 * 1000;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var CODE_RE = /^[a-z][a-z0-9_]{0,40}$/;
  var NONE = '—';

  /* ------------------------------------------------------------------
     strings: 'rpt.<k>' through MarsaI18n, else window.MarsaRptDict
     ------------------------------------------------------------------ */
  function I18N() { return window.MarsaI18n; }
  function lang() { var I = I18N(); return I && typeof I.lang === 'function' ? I.lang() : 'ar'; }
  function isEn() { return lang() === 'en'; }
  function interp(s, vars) { return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : s; }
  function dictGet(k) {
    var D = window.MarsaRptDict || {};
    var s = (D[lang()] || {})[k];
    return s == null ? (D.ar || {})[k] : s;
  }
  function t(k, vars) {
    var I = I18N(), key = 'rpt.' + k;
    if (I && typeof I.t === 'function') { var s = I.t(key, vars); if (s != null && s !== key) return s; }
    var d = dictGet(k);
    return interp(d == null ? k : d, vars);
  }
  function has(k) { var I = I18N(); return !!(I && typeof I.has === 'function' && I.has('rpt.' + k)) || dictGet(k) != null; }
  // code label: the admin label (status_labels / page dictionaries) first, then rpt.<domain>_<code>
  function lab(domain, code, api) {
    if (code == null || code === '') return NONE;
    if (api && typeof api.label === 'function') {
      try { var s = api.label(domain, code); if (s && s !== code && s !== NONE && s !== domain + '.' + code) return s; } catch (e) { /* fall back */ }
    }
    var own = domain + '_' + code;
    return has(own) ? t(own) : String(code);
  }

  /* ------------------------------------------------------------------
     Asia/Riyadh dates (UTC+3, no DST) — the server's "today" (app.rpt_today)
     ------------------------------------------------------------------ */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function riyadh(v) {
    if (v == null || v === '') return null;
    var d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : new Date(d.getTime() + RIYADH_MS);
  }
  function riyadhDay(v) {
    if (typeof v === 'string' && DAY_RE.test(v)) return v;
    var r = riyadh(v); return r ? r.getUTCFullYear() + '-' + pad(r.getUTCMonth() + 1) + '-' + pad(r.getUTCDate()) : '';
  }
  function riyadhDateTime(v) {
    var r = riyadh(v); return r ? riyadhDay(v) + ' ' + pad(r.getUTCHours()) + ':' + pad(r.getUTCMinutes()) : '';
  }
  function today() { return riyadhDay(new Date()); }
  function addDays(day, n) {
    var m = DAY_RE.exec(day) ? day.split('-') : null;
    if (!m) return day;
    var d = new Date(Date.UTC(+m[0], +m[1] - 1, +m[2]) + n * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  /* ------------------------------------------------------------------
     numbers: minor units (integer cents) for every money comparison
     ------------------------------------------------------------------ */
  function numOrNull(v) { if (v == null || v === '' || typeof v === 'boolean') return null; var n = +v; return isFinite(n) ? n : null; }
  function minor(v) { var n = numOrNull(v); return n == null ? 0 : Math.round(n * 100); }
  function fmtNum(v, digits) {
    var n = numOrNull(v);
    if (n == null) return NONE;
    var I = I18N();
    if (I && typeof I.fmtNumber === 'function') { try { return I.fmtNumber(n, { digits: digits }); } catch (e) { /* plain */ } }
    return digits ? n.toFixed(digits) : String(Math.round(n));
  }
  function deepCopy(o) { try { return JSON.parse(JSON.stringify(o || {})); } catch (e) { return {}; } }
  // the filter object as it travels (and as it is audited): no limit / offset / empty values
  function cleanFilters(f) {
    var out = {};
    Object.keys(f || {}).forEach(function (k) {
      var v = f[k];
      if (k === 'limit' || k === 'offset' || k === 'orgId' || v == null || typeof v === 'function') return;
      if (Array.isArray(v)) { v = v.filter(function (x) { return x != null && x !== ''; }); if (!v.length) return; }
      else if (typeof v === 'string') { v = v.trim(); if (!v) return; }
      else if (typeof v === 'object') return;
      out[k] = v;
    });
    return out;
  }

  /* ------------------------------------------------------------------
     API plumbing
     ------------------------------------------------------------------ */
  function sdk(api) { return (api && api.MarsaApi) || window.MarsaApi || null; }
  function hasFn(api, name) { var M = sdk(api); return !!(M && typeof M[name] === 'function'); }
  function isDemo(api) { var M = sdk(api); try { return !!(M && typeof M.isOnline === 'function' && !M.isOnline()); } catch (e) { return false; } }
  function call(api, name) {
    var args = Array.prototype.slice.call(arguments, 2), M = sdk(api);
    if (!M || typeof M[name] !== 'function') return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', fn: name, message: t('api_missing', { fn: name }) } });
    return Promise.resolve().then(function () { return M[name].apply(M, args); }).then(function (r) {
      return r && typeof r === 'object' && ('data' in r || 'error' in r) ? r : { data: r == null ? null : r, error: null };
    }, function (e) { return { data: null, error: e || { message: 'error' } }; });
  }
  function exportErr(detail) { return { code: 'MRS_EXPORT', detail: detail, message: t('exp_err_' + detail) }; }

  /* ------------------------------------------------------------------
     fetchAll: page the reader until total, checking total + fingerprint on each page
     ------------------------------------------------------------------ */
  function fetchAll(api, def, filters, cap) {
    var base = cleanFilters(filters);
    if (!def.paged) {
      return call(api, def.method, base).then(function (r) {
        if (r.error) return { error: r.error };
        var items = def.items(r.data);
        if (cap != null && items.length > cap) return { error: exportErr('too_many_rows'), total: items.length };
        return { items: items, first: r.data, total: items.length };
      });
    }
    var size = def.pageSize || 500;
    var first = Object.assign({}, base, { limit: size, offset: 0 });
    return call(api, def.method, first).then(function (r) {
      if (r.error) return { error: r.error };
      var d = r.data || {}, items = def.items(d).slice();
      var total = d.total != null ? +d.total : items.length;
      if (!total) return { error: exportErr('no_rows'), total: 0 };
      if (cap != null && total > cap) return { error: exportErr('too_many_rows'), total: total };
      var fp = d.fingerprint;
      function next() {
        if (items.length >= total) return Promise.resolve();
        return call(api, def.method, Object.assign({}, base, { limit: size, offset: items.length })).then(function (p) {
          if (p.error) throw { rpc: p.error };
          var pd = p.data || {}, got = def.items(pd);
          if ((pd.total != null && +pd.total !== total) || pd.fingerprint !== fp || !got.length) throw { changed: true };
          items = items.concat(got);
          return next();
        });
      }
      return next().then(function () {
        if (items.length !== total) return { error: exportErr('data_changed'), changed: true };
        var seen = {}, dup = items.some(function (x) { var k = def.rowId ? def.rowId(x) : null; if (k == null) return false; if (seen[k]) return true; seen[k] = 1; return false; });
        if (dup) return { error: exportErr('data_changed'), changed: true };
        return { items: items, first: d, total: total };
      }, function (e) {
        if (e && e.rpc) return { error: e.rpc };
        return { error: exportErr('data_changed'), changed: true };
      });
    });
  }

  /* ------------------------------------------------------------------
     CSV (RFC 4180, CRLF, UTF-8 BOM, formula-injection guard)
     ------------------------------------------------------------------ */
  var NUM_TYPES = { int: 1, money: 1, number: 1 };
  function csvValue(col, v) {
    if (v == null || v === '') return '';
    if (NUM_TYPES[col.type]) {
      var n = numOrNull(v);
      if (n != null) return col.type === 'money' ? n.toFixed(2) : col.type === 'int' ? String(Math.round(n)) : String(n);
    }
    if (col.type === 'date') return riyadhDay(v);
    if (col.type === 'datetime') return riyadhDateTime(v);
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvText(s) { s = String(s == null ? '' : s); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCsv(columns, rows, totals) {
    var lines = [columns.map(function (c) { return csvText(c.label == null ? c.key : c.label); }).join(',')];
    (rows || []).forEach(function (r) { lines.push(columns.map(function (c) { return csvValue(c, r[c.key]); }).join(',')); });
    (totals == null ? [] : Array.isArray(totals) ? totals : [totals]).forEach(function (r) { lines.push(columns.map(function (c) { return csvValue(c, r[c.key]); }).join(',')); });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------
     file names + download
     ------------------------------------------------------------------ */
  function stamp(d) { var r = riyadh(d || new Date()); return r.getUTCFullYear() + pad(r.getUTCMonth() + 1) + pad(r.getUTCDate()) + '-' + pad(r.getUTCHours()) + pad(r.getUTCMinutes()); }
  function fileName(report, ext, d) { return 'marsa-' + String(report).replace(/[^a-z0-9_-]/gi, '') + '-' + stamp(d) + '.' + ext; }
  function download(blob, name) {
    var U = window.URL || window.webkitURL;
    if (!U || typeof U.createObjectURL !== 'function') throw new Error('download unavailable');
    var url = U.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a);
    try { a.click(); } finally {
      a.parentNode && a.parentNode.removeChild(a);
      setTimeout(function () { try { U.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 0);
    }
    return name;
  }

  /* ------------------------------------------------------------------
     print / PDF: a detached <section class="rpt-print"> + window.print()
     ------------------------------------------------------------------ */
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
  // display text of a raw value (screen tfoot / print / default cells)
  function show(col, v) {
    if (v == null || v === '') return NONE;
    if (col.type === 'money') return numOrNull(v) == null ? String(v) : fmtNum(v, 2);
    if (col.type === 'int') return numOrNull(v) == null ? String(v) : fmtNum(v, 0);
    if (col.type === 'number') return numOrNull(v) == null ? String(v) : fmtNum(v);
    if (col.type === 'date') return riyadhDay(v) || String(v);
    if (col.type === 'datetime') return riyadhDateTime(v) || String(v);
    return String(v);
  }
  var LTR_TYPES = { money: 1, int: 1, number: 1, date: 1, datetime: 1 };
  var printing = null;
  function cleanupPrint() {
    if (!printing) return;
    var p = printing; printing = null;
    clearTimeout(p.timer);
    window.removeEventListener('afterprint', p.onAfter);
    if (p.node.parentNode) p.node.parentNode.removeChild(p.node);
    document.body.classList.remove('rpt-printing');
  }
  function printReport(o) {
    cleanupPrint();
    var cols = o.columns || [], dir = o.dir || (isEn() ? 'ltr' : 'rtl');
    var totals = o.totals == null ? [] : Array.isArray(o.totals) ? o.totals : [o.totals];
    function row(tag, obj, bold) {
      return el('tr', { class: bold ? 'rpt-print-total' : null }, cols.map(function (c) {
        var ltr = LTR_TYPES[c.type] || c.ltr;
        return el(tag, { class: (LTR_TYPES[c.type] ? 'num' : '') + (ltr ? ' is-ltr' : '') || null, dir: ltr ? 'ltr' : null }, show(c, obj[c.key]));
      }));
    }
    var node = el('section', { class: 'rpt-print', dir: dir, lang: isEn() ? 'en' : 'ar' }, [
      el('header', { class: 'rpt-print-head' }, [
        el('p', { class: 'rpt-print-brand', text: 'مرسى MARSA' }),
        el('h1', { class: 'rpt-print-title', text: o.title || '' }),
        o.org ? el('p', { class: 'rpt-print-org', text: o.org }) : null
      ]),
      el('dl', { class: 'rpt-print-criteria' }, (o.criteria || []).map(function (p) {
        return el('div', null, [el('dt', { text: p[0] }), el('dd', { text: p[1] == null || p[1] === '' ? NONE : String(p[1]) })]);
      })),
      el('table', { class: 'rpt-print-table' }, [
        el('thead', null, el('tr', null, cols.map(function (c) { return el('th', { scope: 'col', text: c.label }); }))),
        el('tbody', null, (o.rows || []).map(function (r) { return row('td', r, false); })),
        totals.length ? el('tfoot', null, totals.map(function (r) { return row('td', r, true); })) : null
      ]),
      el('p', { class: 'rpt-print-foot', text: t('print_foot', { at: riyadhDateTime(o.generatedAt || new Date()), by: o.generatedBy || NONE }) })
    ]);
    document.body.appendChild(node);
    document.body.classList.add('rpt-printing');
    printing = { node: node, onAfter: cleanupPrint, timer: setTimeout(cleanupPrint, 60000) };
    window.addEventListener('afterprint', printing.onAfter);
    try { if (typeof window.print === 'function') window.print(); } catch (e) { /* jsdom / blocked: the fallback timer cleans up */ }
    return node;
  }

  /* ------------------------------------------------------------------
     run: fetch → checks (retry once) → audit → file
     ------------------------------------------------------------------ */
  function orgLabel(api) {
    if (api && api.orgName) return api.orgName;
    var s = document.getElementById('adm-org-switch');
    var o = s && s.options && s.selectedIndex >= 0 ? s.options[s.selectedIndex] : null;
    return (o && o.textContent) || (api && api.orgId) || '';
  }
  function userLabel(api) {
    if (api && api.userName) return api.userName;
    var n = document.getElementById('adm-me-name');
    var s = n && n.textContent && n.textContent.trim();
    if (s && s !== NONE) return s;
    return api && typeof api.who === 'function' && api.userId ? api.who(api.userId) : '';
  }
  function run(o) {
    var api = o.api, def = o.def, format = o.format, ctx = o.ctx || {};
    var filters = cleanFilters(deepCopy(o.filters));
    if (['xlsx', 'csv', 'print'].indexOf(format) === -1) return Promise.resolve({ ok: false, error: exportErr('audit_failed') });
    if (isDemo(api)) return Promise.resolve({ ok: false, error: { code: 'MRS_DEMO_MODE', message: t('exp_demo') } });
    if (!hasFn(api, def.method) || !hasFn(api, 'logReportExport')) return Promise.resolve({ ok: false, error: { code: 'MRS_UNAVAILABLE', message: t('api_missing', { fn: hasFn(api, def.method) ? 'logReportExport' : def.method }) } });
    var cap = format === 'print' ? CAP_PRINT : CAP_FILE;
    function attempt() {
      return fetchAll(api, def, filters, cap).then(function (res) {
        if (res.error) return res;
        var bad = def.verify ? def.verify(res.items, res.first, ctx) : null;
        if (bad) return { error: exportErr('totals_mismatch'), changed: true, why: bad };
        return res;
      });
    }
    return attempt().then(function (res) { return res.changed ? attempt() : res; }).then(function (res) {
      if (res.error) return { ok: false, error: res.error, why: res.why };
      if (res.total > cap) return { ok: false, error: exportErr('too_many_rows') };
      var columns = def.columns(ctx), rows = res.items.map(function (x) { return toRow(columns, x, ctx); });
      var totals = def.totalsRows ? def.totalsRows(res.first, ctx) : [];
      var payload = { report: def.report, format: format, filters: filters, row_count: rows.length };
      return call(api, 'logReportExport', payload).then(function (a) {
        if (a.error) return { ok: false, error: exportErr('audit_failed'), cause: a.error };
        var when = new Date(), title = def.title(ctx);
        var criteria = [[t('crit_report'), title], [t('crit_org'), orgLabel(api)]].concat(def.criteria ? def.criteria(filters, ctx) : [])
          .concat([[t('crit_generated_at'), riyadhDateTime(when) + ' (' + t('riyadh_tz') + ')'], [t('crit_generated_by'), userLabel(api)], [t('crit_rows'), String(rows.length)]]);
        var fcols = columns.map(function (c) { return { key: c.key, label: c.label, type: c.type || 'text', width: c.width, ltr: c.ltr }; });
        try {
          if (format === 'xlsx') {
            if (!window.MarsaXlsx) throw new Error('MarsaXlsx missing');
            var blob = window.MarsaXlsx.blob({ title: title, generatedAt: when.toISOString(),
              sheets: [{ name: title, rtl: true, columns: fcols, rows: rows, totals: totals }],
              meta: criteria, metaName: t('crit_sheet'), metaLabels: [t('crit_item'), t('crit_value')] });
            var name = download(blob, fileName(def.report, 'xlsx', when));
            return { ok: true, format: format, rows: rows.length, file: name, columns: fcols, data: rows, totals: totals, blob: blob };
          }
          if (format === 'csv') {
            var text = toCsv(fcols, rows, totals);
            var cb = new Blob([text], { type: 'text/csv;charset=utf-8' });
            var n2 = download(cb, fileName(def.report, 'csv', when));
            return { ok: true, format: format, rows: rows.length, file: n2, text: text, blob: cb };
          }
          var node = printReport({ title: title, org: orgLabel(api), criteria: criteria, columns: fcols, rows: rows, totals: totals, generatedAt: when, generatedBy: userLabel(api) });
          return { ok: true, format: format, rows: rows.length, node: node };
        } catch (e) {
          return { ok: false, error: { code: 'MRS_EXPORT', detail: 'build', message: t('exp_err_build') }, cause: e };
        }
      });
    });
  }
  function toRow(columns, item, ctx) {
    var o = {};
    columns.forEach(function (c) { o[c.key] = c.value ? c.value(item, ctx) : item[c.key]; });
    return o;
  }

  /* ==================================================================
     Shared report kit (screen side): table with <tfoot> from the server totals,
     pager, export bar, filter controls, hash-query state, report definitions.
     ================================================================== */
  function U() { return Ops.ui || null; }

  // hash query captured before admin.js normalises '#view?…' to '#view' (this file loads before admin.js,
  // so its hashchange listener runs first). The views read it once on render.
  var PENDING = {};
  function captureHash(ev) {
    var h = String(location.hash || '').replace(/^#/, ''), qi = h.indexOf('?');
    var name = (qi === -1 ? h : h.slice(0, qi)).split('/')[0];
    if (name !== 'search' && name !== 'reports') return;
    if (qi !== -1) PENDING[name] = { path: h.slice(0, qi), query: h.slice(qi + 1) };
    else if (ev) delete PENDING[name];   // a plain #search / #reports navigation drops an unused query
  }
  try { captureHash(); window.addEventListener('hashchange', captureHash); } catch (e) { /* no window */ }
  function takeQuery(name) {
    captureHash();
    var p = PENDING[name]; delete PENDING[name];
    return p || null;
  }
  // org switch (admin.js re-renders the same hash for the new org): drop the previous org's #search / #reports query
  // and the views' remembered filters, so no request carries the old org's branch / client / carrier ids.
  // This listener runs before admin.js' (load order). The boot-time event for the org already shown is ignored.
  function onOrgSwitch(e) {
    var id = e && e.detail && e.detail.orgId;
    if (!ctxApi || !id || id === ctxApi.orgId) return;
    PENDING = {};
    var V = (Ops && Ops.views) || {};
    ['search', 'reports'].forEach(function (k) { if (V[k] && typeof V[k]._reset === 'function') { try { V[k]._reset(); } catch (err) { /* ignore */ } } });
    try {
      var h = String(location.hash || ''), qi = h.indexOf('?'), name = h.replace(/^#/, '').split(/[/?]/)[0];
      if (qi !== -1 && (name === 'search' || name === 'reports')) history.replaceState(history.state, '', h.slice(0, qi));
    } catch (err) { /* ignore */ }
  }
  try { window.addEventListener('marsa:orgchange', onOrgSwitch); } catch (e) { /* no window */ }
  // ids taken from a hash query that the loaded options do not contain (another org's or an inactive branch, a stale
  // client / carrier) are dropped, so a request never carries a filter the form shows as «الكل». A client / carrier
  // list that failed to load or may be truncated (limit reached) keeps the id and shows it as its own option.
  // ctx: {clients, carriers, clientsComplete, carriersComplete}. Returns true when something was dropped.
  function dropUnknownIds(s, api, ctx) {
    var changed = false;
    if (s.branch_id && api && Array.isArray(api.branches) && !api.branches.some(function (b) { return b && b.id === s.branch_id; })) {
      s.branch_id = ''; changed = true;
    }
    [['client_id', 'clients', 'clientsComplete'], ['carrier_id', 'carriers', 'carriersComplete']].forEach(function (p) {
      var v = s[p[0]];
      if (!v) return;
      var list = ctx[p[1]] = Array.isArray(ctx[p[1]]) ? ctx[p[1]] : [];
      if (list.some(function (x) { return x && x.id === v; })) return;
      if (ctx[p[2]]) { s[p[0]] = ''; changed = true; }
      else list.push({ id: v, name_ar: String(v).slice(0, 8), name_en: String(v).slice(0, 8) });
    });
    if (changed) s.offset = 0;
    return changed;
  }
  function parseQuery(q) {
    var out = {};
    String(q || '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('='), k, v;
      try { k = decodeURIComponent((i === -1 ? pair : pair.slice(0, i)).replace(/\+/g, ' ')); v = decodeURIComponent((i === -1 ? '' : pair.slice(i + 1)).replace(/\+/g, ' ')); } catch (e) { return; }
      if (!/^[a-z_]{1,30}$/.test(k)) return;
      out[k] = v;
    });
    return out;
  }
  function buildQuery(obj) {
    return Object.keys(obj).filter(function (k) { var v = obj[k]; return v != null && v !== '' && v !== false && !(Array.isArray(v) && !v.length); })
      .map(function (k) { var v = obj[k]; return encodeURIComponent(k) + '=' + encodeURIComponent(Array.isArray(v) ? v.join(',') : v === true ? 'true' : String(v)); }).join('&');
  }
  function setHash(path, obj) {
    var q = buildQuery(obj), h = '#' + path + (q ? '?' + q : '');
    try { if (location.hash !== h) history.replaceState(history.state, '', h); } catch (e) { /* ignore */ }
    return h;
  }
  // value checks for query values (never trusted: same shapes the server accepts)
  var Q = {
    uuid: function (v) { return UUID_RE.test(v) ? v : ''; },
    day: function (v) { return DAY_RE.test(v) ? v : ''; },
    code: function (v) { return CODE_RE.test(v) ? v : ''; },
    codes: function (v) { return String(v || '').split(',').filter(function (x) { return CODE_RE.test(x); }).slice(0, 20); },
    text: function (v) { return String(v || '').slice(0, 80); },
    bool: function (v) { return v === 'true' || v === '1'; },
    int: function (v) { var n = parseInt(v, 10); return isFinite(n) && n >= 0 ? Math.min(n, 1000000) : 0; }
  };

  // ---- table with totals ------------------------------------------------------
  // columns: [{ key, label, type, value(item, ctx), cell(item, ctx) → Node|string, ltr, cls }]
  function defaultCell(c, raw) {
    var u = U(), s = show(c, raw);
    if (raw == null || raw === '') return NONE;
    if (LTR_TYPES[c.type] || c.ltr) return u ? u.ltr(s) : el('bdi', { dir: 'ltr', text: s });
    return s;
  }
  function reportTable(columns, items, totals, ctx, o) {
    var u = U(); o = o || {};
    var tr = items.map(function (x) {
      return el('tr', { 'data-id': o.rowId ? o.rowId(x) : (x.id || null) }, columns.map(function (c) {
        var kid = c.cell ? c.cell(x, ctx) : defaultCell(c, c.value ? c.value(x, ctx) : x[c.key]);
        var td = el('td', { class: (LTR_TYPES[c.type] && c.type !== 'date' && c.type !== 'datetime' ? 'num' : '') + (c.cls ? ' ' + c.cls : '') || null }, kid == null || kid === '' ? NONE : kid);
        return td;
      }));
    });
    var tf = (totals || []).map(function (r) {
      return el('tr', { class: 'rpt-total-row' }, columns.map(function (c) {
        var v = r[c.key], isNum = NUM_TYPES[c.type] && numOrNull(v) != null;
        return el('td', { class: (NUM_TYPES[c.type] ? 'num' : '') || null, 'data-key': c.key, 'data-value': v == null || v === '' ? null : String(v) },
          v == null || v === '' ? '' : isNum ? (u ? u.ltr(show(c, v)) : show(c, v)) : String(v));
      }));
    });
    return el('div', { class: 'table-wrap adm-table-wrap ops-table-wrap rpt-table-wrap' }, el('table', { class: 'table table-striped adm-table ops-table rpt-table' }, [
      o.caption ? el('caption', { class: 'ops-sr', text: o.caption }) : null,
      el('thead', null, el('tr', null, columns.map(function (c) { return el('th', { scope: 'col', class: NUM_TYPES[c.type] ? 'num' : null, text: c.label }); }))),
      el('tbody', null, tr),
      tf.length ? el('tfoot', null, tf) : null
    ]));
  }

  // ---- pager «عرض 1–25 من 312» · السابق / التالي ---------------------------------
  function pager(total, limit, offset, onGo) {
    total = +total || 0;
    if (!total) return null;
    var from = Math.min(total, offset + 1), to = Math.min(total, offset + limit);
    var prev = el('button', { type: 'button', class: 'btn btn-sm btn-secondary rpt-prev', text: t('prev') });
    var next = el('button', { type: 'button', class: 'btn btn-sm btn-secondary rpt-next', text: t('next') });
    prev.disabled = offset <= 0; next.disabled = offset + limit >= total;
    prev.addEventListener('click', function (e) { e.preventDefault(); onGo(Math.max(0, offset - limit)); });
    next.addEventListener('click', function (e) { e.preventDefault(); onGo(offset + limit); });
    return el('nav', { class: 'rpt-pager', 'aria-label': t('pager') }, [prev,
      el('span', { class: 'rpt-pager-info', 'aria-live': 'polite', text: t('pager_info', { from: fmtNum(from, 0), to: fmtNum(to, 0), total: fmtNum(total, 0) }) }), next]);
  }

  // ---- export bar «Excel» · «CSV» · «طباعة / PDF» ----------------------------------
  // o = { api, def, ctx, getFilters() → the filter object behind the visible table, total }
  function exportBar(o) {
    var api = o.api, def = o.def;
    var demo = isDemo(api), missing = !hasFn(api, def.method) ? def.method : !hasFn(api, 'logReportExport') ? 'logReportExport' : null;
    var msg = el('span', { class: 'rpt-export-msg', role: 'status', 'aria-live': 'polite' });
    var btns = [['xlsx', t('exp_xlsx')], ['csv', t('exp_csv')], ['print', t('exp_print')]].map(function (p) {
      var b = el('button', { type: 'button', class: 'btn btn-sm btn-secondary rpt-exp-' + p[0], 'data-format': p[0], text: p[1] });
      if (demo || missing) { b.disabled = true; b.title = demo ? t('exp_demo') : t('api_missing', { fn: missing }); }
      b.addEventListener('click', function (e) { e.preventDefault(); go(p[0]); });
      return b;
    });
    if (demo || missing) msg.textContent = demo ? t('exp_demo') : t('api_missing', { fn: missing });
    else if (o.total === 0) btns.forEach(function (b) { b.disabled = true; });
    function go(format) {
      btns.forEach(function (b) { b.disabled = true; });
      msg.textContent = t('exp_running');
      msg.className = 'rpt-export-msg';
      return run({ api: api, def: def, format: format, filters: deepCopy(o.getFilters()), ctx: o.ctx }).then(function (r) {
        btns.forEach(function (b) { b.disabled = false; });
        var u = U();
        if (r.ok) {
          msg.textContent = t(format === 'print' ? 'exp_done_print' : 'exp_done', { n: fmtNum(r.rows, 0) });
          if (u) u.toast(api, msg.textContent, 'success');
        } else {
          msg.textContent = r.error && r.error.code === 'MRS_EXPORT' ? r.error.message : (u ? u.errMsg(r.error, api) : (r.error && r.error.message) || 'error');
          msg.className = 'rpt-export-msg is-error';
          if (u) u.toast(api, msg.textContent, 'error');
        }
        if (o.onDone) o.onDone(r, format);
        return r;
      });
    }
    var bar = el('div', { class: 'rpt-export-bar', role: 'group', 'aria-label': t('exp_group') }, [el('span', { class: 'rpt-export-label', text: t('exp_label') })].concat(btns, [msg]));
    bar.__run = go;   // test hook
    return bar;
  }

  // ---- filter controls (original .form-control) ----------------------------------------
  function field(label, control, cls) {
    var id = 'rpt-f-' + Math.random().toString(36).slice(2, 9);
    control.id = control.id || id;
    return el('div', { class: 'form-group rpt-field' + (cls ? ' ' + cls : '') }, [el('label', { class: 'form-label', for: control.id, text: label }), control]);
  }
  function input(name, value, o) {
    o = o || {};
    var n = el('input', { class: 'form-control', type: o.type || 'text', name: name, maxlength: o.type === 'date' ? null : (o.max || 80), dir: o.ltr ? 'ltr' : null,
      placeholder: o.placeholder || null, autocomplete: 'off', inputmode: o.inputmode || null });
    n.value = value == null ? '' : String(value);
    return n;
  }
  function selectEl(name, options, value) {
    var s = el('select', { class: 'form-control', name: name }, options.map(function (p) { return el('option', { value: p[0], text: p[1] }); }));
    s.value = value == null ? '' : String(value);
    if (s.value !== String(value == null ? '' : value)) s.value = '';
    return s;
  }
  function checks(name, options, values) {
    values = values || [];
    return el('div', { class: 'rpt-checks', role: 'group' }, options.map(function (p) {
      var c = el('input', { type: 'checkbox', name: name, value: p[0] });
      c.checked = values.indexOf(p[0]) !== -1;
      return el('label', { class: 'ops-inline-check rpt-check' }, [c, el('span', { text: p[1] })]);
    }));
  }
  function checkedValues(form, name) {
    return Array.prototype.filter.call(form.querySelectorAll('input[type=checkbox][name="' + name + '"]'), function (c) { return c.checked; }).map(function (c) { return c.value; });
  }
  function branchOptions(api) {
    return [['', t('all_branches')]].concat((api && api.branches || []).map(function (b) { return [b.id, (isEn() && b.name_en) || b.name_ar || b.code || String(b.id).slice(0, 8)]; }));
  }
  function branchName(api, id) {
    var b = (api && api.branches || []).filter(function (x) { return x.id === id; })[0];
    return b ? ((isEn() && b.name_en) || b.name_ar || b.code) : '';
  }
  function clientName(x) { return (isEn() && x.client_name_en) || x.client_name || x.client_name_en || ''; }

  // ---- report definitions (columns = file columns; totals rows = <tfoot> = file totals) ----------
  var STAGES = ['new', 'in_progress', 'customs_declaration', 'appointment', 'transport', 'empty_return', 'operationally_complete', 'under_billing', 'billed', 'closed'];
  var RETURN_STATUSES = ['pending', 'evidence_submitted', 'returned_verified', 'disputed', 'waived'];
  var OPEN_RETURNS = ['pending', 'evidence_submitted', 'disputed'];
  var CONTAINER_STATES = ['expected', 'at_port', 'released', 'gated_out', 'delivered', 'empty_returned'];
  var TRIP_STATUSES = ['planned', 'dispatched', 'loaded', 'delivered', 'cancelled'];
  var LEVELS = ['confirmed', 'estimated', 'unknown'];
  var GROUPS = ['transaction', 'client', 'supplier', 'service', 'branch', 'level'];
  var CURRENCIES = ['SAR', 'USD', 'EUR', 'AED', 'CNY'];

  function txLinkCell(id, ref) {
    if (!id || !UUID_RE.test(id)) return ref ? el('bdi', { dir: 'ltr', text: ref }) : NONE;
    return el('a', { class: 'ops-ref', href: '#tx/' + id }, el('bdi', { dir: 'ltr', text: ref || String(id).slice(0, 8) }));
  }
  function badge(domain, code, api) {
    var u = U(); if (code == null || code === '') return NONE;
    var tones = { container_return_status: { pending: 'warning', evidence_submitted: 'info', returned_verified: 'success', disputed: 'danger', waived: 'neutral' } };
    var tone = (tones[domain] || {})[code];
    if (u) return tone ? u.pill(tone, lab(domain, code, ctxApi)) : (domain === 'trip_status' ? u.statusPill('trip_status', code, ctxApi) : u.pill('neutral', lab(domain, code, ctxApi)));
    return lab(domain, code, ctxApi);
  }
  var ctxApi = null;   // the opsApi of the current render (labels); set by the views through kit().use(api)

  function countBy(items, key) { var o = {}; items.forEach(function (x) { var k = x[key] == null ? '' : x[key]; o[k] = (o[k] || 0) + 1; }); return o; }
  function sameCounts(server, items, key) {
    if (!server || typeof server !== 'object') return true;    // not returned → nothing to compare
    var mine = countBy(items, key), keys = {};
    Object.keys(server).concat(Object.keys(mine)).forEach(function (k) { keys[k] = 1; });
    return Object.keys(keys).every(function (k) { return (+server[k] || 0) === (mine[k] || 0); });
  }
  function sumInt(items, key) { return items.reduce(function (n, x) { return n + (Math.round(+x[key]) || 0); }, 0); }
  function sumMinorBy(items, amountKey, curKey) {
    var o = {};
    items.forEach(function (x) { if (x[amountKey] == null || x[amountKey] === '') return; var c = x[curKey] || ''; o[c] = (o[c] || 0) + minor(x[amountKey]); });
    return o;
  }
  function sameMinorMap(server, mine) {
    server = server || {};
    var keys = {}; Object.keys(server).concat(Object.keys(mine)).forEach(function (k) { keys[k] = 1; });
    return Object.keys(keys).every(function (k) { return minor(server[k]) === (mine[k] || 0); });
  }
  function totalLabel(n) { return t('total_n', { n: fmtNum(n, 0) }); }
  function curKeys(obj) { return Object.keys(obj || {}).sort(); }
  function criteriaFrom(filters, labels, ctx) {
    return Object.keys(filters).map(function (k) {
      var L = labels[k];
      if (!L) return null;
      var v = filters[k], text = typeof L.fmt === 'function' ? L.fmt(v, ctx) : Array.isArray(v) ? v.join('، ') : v === true ? t('yes') : v === false ? t('no') : String(v);
      return [L.label(), text];
    }).filter(Boolean);
  }
  function stageList(v, api) { return (Array.isArray(v) ? v : [v]).map(function (c) { return lab('operational_status', c, api); }).join(isEn() ? ', ' : '، '); }
  function nameFrom(list, id) { var x = (list || []).filter(function (r) { return r.id === id; })[0]; return x ? ((isEn() && x.name_en) || x.name_ar || x.name_en || id) : id; }
  // the transactions filter labels (search + transactions report share them)
  function txFilterLabels() {
    return {
      q: { label: function () { return t('f_q'); } }, declaration_no: { label: function () { return t('f_declaration_no'); } },
      bl_number: { label: function () { return t('f_bl_number'); } }, container_no: { label: function () { return t('f_container_no'); } },
      client_id: { label: function () { return t('f_client'); }, fmt: function (v, c) { return nameFrom(c && c.clients, v); } },
      client_q: { label: function () { return t('f_client_q'); } },
      carrier_id: { label: function () { return t('f_carrier'); }, fmt: function (v, c) { return nameFrom(c && c.carriers, v); } },
      carrier_q: { label: function () { return t('f_carrier_q'); } }, port: { label: function () { return t('f_port'); } },
      date_field: { label: function () { return t('f_date_field'); }, fmt: function (v) { return lab('search_date_field', v); } },
      from: { label: function () { return t('f_from'); } }, to: { label: function () { return t('f_to'); } },
      branch_id: { label: function () { return t('f_branch'); }, fmt: function (v) { return branchName(ctxApi, v) || v; } },
      operational_status: { label: function () { return t('f_status'); }, fmt: function (v) { return stageList(v, ctxApi); } },
      sort: { label: function () { return t('f_sort'); }, fmt: function (v) { return t('sort_' + v); } }
    };
  }
  function txColumns(ctx, kind) {
    var cols = [
      { key: 'ref', label: t('c_ref'), type: 'text', ltr: true, width: 18, value: function (x) { return x.ref; }, cell: function (x) { return txLinkCell(x.id, x.ref); } },
      { key: 'client', label: t('c_client'), type: 'text', width: 26, value: clientName },
      { key: 'branch', label: t('c_branch'), type: 'text', width: 14, value: function (x) { return x.branch_name || branchName(ctxApi, x.branch_id); } },
      { key: 'operational_status', label: t('c_status'), type: 'text', width: 18, value: function (x) { return lab('operational_status', x.operational_status, ctxApi); },
        cell: function (x) { var u = U(); return u ? u.pill('brand', lab('operational_status', x.operational_status, ctxApi)) : lab('operational_status', x.operational_status, ctxApi); } },
      { key: 'declaration_no', label: t('c_declaration_no'), type: 'text', ltr: true, width: 16, value: function (x) { return x.declaration_no; } }
    ];
    if (kind === 'transactions') cols.push({ key: 'declaration_status', label: t('c_declaration_status'), type: 'text', width: 14, value: function (x) { return x.declaration_status ? lab('declaration_status', x.declaration_status, ctxApi) : ''; } });
    cols.push(
      { key: 'bl_number', label: t('c_bl_number'), type: 'text', ltr: true, width: 18, value: function (x) { return x.bl_number; } },
      { key: 'port', label: t('c_port'), type: 'text', width: 22, value: function (x) { return [x.port_of_loading, x.port_of_discharge].filter(Boolean).join(' → '); } },
      { key: 'shipping_line', label: t('c_shipping_line'), type: 'text', width: 16, value: function (x) { return x.shipping_line; } },
      { key: 'eta', label: t('c_eta'), type: 'date', value: function (x) { return x.eta || null; } },
      { key: 'container_count', label: t('c_containers'), type: 'int', value: function (x) { return x.container_count == null ? null : +x.container_count; } }
    );
    if (kind === 'transactions') cols.push({ key: 'open_returns', label: t('c_open_returns'), type: 'int', value: function (x) { return x.open_returns == null ? null : +x.open_returns; } });
    if (ctx && ctx.finRead) cols.push({ key: 'financial_status', label: t('c_financial_status'), type: 'text', width: 14, value: function (x) { return x.financial_status ? lab('financial_status', x.financial_status, ctxApi) : ''; } });
    cols.push({ key: 'created_at', label: t('c_created_at'), type: 'datetime', value: function (x) { return x.created_at || null; },
      cell: function (x) { return x.created_at ? el('span', { class: 'is-nowrap', text: riyadhDateTime(x.created_at) }) : NONE; } });
    if (kind === 'search') cols.push({ key: 'matched', label: t('c_matched'), type: 'text', width: 30,
      value: function (x) { return (x.matched || []).slice(0, 5).map(function (m) { return t('m_' + m.field) + ': ' + (m.value == null ? '' : m.value); }).join(' · '); },
      cell: function (x) {
        var m = (x.matched || []).slice(0, 5);
        if (!m.length) return NONE;
        return el('span', { class: 'rpt-chips' }, m.map(function (p) {
          return el('span', { class: 'badge badge-muted rpt-chip' }, [el('span', { text: t('m_' + p.field) + ': ' }), el('bdi', { dir: 'auto', text: p.value == null ? '' : String(p.value) })]);
        }));
      } });
    return cols;
  }
  var DEFS = {
    search: {
      // the file pages through report_transactions (limit 500): same matcher, sort, ids, total and fingerprint as
      // search_records for the same filters (asserted in g6a-tests), at a fifth of the calls (search_records caps at 100)
      report: 'search', method: 'reportTransactions', pageSize: 500, paged: true, rowId: function (x) { return x.id; },
      title: function () { return t('r_search'); },
      items: function (d) { return d && Array.isArray(d.items) ? d.items : []; },
      columns: function (ctx) { return txColumns(ctx, 'search'); },
      totalsRows: function (d) { return [{ ref: totalLabel(d && d.total != null ? +d.total : 0) }]; },
      verify: function (items, d) { return items.length === +d.total ? null : 'count'; },
      criteria: function (f, ctx) { return criteriaFrom(f, txFilterLabels(), ctx); }
    },
    transactions: {
      report: 'transactions', method: 'reportTransactions', pageSize: 500, paged: true, rowId: function (x) { return x.id; },
      title: function () { return t('r_transactions'); },
      items: function (d) { return d && Array.isArray(d.items) ? d.items : []; },
      columns: function (ctx) { return txColumns(ctx, 'transactions'); },
      totalsRows: function (d) {
        var tt = (d && d.totals) || {};
        return [{ ref: totalLabel(tt.count != null ? tt.count : d && d.total), container_count: tt.containers != null ? +tt.containers : null, open_returns: tt.open_returns != null ? +tt.open_returns : null }];
      },
      verify: function (items, d) {
        var tt = d.totals || {};
        if (tt.count != null && +tt.count !== items.length) return 'count';
        if (tt.containers != null && +tt.containers !== sumInt(items, 'container_count')) return 'containers';
        if (tt.open_returns != null && +tt.open_returns !== sumInt(items, 'open_returns')) return 'open_returns';
        if (!sameCounts(tt.by_status, items, 'operational_status')) return 'by_status';
        return null;
      },
      criteria: function (f, ctx) { return criteriaFrom(f, txFilterLabels(), ctx); }
    },
    containers: {
      report: 'containers', method: 'reportContainers', pageSize: 500, paged: true, rowId: function (x) { return x.id; },
      title: function () { return t('r_containers'); },
      items: function (d) { return d && Array.isArray(d.items) ? d.items : []; },
      columns: function () {
        return [
          { key: 'container_no', label: t('c_container_no'), type: 'text', ltr: true, width: 15, value: function (x) { return x.container_no; } },
          { key: 'container_type', label: t('c_container_type'), type: 'text', width: 10, value: function (x) { return x.container_type; } },
          { key: 'transaction_ref', label: t('c_ref'), type: 'text', ltr: true, width: 18, value: function (x) { return x.transaction_ref; }, cell: function (x) { return txLinkCell(x.transaction_id, x.transaction_ref); } },
          { key: 'client', label: t('c_client'), type: 'text', width: 24, value: clientName },
          { key: 'branch', label: t('c_branch'), type: 'text', width: 14, value: function (x) { return x.branch_name || branchName(ctxApi, x.branch_id); } },
          { key: 'operational_state', label: t('c_operational_state'), type: 'text', width: 14, value: function (x) { return lab('container_state', x.operational_state, ctxApi); } },
          { key: 'return_status', label: t('c_return_status'), type: 'text', width: 18, value: function (x) { return lab('container_return_status', x.return_status, ctxApi); },
            cell: function (x) { return badge('container_return_status', x.return_status, ctxApi); } },
          { key: 'return_deadline', label: t('c_return_deadline'), type: 'date', value: function (x) { return x.return_deadline || null; } },
          { key: 'returned_at', label: t('c_returned_at'), type: 'datetime', value: function (x) { return x.returned_at || null; } },
          { key: 'gate_out_at', label: t('c_gate_out_at'), type: 'datetime', value: function (x) { return x.gate_out_at || null; } },
          { key: 'return_place', label: t('c_return_place'), type: 'text', width: 18, value: function (x) { return x.return_yard_name || x.return_location || ''; } },
          { key: 'days_overdue', label: t('c_days_overdue'), type: 'int', value: function (x) { return x.days_overdue == null ? 0 : +x.days_overdue; },
            cell: function (x) { var n = +x.days_overdue || 0; return n > 0 ? el('span', { class: 'badge badge-danger', text: t('days_late', { n: fmtNum(n, 0) }) }) : el('bdi', { dir: 'ltr', class: 'num', text: '0' }); } }
        ];
      },
      totalsRows: function (d) {
        var tt = (d && d.totals) || {};
        return [{ container_no: totalLabel(tt.count != null ? tt.count : d && d.total),
          return_status: t('tot_open_overdue', { open: fmtNum(tt.open || 0, 0), overdue: fmtNum(tt.overdue || 0, 0) }) }];
      },
      verify: function (items, d) {
        var tt = d.totals || {};
        if (tt.count != null && +tt.count !== items.length) return 'count';
        if (!sameCounts(tt.by_return_status, items, 'return_status')) return 'by_return_status';
        if (tt.open != null && +tt.open !== items.filter(function (x) { return OPEN_RETURNS.indexOf(x.return_status) !== -1; }).length) return 'open';
        if (tt.overdue != null && +tt.overdue !== items.filter(function (x) { return +x.days_overdue > 0; }).length) return 'overdue';
        return null;
      },
      criteria: function (f, ctx) {
        return criteriaFrom(f, {
          branch_id: { label: function () { return t('f_branch'); }, fmt: function (v) { return branchName(ctxApi, v) || v; } },
          client_id: { label: function () { return t('f_client'); }, fmt: function (v, c) { return nameFrom(c && c.clients, v); } },
          container_no: { label: function () { return t('f_container_no'); } },
          date_field: { label: function () { return t('f_date_field'); }, fmt: function (v) { return t('cdf_' + v); } },
          from: { label: function () { return t('f_from'); } }, to: { label: function () { return t('f_to'); } },
          return_status: { label: function () { return t('f_return_status'); }, fmt: function (v) { return [].concat(v).map(function (c) { return lab('container_return_status', c, ctxApi); }).join('، '); } },
          operational_state: { label: function () { return t('f_operational_state'); }, fmt: function (v) { return [].concat(v).map(function (c) { return lab('container_state', c, ctxApi); }).join('، '); } },
          overdue: { label: function () { return t('f_overdue'); } },
          sort: { label: function () { return t('f_sort'); }, fmt: function (v) { return t('sort_' + v); } }
        }, ctx);
      }
    },
    trips: {
      report: 'trips', method: 'reportTrips', pageSize: 500, paged: true, rowId: function (x) { return x.id; },
      title: function () { return t('r_trips'); },
      items: function (d) { return d && Array.isArray(d.items) ? d.items : []; },
      columns: function (ctx) {
        var cols = [
          { key: 'transaction_ref', label: t('c_ref'), type: 'text', ltr: true, width: 18, value: function (x) { return x.transaction_ref; }, cell: function (x) { return txLinkCell(x.transaction_id, x.transaction_ref); } },
          { key: 'container_no', label: t('c_container_no'), type: 'text', ltr: true, width: 15, value: function (x) { return x.container_no; } },
          { key: 'leg_no', label: t('c_leg_no'), type: 'int', value: function (x) { return x.leg_no == null ? null : +x.leg_no; } },
          { key: 'carrier_name', label: t('c_carrier'), type: 'text', width: 20, value: function (x) { return x.carrier_name; } },
          { key: 'driver_name', label: t('c_driver'), type: 'text', width: 18, value: function (x) { return x.driver_name; } },
          { key: 'truck_plate', label: t('c_truck'), type: 'text', ltr: true, width: 12, value: function (x) { return x.truck_plate; } },
          { key: 'origin', label: t('c_origin'), type: 'text', width: 16, value: function (x) { return x.origin; } },
          { key: 'destination', label: t('c_destination'), type: 'text', width: 16, value: function (x) { return x.destination; } },
          { key: 'planned_at', label: t('c_planned_at'), type: 'datetime', value: function (x) { return x.planned_at || null; } },
          { key: 'loaded_at', label: t('c_loaded_at'), type: 'datetime', value: function (x) { return x.loaded_at || null; } },
          { key: 'unloaded_at', label: t('c_unloaded_at'), type: 'datetime', value: function (x) { return x.unloaded_at || null; } },
          { key: 'status', label: t('c_trip_status'), type: 'text', width: 12, value: function (x) { return lab('trip_status', x.status, ctxApi); },
            cell: function (x) { return badge('trip_status', x.status, ctxApi); } }
        ];
        if (ctx && ctx.includeFinance) cols.push(
          { key: 'cost_amount', label: t('c_cost'), type: 'money', value: function (x) { return x.cost_amount == null ? null : +x.cost_amount; } },
          { key: 'cost_currency', label: t('c_cost_currency'), type: 'text', ltr: true, width: 8, value: function (x) { return x.cost_amount == null ? '' : x.cost_currency || ''; } },
          { key: 'sell_amount', label: t('c_sell'), type: 'money', value: function (x) { return x.sell_amount == null ? null : +x.sell_amount; } },
          { key: 'sell_currency', label: t('c_sell_currency'), type: 'text', ltr: true, width: 8, value: function (x) { return x.sell_amount == null ? '' : x.sell_currency || ''; } });
        return cols;
      },
      totalsRows: function (d, ctx) {
        var tt = (d && d.totals) || {}, fin = tt.finance || {};
        var out = [{ transaction_ref: totalLabel(tt.count != null ? tt.count : d && d.total) }];
        if (ctx && ctx.includeFinance) {
          var cost = fin.cost_by_currency || {}, sell = fin.sell_by_currency || {}, curs = {};
          curKeys(cost).concat(curKeys(sell)).forEach(function (c) { curs[c] = 1; });
          Object.keys(curs).sort().forEach(function (c) {
            out.push({ transaction_ref: t('total_cur', { cur: c }), cost_amount: cost[c] != null ? +cost[c] : null, cost_currency: cost[c] != null ? c : '',
              sell_amount: sell[c] != null ? +sell[c] : null, sell_currency: sell[c] != null ? c : '' });
          });
        }
        return out;
      },
      verify: function (items, d, ctx) {
        var tt = d.totals || {}, fin = tt.finance || {};
        if (tt.count != null && +tt.count !== items.length) return 'count';
        if (!sameCounts(tt.by_status, items, 'status')) return 'by_status';
        if (ctx && ctx.includeFinance) {
          if (!sameMinorMap(fin.cost_by_currency, sumMinorBy(items, 'cost_amount', 'cost_currency'))) return 'cost';
          if (!sameMinorMap(fin.sell_by_currency, sumMinorBy(items, 'sell_amount', 'sell_currency'))) return 'sell';
        }
        return null;
      },
      criteria: function (f, ctx) {
        return criteriaFrom(f, {
          branch_id: { label: function () { return t('f_branch'); }, fmt: function (v) { return branchName(ctxApi, v) || v; } },
          client_id: { label: function () { return t('f_client'); }, fmt: function (v, c) { return nameFrom(c && c.clients, v); } },
          carrier_id: { label: function () { return t('f_carrier'); }, fmt: function (v, c) { return nameFrom(c && c.carriers, v); } },
          status: { label: function () { return t('f_trip_status'); }, fmt: function (v) { return [].concat(v).map(function (c) { return lab('trip_status', c, ctxApi); }).join('، '); } },
          from: { label: function () { return t('f_from_planned'); } }, to: { label: function () { return t('f_to'); } },
          include_finance: { label: function () { return t('f_include_finance'); } },
          sort: { label: function () { return t('f_sort'); }, fmt: function (v) { return t('sort_' + v); } }
        }, ctx);
      }
    },
    margins: {
      report: 'margins', method: 'marginReport', pageSize: 200, paged: true, rowId: function (x) { return x.transaction_id + ':' + x.currency; },
      title: function () { return t('r_margins'); },
      items: function (d) { return d && Array.isArray(d.items) ? d.items : []; },
      columns: function () {
        var m = function (k) { return { key: k, label: t('c_' + k), type: 'money', value: function (x) { return x[k] == null ? null : +x[k]; } }; };
        return [
          { key: 'ref', label: t('c_ref'), type: 'text', ltr: true, width: 18, value: function (x) { return x.ref; }, cell: function (x) { return txLinkCell(x.transaction_id, x.ref); } },
          { key: 'client', label: t('c_client'), type: 'text', width: 24, value: clientName },
          { key: 'currency', label: t('c_currency'), type: 'text', ltr: true, width: 8, value: function (x) { return x.currency || ''; } },
          m('charges_service'), m('cost_confirmed'), m('cost_estimated'), m('margin_confirmed'), m('margin_expected'),
          { key: 'level', label: t('c_level'), type: 'text', width: 12, value: function (x) { return lab('fin_level', x.level, ctxApi); } },
          { key: 'pending_count', label: t('c_pending'), type: 'int', value: function (x) { return x.pending_count == null ? 0 : +x.pending_count; } }
        ];
      },
      totalsRows: function (d) {
        var tb = (d && d.totals_by_currency) || {};
        return curKeys(tb).map(function (c) {
          var x = tb[c] || {};
          return { ref: t('total_cur_n', { cur: c, n: fmtNum(x.rows || 0, 0) }), currency: c, charges_service: +x.charges_service || 0, cost_confirmed: +x.cost_confirmed || 0,
            cost_estimated: +x.cost_estimated || 0, margin_confirmed: +x.margin_confirmed || 0, margin_expected: +x.margin_expected || 0 };
        });
      },
      verify: function (items, d) {
        var tb = d.totals_by_currency || {};
        var keys = ['charges_service', 'cost_confirmed', 'cost_estimated', 'margin_confirmed', 'margin_expected'];
        var bad = keys.filter(function (k) { return !sameMinorMap(objMap(tb, k), sumMinorBy(items, k, 'currency')); })[0];
        if (bad) return bad;
        var rows = {}; items.forEach(function (x) { rows[x.currency] = (rows[x.currency] || 0) + 1; });
        return curKeys(tb).concat(Object.keys(rows)).every(function (c) { return (tb[c] ? +tb[c].rows || 0 : 0) === (rows[c] || 0); }) ? null : 'rows';
      },
      criteria: function (f, ctx) {
        return criteriaFrom(f, {
          branch_id: { label: function () { return t('f_branch'); }, fmt: function (v) { return branchName(ctxApi, v) || v; } },
          client_id: { label: function () { return t('f_client'); }, fmt: function (v, c) { return nameFrom(c && c.clients, v); } },
          from: { label: function () { return t('f_from_created'); } }, to: { label: function () { return t('f_to'); } },
          operational_status: { label: function () { return t('f_status'); }, fmt: function (v) { return stageList(v, ctxApi); } },
          level: { label: function () { return t('f_level'); }, fmt: function (v) { return lab('fin_level', v, ctxApi); } },
          currency: { label: function () { return t('f_currency'); } }
        }, ctx);
      }
    },
    costs: {
      report: 'costs', method: 'costReport', paged: false,
      title: function () { return t('r_costs'); },
      items: function (d) { return d && Array.isArray(d.rows) ? d.rows : []; },
      columns: function (ctx) {
        var m = function (k) { return { key: k, label: t('c_' + k), type: 'money', value: function (x) { return x[k] == null ? null : +x[k]; } }; };
        var g = (ctx && ctx.groupBy) || 'transaction';
        return [
          { key: 'key', label: t('grp_' + g), type: 'text', width: 26, value: function (x) { return costKeyLabel(g, x); },
            cell: function (x) { return g === 'transaction' && x.key && UUID_RE.test(x.key) ? txLinkCell(x.key, costKeyLabel(g, x)) : costKeyLabel(g, x); } },
          { key: 'currency', label: t('c_currency'), type: 'text', ltr: true, width: 8, value: function (x) { return x.currency || ''; } },
          m('confirmed'), m('estimated'),
          { key: 'unknown_count', label: t('c_unknown_count'), type: 'int', value: function (x) { return x.unknown_count == null ? 0 : +x.unknown_count; } },
          m('pass_through'), m('client_paid_direct'),
          { key: 'items', label: t('c_items'), type: 'int', value: function (x) { return x.items == null ? null : +x.items; } }
        ];
      },
      totalsRows: function (d) {
        var tb = (d && d.totals_by_currency) || {};
        return curKeys(tb).map(function (c) {
          var x = tb[c] || {};
          return { key: t('total_cur', { cur: c }), currency: c, confirmed: +x.confirmed || 0, estimated: +x.estimated || 0, unknown_count: +x.unknown_count || 0,
            pass_through: +x.pass_through || 0, client_paid_direct: +x.client_paid_direct || 0 };
        });
      },
      verify: function (items, d) {
        var tb = d.totals_by_currency || {};
        var bad = ['confirmed', 'estimated', 'pass_through', 'client_paid_direct'].filter(function (k) { return !sameMinorMap(objMap(tb, k), sumMinorBy(items, k, 'currency')); })[0];
        if (bad) return bad;
        var u = {}; items.forEach(function (x) { u[x.currency] = (u[x.currency] || 0) + (Math.round(+x.unknown_count) || 0); });
        return curKeys(tb).concat(Object.keys(u)).every(function (c) { return (tb[c] ? Math.round(+tb[c].unknown_count) || 0 : 0) === (u[c] || 0); }) ? null : 'unknown_count';
      },
      criteria: function (f, ctx) {
        return criteriaFrom(f, {
          group_by: { label: function () { return t('f_group_by'); }, fmt: function (v) { return t('grp_' + v); } },
          branch_id: { label: function () { return t('f_branch'); }, fmt: function (v) { return branchName(ctxApi, v) || v; } },
          client_id: { label: function () { return t('f_client'); }, fmt: function (v, c) { return nameFrom(c && c.clients, v); } },
          from: { label: function () { return t('f_from_item'); } }, to: { label: function () { return t('f_to'); } },
          level: { label: function () { return t('f_level'); }, fmt: function (v) { return lab('fin_level', v, ctxApi); } },
          currency: { label: function () { return t('f_currency'); } },
          include_overhead: { label: function () { return t('f_include_overhead'); } }
        }, ctx);
      }
    }
  };
  function objMap(tb, k) { var o = {}; Object.keys(tb || {}).forEach(function (c) { o[c] = tb[c] ? tb[c][k] : 0; }); return o; }
  function costKeyLabel(g, x) {
    var own = isEn() ? (x.label_en || x.label_ar) : (x.label_ar || x.label_en);
    if (g === 'level') return lab('fin_level', x.key, ctxApi);
    if (g === 'branch' && !own) return branchName(ctxApi, x.key) || String(x.key || '');
    return own || (x.key == null ? t('key_none') : String(x.key));
  }

  function kit() {
    return {
      t: t, has: has, lab: lab, isEn: isEn, lang: lang, NONE: NONE, el: el, ui: U,
      use: function (api) { ctxApi = api; return api; },
      riyadhDay: riyadhDay, riyadhDateTime: riyadhDateTime, today: today, addDays: addDays, fmtNum: fmtNum, minor: minor, show: show,
      call: call, hasFn: hasFn, isDemo: isDemo, cleanFilters: cleanFilters, deepCopy: deepCopy,
      takeQuery: takeQuery, parseQuery: parseQuery, buildQuery: buildQuery, setHash: setHash, Q: Q, dropUnknownIds: dropUnknownIds,
      reportTable: reportTable, pager: pager, exportBar: exportBar, field: field, input: input, select: selectEl, checks: checks, checkedValues: checkedValues,
      branchOptions: branchOptions, branchName: branchName, clientName: clientName, badge: badge, txLinkCell: txLinkCell,
      defs: DEFS, STAGES: STAGES, RETURN_STATUSES: RETURN_STATUSES, OPEN_RETURNS: OPEN_RETURNS, CONTAINER_STATES: CONTAINER_STATES,
      TRIP_STATUSES: TRIP_STATUSES, LEVELS: LEVELS, GROUPS: GROUPS, CURRENCIES: CURRENCIES, UUID_RE: UUID_RE, CAP_FILE: CAP_FILE, CAP_PRINT: CAP_PRINT
    };
  }

  window.MarsaExport = {
    run: run, fetchAll: fetchAll, toCsv: toCsv, printReport: printReport, cleanupPrint: cleanupPrint,
    fileName: fileName, download: download, cleanFilters: cleanFilters, minor: minor, kit: kit,
    CAP_FILE: CAP_FILE, CAP_PRINT: CAP_PRINT
  };
})();
