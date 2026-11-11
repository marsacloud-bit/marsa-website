/* ==========================================================================
   مرسى | MARSA — legacy step 7 «مواءمة دفترة»: the shared Daftra kit (MarsaOps.dftKit)
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_DAFTRA_AR.md (§4 job contract, §5 MarsaApi, §8 worker error codes).
   Used by assets/js/bill/dft-settings.js (the step-7 tabs of #daftra), assets/js/bill/tx-bill.js (the transaction
   billing strip), assets/js/ops/tx-legacy.js (supplier search on a trip), assets/js/ops/tx-sections.js and
   assets/js/decl-review.js (whether an opening draft was requested at declaration approval).
   Loaded after assets/i18n/dft.js and before bill/daftra.js, bill/tx-bill.js, ops/tx-legacy.js, decl-review.js.

   * Pure helpers (no DOM): the worker error dictionary (errorCode / errorFields mirror
     supabase/functions/daftra-sync/adapter.js — the UI cannot import the edge function), the KSA account explanation,
     the zero-insensitive product code (000186 = 186, app.daftra_code_norm), the CustomModel map payload, the tenant
     client-file column mapping (CSV / XLSX rows → import_clients rows), the review decisions per kind, the invoice
     candidate comparison and its confirmation number (confirm_invoice_link), today in Asia/Riyadh.
   * Owner decisions shown, never bypassed: no edit of an existing Daftra draft (HF5), products resolved by code and never
     created, the KSA guard before any write, the AI never approves, billing stays blocked without the empty-return proof.
     The server decides every case; the buttons only mirror it.
   * Server and user data are inserted with textContent / createElement only.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };

  /* ------------------------------------------------------------------ strings */
  function lang() { var I = window.MarsaI18n; return I && typeof I.lang === 'function' ? I.lang() : 'ar'; }
  function interp(s, vars) { return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : s; }
  function T(k, vars) {
    var I = window.MarsaI18n, key = 'dft.' + k;
    if (I && typeof I.t === 'function') { var s = I.t(key, vars); if (s != null && s !== key) return s; }
    var D = window.MarsaDftDict || {}, d = (D[lang()] || {})[k];
    if (d == null) d = (D.ar || {})[k];
    return d == null ? k : interp(d, vars);
  }
  function has(k) { var D = window.MarsaDftDict || {}; return (D.ar || {})[k] != null || T(k) !== k; }
  function sep() { return T('list_sep'); }

  /* ------------------------------------------------------------------ worker error dictionary (adapter.js) */
  var ERROR_CODES = ['account_not_ksa', 'custom_required', 'unmapped_product', 'product_not_found', 'client_not_linked',
    'client_suspended', 'client_inactive', 'draft_update_disabled', 'product_create_disabled', 'date_mismatch', 'readback_mismatch',
    'client_mismatch', 'empty_result', 'reference_lookup_incomplete', 'vat_scan_incomplete', 'auth_failed', 'forbidden', 'account_mismatch',
    'not_configured', 'validation', 'not_found', 'rate_limited', 'http_5xx', 'timeout', 'network', 'lease_lost', 'tax_map_invalid',
    'invoice_issued', 'supplier_not_linked', 'worker', 'setting_disabled', 'purchase_review'];
  var ERROR_ALIASES = { draft_update_refused: 'draft_update_disabled', product_create_refused: 'product_create_disabled',
    tax_unmapped: 'tax_map_invalid', tax_ambiguous: 'tax_map_invalid', intent_issued: 'invoice_issued', not_draft: 'invoice_issued',
    redirect: 'not_configured', mock_disabled: 'not_configured', offline: 'network', bad_response: 'network', no_id: 'network',
    run_deadline: 'timeout', deadline: 'timeout', lease_expired: 'lease_lost', exception: 'worker', before_complete: 'worker', internal: 'worker',
    plan_limit: 'validation', item_unmapped: 'unmapped_product' };
  // e: a code string, or {code, kind, message} (a job / attempt error, an intent's last_error_code)
  function errorCode(e) {
    if (typeof e === 'string') e = { code: e };
    var code = e && e.code ? String(e.code) : '';
    if (ERROR_CODES.indexOf(code) !== -1) return code;
    if (ERROR_ALIASES[code]) return ERROR_ALIASES[code];
    if (/^config_/.test(code)) return 'not_configured';
    var kind = e && e.kind ? String(e.kind) : '';
    if (ERROR_CODES.indexOf(kind) !== -1) return kind;
    if (kind === 'conflict') return 'validation';
    return 'worker';
  }
  function errorFields(e) {
    var m = /\(fields: ([^)]{0,400})\)/.exec(String(e && e.message || ''));
    return m ? m[1].split(',').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 20) : [];
  }
  // a field token → its label (custom field / account reason / read-back part / item key), else the token itself
  function fieldLabel(f) {
    if (CUSTOM_FIELDS.indexOf(f) !== -1) return T('cf_' + f);
    if (['not_checked', 'currency', 'country', 'vat_rate'].indexOf(f) !== -1) return T('acct_reason_' + f);
    if (['client', 'total', 'lines', 'date'].indexOf(f) !== -1) return T('rb_' + f);
    if (has('fld_' + f)) return T('fld_' + f);          // review: setting_disabled / purchase_review tokens
    return f;
  }
  function errorText(e) {
    if (e == null || e === '') return '';
    var o = typeof e === 'string' ? { code: e } : e;
    var code = errorCode(o), fields = errorFields(o);
    if (o.fields && Array.isArray(o.fields)) fields = fields.concat(o.fields);
    return T('err_' + code, { fields: fields.length ? fields.map(fieldLabel).join(sep()) : T('err_fields_unknown') });
  }

  /* ------------------------------------------------------------------ the KSA account guard */
  var SA_COUNTRIES = ['sa', 'sau', 'ksa', 'saudi arabia', 'kingdom of saudi arabia', 'السعودية', 'المملكة العربية السعودية'];
  function isSaudiCountry(c) { return c != null && SA_COUNTRIES.indexOf(String(c).trim().toLowerCase()) !== -1; }
  // account_check {ok, reason, currency, country, vat_15, checked_at, enforced} → {ok, reason, fixes:[dict keys]}
  function accountView(check) {
    var c = check || { ok: false, reason: 'not_checked', enforced: true };
    if (c.ok === true) return { ok: true, reason: null, enforced: !!c.enforced, fixes: [] };
    var reason = c.reason || 'not_checked', fixes = [];
    if (reason === 'not_checked') fixes.push('acct_fix_not_checked');
    else {
      if (c.currency == null ? reason === 'currency' : String(c.currency).toUpperCase() !== 'SAR') fixes.push('acct_fix_currency');
      if (c.country == null ? reason === 'country' : !isSaudiCountry(c.country)) fixes.push('acct_fix_country');
      if (c.vat_15 === false || reason === 'vat_rate') fixes.push('acct_fix_vat_rate');
      if (!fixes.length) fixes.push('acct_fix_' + reason);
    }
    fixes.push('acct_fix_then');
    return { ok: false, reason: reason, enforced: c.enforced !== false, fixes: fixes };
  }
  function accountReason(check) { var v = accountView(check); return v.ok ? null : T('acct_reason_' + v.reason); }

  /* ------------------------------------------------------------------ product codes (app.daftra_code_norm) */
  var CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
  function western(s) {
    return String(s == null ? '' : s).replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
  }
  // review: a leading '#' and every whitespace are ignored like the legacy (#000186 = 000 186 = 186; app.daftra_code_norm)
  function codeNorm(p) {
    var s = western(p).replace(/^\s*#/, '').replace(/\s+/g, '');
    if (!s) return null;
    s = s.toUpperCase();
    if (/^[0-9]+$/.test(s)) { var z = s.replace(/^0+/, ''); return z === '' ? '0' : z; }
    return s;
  }
  // a product map row → mapped | code_only | not_found | no_code
  function productState(row) {
    var l = row && row.link;
    if (row && row.mapped) return 'mapped';
    if (!l || !l.remote_code_norm) return 'no_code';
    if (l.last_error_code === 'product_not_found') return 'not_found';
    return 'code_only';
  }
  function exactCandidates(row) {
    return ((row && row.link && row.link.candidates) || []).filter(function (c) { return c && c.exact === true; });
  }
  function unmappedKeys(items) {
    return (items || []).filter(function (x) { return !x.mapped && (!x.service_item || x.service_item.is_active !== false); }).map(function (x) { return x.item_key; });
  }

  /* ------------------------------------------------------------------ CustomModel map (save_daftra_custom_fields) */
  var CUSTOM_FIELDS = ['declaration_no', 'declaration_date', 'bl', 'port', 'declaration_type', 'containers', 'goods', 'origin'];
  var DECL_TYPES = ['import', 'export', 'clearance'];
  var TYPE_DEFAULTS = { import: 'وارد', export: 'صادر', clearance: 'تصفية' };
  var KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
  // v = { key_<field>, req_<field>, port_<code>, type_<type> } → { map, errors: {<form name>: dict key} }
  function customMapPayload(v, portCodes) {
    var fields = {}, errors = {}, seen = {};
    CUSTOM_FIELDS.forEach(function (f) {
      var key = String(v['key_' + f] == null ? '' : v['key_' + f]).trim();
      if (!key) return;
      if (!KEY_RE.test(key)) { errors['key_' + f] = 'cf_key_bad'; return; }
      if (seen[key]) { errors['key_' + f] = 'cf_key_dup'; return; }
      seen[key] = true;
      fields[f] = { key: key, required: !!v['req_' + f] };
    });
    var pv = {}, tv = {};
    (portCodes || []).forEach(function (c) { var x = String(v['port_' + c] == null ? '' : v['port_' + c]).trim(); if (x) pv[c] = x.slice(0, 120); });
    DECL_TYPES.forEach(function (d) { var x = String(v['type_' + d] == null ? '' : v['type_' + d]).trim(); if (x) tv[d] = x.slice(0, 120); });
    return { map: { fields: fields, port_values: pv, type_values: tv }, errors: errors };
  }

  /* ------------------------------------------------------------------ the tenant client file → import_clients rows */
  var IMPORT_COLS = {
    client_number: ['client_number', 'clientnumber', 'clientcode', 'customernumber', 'customercode', 'code', 'رقمالعميل', 'كودالعميل', 'رمزالعميل', 'الرقم'],
    name: ['name', 'namear', 'arabicname', 'clientname', 'customername', 'الاسم', 'اسمالعميل', 'الاسمالعربي', 'العميل', 'اسمالعميلبالعربي'],
    name_en: ['nameen', 'englishname', 'الاسمبالانجليزي', 'الاسمبالانجليزيه', 'الاسمالانجليزي', 'اسمالعميلبالانجليزي'],
    vat_number: ['vat', 'vatnumber', 'vatno', 'taxnumber', 'الرقمالضريبي', 'رقمضريبي'],
    cr_number: ['cr', 'crnumber', 'crno', 'commercialregistration', 'السجلالتجاري', 'رقمالسجلالتجاري', 'سجلتجاري'],
    phone: ['phone', 'mobile', 'phonenumber', 'الجوال', 'الهاتف', 'رقمالجوال', 'جوال', 'هاتف'],
    email: ['email', 'emailaddress', 'البريد', 'البريدالالكتروني', 'الايميل'],
    city: ['city', 'المدينه', 'المدينة'],
    port_category: ['portcategory', 'category', 'التصنيف', 'الفئه', 'الفئة']
  };
  var CATEGORY = { airport: 'airport', 'مطار': 'airport', port: 'port', 'ميناء': 'port', shared: 'shared', 'مشترك': 'shared', 'مشتركه': 'shared' };
  function headerKey(h) {
    var s = western(h).toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/[\s_\-./():#*'"]+/g, '');
    for (var k in IMPORT_COLS) if (Object.prototype.hasOwnProperty.call(IMPORT_COLS, k)) {
      var list = IMPORT_COLS[k].map(function (x) { return x.replace(/ة/g, 'ه'); });
      if (list.indexOf(s) !== -1 || s === k.replace(/_/g, '')) return k;
    }
    return null;
  }
  // rows2d: string[][] with the titles in row 0 → { rows, unknown:[titles], skipped, error: null | dict key }
  function mapImportRows(rows2d) {
    var all = Array.isArray(rows2d) ? rows2d : [];
    var first = -1;
    for (var i = 0; i < all.length; i++) { if ((all[i] || []).some(function (c) { return String(c == null ? '' : c).trim() !== ''; })) { first = i; break; } }
    if (first === -1) return { rows: [], unknown: [], skipped: 0, error: 'im_file_e_empty' };
    var heads = all[first].map(function (h) { return String(h == null ? '' : h).trim(); });
    var cols = heads.map(headerKey), unknown = [];
    heads.forEach(function (h, j) { if (h && !cols[j]) unknown.push(h); });
    if (cols.indexOf('name') === -1) return { rows: [], unknown: unknown, skipped: 0, error: 'im_file_e_name' };
    var out = [], skipped = 0;
    for (var r = first + 1; r < all.length; r++) {
      var line = all[r] || [], row = {}, any = false;
      cols.forEach(function (k, j) {
        if (!k || row[k] != null) return;
        var v = String(line[j] == null ? '' : line[j]).trim();
        if (!v) return;
        if (k === 'port_category') { v = CATEGORY[v.toLowerCase().replace(/ة/g, 'ه')] || CATEGORY[v.toLowerCase()] || null; if (!v) return; }
        if (k === 'vat_number' || k === 'cr_number' || k === 'phone' || k === 'client_number') v = western(v);
        row[k] = v.slice(0, k === 'email' ? 160 : k === 'name' || k === 'name_en' ? 160 : 80);
        any = true;
      });
      if (!any) { skipped++; continue; }
      out.push(row);
    }
    if (!out.length) return { rows: [], unknown: unknown, skipped: skipped, error: 'im_file_e_empty' };
    if (out.length > 2000) return { rows: [], unknown: unknown, skipped: skipped, error: 'im_file_e_many' };
    return { rows: out, unknown: unknown, skipped: skipped, error: null };
  }
  // a File → Promise<string[][]> (CSV by text, XLSX by XlsxLite) — rejects with a dict key
  function readTable(file) {
    var X = window.XlsxLite;
    var name = String(file && file.name || '').toLowerCase();
    var isX = /\.xlsx$/.test(name), isC = /\.(csv|txt|tsv)$/.test(name);
    if (!file || (!isX && !isC)) return Promise.reject('im_file_e_type');
    if (!X || typeof file.arrayBuffer !== 'function') return Promise.reject('im_file_e_read');
    return file.arrayBuffer().then(function (buf) {
      if (isX) {
        if (typeof X.canRead === 'function' && !X.canRead()) throw 'im_file_e_xlsx';
        return X.read(buf).then(function (wb) { return (wb && wb.sheets && wb.sheets[0] && wb.sheets[0].rows) || []; });
      }
      return X.parseDelimited(X.decodeText(buf)).rows;
    }).catch(function (e) { throw typeof e === 'string' ? e : 'im_file_e_read'; });
  }

  /* ------------------------------------------------------------------ review items of step 7 */
  var REVIEW_KINDS = ['manual_in_daftra', 'date_mismatch', 'readback_mismatch', 'client_mismatch', 'opening_blocked'];
  // resolve_daftra_review: the decisions per kind and the role each needs ('write' = finance writer, 'approve' = approver)
  var REVIEW_DECISIONS = {
    manual_in_daftra: [['done_in_daftra', 'write'], ['dismiss', 'approve']],
    date_mismatch: [['acknowledge', 'approve']], readback_mismatch: [['acknowledge', 'approve']], client_mismatch: [['acknowledge', 'approve']],
    opening_blocked: [['dismiss', 'write']]
  };
  function decisionsFor(kind, can) {
    can = can || {};
    return (REVIEW_DECISIONS[kind] || []).filter(function (d) { return d[1] === 'write' ? can.write : can.approve; }).map(function (d) { return d[0]; });
  }
  function money(n) { return n == null || n === '' || isNaN(+n) ? T('none') : (+n).toFixed(2); }
  // → [{ text, tone?, lines?: [{ op: 'add'|'remove', text }] }] (plain strings only)
  function reviewLines(item) {
    var d = (item && item.details) || {}, out = [];
    if (!item) return out;
    if (item.kind === 'manual_in_daftra') {
      out.push({ text: T('rv_manual_intro', { n: d.daftra_number || d.external_invoice_id || T('none') }) });
      (d.add || []).forEach(function (x) {
        out.push({ op: 'add', text: T('rv_manual_add') + ': ' + T('rv_line', { d: x.description || x.line_ref || T('none'), a: money(x.total_amount) })
          + (x.product_code ? ' · ' + T('rv_line_code', { c: x.product_code }) : '') });
      });
      (d.remove || []).forEach(function (x) {
        out.push({ op: 'remove', text: T('rv_manual_remove') + ': ' + T('rv_line', { d: x.description || x.line_ref || T('none'), a: money(x.total_amount) }) });
      });
    } else if (item.kind === 'date_mismatch') {
      out.push({ text: T('rv_date', { e: d.expected || T('none'), s: d.stored || T('none') }) });
    } else if (item.kind === 'readback_mismatch') {
      out.push({ text: T('rv_readback_fields', { list: (d.fields || []).map(fieldLabel).join(sep()) || T('none') }) });
    } else if (item.kind === 'client_mismatch') {
      out.push({ text: T('rv_client', { r: d.remote_client_id || T('none'), l: d.linked_client_id || T('none') }) });
    } else if (item.kind === 'opening_blocked') {
      out.push({ text: T('rv_opening', { reason: openingReason(d) }) });
    }
    return out;
  }

  /* ------------------------------------------------------------------ opening draft */
  function openingReason(d) {
    var r = (d && d.reason) || 'error';
    var s = has('op_reason_' + r) ? T('op_reason_' + r) : r;
    if (d && d.fields) s += ' (' + String(d.fields).split(',').map(function (x) { return fieldLabel(x.trim()); }).join(sep()) + ')';
    return s;
  }
  // tx_billing → { state: off | queued | blocked | none, reason?, intent? }
  function openingState(d) {
    d = d || {};
    var conn = d.connection || {}, op = d.opening || {};
    var intent = (d.intents || []).filter(function (i) { return i && i.id === op.intent_id; })[0] || null;
    if (op.intent_id) return { state: 'queued', intent: intent, ref: intent ? intent.operational_ref : null };
    if (op.blocked) return { state: 'blocked', reason: openingReason(op.blocked), details: op.blocked };
    if (!conn.auto_draft_on_declaration) return { state: 'off' };
    return { state: 'none' };
  }

  /* ------------------------------------------------------------------ invoice candidates (confirm_invoice_link) */
  function alnum(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
  function numberMatches(typed, cand) {
    var want = alnum(cand && (cand.daftra_number || cand.external_invoice_id));
    return !!want && alnum(western(typed)) === want;
  }
  function check3(v) { return v === true ? 'ok' : v === false ? 'bad' : 'missing'; }
  // the side-by-side rows of a candidate: m = { client, declaration_nos[], bl_numbers[], containers[] } (Marsa values)
  function compareRows(c, m) {
    c = c || {}; m = m || {};
    var f = c.fields || {}, match = c.match || {};
    var list = function (a) { return (a || []).filter(Boolean).join(sep()) || null; };
    return [
      { field: 'client', marsa: m.client || null, daftra: c.client_name || c.remote_client_id || null,
        check: c.client_check === 'ok' ? 'ok' : c.client_check === 'conflict' ? 'bad' : 'missing', note: 'tx_client_' + (c.client_check || 'unlinked') },
      { field: 'decl', marsa: list(m.declaration_nos), daftra: f.declaration_no || null, check: check3(match.declaration) },
      { field: 'bl', marsa: list(m.bl_numbers), daftra: f.bl || null, check: check3(match.bl) },
      { field: 'ctr', marsa: list(m.containers), daftra: list(f.containers), check: check3(match.containers) },
      { field: 'ref', marsa: m.ref || null, daftra: c.po_number || null, check: null },
      { field: 'date', marsa: null, daftra: c.invoice_date || null, check: null },
      { field: 'total', marsa: null, daftra: c.total != null ? money(c.total) + ' ' + (c.currency || 'SAR') : null, check: null },
      { field: 'state', marsa: null, daftra: remoteState(c.remote_state || c.daftra_status || null), check: null }
    ];
  }

  // Daftra's invoice state (draft / issued / cancelled) → its label; anything else stays as Daftra wrote it
  function remoteState(v) { return v && has('rstate_' + v) ? T('rstate_' + v) : v; }

  /* ------------------------------------------------------------------ dates / links */
  // today as YYYY-MM-DD in Asia/Riyadh (never UTC, never the device zone)
  function riyadhToday(now) {
    var d = now == null ? new Date() : new Date(+now);
    try {
      var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
      var g = {}; p.forEach(function (x) { g[x.type] = x.value; });
      if (g.year && g.month && g.day) return g.year + '-' + g.month + '-' + g.day;
    } catch (e) { /* fall back to the fixed UTC+3 offset (Riyadh has no DST) */ }
    return new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 10);
  }
  function safeUrl(u) { return typeof u === 'string' && /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9_./?=&%-]*)?$/.test(u) ? u : null; }

  /* ------------------------------------------------------------------ remembered runs (per viewer convenience only) */
  var RUN_KEY = 'marsa.dft.runs.';
  function rememberRun(orgId, run) {
    if (!orgId || !run || !run.id) return;
    try {
      var k = RUN_KEY + orgId, list = JSON.parse(window.localStorage.getItem(k) || '[]');
      if (!Array.isArray(list)) list = [];
      list = list.filter(function (x) { return x && x.id !== run.id; });
      list.unshift({ id: run.id, kind: run.kind || null, at: run.created_at || new Date().toISOString() });
      window.localStorage.setItem(k, JSON.stringify(list.slice(0, 8)));
    } catch (e) { /* storage blocked: the run is still shown now */ }
  }
  function recallRuns(orgId, kinds) {
    try {
      var list = JSON.parse(window.localStorage.getItem(RUN_KEY + orgId) || '[]');
      return (Array.isArray(list) ? list : []).filter(function (x) { return x && /^[0-9a-f-]{36}$/i.test(x.id) && (!kinds || kinds.indexOf(x.kind) !== -1); });
    } catch (e) { return []; }
  }

  /* ------------------------------------------------------------------ DOM helpers (own tiny el: also used on ocr.html) */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k === 'hidden') n.hidden = true;
      else if (k === 'disabled') n.disabled = true;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return n;
  }
  // api: the opsApi (api.MarsaApi) or the MarsaApi object itself
  function call(api, name) {
    var args = Array.prototype.slice.call(arguments, 2);
    var M = api && api.MarsaApi ? api.MarsaApi : api;
    if (!M || typeof M[name] !== 'function') return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', fn: name, message: name } });
    return Promise.resolve().then(function () { return M[name].apply(M, args); })
      .then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
  }
  function errMsg(api, e) {
    if (api && typeof api.errText === 'function') { try { return api.errText(e); } catch (x) { /* fall through */ } }
    var M = api && api.MarsaApi ? api.MarsaApi : api;
    if (M && typeof M.errorMessage === 'function') { try { var s = M.errorMessage(e); if (s) return s; } catch (x) { /* fall through */ } }
    return (e && e.message) || String(e || '');
  }
  function errNode(e, cls) {
    if (!e) return null;
    var o = typeof e === 'string' ? { code: e } : e;
    return el('span', { class: 'dft-err ' + (cls || 'adm-sub text-danger'), 'data-code': errorCode(o), title: T('err_code_label', { c: String(o.code || o.kind || '') }) }, errorText(o));
  }
  // the opening-draft note of the declaration screens (decl-review.js result, the #tx declarations card): finance only,
  // silent for others (the server refuses tx_billing) — never blocks the declaration screen
  function openingNote(api, txId, o) {
    o = o || {};
    var box = el('p', { class: 'dft-opening-note ' + (o.cls || 'form-hint'), 'data-dft': 'opening-note', 'aria-live': 'polite', hidden: true });
    if (!txId) return box;
    call(api, 'txBilling', txId).then(function (r) {
      // review: o.host (e.g. the <li> of the ocr.html result list) stays hidden until the note has text
      if (!r || r.error || !r.data) { if (o.hiddenText) { box.textContent = T('op_hidden'); box.hidden = false; if (o.host) o.host.hidden = false; } return; }
      var s = openingState(r.data);
      var key = s.state === 'queued' ? 'op_decl_queued' : s.state === 'blocked' ? 'op_decl_blocked' : s.state === 'off' ? 'op_decl_off' : null;
      if (!key && (r.data.intents || []).some(function (i) { return i && i.status !== 'cancelled' && i.purpose === 'final'; })) key = 'op_decl_exists';
      if (!key) return;
      box.setAttribute('data-state', s.state);
      box.textContent = T(key, { reason: s.reason || '' });
      box.hidden = false;
      if (o.host) o.host.hidden = false;
    });
    return box;
  }

  /* --- supplier search on a trip (movements section): read-only, the link is stored only on a single exact match --- */
  var SUP_RUNS = 'marsa.dft.sup.';
  function supRun(tripId, runId) {
    try {
      if (runId) window.localStorage.setItem(SUP_RUNS + tripId, runId);
      var v = window.localStorage.getItem(SUP_RUNS + tripId);
      return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
    } catch (e) { return runId || null; }
  }
  function supplierDialog(api, tx, m) {
    var U = Ops.ui;
    if (!U || !m || !m.trip_id) return Promise.resolve(null);
    var name = m.party_name || '';
    var runId = supRun(m.trip_id);
    return Promise.all([call(api, 'listDaftraSupplierLinks'), runId ? call(api, 'getDaftraRun', runId) : Promise.resolve(null)]).then(function (res) {
      var links = res[0] && !res[0].error ? ((res[0].data && res[0].data.items) || []) : [];
      var norm = function (s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); };
      // review: a name-only link is keyed on the party name (name_norm), the Daftra name may be its secondary name
      var link = links.filter(function (l) { return (m.carrier_id && l.party_id === m.carrier_id) || (!l.party_id && (norm(l.name) === norm(name) || (l.name_norm && l.name_norm === norm(name)))); })[0] || null;
      var run = res[1] && !res[1].error ? res[1].data : null;
      var canUnlink = !!(link && api && typeof api.can === 'function' && api.can('billAdmin'));
      var unlinkB = canUnlink ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-act': 'dft-sup-unlink', text: T('sup_unlink') }) : null;
      if (unlinkB) unlinkB.addEventListener('click', function (e) {
        e.preventDefault();
        U.formModal({
          title: T('sup_unlink_title', { id: link.external_supplier_id }), size: 'sm', intro: T('sup_unlink_text'), submitText: T('sup_unlink'), danger: true,
          fields: [{ name: 'reason', label: T('sup_unlink_reason'), type: 'textarea', required: true, max: 2000 }],
          validate: function (v) { return String(v.reason || '').trim().length < 3 ? { reason: T('required') } : null; },
          submit: function (v) { return call(api, 'unlinkDaftraSupplier', link.id, String(v.reason).trim()); }
        }).then(function (ok) { if (ok) U.toast(api, T('sup_unlinked'), 'success'); });
      });
      var intro = el('div', { class: 'dft-sup-intro' }, [
        el('p', { class: 'ops-modal-intro', text: T('sup_party', { t: m.party_type ? (api.label ? api.label('transport_party_type', m.party_type) : m.party_type) : T('none'), n: name || T('none') }) }),
        m.transport_order_no ? el('p', { class: 'form-hint' }, [T('sup_order', { o: '' }), el('bdi', { dir: 'ltr', text: m.transport_order_no })]) : null,
        !m.party_type ? el('p', { class: 'form-hint', text: T('sup_party_missing') }) : null,
        el('p', { class: link ? 'dft-sup-linked text-success' : 'dft-sup-unlinked form-hint', 'data-dft': link ? 'sup-linked' : 'sup-unlinked',
          text: link ? T('sup_linked', { id: link.external_supplier_id, name: link.name }) : T('sup_not_linked') }),
        unlinkB,
        el('p', { class: 'form-hint', 'data-dft': 'sup-key', text: T('sup_key_hint', { n: name || T('none') }) })
      ]);
      if (run && run.result && Array.isArray(run.result.suppliers)) {
        intro.appendChild(el('p', { class: 'form-label', text: T('sup_results', { n: run.result.suppliers.length }) }));
        intro.appendChild(el('ul', { class: 'dft-sup-list' }, run.result.suppliers.slice(0, 20).map(function (s) {
          return el('li', null, [el('span', { text: s.name || T('none') }), ' · ', el('bdi', { dir: 'ltr', text: [s.external_supplier_id, s.supplier_number].filter(Boolean).join(' / ') })]);
        })));
        intro.appendChild(el('p', { class: 'form-hint', text: run.result.exact_match ? T('sup_exact') : T('sup_not_exact') }));
      } else if (run && run.status && run.status !== 'done') {
        intro.appendChild(el('p', { class: 'form-hint', text: T('run_st_' + run.status) + (run.error_code ? ' · ' + errorText({ code: run.error_code, message: run.error_message }) : '') }));
      }
      return U.formModal({
        title: T('sup_title', { name: name || T('none') }), size: 'sm', intro: intro, submitText: T('sup_search'),
        fields: [{ name: 'q', label: T('sup_q'), required: true, max: 160, value: name, hint: T('sup_q_hint') }],
        validate: function (v) { return v.q.length < 2 ? { q: T('required') } : null; },
        submit: function (v) {
          var p = { trip_id: m.trip_id, q: v.q }, scope = 'dft-sup-' + m.trip_id, key = U.idemKey(api, scope, p);
          return call(api, 'requestDaftraSupplierSearch', p, { idemKey: key }).then(function (r) {
            U.idemSettle(scope, r.error);
            if (!r.error && r.data && r.data.id) supRun(m.trip_id, r.data.id);
            return r;
          });
        }
      }).then(function (ok) { if (ok) U.toast(api, T('sup_queued'), 'success'); return ok; });
    });
  }
  // the Daftra buttons of a movement row (trip carried by a supplier / company)
  function tripActions(api, tx, m) {
    if (!m || !m.trip_id || !tx || ['supplier', 'company'].indexOf(m.party_type) === -1 || m.movement_status === 'cancelled') return [];
    var ok = api && typeof api.can === 'function' && (api.can('transportWriter', tx.branch_id) || api.can('finWrite', tx.branch_id));
    if (!ok) return [];
    var b = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-act': 'dft-supplier', text: T('sup_btn') });
    b.addEventListener('click', function (e) { e.preventDefault(); supplierDialog(api, tx, m); });
    return [b];
  }

  Ops.dftKit = {
    VERSION: 'dft-ui-1', t: T, has: has, el: el, call: call, errMsg: errMsg, errNode: errNode,
    ERROR_CODES: ERROR_CODES, ERROR_ALIASES: ERROR_ALIASES, CUSTOM_FIELDS: CUSTOM_FIELDS, DECL_TYPES: DECL_TYPES, TYPE_DEFAULTS: TYPE_DEFAULTS,
    REVIEW_KINDS: REVIEW_KINDS, REVIEW_DECISIONS: REVIEW_DECISIONS, KEY_RE: KEY_RE, CODE_RE: CODE_RE, IMPORT_COLS: IMPORT_COLS,
    errorCode: errorCode, errorFields: errorFields, errorText: errorText, fieldLabel: fieldLabel,
    accountView: accountView, accountReason: accountReason, isSaudiCountry: isSaudiCountry,
    western: western, codeNorm: codeNorm, productState: productState, exactCandidates: exactCandidates, unmappedKeys: unmappedKeys,
    customMapPayload: customMapPayload, headerKey: headerKey, mapImportRows: mapImportRows, readTable: readTable,
    decisionsFor: decisionsFor, reviewLines: reviewLines, openingReason: openingReason, openingState: openingState,
    numberMatches: numberMatches, compareRows: compareRows, riyadhToday: riyadhToday, safeUrl: safeUrl,
    rememberRun: rememberRun, recallRuns: recallRuns, openingNote: openingNote, supplierDialog: supplierDialog, tripActions: tripActions
  };
})();
