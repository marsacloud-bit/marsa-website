/* ==========================================================================
   مرسى | MARSA — legacy step 8: monthly Fasah reconciliation  →  #fasah_recon (MarsaOps.views.fasah_recon)
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_REPORTS_AR.md §8 (report_fasah_scope, 20261124000100). Legacy:
   FasahMonthlyReconciliation_*.js analyzeFasahMonthlyReportsR116 / fasahR116FindHeaderRow_ / fasahR116MapPort_ /
   fasahR116Compare_ / fasahR116BuildPortSummaries_; Index.html fasahReconciliationPage.

   * The files never leave the browser (owner decision 2026-11-11 (6)): up to 20 .xlsx files, each ≤ 10 MB, read with
     XlsxLite (assets/js/xlsx-lite.js: cached cell values only — a formula is never evaluated), at most 50 000 rows per
     file and 20 000 records in all. The header row is found in the first 10 rows (declaration no., date, port,
     importer, status are required; serial, movement info, total fees, payment no. are optional).
   * Ports are mapped to the customs_ports codes (SAJED, SADMM, SAKAC, SARUH, SAJED-AIR, SADMM-AIR, SARUH-AIR); rows are
     de-duplicated by the document serial (else declaration + port + date + importer). Only the declaration numbers
     and the port / month scopes go to the server: reportFasahScope(nos, scopes) under RLS, read-only.
   * Statuses (domain fasah_match_status): matched, matched_with_note (date / importer differ), status_mismatch (Fasah
     «فسح كلي» while the system stage is not released), missing, port_mismatch, ambiguous (several system records for
     the same number + port and no single one with the same date), system_only (in scope in the system, not in the files).
   * Summaries per port / month and per file; the result is exportable (XLSX / CSV / print), audited first with
     logReportExport({report: 'fasah_recon', filters: {months, port_codes, files, statuses}, row_count}).
   * Pure helpers on MarsaOps.fasahRecon (tests). Strings: 'lrpt'. Data → textContent / createElement only.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var LIMITS = { files: 20, fileBytes: 10 * 1024 * 1024, rowsPerFile: 50000, records: 20000, scopes: 100, headerScan: 10,
    // what one untrusted .xlsx may expand to inside XlsxLite (zip bomb / far cell references stop there, before memory fills)
    inflateBytes: 64 * 1024 * 1024, cols: 256 };
  var STATUSES = ['matched', 'matched_with_note', 'status_mismatch', 'missing', 'port_mismatch', 'ambiguous', 'system_only'];
  var FOUND = { matched: 1, matched_with_note: 1, status_mismatch: 1 };
  var TONES = { matched: 'success', matched_with_note: 'info', status_mismatch: 'warning', missing: 'danger', port_mismatch: 'warning', ambiguous: 'warning', system_only: 'neutral' };
  var PORT_CODES = ['SAJED', 'SADMM', 'SAKAC', 'SARUH', 'SAJED-AIR', 'SADMM-AIR', 'SARUH-AIR'];

  /* ------------------------------------------------------------------ pure helpers (legacy fasahR116*) */
  function str(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
  function westDigits(s) {
    return String(s == null ? '' : s).replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 1632); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 1776); });
  }
  function normArabic(v) {
    return str(westDigits(v)).toLowerCase()
      .replace(/[ً-ٰٟۖ-ۭ]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ـ/g, '')
      .replace(/[^؀-ۿ0-9a-z]+/gi, ' ').replace(/\s+/g, ' ').trim();
  }
  function normHeader(v) { return normArabic(v).replace(/[^0-9a-z؀-ۿ]+/gi, ''); }
  // digits only (Arabic-Indic too), leading zeros dropped ('0' stays) — the server's app.rpt_digits_no
  function cleanDigits(v) {
    var d = westDigits(v).replace(/\D/g, '');
    return d ? (d.replace(/^0+/, '') || '0') : '';
  }
  function isReleased(v) { return normArabic(v).indexOf('فسح كلي') !== -1; }
  function mapPort(v) {
    var raw = str(v), up = raw.toUpperCase();
    if (PORT_CODES.indexOf(up) !== -1) return up;
    var x = normArabic(raw);
    if (!x) return '';
    function has(s) { return x.indexOf(s) !== -1; }
    if (has('ميناء جده الاسلامي') || has('جمرك جده الاسلامي') || has('jeddah islamic')) return 'SAJED';
    if (has('الملك عبدالعزيز') && has('الدمام') && (has('ميناء') || has('بحري'))) return 'SADMM';
    if (has('ميناء الملك عبدالله') || (has('الملك عبدالله') && has('رابغ'))) return 'SAKAC';
    if (has('الرياض الجاف') || has('riyadh dry')) return 'SARUH';
    if (has('الملك عبدالعزيز') && (has('مطار') || has('جوي'))) return 'SAJED-AIR';
    if (has('الملك فهد') && (has('مطار') || has('جوي'))) return 'SADMM-AIR';
    if (has('الملك خالد') && (has('مطار') || has('جوي'))) return 'SARUH-AIR';
    return '';
  }
  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  // dd/mm/yyyy · yyyy-mm-dd · an Excel serial → 'YYYY-MM-DD' (a date only: never shifted by a time zone)
  function normDate(v) {
    var s = str(westDigits(v));
    if (!s) return '';
    var m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s);
    if (m) return m[3] + '-' + pad(m[2]) + '-' + pad(m[1]);
    m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:[ T].*)?$/.exec(s);
    if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    var n = Number(s);
    if (isFinite(n) && n > 20000 && n < 80000) {
      var d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }
    return '';
  }
  function validDay(s) { return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s); }
  function namesCompatible(a, b) {
    var l = normArabic(a), r = normArabic(b);
    if (!l || !r) return true;
    if (l === r || l.indexOf(r) !== -1 || r.indexOf(l) !== -1) return true;
    function strip(t) { return (' ' + t + ' ').replace(/ (شركه|مؤسسه|مكتب|للتجاره|التجاريه|شركة|مؤسسة|co|ltd|company|est) /g, ' ').replace(/\s+/g, ' ').trim(); }
    l = strip(l); r = strip(r);
    return l === r || (!!l && !!r && (l.indexOf(r) !== -1 || r.indexOf(l) !== -1));
  }
  function money(v) { var n = Number(String(v == null ? '' : westDigits(v)).replace(/,/g, '')); return isFinite(n) ? Math.round(n * 100) / 100 : 0; }
  // the header row in the first rows: {rowIndex, columns} | null
  function findHeader(rows) {
    var limit = Math.min((rows || []).length, LIMITS.headerScan);
    for (var i = 0; i < limit; i++) {
      var row = rows[i] || [], c = {};
      for (var j = 0; j < row.length; j++) {
        var k = normHeader(row[j]);
        if (!k) continue;
        if (k.indexOf('رقمالوثيقهالتسلسلي') !== -1) { if (c.serial == null) c.serial = j; }
        else if (k.indexOf('رقمالتصريح') !== -1 || k.indexOf('رقمالبيان') !== -1) { if (c.declarationNo == null) c.declarationNo = j; }
        else if (k.indexOf('تاريخالتصريح') !== -1 || k.indexOf('تاريخالبيان') !== -1) { if (c.declarationDate == null) c.declarationDate = j; }
        else if (k.indexOf('ميناءالتصريح') !== -1 || k.indexOf('منفذالتصريح') !== -1) { if (c.port == null) c.port = j; }
        else if (k.indexOf('اسمالمستورد') !== -1) { if (c.importer == null) c.importer = j; }
        else if (k.indexOf('رقماذنالتسليم') !== -1 || k.indexOf('معلوماتقيدالحركه') !== -1 || k.indexOf('رقمالمانيفست') !== -1) { if (c.movementInfo == null) c.movementInfo = j; }
        else if (k === 'حاله' || k === 'الحاله' || k.indexOf('حالهالبيان') !== -1) { if (c.status == null) c.status = j; }
        else if (k.indexOf('رسومالبيانالاجماليه') !== -1) { if (c.totalFees == null) c.totalFees = j; }
        else if (k.indexOf('رقمالدفع') !== -1 || k.indexOf('رقمالسداد') !== -1) { if (c.paymentNo == null) c.paymentNo = j; }
      }
      if (c.declarationNo != null && c.declarationDate != null && c.port != null && c.importer != null && c.status != null) return { rowIndex: i, columns: c };
    }
    return null;
  }
  function at(row, i) { return i == null ? '' : str(row[i]); }
  // one sheet's rows → {records, summary} | {error: code}
  function parseRows(rows, fileName) {
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.length) return { error: 'empty' };
    if (rows.length > LIMITS.rowsPerFile + LIMITS.headerScan) return { error: 'too_many_rows' };
    var h = findHeader(rows);
    if (!h) return { error: 'no_header' };
    var c = h.columns, out = [], skipped = 0;
    for (var i = h.rowIndex + 1; i < rows.length; i++) {
      var row = rows[i] || [], no = cleanDigits(row[c.declarationNo]);
      if (!no) { if (row.some(function (x) { return str(x) !== ''; })) skipped++; continue; }
      if (no.length > 40) { skipped++; continue; }
      var rawPort = at(row, c.port), date = normDate(row[c.declarationDate]);
      if (date && !validDay(date)) date = '';
      out.push({ file: fileName, row: i + 1, serial: at(row, c.serial), declarationNo: no, declarationDate: date, month: date ? date.slice(0, 7) : '',
        rawPort: rawPort, port: mapPort(rawPort), importer: at(row, c.importer), movementInfo: at(row, c.movementInfo), fasahStatus: at(row, c.status),
        totalFees: money(at(row, c.totalFees)), paymentNo: at(row, c.paymentNo) });
    }
    if (!out.length) return { error: 'no_records' };
    var ports = uniq(out.map(function (r) { return r.port || r.rawPort; })), months = uniq(out.map(function (r) { return r.month; }));
    var released = out.filter(function (r) { return isReleased(r.fasahStatus); }).length;
    return { records: out, summary: { file: fileName, records: out.length, headerRow: h.rowIndex + 1, skipped: skipped, ports: ports, months: months, released: released, pending: out.length - released } };
  }
  function uniq(list) { var seen = Object.create(null), out = [];   // file text as keys: no prototype ('__proto__', 'constructor')
    (list || []).forEach(function (v) { var k = str(v); if (k && !seen[k]) { seen[k] = 1; out.push(k); } }); return out; }
  function dedupe(records) {
    var seen = Object.create(null), out = [], dup = 0;
    (records || []).forEach(function (r) {
      var serial = cleanDigits(r.serial);
      var key = serial ? 'S|' + serial : 'F|' + [r.declarationNo, r.port || r.rawPort, r.declarationDate, normArabic(r.importer)].join('|');
      if (seen[key]) { dup++; return; }
      seen[key] = 1; out.push(r);
    });
    return { records: out, duplicates: dup };
  }
  // what goes to the server: the numbers and the port / month scopes (nothing else from the files)
  function request(records) {
    var nos = uniq((records || []).map(function (r) { return r.declarationNo; }));
    var sc = Object.create(null), scopes = [];
    (records || []).forEach(function (r) { if (r.port && r.month) { var k = r.port + '|' + r.month; if (!sc[k]) { sc[k] = 1; scopes.push({ port_code: r.port, month: r.month }); } } });
    scopes.sort(function (a, b) { return a.month < b.month ? -1 : a.month > b.month ? 1 : a.port_code < b.port_code ? -1 : 1; });
    return { nos: nos, scopes: scopes };
  }
  function sysNo(x) { return cleanDigits(x.declaration_no_norm || x.declaration_no); }
  function sysMonth(x) { return x.month || (x.declaration_date ? String(x.declaration_date).slice(0, 7) : ''); }
  // records (from the files, de-duplicated) × the server's records → statuses, summaries
  function compare(records, system) {
    // a cancelled transaction still matches its number (it is not «missing»), but is never «system only»
    var sys = (system || []).filter(function (x) { return x && sysNo(x); });
    var byNoPort = Object.create(null), byNo = Object.create(null);
    sys.forEach(function (x) {
      var no = sysNo(x), k = no + '|' + (x.port_code || '');
      (byNoPort[k] = byNoPort[k] || []).push(x);
      (byNo[no] = byNo[no] || []).push(x);
    });
    var matchedIds = Object.create(null), scopeKeys = Object.create(null);
    var rows = (records || []).map(function (r) {
      if (r.port && r.month) scopeKeys[r.port + '|' + r.month] = 1;
      var cands = r.port ? (byNoPort[r.declarationNo + '|' + r.port] || []) : [], match = null, status = '', notes = [];
      if (cands.length === 1) match = cands[0];
      else if (cands.length > 1) {
        var same = cands.filter(function (x) { return r.declarationDate && String(x.declaration_date || '').slice(0, 10) === r.declarationDate; });
        if (same.length === 1) match = same[0]; else { status = 'ambiguous'; notes.push('ambiguous'); }
      } else if ((byNo[r.declarationNo] || []).length) { status = 'port_mismatch'; notes.push(r.port ? 'port' : 'port_unknown'); }
      else { status = 'missing'; notes.push('missing'); }
      if (match) {
        matchedIds[match.transaction_id + '|' + (match.declaration_id || '')] = 1;
        var sd = String(match.declaration_date || '').slice(0, 10);
        var dateOk = !r.declarationDate || !sd || r.declarationDate === sd;
        var nameOk = namesCompatible(r.importer, match.client_name);
        if (!dateOk) notes.push('date');
        if (!nameOk) notes.push('importer');
        if (isReleased(r.fasahStatus) && match.declaration_status !== 'released') { notes.push('released'); status = 'status_mismatch'; }
        else if (!status) status = (!dateOk || !nameOk) ? 'matched_with_note' : 'matched';
      }
      var ambig = status === 'ambiguous' ? cands : (status === 'port_mismatch' ? (byNo[r.declarationNo] || []) : []);
      return Object.assign({}, r, { status: status || 'matched', notes: notes, system: match || null,
        others: ambig.slice(0, 5).map(function (x) { return { transaction_id: x.transaction_id, ref: x.ref, port_code: x.port_code }; }) });
    });
    var inScope = sys.filter(function (x) { return !x.cancelled && (x.in_scope === true || (x.in_scope == null && !!scopeKeys[(x.port_code || '') + '|' + sysMonth(x)])); });
    var sysOnly = inScope.filter(function (x) { return !matchedIds[x.transaction_id + '|' + (x.declaration_id || '')]; });
    var by = {}; STATUSES.forEach(function (s) { by[s] = 0; });
    rows.forEach(function (x) { by[x.status]++; });
    by.system_only = sysOnly.length;
    var released = rows.filter(function (x) { return isReleased(x.fasahStatus); }).length;
    var summary = {
      fasahTotal: rows.length, systemScope: inScope.length, found: rows.filter(function (x) { return FOUND[x.status]; }).length, missing: by.missing,
      systemOnly: sysOnly.length, released: released, pending: rows.length - released,
      releasedNotInSystem: rows.filter(function (x) { return x.status === 'status_mismatch'; }).length,
      unknownPort: rows.filter(function (x) { return !x.port; }).length, ambiguous: by.ambiguous, portMismatch: by.port_mismatch, byStatus: by
    };
    // per port / month (legacy fasahR116BuildPortSummaries_)
    var map = Object.create(null);
    function slot(port, month, raw) {
      var k = (port || ('?' + (raw || ''))) + '|' + (month || '');
      if (!map[k]) map[k] = { port: port || '', rawPort: port ? '' : (raw || ''), month: month || '', fasahTotal: 0, released: 0, pending: 0, found: 0, missing: 0, systemScope: 0, systemOnly: 0 };
      return map[k];
    }
    rows.forEach(function (x) {
      var s = slot(x.port, x.month, x.rawPort);
      s.fasahTotal++;
      if (isReleased(x.fasahStatus)) s.released++; else s.pending++;
      if (FOUND[x.status]) s.found++; else if (x.status === 'missing') s.missing++;
    });
    inScope.forEach(function (x) { slot(x.port_code, sysMonth(x)).systemScope++; });
    sysOnly.forEach(function (x) { slot(x.port_code, sysMonth(x)).systemOnly++; });
    var ports = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.month < b.month ? -1 : a.month > b.month ? 1 : (a.port || a.rawPort) < (b.port || b.rawPort) ? -1 : 1; });
    rows.sort(function (a, b) {
      if (a.declarationDate !== b.declarationDate) return a.declarationDate < b.declarationDate ? 1 : -1;
      return (+b.declarationNo || 0) - (+a.declarationNo || 0);
    });
    return { records: rows, systemOnly: sysOnly, summary: summary, ports: ports };
  }

  var PURE = { LIMITS: LIMITS, STATUSES: STATUSES, PORT_CODES: PORT_CODES, normArabic: normArabic, normHeader: normHeader, cleanDigits: cleanDigits, isReleased: isReleased,
    mapPort: mapPort, normDate: normDate, namesCompatible: namesCompatible, findHeader: findHeader, parseRows: parseRows, dedupe: dedupe, request: request, compare: compare };
  Ops.fasahRecon = PURE;

  /* ------------------------------------------------------------------ file reading */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      try {
        if (file && typeof file.arrayBuffer === 'function') { file.arrayBuffer().then(resolve, reject); return; }
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(fr.error || new Error('read')); };
        fr.readAsArrayBuffer(file);
      } catch (e) { reject(e); }
    });
  }
  // file → {records, summary} | {error, file}
  function parseFile(file) {
    var X = window.XlsxLite, name = str(file && file.name).slice(0, 120) || 'report.xlsx';
    if (!/\.xlsx$/i.test(name)) return Promise.resolve({ error: 'not_xlsx', file: name });
    if (!(file.size > 0)) return Promise.resolve({ error: 'empty', file: name });
    if (file.size > LIMITS.fileBytes) return Promise.resolve({ error: 'too_big', file: name });
    if (!X || typeof X.read !== 'function' || (typeof X.canRead === 'function' && !X.canRead())) return Promise.resolve({ error: 'no_reader', file: name });
    return readFile(file).then(function (buf) {
      if (X.sniff && X.sniff(buf) !== 'xlsx') return { error: 'not_xlsx', file: name };
      return X.read(buf, { maxInflateBytes: LIMITS.inflateBytes, maxRows: LIMITS.rowsPerFile + LIMITS.headerScan + 1, maxCols: LIMITS.cols }).then(function (wb) {
        var sh = (wb && wb.sheets || []).filter(function (s) { return !s.hidden && !s.chart; })[0];
        if (!sh) return { error: 'empty', file: name };
        var r = parseRows(sh.rows, name);
        if (r.error) r.file = name;
        return r;
      });
    }).then(null, function (e) {
      var code = e && e.code;
      if (code === 'too_big') return { error: 'inflate_big', file: name };   // the packed file was small; its content is not
      if (code === 'too_many_rows') return { error: 'too_many_rows', file: name };
      if (code === 'too_wide') return { error: 'too_wide', file: name };
      return { error: 'unreadable', file: name };
    });
  }
  // the files one after another (never 20 workbooks inflated at once)
  function parseFiles(list) {
    var out = [];
    return (list || []).reduce(function (p, f) { return p.then(function () { return parseFile(f).then(function (r) { out.push(r); }); }); }, Promise.resolve())
      .then(function () { return out; });
  }

  /* ------------------------------------------------------------------ the view */
  var LAST = null, LAST_ORG = null;   // the last result of LAST_ORG (survives navigation in this tab only; never stored, never shown to another org)
  function render(root, api) {
    var U = Ops.ui, K = window.MarsaExport && window.MarsaExport.kit && window.MarsaExport.kit();
    if (!U || !K) { while (root.firstChild) root.removeChild(root.firstChild); return; }
    K.use(api);
    var lt = K.lt, t = K.t, el = U.el, sc = U.scope(root);
    U.clear(root);
    root.classList.add('ops-view', 'rpt-view', 'lrpt-recon');
    root.appendChild(U.head(lt('fr_title'), lt('fr_sub')));
    root.appendChild(U.alertBox('info', lt('fr_privacy', { n: LIMITS.files, mb: LIMITS.fileBytes / 1048576 })));
    if (!K.hasFn(api, 'reportFasahScope')) { root.appendChild(U.alertBox('warning', t('api_missing', { fn: 'reportFasahScope' }))); return; }
    var files = [];
    var input = el('input', { type: 'file', id: 'fr-files', class: 'lrpt-file-input', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', multiple: true });
    var list = el('ul', { class: 'lrpt-file-list', 'aria-live': 'polite' });
    var err = el('p', { class: 'rpt-form-error', role: 'alert', hidden: true });
    var go = el('button', { type: 'button', class: 'btn btn-primary btn-sm fr-run', text: lt('fr_run') });
    var clear = el('button', { type: 'button', class: 'btn btn-ghost btn-sm fr-clear', text: lt('fr_clear') });
    var out = el('div', { class: 'app-stack lrpt-recon-out', 'aria-live': 'polite' });
    function showErr(msg) { err.hidden = !msg; err.textContent = msg || ''; }
    function paintFiles() {
      U.clear(list);
      files.forEach(function (f, i) {
        var rm = el('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': lt('fr_remove', { f: f.name }), text: lt('fr_remove_short') });
        rm.addEventListener('click', function (e) { e.preventDefault(); files.splice(i, 1); paintFiles(); });
        list.appendChild(el('li', null, [el('bdi', { dir: 'auto', class: 'lrpt-file-name', text: f.name }), el('span', { class: 'text-xs text-muted', text: ' · ' + lt('fr_size', { kb: Math.max(1, Math.round((f.size || 0) / 1024)) }) }), rm]));
      });
      go.disabled = !files.length;
    }
    function addFiles(fl) {
      var arr = Array.prototype.slice.call(fl || []), msg = null;
      arr.forEach(function (f) {
        if (!f) return;
        if (files.length >= LIMITS.files) { msg = lt('fr_err_files', { n: LIMITS.files }); return; }
        if (!/\.xlsx$/i.test(f.name || '')) { msg = lt('fr_err_not_xlsx', { f: str(f.name) }); return; }
        if (f.size > LIMITS.fileBytes) { msg = lt('fr_err_too_big', { f: str(f.name), mb: LIMITS.fileBytes / 1048576 }); return; }
        if (files.some(function (x) { return x.name === f.name && x.size === f.size; })) return;
        files.push(f);
      });
      showErr(msg);
      paintFiles();
    }
    input.addEventListener('change', function () { addFiles(input.files); try { input.value = ''; } catch (e) { /* ignore */ } });
    clear.addEventListener('click', function (e) { e.preventDefault(); files = []; LAST = null; paintFiles(); U.clear(out); showErr(null); });
    go.addEventListener('click', function (e) { e.preventDefault(); run(); });
    var drop = el('label', { class: 'lrpt-drop', for: 'fr-files' }, [el('span', { class: 'lrpt-drop-title', text: lt('fr_pick') }), el('span', { class: 'text-xs text-muted', text: lt('fr_pick_hint', { n: LIMITS.files, mb: LIMITS.fileBytes / 1048576 }) })]);
    ['dragover', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { if (e && e.preventDefault) e.preventDefault(); if (ev === 'drop' && e.dataTransfer) addFiles(e.dataTransfer.files); });
    });
    root.appendChild(U.card(lt('fr_files'), [drop, input, list, err, el('div', { class: 'rpt-form-actions' }, [go, clear])], null, { cls: 'lrpt-recon-files' }));
    root.appendChild(out);
    paintFiles();

    function run() {
      if (!files.length) return;
      showErr(null);
      go.disabled = true;
      U.loadingInto(out);
      var job = parseFiles(files).then(function (parsed) {
        var bad = parsed.filter(function (p) { return p.error; }), good = parsed.filter(function (p) { return !p.error; });
        var all = []; good.forEach(function (p) { all = all.concat(p.records); });
        if (!all.length) return { error: bad.length ? 'files' : 'no_records', bad: bad };
        if (all.length > LIMITS.records) return { error: 'too_many_records' };
        var dd = dedupe(all), req = request(dd.records);
        if (req.scopes.length > LIMITS.scopes) return { error: 'too_many_scopes' };
        return U.call(api, 'reportFasahScope', req.nos, req.scopes).then(function (r) {
          if (r.error) return { error: 'rpc', rpc: r.error };
          var d = r.data || {}, res = compare(dd.records, Array.isArray(d.records) ? d.records : []);
          res.summary.duplicates = dd.duplicates;
          res.summary.files = good.length;
          res.files = good.map(function (p) { return p.summary; });
          res.bad = bad;
          res.truncated = !!d.truncated;
          res.scopes = req.scopes;
          res.generatedAt = d.generated_at || new Date().toISOString();
          return res;
        });
      });
      var P = window.MarsaShell && window.MarsaShell.progress;
      var wait = P && typeof P.track === 'function' ? P.track('fasah_recon', job, { label: lt('fr_running') }) : job;
      return wait.then(function (res) {
        go.disabled = !files.length;
        if (!sc.alive()) return;
        U.doneLoading(out);
        if (res.error) {
          if (res.error === 'rpc') { out.appendChild(U.errorState(api, res.rpc, run)); return; }
          out.appendChild(U.alertBox('danger', lt('fr_err_' + res.error, { n: LIMITS.records, s: LIMITS.scopes })));
          (res.bad || []).forEach(function (b) { out.appendChild(U.alertBox('warning', lt('fr_file_err_' + b.error, { f: b.file, mb: LIMITS.fileBytes / 1048576, n: LIMITS.rowsPerFile }))); });
          return;
        }
        LAST = res; LAST_ORG = api && api.orgId;
        draw(res);
      }, function (e) {
        go.disabled = !files.length;
        if (!sc.alive()) return;
        U.doneLoading(out);
        out.appendChild(U.alertBox(e && e.cancelled ? 'info' : 'danger', e && e.cancelled ? lt('cancelled_load') : U.errMsg(e, api)));
      });
    }

    function portLabel(code, raw) { return code ? lt('port_' + code.replace('-', '_')) : (raw ? lt('fr_port_unknown', { p: raw }) : lt('fr_port_none')); }
    function stLabel(s) { return K.famLab('fasah_match_status', 'lrpt', 'fms', s); }
    function noteText(n) { return n.map(function (c) { return lt('fr_note_' + c); }).join(' '); }
    function draw(res) {
      U.clear(out);
      var s = res.summary;
      if (res.truncated) out.appendChild(U.alertBox('warning', lt('fr_truncated')));
      (res.bad || []).forEach(function (b) { out.appendChild(U.alertBox('warning', lt('fr_file_err_' + b.error, { f: b.file, mb: LIMITS.fileBytes / 1048576, n: LIMITS.rowsPerFile }))); });
      var tiles = el('div', { class: 'adm-tiles ops-kpis rpt-tiles' });
      [['fr_k_fasah', s.fasahTotal], ['fr_k_found', s.found], ['fr_k_missing', s.missing, 'danger'], ['fr_k_system_only', s.systemOnly, 'warning'],
        ['fr_k_released', s.released], ['fr_k_released_not', s.releasedNotInSystem, 'warning'], ['fr_k_port_mismatch', s.portMismatch, 'warning'],
        ['fr_k_ambiguous', s.ambiguous, 'warning'], ['fr_k_unknown_port', s.unknownPort, 'warning'], ['fr_k_duplicates', s.duplicates], ['fr_k_scope', s.systemScope]
      ].forEach(function (p) { tiles.appendChild(U.kpi(lt(p[0]), K.fmtNum(p[1] || 0, 0), p[2] || 'neutral')); });
      out.appendChild(tiles);
      out.appendChild(exportBar(res));
      // per port / month
      out.appendChild(U.card(lt('fr_by_port'), U.table([lt('c_port'), lt('fr_c_month'), { label: lt('fr_k_fasah'), num: true }, { label: lt('fr_c_released'), num: true },
        { label: lt('fr_c_pending'), num: true }, { label: lt('fr_k_found'), num: true }, { label: lt('fr_k_missing'), num: true }, { label: lt('fr_k_scope'), num: true }, { label: lt('fr_k_system_only'), num: true }],
        res.ports.map(function (p) {
          return el('tr', null, [U.td(portLabel(p.port, p.rawPort)), U.td(U.ltr(p.month || '—')), U.td(U.ltr(K.fmtNum(p.fasahTotal, 0)), 'num'), U.td(U.ltr(K.fmtNum(p.released, 0)), 'num'),
            U.td(U.ltr(K.fmtNum(p.pending, 0)), 'num'), U.td(U.ltr(K.fmtNum(p.found, 0)), 'num'), U.td(U.ltr(K.fmtNum(p.missing, 0)), 'num'), U.td(U.ltr(K.fmtNum(p.systemScope, 0)), 'num'), U.td(U.ltr(K.fmtNum(p.systemOnly, 0)), 'num')]);
        }), { caption: lt('fr_by_port') }), null, { flush: true }));
      // per file
      out.appendChild(U.card(lt('fr_by_file'), U.table([lt('fr_c_file'), { label: lt('fr_c_records'), num: true }, lt('c_port'), lt('fr_c_month'), { label: lt('fr_c_released'), num: true },
        { label: lt('fr_c_pending'), num: true }, { label: lt('fr_c_header_row'), num: true }, { label: lt('fr_c_skipped'), num: true }],
        res.files.map(function (f) {
          return el('tr', null, [U.td(el('bdi', { dir: 'auto', text: f.file })), U.td(U.ltr(K.fmtNum(f.records, 0)), 'num'),
            U.td(f.ports.map(function (p) { return PORT_CODES.indexOf(p) !== -1 ? portLabel(p) : lt('fr_port_unknown', { p: p }); }).join('، ') || '—'),
            U.td(U.ltr(f.months.join(', ') || '—')), U.td(U.ltr(K.fmtNum(f.released, 0)), 'num'), U.td(U.ltr(K.fmtNum(f.pending, 0)), 'num'),
            U.td(U.ltr(String(f.headerRow)), 'num'), U.td(U.ltr(K.fmtNum(f.skipped, 0)), 'num')]);
        }), { caption: lt('fr_by_file') }), null, { flush: true }));
      // records with status chips + column filters
      var only = {};
      var chips = el('div', { class: 'lrpt-quick', role: 'group', 'aria-label': lt('fr_status_filter') });
      var tableBox = el('div'), countP = el('p', { class: 'rpt-count', 'aria-live': 'polite' });
      var cols = recordColumns();
      var cf = window.MarsaColFilter ? window.MarsaColFilter.create({ id: 'fr', columns: cols.map(function (c) { return { key: c.key, label: c.label, type: c.type, value: c.value }; }), onChange: function () { paint(); } }) : null;
      if (cf) cf.setRows(res.records);
      STATUSES.filter(function (x) { return x !== 'system_only'; }).forEach(function (st) {
        var n = s.byStatus[st] || 0;
        var b = el('button', { type: 'button', class: 'chip lrpt-chip', 'aria-pressed': 'false', 'data-status': st, text: stLabel(st) + ' (' + K.fmtNum(n, 0) + ')' });
        b.addEventListener('click', function (e) { e.preventDefault(); if (only[st]) delete only[st]; else only[st] = 1; b.setAttribute('aria-pressed', String(!!only[st])); b.className = 'chip lrpt-chip' + (only[st] ? ' is-active' : ''); paint(); });
        chips.appendChild(b);
      });
      function shownRows() {
        var keys = Object.keys(only), rows = keys.length ? res.records.filter(function (r) { return only[r.status]; }) : res.records;
        return cf ? cf.apply(rows) : rows;
      }
      res.shownRows = shownRows;
      res.statusFilter = function () { return Object.keys(only); };
      function paint() {
        U.clear(tableBox);
        var rows = shownRows();
        countP.textContent = lt('fr_records_n', { n: K.fmtNum(rows.length, 0), m: K.fmtNum(res.records.length, 0) });
        var slice = rows.slice(0, 1000);
        tableBox.appendChild(U.card(null, K.reportTable(cols, slice, [], {}, { caption: lt('fr_records'), rowId: function (x) { return x.file + ':' + x.row; },
          rowClass: function (x) { return 'lrpt-fr-row lrpt-fr-' + x.status; }, thExtra: cf ? function (c) { return cf.button(c.key); } : null }), null, { flush: true }));
        if (rows.length > slice.length) tableBox.appendChild(el('p', { class: 'text-xs text-muted', text: lt('fr_first_n', { n: K.fmtNum(slice.length, 0) }) }));
      }
      out.appendChild(U.card(lt('fr_records'), [chips, countP, tableBox], null, { cls: 'lrpt-recon-records' }));
      paint();
      // system only
      out.appendChild(U.card(lt('fr_system_only') + ' (' + K.fmtNum(res.systemOnly.length, 0) + ')', res.systemOnly.length ? U.table([lt('c_ref'), lt('c_declaration_no'), lt('c_declaration_date'), lt('c_port'), lt('c_importer'), lt('c_stage'), lt('c_tx_status')],
        res.systemOnly.slice(0, 1000).map(function (x) {
          return el('tr', null, [U.td(K.txLinkCell(x.transaction_id, x.ref)), U.td(U.ltr(x.declaration_no)), U.td(U.ltr(x.declaration_date ? String(x.declaration_date).slice(0, 10) : '—')),
            U.td(portLabel(x.port_code)), U.td(x.client_name || '—'), U.td(x.declaration_status ? K.lab('declaration_status', x.declaration_status, api) : '—'), U.td(K.lab('operational_status', x.operational_status, api))]);
        }), { caption: lt('fr_system_only') }) : U.emptyState('check', null, lt('fr_system_only_none'), null, true), null, { flush: true }));
      out.appendChild(el('p', { class: 'text-xs text-muted', text: lt('fr_generated', { d: K.riyadhDateTime(res.generatedAt) }) }));
    }
    function recordColumns() {
      return [
        { key: 'status', label: lt('fr_c_status'), type: 'text', value: function (x) { return stLabel(x.status); }, cell: function (x) { return U.pill(TONES[x.status] || 'neutral', stLabel(x.status)); }, tone: function (x) { return x.status === 'missing' ? 'danger' : FOUND[x.status] && x.status !== 'status_mismatch' ? null : 'warning'; } },
        { key: 'file', label: lt('fr_c_file'), type: 'text', value: function (x) { return x.file; } },
        { key: 'row', label: lt('fr_c_row'), type: 'int', value: function (x) { return x.row; } },
        { key: 'declarationNo', label: lt('c_declaration_no'), type: 'text', ltr: true, value: function (x) { return x.declarationNo; } },
        { key: 'declarationDate', label: lt('c_declaration_date'), type: 'date', value: function (x) { return x.declarationDate || null; } },
        { key: 'port', label: lt('c_port'), type: 'text', value: function (x) { return portLabel(x.port, x.rawPort); } },
        { key: 'importer', label: lt('c_importer'), type: 'text', value: function (x) { return x.importer; } },
        { key: 'fasahStatus', label: lt('fr_c_fasah_status'), type: 'text', value: function (x) { return x.fasahStatus; } },
        { key: 'totalFees', label: lt('fr_c_fees'), type: 'money', value: function (x) { return x.totalFees; } },
        { key: 'ref', label: lt('fr_c_system_ref'), type: 'text', ltr: true, value: function (x) { return x.system ? x.system.ref : ''; },
          cell: function (x) { return x.system ? K.txLinkCell(x.system.transaction_id, x.system.ref) : (x.others && x.others.length ? el('span', { class: 'lrpt-refs' }, x.others.map(function (o) { return K.txLinkCell(o.transaction_id, o.ref); })) : K.NONE); } },
        { key: 'system_client', label: lt('fr_c_system_client'), type: 'text', value: function (x) { return x.system ? x.system.client_name : ''; } },
        { key: 'system_stage', label: lt('c_stage'), type: 'text', value: function (x) { return x.system && x.system.declaration_status ? K.lab('declaration_status', x.system.declaration_status, api) : ''; } },
        { key: 'note', label: lt('fr_c_note'), type: 'text', value: function (x) { return noteText(x.notes || []); } }
      ];
    }
    // export: audit first (logReportExport), then the file from the result in memory (never re-read from the server)
    function exportBar(res) {
      var msg = el('span', { class: 'rpt-export-msg', role: 'status', 'aria-live': 'polite' });
      var btns = [['xlsx', t('exp_xlsx')], ['csv', t('exp_csv')], ['print', t('exp_print')]].map(function (p) {
        var b = el('button', { type: 'button', class: 'btn btn-sm btn-secondary rpt-exp-' + p[0], 'data-format': p[0], text: p[1] });
        b.addEventListener('click', function (e) { e.preventDefault(); doExport(res, p[0], msg, btns); });
        return b;
      });
      if (!K.hasFn(api, 'logReportExport') || K.isDemo(api)) { btns.forEach(function (b) { b.disabled = true; }); msg.textContent = K.isDemo(api) ? t('exp_demo') : t('api_missing', { fn: 'logReportExport' }); }
      var bar = el('div', { class: 'rpt-export-bar', role: 'group', 'aria-label': t('exp_group') }, [el('span', { class: 'rpt-export-label', text: t('exp_label') })].concat(btns, [msg]));
      bar.__run = function (f) { return doExport(res, f, msg, btns); };
      return bar;
    }
    function doExport(res, format, msg, btns) {
      var rows = res.shownRows ? res.shownRows() : res.records;
      var cap = format === 'print' ? K.CAP_PRINT : K.CAP_FILE;
      if (!rows.length) { msg.textContent = t('exp_err_no_rows'); return Promise.resolve({ ok: false }); }
      // the Excel file also carries the «system only» sheet (system records): they are part of what leaves the system, so they
      // count in the audited row_count and in the cap (CSV / print carry the file rows only)
      var sysRows = format === 'xlsx' ? (res.systemOnly || []).length : 0;
      if (rows.length + sysRows > cap) { msg.textContent = t('exp_err_too_many_rows'); msg.className = 'rpt-export-msg is-error'; return Promise.resolve({ ok: false }); }
      // ≤ 100 scopes → ≤ 100 months / ports (log_report_export accepts 100 for these two keys of fasah_recon)
      var months = uniq(res.scopes.map(function (x) { return x.month; })).slice(0, 100), ports = uniq(res.scopes.map(function (x) { return x.port_code; })).slice(0, 100);
      var filters = { months: months, port_codes: ports, files: res.files.length };
      if (sysRows) filters.system_only = sysRows;
      var st = res.statusFilter ? res.statusFilter() : [];
      if (st.length) filters.statuses = st;
      btns.forEach(function (b) { b.disabled = true; });
      msg.className = 'rpt-export-msg'; msg.textContent = t('exp_running');
      var cols = recordColumns().map(function (c) { return { key: c.key, label: c.label, type: c.type, ltr: c.ltr, value: c.value, tone: c.tone }; });
      return U.call(api, 'logReportExport', { report: 'fasah_recon', format: format, filters: filters, row_count: rows.length + sysRows }).then(function (a) {
        btns.forEach(function (b) { b.disabled = false; });
        if (a.error) { msg.textContent = t('exp_err_audit_failed'); msg.className = 'rpt-export-msg is-error'; return { ok: false, error: a.error }; }
        var data = rows.map(function (x) { var o = {}; cols.forEach(function (c) { o[c.key] = c.value(x); if (c.tone) { var tn = c.tone(x); if (tn) o[c.key + '__tone'] = tn; } }); return o; });
        var fcols = cols.map(function (c) { return { key: c.key, label: c.label, type: c.type || 'text', ltr: c.ltr }; });
        var when = new Date(), title = lt('r_fasah_recon');
        var crit = [[t('crit_report'), title], [lt('fr_c_month'), months.join(', ')], [lt('c_port'), ports.join(', ')], [lt('fr_c_files'), String(res.files.length)],
          [t('crit_generated_at'), K.riyadhDateTime(when) + ' (' + t('riyadh_tz') + ')'], [t('crit_rows'), String(data.length)]].concat(sysRows ? [[lt('fr_system_only'), String(sysRows)]] : []);
        var E = window.MarsaExport;
        try {
          if (format === 'xlsx') {
            var sysCols = [{ key: 'ref', label: lt('c_ref'), type: 'text' }, { key: 'declaration_no', label: lt('c_declaration_no'), type: 'text' }, { key: 'declaration_date', label: lt('c_declaration_date'), type: 'date' },
              { key: 'port', label: lt('c_port'), type: 'text' }, { key: 'client', label: lt('c_importer'), type: 'text' }, { key: 'stage', label: lt('c_stage'), type: 'text' }];
            var portCols = [{ key: 'port', label: lt('c_port'), type: 'text' }, { key: 'month', label: lt('fr_c_month'), type: 'text' }, { key: 'fasahTotal', label: lt('fr_k_fasah'), type: 'int' },
              { key: 'released', label: lt('fr_c_released'), type: 'int' }, { key: 'pending', label: lt('fr_c_pending'), type: 'int' }, { key: 'found', label: lt('fr_k_found'), type: 'int' },
              { key: 'missing', label: lt('fr_k_missing'), type: 'int' }, { key: 'systemScope', label: lt('fr_k_scope'), type: 'int' }, { key: 'systemOnly', label: lt('fr_k_system_only'), type: 'int' }];
            var blob = window.MarsaXlsx.blob({ title: title, generatedAt: when.toISOString(), metaName: t('crit_sheet'), metaLabels: [t('crit_item'), t('crit_value')], meta: crit,
              sheets: [{ name: lt('fr_records'), rtl: true, columns: fcols, rows: data },
                { name: lt('fr_system_only'), rtl: true, columns: sysCols, rows: res.systemOnly.map(function (x) {
                  return { ref: x.ref, declaration_no: x.declaration_no, declaration_date: x.declaration_date ? String(x.declaration_date).slice(0, 10) : null, port: portLabel(x.port_code), client: x.client_name,
                    stage: x.declaration_status ? K.lab('declaration_status', x.declaration_status, api) : '' };
                }) },
                { name: lt('fr_by_port'), rtl: true, columns: portCols, rows: res.ports.map(function (p) { return Object.assign({}, p, { port: portLabel(p.port, p.rawPort) }); }) }] });
            E.download(blob, E.fileName('fasah_recon', 'xlsx', when));
          } else if (format === 'csv') {
            var text = E.toCsv(fcols, data, []);
            E.download(new Blob([text], { type: 'text/csv;charset=utf-8' }), E.fileName('fasah_recon', 'csv', when));
          } else {
            E.printReport({ title: title, org: api && api.orgName, criteria: crit, columns: fcols, rows: data, totals: [], generatedAt: when });
          }
        } catch (e) { msg.textContent = t('exp_err_build'); msg.className = 'rpt-export-msg is-error'; return { ok: false }; }
        msg.textContent = t(format === 'print' ? 'exp_done_print' : 'exp_done', { n: K.fmtNum(data.length, 0) });
        return { ok: true, rows: data.length, filters: filters };
      });
    }
    if (LAST && LAST_ORG === (api && api.orgId)) draw(LAST); else LAST = null;
  }

  Ops.views.fasah_recon = {
    allow: 'staff', titleKey: 'lrpt.nav_fasah_recon', icon: 'list',
    render: function (root, api) { return render(root, api); },
    _reset: function () { LAST = null; LAST_ORG = null; }, _parseFile: parseFile, _parseFiles: parseFiles
  };
})();
